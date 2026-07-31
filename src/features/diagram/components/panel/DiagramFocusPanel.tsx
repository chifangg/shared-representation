import { useCallback } from "react";
import { Loader2, X } from "lucide-react";
import { ReactFlowProvider } from "@xyflow/react";
import type { DiagramArrow, DiagramBlock } from "../../types";
import { PANEL_MAX, PANEL_MIN } from "../../layout/constants";
import { FocusMiniGraph } from "./FocusMiniGraph";

/**
 * Right-side panel that slides in during adaptive-focus mode. Shows
 * what the diagram is currently focusing on (focused base block
 * labels) plus a mini-graph of detail blocks that drill into those
 * focused regions.
 *
 * Resizable via a drag handle on the left edge (clamped to PANEL_MIN
 * / PANEL_MAX from layout/constants). The mini-graph is rendered
 * inside its own ReactFlowProvider so its useReactFlow() doesn't
 * conflict with the main canvas's provider.
 */
export function DiagramFocusPanel({
  baseBlocks,
  focused,
  streaming,
  emptyRound,
  promotedIds,
  width,
  onWidthChange,
  onClose,
  onPromote,
  onUnpromote,
}: {
  baseBlocks: DiagramBlock[];
  focused: {
    ids: string[];
    blocks: DiagramBlock[];
    arrows: DiagramArrow[];
  };
  /** True while the focus round is still streaming detail blocks. Drives
   *  the loading state and the live "generating · N so far" count so the
   *  user can tell whether the round has finished. */
  streaming: boolean;
  /** A round completed with nothing to show (or errored). Distinguishes the
   *  "nothing related" state from the never-asked welcome. */
  emptyRound: boolean;
  promotedIds: Set<string>;
  width: number;
  onWidthChange: (w: number) => void;
  onClose: () => void;
  onPromote: (b: DiagramBlock) => void;
  onUnpromote: (b: DiagramBlock) => void;
}) {
  const focusedLabels = focused.ids
    .map((id) => baseBlocks.find((b) => b.id === id)?.label)
    .filter((x): x is string => Boolean(x));
  const detailCount = focused.blocks.length;
  // Show the loading spinner only before the FIRST detail block; once any
  // card exists, show the mini-graph and let the count carry the progress.
  const loading = streaming && detailCount === 0;
  // Nothing on screen and not loading. Two flavors:
  //  - welcome: the user hasn't asked yet, so we invite them to.
  //  - noResults: a round ran but grew nothing (or errored), so we say so
  //    instead of pretending they never asked.
  const nothing = !streaming && detailCount === 0 && focused.ids.length === 0;
  const noResults = nothing && emptyRound;
  const welcome = nothing && !emptyRound;

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      // Coalesce to ONE state update per animation frame. Pointer devices
      // fire far faster than the display refreshes, and each update re-renders
      // the panel (whose mini-graph relays out), so committing every raw event
      // queues more work than the frame can drain and the drag falls behind.
      let raf = 0;
      let pending = startW;
      const onMove = (ev: MouseEvent) => {
        const dx = startX - ev.clientX; // dragging left grows panel
        pending = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + dx));
        if (raf) return;
        raf = window.requestAnimationFrame(() => {
          raf = 0;
          onWidthChange(pending);
        });
      };
      const onUp = () => {
        if (raf) {
          window.cancelAnimationFrame(raf);
          raf = 0;
        }
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        onWidthChange(pending); // commit the final position
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width, onWidthChange],
  );

  return (
    <aside
      className="panel-slide-in relative flex h-full shrink-0 flex-col border-l border-[#E0E0E0] bg-white shadow-[-6px_0_18px_rgba(0,0,0,0.04)]"
      style={{ width }}
    >
      {/* Drag handle on the left edge — wider invisible hit-area, thin
          visible bar that lights up on hover. */}
      <div
        onMouseDown={onResizeStart}
        className="group absolute left-0 top-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize"
        aria-label="Resize focus panel"
        role="separator"
      >
        <div className="mx-auto h-full w-px bg-[#E8E8E8] transition-colors group-hover:bg-[#78716C]/40" />
      </div>

      <header className="flex items-start justify-between gap-2 border-b border-[#E8E8E8] px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[#999999]">
            {welcome || noResults ? "Adaptive focus" : "Focusing"}
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold text-[#222222]">
            {welcome
              ? "Ready when you are"
              : noResults
                ? "Nothing related this time"
                : focusedLabels.length > 0
                  ? focusedLabels.join(", ")
                  : "…"}
          </div>
          {streaming ? (
            <div className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-[#B0975A]">
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
              <span>
                Growing the related details
                {detailCount > 0 ? ` · ${detailCount} so far` : "…"}
              </span>
            </div>
          ) : (
            detailCount > 0 && (
              <div className="mt-1 text-[11px] text-[#999999]">
                {detailCount} {detailCount === 1 ? "detail" : "details"} · click{" "}
                <span className="font-medium text-[#78716C]">+</span> to add
              </div>
            )
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close focus panel"
          className="rounded-md p-1 text-[#999999] transition-colors hover:bg-[#F4F4F4] hover:text-[#484848]"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      </header>

      <div className="relative flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Loader2
              className="h-6 w-6 animate-spin text-[#B0975A]"
              strokeWidth={2}
            />
            <div className="text-[13px] font-medium text-[#484848]">
              Finding the related details…
            </div>
            <div className="text-[11px] text-[#999999]">
              Reading the conversation to grow sub-pieces beside the focused
              blocks.
            </div>
          </div>
        ) : welcome ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#F5F1EA] text-[#B0975A]">
              <MagicWandIcon className="h-6 w-6" />
            </div>
            <div className="text-[13px] font-medium text-[#484848]">
              Start prompting or editing
            </div>
            <div className="text-[11px] leading-relaxed text-[#999999]">
              Ask a question in the chat, or edit the diagram, and the pieces
              of your project related to what you are working on will grow
              here.
            </div>
          </div>
        ) : noResults ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <div className="text-[13px] font-medium text-[#484848]">
              Nothing related to show
            </div>
            <div className="text-[11px] leading-relaxed text-[#999999]">
              That turn didn't map onto a part of the diagram. Try another
              question or edit, and related pieces will grow here.
            </div>
          </div>
        ) : (
          <ReactFlowProvider>
            <FocusMiniGraph
              focused={focused}
              baseBlocks={baseBlocks}
              promotedIds={promotedIds}
              onPromote={onPromote}
              onUnpromote={onUnpromote}
            />
          </ReactFlowProvider>
        )}
      </div>
    </aside>
  );
}

/**
 * A small filled magic-wand-with-sparkles glyph for the welcome state. Inline
 * (not lucide) so it reads solid/playful; painted via `currentColor` so the
 * wrapper's text color drives it.
 */
function MagicWandIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M15.5 2.5 L16.85 5.64 L20.26 5.96 L17.69 8.21 L18.44 11.55 L15.5 9.8 L12.56 11.55 L13.31 8.21 L10.74 5.96 L14.15 5.64 Z"
        fill="currentColor"
      />
      <path
        d="M5.5 1.8 L6.25 3.25 L7.7 4 L6.25 4.75 L5.5 6.2 L4.75 4.75 L3.3 4 L4.75 3.25 Z"
        fill="currentColor"
      />
      <path
        d="M19.8 13.6 L20.45 14.85 L21.7 15.5 L20.45 16.15 L19.8 17.4 L19.15 16.15 L17.9 15.5 L19.15 14.85 Z"
        fill="currentColor"
      />
      <path
        d="M3.2 20.8 L11.8 12.2"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
