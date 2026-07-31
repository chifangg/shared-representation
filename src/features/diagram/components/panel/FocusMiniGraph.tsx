import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dagre from "@dagrejs/dagre";
import {
  Background,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import type {
  DiagramArrow,
  DiagramBlock,
  MiniNodeData,
} from "../../types";
import { estimateMiniExpandedHeight } from "../../layout/layoutSchema";
import { categoryStyle } from "../../util/blockCategory";
import { miniNodeTypes } from "./MiniBlockNode";
import { miniEdgeTypes } from "./MiniLabeledEdge";

/**
 * The nested ReactFlow inside the focus side-panel.
 *
 * Layout: ghost re-stamps of focused base blocks at the top, focus-
 * fetched detail blocks below, dagre TB. The arrow set spans both
 * layers so the viewer can see how each detail attaches to the base
 * blocks.
 *
 * Click a detail block to expand it (full file + function lists).
 * Click + on a detail block to promote it onto the main canvas; click
 * the now-blue check to unpromote.
 *
 * Auto-fits on every layout change (new blocks streaming in, panel
 * resize, click-to-expand) so the user always sees the full graph
 * regardless of panel width.
 */
export function FocusMiniGraph({
  focused,
  baseBlocks,
  promotedIds,
  onPromote,
  onUnpromote,
}: {
  focused: {
    ids: string[];
    blocks: DiagramBlock[];
    arrows: DiagramArrow[];
  };
  baseBlocks: DiagramBlock[];
  promotedIds: Set<string>;
  onPromote: (b: DiagramBlock) => void;
  onUnpromote: (b: DiagramBlock) => void;
}) {
  const { fitView } = useReactFlow();
  const [selectedMiniId, setSelectedMiniId] = useState<string | null>(null);
  const onMiniNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      // Ghost nodes (focused base re-stamped at the top) aren't
      // expandable here — they belong to the main canvas.
      if (node.id.startsWith("ghost-")) return;
      setSelectedMiniId((prev) => (prev === node.id ? null : node.id));
    },
    [],
  );
  const onMiniPaneClick = useCallback(() => {
    setSelectedMiniId(null);
  }, []);

  // Detail blocks the user has dragged, keyed by block id. dagre computes a
  // fresh layout every render, so without this a drag would snap straight
  // back on the next render. The override wins over dagre's slot (like the
  // main canvas' userPositionsRef). Reset per new focus round so a new
  // question re-lays out cleanly. `pinnedRef` records that the user has taken
  // manual control, which suppresses the auto-fit so it stops fighting drags.
  const [userPos, setUserPos] = useState<
    Map<string, { x: number; y: number }>
  >(new Map());
  const pinnedRef = useRef(false);
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<MiniNodeData>>[]) => {
      const updates: Array<{ id: string; position: { x: number; y: number } }> =
        [];
      for (const c of changes) {
        if (c.type === "position" && c.position && !c.id.startsWith("ghost-")) {
          updates.push({ id: c.id, position: c.position });
        }
      }
      if (updates.length === 0) return;
      pinnedRef.current = true;
      setUserPos((prev) => {
        const next = new Map(prev);
        for (const u of updates) next.set(u.id, u.position);
        return next;
      });
    },
    [],
  );
  const focusKey = focused.ids.join("|");
  useEffect(() => {
    setUserPos(new Map());
    pinnedRef.current = false;
  }, [focusKey]);

  // The promote callbacks come from the canvas and get a new identity on every
  // canvas render (including every frame of a panel-width drag). Route them
  // through refs so the layout memo below is not invalidated by them.
  const onPromoteRef = useRef(onPromote);
  onPromoteRef.current = onPromote;
  const onUnpromoteRef = useRef(onUnpromote);
  onUnpromoteRef.current = onUnpromote;
  const promote = useCallback((b: DiagramBlock) => onPromoteRef.current(b), []);
  const unpromote = useCallback(
    (b: DiagramBlock) => onUnpromoteRef.current(b),
    [],
  );
  // Set identity is not stable either; compare by content.
  const promotedKey = useMemo(
    () => [...promotedIds].sort().join("|"),
    [promotedIds],
  );

  // Build mini-layout: ghost focused base blocks at top, detail
  // blocks below, dagre TB. Arrow set spans both layers so the
  // viewer can see where each detail attaches.
  //
  // MEMOIZED: this runs a full dagre.layout() and hands the nested ReactFlow
  // brand-new node/edge identities. As a bare IIFE it re-ran on EVERY render,
  // so dragging the panel edge (a setState per pointer frame) relaid out the
  // whole graph once per frame.
  const { nodes, edges } = useMemo(() => {
    // Ghosts: the model's focused ids PLUS any canvas block a detail
    // names as its parent. The model sometimes parents a detail under a
    // canvas block it forgot to list in the focus call; without this the
    // containment edge got dropped and the whole detail chain floated
    // disconnected beside the ON CANVAS chips.
    const ghostIds: string[] = [...focused.ids];
    for (const b of focused.blocks) {
      if (b.parent && !ghostIds.includes(b.parent)) ghostIds.push(b.parent);
    }
    const ghostNodes = ghostIds
      .map((id) => baseBlocks.find((b) => b.id === id))
      .filter((b): b is DiagramBlock => Boolean(b));

    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: "TB",
      // Roomier than before: a collapsed detail card actually renders ~78px
      // tall (title + 2-line caption + feature count), so the old 56 height
      // + tight ranksep let adjacent ranks overlap while streaming in.
      nodesep: 34,
      ranksep: 64,
      marginx: 16,
      marginy: 16,
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const b of ghostNodes) g.setNode(b.id, { width: 150, height: 44 });
    for (const b of focused.blocks) {
      const isSel = b.id === selectedMiniId;
      g.setNode(b.id, {
        width: isSel ? 220 : 160,
        height: isSel ? estimateMiniExpandedHeight(b) : 78,
      });
    }

    const allIds = new Set<string>([
      ...ghostNodes.map((b) => b.id),
      ...focused.blocks.map((b) => b.id),
    ]);
    for (const a of focused.arrows) {
      if (allIds.has(a.from) && allIds.has(a.to)) g.setEdge(a.from, a.to);
    }
    // If a detail block declares a parent that's a focused base, draw
    // an implicit containment edge so dagre lays it underneath.
    for (const b of focused.blocks) {
      if (b.parent && allIds.has(b.parent)) {
        g.setEdge(b.parent, b.id);
      }
    }
    dagre.layout(g);

    const nodes: Node<MiniNodeData>[] = [
      ...ghostNodes.map<Node<MiniNodeData>>((b) => {
        const pos = g.node(b.id);
        const style = categoryStyle(b.category);
        return {
          id: `ghost-${b.id}`,
          type: "mini",
          position: { x: pos.x - 75, y: pos.y - 22 },
          draggable: false,
          data: {
            label: b.label,
            caption: "",
            functions: [],
            isGhost: true,
            isPromoted: false,
            isSelected: false,
            block: null,
            onPromote: null,
            onUnpromote: null,
            // Re-stamp on-canvas blocks in their own category colour, not
            // a generic amber, so the ghost reads as "the same block".
            tint: style?.tint,
            accent: style?.accent,
          },
        };
      }),
      ...focused.blocks.map<Node<MiniNodeData>>((b) => {
        const pos = g.node(b.id);
        const isSel = b.id === selectedMiniId;
        const w = isSel ? 220 : 160;
        const h = isSel ? estimateMiniExpandedHeight(b) : 78;
        return {
          id: b.id,
          type: "mini",
          // A manual drag (userPos) wins over dagre's fresh slot.
          position:
            userPos.get(b.id) ?? { x: pos.x - w / 2, y: pos.y - h / 2 },
          data: {
            label: b.label,
            caption: b.caption,
            functions: b.provenance?.functions ?? [],
            capabilities: b.capabilities ?? [],
            isGhost: false,
            isPromoted: promotedIds.has(b.id),
            isSelected: isSel,
            block: b,
            onPromote: promote,
            onUnpromote: unpromote,
          },
        };
      }),
    ];

    const idMap = new Map<string, string>();
    for (const b of ghostNodes) idMap.set(b.id, `ghost-${b.id}`);
    for (const b of focused.blocks) idMap.set(b.id, b.id);

    const edges: Edge[] = focused.arrows
      .filter((a) => idMap.has(a.from) && idMap.has(a.to))
      .map((a, i) => ({
        id: `mini-arrow-${a.from}-${a.to}-${i}`,
        source: idMap.get(a.from)!,
        target: idMap.get(a.to)!,
        type: "miniLabeled",
        label: a.label || undefined,
        style: { stroke: "#A8A29E", strokeWidth: 1.25, strokeDasharray: "4,3" },
      }));
    // Containment edges (parent → detail) when no explicit arrow.
    const arrowKey = new Set(
      focused.arrows.map((a) => `${a.from}->${a.to}`),
    );
    for (const b of focused.blocks) {
      if (!b.parent || !idMap.has(b.parent)) continue;
      if (arrowKey.has(`${b.parent}->${b.id}`)) continue;
      edges.push({
        id: `mini-contain-${b.parent}-${b.id}`,
        source: idMap.get(b.parent)!,
        target: b.id,
        type: "smoothstep",
        style: {
          stroke: "#CCCCCC",
          strokeWidth: 1,
          strokeDasharray: "2,3",
        },
      });
    }
    return { nodes, edges };
    // promotedKey stands in for promotedIds (Set identity is unstable);
    // promote/unpromote are ref-backed and stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    focused,
    baseBlocks,
    selectedMiniId,
    userPos,
    promotedKey,
    promote,
    unpromote,
  ]);

  // Fit on every layout change (new detail blocks streaming in,
  // promotion removing nodes, click-to-expand) UNTIL the user drags a
  // block. After that they own the framing, so stop auto-fitting.
  const lastFitKeyRef = useRef("");
  useEffect(() => {
    if (pinnedRef.current) return;
    // Only animate when the layout ACTUALLY changed. Without this guard a
    // spurious re-run replays a 350ms camera move, which reads as the panel
    // drifting for half a second after an unrelated interaction.
    const key = `${nodes.length}:${edges.length}:${selectedMiniId ?? ""}`;
    if (key === lastFitKeyRef.current) return;
    lastFitKeyRef.current = key;
    const t = window.setTimeout(() => {
      fitView({ padding: 0.18, duration: 350, maxZoom: 1.3 });
    }, 80);
    return () => window.clearTimeout(t);
  }, [nodes.length, edges.length, selectedMiniId, fitView]);

  // Refit the mini-graph whenever its container size changes, so when
  // the user drags the panel handle the focused subflow stays
  // proportionally scaled and centered instead of clipping at one edge.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    let raf = 0;
    let isFirst = true;
    const ro = new ResizeObserver(() => {
      if (isFirst) {
        isFirst = false;
        return;
      }
      if (pinnedRef.current) return;
      // One instant fit per frame, not a debounced animated one: while the
      // panel handle is being dragged the mini-graph has to track the width
      // live, otherwise it only catches up ~300ms after the drag ends.
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        fitView({ padding: 0.18, duration: 0, maxZoom: 1.3 });
      });
    });
    ro.observe(el);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fitView]);

  return (
    <div ref={wrapperRef} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={miniNodeTypes}
        edgeTypes={miniEdgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onMiniNodeClick}
        onPaneClick={onMiniPaneClick}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.3 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.4}
        maxZoom={1.6}
        nodesDraggable
        nodesConnectable={false}
        nodesFocusable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll
      >
        <Background color="#EFEFEF" gap={14} />
      </ReactFlow>
    </div>
  );
}
