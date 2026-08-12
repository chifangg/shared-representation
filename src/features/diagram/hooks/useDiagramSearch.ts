/**
 * Owns natural-language diagram search: the box's open/closed state, the
 * query, the instant lexical pass, the semantic fetch, and what happens to
 * a live result when the diagram regenerates underneath it.
 *
 * The load-bearing design rule, and the reason this is a separate hook
 * rather than state inside DiagramCanvas: SEARCH IS READ-ONLY AND DERIVED.
 * It never writes the schema, never touches `focused` (the adaptive-focus
 * channel), never triggers a regen, and never takes the chat lock. A
 * feature that only reads cannot interfere with the agent, which is the
 * whole point: people search WHILE the agent writes code, so search must
 * be usable at exactly the moment the rest of the diagram is busy. That
 * holds for `ask` too, the one entry point a caller outside the box can
 * use (the chat nudge): it opens the box and runs a query, nothing more.
 *
 * Two tiers feed one result surface:
 *   - tier 0 (`lexicalHits`) is recomputed synchronously on every
 *     keystroke, so the tray is never empty while the network is in
 *     flight.
 *   - tier 1 (`result`) replaces it when the semantic answer lands.
 *
 * Regen policy: when the schema changes under a live result, hits are
 * re-resolved BY LABEL and misses are dropped, rather than clearing.
 * Clearing would punish the user for the agent's activity at precisely
 * the moment they are relying on search.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { logEvent } from "@/core/interactionLog";
import type { DiagramSchema } from "../types";
import { lexicalSearch, type LexicalHit } from "../util/lexicalSearch";
import {
  searchDiagram,
  type DiagramSearchResult,
  type SearchPathEdge,
} from "../api/fetchDiagramSearch";
import {
  pushHistory,
  resolveHistoryEntry,
  type SearchHistoryEntry,
} from "../util/searchHistory";

export type SearchStatus = "idle" | "loading" | "ready" | "error";

/**
 * Which search the box is doing. The two used to be one escalating flow
 * (type for names, press Enter for the agent), which hid the second half:
 * the instant matches satisfied people and they never submitted. Making
 * it a mode says up front which question is being answered and what it
 * costs, and it makes the cheap local search a destination in its own
 * right rather than a waiting room.
 *
 *   - "name"  — local substring match over the schema. Live, free.
 *   - "agent" — the semantic pass. Costs a model call, returns an answer
 *               and an ordered reading path, and only runs on submit.
 */
export type SearchMode = "name" | "agent";

/** Agent mode is the default: the ordered reading path is the reason this
 *  box exists, and name matching is the fallback people reach for once
 *  they know what a block is called. */
const DEFAULT_MODE: SearchMode = "agent";

/** A tier-1 hit resolved against the CURRENT schema. `label` is captured at
 *  fetch time and is what re-resolution matches on after a regen. */
export type ResolvedHit = {
  blockId: string;
  label: string;
  why: string;
  order: number;
};

export type SearchState = {
  open: boolean;
  /** Which of the two searches the box is currently doing. */
  mode: SearchMode;
  query: string;
  status: SearchStatus;
  error: string | null;
  /** Tier 0. Present from the first keystroke, cleared once tier 1 lands. */
  lexicalHits: LexicalHit[];
  /** Tier 1, resolved against the current schema. */
  hits: ResolvedHit[];
  path: SearchPathEdge[];
  answer: string;
  missing: boolean;
  /** The diagram regenerated while this result was on screen, or a reopened
   *  history entry lost hits to a rebuild. Either way the user is looking
   *  at a re-matched answer, not the original one. */
  stale: boolean;
  /** Ids to ring on the canvas: tier 1 if present, else tier 0. */
  highlightIds: string[];
  /** Past searches for this project, newest first. */
  history: SearchHistoryEntry[];
};

export function useDiagramSearch({
  schema,
  projectKey,
  enabled,
}: {
  schema: DiagramSchema;
  /** USER-initiated project change. Resets everything. */
  projectKey: string | number;
  /** False while the diagram is not ready; the box stays closed. */
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setModeState] = useState<SearchMode>(DEFAULT_MODE);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiagramSearchResult | null>(null);
  /** Labels captured when the result arrived, keyed by the id it had then.
   *  This is what survives a regen; ids do not. */
  const [resultLabels, setResultLabels] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [stale, setStale] = useState(false);
  // In memory only: a reload starts a clean slate, so one session's
  // questions never carry into the next on a shared machine.
  const [history, setHistory] = useState<SearchHistoryEntry[]>([]);

  const inflight = useRef<AbortController | null>(null);
  const startedAt = useRef<number>(0);

  // Name mode: synchronous, every keystroke, no network. Not computed in
  // agent mode at all now that it is a mode rather than a warm-up layer.
  const lexicalHits = useMemo(
    () =>
      mode !== "name" || query.trim().length === 0
        ? []
        : lexicalSearch(schema.blocks, query),
    [mode, schema.blocks, query],
  );

  const clear = useCallback(() => {
    inflight.current?.abort();
    inflight.current = null;
    setQuery("");
    setStatus("idle");
    setError(null);
    setResult(null);
    setResultLabels(new Map());
    setStale(false);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setModeState(DEFAULT_MODE);
    clear();
    logEvent("diagram-search-close", {});
  }, [clear]);

  /**
   * Switch which search the box is doing.
   *
   * The query survives the switch: the same words are a reasonable input
   * to both searches, and retyping them would be the main cost of having
   * two modes at all. An in-flight agent call does not survive, because
   * flipping to name mode is a statement that its answer is no longer
   * wanted, and letting it land would repopulate a tray the user just
   * asked to show something else.
   */
  const setMode = useCallback(
    (next: SearchMode) => {
      setModeState((prev) => {
        if (prev === next) return prev;
        if (next === "name") {
          inflight.current?.abort();
          inflight.current = null;
          setStatus("idle");
          setError(null);
        }
        logEvent("diagram-search-mode", { mode: next });
        return next;
      });
    },
    [],
  );

  const openBox = useCallback(
    (via: "header" | "shortcut") => {
      if (!enabled) return;
      setOpen(true);
      logEvent("diagram-search-open", { via });
    },
    [enabled],
  );

  // Cmd+K / Ctrl+K opens and focuses; Escape closes. Bound at the window so
  // they work wherever focus is inside the diagram panel. Search is diagram
  // only by design, so this is mounted with the canvas and dies with it.
  //
  // Escape needs the window binding specifically because the search box's
  // own onKeyDown only fires while the INPUT holds focus. The moment the
  // user clicks anything in the results tray (a step, a history row, a
  // drill-in chevron) focus moves to that button and the input-scoped
  // handler goes dead, which made Escape stop working exactly when the
  // tray was in use. The input keeps its own handler as well: it calls
  // stopPropagation on every key so canvas shortcuts do not fire mid-typing,
  // which also stops keys reaching this listener while typing. The two
  // therefore cover disjoint cases rather than double-firing.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openBox("shortcut");
        return;
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, openBox, open, close]);

  /** Fire the semantic pass. Aborts any in-flight search first, so holding
   *  Enter cannot stack requests. */
  const run = useCallback(
    (raw?: string) => {
    const q = (raw ?? query).trim();
    if (q.length === 0 || schema.blocks.length === 0) return;

    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    startedAt.current = Date.now();

    setStatus("loading");
    setError(null);
    setStale(false);
    logEvent("diagram-search-submit", {
      query: q,
      blocks: schema.blocks.length,
      lexicalHits: lexicalHits.length,
    });

    searchDiagram({ query: q, schema, signal: ctl.signal })
      .then((res) => {
        if (ctl.signal.aborted) return;
        const labelById = new Map(
          res.hits
            .map((h) => {
              const b = schema.blocks.find((bl) => bl.id === h.block_id);
              return b ? ([h.block_id, b.label] as const) : null;
            })
            .filter((e): e is readonly [string, string] => e !== null),
        );
        setResult(res);
        setResultLabels(labelById);
        setStatus("ready");

        // Record it. Stored by label, not id, so the entry still resolves
        // after the diagram rebuilds (see util/searchHistory).
        setHistory((prev) =>
          pushHistory(prev, {
            query: q,
            at: Date.now(),
            answer: res.answer,
            missing: res.missing,
            hits: res.hits
              .map((h) => {
                const label = labelById.get(h.block_id);
                return label ? { label, why: h.why, order: h.order } : null;
              })
              .filter((h): h is NonNullable<typeof h> => h !== null),
            path: res.path
              .map((e) => {
                const fromLabel = labelById.get(e.from);
                const toLabel = labelById.get(e.to);
                return fromLabel && toLabel ? { fromLabel, toLabel } : null;
              })
              .filter((e): e is NonNullable<typeof e> => e !== null),
          }),
        );
        logEvent("diagram-search-result", {
          query: q,
          hits: res.hits.length,
          pathEdges: res.path.length,
          missing: res.missing,
          ms: Date.now() - startedAt.current,
        });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        const msg = e instanceof Error ? e.message : "search failed";
        setStatus("error");
        setError(msg);
        logEvent("diagram-search-error", {
          query: q,
          error: msg,
          ms: Date.now() - startedAt.current,
        });
      });
    },
    [query, schema, lexicalHits.length],
  );

  /** Enter in the search box. Only agent mode has anything to submit:
   *  name matching is already live on every keystroke. */
  const submit = useCallback(() => {
    if (mode !== "agent") return;
    run();
  }, [mode, run]);

  /**
   * Fire a search the user did not type: open the box, show the question,
   * run it. This is the one programmatic entry point into search (the chat
   * nudge card uses it via the "diagram-search-ask" bus topic).
   *
   * The query is passed to `run` explicitly rather than through
   * `setQuery` + `submit`: `run` closes over the `query` state, so a
   * same-tick submit would fire the PREVIOUS query.
   */
  const ask = useCallback(
    (q: string) => {
      if (!enabled) return;
      setOpen(true);
      // The nudge asks a question, not for a name, so it forces the mode
      // rather than firing into whichever one the box was left in.
      setModeState("agent");
      setQuery(q);
      run(q);
      logEvent("diagram-search-ask", { query: q });
    },
    [enabled, run],
  );

  /**
   * Re-ask a past question against the diagram as it is now.
   *
   * The point of this over reopen: reopen restores the stored answer,
   * which can reference blocks a rebuild has since deleted. Regenerate
   * throws that away and pays for a fresh model call, which is the only
   * way to get an answer that matches the current diagram.
   */
  const regenerate = useCallback(
    (entry: SearchHistoryEntry) => {
      logEvent("diagram-search-history-regenerate", {
        query: entry.query,
        ageMs: Date.now() - entry.at,
      });
      setQuery(entry.query);
      run(entry.query);
    },
    [run],
  );

  /**
   * Reopen a past search WITHOUT paying for another model call.
   *
   * The stored entry is keyed by label, so this re-resolves it against the
   * schema as it exists now. Blocks that were renamed or removed by a
   * rebuild in the meantime simply drop out, and losing any marks the
   * result stale so the user can tell a recovered answer from a fresh one
   * (and press Enter to re-run if they want the current truth).
   */
  const reopen = useCallback(
    (entry: SearchHistoryEntry) => {
      inflight.current?.abort();
      inflight.current = null;

      const { hits, path, dropped } = resolveHistoryEntry(entry, schema.blocks);
      setQuery(entry.query);
      setError(null);
      setResult({
        answer: entry.answer,
        missing: entry.missing || hits.length === 0,
        hits: hits.map((h) => ({
          block_id: h.blockId,
          why: h.why,
          order: h.order,
        })),
        path,
      });
      setResultLabels(new Map(hits.map((h) => [h.blockId, h.label])));
      setStale(dropped > 0);
      setStatus("ready");
      logEvent("diagram-search-history-reopen", {
        query: entry.query,
        ageMs: Date.now() - entry.at,
        kept: hits.length,
        dropped,
      });
    },
    [schema.blocks],
  );

  const forgetHistory = useCallback(() => {
    setHistory([]);
    logEvent("diagram-search-history-clear", {});
  }, []);

  // Regen survival. When the schema's block ids change under a live result,
  // re-resolve each hit by the label it had at fetch time. Hits whose block
  // is gone are dropped; the rest keep their reading order. Never clears.
  const blockIds = useMemo(
    () => schema.blocks.map((b) => b.id).join("|"),
    [schema.blocks],
  );
  const lastIds = useRef(blockIds);
  useEffect(() => {
    if (lastIds.current === blockIds) return;
    lastIds.current = blockIds;
    if (!result) return;

    const byLabel = new Map(schema.blocks.map((b) => [b.label, b.id]));
    let dropped = 0;
    const remapped = result.hits
      .map((h) => {
        const label = resultLabels.get(h.block_id);
        const nextId = label ? byLabel.get(label) : undefined;
        if (!nextId) {
          dropped += 1;
          return null;
        }
        return { ...h, block_id: nextId };
      })
      .filter((h): h is (typeof result.hits)[number] => h !== null);

    const alive = new Set(remapped.map((h) => h.block_id));
    const idByOldId = new Map(
      result.hits.map((h) => {
        const label = resultLabels.get(h.block_id);
        return [h.block_id, (label && byLabel.get(label)) || h.block_id];
      }),
    );
    const nextPath = result.path
      .map((e) => ({
        from: idByOldId.get(e.from) ?? e.from,
        to: idByOldId.get(e.to) ?? e.to,
      }))
      .filter((e) => alive.has(e.from) && alive.has(e.to));

    setResult({ ...result, hits: remapped, path: nextPath });
    setResultLabels(
      new Map(
        remapped
          .map((h) => {
            const b = schema.blocks.find((bl) => bl.id === h.block_id);
            return b ? ([h.block_id, b.label] as const) : null;
          })
          .filter((e): e is readonly [string, string] => e !== null),
      ),
    );
    setStale(true);
    logEvent("diagram-search-restale", { dropped, kept: remapped.length });
  }, [blockIds, result, resultLabels, schema.blocks]);

  // USER project change wipes everything, box included, and swaps in that
  // project's own history (searches are only meaningful against the
  // diagram they were asked of).
  useEffect(() => {
    inflight.current?.abort();
    inflight.current = null;
    setOpen(false);
    setModeState(DEFAULT_MODE);
    setQuery("");
    setStatus("idle");
    setError(null);
    setResult(null);
    setResultLabels(new Map());
    setStale(false);
    setHistory([]);
  }, [projectKey]);

  useEffect(() => () => inflight.current?.abort(), []);

  const hits: ResolvedHit[] = useMemo(() => {
    if (!result) return [];
    return result.hits
      .map((h) => {
        const b = schema.blocks.find((bl) => bl.id === h.block_id);
        return b
          ? { blockId: h.block_id, label: b.label, why: h.why, order: h.order }
          : null;
      })
      .filter((h): h is ResolvedHit => h !== null);
  }, [result, schema.blocks]);

  // Rings on the canvas follow the active mode, not whichever list happens
  // to be non-empty: a stale agent result must not keep blocks lit while
  // name mode is showing a different set.
  const highlightIds = useMemo(
    () =>
      mode === "agent"
        ? hits.map((h) => h.blockId)
        : lexicalHits.map((h) => h.blockId),
    [mode, hits, lexicalHits],
  );

  // Each mode publishes only its own result. The agent's answer is kept in
  // state across a switch (flipping to names and back should not cost
  // another call) but it is not rendered while name mode is showing, so
  // the tray can never mix the two.
  const agentMode = mode === "agent";
  const state: SearchState = {
    open,
    mode,
    query,
    status,
    error,
    lexicalHits,
    hits: agentMode ? hits : [],
    path: agentMode ? result?.path ?? [] : [],
    answer: agentMode ? result?.answer ?? "" : "",
    missing: agentMode ? result?.missing ?? false : false,
    stale: agentMode && stale,
    highlightIds,
    history,
  };

  return {
    state,
    setQuery,
    setMode,
    submit,
    ask,
    openBox,
    close,
    clear,
    reopen,
    regenerate,
    forgetHistory,
  };
}
