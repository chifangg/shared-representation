import type { Node } from "@xyflow/react";
import type {
  BubbleNodeData,
  BubbleSectorNodeData,
  DiagramBlock,
} from "../types";
import { NODE_H, NODE_W } from "./constants";
import {
  computeFanPositions,
  fanRadius,
  fanSpreadDeg,
  pickFanCenterAngle,
} from "./bubbleLayout";
import { humanizeFunctionName } from "../util/humanize";

/**
 * Pure construction of the React Flow node array for a bubble cluster:
 * one sector backdrop followed by N bubbles, all positioned around the
 * expanded block.
 *
 * Extracted from `useBubbleFocus` so the hook stays focused on state +
 * viewport orchestration; this file owns the geometry → node mapping.
 * No React imports, no React Flow hooks — just `Node` type usage.
 *
 * Geometry constants live here (not in the hook) because they're
 * tightly coupled to the layout decisions made in this file:
 * tweaking any one of them without the others would desync the
 * sector arc from where the bubbles actually land.
 */

/** Bubble is a fixed circle (see FunctionBubble). Larger than the old
 *  80px so a multi-word capability phrase fits without wrapping to one
 *  or two words per line. Keep in sync with the diameter the component
 *  renders. */
export const BUBBLE_HALF_SIZE = 56;

/** Radial distance from block center to bubble center for N >= 2. */
const RADIUS_MULTI = 250;

/** Tighter radius for the single-bubble case so the lone bubble doesn't
 *  drift visually disconnected from its parent block. */
const RADIUS_SINGLE = 168;

/** Sector inner radius starts just past the block half-extents so the
 *  cream fill doesn't overlap the block card itself. */
const SECTOR_INNER_RADIUS = 100;

/** Sector outer radius pad past the outermost bubble center. */
const SECTOR_OUTER_PAD = 20;

/** Sector arc extends slightly past the fan's outermost angle so the
 *  cream backdrop visibly wraps the cluster rather than ending exactly
 *  at the bubbles. */
const SECTOR_ANGLE_PAD_DEG = 12;

/** Extra angular slack (deg) past the sector arc when deciding whether a
 *  neighbour block is "in the way" of the fan, so a block grazing the
 *  edge still gets nudged rather than half-covered. */
const BORROW_ARC_MARGIN_DEG = 16;

/** Gap (px) left between the sector's outer edge and a borrowed block's
 *  center after it's pushed out, so the block clears the cluster with
 *  visible breathing room. */
const BORROW_GAP = 28;

/**
 * For each neighbour block sitting inside the bubble fan's sector,
 * compute the top-left position it should move to so the fan doesn't
 * cover it ("borrow" / make-way). Blocks outside the sector are absent
 * from the map (left where they are). The caller animates blocks to
 * these positions on expand and back to their layout positions on
 * collapse.
 */
function computeBorrowOffsets(args: {
  cx: number;
  cy: number;
  centerAngleDeg: number;
  sectorHalfArc: number;
  sectorOuterR: number;
  otherBlocks: Array<{ id: string; x: number; y: number }>;
}): Map<string, { x: number; y: number }> {
  const { cx, cy, centerAngleDeg, sectorHalfArc, sectorOuterR, otherBlocks } =
    args;
  const offsets = new Map<string, { x: number; y: number }>();
  const clearDist = sectorOuterR + NODE_W / 2 + BORROW_GAP;
  for (const b of otherBlocks) {
    const bcx = b.x + NODE_W / 2;
    const bcy = b.y + NODE_H / 2;
    const dx = bcx - cx;
    const dy = bcy - cy;
    const dist = Math.hypot(dx, dy);
    if (dist === 0 || dist >= clearDist) continue;
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    // Signed angular distance to the fan center, normalized to [-180,180].
    const da = ((ang - centerAngleDeg + 540) % 360) - 180;
    if (Math.abs(da) > sectorHalfArc + BORROW_ARC_MARGIN_DEG) continue;
    // Push the block straight out along its own bearing until it clears.
    const ux = dx / dist;
    const uy = dy / dist;
    offsets.set(b.id, {
      x: cx + ux * clearDist - NODE_W / 2,
      y: cy + uy * clearDist - NODE_H / 2,
    });
  }
  return offsets;
}

type BubbleItem = { label: string; display: string };

/** Drill-in bubble items for a block: its plain-language capabilities when
 *  present, else (older schemas) its humanized function names. */
export function bubbleItemsForBlock(block: DiagramBlock): BubbleItem[] {
  const caps = block.capabilities ?? [];
  if (caps.length > 0) {
    return caps.map((c) => ({ label: c, display: c }));
  }
  return (block.provenance?.functions ?? []).map((fn) => ({
    label: fn,
    display: humanizeFunctionName(fn),
  }));
}

/** The fan's core geometry for a block, shared by the node builder and
 *  the viewport-focus helper so the two never disagree about where the
 *  bubbles land. */
function fanGeometry(
  blockPosition: { x: number; y: number },
  count: number,
  otherBlocks: Array<{ x: number; y: number }>,
): {
  cx: number;
  cy: number;
  centerAngleDeg: number;
  radius: number;
  positions: Array<{ x: number; y: number }>;
} {
  const cx = blockPosition.x + NODE_W / 2;
  const cy = blockPosition.y + NODE_H / 2;
  const centerAngleDeg = pickFanCenterAngle(cx, cy, otherBlocks);
  const baseRadius = count === 1 ? RADIUS_SINGLE : RADIUS_MULTI;
  const radius = fanRadius(count, baseRadius);
  const positions = computeFanPositions(cx, cy, count, centerAngleDeg, radius);
  return { cx, cy, centerAngleDeg, radius, positions };
}

/**
 * Center point the viewport should focus on when this block's fan opens:
 * the center of the bounding box around the block AND all its bubbles.
 * Centering on the block alone clips the fan when it opens up or down
 * (the canvas is wider than tall), so the bottom/top bubbles fall off
 * screen. Framing the whole cluster fixes that.
 */
export function clusterFocusBounds(args: {
  block: DiagramBlock;
  blockPosition: { x: number; y: number };
  otherBlocks: Array<{ x: number; y: number }>;
}): { x: number; y: number; width: number; height: number } {
  const { block, blockPosition, otherBlocks } = args;
  const items = bubbleItemsForBlock(block);
  if (items.length === 0) {
    return {
      x: blockPosition.x,
      y: blockPosition.y,
      width: NODE_W,
      height: NODE_H,
    };
  }
  const { positions } = fanGeometry(blockPosition, items.length, otherBlocks);
  let minX = blockPosition.x;
  let maxX = blockPosition.x + NODE_W;
  let minY = blockPosition.y;
  let maxY = blockPosition.y + NODE_H;
  for (const p of positions) {
    minX = Math.min(minX, p.x - BUBBLE_HALF_SIZE);
    maxX = Math.max(maxX, p.x + BUBBLE_HALF_SIZE);
    minY = Math.min(minY, p.y - BUBBLE_HALF_SIZE);
    maxY = Math.max(maxY, p.y + BUBBLE_HALF_SIZE);
  }
  // Return the bounding RECT of the block + fan (not just the center) so the
  // caller can fitBounds() it: the zoom then adapts to how many bubbles there
  // are, instead of a fixed zoom that lands too close once a bubble edit adds
  // more of them.
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function buildBubbleAndSectorNodes(args: {
  activeBlockId: string;
  block: DiagramBlock;
  blockPosition: { x: number; y: number };
  otherBlocks: Array<{ id: string; x: number; y: number }>;
  isExiting: boolean;
}): { nodes: Node[]; borrow: Map<string, { x: number; y: number }> } {
  const { activeBlockId, block, blockPosition, otherBlocks, isExiting } = args;
  const items = bubbleItemsForBlock(block);
  if (items.length === 0) return { nodes: [], borrow: new Map() };

  const { cx, cy, centerAngleDeg, radius, positions } = fanGeometry(
    blockPosition,
    items.length,
    otherBlocks,
  );

  const sectorOuterR = radius + BUBBLE_HALF_SIZE + SECTOR_OUTER_PAD;
  const fanSpread = fanSpreadDeg(items.length);
  const sectorHalfArc =
    items.length === 1
      ? SECTOR_ANGLE_PAD_DEG
      : fanSpread / 2 + SECTOR_ANGLE_PAD_DEG;
  const sectorNode: Node<BubbleSectorNodeData> = {
    id: `__sector_${activeBlockId}`,
    type: "bubbleSector",
    position: { x: cx - sectorOuterR, y: cy - sectorOuterR },
    data: {
      parentBlockId: activeBlockId,
      outerRadius: sectorOuterR,
      innerRadius: SECTOR_INNER_RADIUS,
      startDeg: centerAngleDeg - sectorHalfArc,
      endDeg: centerAngleDeg + sectorHalfArc,
      isExiting,
    },
    draggable: false,
    selectable: false,
    // Purely decorative backdrop: make the whole node click-through so a
    // click on the fan area (this node's large bounding box) falls through
    // to the pane and collapses the cluster, instead of being swallowed by
    // the React Flow node wrapper (which captures clicks even though the
    // inner SVG is pointer-events-none).
    style: { pointerEvents: "none" },
    width: sectorOuterR * 2,
    height: sectorOuterR * 2,
    zIndex: -1,
  };

  // Assign items to fan slots in VISUAL reading order: sort the slots
  // top-to-bottom (left-to-right on ties) and give the first capability
  // the topmost slot. The angular fan order zig-zags on screen, so
  // badge 1..N used to jump around the arc; after this the eye can
  // follow 1, 2, 3 straight down the fan.
  const slotByItem = positions
    .map((_, i) => i)
    .sort(
      (a, b) =>
        positions[a].y - positions[b].y || positions[a].x - positions[b].x,
    );
  const bubbles: Node<BubbleNodeData>[] = items.map((item, i) => {
    const slot = positions[slotByItem[i]];
    const posX = slot.x - BUBBLE_HALF_SIZE;
    const posY = slot.y - BUBBLE_HALF_SIZE;
    // Offset from bubble center to block center: the radial-outward
    // animation starts at the block center (transform = this delta)
    // and tweens to (0,0).
    const bubbleCenterX = posX + BUBBLE_HALF_SIZE;
    const bubbleCenterY = posY + BUBBLE_HALF_SIZE;
    return {
      id: `__bubble_${activeBlockId}_${i}`,
      type: "bubble",
      position: { x: posX, y: posY },
      data: {
        label: item.label,
        displayLabel: item.display,
        parentBlockId: activeBlockId,
        parentBlockLabel: block.label,
        order: i + 1,
        total: items.length,
        isExiting,
        enterDx: cx - bubbleCenterX,
        enterDy: cy - bubbleCenterY,
      },
      draggable: false,
      selectable: false,
      width: BUBBLE_HALF_SIZE * 2,
      height: BUBBLE_HALF_SIZE * 2,
      zIndex: 1,
    };
  });

  const borrow = computeBorrowOffsets({
    cx,
    cy,
    centerAngleDeg,
    sectorHalfArc,
    sectorOuterR,
    otherBlocks,
  });

  return { nodes: [sectorNode, ...bubbles], borrow };
}
