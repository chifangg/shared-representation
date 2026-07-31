import type { ConnectionOption } from "../../types";

/**
 * Single card inside ConnectionOptionsOverlay: a soft kind pill, the
 * option title, and a one-line detail. The kind reads as a quiet tinted
 * pill (no monospace / uppercase / dotted label), so the picker looks
 * designed rather than auto-generated.
 */
const KIND_META: Record<
  ConnectionOption["kind"],
  { label: string; accent: string; tint: string }
> = {
  block_level: { label: "New link", accent: "#6E7F55", tint: "#EDF1E6" },
  detail: { label: "Detail", accent: "#A56C2E", tint: "#F6ECDD" },
  none: { label: "No change", accent: "#8C8780", tint: "#F1F0ED" },
};

export function OptionCardButton({
  option,
  onClick,
}: {
  option: ConnectionOption;
  onClick: () => void;
}) {
  const meta = KIND_META[option.kind] ?? KIND_META.detail;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start gap-2 rounded-xl border border-white/70 bg-white/80 p-3.5 text-left transition-all duration-150 hover:-translate-y-px hover:border-[#C9B58E] hover:bg-white hover:shadow-[0_4px_14px_rgba(120,113,108,0.12)]"
    >
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-tight"
        style={{ backgroundColor: meta.tint, color: meta.accent }}
      >
        {meta.label}
      </span>
      <div className="text-[14px] font-semibold leading-snug text-[#2A2622]">
        {option.title}
      </div>
      {option.detail && (
        <div className="text-[12px] leading-snug text-[#857F75]">
          {option.detail}
        </div>
      )}
    </button>
  );
}
