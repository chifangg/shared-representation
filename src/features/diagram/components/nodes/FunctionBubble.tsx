import { memo, type CSSProperties } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useChatContextDrag } from "@/core/chatContextDrag";
import type { BubbleNodeData } from "../../types";
import { BUBBLE_HALF_SIZE } from "../../layout/bubbleNodes";
import { capabilityContextItem } from "../../util/contextItem";

/**
 * One satellite in a block's drill-in fan: a round bubble surfacing a
 * single plain-language capability (e.g. "Render chat turns as HTML").
 *
 * Shape note: a circle is the intended look. To keep multi-word phrases
 * from wrapping to one or two words per line, the radius is generous and
 * the font small rather than reshaping the bubble. Diameter is fixed
 * (BUBBLE_HALF_SIZE * 2) so the fan geometry in `bubbleNodes` /
 * `bubbleLayout` stays a clean center-to-center spacing problem.
 *
 * Entry/exit animation uses CSS custom properties so each bubble can
 * tween FROM the parent block's center (the `--enter-dx, --enter-dy`
 * offset) to its own final position. See `.bubble-enter` / `.bubble-exit`
 * keyframes in styles.css.
 */
function FunctionBubbleImpl({ data }: NodeProps & { data: BubbleNodeData }) {
  const { dragSourceProps } = useChatContextDrag();
  const animStyle = {
    "--enter-dx": `${data.enterDx}px`,
    "--enter-dy": `${data.enterDy}px`,
    width: BUBBLE_HALF_SIZE * 2,
    height: BUBBLE_HALF_SIZE * 2,
  } as CSSProperties;
  return (
    <div
      {...dragSourceProps(
        capabilityContextItem(data.displayLabel, data.parentBlockLabel),
      )}
      className={`nodrag nopan relative flex cursor-grab items-center justify-center rounded-full border border-[#E8DDC4] bg-[#F5EFE0] text-center shadow-sm transition-colors hover:border-[#C9B58E] hover:bg-[#EFE5D0] active:cursor-grabbing ${
        data.isExiting ? "bubble-exit" : "bubble-enter"
      }`}
      style={animStyle}
      title={`${data.label}  (drag into chat as context)`}
    >
      {/* Reading-order badge: the fan reads as a sequence (1..N) in the
       *  same order the capabilities were generated, matching the
       *  diagram's top-down flow. Sits just outside the top-left rim so
       *  it annotates the bubble without covering its label. */}
      <span
        title={`Step ${data.order} of ${data.total}`}
        className="absolute -left-1 -top-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[#B0975A] text-[10.5px] font-semibold text-white shadow-[0_1px_2px_rgba(51,50,47,0.3)]"
      >
        {data.order}
      </span>
      <span className="line-clamp-4 break-words px-2 text-[10px] font-medium leading-[1.2] text-[#5C5040]">
        {data.displayLabel}
      </span>
      <Handle
        type="target"
        position={Position.Left}
        style={{ opacity: 0, pointerEvents: "none" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ opacity: 0, pointerEvents: "none" }}
      />
    </div>
  );
}

export const FunctionBubble = memo(FunctionBubbleImpl);
