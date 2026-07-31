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
import { DiagramActionEntry } from "./overlays/DiagramActionEntry";
import {
  type BlockCategory,
  type BlockNodeData,
  type DiagramArrow,
  type DiagramBlock,
  type DiagramSchema,
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
import {
  useInteractionTracker,
  type TracedStep,
} from "../hooks/useInteractionTracker";
import { blockChip, useTrackerRecorder } from "../hooks/useTrackerRecorder";
import { useTraceFit } from "../hooks/useTraceFit";
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
import { DiagramControls } from "./overlays/DiagramControls";
import { TrackerButton } from "./overlays/TrackerButton";
import { TrackerTray } from "./overlays/TrackerTray";
import { ColorSchemeLegend } from "./overlays/ColorSchemeLegend";
import { useColorScheme } from "../color/useColorScheme";
import { resolveBlockColorWithFallback } from "../color/scheme";
import { BubbleEditOverlays } from "./overlays/BubbleEditOverlays";
import { ConnectionLensOverlay } from "./overlays/ConnectionLensOverlay";
import { useConnectionLens } from "../hooks/useConnectionLens";
import { useBubbleEditOverlays } from "../hooks/useBubbleEditOverlays";
import { useOnboardingIntent } from "../hooks/useOnboardingIntent";
import { IntentSurvey } from "./overlays/IntentSurvey";
import { SurveyPreparingOverlay } from "./overlays/SurveyPreparingOverlay";
import { IntentChip } from "./overlays/IntentChip";
import { DiagramFocusPanel } from "./panel/DiagramFocusPanel";

/** Stable empty references so effect deps don't change identity every
 *  render while no schema is ready. */
const EMPTY_BLOCKS: DiagramBlock[] = [];
const EMPTY_ARROWS: DiagramArrow[] = [];

export function DiagramCanvas({
  view,
  onViewChange,
  headerSlot,
  headerRightSlot,
}: {
  view: DiagramView;
  /** Switch the diagram view. The overview/focus toggle now lives on the
   *  canvas (DiagramControls) rather than the panel header. */
  onViewChange: (v: DiagramView) => void;
  /** DOM node in the panel header where the intent chip portals itself,
   *  so it lives in the chrome instead of floating over the canvas. */
  headerSlot?: HTMLElement | null;
  /** Right-aligned header slot for the interaction-tracker button. */
  headerRightSlot?: HTMLElement | null;
}) {
  return (
    <ReactFlowProvider>
      <DiagramCanvasInner
        view={view}
        onViewChange={onViewChange}
        headerSlot={headerSlot}
        headerRightSlot={headerRightSlot}
      />
    </ReactFlowProvider>
  );
}

function DiagramCanvasInner({
  view,
  onViewChange,
  headerSlot,
  headerRightSlot,
}: {
  view: DiagramView;
  onViewChange: (v: DiagramView) => void;
  headerSlot?: HTMLElement | null;
  headerRightSlot?: HTMLElement | null;
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
  const connection = useConnectionLens(projectKey);

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

  // THE one merged "schema as the user sees it": base plus promoted.
  // Every label-resolving consumer reads these (bubbles, lens, gates,
  // cards, tracker chips, color fallbacks, visual-edit guards), so the
  // merge semantics exist in exactly one place. Promoted blocks live in
  // their own state slot; any consumer fed only state.schema treats them
  // as unresolvable ids.
  const allBlocks = useMemo(
    () =>
      state.kind === "ready"
        ? [...state.schema.blocks, ...promoted.blocks]
        : EMPTY_BLOCKS,
    [state, promoted],
  );
  const allArrows = useMemo(
    () =>
      state.kind === "ready"
        ? [...state.schema.arrows, ...promoted.arrows]
        : EMPTY_ARROWS,
    [state, promoted],
  );
  const viewSchema = useMemo<DiagramSchema>(
    () => ({ blocks: allBlocks, arrows: allArrows }),
    [allBlocks, allArrows],
  );

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

  // Interaction tracker: the ordered list of agent-driven diagram changes
  // (fed at the change points below), whether the tray is open, and which
  // step the user is currently tracing back (drives a gold ring + a camera
  // move, never any state change). Declared before the glow hook so the
  // per-regen delta can feed it.
  const tracker = useInteractionTracker(projectKey);
  // Row assembly (chips, accent fallback, dedupe keys) lives in the
  // recorder so each change point below is a one-line record* call.
  const recorder = useTrackerRecorder(tracker.addEntry);
  const trackerSelect = tracker.select;
  const [trackerOpen, setTrackerOpen] = useState(false);
  // The Tracker header button, so its dropdown tray can anchor beneath it.
  const trackerBtnRef = useRef<HTMLButtonElement>(null);
  const [tracedStep, setTracedStep] = useState<TracedStep>(null);
  // A trace-back highlight is a transient INSPECTION. Clear it (ring + tray
  // row selection) the moment the user starts a new turn: both typed chat and
  // visual edits flip chatRunning, so this fires before the ensuing regen,
  // which means the traced block fogs normally with the rest instead of
  // lingering highlighted. (Also cleared on pane-click and tray-close.)
  const clearTrace = useCallback(() => {
    setTracedStep(null);
    trackerSelect(null);
  }, [trackerSelect]);
  useEffect(() => {
    if (chatRunning) clearTrace();
  }, [chatRunning, clearTrace]);

  // recentChanges (the glow) + editSummary (the toast) lifecycles. The
  // regen delta also feeds the tracker: one row per element (blocks added
  // / edited / removed, arrows linked / unlinked). Edited blocks there
  // come from the POST-regen file mapping (typed-chat edits); no-regen
  // card edits are recorded from the option-executed subscriber instead.
  const { recentChanges, setRecentChanges } = useRecentChanges({
    state,
    preRegenSnapshotRef,
    onDelta: recorder.recordDelta,
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
    // Resolve each label to its id + category. On the typed-chat REGEN path
    // this effect runs while `state` is momentarily "idle" (the settle effect
    // sets editSummary and state=idle in the same commit), so state.schema is
    // empty here; fall back to the pre-regen snapshot's blockMeta so the chip
    // colours AND the trace-back ids still resolve (otherwise the "edited" row
    // would be grey and click-dead). The no-regen card path keeps state ready,
    // so the live schema wins there.
    const readyBlocks = allBlocks;
    const snapMeta = preRegenSnapshotRef.current?.blockMeta;
    const resolve = (
      label: string,
    ): { id?: string; category?: BlockCategory } => {
      const rb = readyBlocks.find((b) => b.label === label);
      if (rb) return { id: rb.id, category: rb.category };
      if (snapMeta) {
        for (const [id, m] of snapMeta) {
          if (m.label === label) return { id, category: m.category };
        }
      }
      return {};
    };
    const resolved = labels.map((label) => ({ label, ...resolve(label) }));
    const chips = resolved.map((r) => blockChip(r.label, r.category));
    const seq = chatMessages.length
      ? chatMessages[chatMessages.length - 1]._seq
      : 0;
    pushChatActivity({
      id: `feat:${seq}:${labels.join("|")}`,
      afterSeq: seq,
      node: (
        <DiagramActionEntry
          verb="Updated the diagram"
          chips={chips}
          // The dropped-connection notice used to live on the floating
          // "Just edited" card; that card duplicated the chat's closing
          // message and was removed, so the notice rides here instead.
          note={editSummary?.note}
        />
      ),
    });
    // NOTE: the tracker's "edited" row is NOT recorded here. Card edits (block
    // "..." / bubble) are recorded immediately from the known target in the
    // option-executed subscriber above; typed-chat edits come from the
    // post-regen delta (useRecentChanges). This effect only pushes the chat
    // "Updated the diagram" chip, so it never double-counts.
    // Read state / chatMessages from the render where editSummary settled
    // (both are final by then); re-running on their later changes would
    // mis-tag the record to a newer turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSummary, pushChatActivity]);

  // Bidirectional editing: a chat-driven diagram tool (change_block_color /
  // delete_block) emits "diagram-op"; apply it to the current schema,
  // matched best-effort by the block's displayed label.
  useDiagramBusSubscribe("diagram-op", (detail) => {
    // Record the op in the tracker (in diagram terms) before applying it.
    // Resolve the target the same way the schema update below does, off the
    // current render's state (kept fresh by useDiagramBusSubscribe).
    if (state.kind === "ready") {
      const norm = detail.block.trim().toLowerCase();
      const target =
        state.schema.blocks.find((b) => b.label.toLowerCase() === norm) ??
        state.schema.blocks.find((b) => b.label.toLowerCase().includes(norm));
      if (target) {
        if (detail.op === "recolor") {
          recorder.recordRecolor(target, detail.category);
        } else {
          recorder.recordRemove(target);
        }
      }
    }
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
    if (!detail) return;
    // Card-driven NEW blocks settle locally (no regen), so the regen delta
    // never sees them. Record the "added" here, when the user commits the
    // suggestion, keyed by the pending placeholder that is about to become
    // the real block. (Edited blocks still come from editSummary; card arrows
    // are a separate follow-up.)
    if (detail.target.kind === "new-block") {
      // Match on the id prefix only, never the placeholder's label text
      // (a stale label literal here silently lost the block association).
      const placeholder =
        state.kind === "ready"
          ? state.schema.blocks.find(
              (b) => b.pending && b.id.startsWith("__pending_new_"),
            )
          : undefined;
      recorder.recordNewBlockAdd(placeholder, detail.option.title);
      return;
    }
    // A user-drawn arrow the user then committed. Recorded here, at the
    // commit, for the same reason "added" is: it is the one moment we know
    // both endpoints, and it does not depend on the settle delta. ONLY a
    // block_level choice keeps the arrow at settle; detail / none run the
    // edit but the line itself is dropped (with a toast note saying so),
    // and recording those would leave a "linked" row in the history for a
    // connection the canvas never kept.
    if (detail.target.kind === "arrow") {
      if (detail.option.kind !== "block_level") return;
      const { from, to } = detail.target;
      // Merged view: chips for arrows touching promoted blocks resolve
      // to labels instead of raw ids.
      recorder.recordLink(allBlocks, from, to);
      return;
    }
    if (detail.target.kind !== "block") return;
    const id = detail.target.id;
    setCardEditBlockIds((prev) =>
      prev.has(id) ? prev : new Set(prev).add(id),
    );
    // Record the edit in the tracker NOW, from the block the user explicitly
    // targeted (block "..." action or a bubble edit). Reliable + immediate,
    // like "added": it no longer waits for the settle effect or depends on
    // the edited file mapping back to this block's provenance, which is what
    // kept dropping card edits (e.g. a scraper edit whose file the block's
    // provenance didn't list). Typed-chat edits still come from the delta.
    // Merged view: a card edit on a PROMOTED block records too (the
    // base-only lookup silently skipped it).
    const block = allBlocks.find((b) => b.id === id);
    if (block) recorder.recordEdit(block);
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

  const {
    expandedBlockId,
    bubbleNodes,
    borrowOffsets,
    toggleBlock: toggleBubbleBlock,
    clear: clearBubbles,
  } = useBubbleFocus({
    projectKey,
    blocks: allBlocks,
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
    const tracedIds =
      tracedStep && tracedStep.blockIds.length > 0
        ? new Set(tracedStep.blockIds)
        : null;
    // Gold ring drawn around the block(s) of the tracker step being traced
    // back. Deliberately a different colour from the blue "just edited" glow
    // so "I'm inspecting history" reads apart from "this just changed".
    // The first shadow is a canvas-coloured gap slot: it separates the gold
    // from the block's own category border, so the two never fuse into one
    // muddy khaki band on tinted blocks.
    const TRACE_RING =
      "0 0 0 2px #FAFAF9, 0 0 0 5px #B0975A, 0 0 0 9px rgba(176,151,90,0.22)";
    // Scheme resolution with the neighbor-inheritance fallback (see
    // resolveBlockColorWithFallback in color/scheme.ts, shared with the
    // connection lens so every surface agrees on a fresh block's color).
    const blockById = new Map(allBlocks.map((b) => [b.id, b]));
    const neighborInput = (id: string) => {
      const b = blockById.get(id);
      return b
        ? {
            id: b.id,
            label: b.label,
            category: b.category,
            fileCount: b.provenance?.files.length ?? 0,
          }
        : undefined;
    };
    const resolveScheme = (n: Node<BlockNodeData>) =>
      resolveBlockColorWithFallback(
        activeScheme,
        {
          id: n.id,
          label: n.data.label,
          category: n.data.category,
          fileCount: n.data.files?.length ?? 0,
        },
        allArrows,
        neighborInput,
      );
    const base = nodes.map((n) => {
      const moved = borrowOffsets.get(n.id);
      const dimByFan = expandedBlockId !== null && n.id !== expandedBlockId;
      const dimByLens =
        lens !== null && n.id !== lens.from && n.id !== lens.to;
      const dim = dimByFan || dimByLens;
      const traced = tracedIds?.has(n.id) ?? false;
      // Resolve this block's fill + accent through the active color
      // scheme (with the neighbor-inheritance fallback above). Done here
      // (not at layout time) so switching schemes recolors without
      // re-running layout, preserving spatial memory.
      const resolved = resolveScheme(n);
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
      if (!moved && !dim && !traced) return { ...n, data };
      // Trace ring wins over dim so a traced block is always legible.
      const style = traced
        ? {
            ...n.style,
            boxShadow: TRACE_RING,
            borderRadius: 12,
            transition: "box-shadow 200ms ease",
          }
        : dim
          ? {
              ...n.style,
              opacity: 0.16,
              transition: "opacity 200ms ease",
              // Non-interactive while dimmed so a click on the area AROUND
              // an open fan / lens falls through to the pane and collapses
              // it, instead of being swallowed by a faded block.
              pointerEvents: "none" as const,
            }
          : n.style;
      return { ...n, data, position: moved ?? n.position, style };
    });
    return bubbleNodes.length === 0
      ? base
      : [...base, ...(bubbleNodes as unknown as Node<BlockNodeData>[])];
  }, [
    nodes,
    bubbleNodes,
    borrowOffsets,
    expandedBlockId,
    lens,
    activeScheme,
    state,
    promoted,
    allBlocks,
    tracedStep,
  ]);

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
    setTracedStep(null);
    setTrackerOpen(false);
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
    viewSchema,
    dismissRecentEdit,
    setSelectedId,
    // Arrows Claude added during a turn, already resolved to block ids.
    // Deduped by direction so a re-report can never double-count. Blocks are
    // read from the CURRENT render's schema (adding arrows does not change
    // them), so this stays a plain read with no state-updater side effects.
    onArrowsLinked: useCallback(
      (links: Array<{ from: string; to: string; label: string }>) => {
        for (const l of links) recorder.recordLink(allBlocks, l.from, l.to);
      },
      [allBlocks, recorder],
    ),
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

  // A pane click is inspection only: deselect, collapse bubbles, end a trace.
  // Double-clicking empty canvas used to add a new block; that shortcut was
  // removed because it fired by accident. Add block via the labelled button.
  const onPaneClick = useCallback(() => {
    setSelectedId(null);
    clearBubbles();
    clearTrace();
  }, [clearBubbles, clearTrace]);

  // Diff-on-ready glow handled by useRecentChanges above.
  // Settle effect (arrow outcomes, regen, edit-summary) handled below.
  useChatSettleEffect({
    chatRunning,
    chatMessages,
    state,
    setState,
    viewBlocks: allBlocks,
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

  // Camera pan to the block(s) of the tracker step the user is tracing back.
  useTraceFit(tracedStep);

  // Auto-fit during streaming + final fit + ResizeObserver-driven refit.
  const canvasContainerRef = useCanvasFit({
    state,
    view,
    focused,
    nodes,
    // While a connection lens is opening or open, canvas-wide auto-fits
    // must not fire: they stomp the lens's own framing and the note then
    // places itself in a wrongly-zoomed view.
    suspend: connection.active,
  });

  // The panel is open for the WHOLE of focus mode, not just once there's
  // content. Switching into adaptive focus animates it in immediately; with
  // nothing prompted yet it shows a welcome invite, then the loading state
  // once a round starts, then the detail mini-graph. This keeps the focus-mode
  // toggle anchored to the panel's corner instead of leaving a bare canvas
  // with a floating banner.
  const panelOpen = view === "focus";

  return (
    <div className="relative flex h-full w-full bg-[#FAFAF9]">
      <div
        ref={canvasContainerRef}
        className={`relative h-full ${panelOpen ? "flex-1 min-w-0" : "w-full"}`}
      >
        {/* The regen "fog" dims the diagram CONTENT while it's being REBUILT
         *  (an edit-driven regen). It is deliberately NOT tied to `regenerating`
         *  (the adaptive-focus round): a focus round only grows the SIDE PANEL,
         *  the main canvas is stable, so fogging it there needlessly dims
         *  everything (including a block the user just promoted). The side
         *  panel's own loading state signals the focus round instead. Overlay
         *  controls sit outside this layer and stay crisp. */}
        <div
          className={`absolute inset-0 transition-opacity duration-300 ${
            editRegenIds.size > 0 ? "opacity-60" : "opacity-100"
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
            <Background color="#E4E3E0" gap={16} />
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
        {/* Tracker tray: a dropdown anchored (fixed) beneath the Tracker
         *  header button via trackerBtnRef, so it reads as belonging to that
         *  button rather than a stray floating panel. Clicking a row
         *  trace-highlights that step's block(s) via tracedStep. */}
        {state.kind === "ready" && trackerOpen && (
          <TrackerTray
            entries={tracker.entries}
            selectedId={tracker.selectedId}
            anchorRef={trackerBtnRef}
            onSelect={(e) => {
              // Re-clicking the selected row toggles the trace OFF (clears the
              // ring + zooms back out via useTraceFit); a different row moves
              // the trace to that block.
              if (tracker.selectedId === e.id) {
                trackerSelect(null);
                setTracedStep(null);
              } else {
                trackerSelect(e.id);
                setTracedStep({ blockIds: e.blockIds, bubble: e.bubble });
              }
            }}
            onClose={() => {
              // Closing the tray ends the trace-back too, so no orphan ring
              // lingers on the canvas with no tray to explain it.
              setTrackerOpen(false);
              clearTrace();
            }}
          />
        )}
        {/* Adaptive-focus welcome / loading / streaming count all live INSIDE
         *  the side panel (DiagramFocusPanel), which is open for the whole of
         *  focus mode, so nothing floats over the canvas during a focus round. */}
        {visualEdit.pendingOptions && state.kind === "ready" && (
          <ConnectionOptionsOverlay
            target={visualEdit.pendingOptions.target}
            options={visualEdit.pendingOptions.options}
            blocks={allBlocks}
            onPick={visualEdit.handlePickOption}
            onCancel={visualEdit.handleCancelOptions}
          />
        )}
        {visualEdit.intentGate && state.kind === "ready" && (
          <IntentGate
            key={
              visualEdit.intentGate.target.kind === "arrow"
                ? `arrow:${visualEdit.intentGate.target.from}:${visualEdit.intentGate.target.to}`
                : visualEdit.intentGate.target.kind === "block"
                  ? `block:${visualEdit.intentGate.target.id}`
                  : "module"
            }
            target={visualEdit.intentGate.target}
            blocks={allBlocks}
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
        {/* Interaction-tracker button in the header-right slot; the tray it
         *  opens floats over the canvas' top-right corner (rendered below). */}
        {state.kind === "ready" &&
          headerRightSlot &&
          createPortal(
            <TrackerButton
              ref={trackerBtnRef}
              count={tracker.entries.length}
              open={trackerOpen}
              onToggle={() => {
                // Toggling the tray shut also ends the trace-back.
                if (trackerOpen) clearTrace();
                setTrackerOpen((o) => !o);
              }}
            />,
            headerRightSlot,
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
                  title="Add a new block"
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
            settled={bubbleEdit.settled}
            onCloseDetail={bubbleEdit.closeDetail}
            onConfirmDetail={(blockId, instruction, summary) => {
              visualEdit.dispatchExecuteDirect(
                { kind: "block", id: blockId },
                instruction,
                summary,
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
            // block on the canvas. Uses the SAME neighbor-inheritance
            // fallback as the canvas nodes, so a scheme-unknown block
            // (created or promoted after the scheme was generated) shows
            // one consistent inherited color in both places.
            const ln = connection.lens;
            const blocks = allBlocks;
            const schemeInput = (b: DiagramBlock) => ({
              id: b.id,
              label: b.label,
              category: b.category,
              fileCount: b.provenance?.files.length ?? 0,
            });
            const accentOf = (id: string): string | null => {
              const b = blocks.find((x) => x.id === id);
              if (!b) return null;
              return (
                resolveBlockColorWithFallback(
                  activeScheme,
                  schemeInput(b),
                  allArrows,
                  (nid) => {
                    const nb = blocks.find((x) => x.id === nid);
                    return nb ? schemeInput(nb) : undefined;
                  },
                )?.accent ?? null
              );
            };
            return (
              <ConnectionLensOverlay
                key={`${ln.from}-${ln.to}-${ln.verb}`}
                detail={ln}
                blocks={blocks}
                files={files}
                onClose={connection.close}
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
                promotedDetail: true,
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
            // The blue "just changed" mark always shows the LATEST action.
            // A promote IS the user's newest diagram change, so it takes the
            // mark over; leaving the previous action's blocks glowing while
            // the newly promoted block arrives unmarked read as the
            // highlight being stuck on stale targets.
            const promotedParentId =
              b.parent && state.schema.blocks.some((x) => x.id === b.parent)
                ? b.parent
                : null;
            setRecentChanges({
              blockIds: new Set([b.id]),
              arrowKeys: promotedParentId
                ? new Set([`${promotedParentId}->${b.id}`])
                : new Set(),
            });
            // Track the promote (in diagram terms) so it can be traced back.
            const cat =
              b.category ??
              (b.parent
                ? state.schema.blocks.find((x) => x.id === b.parent)?.category
                : undefined);
            recorder.recordPromote(b, cat);
          }}
          onUnpromote={(b) => {
            setPromoted((prev) => ({
              blocks: prev.blocks.filter((x) => x.id !== b.id),
              arrows: prev.arrows.filter(
                (a) => a.from !== b.id && a.to !== b.id,
              ),
            }));
            // The removed block cannot glow (it is gone), and the previous
            // action's glow is stale by now, so the mark simply clears.
            dismissRecentEdit();
            // Taking a promoted detail back off the canvas is a removal from
            // the diagram, so record it. Otherwise the tracker keeps showing a
            // stale "promoted" row for a block that is no longer there.
            recorder.recordRemove(b);
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
