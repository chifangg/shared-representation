import { useEffect, useRef, type RefObject } from "react";
import { Loader2, Search, X } from "lucide-react";

/**
 * The search box in the diagram header.
 *
 * Two ways in, one box: click the field, or hit Cmd+K anywhere in the
 * diagram (the shortcut is bound in useDiagramSearch). Search is diagram
 * only by design, so this lives in the diagram's header chrome rather
 * than anywhere in the app shell.
 *
 * Collapsed it is a slim affordance with the shortcut hint; focused it
 * widens. Enter runs the semantic pass; typing alone already drives the
 * instant lexical pass, so the field is never a dead end while the user
 * decides whether to commit to a round trip.
 *
 * Deliberately NOT disabled while the agent is streaming. That is the
 * moment people search, and the whole architecture (stateless endpoint,
 * schema only, no shared state) exists to make it safe then.
 */
export function DiagramSearchBox({
  open,
  query,
  loading,
  inputRef,
  onOpen,
  onQueryChange,
  onSubmit,
  onClose,
}: {
  open: boolean;
  query: string;
  loading: boolean;
  /** So the tray can anchor under the field, and Cmd+K can focus it. */
  inputRef: RefObject<HTMLInputElement>;
  onOpen: () => void;
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
      className="flex h-7 w-[22rem] items-center gap-1.5 rounded-md border border-[#B9B7B1] bg-white px-2 shadow-[0_1px_2px_rgba(51,50,47,0.08)]"
    >
      {loading ? (
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-[#2F7A6F]"
          strokeWidth={2}
        />
      ) : (
        <Search className="h-3.5 w-3.5 shrink-0 text-[#8A8880]" strokeWidth={2} />
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
        placeholder="What do you want to understand?"
        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[#33322F] outline-none placeholder:text-[#A9A69E]"
      />
      {/* Enter-to-search hint. Typing already shows instant name matches,
       *  but the full answer + ordered reading path only comes on Enter,
       *  and a pilot never pressed it without being told. The hint brightens
       *  to teal once there is a query worth submitting. */}
      {!loading && (
        <span
          title="Press Enter for a full answer and a reading path"
          className={`flex shrink-0 items-center gap-1 whitespace-nowrap text-[10.5px] font-medium ${
            query.trim() ? "text-[#2F7A6F]" : "text-[#A9A69E]"
          }`}
        >
          <kbd
            className={`rounded border px-1 font-sans text-[10px] ${
              query.trim()
                ? "border-[#9CC6BE] bg-[#E7F2EF] text-[#2F7A6F]"
                : "border-[#D9D7D2] bg-[#F4F3F1] text-[#A9A69E]"
            }`}
          >
            ↵
          </kbd>
          more
        </span>
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
