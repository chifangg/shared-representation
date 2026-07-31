import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Edge, Node } from "@xyflow/react";
import {
  type BlockNodeData,
  type DiagramArrow,
  type DiagramBlock,
  type DiagramSchema,
  type DiagramView,
  type FetchState,
} from "../types";
import { layoutSchema } from "../layout/layoutSchema";
import type { FocusState } from "./useAdaptiveFocus";
import type { RecentChanges } from "./useRecentChanges";
import { dlog } from "../util/debug";

/**
 * Owns the node + edge "decoration" post-pass and the two layout
 * effects that feed it into React Flow.
 *
 * `layoutSchema` is pure: it knows nothing about component state, so the
 * nodes / edges it emits carry no callbacks, no recent-change styling,
 * and ignore manual drags. This hook bridges that gap:
 *   - `attachInteractive` re-injects per-node callbacks + the
 *     recently-added / editing flags, and honors user drags.
 *   - `tagRecentEdges` paints edges that just settled solid blue.
 *
 * Both are applied by the two effects below: one re-lays-out on
 * selection toggle (so dagre makes room for the expanded block), the
 * other re-renders the base canvas (merging promoted detail blocks +
 * narrowing to the focused ids in focus view). The base-canvas effect
 * is registered last, so on any commit where both fire it wins — the
 * selection effect is the cheaper subset.
 *
 * Nothing is returned: the hook drives `setNodes` / `setEdges` directly.
 */
export function useCanvasDecoration({
  state,
  selectedId,
  focused,
  view,
  promoted,
  setNodes,
  setEdges,
  recentChanges,
  editingBlockIds,
  editRegenIds,
  handleRenameBlock,
  handleBlockAction,
  userPositionsRef,
}: {
  state: FetchState;
  selectedId: string | null;
  focused: FocusState | null;
  view: DiagramView;
  promoted: { blocks: DiagramBlock[]; arrows: DiagramArrow[] };
  setNodes: Dispatch<SetStateAction<Node<BlockNodeData>[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  recentChanges: RecentChanges | null;
  editingBlockIds: Set<string>;
  editRegenIds: Set<string>;
  handleRenameBlock: (blockId: string, newLabel: string) => void;
  handleBlockAction: (blockId: string) => void;
  /** Positions the user has dragged blocks to, keyed by block id. Used
   *  to override the freshly computed dagre slot so a manual move
   *  survives a relayout. Owned by the canvas (also written by the
   *  drag handler). */
  userPositionsRef: MutableRefObject<Map<string, { x: number; y: number }>>;
}): void {
  /**
   * Inject `onLabelChange` / `onActions` callbacks + the recently-added
   * and editing flags into nodes produced by `layoutSchema` (which is
   * pure and doesn't know about component state). Honors a manual drag
   * over the freshly computed dagre slot so relayouts don't yank the
   * block back.
   */
  const attachInteractive = useCallback(
    (laidNodes: Node<BlockNodeData>[]) => {
      // Promoted detail blocks cannot be renamed: the rename pipeline
      // writes state.schema only, so on them it was a silent no-op.
      // Omitting the handler removes the affordance entirely (BlockNode
      // gates the double-click rename on its presence).
      const promotedIds = new Set(promoted.blocks.map((b) => b.id));
      const result = laidNodes.map((n) => {
        const dragged = userPositionsRef.current.get(n.id);
        return {
          ...n,
          // Honor a manual drag over the freshly computed dagre slot so
          // relayouts (selection toggle, bubble open) don't yank the
          // block back.
          position: dragged ?? n.position,
          data: {
            ...n.data,
            isRecentlyAdded:
              recentChanges?.blockIds.has(n.id) ?? false,
            isEditing:
              editingBlockIds.has(n.id) || editRegenIds.has(n.id),
            onLabelChange: promotedIds.has(n.id)
              ? undefined
              : (newLabel: string) => handleRenameBlock(n.id, newLabel),
            onActions: () => handleBlockAction(n.id),
          },
        };
      });
      dlog("recent-debug:attachInteractive ran", {
        recentChangesBlockIds: recentChanges
          ? Array.from(recentChanges.blockIds)
          : null,
        nodeIds: result.map((n) => n.id),
        highlightedNodeIds: result
          .filter((n) => n.data.isRecentlyAdded)
          .map((n) => n.id),
      });
      return result;
    },
    [
      handleRenameBlock,
      handleBlockAction,
      recentChanges,
      editingBlockIds,
      editRegenIds,
      promoted,
      userPositionsRef,
    ],
  );

  /** Post-pass on layoutSchema's edges that tags any edge whose
   *  source/target pair landed in recentChanges with the
   *  `recent-change-edge` class — solid blue stroke that persists
   *  until the user takes their next action (dismissRecentEdit). */
  const tagRecentEdges = useCallback(
    (laidEdges: Edge[]) => {
      if (!recentChanges || recentChanges.arrowKeys.size === 0) {
        dlog("recent-debug:tagRecentEdges (no recent arrows)", {
          recentChanges: recentChanges ? "non-null but empty" : "null",
        });
        return laidEdges;
      }
      const matched: string[] = [];
      const result = laidEdges.map((e) => {
        const key = `${e.source}->${e.target}`;
        if (!recentChanges.arrowKeys.has(key)) return e;
        matched.push(key);
        // Override the inline style directly — layoutSchema puts a
        // hard-coded `stroke: "#666666"` on every settled edge, which
        // beats our `.recent-change-edge` CSS class on actual render
        // (inline style wins specificity even against !important in
        // some React Flow paths). Setting it here is the only sure
        // way to get the blue "just edited" stroke on the recent edges.
        return {
          ...e,
          className: e.className
            ? `${e.className} recent-change-edge`
            : "recent-change-edge",
          style: {
            ...(e.style ?? {}),
            stroke: "#3B5BD9",
            strokeWidth: 2,
          },
          // Recolor the arrowhead to match the blue stroke.
          markerEnd:
            e.markerEnd && typeof e.markerEnd === "object"
              ? { ...e.markerEnd, color: "#3B5BD9" }
              : e.markerEnd,
          data: { ...(e.data ?? {}), recent: true },
        };
      });
      dlog("recent-debug:tagRecentEdges ran", {
        recentChangesArrowKeys: Array.from(recentChanges.arrowKeys),
        laidEdges: laidEdges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          key: `${e.source}->${e.target}`,
        })),
        matched,
      });
      return result;
    },
    [recentChanges],
  );

  // Re-render base canvas; also the selection re-layout (selectedId is a
  // dep), so dagre makes room for an expanded block. There used to be a
  // second, earlier effect doing the selection pass WITHOUT the promoted
  // blocks merged in; both fired on the same commits and only effect
  // ordering kept promoted blocks on the canvas, so it was removed.
  // Detail blocks live in the side panel by default; the user can promote
  // individual ones into the main diagram and from then on they layout
  // alongside base blocks.
  useEffect(() => {
    if (state.kind !== "ready") return;
    // Blocks the user explicitly promoted onto the canvas stay exempt
    // from the focus dim: fogging the thing they JUST pulled out of the
    // panel read as the canvas rejecting it.
    const focusedIds =
      view === "focus" && focused
        ? [...focused.ids, ...promoted.blocks.map((b) => b.id)]
        : null;
    const merged: DiagramSchema = {
      blocks: [...state.schema.blocks, ...promoted.blocks],
      arrows: [...state.schema.arrows, ...promoted.arrows],
    };
    const laid = layoutSchema(merged, selectedId, focusedIds);
    dlog("recent-debug:base-canvas layout effect", {
      schemaArrowKeys: state.schema.arrows.map(
        (a) => `${a.from}->${a.to}(pending=${a.pending ?? "none"})`,
      ),
      laidEdgeKeys: laid.edges.map((e) => `${e.source}->${e.target}`),
      recentChanges: null,
    });
    setNodes(attachInteractive(laid.nodes));
    setEdges(tagRecentEdges(laid.edges));
  }, [
    state,
    selectedId,
    focused,
    view,
    promoted,
    setNodes,
    setEdges,
    attachInteractive,
    tagRecentEdges,
  ]);
}
