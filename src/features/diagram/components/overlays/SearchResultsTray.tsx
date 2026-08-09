import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type RefObject,
} from "react";
import {
  AlertCircle,
  ChevronRight,
  Clock,
  CornerDownRight,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { FileEntry } from "@/core/project";
import { logEvent } from "@/core/interactionLog";
import type { DiagramArrow, DiagramBlock } from "../../types";
import type { ResolvedHit, SearchState } from "../../hooks/useDiagramSearch";
import {
  historyEntryStatus,
  relativeTime,
  type SearchHistoryEntry,
} from "../../util/searchHistory";
import { describeFunction } from "../../api/fetchFunctionDetail";
import { describeConnection } from "../../api/fetchConnectionDetail";

/**
 * The result surface for diagram search: a dropdown under the search box
 * listing the reading path, one numbered row per block.
 *
 * The list is ordered, not ranked. A search returns a set; understanding
 * needs a sequence, so row 1 is where to start reading and each connector
 * between rows is the arrow to follow. That ordering is the reason this
 * feature beats grep, and it is why the rows are numbered rather than
 * sorted by score.
 *
 * Everything factual on a row (name, file paths) is read from the SCHEMA,
 * never from the model's reply. The model contributes selection, order and
 * the one-line "why" only, which makes a fabricated file path structurally
 * impossible rather than merely unlikely.
 *
 * Tier 2 lives here: expanding a row calls the existing function-detail
 * lens with that block's real source, and a connector calls the existing
 * connection-detail lens for that arrow. Both are on-demand, so file
 * contents stay off the search path.
 */

const TRAY_W = 380;

type DetailState<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string };

type BlockDetail = { description: string; behaviors: string[] };
type EdgeDetail = { realization?: string; uses?: string[]; hidden?: string[] };

const edgeKey = (from: string, to: string) => `${from}->${to}`;

export function SearchResultsTray({
  state,
  blocks,
  arrows,
  files,
  anchorRef,
  onSelectHit,
  onReopen,
  onRegenerate,
  onForgetHistory,
  onClose,
}: {
  state: SearchState;
  blocks: DiagramBlock[];
  arrows: DiagramArrow[];
  files: FileEntry[];
  /** The search box; the tray hangs under it. */
  anchorRef: RefObject<HTMLElement>;
  /** Trace-highlight and pan to one hit. Never changes diagram state. */
  onSelectHit: (blockId: string) => void;
  /** Restore a past search from history (no model call). */
  onReopen: (entry: SearchHistoryEntry) => void;
  /** Re-ask a past question against the current diagram (costs a call). */
  onRegenerate: (entry: SearchHistoryEntry) => void;
  onForgetHistory: () => void;
  onClose: () => void;
}) {
  // Fixed-positioned under the anchor so it escapes the canvas container and
  // cannot be clipped by it. The cost of `fixed` is that nothing re-anchors
  // it automatically, and window resize / scroll listeners are not enough
  // here: dragging the panel divider, expanding the files rail, or opening
  // the code column all move the header without firing either event, which
  // left the tray stranded mid-canvas.
  //
  // So re-measure on every frame while the tray is open. That is one
  // getBoundingClientRect per frame on a single element, only while open,
  // and state is written only when the rounded position actually changes,
  // so a still layout costs no renders. This is the same catch-all
  // strategy positioning libraries use when the anchor can move for
  // reasons the DOM does not announce.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const tick = () => {
      const el = anchorRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        // Keep the tray on screen if the header sits near the right edge.
        const left = Math.round(
          Math.max(8, Math.min(r.left, window.innerWidth - TRAY_W - 8)),
        );
        const top = Math.round(r.bottom + 6);
        setPos((cur) =>
          cur && cur.top === top && cur.left === left ? cur : { top, left },
        );
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [anchorRef]);

  const [blockDetail, setBlockDetail] = useState<
    Record<string, DetailState<BlockDetail>>
  >({});
  const [edgeDetail, setEdgeDetail] = useState<
    Record<string, DetailState<EdgeDetail>>
  >({});
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [openEdge, setOpenEdge] = useState<string | null>(null);

  // Drill-ins are keyed by block/arrow id, so a fresh query must drop them
  // or a stale expansion can reappear under a different result.
  useEffect(() => {
    setBlockDetail({});
    setEdgeDetail({});
    setOpenRow(null);
    setOpenEdge(null);
  }, [state.answer, state.query]);

  const filesFor = useCallback(
    (paths: string[]) =>
      paths
        .map((p) => files.find((f) => f.path === p))
        .filter((f): f is FileEntry => !!f)
        .map((f) => ({ path: f.path, content: f.content })),
    [files],
  );

  /** Tier 2, block: the existing function-detail lens over this block's
   *  strongest capability, read from real source. */
  const loadBlockDetail = useCallback(
    (hit: ResolvedHit) => {
      const block = blocks.find((b) => b.id === hit.blockId);
      if (!block) return;
      if (blockDetail[hit.blockId]?.kind === "ready") return;
      const target =
        block.capabilities?.[0] ??
        block.provenance?.functions?.[0] ??
        block.label;
      const src = filesFor(block.provenance?.files ?? []);
      if (src.length === 0) {
        setBlockDetail((s) => ({
          ...s,
          [hit.blockId]: {
            kind: "error",
            message: "No source is attached to this block.",
          },
        }));
        return;
      }
      setBlockDetail((s) => ({ ...s, [hit.blockId]: { kind: "loading" } }));
      logEvent("diagram-search-drillin", {
        kind: "block",
        block: block.label,
        query: state.query,
      });
      describeFunction({ functionName: target, files: src })
        .then((data) =>
          setBlockDetail((s) => ({
            ...s,
            [hit.blockId]: { kind: "ready", data },
          })),
        )
        .catch((e: unknown) =>
          setBlockDetail((s) => ({
            ...s,
            [hit.blockId]: {
              kind: "error",
              message: e instanceof Error ? e.message : "lookup failed",
            },
          })),
        );
    },
    [blocks, blockDetail, filesFor, state.query],
  );

  /** Tier 2, arrow: the existing connection-detail lens for one seam. */
  const loadEdgeDetail = useCallback(
    (from: string, to: string) => {
      const key = edgeKey(from, to);
      if (edgeDetail[key]?.kind === "ready") return;
      const fromB = blocks.find((b) => b.id === from);
      const toB = blocks.find((b) => b.id === to);
      if (!fromB || !toB) return;
      const arrow = arrows.find(
        (a) =>
          (a.from === from && a.to === to) || (a.from === to && a.to === from),
      );
      const src = filesFor([
        ...(fromB.provenance?.files ?? []),
        ...(toB.provenance?.files ?? []),
      ]);
      setEdgeDetail((s) => ({ ...s, [key]: { kind: "loading" } }));
      logEvent("diagram-search-drillin", {
        kind: "arrow",
        from: fromB.label,
        to: toB.label,
        query: state.query,
      });
      describeConnection({
        fromLabel: fromB.label,
        toLabel: toB.label,
        verb: arrow?.label || "connects to",
        fromCaption: fromB.caption,
        toCaption: toB.caption,
        files: src,
      })
        .then((data) =>
          setEdgeDetail((s) => ({ ...s, [key]: { kind: "ready", data } })),
        )
        .catch((e: unknown) =>
          setEdgeDetail((s) => ({
            ...s,
            [key]: {
              kind: "error",
              message: e instanceof Error ? e.message : "lookup failed",
            },
          })),
        );
    },
    [arrows, blocks, edgeDetail, filesFor, state.query],
  );

  if (!pos) return null;

  const hasTier1 = state.hits.length > 0;
  const showLexical = !hasTier1 && state.lexicalHits.length > 0;
  const idle =
    !hasTier1 &&
    !showLexical &&
    state.status !== "loading" &&
    state.status !== "error" &&
    !state.missing;
  // Past searches fill the otherwise-empty tray, which is where a recent
  // list is most useful and costs no extra surface. Once a query is typed
  // the lexical matches take over the same space.
  const showHistory = idle && state.query.trim() === "" && state.history.length > 0;
  const nothingYet = idle && !showHistory;

  /** The arrow (if any) the reading path says to follow from row i to i+1. */
  const connectorAfter = (i: number): { from: string; to: string } | null => {
    const a = state.hits[i];
    const b = state.hits[i + 1];
    if (!a || !b) return null;
    const hit = state.path.find(
      (e) =>
        (e.from === a.blockId && e.to === b.blockId) ||
        (e.from === b.blockId && e.to === a.blockId),
    );
    return hit ? { from: hit.from, to: hit.to } : null;
  };

  return (
    <div
      style={{ top: pos.top, left: pos.left, width: TRAY_W }}
      className="fixed z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-[#C9C8C3] bg-[#F7F6F4] shadow-[0_12px_28px_-10px_rgba(51,50,47,0.45)]"
      // Clicks inside must not reach the canvas pane handler, which would
      // collapse selections behind the tray.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {state.status === "loading" && (
        <div className="flex items-center gap-2 px-3 py-2.5 text-[12px] text-[#6E6D68]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#2F7A6F]" strokeWidth={2} />
          <span>Reading the diagram…</span>
        </div>
      )}

      {state.status === "error" && (
        <div className="flex items-start gap-2 px-3 py-2.5 text-[12px] text-[#8A3A32]">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span>{state.error}</span>
        </div>
      )}

      {state.stale && (
        <div className="flex items-start gap-2 border-b border-[#E4E3E0] bg-[#F1EEE6] px-3 py-2 text-[11px] text-[#7A6A44]">
          <span className="flex-1">
            The diagram has changed since this answer. Steps were re-matched by
            name, and any that no longer exist were dropped.
          </span>
          <button
            type="button"
            onClick={() =>
              onRegenerate({
                query: state.query,
                at: Date.now(),
                answer: state.answer,
                missing: state.missing,
                hits: [],
                path: [],
              })
            }
            className="flex shrink-0 items-center gap-1 rounded bg-[#E4D7BE] px-1.5 py-1 text-[10.5px] text-[#7A5F26] transition-colors hover:bg-[#DBCBAA]"
          >
            <RefreshCw className="h-3 w-3" strokeWidth={2} />
            <span>Regenerate</span>
          </button>
        </div>
      )}

      {/* The one-sentence answer. Also the whole payload when nothing in the
       *  diagram covers the question: saying so plainly is better than an
       *  invented path. */}
      {state.answer && (
        <div
          className={`px-3 py-2.5 text-[12.5px] leading-relaxed ${
            state.missing ? "text-[#6E6D68]" : "text-[#33322F]"
          } ${hasTier1 ? "border-b border-[#E4E3E0]" : ""}`}
        >
          {state.answer}
        </div>
      )}

      {showLexical && (
        <div className="px-3 py-2">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#A09C92]">
            Name matches · press Enter to search properly
          </div>
          {state.lexicalHits.map((h) => {
            const b = blocks.find((bl) => bl.id === h.blockId);
            if (!b) return null;
            return (
              <button
                key={h.blockId}
                type="button"
                onClick={() => onSelectHit(h.blockId)}
                className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-black/[0.04]"
              >
                <span className="truncate text-[12.5px] text-[#33322F]">
                  {b.label}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-[#A09C92]">
                  {h.field}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {showHistory && (
        <div className="px-2 py-2">
          <div className="mb-1 flex items-center gap-1.5 px-1.5">
            <Clock className="h-3 w-3 text-[#A09C92]" strokeWidth={2} />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#A09C92]">
              Recent searches
            </span>
            <button
              type="button"
              onClick={onForgetHistory}
              className="ml-auto rounded px-1 text-[10px] text-[#A09C92] transition-colors hover:bg-black/[0.06] hover:text-[#6E6D68]"
            >
              Clear
            </button>
          </div>
          {state.history.map((entry) => {
            // A record whose blocks the diagram has since deleted is kept,
            // not pruned: the question is still a record of what the person
            // was trying to understand. It is marked instead, and offered a
            // regenerate, which is the only way to get an answer that
            // matches the diagram as it now stands.
            const { kept, total, outdated } = historyEntryStatus(entry, blocks);
            return (
              <div
                key={`${entry.at}-${entry.query}`}
                className="group/hist flex items-start gap-1 rounded px-1.5 py-1.5 transition-colors hover:bg-black/[0.04]"
              >
                <button
                  type="button"
                  onClick={() => onReopen(entry)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex w-full items-baseline gap-2">
                    <span
                      className={`truncate text-[12.5px] ${
                        outdated ? "text-[#6E6D68]" : "text-[#33322F]"
                      }`}
                    >
                      {entry.query}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-[#A09C92]">
                      {relativeTime(entry.at)}
                    </span>
                  </div>
                  <span className="block truncate text-[11px] text-[#8A8880]">
                    {entry.missing || total === 0
                      ? "No match in the diagram"
                      : `${total} step${total === 1 ? "" : "s"} · ${entry.hits
                          .map((h) => h.label)
                          .join(" → ")}`}
                  </span>
                  {outdated && (
                    <span className="mt-0.5 block text-[10.5px] text-[#8A6A32]">
                      {kept === 0
                        ? "None of these blocks are in the diagram any more"
                        : `${kept} of ${total} steps still exist`}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  title="Ask this again against the current diagram"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRegenerate(entry);
                  }}
                  className={`mt-px flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] transition-colors ${
                    outdated
                      ? "bg-[#EDE4D2] text-[#7A5F26] hover:bg-[#E4D7BE]"
                      : "text-[#A09C92] opacity-0 hover:bg-black/[0.06] hover:text-[#6E6D68] group-hover/hist:opacity-100"
                  }`}
                >
                  <RefreshCw className="h-3 w-3" strokeWidth={2} />
                  <span>Regenerate</span>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {nothingYet && (
        <div className="px-3 py-2.5 text-[12px] text-[#8A8880]">
          Describe what you are trying to understand, then press Enter.
        </div>
      )}

      {hasTier1 && (
        <ol className="px-2 py-2">
          {state.hits.map((hit, i) => {
            const block = blocks.find((b) => b.id === hit.blockId);
            const detail = blockDetail[hit.blockId] ?? { kind: "idle" as const };
            const expanded = openRow === hit.blockId;
            const conn = connectorAfter(i);
            const cKey = conn ? edgeKey(conn.from, conn.to) : null;
            const cDetail =
              cKey ? edgeDetail[cKey] ?? { kind: "idle" as const } : null;
            const cOpen = cKey !== null && openEdge === cKey;
            const verb =
              conn &&
              (arrows.find(
                (a) => a.from === conn.from && a.to === conn.to,
              )?.label ||
                "connects to");

            return (
              <li key={hit.blockId}>
                <div className="rounded-md transition-colors hover:bg-black/[0.03]">
                  <div className="flex items-start gap-2 px-1.5 py-1.5">
                    <span className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[#2F7A6F] text-[10.5px] font-semibold text-white">
                      {hit.order}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        logEvent("diagram-search-hit-click", {
                          block: hit.label,
                          order: hit.order,
                          query: state.query,
                        });
                        onSelectHit(hit.blockId);
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate text-[12.5px] font-medium text-[#33322F]">
                        {hit.label}
                      </div>
                      <div className="text-[11.5px] leading-snug text-[#6E6D68]">
                        {hit.why}
                      </div>
                      {/* Real paths, straight from provenance. */}
                      {(block?.provenance?.files?.length ?? 0) > 0 && (
                        <div className="mt-0.5 truncate font-mono text-[10px] text-[#A09C92]">
                          {block!.provenance.files.slice(0, 2).join("  ")}
                          {block!.provenance.files.length > 2
                            ? `  +${block!.provenance.files.length - 2}`
                            : ""}
                        </div>
                      )}
                    </button>
                    <button
                      type="button"
                      title="Explain from the code"
                      onClick={() => {
                        const next = expanded ? null : hit.blockId;
                        setOpenRow(next);
                        if (next) loadBlockDetail(hit);
                      }}
                      className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#8A8880] transition-colors hover:bg-black/[0.06] hover:text-[#33322F]"
                    >
                      <ChevronRight
                        className={`h-3.5 w-3.5 transition-transform ${
                          expanded ? "rotate-90" : ""
                        }`}
                        strokeWidth={2}
                      />
                    </button>
                  </div>

                  {expanded && (
                    <div className="border-t border-[#E9E8E4] px-3 py-2 text-[11.5px] leading-relaxed text-[#4A4842]">
                      {detail.kind === "loading" && (
                        <span className="flex items-center gap-1.5 text-[#6E6D68]">
                          <Loader2
                            className="h-3 w-3 animate-spin"
                            strokeWidth={2}
                          />
                          Reading the source…
                        </span>
                      )}
                      {detail.kind === "error" && (
                        <span className="text-[#8A3A32]">{detail.message}</span>
                      )}
                      {detail.kind === "ready" && (
                        <>
                          <p>{detail.data.description}</p>
                          {detail.data.behaviors.length > 0 && (
                            <ul className="mt-1.5 space-y-0.5">
                              {detail.data.behaviors.map((b, k) => (
                                <li key={k} className="flex gap-1.5">
                                  <span className="text-[#A09C92]">·</span>
                                  <span>{b}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Connector: the arrow the path says to follow next. Its
                 *  presence is what turns a list into a route. */}
                {conn && cKey && (
                  <div className="ml-[15px] border-l border-dashed border-[#C9C8C3] pl-3">
                    <button
                      type="button"
                      onClick={() => {
                        const next = cOpen ? null : cKey;
                        setOpenEdge(next);
                        if (next) loadEdgeDetail(conn.from, conn.to);
                      }}
                      className="flex items-center gap-1 py-1 text-[11px] text-[#6E6D68] transition-colors hover:text-[#2F7A6F]"
                    >
                      <CornerDownRight className="h-3 w-3" strokeWidth={2} />
                      <span className="italic">{verb}</span>
                    </button>
                    {cOpen && cDetail && (
                      <div className="pb-1.5 pr-2 text-[11px] leading-relaxed text-[#4A4842]">
                        {cDetail.kind === "loading" && (
                          <span className="flex items-center gap-1.5 text-[#6E6D68]">
                            <Loader2
                              className="h-3 w-3 animate-spin"
                              strokeWidth={2}
                            />
                            Reading the seam…
                          </span>
                        )}
                        {cDetail.kind === "error" && (
                          <span className="text-[#8A3A32]">
                            {cDetail.message}
                          </span>
                        )}
                        {cDetail.kind === "ready" && (
                          <>
                            {cDetail.data.realization && (
                              <p>{cDetail.data.realization}</p>
                            )}
                            {(cDetail.data.hidden?.length ?? 0) > 0 && (
                              <ul className="mt-1 space-y-0.5">
                                {cDetail.data.hidden!.map((h, k) => (
                                  <li key={k} className="flex gap-1.5">
                                    <span className="text-[#A09C92]">·</span>
                                    <span>{h}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex items-center justify-between border-t border-[#E4E3E0] px-3 py-1.5 text-[10px] text-[#A09C92]">
        <span>Reading order · click a step to fly there</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1 transition-colors hover:bg-black/[0.06] hover:text-[#6E6D68]"
        >
          Esc to close
        </button>
      </div>
    </div>
  );
}
