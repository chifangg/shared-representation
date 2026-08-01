import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type {
  ConnectionOption,
  DiagramBlock,
  EditTarget,
} from "../../types";
import { OptionCardButton } from "./OptionCardButton";

/**
 * Floating panel pinned to the bottom-center of the diagram canvas
 * once Claude has proposed options for a freshly-pulled arrow. The
 * user picks one (block_level / detail / no change) or types a free-
 * form description into the "Others" card; both paths feed back into
 * `onPick(option)` so the parent can fire the round-2 execute prompt.
 *
 * Floating overlay over the canvas (not anchored at the arrow midpoint)
 * — keeps clear of overlapping blocks and stays predictable while the
 * marching-ants arrow visually links it to the diagram.
 */
export function ConnectionOptionsOverlay({
  target,
  options,
  blocks,
  onPick,
  onCancel,
}: {
  target: EditTarget;
  options: ConnectionOption[];
  blocks: DiagramBlock[];
  onPick: (option: ConnectionOption) => void;
  onCancel: () => void;
}) {
  const [otherText, setOtherText] = useState("");
  const [othersExpanded, setOthersExpanded] = useState(false);

  const submitOthers = () => {
    const trimmed = otherText.trim();
    if (trimmed.length === 0) return;
    // We don't know the kind yet — let Claude decide what fits.
    // Default to "detail" so any pending arrow gets removed; if Claude
    // actually adds a block-level link, the auto-regen after Claude's
    // turn will surface it again.
    onPick({
      title: trimmed,
      detail: "User-described change.",
      kind: "detail",
      custom: true,
    });
  };

  // Build the contextual header based on target kind.
  let headerEyebrow: string;
  let headerLine: ReactNode;
  if (target.kind === "arrow") {
    const fromBlock = blocks.find((b) => b.id === target.from);
    const toBlock = blocks.find((b) => b.id === target.to);
    headerEyebrow = "Pick a change";
    headerLine = (
      <>
        for connection{" "}
        <span className="font-semibold">
          {fromBlock?.label ?? target.from}
        </span>{" "}
        →{" "}
        <span className="font-semibold">{toBlock?.label ?? target.to}</span>
      </>
    );
  } else if (target.kind === "block") {
    const block = blocks.find((b) => b.id === target.id);
    headerEyebrow = "Pick a change";
    headerLine = (
      <>
        for <span className="font-semibold">{block?.label ?? target.id}</span>
      </>
    );
  } else {
    headerEyebrow = "Pick a new block";
    headerLine = <>to add to the project</>;
  }

  return (
    <div
      className="gate-backdrop pointer-events-auto absolute inset-0 z-[60] flex items-center justify-center bg-[#2A2622]/25 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        // Clicking the backdrop cancels (only when the click landed
        // on the backdrop itself, not inside the panel).
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      {/* Same frosted-glass material and entrance as the intent gate, so
       *  the two beats of one flow (gate, then cards) read as one surface. */}
      <div
        className="gate-card glass-card w-[min(760px,calc(100%-48px))] rounded-2xl p-5"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-[#B0A99E]">
              {headerEyebrow}
            </div>
            <div className="mt-1 text-[16px] font-semibold leading-snug text-[#2A2622]">
              {headerLine}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            title="Cancel"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#A8A29E] transition-colors hover:bg-[#F0EDE7] hover:text-[#57534E]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {options.map((opt, i) => (
          <OptionCardButton key={i} option={opt} onClick={() => onPick(opt)} />
        ))}
        {/* "Others" card: expand to text input, submit free-form intent. */}
        <div
          className={`flex flex-col items-start gap-2 rounded-xl border border-dashed border-[#D8D2C8] bg-white/60 p-3.5 transition-colors ${
            othersExpanded
              ? ""
              : "cursor-pointer hover:border-[#C9B58E] hover:bg-[#F7F5F1]"
          }`}
          onClick={() => {
            if (!othersExpanded) setOthersExpanded(true);
          }}
        >
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-tight"
            style={{ backgroundColor: "#F1F0ED", color: "#8C8780" }}
          >
            Custom
          </span>
          <div className="text-[14px] font-semibold leading-snug text-[#2A2622]">
            Something else…
          </div>
          {othersExpanded ? (
            <>
              <input
                autoFocus
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitOthers();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setOthersExpanded(false);
                    setOtherText("");
                  }
                }}
                placeholder="Describe what you want Claude to do for this arrow"
                className="w-full rounded-lg border border-[#E2DCD0] bg-white px-2.5 py-1.5 text-[12px] text-[#2A2622] outline-none focus:border-[#C9B58E]"
              />
              <div className="flex w-full items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setOthersExpanded(false);
                    setOtherText("");
                  }}
                  className="rounded-lg px-2.5 py-1 text-[11px] text-[#857F75] hover:bg-[#F0EDE7]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitOthers}
                  disabled={otherText.trim().length === 0}
                  className="rounded-lg bg-[#78716C] px-3 py-1 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-[#57534E] disabled:cursor-not-allowed disabled:bg-[#CFC8BC]"
                >
                  Send
                </button>
              </div>
            </>
          ) : (
            <div className="text-[12px] leading-snug text-[#857F75]">
              Describe a custom change in your own words.
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
