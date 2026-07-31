import { useEffect, useRef } from "react";
import { useReactFlow } from "@xyflow/react";
import type { TracedStep } from "./useInteractionTracker";

/**
 * Camera-only trace-back: when the user clicks a tracker row, zoom to the
 * block(s) it points at; when they clear the trace (re-click the row, click
 * the pane, close the tray), zoom back OUT to the whole diagram so they
 * return to the overview they came from. Never changes diagram state.
 */
export function useTraceFit(traced: TracedStep): void {
  const rf = useReactFlow();
  // Whether we're currently zoomed in for a trace, so a clear zooms back out
  // exactly once (not on every render where traced is already null).
  const zoomedIn = useRef(false);
  useEffect(() => {
    if (traced && traced.blockIds.length > 0) {
      // Only fit to blocks that still exist. A traced step can point at a
      // block that is gone (a "removed" entry, or one re-keyed by a regen);
      // React Flow's fitView does NOT bail on unknown ids, it computes empty
      // bounds and lurches the camera to world origin.
      const present = traced.blockIds.filter((id) => rf.getNode(id));
      if (present.length === 0) return;
      zoomedIn.current = true;
      const t = window.setTimeout(() => {
        rf.fitView({
          nodes: present.map((id) => ({ id })),
          padding: 0.35,
          duration: 500,
          maxZoom: 1.4,
          minZoom: 0.5,
        });
      }, 40);
      return () => window.clearTimeout(t);
    }
    // Trace cleared: zoom back out to the full diagram (once).
    if (zoomedIn.current) {
      zoomedIn.current = false;
      const t = window.setTimeout(() => {
        rf.fitView({ padding: 0.15, duration: 500, maxZoom: 1.6 });
      }, 40);
      return () => window.clearTimeout(t);
    }
  }, [traced, rf]);
}
