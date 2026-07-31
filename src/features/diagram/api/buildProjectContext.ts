/**
 * Serialize the uploaded project as a single XML-tagged string suitable
 * for the `/api/diagram` request body. The diagram backend uses this to
 * brief Claude about the project shape when generating the structure
 * stream (view=structure) and the focus delta (view=focus).
 *
 * Truncation caps are tuned for the diagram backend's streaming-NDJSON
 * response time — feeding it the entire project body unbounded blows
 * out per-request latency without improving the structure pass. Per
 * file 16 KB, total 80 KB. Files past the total cap appear in the tree
 * but their body is replaced with an "[omitted, total context cap
 * reached]" placeholder so the model still sees the path.
 *
 * This was previously in src/core/project.tsx; moved here because the
 * diagram is the only caller and the caps are diagram-specific. Pure
 * function with no React, no runtime side effects.
 */

import type { FileEntry } from "@/core/project";

const PER_FILE_CAP = 16 * 1024;
const TOTAL_CAP = 80 * 1024;

export function buildProjectContext(
  files: FileEntry[],
  goal: string | null,
): string {
  const tree = files
    .map((f) => f.path)
    .sort()
    .join("\n");

  let totalSoFar = 0;
  const fileBlocks = files
    .map((f) => {
      if (f.content.includes("\0")) {
        return `<file path="${f.path}">\n[binary file, ${f.size} bytes]\n</file>`;
      }

      if (totalSoFar >= TOTAL_CAP) {
        return `<file path="${f.path}">\n[${f.size} bytes — omitted, total context cap reached]\n</file>`;
      }

      let body = f.content;
      let truncatedNote = "";
      if (body.length > PER_FILE_CAP) {
        body = body.slice(0, PER_FILE_CAP);
        truncatedNote = `\n... [truncated, full file is ${f.size} bytes]`;
      }
      totalSoFar += body.length;
      return `<file path="${f.path}">\n${body}${truncatedNote}\n</file>`;
    })
    .join("\n\n");

  const goalBlock = goal
    ? `\n\n<user_goal>\n${goal}\n</user_goal>`
    : "";

  return `<project_context>\n<tree>\n${tree}\n</tree>\n\n${fileBlocks}${goalBlock}\n</project_context>`;
}

/**
 * Summary-doc filenames, in priority order, trusted enough to REPLACE
 * reading the codebase. Only CLAUDE.md and AGENTS.md qualify: both are
 * written specifically to orient an AI to the project's architecture, so
 * if one exists it is reliably high signal.
 *
 * README is deliberately NOT here. READMEs vary wildly (many are just
 * install/run instructions with little architecture), so trusting one as
 * a code replacement would degrade the capability scan on projects whose
 * file names are generic. Projects without a CLAUDE.md / AGENTS.md fall
 * back to reading the actual code, exactly as before.
 */
const SUMMARY_DOC_NAMES = ["claude.md", "agents.md"];

/** A doc shorter than this is treated as a stub and we fall back to
 *  reading the project. */
const MIN_SUMMARY_DOC_CHARS = 200;

/** Cap on the summary doc itself, so a huge README can't blow the budget. */
const SUMMARY_DOC_CAP = 24 * 1024;

export function findSummaryDoc(files: FileEntry[]): FileEntry | null {
  for (const name of SUMMARY_DOC_NAMES) {
    const matches = files.filter(
      (f) =>
        f.path.toLowerCase().split("/").pop() === name &&
        !f.content.includes("\0") &&
        f.content.trim().length >= MIN_SUMMARY_DOC_CHARS,
    );
    if (matches.length) {
      // Prefer the shallowest (root-level) doc when several match.
      matches.sort(
        (a, b) => a.path.split("/").length - b.path.split("/").length,
      );
      return matches[0];
    }
  }
  return null;
}

/**
 * Lighter context for the onboarding capability scan.
 *
 * The scan only needs a high-level capability list (label + caption +
 * icon, NO provenance), so it does not need the whole codebase. If the
 * upload ships a trusted architecture doc (CLAUDE.md / AGENTS.md), feed
 * THAT plus the file tree instead of every file body: the doc is already
 * the architecture summary the scan is trying to derive, so this is far
 * cheaper on tokens and faster on large projects.
 *
 * Falls back to the full project context when no such doc exists (README
 * does not count, see SUMMARY_DOC_NAMES), so projects without a trusted
 * summary still work exactly as before.
 */
export function buildScanContext(files: FileEntry[]): string {
  const doc = findSummaryDoc(files);
  if (!doc) return buildProjectContext(files, null);

  const tree = files
    .map((f) => f.path)
    .sort()
    .join("\n");
  let body = doc.content;
  if (body.length > SUMMARY_DOC_CAP) {
    body = `${body.slice(0, SUMMARY_DOC_CAP)}\n... [truncated, full doc is ${doc.size} bytes]`;
  }
  return `<project_context>\n<tree>\n${tree}\n</tree>\n\n<project_summary path="${doc.path}">\n${body}\n</project_summary>\n</project_context>`;
}
