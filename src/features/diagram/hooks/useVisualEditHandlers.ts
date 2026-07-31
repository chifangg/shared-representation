import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Connection } from "@xyflow/react";
import type { FileEntry } from "@/core/project";
import {
  serializeTarget,
  type ConnectionOption,
  type DiagramArrow,
  type DiagramBlock,
  type EditTarget,
  type FetchState,
} from "../types";
import {
  composeExecuteDirectPrompt,
  composeExecuteOptionPrompt,
  composeRenamePrompt,
  composeSuggestionsRound1Prompt,
} from "../protocol/prompts";
import type { DiagramBus } from "../protocol/bus";
import { useDiagramBusSubscribe } from "../protocol/bus";
import type { ChosenOption } from "./useChatSettleEffect";
import { dlog, dwarn } from "../util/debug";

/**
 * Owns the whole visual-edit / connection flow that the diagram canvas
 * drives: dropping a new arrow, the "actions" affordance on a block,
 * the add-new-block placeholder, the two-stage intent gate (describe
 * yourself vs ask Claude for suggestions), the floating cards overlay,
 * and the round-2 execute dispatch. Everything here either emits a
 * `visual-edit` prompt to the bus or manipulates the pending-arrow /
 * placeholder-block visuals + the gate / cards overlay state.
 *
 * The three bus subscribers (`option-executed`, `options-ready`,
 * `arrows-added`) live here too because they read and write the same
 * `chosenOptionsRef` / `pendingOptions` state and the schema.
 *
 * `chosenOptionsRef` is returned so the canvas can hand it to
 * `useChatSettleEffect`, which consumes the chosen options when the
 * round-2 turn settles.
 */
export function useVisualEditHandlers({
  state,
  setState,
  files,
  bus,
  dismissRecentEdit,
  setSelectedId,
  onArrowsLinked,
}: {
  state: FetchState;
  setState: Dispatch<SetStateAction<FetchState>>;
  files: FileEntry[];
  bus: DiagramBus;
  /** Clears the "just edited" highlight + toast. Called from every
   *  user-action handler so the highlight survives until they act. */
  dismissRecentEdit: () => void;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  /** Reports arrows Claude added, already resolved to block IDS, so the
   *  canvas can record them in the interaction tracker. Reported from here
   *  rather than from an "arrows-added" subscriber on the canvas because
   *  the label to id resolution (with its fuzzy fallback) lives here, and
   *  duplicating it would let the two disagree. */
  onArrowsLinked?: (
    links: Array<{ from: string; to: string; label: string }>,
  ) => void;
}) {
  // Round-1 options Claude returned for the most-recent edit target
  // (arrow, block, or new-block). Set by the "options-ready" subscriber
  // (fired from ChatView once it parses the JSON). Cleared when the user
  // picks a card or cancels. Drives the floating cards overlay.
  const [pendingOptions, setPendingOptions] = useState<{
    target: EditTarget;
    options: ConnectionOption[];
  } | null>(null);
  // First-stage gate for arrow / block / new-block flows: before
  // anything is sent to chat, ask the user whether they want to
  // describe the change themselves (skip suggestions round-trip) or
  // ask Claude for suggestions (current cards flow). The visual side
  // (pending arrow / placeholder block) is already on canvas by the
  // time this state is set.
  const [intentGate, setIntentGate] = useState<{
    target: EditTarget;
    /** For the add-module gate: the id of the dashed placeholder block it was
     *  opened against. The gate lives only as long as that placeholder does, so
     *  a regeneration (which wipes the placeholder) also closes the gate. */
    pendingBlockId?: string;
  } | null>(null);

  // Close a stale add-module gate once its placeholder is gone. A regeneration
  // replaces the whole schema and wipes the pending placeholder; without this
  // the gate (which briefly hides while the diagram is not "ready") would pop
  // back over the fresh diagram, reading as if it opened itself.
  useLayoutEffect(() => {
    if (!intentGate?.pendingBlockId) return;
    if (state.kind !== "ready") return;
    const stillThere = state.schema.blocks.some(
      (b) => b.id === intentGate.pendingBlockId,
    );
    if (!stillThere) setIntentGate(null);
  }, [state, intentGate]);

  /**
   * User asked to add a new module (clicked "+" or double-clicked the
   * empty canvas). We:
   *   1. Add a dashed-border placeholder block to the schema RIGHT NOW
   *      so the user gets immediate visual feedback ("yes I heard you,
   *      something is happening"). The placeholder lives in schema with
   *      pending=true and a generated id; auto-regen after Claude
   *      finishes will wipe it and surface the real block(s) instead.
   *   2. Open the intent gate so they can pick describe vs ask.
   */
  const handleAddNewBlock = useCallback(() => {
    if (state.kind !== "ready") return;
    dismissRecentEdit();
    const placeholderId = `__pending_new_${Date.now()}`;
    setState((prev) => {
      if (prev.kind !== "ready") return prev;
      const placeholder: DiagramBlock = {
        id: placeholderId,
        label: "New block…",
        caption: "Waiting for you to describe it or pick a suggestion.",
        parent: null,
        provenance: { files: [], functions: [] },
        pending: true,
      };
      return {
        kind: "ready",
        schema: {
          blocks: [...prev.schema.blocks, placeholder],
          arrows: prev.schema.arrows,
        },
      };
    });
    setIntentGate({ target: { kind: "new-block" }, pendingBlockId: placeholderId });
  }, [state, dismissRecentEdit, setState]);

  /**
   * Commit a visual rename: update the local diagram schema so the
   * label change shows up immediately, then fire a chat prompt so
   * Claude rewrites the corresponding identifier(s) in source. This
   * is the slow-path side of the bidirectional loop — visual edit
   * shows up in chat as a user turn, Claude responds with edits, the
   * diff card renders in chat, code panel reflects the change.
   *
   * No-op if there's no diagram yet (state isn't "ready"), or if the
   * label didn't actually change.
   */
  const handleRenameBlock = useCallback(
    (blockId: string, newLabel: string) => {
      setState((prev) => {
        if (prev.kind !== "ready") return prev;
        const block = prev.schema.blocks.find((b) => b.id === blockId);
        if (!block) return prev;
        const oldLabel = block.label;
        if (oldLabel === newLabel) return prev;

        bus.emit("visual-edit", {
          prompt: composeRenamePrompt(block, newLabel),
          kind: "rename",
        });

        return {
          kind: "ready",
          schema: {
            blocks: prev.schema.blocks.map((b) =>
              b.id === blockId ? { ...b, label: newLabel } : b,
            ),
            arrows: prev.schema.arrows,
          },
        };
      });
    },
    [setState, bus],
  );

  /**
   * "Ask Claude for suggestions" path (round-1). Dispatches a prompt
   * asking Claude to list ≤5 options as JSON. The chat-side cards
   * renderer will surface them as canvas cards via the "options-ready"
   * bus topic. No code change in this round.
   */
  const dispatchSuggestionsRound1 = useCallback(
    (target: EditTarget) => {
      if (state.kind !== "ready") return;
      bus.emit("visual-edit", {
        prompt: composeSuggestionsRound1Prompt(target, state.schema),
        kind: "suggestions-round1",
      });
    },
    [state, bus],
  );

  /**
   * Flip a user-drawn arrow's pending stage from "intent" to "claude"
   * the moment its edit is dispatched. This is the transition the
   * DiagramArrow type documents but which was never wired: "intent"
   * arrows are kept OUT of dagre ranking (so the open popover doesn't
   * get janked off its midpoint), while "claude" arrows DO rank. Making
   * the handoff real means that as soon as the user commits, the arrow
   * starts counting for layout, and a new block it connects slides out
   * of the island band into the spine while Claude works, instead of
   * staying stranded at the bottom all turn.
   */
  const markArrowHandedOff = useCallback(
    (target: EditTarget) => {
      if (target.kind !== "arrow") return;
      const { from, to } = target;
      setState((prev) => {
        if (prev.kind !== "ready") return prev;
        let changed = false;
        const arrows = prev.schema.arrows.map((a) => {
          if (a.from === from && a.to === to && a.pending === "intent") {
            changed = true;
            return { ...a, pending: "claude" as const };
          }
          return a;
        });
        if (!changed) return prev;
        return {
          kind: "ready",
          schema: { blocks: prev.schema.blocks, arrows },
        };
      });
    },
    [setState],
  );

  /**
   * "Describe yourself" path: skip round-1 and go straight to a
   * round-2 execute, packing the user's free-text description as the
   * intent. Also fires "option-executed" with a synthesized option
   * (kind=detail) so the chatRunning settle effect knows what to do
   * with any pending arrow / placeholder block (default: drop arrow,
   * let auto-regen pick up real outcomes).
   */
  const dispatchExecuteDirect = useCallback(
    (target: EditTarget, userText: string, summaryOverride?: string) => {
      if (state.kind !== "ready") return;
      const trimmed = userText.trim();
      // The chat-bubble summary. Callers that wrap the user's words in
      // targeting boilerplate (the bubble-edit card) pass a concise override
      // so the summary leads with the actual change, not "In the block X,
      // change the function ...". Falls back to a truncated userText.
      const rawSummary = (summaryOverride ?? trimmed).trim();
      const summaryTitle =
        rawSummary.length > 60 ? `${rawSummary.slice(0, 57)}…` : rawSummary;
      const synthOption: ConnectionOption = {
        title: summaryTitle,
        detail: "User-described change.",
        kind: "detail",
      };
      markArrowHandedOff(target);
      bus.emit("option-executed", { target, option: synthOption });
      bus.emit("visual-edit", {
        prompt: composeExecuteDirectPrompt(
          target,
          state.schema,
          files,
          trimmed,
          synthOption.title,
        ),
        kind: "execute-direct",
      });
    },
    [state, files, bus, markArrowHandedOff],
  );

  /**
   * User dropped a new arrow. Add it to the schema with pending="intent"
   * (marching-ants, excluded from ranking while the gate is open) AND
   * open the intent gate so they can pick whether to describe the change
   * themselves or have Claude suggest options. No chat dispatch until
   * the gate closes; the execute paths then hand the arrow off to
   * pending="claude" via markArrowHandedOff.
   */
  const handleAddConnection = useCallback(
    (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target || source === target) return;
      // Decide validity SYNCHRONOUSLY from current state. The old code set
      // an `opened` flag inside the setState updater and read it right
      // after, but React does not guarantee the updater runs eagerly
      // (especially with an async setState already queued, e.g. the
      // capability refresh after a block edit) so the gate could silently
      // never open and the pending arrow would blink forever.
      if (state.kind !== "ready") return;
      const { blocks, arrows } = state.schema;
      if (!blocks.some((b) => b.id === source)) return;
      if (!blocks.some((b) => b.id === target)) return;
      if (arrows.some((a) => a.from === source && a.to === target)) return;
      dismissRecentEdit();
      setState((prev) => {
        if (prev.kind !== "ready") return prev;
        if (
          prev.schema.arrows.some((a) => a.from === source && a.to === target)
        ) {
          return prev;
        }
        const newArrow: DiagramArrow = {
          from: source,
          to: target,
          label: "",
          // "intent", NOT "claude": this arrow is the user's, awaiting the
          // intent gate / suggestion pick. The settle effect's "settle
          // leftover claude arrows" branch (which fires when the round-1
          // suggestions turn ends, before the user has picked) only touches
          // "claude" arrows, so keeping this "intent" leaves it blue-dashed
          // THROUGH round-1 and the execute edit. It settles only when the
          // execute turn completes (the arrow branch matches it by key).
          pending: "intent",
        };
        return {
          kind: "ready",
          schema: {
            blocks: prev.schema.blocks,
            arrows: [...prev.schema.arrows, newArrow],
          },
        };
      });
      // Validity was decided above, so open the gate unconditionally.
      setIntentGate({ target: { kind: "arrow", from: source, to: target } });
    },
    [state, dismissRecentEdit, setState],
  );

  /**
   * Round 2: chat-side card click fires "option-executed". We store the
   * winning option keyed by target; once chatRunning transitions to
   * false (the execute turn finishes), useChatSettleEffect applies the
   * outcome — label the arrow or drop it.
   */
  const chosenOptionsRef = useRef(
    new Map<string, ChosenOption>(), // key = serializeTarget(target)
  );
  useDiagramBusSubscribe("option-executed", (detail) => {
    if (!detail) return;
    chosenOptionsRef.current.set(serializeTarget(detail.target), {
      target: detail.target,
      option: detail.option,
    });

    // For new-block: rename the next unclaimed placeholder eagerly so
    // any arrows-added Claude emits during this turn can resolve its
    // label. Without this, the placeholder keeps its generic waiting
    // label until the chatRunning settle runs (after Claude is fully
    // done), so any mid-stream arrows-added → resolveId silently drops
    // every arrow pointing at the new block. We keep `pending: true` so
    // the dashed border still signals "Claude is implementing this".
    //
    // Identify the placeholder by its id prefix, NEVER by its label
    // text: a previous rename of that copy left this check comparing
    // against a stale literal, so nothing ever matched and every new
    // block landed with no edges at all.
    if (detail.target.kind === "new-block") {
      setState((prev) => {
        if (prev.kind !== "ready") return prev;
        let claimed = false;
        const nextBlocks = prev.schema.blocks.map((b) => {
          if (claimed) return b;
          if (!b.pending || !b.id.startsWith("__pending_new_")) return b;
          claimed = true;
          return {
            ...b,
            label: detail.option.title.slice(0, 40),
            caption: detail.option.detail.slice(0, 200) || b.caption,
          };
        });
        if (!claimed) return prev;
        return {
          kind: "ready",
          schema: { blocks: nextBlocks, arrows: prev.schema.arrows },
        };
      });
    }
  });

  /**
   * Receive parsed round-1 options from ChatView and surface them as
   * a floating cards overlay on the canvas. Also clears any stale
   * chosen-option for the same target — this catches the case where
   * the user took the "Describe yourself" path with vague text and
   * Claude bailed out with options instead of executing (we'd have
   * pre-fired "option-executed" optimistically; cancel it).
   */
  useDiagramBusSubscribe("options-ready", (detail) => {
    if (!detail) return;
    chosenOptionsRef.current.delete(serializeTarget(detail.target));
    setPendingOptions({ target: detail.target, options: detail.options });
  });

  /**
   * ChatView dispatches this when Claude's response includes a trailing
   * `added_arrows` JSON block. We resolve block labels → ids against
   * the current schema and append arrows with pending="claude" so they
   * render with marching-ants until the chatRunning settle. Duplicates
   * (same from→to direction) and unresolved labels are silently
   * dropped — Claude sometimes hallucinates labels.
   *
   * Resolution runs OUTSIDE the setState updater (the bus keeps this
   * handler's closure fresh, so `state` is current). An earlier version
   * filled the `linked` report array inside the updater and read it right
   * after the setState call; React often defers updaters, so the array was
   * still empty at the read and Claude's arrows never reached the tracker.
   * The updater now only re-checks duplicates against `prev` and appends.
   */
  useDiagramBusSubscribe("arrows-added", (detail) => {
    if (!detail || detail.arrows.length === 0) return;
    dlog("recent-debug:arrows-added handler", {
      detailArrows: detail.arrows,
    });
    if (state.kind !== "ready") return;
    const blocks = state.schema.blocks;
    const resolveId = (label: string): string | null => {
      const lc = label.trim().toLowerCase();
      const exact = blocks.find((b) => b.label.toLowerCase() === lc);
      if (exact) return exact.id;
      // Fuzzy: substring match either way.
      const fuzzy = blocks.find(
        (b) =>
          b.label.toLowerCase().includes(lc) ||
          lc.includes(b.label.toLowerCase()),
      );
      if (!fuzzy) {
        // Surface mismatches in dev: silently dropping arrows
        // makes it impossible to tell whether Claude forgot to
        // emit them vs. emitted wrong labels.
        dwarn(
          "diagram",
          `added_arrows label "${label}" did not match any block. Existing labels:`,
          blocks.map((b) => b.label),
        );
      }
      return fuzzy?.id ?? null;
    };
    const toAdd: DiagramArrow[] = [];
    for (const a of detail.arrows) {
      const from = resolveId(a.from);
      const to = resolveId(a.to);
      if (!from || !to || from === to) continue;
      // Skip an arrow if ANY arrow already connects this pair, in
      // EITHER direction: a same-pair anti-parallel arrow (e.g. the
      // user drew A->B and Claude proposes B->A) renders as a confusing
      // "writes / writes" double line. One arrow per pair is enough.
      const samePair = (x: { from: string; to: string }) =>
        (x.from === from && x.to === to) || (x.from === to && x.to === from);
      if (state.schema.arrows.some(samePair)) continue;
      if (toAdd.some(samePair)) continue;
      const label = a.label?.trim() || "uses";
      toAdd.push({ from, to, label, pending: "claude" });
    }
    if (toAdd.length === 0) return;
    dlog("recent-debug:arrows-added applied", {
      toAdd: toAdd.map((a) => `${a.from}->${a.to}(${a.label})`),
    });
    setState((prev) => {
      if (prev.kind !== "ready") return prev;
      // Re-check against prev: the closure's snapshot can be one commit
      // behind (e.g. two arrows-added events landing in the same batch).
      const fresh = toAdd.filter(
        (n) =>
          !prev.schema.arrows.some(
            (x) =>
              (x.from === n.from && x.to === n.to) ||
              (x.from === n.to && x.to === n.from),
          ),
      );
      if (fresh.length === 0) return prev;
      return {
        kind: "ready",
        schema: {
          blocks: prev.schema.blocks,
          arrows: [...prev.schema.arrows, ...fresh],
        },
      };
    });
    // Report AFTER dispatch, from the precomputed list: the tracker-side
    // consumer dedupes by pair key, so a rare prev-side drop above can at
    // worst re-report a pair it has already recorded, never miss one.
    onArrowsLinked?.(toAdd.map(({ from, to, label }) => ({ from, to, label })));
  });

  /**
   * User picked a card (or submitted "Others"). Fire "option-executed"
   * so the diagram's own listener captures the chosen option keyed by
   * target; fire "visual-edit" to send the round-2 execute prompt;
   * clear the overlay.
   */
  const handlePickOption = useCallback(
    (option: ConnectionOption) => {
      if (!pendingOptions) return;
      if (state.kind !== "ready") return;
      const { target } = pendingOptions;

      markArrowHandedOff(target);
      bus.emit("option-executed", { target, option });
      bus.emit("visual-edit", {
        prompt: composeExecuteOptionPrompt(
          target,
          state.schema,
          files,
          option,
        ),
        kind: "execute-option",
      });
      setPendingOptions(null);
    },
    [pendingOptions, state, files, bus, markArrowHandedOff],
  );

  /** Strip any pending arrow / placeholder block tied to the target
   *  out of the schema. Shared by "cancel intent gate" and "cancel
   *  cards overlay" paths (both want the on-canvas placeholder gone). */
  const removeTargetVisual = useCallback(
    (target: EditTarget) => {
      setState((prev) => {
        if (prev.kind !== "ready") return prev;
        if (target.kind === "arrow") {
          const { from, to } = target;
          return {
            kind: "ready",
            schema: {
              blocks: prev.schema.blocks,
              arrows: prev.schema.arrows.filter(
                (a) => !(a.from === from && a.to === to && a.pending),
              ),
            },
          };
        }
        if (target.kind === "new-block") {
          return {
            kind: "ready",
            schema: {
              blocks: prev.schema.blocks.filter((b) => !b.pending),
              arrows: prev.schema.arrows,
            },
          };
        }
        return prev;
      });
    },
    [setState],
  );

  /** "Cancel" on the cards overlay: clear the cards + drop any
   *  on-canvas placeholder tied to the target. Also announces the
   *  cancellation so the chat's "suggestions ready" chip flips to its
   *  dismissed state instead of forever advertising options that no
   *  longer exist. */
  const handleCancelOptions = useCallback(() => {
    if (!pendingOptions) return;
    bus.emit("options-cancelled", { target: pendingOptions.target });
    removeTargetVisual(pendingOptions.target);
    setPendingOptions(null);
  }, [pendingOptions, removeTargetVisual, bus]);

  /** Intent gate: user picked "Ask Claude for suggestions". Fire the
   *  round-1 prompt; the cards UI will land in pendingOptions when
   *  ChatView parses the response. */
  const handleIntentGateAskSuggestions = useCallback(() => {
    if (!intentGate) return;
    dispatchSuggestionsRound1(intentGate.target);
    setIntentGate(null);
  }, [intentGate, dispatchSuggestionsRound1]);

  /** Intent gate: user picked "Describe yourself" + submitted text.
   *  Skip round-1 and dispatch a self-contained execute prompt. */
  const handleIntentGateDescribe = useCallback(
    (text: string) => {
      if (!intentGate) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      dispatchExecuteDirect(intentGate.target, trimmed);
      setIntentGate(null);
    },
    [intentGate, dispatchExecuteDirect],
  );

  /** Intent gate cancel: drop any on-canvas placeholder. */
  const handleIntentGateCancel = useCallback(() => {
    if (!intentGate) return;
    removeTargetVisual(intentGate.target);
    setIntentGate(null);
  }, [intentGate, removeTargetVisual]);

  /**
   * User clicked the "⋯" affordance on a block. Select the block (so
   * the user gets visual feedback that "this is the block I'm acting
   * on") and open the intent gate so they can pick describe vs ask.
   */
  const handleBlockAction = useCallback(
    (blockId: string) => {
      if (state.kind !== "ready") return;
      if (!state.schema.blocks.some((b) => b.id === blockId)) return;
      dismissRecentEdit();
      setSelectedId(blockId);
      setIntentGate({ target: { kind: "block", id: blockId } });
    },
    [state, dismissRecentEdit, setSelectedId],
  );

  return {
    pendingOptions,
    intentGate,
    chosenOptionsRef,
    handleAddConnection,
    handlePickOption,
    handleCancelOptions,
    dispatchExecuteDirect,
    handleAddNewBlock,
    handleRenameBlock,
    handleBlockAction,
    handleIntentGateAskSuggestions,
    handleIntentGateDescribe,
    handleIntentGateCancel,
  };
}
