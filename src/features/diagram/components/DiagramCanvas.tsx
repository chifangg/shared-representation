/**
 * The diagram canvas — public entry point of the feature.
 *
 * `DiagramCanvas` is a thin wrapper that mounts the ReactFlowProvider
 * so the inner orchestrator can call `useReactFlow()` (via the
 * useCanvasFit / useViewportFocusFit hooks). All the actual state +
 * effects + interactions live inside `DiagramCanvasInner` below.
 *
 * The inner component is now mostly wiring + the JSX layout shell.
 * Hooks own the heavy machinery: fetch lifecycles, settle effect,
 * recent-changes diff, canvas fit, the visual-edit / connection flow
 * (useVisualEditHandlers), and the node/edge decoration + layout
 * effects (useCanvasDecoration).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  ConnectionMode,
  Controls,
  useNodesState,
  useEdgesState,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useProject } from "@/core/project";
import { useChatActivity } from "@/core/chatActivity";
import { categoryStyle } from "../util/blockCategory";
import { DiagramActionEntry } from "./overlays/DiagramActionEntry";
import {
  type BlockNodeData,
  type DiagramArrow,
  type DiagramBlock,
  type DiagramView,
} from "../types";
import { useEdgeRouting } from "../hooks/useEdgeRouting";
import { useBlockCapabilityRefresh } from "../hooks/useBlockCapabilityRefresh";
import { useDiagramStructureFetch } from "../hooks/useDiagramStructureFetch";
import { useCapabilityScan } from "../hooks/useCapabilityScan";
import { useAdaptiveFocus } from "../hooks/useAdaptiveFocus";
import {
  useRecentChanges,
  type PreRegenSnapshot,
} from "../hooks/useRecentChanges";
import { useEditSummary } from "../hooks/useEditSummary";
import { useChatSettleEffect } from "../hooks/useChatSettleEffect";
import { useCanvasFit } from "../hooks/useCanvasFit";
import { useViewportFocusFit } from "../hooks/useViewportFocusFit";
import { useBubbleFocus } from "../hooks/useBubbleFocus";
import { useEditingBlocks } from "../hooks/useEditingBlocks";
import { useVisualEditHandlers } from "../hooks/useVisualEditHandlers";
import { useCanvasDecoration } from "../hooks/useCanvasDecoration";
import { useDiagramBus, useDiagramBusSubscribe } from "../protocol/bus";
import { nodeTypes } from "./nodes/BlockNode";
import { edgeTypes } from "./nodes/LabeledEdge";
import { ConnectionOptionsOverlay } from "./overlays/ConnectionOptionsOverlay";
import { IntentGate } from "./overlays/IntentGate";
import { DiagramFetchOverlay } from "./overlays/DiagramFetchOverlay";
import { EditSummaryToast } from "./overlays/EditSummaryToast";
import { DiagramControls } from "./overlays/DiagramControls";
import { ColorSchemeLegend } from "./overlays/ColorSchemeLegend";
import { useColorScheme } from "../color/useColorScheme";
import { resolveBlockColor } from "../color/scheme";
import { BubbleEditOverlays } from "./overlays/BubbleEditOverlays";
import { ConnectionLensOverlay } from "./overlays/ConnectionLensOverlay";
import { useConnectionLens } from "../hooks/useConnectionLens";
import { useBubbleEditOverlays } from "../hooks/useBubbleEditOverlays";
import { useOnboardingIntent } from "../hooks/useOnboardingIntent";
import { IntentSurvey } from "./overlays/IntentSurvey";
import { SurveyPreparingOverlay } from "./overlays/SurveyPreparingOverlay";
import { IntentChip } from "./overlays/IntentChip";
import { DiagramFocusPanel } from "./panel/DiagramFocusPanel";

/** Stable empty-blocks reference so useEditingBlocks' effect dep doesn't
 *  change identity every render while no schema is ready. */
const EMPTY_BLOCKS: DiagramBlock[] = [];

export function DiagramCanvas({
  view,
  onViewChange,
  headerSlot,
}: {
  view: DiagramView;
  /** Switch the diagram view. The overview/focus toggle now lives on the
   *  canvas (DiagramControls) rather than the panel header. */
  onViewChange: (v: DiagramView) => void;
  /** DOM node in the panel header where the intent chip portals itself,
   *  so it lives in the chrome instead of floating over the canvas. */
  headerSlot?: HTMLElement | null;
}) {
  return (
    <ReactFlowProvider>
      <DiagramCanvasInner
        view={view}
        onViewChange={onViewChange}
        headerSlot={headerSlot}
      />
    </ReactFlowProvider>
  );
}

function DiagramCanvasInner({
  view,
  onViewChange,
  headerSlot,
}: {
  view: DiagramView;
  onViewChange: (v: DiagramView) => void;
  headerSlot?: HTMLElement | null;
}) {
  const { files, chatMessages, chatRunning, projectKey } = useProject();
  const bus = useDiagramBus();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [promoted, setPromoted] = useState<{
    blocks: DiagramBlock[];
    arrows: DiagramArrow[];
  }>({ blocks: [], arrows: [] });
  const [panelWidth, setPanelWidth] = useState(380);
  // Bubble drill-in editors (per-function detail card + per-surface
  // appearance card). State, click-routing, and reset live in the hook;
  // this component only owns the code-write dispatch on confirm.
  const bubbleEdit = useBubbleEditOverlays(projectKey);
  // Snapshot of the schema captured just before each auto-regen so
  // useRecentChanges can diff and glow whatever Claude added.
  const preRegenSnapshotRef = useRef<PreRegenSnapshot | null>(null);
  // While an edit-driven regen runs, keep the old diagram up + pulse the
  // edited block(s) instead of blanking. The ref gates the fetch hook;
  // editRegenIds drives the pulse and clears on the next ready.
  const preserveRegenRef = useRef<{ active: boolean }>({ active: false });
  const [editRegenIds, setEditRegenIds] = useState<Set<string>>(new Set());
  // Blocks queued for an in-place capability/caption refresh after a
  // no-regen edit (filled by the settle effect, drained by the hook).
  // blockId -> extra files (created/edited this turn) to fold in.
  const [refreshTargets, setRefreshTargets] = useState<Map<string, string[]>>(
    new Map(),
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<BlockNodeData>>(
    [],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Connection-lens overlay (arrow-label pill drill-in). Owns its state,
  // the bus subscribe, reset, and the zoom-to-edge; the card floats next
  // to the clicked pill.
  const connection = useConnectionLens(projectKey, nodes);

  // Positions the user has dragged blocks to, keyed by block id. Re-laid
  // out nodes (e.g. when selection toggles or a bubble cluster opens)
  // are overridden with these so a manual move survives the relayout
  // instead of snapping back to dagre's slot. Cleared on project change.
  const userPositionsRef = useRef<Map<string, { x: number; y: number }>>(
    new Map(),
  );
  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      for (const c of changes) {
        if (c.type === "position" && c.position) {
          userPositionsRef.current.set(c.id, c.position);
        }
      }
      onNodesChange(changes);
    },
    [onNodesChange],
  );

  // Onboarding survey: gates the structure fetch. Null until the user
  // submits the survey; reset to null on projectKey change AND on the
  // explicit "Regenerate" button (which re-opens the modal).
  // Active color-encoding scheme (Category default + a test scheme;
  // AI-generated ones append in Phase 2). Drives block colors + legend.
  const color = useColorScheme();
  const activeScheme = color.active;
  const [userGoal, setUserGoal] = useState<string | null>(null);
  // Gates the survey behind the intro overlay: the survey only opens
  // once the intro timeline finished AND the scan resolved. Reset
  // alongside userGoal (projectKey change).
  const [surveyIntroDone, setSurveyIntroDone] = useState(false);
  const handleSurveyIntroReady = useCallback(
    () => setSurveyIntroDone(true),
    [],
  );

  // Capability scan fires in parallel with the survey opening — by the
  // time the user picks Edit/Reference the picklist is usually ready.
  const scanState = useCapabilityScan({ projectKey, files });

  // Structure fetch lifecycle: reset on projectKey, stream
  // /api/diagram?view=structure into FetchState + nodes + edges. Gated
  // on userGoal — fires only after the survey completes.
  const { state, setState, setRetryNonce } = useDiagramStructureFetch({
    projectKey,
    files,
    userGoal,
    selectedId,
    setNodes,
    setEdges,
    preserveRegenRef,
  });

  // Hand the edit pulse off to the post-regen glow: once the rebuild is
  // ready, clear the through-regen pulse (recentChanges takes over).
  useEffect(() => {
    if (state.kind === "ready") {
      setEditRegenIds((prev) => (prev.size === 0 ? prev : new Set()));
    }
  }, [state.kind]);

  // Adaptive focus lifecycle: debounced /api/diagram?view=focus on
  // each new user turn. Resets on projectKey.
  const { focused, regenerating, emptyRound } = useAdaptiveFocus({
    view,
    state,
    files,
    chatMessages,
    projectKey,
  });

  // recentChanges (the glow) + editSummary (the toast) lifecycles.
  const { recentChanges, setRecentChanges } = useRecentChanges({
    state,
    preRegenSnapshotRef,
  });
  const { editSummary, setEditSummary } = useEditSummary();

  // Mirror the diagram's reaction to a code-editing turn into the chat
  // transcript: when features are re-derived on a block, drop a sand
  // "Updated the diagram" record under the agent reply that caused it,
  // tagged to that turn's sequence. The record flashes blue on mount in
  // sync with the canvas glow. Pushed through the core chat-activity
  // channel so ChatView stays unaware of diagram specifics.
  const { pushEntry: pushChatActivity } = useChatActivity();
  useEffect(() => {
    const labels = editSummary?.blocks;
    if (!labels || labels.length === 0) return;
    const blocks = state.kind === "ready" ? state.schema.blocks : [];
    const chips = labels.map((label) => {
      const cat = blocks.find((b) => b.label === label)?.category;
      return { label, accent: categoryStyle(cat)?.accent ?? "#978B77" };
    });
    const seq = chatMessages.length
      ? chatMessages[chatMessages.length - 1]._seq
      : 0;
    pushChatActivity({
      id: `feat:${seq}:${labels.join("|")}`,
      afterSeq: seq,
      node: <DiagramActionEntry verb="Updated the diagram" chips={chips} />,
    });
    // Read state / chatMessages from the render where editSummary settled
    // (both are final by then); re-running on their later changes would
    // mis-tag the record to a newer turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSummary, pushChatActivity]);

  // Bidirectional editing: a chat-driven diagram tool (change_block_color /
  // delete_block) emits "diagram-op"; apply it to the current schema,
  // matched best-effort by the block's displayed label.
  useDiagramBusSubscribe("diagram-op", (detail) => {
    setState((prev) => {
      if (prev.kind !== "ready") return prev;
      const norm = detail.block.trim().toLowerCase();
      const target =
        prev.schema.blocks.find((b) => b.label.toLowerCase() === norm) ??
        prev.schema.blocks.find((b) => b.label.toLowerCase().includes(norm));
      if (!target) return prev;
      if (detail.op === "recolor") {
        return {
          kind: "ready",
          schema: {
            arrows: prev.schema.arrows,
            blocks: prev.schema.blocks.map((b) =>
              b.id === target.id
                ? { ...b, category: detail.category as typeof b.category }
                : b,
            ),
          },
        };
      }
      return {
        kind: "ready",
        schema: {
          blocks: prev.schema.blocks.filter((b) => b.id !== target.id),
          arrows: prev.schema.arrows.filter(
            (a) => a.from !== target.id && a.to !== target.id,
          ),
        },
      };
    });
  });

  // Live blue pulse on the block(s) whose files Claude is editing RIGHT
  // NOW (turn in flight). Clears on settle, where recentChanges takes
  // over with the persistent post-edit glow.
  const fileEditingBlockIds = useEditingBlocks({
    chatRunning,
    chatMessages,
    blocks: state.kind === "ready" ? state.schema.blocks : EMPTY_BLOCKS,
  });

  // Block-level edits (the "..." cards flow) glow the TARGET block from
  // the moment an option is executed through the whole turn, the same way
  // a freshly-drawn arrow stays blue. The file-based pulse above only
  // catches it once Claude actually writes a file (and after reading), so
  // we mark the target explicitly here and clear it when the turn ends.
  const [cardEditBlockIds, setCardEditBlockIds] = useState<Set<string>>(
    new Set(),
  );
  useDiagramBusSubscribe("option-executed", (detail) => {
    if (detail?.target.kind !== "block") return;
    const id = detail.target.id;
    setCardEditBlockIds((prev) =>
      prev.has(id) ? prev : new Set(prev).add(id),
    );
  });
  const prevChatRunningRef = useRef(chatRunning);
  useEffect(() => {
    if (prevChatRunningRef.current && !chatRunning) {
      setCardEditBlockIds((prev) => (prev.size === 0 ? prev : new Set()));
    }
    prevChatRunningRef.current = chatRunning;
  }, [chatRunning]);

  const editingBlockIds = useMemo(() => {
    if (cardEditBlockIds.size === 0) return fileEditingBlockIds;
    const merged = new Set(fileEditingBlockIds);
    for (const id of cardEditBlockIds) merged.add(id);
    return merged;
  }, [fileEditingBlockIds, cardEditBlockIds]);

  // Click-a-block-to-expand-bubbles state. Bubbles are derived from the
  // block's provenance.functions and rendered as fan-laid ReactFlow
  // nodes; viewport pans/zooms to the cluster and restores on collapse.
  const {
    expandedBlockId,
    bubbleNodes,
    borrowOffsets,
    toggleBlock: toggleBubbleBlock,
    clear: clearBubbles,
  } = useBubbleFocus({
    projectKey,
    blocks: state.kind === "ready" ? state.schema.blocks : [],
    nodes,
  });

  // Merge bubble nodes with the layout-computed nodes for the ReactFlow
  // render. Kept derived (not state) so layoutSchema re-runs don't have
  // to know about bubbles, and bubbles vanish the instant useBubbleFocus
  // returns an empty array.
  //
  // Cast: BubbleNodeData ≠ BlockNodeData structurally, but bubble nodes
  // route through `type: "bubble"` → FunctionBubble (not BlockNode), and
  // are non-selectable / non-draggable, so onNodesChange never touches
  // their data fields. Safe at runtime; types just need the alignment.
  // A fan (expanded block) OR an open connection lens dims everything else
  // so the focused thing stands out: the fan keeps only its block; the lens
  // keeps only its two endpoint blocks (and, below, its one arrow).
  const lens = connection.lens;
  const renderedNodes = useMemo<Node<BlockNodeData>[]>(() => {
    const base = nodes.map((n) => {
      const moved = borrowOffsets.get(n.id);
      const dimByFan = expandedBlockId !== null && n.id !== expandedBlockId;
      const dimByLens =
        lens !== null && n.id !== lens.from && n.id !== lens.to;
      const dim = dimByFan || dimByLens;
      // Resolve this block's fill + accent through the active color
      // scheme. Done here (not at layout time) so switching schemes
      // recolors without re-running layout, preserving spatial memory.
      const resolved = resolveBlockColor(activeScheme, {
        id: n.id,
        label: n.data.label,
        category: n.data.category,
        fileCount: n.data.files?.length ?? 0,
      });
      const data = {
        ...n.data,
        colorTint: resolved?.tint,
        colorAccent: resolved?.accent,
        // Full description shows in lockstep with the drill-in bubbles:
        // both follow expandedBlockId, NOT React Flow's `selected` prop.
        // React Flow keeps `selected` true on a re-click, which would
        // leave the description open after the bubbles collapse.
        isExpanded: n.id === expandedBlockId,
      };
      if (!moved && !dim) return { ...n, data };
      return {
        ...n,
        data,
        position: moved ?? n.position,
        style: dim
          ? {
              ...n.style,
              opacity: 0.16,
              transition: "opacity 200ms ease",
              // Non-interactive while dimmed so a click on the area AROUND
              // an open fan / lens falls through to the pane and collapses
              // it, instead of being swallowed by a faded block.
              pointerEvents: "none" as const,
            }
          : n.style,
      };
    });
    return bubbleNodes.length === 0
      ? base
      : [...base, ...(bubbleNodes as unknown as Node<BlockNodeData>[])];
  }, [nodes, bubbleNodes, borrowOffsets, expandedBlockId, lens, activeScheme]);

  // Global obstacle-avoiding routing with lane separation (see hook).
  const edgesWithRoutes = useEdgeRouting(nodes, edges);

  // Fade + de-activate every edge and its label while a fan is open, so
  // no line or label pill floats over the bubbles. `data.dimmed` lets
  // LabeledEdge drop the pill's opacity and pointer events; the path
  // dims via the style opacity. Restores the moment the fan collapses.
  const renderedEdges = useMemo<Edge[]>(() => {
    const dimEdge = (e: Edge): Edge => ({
      ...e,
      style: { ...e.style, opacity: 0.1, transition: "opacity 200ms ease" },
      data: { ...e.data, dimmed: true },
    });
    if (expandedBlockId !== null) return edgesWithRoutes.map(dimEdge);
    if (lens !== null) {
      // Lens open: keep only the lensed arrow lit, dim the rest, so the
      // popup + its two blocks + that one arrow read clearly.
      return edgesWithRoutes.map((e) =>
        e.source === lens.from && e.target === lens.to ? e : dimEdge(e),
      );
    }
    return edgesWithRoutes;
  }, [edgesWithRoutes, expandedBlockId, lens]);


  // Reset the small in-component state on USER-initiated project
  // change. (FetchState, nodes/edges, focused, regenerating are
  // already reset by the hooks above.)
  useEffect(() => {
    setSelectedId(null);
    setPromoted({ blocks: [], arrows: [] });
    setUserGoal(null);
    setSurveyIntroDone(false);
    userPositionsRef.current.clear();
  }, [projectKey]);

  /** Wipe the canvas so a regenerate starts from a blank slate. The
   *  structure fetch re-fires once userGoal is (re)set and state is idle. */
  const onRegenerate = useCallback(() => {
    setState({ kind: "idle" });
    setNodes([]);
    setEdges([]);
    setSelectedId(null);
    setPromoted({ blocks: [], arrows: [] });
  }, [setState, setNodes, setEdges]);

  const intentCtl = useOnboardingIntent({
    projectKey,
    userGoal,
    setUserGoal,
    onRegenerate,
  });

  // We deliberately do NOT clear `focused` when switching away from
  // focus view — the layout/panel both already gate on `view === "focus"`,
  // so the side panel and spotlight just disappear visually while the
  // state survives. Toggling back into focus restores what the user
  // was looking at instead of forcing them to re-ask the question.

  /** Clears the "just edited" visual state — recent-change highlight
   *  on blocks/arrows AND the edit-summary toast. Called from every
   *  user-action handler so the highlight survives until they
   *  actually look away. */
  const dismissRecentEdit = useCallback(() => {
    setRecentChanges(null);
    setEditSummary(null);
  }, []);

  // Visual-edit / connection flow: pending-arrow + placeholder-block
  // visuals, the intent gate, the suggestion cards, and the round-2
  // execute dispatch. Owns the three bus subscribers and the
  // chosenOptionsRef that useChatSettleEffect consumes below.
  const visualEdit = useVisualEditHandlers({
    state,
    setState,
    files,
    bus,
    dismissRecentEdit,
    setSelectedId,
  });

  const onNodeClick = useCallback(
    (evt: React.MouseEvent, node: Node) => {
      // NOTE: do NOT dismiss the recent-change glow here. Expanding a
      // block's bubbles / opening a bubble's detail is INSPECTION, not the
      // user's next edit, so the "just edited" highlight must survive it
      // (it clears only on a real next action: a new arrow / block edit /
      // chat prompt).
      if (node.type === "bubble") {
        bubbleEdit.openFromBubble(node, evt);
        return;
      }
      setSelectedId((prev) => (prev === node.id ? null : node.id));
      toggleBubbleBlock(node.id);
    },
    [toggleBubbleBlock, bubbleEdit],
  );

  // Detect double-click on the empty canvas (no built-in handler in
  // React Flow for this on the pane). Two onPaneClick events within
  // 300ms => add-new-block. A single click still deselects as before.
  const lastPaneClickRef = useRef(0);
  const onPaneClick = useCallback(() => {
    const now = Date.now();
    if (now - lastPaneClickRef.current < 300) {
      lastPaneClickRef.current = 0;
      visualEdit.handleAddNewBlock();
      return;
    }
    lastPaneClickRef.current = now;
    // Deselect / collapse bubbles is inspection, not a next edit, so keep
    // the recent-change glow (add-new-block on double-click dismisses via
    // its own handler).
    setSelectedId(null);
    clearBubbles();
  }, [visualEdit, clearBubbles]);

  // Diff-on-ready glow handled by useRecentChanges above.
  // Settle effect (arrow outcomes, regen, edit-summary) handled below.
  useChatSettleEffect({
    chatRunning,
    chatMessages,
    state,
    setState,
    chosenOptionsRef: visualEdit.chosenOptionsRef,
    preRegenSnapshotRef,
    preserveRegenRef,
    setRetryNonce,
    setRecentChanges,
    setEditSummary,
    setEditRegenIds,
    setRefreshTargets,
  });

  // After a no-regen edit, re-derive the edited block(s)' caption +
  // capabilities in place so the bubbles + description reflect the change.
  useBlockCapabilityRefresh({
    refreshTargets,
    setRefreshTargets,
    state,
    setState,
    files,
  });

  // Adaptive focus lifecycle handled by useAdaptiveFocus above.

  // Node + edge decoration post-pass (recent-change glow, editing
  // pulse, per-node callbacks, user-drag overrides) + the two layout
  // effects that feed it into React Flow (selection-toggle relayout +
  // base-canvas re-render). Drives setNodes / setEdges directly.
  useCanvasDecoration({
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
    handleRenameBlock: visualEdit.handleRenameBlock,
    handleBlockAction: visualEdit.handleBlockAction,
    userPositionsRef,
  });

  // Camera pan to focused base block(s) when a focus delta arrives.
  useViewportFocusFit({ view, focused });

  // Auto-fit during streaming + final fit + ResizeObserver-driven refit.
  const canvasContainerRef = useCanvasFit({ state, view, focused, nodes });

  // The panel is open for the WHOLE of focus mode, not just once there's
  // content. Switching into adaptive focus animates it in immediately; with
  // nothing prompted yet it shows a welcome invite, then the loading state
  // once a round starts, then the detail mini-graph. This keeps the focus-mode
  // toggle anchored to the panel's corner instead of leaving a bare canvas
  // with a floating banner.
  const panelOpen = view === "focus";

  return (
    <div className="relative flex h-full w-full bg-[#FAFAFA]">
      <div
        ref={canvasContainerRef}
        className={`relative h-full ${panelOpen ? "flex-1 min-w-0" : "w-full"}`}
      >
        {/* The regen "fog" dims only the diagram CONTENT (nodes, edges,
         *  labels) so the reader sees it's stale/rebuilding. The overlay
         *  controls below (focus toggle, legend, add button) sit outside this
         *  layer and stay crisp: fogging a control you might click reads as a
         *  glitch, not as feedback. */}
        <div
          className={`absolute inset-0 transition-opacity duration-300 ${
            regenerating || editRegenIds.size > 0 ? "opacity-60" : "opacity-100"
          }`}
        >
          <ReactFlow
            nodes={renderedNodes}
            edges={renderedEdges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={visualEdit.handleAddConnection}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1.6 }}
            proOptions={{ hideAttribution: true }}
            minZoom={0.3}
            maxZoom={2}
            nodesDraggable
            nodesConnectable={state.kind === "ready"}
            connectionMode={ConnectionMode.Loose}
            nodesFocusable={false}
            elementsSelectable={false}
          >
            <Background color="#E0E0E0" gap={16} />
            <Controls
              showInteractive={false}
              className="!border-[#D4D4D4] !bg-white"
            />
          </ReactFlow>
        </div>
        <DiagramFetchOverlay
          state={state}
          hasFiles={files.length > 0}
          nodeCount={nodes.length}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
        {/* Adaptive-focus welcome / loading / streaming count all live INSIDE
         *  the side panel (DiagramFocusPanel), which is open for the whole of
         *  focus mode, so nothing floats over the canvas during a focus round. */}
        {visualEdit.pendingOptions && state.kind === "ready" && (
          <ConnectionOptionsOverlay
            target={visualEdit.pendingOptions.target}
            options={visualEdit.pendingOptions.options}
            blocks={state.schema.blocks}
            onPick={visualEdit.handlePickOption}
            onCancel={visualEdit.handleCancelOptions}
          />
        )}
        {visualEdit.intentGate && state.kind === "ready" && (
          <IntentGate
            target={visualEdit.intentGate.target}
            blocks={state.schema.blocks}
            onAskSuggestions={visualEdit.handleIntentGateAskSuggestions}
            onDescribe={visualEdit.handleIntentGateDescribe}
            onCancel={visualEdit.handleIntentGateCancel}
          />
        )}
        {state.kind === "ready" &&
          intentCtl.intent !== null &&
          !intentCtl.editingIntent &&
          headerSlot &&
          createPortal(
            <IntentChip
              intent={intentCtl.intent}
              onEdit={intentCtl.openEditor}
            />,
            headerSlot,
          )}
        {userGoal === null &&
          files.length > 0 &&
          (surveyIntroDone &&
          (scanState.kind === "ready" || scanState.kind === "error") ? (
            <IntentSurvey scanState={scanState} onComplete={intentCtl.complete} />
          ) : (
            <SurveyPreparingOverlay
              scanState={scanState}
              onReady={handleSurveyIntroReady}
            />
          ))}
        {intentCtl.editingIntent && (
          <IntentSurvey
            scanState={scanState}
            initialSelection={intentCtl.intent ?? undefined}
            onComplete={intentCtl.revise}
            onCancel={intentCtl.closeEditor}
          />
        )}
        {editSummary && (
          <EditSummaryToast
            summary={editSummary}
            onDismiss={() => setEditSummary(null)}
          />
        )}
        {state.kind === "ready" && view === "overview" && (
          <ColorSchemeLegend
            schemes={color.schemes}
            active={color.active}
            onSelect={color.setActiveId}
            blocks={state.schema.blocks}
            onGenerate={(instruction) =>
              color.generate(state.schema.blocks, instruction)
            }
            generating={color.generating}
            genError={color.genError}
            onClearGenError={color.clearGenError}
            topAccessory={
              !visualEdit.pendingOptions && !visualEdit.intentGate ? (
                <button
                  type="button"
                  onClick={visualEdit.handleAddNewBlock}
                  title="Add a new module (or double-click the empty canvas)"
                  className="flex items-center gap-1.5 rounded-full border border-[#78716C]/20 bg-white/95 py-2 pl-3 pr-3.5 text-[12px] font-medium text-[#484848] shadow-lg backdrop-blur-[2px] transition-colors hover:bg-white"
                >
                  <Plus className="h-4 w-4 text-[#78716C]" strokeWidth={2} />
                  Add block
                </button>
              ) : null
            }
          />
        )}
        {state.kind === "ready" && (
          <BubbleEditOverlays
            blocks={state.schema.blocks}
            files={files}
            detail={bubbleEdit.detail}
            onCloseDetail={bubbleEdit.closeDetail}
            onConfirmDetail={(blockId, instruction) => {
              visualEdit.dispatchExecuteDirect(
                { kind: "block", id: blockId },
                instruction,
              );
              bubbleEdit.closeDetail();
              clearBubbles();
            }}
          />
        )}
        {connection.lens &&
          state.kind === "ready" &&
          (() => {
            // Resolve the two endpoint blocks' colors through the active
            // scheme so the lens header can tint each end to match its
            // block on the canvas (instead of an arbitrary accent).
            const ln = connection.lens;
            const blocks = state.schema.blocks;
            const accentOf = (id: string): string | null => {
              const b = blocks.find((x) => x.id === id);
              if (!b) return null;
              return (
                resolveBlockColor(activeScheme, {
                  id: b.id,
                  label: b.label,
                  category: b.category,
                  fileCount: b.provenance.files.length,
                })?.accent ?? null
              );
            };
            return (
              <ConnectionLensOverlay
                key={`${ln.from}-${ln.to}-${ln.verb}`}
                detail={ln}
                blocks={blocks}
                files={files}
                onClose={connection.close}
                offset={connection.cardOffset}
                onOffsetChange={connection.setCardOffset}
                fromColor={accentOf(ln.from)}
                toColor={accentOf(ln.to)}
              />
            );
          })()}
      </div>
      {panelOpen && state.kind === "ready" && (
        <DiagramFocusPanel
          baseBlocks={state.schema.blocks}
          focused={focused ?? { ids: [], blocks: [], arrows: [] }}
          streaming={regenerating}
          emptyRound={emptyRound}
          promotedIds={new Set(promoted.blocks.map((b) => b.id))}
          width={panelWidth}
          onWidthChange={setPanelWidth}
          // Closing the panel means leaving focus mode (same as the toggle).
          // `focused` is intentionally kept so returning restores the view.
          onClose={() => onViewChange("overview")}
          onPromote={(b) => {
            // NOTE: promoting adds a node + arrow to the merged schema, so
            // dagre re-lays-out the whole graph and unrelated blocks can
            // shift slightly (an arrow visibly re-routing). We do NOT pin all
            // block positions here to stop that: pinning writes into the
            // manual-drag override, which then freezes the diagram's live
            // auto-layout for the rest of the session (make-room on select,
            // re-layout on regen all stop). The proper fix is to lay promoted
            // blocks out beside their parent OUTSIDE the global dagre pass so
            // base blocks are never disturbed; that is a separate change.
            setPromoted((prev) => {
              if (prev.blocks.some((x) => x.id === b.id)) return prev;
              const knownIds = new Set([
                ...state.schema.blocks.map((x) => x.id),
                ...prev.blocks.map((x) => x.id),
                b.id,
              ]);
              const newArrows = focused!.arrows.filter(
                (a) =>
                  (a.from === b.id || a.to === b.id) &&
                  knownIds.has(a.from) &&
                  knownIds.has(a.to) &&
                  !prev.arrows.some(
                    (p) =>
                      p.from === a.from &&
                      p.to === a.to &&
                      p.label === a.label,
                  ),
              );
              // Inherit the parent overview region's category so the
              // promoted block gets a real color instead of rendering
              // white on the canvas. DROP `parent` so that region isn't
              // turned into a container frame; wire an explicit arrow to
              // it instead so the block stays connected to where it came
              // from.
              const parentBlock = b.parent
                ? state.schema.blocks.find((x) => x.id === b.parent)
                : undefined;
              const promotedBlock: DiagramBlock = {
                ...b,
                parent: null,
                category: b.category ?? parentBlock?.category,
              };
              const alreadyLinked =
                !parentBlock ||
                newArrows.some(
                  (a) =>
                    (a.from === parentBlock.id && a.to === b.id) ||
                    (a.from === b.id && a.to === parentBlock.id),
                ) ||
                prev.arrows.some(
                  (p) => p.from === parentBlock.id && p.to === b.id,
                );
              const parentArrow =
                parentBlock && !alreadyLinked
                  ? [{ from: parentBlock.id, to: b.id, label: "detail" }]
                  : [];
              return {
                blocks: [...prev.blocks, promotedBlock],
                arrows: [...prev.arrows, ...newArrows, ...parentArrow],
              };
            });
          }}
          onUnpromote={(b) => {
            setPromoted((prev) => ({
              blocks: prev.blocks.filter((x) => x.id !== b.id),
              arrows: prev.arrows.filter(
                (a) => a.from !== b.id && a.to !== b.id,
              ),
            }));
          }}
        />
      )}
      {/* Focus-mode toggle anchored to the OUTER container's bottom-right, so
       *  it holds the same screen spot whether the side panel is open or not
       *  (over the panel's corner when open). Sits outside the canvas div on
       *  purpose: otherwise the opening panel would shove it left, making the
       *  user chase it to switch back. */}
      {state.kind === "ready" && (
        <DiagramControls view={view} onViewChange={onViewChange} />
      )}
    </div>
  );
}

// DiagramFocusPanel, MiniBlockNode, MiniLabeledEdge, FocusMiniGraph,
// DiagramFetchOverlay, ElapsedClock, DiagramLoadingCard,
// ConnectionOptionsOverlay, IntentGate, and OptionCardButton all moved
// to @/features/diagram/components/. Imported above.
