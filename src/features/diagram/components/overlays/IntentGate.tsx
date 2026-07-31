import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  PencilLine,
  Plus,
  Sparkles,
  SquarePen,
  X,
  type LucideIcon,
} from "lucide-react";
import type { DiagramBlock, EditTarget } from "../../types";

/**
 * Pre-suggestions gate: pops the moment a user action lands on the
 * canvas (arrow drop, block action, "+" add-module). Two paths:
 *
 *   - "Describe yourself" expands into a text input. Submitting jumps
 *     straight to round-2 execute (skips the suggestions round-trip,
 *     fastest path for users who already know what they want).
 *   - "Ask Claude for suggestions" dispatches round-1; cards land in
 *     the cards overlay when Claude responds.
 *
 * Backdrop click cancels (and removes any pending placeholder via the
 * parent's removeTargetVisual). Centered modal so it doesn't fight
 * with overlapping blocks like the older arrow-midpoint popover did.
 * The backdrop and card animate in on mount (see .gate-* in styles.css).
 */
export function IntentGate({
  target,
  blocks,
  onAskSuggestions,
  onDescribe,
  onCancel,
}: {
  target: EditTarget;
  blocks: DiagramBlock[];
  onAskSuggestions: () => void;
  onDescribe: (text: string) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"choose" | "describe">("choose");
  const [text, setText] = useState("");

  let eyebrow: string;
  let line: ReactNode;
  let HeaderIcon: LucideIcon;
  if (target.kind === "arrow") {
    const from = blocks.find((b) => b.id === target.from);
    const to = blocks.find((b) => b.id === target.to);
    eyebrow = "New connection";
    HeaderIcon = ArrowRight;
    line = (
      <>
        <span className="font-semibold">{from?.label ?? target.from}</span>
        {" to "}
        <span className="font-semibold">{to?.label ?? target.to}</span>
      </>
    );
  } else if (target.kind === "block") {
    const b = blocks.find((bk) => bk.id === target.id);
    eyebrow = "Modify";
    HeaderIcon = SquarePen;
    line = (
      <>
        <span className="font-semibold">{b?.label ?? target.id}</span>
      </>
    );
  } else {
    eyebrow = "New block";
    HeaderIcon = Plus;
    line = <>Add something to the project</>;
  }

  return (
    <div
      className="gate-backdrop pointer-events-auto absolute inset-0 z-[60] flex items-center justify-center bg-[#2A2622]/25 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="gate-card glass-card w-[min(480px,calc(100%-48px))] rounded-2xl p-5"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            {/* Leading slot: the kind icon while choosing; in describe mode it
             *  becomes the Back control, so return sits top-left where it reads
             *  (the "+" is meaningless once you are already describing). */}
            {mode === "describe" ? (
              <button
                type="button"
                onClick={() => {
                  setMode("choose");
                  setText("");
                }}
                title="Back"
                aria-label="Back"
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#78716C] transition-colors hover:bg-black/[0.06]"
              >
                <ArrowLeft className="h-4 w-4" strokeWidth={2} />
              </button>
            ) : (
              // Plain icon, deliberately NO background chip: the two option
              // cards below already lead with circled icons, and a circled
              // pencil up here read as a third, confusingly similar option.
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center text-[#8A7B5C]">
                <HeaderIcon className="h-[18px] w-[18px]" strokeWidth={2} />
              </span>
            )}
            <div>
              <div className="text-[10.5px] font-medium uppercase tracking-wider text-[#A8A29E]">
                {eyebrow}
              </div>
              <div className="mt-0.5 text-[14px] text-[#2A2622]">{line}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            title="Cancel"
            aria-label="Cancel"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#A3A29D] transition-colors hover:bg-black/[0.05] hover:text-[#57534E]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {mode === "choose" ? (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {/* Describe path: the calm, neutral default. */}
            <button
              type="button"
              onClick={() => setMode("describe")}
              className="group flex flex-col gap-2 rounded-xl border border-white/70 bg-white/75 px-3.5 py-3.5 text-left transition-colors hover:border-[#D8CEBE] hover:bg-[#F8F5EF]"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#EFEAE2] text-[#8A7B5C] transition-transform group-hover:scale-105">
                <PencilLine className="h-4 w-4" strokeWidth={2} />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-[#2A2622]">
                  Describe it yourself
                </span>
                <span className="text-xs leading-snug text-[#8A8276]">
                  You already know what you want. Type it.
                </span>
              </span>
            </button>
            {/* Ask-Claude path: a small gold spark marks the assisted route. */}
            <button
              type="button"
              onClick={onAskSuggestions}
              className="group flex flex-col gap-2 rounded-xl border border-white/70 bg-white/75 px-3.5 py-3.5 text-left transition-colors hover:border-[#E0D3AE] hover:bg-[#FAF6EC]"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#F3ECD9] text-[#B08A3E] transition-transform group-hover:scale-105">
                <Sparkles className="h-4 w-4" strokeWidth={2} />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-[#2A2622]">
                  Ask Claude for suggestions
                </span>
                <span className="text-xs leading-snug text-[#8A8276]">
                  Get a few options to pick from.
                </span>
              </span>
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onDescribe(text);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setMode("choose");
                  setText("");
                }
              }}
              placeholder="What do you want done?"
              rows={3}
              className="w-full resize-none rounded-xl border border-white/70 bg-white/80 px-3 py-2.5 text-[13px] leading-snug text-[#2A2622] outline-none transition-colors placeholder:text-[#B5AFA4] focus:border-[#C9B58E]"
            />
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={() => onDescribe(text)}
                disabled={text.trim().length === 0}
                className="flex items-center gap-1.5 rounded-lg bg-[#2A2622] px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#403A33] disabled:cursor-not-allowed disabled:bg-[#CFC8BC]"
              >
                Send
                <CornerDownLeft className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
