import { useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import type { ConnectionLensDetail } from "../types";
import { NODE_H, NODE_W } from "../layout/constants";
import { useDiagramBusSubscribe } from "../protocol/bus";

/**
 * Connection-lens state (arrow-label pill drill-in).
 *
 * Opening runs in two beats. First the camera eases to frame the edge's two
 * blocks; only once it has SETTLED does the annotation appear and draw itself.
 * Doing it in that order matters: the note picks its spot from the emptiest
 * region of the current view, so drawing it mid-animation would make it skate
 * around as the transform changed underneath it.
 *
 * Closing restores whatever viewport the user had before, so dismissing the
 * note also undoes the zoom-in rather than leaving them stranded up close.
 *
 * The anchor is the edge's own label position in FLOW coordinates, forwarded
 * by LabeledEdge, so the leader dot sits exactly on the pill at any zoom.
 */

const FIT_MS = 380;
/** The framed pair may take at most this fraction of the pane, so the rest
 *  of the pane stays open canvas for the margin note (270px wide plus its
 *  breathing room). */
const PAIR_MAX_W_FRAC = 0.5;
const PAIR_MAX_H_FRAC = 0.6;
/** Never zoom IN past this while framing; reading the note matters more
 *  than huge block cards. */
const LENS_ZOOM_CAP = 1.0;

export function useConnectionLens(projectKey: number) {
  const reactFlow = useReactFlow();
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);
  const [lens, setLens] = useState<ConnectionLensDetail | null>(null);
  // True from the moment a lens open is REQUESTED (the camera starts its
  // framing flight) until close. `lens` alone cannot serve as this signal:
  // it is set FIT_MS after the request, and a canvas-wide auto-fit landing
  // inside that window would stomp the lens framing (the note then places
  // itself in a cramped, wrongly-zoomed view and can land on a block).
  // useCanvasFit suspends its fits while this is true.
  const [active, setActive] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const savedViewport = useRef<{ x: number; y: number; zoom: number } | null>(
    null,
  );

  useDiagramBusSubscribe("connection-lens", (detail) => {
    if (!detail) return;
    setActive(true);
    window.clearTimeout(timerRef.current);
    // Remember where we were so closing can return there. Only capture on a
    // fresh open, not when re-clicking while already open.
    if (!savedViewport.current) {
      savedViewport.current = reactFlow.getViewport();
    }
    // Frame the relationship MANUALLY via setViewport. fitView with its
    // `nodes` option silently did nothing here (verified live against
    // @xyflow/react 12.10: the camera never moved), so the note placed
    // itself in whatever cramped full-diagram view was active and could
    // land on a block. Manual math also lets the pair be capped to a
    // FRACTION of the pane, guaranteeing open canvas for the writing.
    const a = reactFlow.getNode(detail.from);
    const b = reactFlow.getNode(detail.to);
    if (a && b && paneW > 0 && paneH > 0) {
      const x0 = Math.min(a.position.x, b.position.x);
      const y0 = Math.min(a.position.y, b.position.y);
      const x1 = Math.max(
        a.position.x + (a.measured?.width ?? NODE_W),
        b.position.x + (b.measured?.width ?? NODE_W),
      );
      const y1 = Math.max(
        a.position.y + (a.measured?.height ?? NODE_H),
        b.position.y + (b.measured?.height ?? NODE_H),
      );
      const zoom = Math.max(
        0.4,
        Math.min(
          LENS_ZOOM_CAP,
          (paneW * PAIR_MAX_W_FRAC) / (x1 - x0),
          (paneH * PAIR_MAX_H_FRAC) / (y1 - y0),
        ),
      );
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      reactFlow.setViewport(
        { x: paneW / 2 - cx * zoom, y: paneH / 2 - cy * zoom, zoom },
        { duration: FIT_MS },
      );
    }
    timerRef.current = window.setTimeout(() => setLens(detail), FIT_MS);
  });

  const restoreViewport = useCallback(() => {
    if (savedViewport.current) {
      reactFlow.setViewport(savedViewport.current, { duration: FIT_MS });
      savedViewport.current = null;
    }
  }, [reactFlow]);

  // Close on USER-initiated project change (no camera restore: the diagram
  // itself is changing out from under us).
  useEffect(() => {
    window.clearTimeout(timerRef.current);
    setLens(null);
    setActive(false);
    savedViewport.current = null;
  }, [projectKey]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const close = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setLens(null);
    setActive(false);
    restoreViewport();
  }, [restoreViewport]);

  return { lens, active, close };
}
