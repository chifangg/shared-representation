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

  // Collect the edges dagre ranks on (parent links + settled arrows).
  // Pending arrows are skipped — adding an in-flight edge can shuffle
  // nodes the moment the user pulls a new arrow, jarring the popover
  // off its midpoint. They still render (see edges loop below).
  const dagreEdges: Array<[string, string]> = [];
  for (const b of schema.blocks) {
    if (b.parent && allBlockIds.has(b.parent)) dagreEdges.push([b.parent, b.id]);
  }
  for (const a of schema.arrows) {
    if (a.pending !== undefined) continue;
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

  // --- Importance-based re-rooting -------------------------------------
  // dagre ranks purely by edge direction, so a convergence point (many
  // arrows pointing IN) lands at the BOTTOM even when it is the block the
  // user should read first. Instead we pick a `primary` block by
  // connectivity and lay the graph out top-down FROM it: the primary sits
  // at the top rank and everything else descends by graph distance.
  //
  // Only the edges dagre RANKS on are re-oriented here. The rendered
  // arrows further down keep their original direction, so the semantics
  // are intact (an arrow into the primary still points at it, i.e. up).
  const undirected = new Map<string, string[]>();
  const degree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const [u, v] of dagreEdges) {
    if (!undirected.has(u)) undirected.set(u, []);
    if (!undirected.has(v)) undirected.set(v, []);
    undirected.get(u)!.push(v);
    undirected.get(v)!.push(u);
    degree.set(u, (degree.get(u) ?? 0) + 1);
    degree.set(v, (degree.get(v) ?? 0) + 1);
    inDegree.set(v, (inDegree.get(v) ?? 0) + 1);
  }
  // Primary = most-connected block; ties broken by in-degree (a hub that
  // everything feeds), then emission order: the loop runs in emission
  // order and only replaces on a strict gain, so the earliest wins ties.
  let primary: string | null = null;
  for (const b of schema.blocks) {
    if (!connected.has(b.id)) continue;
    if (primary === null) {
      primary = b.id;
      continue;
    }
    const d = degree.get(b.id) ?? 0;
    const pd = degree.get(primary) ?? 0;
    if (
      d > pd ||
      (d === pd &&
        (inDegree.get(b.id) ?? 0) > (inDegree.get(primary) ?? 0))
    ) {
      primary = b.id;
    }
  }
  // BFS distance from the primary (then from any other component's first
  // unvisited block) gives every connected block a layer.
  const depth = new Map<string, number>();
  const bfsFrom = (root: string) => {
    depth.set(root, 0);
    const queue = [root];
    while (queue.length > 0) {
      const u = queue.shift()!;
      for (const w of undirected.get(u) ?? []) {
        if (!depth.has(w)) {
          depth.set(w, (depth.get(u) ?? 0) + 1);
          queue.push(w);
        }
      }
    }
  };
  if (primary) bfsFrom(primary);
  for (const b of schema.blocks) {
    if (connected.has(b.id) && !depth.has(b.id)) bfsFrom(b.id);
  }

  for (const b of schema.blocks) {
    if (!connected.has(b.id)) continue;
    g.setNode(b.id, { width: NODE_W, height: blockHeight(b) });
  }
  // Feed dagre edges oriented shallow->deep so the primary (depth 0) ranks
  // at the top. Same-depth edges are skipped from ranking (they would
  // shove siblings onto adjacent ranks); they still render as arrows.
  for (const [from, to] of dagreEdges) {
    const df = depth.get(from);
    const dt = depth.get(to);
    if (df === undefined || dt === undefined) g.setEdge(from, to);
    else if (df < dt) g.setEdge(from, to);
    else if (dt < df) g.setEdge(to, from);
  }

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
    const startX = hasSpine ? spineMinX : 20;
    const startY = hasSpine ? spineMaxY + ISLAND_BAND_GAP : 20;
    const bandWidth = hasSpine ? spineMaxX - spineMinX : colStride * 4 - ISLAND_GAP_X;
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
      // visible. With the importance-based top-down layout the source can
      // sit below the target, so without a head the line reads ambiguous
      // (or backwards). The head lands at whichever handle the edge enters.
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
