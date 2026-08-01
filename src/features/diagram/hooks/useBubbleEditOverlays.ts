import { useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow, useStore, type Node } from "@xyflow/react";
import { logEvent } from "@/core/interactionLog";
import { BUBBLE_HALF_SIZE } from "../layout/bubbleNodes";
import {
  CARD_GAP,
  CARD_MARGIN,
  CARD_RESERVE_H,
  CARD_W,
} from "../layout/detailCardLayout";

/**
 * State machine behind the bubble-drill-in capability detail card.
 *
 * Extracted from DiagramCanvas so that orchestrator does not carry this
 * feature's state, click-routing, and reset inline (it was already past
 * a thousand lines). The actual code-writing dispatch stays in
 * DiagramCanvas, which owns the bus and clearBubbles; this hook only
 * tracks whether the detail card is open and opens it from a bubble click.
 *
 * Opening a bubble reads like PULLING the detail out of the bubble: the
 * camera eases OUT a touch (so there is room beside the bubble and the fan
 * shrinks back into context), a leader line then grows from the bubble's rim
 * out to the card. That sequencing lives here (the zoom-out + a `settled`
 * flag the card waits on before it draws itself); the card owns the leader
 * and its own placement beside the bubble.
 */

export type BubbleDetailTarget = {
  functionName: string;
  displayLabel: string;
  blockId: string;
  /** Bubble CENTRE in flow coords, so the leader stays welded to the bubble
   *  through the zoom-out and any later transform tick. */
  fx: number;
  fy: number;
  /** Bubble radius in flow units, so the leader can start at the rim. */
  r: number;
  /** Outward direction (bubble relative to its block/fan centre). The card
   *  extends THIS way, following the fan into the open space it opened, so a
   *  left-fanning cluster grows its card left, an up-fan grows up, and so on. */
  dirX: number;
  dirY: number;
};

type Viewport = { x: number; y: number; zoom: number };

/** Zoom-out eased on open (and the reverse on close). */
const ZOOM_MS = 420;
/** How far to pull the camera OUT so the card + leader have room. */
const ZOOM_OUT_FACTOR = 0.72;
/** Extra slack beyond the card's own footprint, so after this reframe the
 *  card's fit check on the outward side passes comfortably rather than by a
 *  hair (a hair's difference made it fall back to the wrong side). */
const FIT_SLACK = 24;

export function useBubbleEditOverlays(projectKey: number) {
  const reactFlow = useReactFlow();
  // Pane size, so the open reframe can place the bubble where the card fits.
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);
  const [detail, setDetail] = useState<BubbleDetailTarget | null>(null);
  // The card waits for this before it draws, so its leader and body appear
  // only once the zoom-out has settled (drawing mid-animation would make the
  // note skate as the transform changed underneath it).
  const [settled, setSettled] = useState(false);
  // Viewport to return to when the card closes (the fanned-cluster view).
  const savedViewport = useRef<Viewport | null>(null);
  const settleTimer = useRef<number | undefined>(undefined);

  // Close the editor on a USER-initiated project change.
  useEffect(() => {
    setDetail(null);
    setSettled(false);
    savedViewport.current = null;
    window.clearTimeout(settleTimer.current);
  }, [projectKey]);

  useEffect(
    () => () => window.clearTimeout(settleTimer.current),
    [],
  );

  /** Open the capability detail card for a clicked function bubble. Anchors to
   *  the bubble's flow centre and eases the camera out to make room. */
  const openFromBubble = useCallback(
    (node: Node, evt: React.MouseEvent) => {
      // The click point is unused now (the card anchors to the bubble in flow
      // space, not the cursor), but keep the signature stable for the caller.
      void evt;
      const d = node.data as {
        label?: string;
        displayLabel?: string;
        parentBlockId?: string;
        enterDx?: number;
        enterDy?: number;
      };
      if (!d.parentBlockId || !d.label) return;
      logEvent("bubble-open", {
        blockId: d.parentBlockId,
        functionName: d.label,
      });

      const w = node.measured?.width ?? BUBBLE_HALF_SIZE * 2;
      const h = node.measured?.height ?? BUBBLE_HALF_SIZE * 2;
      const fx = node.position.x + w / 2;
      const fy = node.position.y + h / 2;
      const r = Math.max(w, h) / 2;
      // enterDx/Dy points from the bubble TO the fan centre (near the block);
      // the outward direction the card should follow is the opposite.
      const dirX = -(d.enterDx ?? 0);
      const dirY = -(d.enterDy ?? 0);

      // Ease OUT, then pin the bubble at a screen spot that guarantees room for
      // the card on its OUTWARD side (the way the fan opened). A fan that opens
      // toward a pane edge leaves the bubble hard against it, so pinning it
      // where it sits would give the card no room outward and the card would
      // fall back to the INWARD side (over the block). We keep the bubble near
      // where it is, but shift it just enough along the outward axis so the
      // card fits beyond it, and never off the near edge.
      const vp = reactFlow.getViewport();
      savedViewport.current = vp;
      const z2 = Math.max(0.3, vp.zoom * ZOOM_OUT_FACTOR);
      const rp = r * z2;
      let sx = fx * vp.zoom + vp.x;
      let sy = fy * vp.zoom + vp.y;
      const horiz = Math.abs(dirX) >= Math.abs(dirY);
      // Same fan-bulge overshoot the card adds to its gap, so the room we
      // reserve on the outward side matches where the card will actually land.
      const reach = Math.hypot(dirX, dirY);
      const axisComp = horiz ? Math.abs(dirX) : Math.abs(dirY);
      const bulge = Math.max(0, reach - axisComp) * z2;
      const needH = CARD_W + CARD_GAP + bulge + CARD_MARGIN + rp + FIT_SLACK;
      const needV = CARD_RESERVE_H + CARD_GAP + bulge + CARD_MARGIN + rp + FIT_SLACK;
      if (horiz) {
        if (dirX >= 0) sx = Math.min(sx, paneW - needH); // card to the right
        else sx = Math.max(sx, needH); // card to the left
      } else {
        if (dirY >= 0) sy = Math.min(sy, paneH - needV); // card below
        else sy = Math.max(sy, needV); // card above
      }
      // Keep the bubble itself comfortably on-screen.
      sx = Math.min(Math.max(sx, rp + CARD_MARGIN), paneW - rp - CARD_MARGIN);
      sy = Math.min(Math.max(sy, rp + CARD_MARGIN), paneH - rp - CARD_MARGIN);
      reactFlow.setViewport(
        { x: sx - fx * z2, y: sy - fy * z2, zoom: z2 },
        { duration: ZOOM_MS },
      );

      setSettled(false);
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => setSettled(true), ZOOM_MS);

      setDetail({
        functionName: d.label,
        displayLabel: d.displayLabel ?? d.label,
        blockId: d.parentBlockId,
        fx,
        fy,
        r,
        dirX,
        dirY,
      });
    },
    [reactFlow, paneW, paneH],
  );

  const closeDetail = useCallback(() => {
    setDetail(null);
    setSettled(false);
    window.clearTimeout(settleTimer.current);
    // Ease back to the fanned-cluster view we pulled out of.
    if (savedViewport.current) {
      reactFlow.setViewport(savedViewport.current, { duration: ZOOM_MS });
      savedViewport.current = null;
    }
  }, [reactFlow]);

  return {
    detail,
    settled,
    openFromBubble,
    closeDetail,
  };
}
