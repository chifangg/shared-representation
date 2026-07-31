/**
 * Pure dagre layout pass for the diagram canvas.
 *
 * Given a DiagramSchema (blocks + arrows) and an optional selected /
 * focused set, returns React Flow nodes + edges with positions, focus
 * dimming applied, and label-clusters merged. No React, no hooks, no
 * side effects — easy to test and snapshot.
 *
 * The dagre instance is created fresh per call; the schema is small
 * enough (typically <50 blocks) that the layout cost is negligible
 * compared to the render cost of @xyflow/react.
 */

import dagre from "@dagrejs/dagre";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type {
  BlockNodeData,
  DiagramArrow,
  DiagramBlock,
  DiagramSchema,
} from "../types";
import { NODE_H, NODE_W, PROX } from "./constants";
import { assignEdgeHandles } from "./edgeHandles";

/**
 * Approximate the expanded height of a selected block so dagre can
 * reserve enough vertical room for the unclamped caption without
 * shifting neighbors mid-animation.
 *
 * Selected blocks now show the full caption (no line-clamp) but no
 * longer pop out full file / function lists — they were too small to
 * read and crowded the node. Height just accommodates the unclamped
 * caption.
 */
export function estimateExpandedHeight(b: DiagramBlock): number {
  const captionLines = Math.max(1, Math.ceil((b.caption?.length ?? 0) / 32));
  const captionExtra = Math.max(0, captionLines - 2) * 14;
  return NODE_H + captionExtra;
}

/**
 * Approximate the expanded height of a selected detail block in the
 * mini graph so dagre can carve out enough vertical room and avoid
 * overlapping neighbors when the user clicks to inspect.
 *
 * The mini-graph layout is denser than the main canvas (smaller nodes,
 * tighter ranks) so the constants differ from estimateExpandedHeight.
 */
export function estimateMiniExpandedHeight(b: DiagramBlock): number {
  let h = 44;
  const captionLines = Math.max(1, Math.ceil((b.caption?.length ?? 0) / 28));
  h += captionLines * 12;
  // Expanded card lists FEATURES (capabilities, else functions), one per
  // line, plus a small header. Files are no longer surfaced.
  const caps = b.capabilities ?? [];
  const featureCount =
    caps.length > 0 ? caps.length : b.provenance?.functions?.length ?? 0;
  if (featureCount > 0) h += 18 + featureCount * 14;
  return Math.max(h + 12, 56);
}

/** Gaps used when corralling edge-less "island" blocks into a tidy
 *  band. Kept close to dagre's nodesep/ranksep so the band reads as the
 *  same grid density rather than a visibly different one. */
const ISLAND_GAP_X = 40;
const ISLAND_GAP_Y = 40;
/** Gap between the bottom of the connected spine and the island band. */
const ISLAND_BAND_GAP = 90;
/** Left indent of the island band, in flow units. The pane's bottom-left
 *  corner carries floating chrome (the Add block button and the category
 *  legend), and a fresh edge-less block used to spawn exactly underneath
 *  it. Indenting the band keeps that corner clear at typical zoom. */
const ISLAND_CHROME_INDENT = 320;

export function layoutSchema(
  schema: DiagramSchema,
  selectedId: string | null = null,
  focusedIds?: string[] | null,
): {
  nodes: Node<BlockNodeData>[];
  edges: Edge[];
} {
  const focusedSet = new Set(focusedIds ?? []);
  const hasFocus = focusedSet.size > 0;
  const allBlockIds = new Set(schema.blocks.map((b) => b.id));
  const containerIds = new Set<string>();
  for (const b of schema.blocks) {
    if (b.parent && allBlockIds.has(b.parent)) containerIds.add(b.parent);
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "TB",
    // Bumped from 50 / 70 → 80 / 110 so edge labels sitting at the
    // path midpoint have visible whitespace around them instead of
    // crashing into adjacent blocks. Combined with zIndex:20 on the
    // label div (in LabeledEdge), this keeps "imports / fetches"
    // pills readable even when blocks are dense.
    nodesep: 80,
    ranksep: 110,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const blockHeight = (b: DiagramBlock) =>
    b.id === selectedId ? estimateExpandedHeight(b) : NODE_H;

  // Collect the edges dagre ranks on (parent links + settled arrows +
  // Claude's in-flight arrows). Only "intent" arrows are skipped: while
  // the user is still pulling an arrow (popover open), re-ranking would
  // jar the popover off its midpoint. Once it hands off to Claude
  // ("claude"), the arrow DOES rank: it is often a brand-new block's only
  // tie to the graph, and ranking on it slots the block into the spine
  // during the visibly-in-progress phase instead of leaving it in the
  // island band all turn and teleporting it up when the turn settles.
  // The settle pass only clears the pending tag, so the ranking edges
  // (and therefore positions) do not change again at settle time.
  const dagreEdges: Array<[string, string]> = [];
  for (const b of schema.blocks) {
    if (b.parent && allBlockIds.has(b.parent)) dagreEdges.push([b.parent, b.id]);
  }
  for (const a of schema.arrows) {
    if (a.pending === "intent") continue;
    if (allBlockIds.has(a.from) && allBlockIds.has(a.to)) {
      dagreEdges.push([a.from, a.to]);
    }
  }

  // A block is "connected" if it touches any of those edges. Edge-less
  // "island" blocks are pulled OUT of the dagre pass: dagre would drop
  // them at arbitrary ranks, so the canvas read as a flow plus random
  // floating cards. We corral them into a tidy band under the spine
  // instead (in emission order), so the reading axis stays intact.
  const connected = new Set<string>();
  for (const [from, to] of dagreEdges) {
    connected.add(from);
    connected.add(to);
  }

  // --- Flow ranking -----------------------------------------------------
  // Edges feed dagre in their REAL direction, so ranks follow the flow:
  // blocks nothing points at (entry scripts, top-level UI shells) take
  // the top rank and everything else descends the way the arrows point.
  // The layout itself is the reading order: start at the top, follow the
  // arrows down. An earlier version re-rooted the ranking on the block
  // with the most connections; that answered "which block matters most",
  // not "where do I start reading", and a well-connected newcomer could
  // steal the root and reshuffle the whole diagram. dagre breaks the
  // occasional cycle by reversing an edge internally, so a rare arrow can
  // still point upward; rendered arrows always keep their true direction.
  for (const b of schema.blocks) {
    if (!connected.has(b.id)) continue;
    g.setNode(b.id, { width: NODE_W, height: blockHeight(b) });
  }
  for (const [from, to] of dagreEdges) g.setEdge(from, to);

  dagre.layout(g);

  // Top-left position per block: connected ones come from dagre; the
  // island band is computed below.
  const posMap = new Map<string, { x: number; y: number }>();
  let spineMinX = Infinity;
  let spineMaxX = -Infinity;
  let spineMaxY = -Infinity;
  for (const b of schema.blocks) {
    if (!connected.has(b.id)) continue;
    const node = g.node(b.id);
    const h = blockHeight(b);
    const x = node.x - NODE_W / 2;
    const y = node.y - h / 2;
    posMap.set(b.id, { x, y });
    spineMinX = Math.min(spineMinX, x);
    spineMaxX = Math.max(spineMaxX, x + NODE_W);
    spineMaxY = Math.max(spineMaxY, y + h);
  }

  // Pack the islands left-to-right in emission order, wrapping to fit
  // under the spine's horizontal extent (or a default 4-wide grid when
  // there's no spine at all, i.e. nothing is connected).
  const islands = schema.blocks.filter((b) => !connected.has(b.id));
  if (islands.length > 0) {
    const colStride = NODE_W + ISLAND_GAP_X;
    const hasSpine = Number.isFinite(spineMinX);
    // Indent past the bottom-left chrome, but never so far that not even
    // one column fits inside the spine's width.
    const indent = hasSpine
      ? Math.min(
          ISLAND_CHROME_INDENT,
          Math.max(0, spineMaxX - spineMinX - NODE_W),
        )
      : ISLAND_CHROME_INDENT;
    const startX = (hasSpine ? spineMinX : 20) + indent;
    const startY = hasSpine ? spineMaxY + ISLAND_BAND_GAP : 20;
    const bandWidth = hasSpine ? spineMaxX - startX : colStride * 4 - ISLAND_GAP_X;
    const maxCols = Math.max(1, Math.floor((bandWidth + ISLAND_GAP_X) / colStride));

    let col = 0;
    let rowY = startY;
    let rowMaxH = 0;
    for (const b of islands) {
      if (col >= maxCols) {
        col = 0;
        rowY += rowMaxH + ISLAND_GAP_Y;
        rowMaxH = 0;
      }
      posMap.set(b.id, { x: startX + col * colStride, y: rowY });
      rowMaxH = Math.max(rowMaxH, blockHeight(b));
      col++;
    }
  }

  const nodes: Node<BlockNodeData>[] = schema.blocks.map((b) => {
    const pos = posMap.get(b.id) ?? { x: 0, y: 0 };
    return {
      id: b.id,
      type: "block",
      position: pos,
      selected: b.id === selectedId,
      data: {
        label: b.label,
        caption: b.caption,
        files: b.provenance?.files ?? [],
        functions: b.provenance?.functions ?? [],
        capabilities: b.capabilities ?? [],
        category: b.category,
        isContainer: containerIds.has(b.id),
        isFocused: focusedSet.has(b.id),
        isDimmed: hasFocus && !focusedSet.has(b.id),
        isPending: b.pending === true,
        promotedDetail: b.promotedDetail === true,
        isRecentlyAdded: false, // injected by attachInteractive
      },
    };
  });

  const edges: Edge[] = [];

  // Note: parent → child structural edges used to be drawn here as
  // faint grey lines. Claude was emitting `parent` for blocks that
  // visually looked like clutter (e.g. linking unrelated services
  // through a meaningless containment), so we stopped rendering
  // them. The `parent` relationships still feed dagre above for
  // layout ranking — we just no longer paint the line on screen.

  // Cluster arrows whose approximate midpoints land near each other
  // (e.g. multiple arrows fanning into the same target node), then
  // merge their labels into a single combined label so we don't render
  // overlapping pills like "POSTs" stacked under "spawns". Secondary
  // arrows in a cluster keep their line but render with no label.
  const nodePos = new Map(nodes.map((n) => [n.id, n.position]));
  type ArrowInfo = {
    arrow: DiagramArrow;
    midX: number;
    midY: number;
  };
  const arrowInfos: ArrowInfo[] = [];
  for (const a of schema.arrows) {
    if (!allBlockIds.has(a.from) || !allBlockIds.has(a.to)) continue;
    const from = nodePos.get(a.from);
    const to = nodePos.get(a.to);
    if (!from || !to) continue;
    arrowInfos.push({
      arrow: a,
      midX: (from.x + to.x) / 2 + NODE_W / 2,
      midY: (from.y + to.y) / 2 + NODE_H / 2,
    });
  }
  const clusters: ArrowInfo[][] = [];
  for (const info of arrowInfos) {
    const found = clusters.find(
      (c) =>
        Math.abs(c[0].midX - info.midX) < PROX &&
        Math.abs(c[0].midY - info.midY) < PROX,
    );
    if (found) found.push(info);
    else clusters.push([info]);
  }
  const labelOverride = new Map<DiagramArrow, string>();
  for (const cluster of clusters) {
    if (cluster.length <= 1) continue;
    const merged = cluster
      .map((c) => c.arrow.label)
      .filter((l) => l && l.trim() !== "")
      .join(" / ");
    labelOverride.set(cluster[0].arrow, merged);
    for (let i = 1; i < cluster.length; i++) {
      labelOverride.set(cluster[i].arrow, "");
    }
  }

  // Distribute handles per block so DIFFERENT arrows touching the same
  // block land on DIFFERENT sides (not stacked on one anchor). Done as a
  // global pass over all renderable arrows, in array order, so a freshly
  // appended pending arrow avoids sides already used by existing arrows.
  const renderArrows = schema.arrows.filter(
    (a) => allBlockIds.has(a.from) && allBlockIds.has(a.to),
  );
  const handlePairs = assignEdgeHandles(renderArrows, (id) => {
    const p = posMap.get(id);
    return p ? { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 } : undefined;
  });

  renderArrows.forEach((a, i) => {
    const finalLabel = labelOverride.has(a)
      ? labelOverride.get(a)!
      : a.label;
    const dim = hasFocus && !(focusedSet.has(a.from) || focusedSet.has(a.to));
    const isPending = a.pending !== undefined;
    const { sourceHandle, targetHandle } = handlePairs[i];
    edges.push({
      id: `sem-${a.from}-${a.to}-${a.label}`,
      source: a.from,
      target: a.to,
      sourceHandle,
      targetHandle,
      type: "labeled",
      label: finalLabel || undefined,
      // Marching-ants while pending (any stage); settled arrows skip
      // the class so they render as a normal solid line.
      className: isPending ? "pending-edge" : undefined,
      // Arrowhead at the target end so the relationship's DIRECTION is
      // visible. Ranks follow the arrows, but a cycle broken by dagre can
      // still leave a source below its target, so without a head such a
      // line reads ambiguous (or backwards). The head lands at whichever
      // handle the edge enters.
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        // Pending edges are blue (the in-flight "edit" color, matching the
        // block pulse); settled edges are neutral grey.
        color: isPending ? "#3B5BD9" : "#666666",
      },
      style: isPending
        ? {
            stroke: "#3B5BD9",
            strokeWidth: 2,
            strokeDasharray: "8 6",
            opacity: 1,
          }
        : {
            stroke: "#666666",
            strokeWidth: 1.5,
            opacity: dim ? 0.2 : 1,
          },
    });
  });

  return { nodes, edges };
}
