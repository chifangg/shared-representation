import { useEffect, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { MoreHorizontal, Grip } from "lucide-react";
import { useChatContextDrag } from "@/core/chatContextDrag";
import type { BlockNodeData } from "../../types";
import { NODE_H, NODE_W } from "../../layout/constants";
import { blockContextItem } from "../../util/contextItem";

/**
 * Custom React Flow node renderer for a diagram block.
 *
 * Pulls its visual state from the typed `data` prop (label, caption,
 * provenance counts, focus / pending / recent-change flags) and renders
 * a card with inline rename, four connection handles, and a "⋯" action
 * affordance that appears on hover.
 *
 * Behavior surface owned by the caller and threaded through
 * `data.onLabelChange` / `data.onActions`:
 *  - onLabelChange: commits a rename (called on Enter or blur with a
 *    trimmed, non-empty, changed label). Triggers the slow-path chat
 *    flow that asks Claude to rewrite the corresponding identifier in
 *    source.
 *  - onActions: opens the block-level cards overlay.
 */
export function BlockNode({ data, selected }: NodeProps<Node<BlockNodeData>>) {
  const { dragSourceProps } = useChatContextDrag();
  const fileCount = data.files.length;
  const fnCount = data.functions.length;
  const capCount = data.capabilities?.length ?? 0;
  // What the drill-in bubbles surface: capabilities when present, else the
  // older function list.
  const drillCount = capCount > 0 ? capCount : fnCount;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.label);
  // Sync draft with external label updates (e.g. diagram regenerated)
  // when we're not actively editing.
  useEffect(() => {
    if (!editing) setDraft(data.label);
  }, [data.label, editing]);

  const commit = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (!trimmed || trimmed === data.label) {
      setDraft(data.label);
      return;
    }
    data.onLabelChange?.(trimmed);
  };
  const cancel = () => {
    setDraft(data.label);
    setEditing(false);
  };

  const ring = data.isPending
    ? "pending-block-pulse"
    : data.isEditing
      ? "pending-block-pulse"
      : data.isRecentlyAdded
        ? "recent-change-block"
        : data.isFocused
          ? "ring-[3px] ring-[#F59E0B] focus-pulse"
          : selected
            ? "ring-2 ring-[#78716C]/40 shadow-xl"
            : "shadow-sm hover:shadow-md";
  const borderColor = data.isPending
    ? "border-2 border-dashed border-[#78716C] bg-[#F5F5F4]"
    : data.isContainer
      ? "border-[#78716C]/40 bg-[#F5F5F4]"
      : "border-[#D4D4D4]";
  const dim = data.isDimmed
    ? "opacity-30 saturate-50 transition-opacity duration-300"
    : "opacity-100 transition-opacity duration-300";
  // Color-coding applies only to ordinary blocks. Pending placeholders
  // and container frames keep their own distinct framing so the tint
  // doesn't muddy those states. The fill + accent are resolved upstream
  // in DiagramCanvas through the active color scheme, so this renderer
  // stays scheme-agnostic. Inline style so it overrides the base
  // `bg-white` + neutral border classes; the accent rides on the left
  // edge as a chunking cue.
  const colored =
    !data.isPending &&
    !data.isContainer &&
    !!data.colorTint &&
    !!data.colorAccent;
  const catStyle = colored
    ? {
        // Category now reads as a soft tint fill inside a thin full-accent
        // outline, not a chunky dark left bar (the old borderLeftWidth: 4
        // read as heavy and ugly). Same colour information, calmer edge.
        backgroundColor: data.colorTint,
        borderColor: data.colorAccent,
      }
    : !data.isPending && !data.isContainer
      ? {
          // Real block that falls outside every group in the active
          // scheme (e.g. a freshly created one before the next structure
          // regen). Give it a soft neutral tint so it reads as
          // "uncategorized", not broken-white.
          backgroundColor: "#F0ECE4",
          borderColor: "#D2CABB",
        }
      : undefined;
  return (
    <div
      className={`block-node-grow group/block relative rounded-[5px] border bg-white px-3 py-2 transition-all ${borderColor} ${ring} ${dim}`}
      style={{ width: NODE_W, minHeight: NODE_H, ...catStyle }}
    >
      {/* Small corner mark on a block promoted out of a detail view, so
       *  back on the overview it reads as a lifted detail rather than a
       *  top-level module. Same glyph the tracker uses for "promoted",
       *  keeping one visual vocabulary for the concept. */}
      {data.promotedDetail && (
        <span
          title="Promoted from block details"
          className="absolute right-1.5 top-1.5 text-[#8A8276]"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x={4.5} y={3.5} width={15} height={8} rx={2.5} />
            <circle cx={12} cy={19} r={2.6} />
            <path d="M12 16 V13" />
          </svg>
        </span>
      )}
      {/* Per-block action affordance ("⋯") — appears at top-right on
       *  block hover, opens the cards overlay so the user can pick a
       *  Claude-proposed change scoped to this block. Stops click +
       *  mousedown propagation so React Flow doesn't treat it as a
       *  node drag / selection. */}
      {data.onActions && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            data.onActions?.();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          title="Block actions"
          className="absolute -right-2 -top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-[#D4D4D4] bg-white text-[#666666] opacity-0 shadow-sm transition-opacity hover:bg-[#F5F5F4] hover:text-[#78716C] group-hover/block:opacity-100"
        >
          <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      )}
      {/* Drag grip (top-left) to pull this block into the chat as
       *  context. HTML5 draggable + `nodrag` so React Flow does not start
       *  a node-move; the chat panel's drop zone reads the payload. Only
       *  visible on hover, so it does not affect the global layout. */}
      <div
        {...dragSourceProps(
          blockContextItem({
            label: data.label,
            caption: data.caption,
            files: data.files,
            capabilities: data.capabilities,
            category: data.category,
          }),
        )}
        // Stop a stray tap on the grip from toggling the block's bubbles.
        onClick={(e) => e.stopPropagation()}
        title="Drag into chat as context"
        className="nodrag nopan absolute -left-2.5 -top-2.5 z-10 flex h-6 w-6 cursor-grab items-center justify-center rounded-full border border-[#E2E0DC] bg-white/95 text-[#A8A29E] opacity-0 shadow-sm backdrop-blur-sm transition-all hover:scale-105 hover:text-[#78716C] active:cursor-grabbing group-hover/block:opacity-100"
      >
        <Grip className="h-3 w-3" strokeWidth={2} />
      </div>
      {/* Four connection handles, one per side. All declared as
       *  type="source" — combined with ConnectionMode.Loose on the
       *  parent ReactFlow, each handle can act as either source or
       *  target of a user-drawn connection. Programmatic edges from
       *  layoutSchema set sourceHandle="b" / targetHandle="t" so
       *  auto-laid arrows still flow top-to-bottom under the dagre TB
       *  layout. The visible dot is small at rest; on block hover all
       *  four sides grow + tint so users can see the affordance. */}
      <Handle
        id="t"
        type="source"
        position={Position.Top}
        className="!h-3 !w-3 !-translate-y-1/2 !border-2 !border-white !bg-[#999999] opacity-0 transition-all group-hover/block:!h-4 group-hover/block:!w-4 group-hover/block:!bg-[#78716C] group-hover/block:opacity-100"
      />
      <Handle
        id="r"
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !translate-x-1/2 !border-2 !border-white !bg-[#999999] opacity-0 transition-all group-hover/block:!h-4 group-hover/block:!w-4 group-hover/block:!bg-[#78716C] group-hover/block:opacity-100"
      />
      <Handle
        id="l"
        type="source"
        position={Position.Left}
        className="!h-3 !w-3 !-translate-x-1/2 !border-2 !border-white !bg-[#999999] opacity-0 transition-all group-hover/block:!h-4 group-hover/block:!w-4 group-hover/block:!bg-[#78716C] group-hover/block:opacity-100"
      />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={commit}
          // Don't let React Flow grab the click and trigger selection.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="w-full rounded border border-[#78716C]/40 bg-white px-1.5 py-0.5 text-sm font-semibold leading-tight text-[#222222] outline-none focus:border-[#78716C]"
        />
      ) : (
        <div
          // break-words: labels sometimes carry an unbreakable token (a
          // file path pasted from the user's prompt), which otherwise
          // escapes the fixed-width card.
          className="break-words text-sm font-semibold leading-tight text-[#222222] cursor-text"
          title={data.onLabelChange ? "Double-click to rename" : undefined}
          onDoubleClick={(e) => {
            if (!data.onLabelChange) return;
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {data.label}
        </div>
      )}
      {data.caption && (
        <div
          className={`mt-1 break-words text-[11px] leading-snug text-[#666666] ${
            data.isExpanded ? "" : "line-clamp-2"
          }`}
        >
          {data.caption}
        </div>
      )}
      {(fileCount > 0 || drillCount > 0) && (
        <div
          className="mt-1.5 text-[10px] uppercase tracking-wide text-[#999999]"
          // Hover-tooltip lists actual file names + the capabilities (or,
          // for older schemas, the functions). The in-block expanded lists
          // were dropped: they crowded the node and were hard to read at
          // this scale; the hover gives the same info on demand.
          title={[
            fileCount > 0 ? `Files:\n${data.files.join("\n")}` : "",
            capCount > 0
              ? `Features:\n${(data.capabilities ?? []).join("\n")}`
              : fnCount > 0
                ? `Functions:\n${data.functions.slice(0, 12).join(", ")}${
                    fnCount > 12 ? ` (+${fnCount - 12} more)` : ""
                  }`
                : "",
          ]
            .filter(Boolean)
            .join("\n\n")}
        >
          {drillCount > 0 && (
            <>
              {drillCount}{" "}
              {capCount > 0
                ? drillCount === 1
                  ? "feature"
                  : "features"
                : drillCount === 1
                  ? "fn"
                  : "fns"}
            </>
          )}
        </div>
      )}
      <Handle
        id="b"
        type="source"
        position={Position.Bottom}
        className="!h-3 !w-3 !translate-y-1/2 !border-2 !border-white !bg-[#999999] opacity-0 transition-all group-hover/block:!h-4 group-hover/block:!w-4 group-hover/block:!bg-[#78716C] group-hover/block:opacity-100"
      />
    </div>
  );
}

import { FunctionBubble } from "./FunctionBubble";
import { BubbleSector } from "./BubbleSector";

/**
 * Stable nodeType registry passed to ReactFlow. Module-level so the
 * object identity doesn't change between renders — React Flow warns
 * about "It looks like you've created a new nodeTypes" otherwise.
 */
export const nodeTypes = {
  block: BlockNode,
  bubble: FunctionBubble,
  bubbleSector: BubbleSector,
};
