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
}: {
  state: FetchState;
  view: DiagramView;
  focused: FocusState | null;
  nodes: unknown[];
}): React.MutableRefObject<HTMLDivElement | null> {
  const { fitView } = useReactFlow();

  // Auto-fit viewport whenever the node set grows during streaming.
  useEffect(() => {
    if (nodes.length === 0) return;
    const t = window.setTimeout(() => {
      fitView({ padding: 0.15, duration: 400, maxZoom: 1.6 });
    }, 60);
    return () => window.clearTimeout(t);
  }, [nodes.length, fitView]);

  // Final fit after streaming completes — edges may have arrived after
  // the last node-trigger, and dagre may have shifted positions.
  useEffect(() => {
    if (state.kind !== "ready") return;
    if (nodes.length === 0) return;
    const t = window.setTimeout(() => {
      fitView({ padding: 0.15, duration: 500, maxZoom: 1.6 });
    }, 120);
    return () => window.clearTimeout(t);
  }, [state, fitView, nodes.length]);

  // Recenter the viewport whenever the canvas's available width
  // changes — the side panel sliding in/out, the user dragging the
  // resize handle, the window itself resizing. Without this, growing
  // the panel pushes the diagram off the visible area and shrinking
  // it leaves a lopsided composition.
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const fitFnRef = useRef<() => void>(() => {});
  fitFnRef.current = () => {
    if (state.kind !== "ready") return;
    if (nodes.length === 0) return;
    // Gentle pan/zoom (400ms, not 220) so toggling focus mode on/off, where
    // the panel opening/closing changes the canvas width and triggers this
    // refit, glides instead of snapping. A snap at this size reads as jarring.
    if (view === "focus" && focused && focused.ids.length > 0) {
      fitView({
        nodes: focused.ids.map((id) => ({ id })),
        padding: 0.3,
        duration: 400,
        maxZoom: 1.3,
        minZoom: 0.5,
      });
    } else {
      fitView({ padding: 0.15, duration: 400, maxZoom: 1.6 });
    }
  };
  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;
    let timer: number | undefined;
    let isFirst = true;
    const ro = new ResizeObserver(() => {
      // Skip the very first observation — that's the initial mount,
      // already handled by React Flow's `fitView` prop and the streaming
      // effects above. We only want to react to subsequent size changes.
      if (isFirst) {
        isFirst = false;
        return;
      }
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => fitFnRef.current(), 80);
    });
    ro.observe(el);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  return canvasContainerRef;
}
