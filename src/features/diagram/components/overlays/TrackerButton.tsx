import { forwardRef } from "react";
import { History } from "lucide-react";

/**
 * Top-right header pill that opens the interaction tracker. Shows a badge
 * with the number of tracked steps. Portaled into the diagram header slot
 * (like IntentChip) so it lives in the chrome, above both the canvas and
 * the focus panel.
 *
 * Forwards a ref to the button element so the tray can anchor itself as a
 * dropdown directly beneath this pill.
 */
export const TrackerButton = forwardRef<
  HTMLButtonElement,
  { count: number; open: boolean; onToggle: () => void }
>(function TrackerButton({ count, open, onToggle }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      title="Interaction tracker: what the agent changed on the diagram"
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${
        open
          ? "border-[#B0975A]/60 bg-[#F1E9D8] text-[#6E5B2E]"
          : "border-[#484848]/25 bg-white/80 text-[#484848] hover:bg-white"
      }`}
    >
      <History className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      Tracker
      {count > 0 && (
        <span className="ml-0.5 inline-flex min-w-[16px] items-center justify-center rounded-full bg-[#B0975A] px-1 text-[10px] font-semibold leading-none text-white">
          {count}
        </span>
      )}
    </button>
  );
});
