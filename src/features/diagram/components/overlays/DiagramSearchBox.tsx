import { useEffect, useRef, type RefObject } from "react";
import { Loader2, Search, Sparkles, Type, X } from "lucide-react";
import type { SearchMode } from "../../hooks/useDiagramSearch";

/**
 * The search box in the diagram header.
 *
 * Two ways in, one box: click the field, or hit Cmd+K anywhere in the
 * diagram (the shortcut is bound in useDiagramSearch). Search is diagram
 * only by design, so this lives in the diagram's header chrome rather
 * than anywhere in the app shell.
 *
 * Collapsed it is a slim affordance with the shortcut hint; focused it
 * widens and leads with the mode toggle.
 *
 * The toggle is the first control in the field because it decides what
 * the rest of it means: in "Name" the results are live and free, in
 * "Agent" nothing happens until Enter and it costs a model call. These
 * used to be one escalating flow, and the free half quietly satisfied
 * people so they never reached the half worth having.
 *
 * Deliberately NOT disabled while the agent is streaming. That is the
 * moment people search, and the whole architecture (stateless endpoint,
 * schema only, no shared state) exists to make it safe then.
 */
const MODES: {
  value: SearchMode;
  label: string;
  title: string;
  icon: typeof Type;
}[] = [
  {
    value: "name",
    label: "Name",
    title: "Match block names and summaries as you type. Instant, no model call.",
    icon: Type,
  },
  {
    value: "agent",
    label: "Agent",
    title: "Ask an agent for an answer and a reading path. Runs on Enter.",
    icon: Sparkles,
  },
];

export function DiagramSearchBox({
  open,
  mode,
  query,
  loading,
  inputRef,
  onOpen,
  onModeChange,
  onQueryChange,
  onSubmit,
  onClose,
}: {
  open: boolean;
  mode: SearchMode;
  query: string;
  loading: boolean;
  /** So the tray can anchor under the field, and Cmd+K can focus it. */
  inputRef: RefObject<HTMLInputElement>;
  onOpen: () => void;
  onModeChange: (mode: SearchMode) => void;
  onQueryChange: (q: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  // Focus on open (including the Cmd+K path, which flips `open` from afar).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, inputRef]);

  const wrapRef = useRef<HTMLDivElement>(null);

  if (!open) {
    // Accent-tinted, not grey: a pilot missed the search entirely when it
    // read as chrome. The teal ties it to the search results' own accent.
    return (
      <button
        type="button"
        onClick={onOpen}
        title="Search the diagram (⌘K)"
        className="flex h-7 items-center gap-1.5 rounded-md border border-[#9CC6BE] bg-[#E2F0ED] px-2.5 text-[11.5px] font-medium text-[#256B60] transition-colors hover:bg-[#D3E8E3] hover:text-[#1C574E]"
      >
        <Search className="h-3.5 w-3.5" strokeWidth={2.2} />
        <span>Search the diagram</span>
        <kbd className="ml-0.5 rounded border border-[#A9CDC6] bg-[#F0F7F5] px-1 font-sans text-[9.5px] text-[#4E877D]">
          ⌘K
        </kbd>
      </button>
    );
  }

  return (
    <div
      ref={wrapRef}
      // 24rem, up from 22: the mode toggle eats ~117px of the row, and at
      // the old width the agent placeholder truncated on open, which is the
      // worst place to lose words. The intent chip yields the header while
      // this is open (see DiagramCanvas), so the extra width is free.
      className="flex h-7 w-[24rem] items-center gap-1.5 rounded-md border border-[#B9B7B1] bg-white px-2 shadow-[0_1px_2px_rgba(51,50,47,0.08)]"
    >
      {/* Mode first, because it changes what everything to its right does.
       *  A two-segment control rather than a single flip: with one button
       *  there is no way to see which mode you are in without reading the
       *  icon and guessing whether it shows the current state or the one
       *  you would switch to. */}
      <div
        role="radiogroup"
        aria-label="Search mode"
        className="flex shrink-0 items-center gap-0.5 rounded bg-[#F2F1EF] p-0.5"
      >
        {MODES.map((m) => {
          const active = mode === m.value;
          return (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={active}
              // Never steal focus from the input: switching modes mid-typing
              // has to leave the caret where it was.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onModeChange(m.value)}
              title={m.title}
              className={`flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-medium transition-colors ${
                active
                  ? "bg-white text-[#2F7A6F] shadow-[0_1px_2px_rgba(51,50,47,0.12)]"
                  : "text-[#8A8880] hover:text-[#33322F]"
              }`}
            >
              <m.icon className="h-3 w-3 shrink-0" strokeWidth={2.2} />
              {m.label}
            </button>
          );
        })}
      </div>
      {loading && (
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-[#2F7A6F]"
          strokeWidth={2}
        />
      )}
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
          // Don't let canvas-level shortcuts fire while typing.
          e.stopPropagation();
        }}
        // Shorter than the old "What do you want to understand?": the Agent
        // segment sitting to the left already frames the question, and the
        // long version no longer fits beside the toggle.
        placeholder={
          mode === "agent" ? "Ask about the diagram" : "Find a block by name"
        }
        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[#33322F] outline-none placeholder:text-[#A9A69E]"
      />
      {/* The submit affordance, in the field rather than in the tray.
       *
       *  Agent mode only: name matching is live on every keystroke, so
       *  there is nothing to submit there and a key-cap would promise an
       *  action that does nothing. It teaches the shortcut where the
       *  typing happens, and it is a real button, so anyone who does not
       *  take the hint can still get the answer by clicking.
       *
       *  Only once there is something to submit; an empty field would be
       *  offering a search that `run` refuses anyway. */}
      {mode === "agent" && query.trim().length > 0 && !loading && (
        <button
          type="button"
          // Keep focus in the input: a click that blurred the field would
          // move focus to this button, which is exactly what stops the
          // input's own Escape handler from working (see useDiagramSearch).
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSubmit}
          title="Search the diagram (Enter)"
          aria-label="Search the diagram"
          className="shrink-0 rounded border border-[#C9C8C3] bg-[#F2F1EF] px-1 font-sans text-[9.5px] leading-4 text-[#8A8880] transition-colors hover:border-[#2F7A6F] hover:bg-[#E6F0EE] hover:text-[#2F7A6F]"
        >
          ⏎
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        title="Close search (Esc)"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#8A8880] transition-colors hover:bg-black/[0.06] hover:text-[#33322F]"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
