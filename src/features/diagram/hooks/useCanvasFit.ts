import { useEffect, useRef } from "react";
import { useReactFlow } from "@xyflow/react";
import type { DiagramView, FetchState } from "../types";
import type { FocusState } from "./useAdaptiveFocus";

/**
 * Auto-fit the main canvas viewport at the three moments where the
 * node set or container size changes:
 *
 *   1. **Streaming growth** — fit each time `nodes.length` grows so
 *      new blocks don't land off-screen.
 *   2. **Final settle** — fit once when state transitions to "ready"
 *      so any post-stream edge arrivals get reframed.
 *   3. **Container resize** — fit on every container resize except the
 *      first (initial mount is handled by React Flow's fitView prop).
 *      Use the focused-set fit when in focus view so the camera tracks
 *      the active subset, not the full diagram.
 *
 * Returns a ref the caller attaches to the canvas container so the
 * ResizeObserver can watch the right element.
 */
export function useCanvasFit({
  state,
  view,
  focused,
  nodes,
  suspend = false,
}: {
  state: FetchState;
  view: DiagramView;
  focused: FocusState | null;
  nodes: unknown[];
  /** Pause every auto-fit while an overlay owns the camera (the connection
   *  lens frames its own two blocks; a canvas-wide fit landing mid-flight
   *  would stomp that framing and misplace the lens's margin note). */
  suspend?: boolean;
}): React.MutableRefObject<HTMLDivElement | null> {
  const { fitView } = useReactFlow();

  // Auto-fit viewport whenever the node set GROWS during streaming. Guarded on
  // the previous count rather than just running whenever the effect re-runs:
  // an animated fit that fires on a spurious re-run reads as the canvas
  // drifting for half a second for no reason the user can attribute.
  const prevCountRef = useRef(0);
  useEffect(() => {
    const grew = nodes.length > prevCountRef.current;
    prevCountRef.current = nodes.length;
    if (suspend) return;
    if (nodes.length === 0 || !grew) return;
    const t = window.setTimeout(() => {
      fitView({ padding: 0.15, duration: 400, maxZoom: 1.6 });
    }, 60);
    return () => window.clearTimeout(t);
  }, [nodes.length, fitView, suspend]);

  // Final fit after streaming completes — edges may have arrived after
  // the last node-trigger, and dagre may have shifted positions.
  useEffect(() => {
    if (suspend) return;
    if (state.kind !== "ready") return;
    if (nodes.length === 0) return;
    const t = window.setTimeout(() => {
      fitView({ padding: 0.15, duration: 500, maxZoom: 1.6 });
    }, 120);
    return () => window.clearTimeout(t);
  }, [state, fitView, nodes.length, suspend]);

  // Recenter the viewport whenever the canvas's available width
  // changes — the side panel sliding in/out, the user dragging the
  // resize handle, the window itself resizing. Without this, growing
  // the panel pushes the diagram off the visible area and shrinking
  // it leaves a lopsided composition.
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const fitFnRef = useRef<() => void>(() => {});
  fitFnRef.current = () => {
    if (suspend) return;
    if (state.kind !== "ready") return;
    if (nodes.length === 0) return;
    // duration 0: the resize path must track the container LIVE. Any easing
    // here reads as the canvas lagging the panel edge, because the animation
    // only starts once the size stops changing. Animated fits are still used
    // for CONTENT changes (streaming / settle) in the effects above, where a
    // glide is what you want.
    if (view === "focus" && focused && focused.ids.length > 0) {
      fitView({
        nodes: focused.ids.map((id) => ({ id })),
        padding: 0.3,
        duration: 0,
        maxZoom: 1.3,
        minZoom: 0.5,
      });
    } else {
      fitView({ padding: 0.15, duration: 0, maxZoom: 1.6 });
    }
  };
  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;
    let raf = 0;
    let isFirst = true;
    const ro = new ResizeObserver(() => {
      // Skip the very first observation — that's the initial mount,
      // already handled by React Flow's `fitView` prop and the streaming
      // effects above. We only want to react to subsequent size changes.
      if (isFirst) {
        isFirst = false;
        return;
      }
      // Coalesce to one fit per frame instead of debouncing. Debouncing meant
      // nothing moved until 80ms AFTER the drag ended; this keeps the diagram
      // tracking the panel edge while it is being dragged.
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        fitFnRef.current();
      });
    });
    ro.observe(el);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return canvasContainerRef;
}
