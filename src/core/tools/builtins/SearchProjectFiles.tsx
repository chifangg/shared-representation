import { useEffect, useRef } from "react";
import { Loader2, Search } from "lucide-react";
import type { ClientToolProps } from "@/core/tools/registry";
import { useProject } from "@/core/project";

interface SearchProjectFilesInput {
  pattern: string;
  case_sensitive?: boolean;
}

type SearchProjectFilesResult =
  | {
      ok: true;
      pattern: string;
      match_count: number;
      /** Matches as "path:line: text" rows, newline-joined. */
      matches: string;
      truncated: boolean;
    }
  | { ok: false; error: string };

/** Caps keep the tool_result small: the point is locating code, not
 *  transferring it. Reading the file is read_project_file's job. */
const MAX_MATCHES = 100;
const MAX_LINE_CHARS = 200;

/**
 * Client tool handler for `search_project_files`: regex over every
 * in-memory project file, line by line. Purely additive next to the
 * read/write/edit tools; exists so the agent can find a hook point
 * without ingesting whole 20-30KB files one at a time.
 */
export function SearchProjectFiles({
  input,
  resolve,
}: ClientToolProps<SearchProjectFilesInput, SearchProjectFilesResult>) {
  const { files } = useProject();
  const resolvedRef = useRef(false);

  useEffect(() => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;

    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.case_sensitive ? "" : "i");
    } catch (e) {
      resolve({
        ok: false,
        error: `invalid regular expression: ${String(e).slice(0, 160)}`,
      });
      return;
    }

    const rows: string[] = [];
    let total = 0;
    outer: for (const f of files) {
      if (f.content.includes("\0")) continue; // binary
      const lines = f.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        total++;
        if (rows.length < MAX_MATCHES) {
          rows.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, MAX_LINE_CHARS)}`);
        } else {
          // Keep counting total matches but stop collecting rows once
          // the cap is hit; bail entirely when counting stops informing.
          if (total > MAX_MATCHES * 10) break outer;
        }
      }
    }

    resolve({
      ok: true,
      pattern: input.pattern,
      match_count: total,
      matches: rows.join("\n"),
      truncated: total > rows.length,
    });
  }, [files, input.pattern, input.case_sensitive, resolve]);

  return (
    <div className="flex items-center gap-2 rounded-md border border-[#78716C]/20 bg-[#F5F5F4] px-3 py-1.5 text-xs text-[#78716C]">
      <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
      <Search className="h-3 w-3" strokeWidth={2} />
      <span className="truncate font-mono">{input.pattern}</span>
    </div>
  );
}
