import { useCallback, useEffect, useRef, useState } from "react";
import dagre from "@dagrejs/dagre";
import {
  Background,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
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

  // Build mini-layout: ghost focused base blocks at top, detail
  // blocks below, dagre TB. Arrow set spans both layers so the
  // viewer can see where each detail attaches.
  const { nodes, edges } = (() => {
    const ghostNodes = focused.ids
      .map((id) => baseBlocks.find((b) => b.id === id))
      .filter((b): b is DiagramBlock => Boolean(b));

    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: "TB",
      nodesep: 26,
      ranksep: 44,
      marginx: 16,
      marginy: 16,
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const b of ghostNodes) g.setNode(b.id, { width: 150, height: 44 });
    for (const b of focused.blocks) {
      const isSel = b.id === selectedMiniId;
      g.setNode(b.id, {
        width: isSel ? 220 : 160,
        height: isSel ? estimateMiniExpandedHeight(b) : 56,
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
        const h = isSel ? estimateMiniExpandedHeight(b) : 56;
        return {
          id: b.id,
          type: "mini",
          position: { x: pos.x - w / 2, y: pos.y - h / 2 },
          data: {
            label: b.label,
            caption: b.caption,
            functions: b.provenance?.functions ?? [],
            capabilities: b.capabilities ?? [],
            isGhost: false,
            isPromoted: promotedIds.has(b.id),
            isSelected: isSel,
            block: b,
            onPromote,
            onUnpromote,
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
  })();

  // Fit on every layout change (new detail blocks streaming in,
  // panel resize, promotion removing nodes, click-to-expand).
  useEffect(() => {
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
    let timer: number | undefined;
    let isFirst = true;
    const ro = new ResizeObserver(() => {
      if (isFirst) {
        isFirst = false;
        return;
      }
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        fitView({ padding: 0.18, duration: 220, maxZoom: 1.3 });
      }, 80);
    });
    ro.observe(el);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
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
