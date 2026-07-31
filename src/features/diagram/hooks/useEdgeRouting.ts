import { useMemo, useRef } from "react";
import type { Edge, Node } from "@xyflow/react";
import { NODE_W, NODE_H } from "../layout/constants";
import {
  routeManyEdges,
  type RouteRect,
  type RouteSide,
} from "../layout/orthogonalRoute";

/**
 * Attach a globally-routed, lane-separated path to each edge's
 * `data.routedPath`.
 *
 * Routes ALL edges together (routeManyEdges) so they avoid blocks AND fan
 * into separate lanes instead of stacking when they share a corridor. The
 * edge component reads `data.routedPath` and draws it (falling back to
 * smoothstep when an edge could not be routed).
 *
 * PERFORMANCE: routing runs A* per edge over a grid built from every block's
 * coordinates, so it is far too expensive to run on every render. It used to
 * be memoized on `[edges, nodes]`, but the canvas hands us a NEW nodes array
 * on each render, so the memo missed every time. Anything that re-rendered
 * the canvas without moving a single block (notably resizing the panel, which
 * makes React Flow re-measure and re-render) re-ran the entire router, once
 * per animation frame, which is what made dragging the divider crawl.
 *
 * So we key the expensive work on a cheap SIGNATURE of exactly the geometry
 * the router consumes (block ids, positions, measured sizes, and the edge
 * endpoints). Re-renders that do not change that signature reuse the paths.
 */
export function useEdgeRouting(nodes: Node[], edges: Edge[]): Edge[] {
  // Read the latest values inside the heavy memo without making them deps.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // O(n) string build, cheap enough to run every render.
  const signature = useMemo(() => {
    const parts: string[] = [];
    for (const n of nodes) {
      if (n.type !== "block") continue;
      const m = (n as { measured?: { width?: number; height?: number } })
        .measured;
      parts.push(
        `${n.id}:${Math.round(n.position.x)}:${Math.round(n.position.y)}:${
          m?.width ?? NODE_W
        }:${m?.height ?? NODE_H}`,
      );
    }
    parts.push("#");
    for (const e of edges) {
      parts.push(`${e.id}:${e.source}>${e.target}:${e.sourceHandle ?? "b"}${e.targetHandle ?? "t"}`);
    }
    return parts.join("|");
  }, [nodes, edges]);

  // The expensive part: only re-runs when the geometry actually changed.
  const paths = useMemo(() => {
    const rects = new Map<string, RouteRect>();
    for (const n of nodesRef.current) {
      if (n.type !== "block") continue;
      const m = (n as { measured?: { width?: number; height?: number } })
        .measured;
      rects.set(n.id, {
        x: n.position.x,
        y: n.position.y,
        width: m?.width ?? NODE_W,
        height: m?.height ?? NODE_H,
      });
    }
    const routeInputs = edgesRef.current
      .filter((e) => rects.has(e.source) && rects.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceSide: (e.sourceHandle ?? "b") as RouteSide,
        targetSide: (e.targetHandle ?? "t") as RouteSide,
      }));
    return routeManyEdges(rects, routeInputs);
    // Intentionally keyed on the signature alone: it encodes every input the
    // router reads, so the refs above are always consistent with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        data: { ...e.data, routedPath: paths.get(e.id) ?? null },
      })),
    [edges, paths],
  );
}
