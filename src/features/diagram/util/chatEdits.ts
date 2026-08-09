import type { ClaudeMessage } from "@/core/hooks/useClaudeSession";

/**
 * Walk the most recent assistant turn for the files it edited.
 *
 * Subtlety that bit us: tool calls come back as `user`-typed
 * `tool_result` messages interleaved between the assistant's tool_use
 * messages. A naive "stop at the first user message" walk therefore
 * breaks at the LAST tool_result (just before Claude's closing summary)
 * and sees none of the edits. We must skip tool_result messages and
 * stop only at the real human prompt (string content, or an array with
 * no tool_result block).
 */

type AnyMsg = { type?: string; message?: { content?: unknown } };

/**
 * A GENUINE user turn (typed prompt or executed visual edit), NOT a
 * tool-result round-trip. The stream-json protocol delivers tool results
 * as `role: "user"` messages too, so callers that count "user turns" must
 * exclude them: a real prompt has string content, or an array with no
 * `tool_result` block; a tool result carries `tool_result` blocks.
 */
export function isUserPrompt(m: ClaudeMessage): boolean {
  const mm = m as AnyMsg;
  if (mm.type !== "user") return false;
  const c = mm.message?.content;
  if (typeof c === "string") return true;
  if (Array.isArray(c)) {
    return !c.some((b) => (b as { type?: string })?.type === "tool_result");
  }
  return true;
}

/**
 * Tool names arrive MCP-qualified in Claude's stream: the backend serves the
 * client tools through its bridge, so `write_project_file` reaches us as
 * `mcp__template-tools__write_project_file` (see backend/src/core/tools.rs,
 * MCP_SERVER_NAME). Matching the bare name exactly therefore never hit, which
 * silently emptied the edited-file set: new blocks got handed no files, so
 * their capability refresh had nothing to read and they opened with no
 * bubbles. Compare on the trailing segment so both spellings match, and so a
 * rename of the MCP server cannot break this again.
 */
const EDIT_TOOLS = new Set(["edit_project_file", "write_project_file"]);
function isEditTool(name: string | undefined): boolean {
  if (!name) return false;
  const bare = bareToolName(name);
  return EDIT_TOOLS.has(bare);
}

/** Tools that TOUCH a specific file, edit or read alike. The live
 *  "working here" pulse uses this wider set: while a turn runs, the
 *  agent spends most of it reading the files around a hook point before
 *  it writes, so tracking reads too makes the pulse move across the
 *  diagram in real time instead of flashing once at the final write. */
const FILE_TOOLS = new Set([
  "edit_project_file",
  "write_project_file",
  "read_project_file",
]);
function isFileTool(name: string | undefined): boolean {
  if (!name) return false;
  return FILE_TOOLS.has(bareToolName(name));
}

function bareToolName(name: string): string {
  return name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
}

/**
 * Edited/written file paths in the latest assistant turn, plus its text
 * chunks (oldest first) for the edit-summary toast. Walks back to the
 * last human prompt, skipping interleaved tool_result messages.
 */
export function editedFilesInLatestTurn(messages: ClaudeMessage[]): {
  files: string[];
  textChunks: string[];
} {
  const files = new Set<string>();
  const textChunks: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserPrompt(messages[i])) break;
    const m = messages[i] as AnyMsg;
    if (m.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Array<{
      type?: string;
      name?: string;
      input?: { path?: string };
      text?: string;
    }>) {
      if (
        b?.type === "tool_use" &&
        isEditTool(b.name) &&
        typeof b.input?.path === "string"
      ) {
        files.add(b.input.path);
      } else if (b?.type === "text" && typeof b.text === "string") {
        textChunks.unshift(b.text);
      }
    }
  }
  return { files: Array.from(files), textChunks };
}

/**
 * File paths TOUCHED (read or edited) in the latest assistant turn, for
 * the live "the agent is working here" pulse. Same walk as
 * `editedFilesInLatestTurn` but the wider FILE_TOOLS set, so a block
 * lights up while the agent is reading its file, not only at the moment
 * it writes. Kept separate from `editedFilesInLatestTurn`, which must
 * stay edit-only: reads must not trigger the post-turn regen or count as
 * changes.
 */
export function touchedFilesInLatestTurn(messages: ClaudeMessage[]): string[] {
  const files = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserPrompt(messages[i])) break;
    const m = messages[i] as AnyMsg;
    if (m.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Array<{
      type?: string;
      name?: string;
      input?: { path?: string };
    }>) {
      if (
        b?.type === "tool_use" &&
        isFileTool(b.name) &&
        typeof b.input?.path === "string"
      ) {
        files.add(b.input.path);
      }
    }
  }
  return Array.from(files);
}
