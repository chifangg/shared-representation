import { useState, type KeyboardEvent, type ReactNode } from "react";

/** Tallest the input grows before it starts scrolling internally (px).
 *  About four lines; past that the textarea scrolls instead of pushing
 *  the transcript up (six felt like the input was taking over the panel). */
const MAX_INPUT_H = 104;

export function PromptInput({
  onSubmit,
  onCancel,
  disabled,
  running,
  attachments,
  placeholder,
}: {
  onSubmit: (prompt: string) => void;
  onCancel?: () => void;
  /** Override for the idle placeholder, used to say WHY input is gated
   *  (e.g. the diagram is still generating). */
  placeholder?: string;
  disabled?: boolean;
  running?: boolean;
  /** Optional row rendered above the textarea, inside the input box
   *  (e.g. attached context chips). */
  attachments?: ReactNode;
}) {
  const [value, setValue] = useState("");

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-[#C9C8C3] bg-[#DCDBD6] p-3">
      {attachments}
      <div className="flex items-end gap-2">
      <textarea
        className="chat-input flex-1 resize-none overflow-y-auto rounded-lg border border-[#D9D7D2] bg-white px-3 py-2 text-[14px] leading-snug text-[#2E2A25] placeholder:text-[#AEADA8] outline-none focus:border-[#C4C2BB] disabled:opacity-60"
        style={{ maxHeight: MAX_INPUT_H }}
        placeholder={running ? "Streaming…" : placeholder ?? "Message…"}
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
      />
      {running && onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-100"
        >
          Cancel
        </button>
      ) : (
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !value.trim()}
          className="rounded-lg border border-[#2E2A25] bg-[#2E2A25] px-4 py-2 text-xs font-medium text-[#EFE9DD] transition-colors hover:bg-[#46403A] disabled:opacity-40 disabled:hover:bg-[#2E2A25]"
        >
          Send
        </button>
      )}
      </div>
    </div>
  );
}
