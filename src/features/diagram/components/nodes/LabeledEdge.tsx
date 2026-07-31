import { useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useNodes,
  type EdgeProps,
} from "@xyflow/react";
import { useChatContextDrag } from "@/core/chatContextDrag";
import { useDiagramBus } from "../../protocol/bus";
import {
  pathLabelAnchor,
  pointsToPath,
  type Pt,
} from "../../layout/orthogonalRoute";
import { linkContextItem } from "../../util/contextItem";

/** Pull both endpoints of a routed polyline inward by `gap` px along their
 *  adjacent segment, so the line + arrowhead stop just short of the block
 *  instead of butting into its edge (and the now-hidden handle dot). */
function insetEnds(pts: Pt[], gap: number): Pt[] {
  if (pts.length < 2) return pts;
  const move = (from: Pt, toward: Pt): Pt => {
    const dx = toward.x - from.x;
    const dy = toward.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.min(gap, len) / len;
    return { x: from.x + dx * k, y: from.y + dy * k };
  };
  const out = pts.map((p) => ({ ...p }));
  out[0] = move(out[0], out[1]);
  out[out.length - 1] = move(out[out.length - 1], out[out.length - 2]);
  return out;
}

/**
 * Custom React Flow edge renderer for a labeled, obstacle-avoiding arrow.
 *
 * The path is routed GLOBALLY by the canvas (routeManyEdges) so lines
 * route around blocks AND fan into separate lanes; the routed waypoints
 * arrive on `data.routedPath` and this component just draws them. It
 * falls back to smoothstep only when no route is supplied. The label pill
 * sits BESIDE the line at its midpoint. On hover it emphasizes its own
 * line (thicker, darker) so, when pills bunch up near a junction, you can
 * tell which line a pill belongs to and which way it points. A click
 * emits `connection-lens` so the canvas opens the connection lenses.
 *
 * Pending arrows (marching-ants, mid-pull) are non-interactive.
 */
export function LabeledEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  style,
  markerEnd,
  data,
  ...rest
}: EdgeProps) {
  const bus = useDiagramBus();
  const nodes = useNodes();
  const { dragSourceProps } = useChatContextDrag();
  const [hover, setHover] = useState(false);

  // Block labels for the two ends, so dragging the pill into chat reads
  // "<from> -> <to>" rather than raw ids.
  const labelOf = (nodeId: string) =>
    (
      nodes.find((n) => n.id === nodeId)?.data as
        | { label?: string }
        | undefined
    )?.label ?? nodeId;

  // Draw the globally-routed waypoints directly (their endpoints are the
  // handle centers, so they meet the handles). Fall back to smoothstep
  // only when the canvas could not route this edge.
  const routedPath = (data as { routedPath?: Pt[] | null } | undefined)
    ?.routedPath;
  const points = routedPath && routedPath.length >= 2 ? routedPath : null;
  // Draw a slightly shortened polyline so the arrow keeps a small gap from
  // the block at both ends; the label anchor still uses the full `points`.
  const drawPoints = points ? insetEnds(points, 7) : null;

  const fallback = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const edgePath = drawPoints ? pointsToPath(drawPoints) : fallback[0];
  const anchor = points
    ? pathLabelAnchor(points)
    : {
        x: fallback[1],
        y: fallback[2],
        vertical: Math.abs(targetY - sourceY) >= Math.abs(targetX - sourceX),
      };
  const lx = anchor.x;
  const ly = anchor.y;
  const vertical = anchor.vertical;

  const className = (rest as { className?: string }).className;
  const recent = (data as { recent?: boolean } | undefined)?.recent === true;
  // Set by the canvas while a bubble fan is open: the whole edge (line +
  // label) fades back and goes non-interactive so nothing competes with
  // the cluster. Clears the moment the fan collapses.
  const dimmed = (data as { dimmed?: boolean } | undefined)?.dimmed === true;
  const pending = typeof className === "string" && className.includes("pending");
  const verb = typeof label === "string" ? label : "";
  const interactive = !!verb && !pending && !dimmed;

  // Place the pill BESIDE its line, not over it. For a vertical segment
  // anchor the pill just to the right of the line; for a horizontal one,
  // sit it just above. `vertical` is the orientation at the path midpoint.
  const labelTransform = vertical
    ? `translate(8px, -50%) translate(${lx}px, ${ly}px)`
    : `translate(-50%, -118%) translate(${lx}px, ${ly}px)`;

  // Hover emphasizes this edge's own line so it stands out from any
  // overlapping neighbours.
  const pathStyle =
    hover && interactive
      ? { ...style, stroke: "#2A2622", strokeWidth: 2.5 }
      : style;

  const labelClass = `nodrag nopan absolute select-none rounded-md border px-2 py-0.5 text-[11px] font-medium shadow-sm transition-colors ${
    recent
      ? "border-[#78716C] bg-[#F5F5F4] text-[#78716C]"
      : "border-[#D4D4D4] bg-white text-[#444444]"
  } ${
    interactive
      ? `pointer-events-auto cursor-pointer hover:bg-[#F7F9FB] ${hover ? "border-[#8A97A3]" : ""}`
      : "pointer-events-none"
  }`;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={pathStyle}
        markerEnd={markerEnd}
        className={className}
        interactionWidth={0}
      />
      {/* Invisible widened hit-area over the line, so hovering (or
       *  clicking) the LINE itself, not just the pill, highlights /
       *  opens the link. */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        className={interactive ? "nopan nodrag" : undefined}
        style={{
          pointerEvents: interactive ? "stroke" : "none",
          cursor: interactive ? "grab" : "default",
        }}
        {...(interactive
          ? dragSourceProps(
              linkContextItem(labelOf(source), labelOf(target), verb),
            )
          : {})}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={
          interactive
            ? (e) => {
                e.stopPropagation();
                bus.emit("connection-lens", {
                  from: source,
                  to: target,
                  verb,
                  x: e.clientX,
                  y: e.clientY,
                  fx: lx,
                  fy: ly,
                });
              }
            : undefined
        }
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className={labelClass}
            {...(interactive
              ? dragSourceProps(
                  linkContextItem(labelOf(source), labelOf(target), verb),
                )
              : {})}
            style={{
              transform: labelTransform,
              // Pop above nodes (~10), a touch higher while hovered so the
              // emphasized pill sits over its neighbours. While dimmed the
              // pill recedes (faded + behind the open fan's bubbles).
              zIndex: dimmed ? 0 : hover ? 21 : 20,
              opacity: dimmed ? 0.12 : 1,
              transition: "opacity 200ms ease",
            }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            onClick={
              interactive
                ? (e) => {
                    e.stopPropagation();
                    bus.emit("connection-lens", {
                      from: source,
                      to: target,
                      verb,
                      x: e.clientX,
                      y: e.clientY,
                      fx: lx,
                      fy: ly,
                    });
                  }
                : undefined
            }
            title={
              interactive
                ? "Click to see how this link works · drag into chat as context"
                : undefined
            }
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/**
 * Stable edgeType registry passed to ReactFlow. Module-level so the
 * object identity doesn't change between renders.
 */
export const edgeTypes = { labeled: LabeledEdge };
