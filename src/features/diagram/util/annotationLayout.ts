/**
 * Pure geometry for the connection-lens margin note: where to place the note
 * and how clear the leader's run is. Extracted from the overlay so it stays
 * small and so this can be unit-tested (it is currently exercised by a
 * scratch harness; a real test can import these directly).
 *
 * Everything here is in PANE (screen) pixels. The caller converts to/from flow
 * coordinates so the note stays glued to the diagram through pans and zooms.
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type Pt = [number, number];

/** Width of the writing column (matches the note div's width). */
export const NOTE_W = 270;
/** A generous default note height, used before the real one is measured. */
export const NOTE_H_EST = 178;
/** Height the note is placed AGAINST even while it is still a short loading
 *  skeleton. Reserving a full-note footprint up front is what stops the note
 *  from being parked low (against the skeleton height) and then overrunning the
 *  canvas once the real, taller text arrives. Also keeps the loading spot and
 *  the final spot identical for any note this tall or shorter, so it never
 *  visibly jumps when its text loads. */
export const NOTE_H_RESERVE = 200;

/** Grid step for the empty-space search. Finer = better spot, costlier. */
const GRID_STEP = 46;
/** Keep the whole note this far inside the pane. */
const MARGIN = 16;
/** Breathing room the note keeps from every block. Scoring treats the zone
 *  around a block as part of the block, so the note never sits flush against
 *  a card edge (flush placements read as the note clipping the drawing, and
 *  any slight zoom drift after placement turns them into real overlap). */
const BLOCK_CLEAR = 28;
/** Half-size of the keep-clear box around the pill, so the note never lands on
 *  the verb pill / leader dot it points at. Exported so the leader can begin
 *  its line at this same box border (never over the pill label). */
export const PILL_CLEAR_X = 96;
export const PILL_CLEAR_Y = 44;

/** Area where two rects overlap; 0 when they miss each other. */
export function overlapArea(a: Rect, b: Rect): number {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}

/** How many sampled points along a polyline fall inside a block, i.e. how much
 *  a leader drawn along it would paint over the drawing. */
export function routeCost(poly: Pt[], blocks: Rect[]): number {
  let hits = 0;
  for (let s = 0; s < poly.length - 1; s++) {
    const [x0, y0] = poly[s];
    const [x1, y1] = poly[s + 1];
    for (let k = 1; k < 16; k++) {
      const px = x0 + ((x1 - x0) * k) / 16;
      const py = y0 + ((y1 - y0) * k) / 16;
      for (const b of blocks) {
        if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
          hits += 1;
          break;
        }
      }
    }
  }
  return hits + (poly.length - 2) * 0.25;
}

/** The point on the note's edge NEAREST the pill: a perpendicular drop onto the
 *  closest edge. The leader joins here. Because the pill sits OUTSIDE the note,
 *  the straight line to this point approaches the edge square-on and never
 *  crosses the note's own text; and, unlike joining a corner, it always points
 *  straight INTO the note (a corner on the note's far side made the leader look
 *  like it pointed away, past the note, toward whatever was beyond it). */
export function nearestNotePoint(
  nx: number,
  ny: number,
  w: number,
  h: number,
  ax: number,
  ay: number,
): Pt {
  const cx = Math.min(Math.max(ax, nx), nx + w);
  const cy = Math.min(Math.max(ay, ny), ny + h);
  return [cx, cy];
}

/**
 * Choose the note's top-left. The governing principle: the note grows into
 * the empty space NEAR the pill. A pill sitting toward a corner grows into
 * that corner's void; a note that flies across the pane to some unrelated
 * corner is wrong even if that corner is perfectly clear, because the reader
 * loses the connection between the pill and its annotation.
 *
 * Scored as ONE combined cost per candidate cell:
 *  - clearance, two tiers: sitting on a block BODY is effectively
 *    forbidden (raw px^2, tripled), while eating into a block's breathing
 *    zone is only a light penalty. The soft tier matters in narrow
 *    corridors: a spot beside the pill with a slightly tighter gap must
 *    beat a spot hundreds of px away with a perfect gap.
 *  - crossHot * 250: the leader must not run through either of the lens's
 *    two LIT endpoint blocks.
 *  - crossCold * 40: the leader running over a DIMMED background block is
 *    only mildly discouraged. During the lens everything but the endpoints
 *    sits at near-zero opacity, so a line brushing one is visually cheap,
 *    and treating it as forbidden was what used to chase the note to the
 *    far corners.
 *  - d * 1.2: distance to the pill, the dominant tiebreak among clear
 *    spots. This is what keeps the note adjacent instead of merely legal.
 *    The metric is ANISOTROPIC: vertical offset counts about 2.4x, so the
 *    note pulls straight LEFT or RIGHT of the pill whenever a side has
 *    room (a horizontal leader reads calmer than a diagonal one) and only
 *    drifts diagonally when both sides are blocked.
 *  - left * 30: soft nudge to the right of the pill so the margin rule
 *    faces it.
 *
 * The candidates are a coarse grid for open areas PLUS lines aligned to every
 * block edge (one breathing-room gap past its right/left/top/bottom). Those
 * edge lines matter: a plain grid can step OVER the clear column that sits
 * right beside a block and settle for a small sliver of overlap, which reads
 * as the note clipping the drawing. Aligning candidates to the block edges
 * makes "beside a block, with a gap" always reachable, so a clear spot is
 * chosen when one exists.
 *
 * `hotRects` must be entries of `blockRects` (same references); the rest are
 * treated as cold.
 */
export function placeNote(
  blockRects: Rect[],
  ax: number,
  ay: number,
  paneW: number,
  paneH: number,
  noteH: number,
  hotRects: Rect[] = [],
): { x: number; y: number; covered: number } {
  const pill: Rect = {
    x: ax - PILL_CLEAR_X,
    y: ay - PILL_CLEAR_Y,
    w: PILL_CLEAR_X * 2,
    h: PILL_CLEAR_Y * 2,
  };
  // Rects the leader may brush cheaply: everything not in the hot set.
  const hotSet = new Set(hotRects);
  const cold = blockRects.filter((b) => !hotSet.has(b));
  // Coverage is scored against blocks INFLATED by the breathing room, so
  // "touching a card" costs the same as sitting on it and the note keeps a
  // visible gap from the drawing.
  const padded: Rect[] = blockRects.map((b) => ({
    x: b.x - BLOCK_CLEAR,
    y: b.y - BLOCK_CLEAR,
    w: b.w + BLOCK_CLEAR * 2,
    h: b.h + BLOCK_CLEAR * 2,
  }));
  const maxX = Math.max(MARGIN, paneW - NOTE_W - MARGIN);
  const maxY = Math.max(MARGIN, paneH - noteH - MARGIN);
  const clampX = (x: number) => Math.min(Math.max(MARGIN, x), maxX);
  const clampY = (y: number) => Math.min(Math.max(MARGIN, y), maxY);

  const xs = new Set<number>();
  const ys = new Set<number>();
  for (let x = MARGIN; x <= maxX; x += GRID_STEP) xs.add(x);
  for (let y = MARGIN; y <= maxY; y += GRID_STEP) ys.add(y);
  xs.add(maxX);
  ys.add(maxY);
  for (const b of padded) {
    xs.add(clampX(b.x + b.w)); // clear of the block's right
    xs.add(clampX(b.x - NOTE_W)); // clear of the block's left
    ys.add(clampY(b.y + b.h)); // just below the block, with the gap
    ys.add(clampY(b.y - noteH)); // just above the block, with the gap
  }

  let best = { x: MARGIN, y: MARGIN, covered: 0 };
  let bestScore = Number.POSITIVE_INFINITY;
  for (const x of xs) {
    for (const y of ys) {
      const rect: Rect = { x, y, w: NOTE_W, h: noteH };
      let rawCover = 0;
      for (const b of blockRects) rawCover += overlapArea(rect, b);
      let paddedCover = 0;
      for (const b of padded) paddedCover += overlapArea(rect, b);
      const clearanceCost =
        rawCover * 3 +
        (paddedCover - rawCover) * 0.15 +
        overlapArea(rect, pill) * 5;
      const joint = nearestNotePoint(x, y, NOTE_W, noteH, ax, ay);
      const crossHot =
        hotRects.length > 0 ? routeCost([[ax, ay], joint], hotRects) : 0;
      const crossCold = routeCost([[ax, ay], joint], cold);
      const d = Math.hypot(x + NOTE_W / 2 - ax, (y + noteH / 2 - ay) * 2.4);
      const score =
        clearanceCost +
        crossHot * 250 +
        crossCold * 40 +
        (x + NOTE_W / 2 < ax ? 30 : 0) +
        d * 1.2;
      if (score < bestScore) {
        bestScore = score;
        // Report RAW block coverage, not the padded scoring term: the
        // caller's "needs a paper halo" check should react to real
        // ink-on-block overlap, not to sitting inside the breathing zone.
        let raw = 0;
        for (const b of blockRects) raw += overlapArea(rect, b);
        best = { x, y, covered: raw };
      }
    }
  }
  return best;
}
