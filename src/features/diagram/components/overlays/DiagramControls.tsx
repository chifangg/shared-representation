import type { DiagramView } from "../../types";

/**
 * Bottom-right focus-mode switch: toggles the diagram between the project
 * overview and adaptive focus. Styled as an iOS-style labeled toggle (white
 * pill, hairline border, soft shadow). The add-block button lives separately,
 * above the color legend at bottom-left; the top-left is reserved for the
 * interaction tracker.
 */
export function DiagramControls({
  view,
  onViewChange,
}: {
  view: DiagramView;
  onViewChange: (v: DiagramView) => void;
}) {
  const focusOn = view === "focus";
  return (
    <div className="absolute bottom-4 right-4 z-40">
      <button
        type="button"
        onClick={() => onViewChange(focusOn ? "overview" : "focus")}
        title={
          focusOn ? "Switch to project overview" : "Switch to adaptive focus"
        }
        aria-pressed={focusOn}
        className="flex items-center gap-2.5 rounded-full border border-[#78716C]/20 bg-white/95 py-2 pl-3.5 pr-3 shadow-lg backdrop-blur-[2px] transition-colors hover:bg-white"
      >
        <span className="text-[12px] font-medium tracking-tight text-[#484848]">
          Focus mode
        </span>
        <span
          className="relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors duration-200"
          style={{ background: focusOn ? "#B0975A" : "#D8D4CD" }}
        >
          <span
            className="h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform duration-200"
            style={{ transform: focusOn ? "translateX(16px)" : "translateX(2px)" }}
          />
        </span>
      </button>
    </div>
  );
}
