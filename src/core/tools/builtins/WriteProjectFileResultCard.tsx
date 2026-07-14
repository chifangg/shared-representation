import { useEffect } from "react";
import { FilePen, FileX, FilePlus } from "lucide-react";
import type { ToolResultProps } from "@/core/tools/registry";
import type { DiffLine } from "./WriteProjectFile";
import { logEvent } from "@/core/interactionLog";

type Result =
  | {
      ok: true;
      path: string;
      size: number;
      created: boolean;
      previous_size: number | null;
      added: number;
      removed: number;
      diff: DiffLine[];
    }
  | { ok: false; path: string; error: string };

/**
 * Tool-result bubble for `write_project_file`. Renders a unified-style
 * diff (green +, red -, grey context) so the chat shows exactly what
 * changed — mirroring how Claude Code surfaces its Edit tool results.
 */
export function WriteProjectFileResultCard({
  content,
}: ToolResultProps<Result>) {
  const unparseable = !content || typeof content !== "object";
  // Non-JSON results are transient bridge/CLI hiccups (persisted-output
  // rewrite, stale session after a backend restart) that Claude recovers
  // from by retrying; rendering them only alarms participants. Log
  // silently for diagnosis and show nothing.
  useEffect(() => {
    if (unparseable) {
      logEvent(
        "tool-result-unparseable",
        { card: "write_project_file" },
        "system",
      );
    }
  }, [unparseable]);
  if (unparseable) return null;

  if (!content.ok) {
    // A failed edit (e.g. old_string did not match) is something the model
    // recovers from on the next attempt, so keep it quiet and collapsed
    // like a thinking line instead of a loud card that clutters the chat.
    return (
      <details className="self-start text-[11.5px] text-[#A89E8E]">
        <summary className="cursor-pointer select-none font-mono hover:text-[#8A8175]">
          <span className="inline-flex items-center gap-1.5">
            <FileX className="h-3 w-3 shrink-0" strokeWidth={2} />
            {content.path}
            <span className="text-[#B3A998]">· retrying</span>
          </span>
        </summary>
        <div className="mt-1 max-w-full whitespace-pre-wrap rounded-md border border-[#EAE3D6] bg-[#FBF7EF] p-2 font-mono text-[11px] leading-relaxed text-[#857F75]">
          {content.error}
        </div>
      </details>
    );
  }

  const Icon = content.created ? FilePlus : FilePen;
  const verb = content.created ? "Created" : "Edited";

  // Cool-toned "code material" card, recessed into the warm chat surface
  // so a code change reads as a different kind of thing than speech.
  return (
    <div
      className="overflow-hidden rounded-[9px] bg-[#FBFAFC] text-xs"
      style={{
        boxShadow:
          "inset 0 2px 5px rgba(70,80,100,0.13), inset 0 0 0 1px rgba(70,80,100,0.10)",
      }}
    >
      <header className="flex items-center gap-2 border-b border-[#E6E8EC] bg-[#F2F3F6] px-3 py-1.5">
        <Icon className="h-3 w-3 text-[#7A818C]" strokeWidth={2} />
        <span className="font-medium text-[#5C6470]">{verb}</span>
        <span className="font-mono text-[#3C424C]">{content.path}</span>
        <span className="ml-auto flex items-center gap-1.5 tabular-nums">
          {content.added > 0 && (
            <span className="text-emerald-700">+{content.added}</span>
          )}
          {content.removed > 0 && (
            <span className="text-red-600">-{content.removed}</span>
          )}
          {content.added === 0 && content.removed === 0 && (
            <span className="text-[#99A0AB]">no changes</span>
          )}
        </span>
      </header>
      {content.diff.length > 0 && (
        <div className="max-h-72 overflow-auto bg-white font-mono text-[11px] leading-snug">
          {/* w-max sizes to the widest line; min-w-full keeps it at least
              the card width, so each row's highlight spans the full
              horizontal scroll width, not just the viewport. */}
          <div className="w-max min-w-full">
          {content.diff.map((line, i) => {
            if (line.type === "gap") {
              return (
                <div
                  key={i}
                  className="w-full select-none border-y border-[#F0F0F0] bg-[#FAFAFA] px-3 py-0.5 text-center text-[10px] text-[#999999]"
                >
                  ⋮
                </div>
              );
            }
            const marker =
              line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
            const cls =
              line.type === "add"
                ? "bg-emerald-50 text-emerald-900"
                : line.type === "remove"
                  ? "bg-red-50 text-red-900"
                  : "text-[#444444]";
            return (
              <div
                key={i}
                className={`flex w-full whitespace-pre px-3 ${cls}`}
              >
                <span className="mr-2 inline-block w-3 select-none text-[#999999]">
                  {marker}
                </span>
                <span>{line.text || " "}</span>
              </div>
            );
          })}
          </div>
        </div>
      )}
    </div>
  );
}
