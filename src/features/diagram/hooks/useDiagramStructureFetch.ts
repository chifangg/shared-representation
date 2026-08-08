import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Edge, Node } from "@xyflow/react";
import type { FileEntry } from "@/core/project";
import type {
  BlockNodeData,
  DiagramArrow,
  DiagramBlock,
  FetchState,
} from "../types";
import { layoutSchema } from "../layout/layoutSchema";
import { buildProjectContext } from "../api/buildProjectContext";
import { fetchStructureStream } from "../api/fetchStructure";

/**
 * Owns the initial diagram structure fetch lifecycle.
 *
 * Two effects:
 *  1. Reset effect: on `projectKey` change (user upload / reset),
 *     wipes local state back to idle so the next render kicks off a
 *     fresh fetch. Crucially keyed on `projectKey`, not `files`, so
 *     Claude calling `write_project_file` mid-turn does NOT trigger
 *     a diagram regen — only USER-initiated project changes do.
 *  2. Fetch effect: when state is idle AND files exist, POST to
 *     `/api/diagram?view=structure` and stream NDJSON events into a
 *     growing schema, calling `reLayout` after each event so the
 *     canvas renders blocks/arrows as they arrive.
 *
 * Exposes `retryNonce` + `setRetryNonce` so the settle-effect's
 * auto-regen path can re-trigger the fetch by bumping the nonce.
 */
export function useDiagramStructureFetch({
  projectKey,
  files,
  userGoal,
  chatRunning,
  selectedId,
  setNodes,
  setEdges,
  preserveRegenRef,
}: {
  projectKey: number;
  files: FileEntry[];
  /** True while a chat turn streams. A generation must never overlap a
   *  live turn (the historical canvas wedge), so the fetch effect defers
   *  while this is true and re-fires on its falling edge. The reverse
   *  direction is the chat's diagramBusy gate. */
  chatRunning: boolean;
  /** Composed survey answer fed to the backend as `<user_goal>`. Null
   *  before the user finishes the onboarding survey — the effect bails
   *  in that case, leaving state at idle so the canvas keeps the modal
   *  visible while waiting. */
  userGoal: string | null;
  selectedId: string | null;
  setNodes: Dispatch<SetStateAction<Node<BlockNodeData>[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  /** When `.active`, this fetch is an EDIT-driven regen: keep the old
   *  diagram on screen, buffer the stream silently, and swap to the new
   *  layout only once it is fully ready (so the canvas never blanks and
   *  the user's spatial memory survives the rebuild). The settle-effect
   *  flips it on; this hook flips it off once the swap lands. */
  preserveRegenRef?: MutableRefObject<{ active: boolean }>;
}): {
  state: FetchState;
  setState: Dispatch<SetStateAction<FetchState>>;
  retryNonce: number;
  setRetryNonce: Dispatch<SetStateAction<number>>;
} {
  const [state, setState] = useState<FetchState>({ kind: "idle" });
  const [retryNonce, setRetryNonce] = useState(0);
  // Whether any run has reached "ready" for this project. A preserve
  // regen only makes sense when there is a diagram on screen to keep;
  // a preserve request left over from before the survey completed
  // would otherwise make the FIRST generation buffer silently.
  const hasEverReadyRef = useRef(false);

  // Stable string of the current file paths. We key the fetch effect
  // on this (not on `files` itself) so that Claude calling
  // `write_project_file` mid-turn — which produces a new `files`
  // reference with the same path set — does NOT cancel the in-flight
  // fetch via the cleanup-then-rerun cycle.
  const filesKey = useMemo(
    () =>
      files
        .map((f) => f.path)
        .sort()
        .join("|"),
    [files],
  );

  // Reset on USER-initiated project change.
  useEffect(() => {
    setState({ kind: "idle" });
    setNodes([]);
    setEdges([]);
    hasEverReadyRef.current = false;
  }, [projectKey, setNodes, setEdges]);

  // Initial streaming fetch — kicks in whenever state goes idle and
  // there are files to analyze. retryNonce bumps re-trigger the fetch
  // without changing the project; useful for explicit Retry + auto-regen.
  useEffect(() => {
    if (files.length === 0) return;
    if (state.kind !== "idle") return;
    // Wait for the onboarding survey to deliver a goal before firing.
    if (userGoal === null) return;
    // Never start while a chat turn streams: the two streams racing is
    // the historical canvas wedge. chatRunning is a dep, so the effect
    // re-fires on the turn's end and starts then.
    if (chatRunning) return;

    // EDIT-driven regen: keep the existing diagram on screen, buffer the
    // stream silently, and swap to the new layout only on `ready`. A
    // normal generate blanks + streams blocks in as they arrive. Only
    // honored when a diagram actually reached the screen; a stale
    // request from before the first generation falls back to streaming.
    const preserve =
      (preserveRegenRef?.current?.active ?? false) && hasEverReadyRef.current;

    setState({ kind: "loading", startedAt: Date.now() });
    if (!preserve) {
      setNodes([]);
      setEdges([]);
    }
    const controller = new AbortController();
    const projectContext = buildProjectContext(files, userGoal);

    const blocks: DiagramBlock[] = [];
    const arrows: DiagramArrow[] = [];

    const reLayout = () => {
      const laid = layoutSchema({ blocks, arrows }, selectedId);
      setNodes(laid.nodes);
      setEdges(laid.edges);
    };

    let settled = false;
    (async () => {
      let errorMessage: string | null = null;
      try {
        await fetchStructureStream({
          projectContext,
          signal: controller.signal,
          onEvent: (evt) => {
            if (evt.kind === "block") {
              const block = evt.data;
              const dupIdx = blocks.findIndex((b) => b.id === block.id);
              if (dupIdx >= 0) blocks[dupIdx] = block;
              else blocks.push(block);
              // While preserving, don't morph the old diagram block by
              // block; just accumulate and swap once at the end.
              if (!preserve) reLayout();
            } else if (evt.kind === "arrow") {
              const arrow = evt.data;
              const dupIdx = arrows.findIndex(
                (a) => a.from === arrow.from && a.to === arrow.to,
              );
              if (dupIdx >= 0) arrows[dupIdx] = arrow;
              else arrows.push(arrow);
              if (!preserve) reLayout();
            } else if (evt.kind === "error") {
              errorMessage = evt.message;
            }
          },
        });

        if (controller.signal.aborted) return;
        settled = true;
        if (errorMessage) {
          setState({ kind: "error", message: errorMessage });
        } else {
          // Lay out the final schema once and swap. For the preserve path
          // this is the single moment the old diagram is replaced.
          reLayout();
          hasEverReadyRef.current = true;
          setState({
            kind: "ready",
            schema: { blocks, arrows },
          });
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        settled = true;
        setState({ kind: "error", message: String(e) });
      } finally {
        // An aborted run keeps the preserve request: the restart that
        // follows (new filesKey, or a chat turn ending) should still
        // swap in place rather than blank the canvas.
        if (!controller.signal.aborted && preserveRegenRef) {
          preserveRegenRef.current.active = false;
        }
      }
    })();

    return () => {
      controller.abort();
      // A dep change mid-stream (files flowing in from disk, a chat
      // turn starting) aborts the run above, and the aborted body
      // returns without a terminal setState. Left alone, state would
      // strand at "loading": diagramBusy stays true and the chat is
      // gated forever. Restore idle, and bump the nonce so the effect
      // re-fires with the fresh state and restarts the generation
      // (state.kind is deliberately not a dep, so the idle write alone
      // would not re-run it). On unmount both writes are harmless no-ops.
      if (!settled) {
        setState((s) => (s.kind === "loading" ? { kind: "idle" } : s));
        setRetryNonce((n) => n + 1);
      }
    };
    // `state.kind` and `selectedId` are intentionally omitted:
    //  - state.kind: read inside the guard `state.kind !== "idle"`;
    //    including it as a dep causes the cleanup-then-rerun cycle to
    //    abort the fetch the moment setState({kind:"loading"}) commits.
    //  - selectedId: only consulted inside reLayout's closure for the
    //    streaming pass; changing it mid-stream shouldn't restart.
    //  - files: replaced by filesKey above so mid-turn file writes
    //    (same paths, new array ref) don't cancel an in-flight fetch.
    //  - userGoal IS in deps: when survey completes, goal goes from
    //    null → string and the effect re-fires (guard above no longer
    //    bails). A subsequent regenerate flips it back to null, resets
    //    state to idle, and the next non-null goal triggers a fresh run.
    //  - chatRunning IS in deps: its falling edge is what starts a
    //    generation that was deferred by the guard above. Its rising
    //    edge mid-stream aborts the run (mutual exclusion, both
    //    directions); the cleanup restores idle so the generation
    //    restarts cleanly when the turn ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey, userGoal, chatRunning, retryNonce, setNodes, setEdges]);

  return { state, setState, retryNonce, setRetryNonce };
}
