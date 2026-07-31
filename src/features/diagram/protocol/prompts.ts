/**
 * Prompt composition for the chat ↔ diagram visual-edit protocol.
 *
 * Pure functions, no React, no runtime side effects. The dispatch
 * sites in the diagram hook assemble the final user-message prompt
 * by composing these fragments and emitting a single string.
 *
 * Two layers live here:
 *  - Round-2 trailing fragments (`buildArrowJsonSuffix`,
 *    `buildFileTreeBlock`) — tell Claude what to emit at the END of
 *    its execute response.
 *  - Full-prompt composers (`composeSuggestionsRound1Prompt`,
 *    `composeExecuteDirectPrompt`, `composeExecuteOptionPrompt`,
 *    `composeRenamePrompt`) — produce the full
 *    `<<diagram-edit summary="...">>`-prefixed body of the
 *    visual-edit event payload.
 */

import type {
  ConnectionOption,
  DiagramBlock,
  DiagramSchema,
  EditTarget,
} from "../types";
import type { FileEntry } from "@/core/project";
import {
  VISUAL_EDIT_SENTINEL_PREFIX,
  VISUAL_EDIT_SENTINEL_SUFFIX,
  buildTargetSentinel,
} from "./sentinels";

// ---------------------------------------------------------------------------
// Target-context helper used by every composer
// ---------------------------------------------------------------------------

/**
 * Build the "this is what the target looks like" lines used in both
 * round-1 (suggestions) and round-2 (execute) prompts. Centralized
 * so arrow / block / new-block all describe their context the same
 * way and we don't duplicate the if-block-else-arrow-else-new-block
 * branching twice.
 */
export function buildTargetContextLines(
  target: EditTarget,
  schema: DiagramSchema,
): string[] {
  const block = (id: string) => schema.blocks.find((b) => b.id === id);
  const line = (
    label: string,
    files: string[],
    fns: string[],
    caption: string,
  ): string[] => [
    `${label}:`,
    `- Caption: ${caption}`,
    files.length > 0
      ? `- Files: ${files.join(", ")}`
      : "- Files: (none recorded)",
    fns.length > 0
      ? `- Functions: ${fns.join(", ")}`
      : "- Functions: (none recorded)",
  ];
  if (target.kind === "arrow") {
    const from = block(target.from);
    const to = block(target.to);
    if (!from || !to) return [];
    return [
      ...line(
        `Source block ("${from.label}")`,
        from.provenance?.files ?? [],
        from.provenance?.functions ?? [],
        from.caption,
      ),
      "",
      ...line(
        `Target block ("${to.label}")`,
        to.provenance?.files ?? [],
        to.provenance?.functions ?? [],
        to.caption,
      ),
    ];
  }
  if (target.kind === "block") {
    const b = block(target.id);
    if (!b) return [];
    return line(
      `Block ("${b.label}")`,
      b.provenance?.files ?? [],
      b.provenance?.functions ?? [],
      b.caption,
    );
  }
  // new-block: no specific block context, just give project shape.
  const labels = schema.blocks
    .filter((b) => !b.pending)
    .map((b) => b.label)
    .join(", ");
  return [`Existing blocks on the diagram: ${labels || "(none)"}.`];
}

// ---------------------------------------------------------------------------
// Round-2 trailing fragments
// ---------------------------------------------------------------------------

/**
 * Trailing instruction appended to round-2 execute prompts. Asks
 * Claude to emit ONE more fenced JSON code block AFTER its text
 * summary, listing arrows that should now be drawn between blocks
 * (because the code change actually introduced a dependency). Diagram
 * side parses + draws those arrows with a glow animation so the user
 * sees how the new module hooks into the rest of the system without
 * a full regen.
 *
 * `newBlockLabel` is the label of any just-created block (the option
 * title); empty for non-new-block flows.
 */
export function buildArrowJsonSuffix(
  newBlockLabel: string,
  existingBlockLabels: string[] = [],
): string[] {
  const labelsLine =
    existingBlockLabels.length > 0
      ? `Existing block labels (use these EXACTLY, including capitalization): ${existingBlockLabels.map((l) => `"${l}"`).join(", ")}.`
      : "";
  return [
    "",
    `MANDATORY: end your response with a fenced JSON code block listing arrows that should now appear on the diagram. This is how the canvas learns about new dependencies your edit just created. Format:`,
    "",
    "```json",
    `{`,
    `  "added_arrows": [`,
    `    { "from": "<source block label>", "to": "<target block label>", "label": "<short verb>" }`,
    `  ]`,
    `}`,
    "```",
    "",
    `Example — if you added \`import { foo } from '../canvas/server'\` in App.tsx:`,
    "```json",
    `{ "added_arrows": [ { "from": "Frontend App", "to": "Canvas Server", "label": "imports" } ] }`,
    "```",
    "",
    labelsLine,
    newBlockLabel
      ? `Plus your new block appears on the diagram with the label "${newBlockLabel}" — use that exact string in "from" or "to".`
      : "",
    "",
    `If your edit truly created no new block-to-block dependency, still emit the block with an empty list: \`{ "added_arrows": [] }\`. Never skip the block.`,
  ].filter((l) => l !== "" || true); // keep blank lines for readability
}

/**
 * Compact file-tree block injected into round-2 execute prompts so
 * Claude doesn't invent plausible-but-wrong paths (e.g. "src/types/..."
 * when the project root is "mcp_excalidraw/"). The system prompt
 * already lists every path, but by round-2 enough tokens have flowed
 * past that the model often forgets and guesses — the inline
 * reminder right next to the read/edit instruction fixes that.
 *
 * Capped at ~80 paths to keep prompt size sane; for larger uploads we
 * surface the count + the first 80 sorted paths. Even huge repos
 * usually have their top-level shape captured in the first dozen.
 */
export function buildFileTreeBlock(paths: string[]): string[] {
  const MAX = 80;
  const sorted = [...paths].sort();
  const shown = sorted.slice(0, MAX);
  const lines = [
    "",
    `<project_files count="${paths.length}">`,
    ...shown,
    paths.length > MAX
      ? `... (${paths.length - MAX} more files — read_project_file with one of the listed paths)`
      : "",
    "</project_files>",
    `Every \`read_project_file\` / \`edit_project_file\` / \`write_project_file\` path MUST be one of the entries above, character-for-character. Do NOT invent paths like "src/..." if no such prefix appears in the tree — the project root may be nested (e.g. "mcp_excalidraw/src/...").`,
  ];
  return lines.filter((l) => l !== "");
}

// ---------------------------------------------------------------------------
// Full-prompt composers
// ---------------------------------------------------------------------------

/**
 * Round-1 suggestions prompt: ask Claude to list ≤5 options as JSON
 * for the user to pick from. No code changes in this round.
 */
export function composeSuggestionsRound1Prompt(
  target: EditTarget,
  schema: DiagramSchema,
): string {
  const ctx = buildTargetContextLines(target, schema);
  let intro: string;
  let kindGuide: string[];
  if (target.kind === "arrow") {
    intro = `User drew a new arrow on the diagram and wants suggestions for what it should mean.`;
    kindGuide = [
      `\`kind\` guide:`,
      `- "block_level": real new cross-block dependency (import / fetch / subscription). Provide a short \`label\` (e.g. "imports", "fetches").`,
      `- "detail": small inline change in one block; no new arrow needed.`,
      `- "none": already connected / no change required.`,
    ];
  } else if (target.kind === "block") {
    intro = `User clicked the "actions" affordance on a block and wants suggestions for what to do with it.`;
    kindGuide = [
      `\`kind\` guide: use "detail" for actual code changes, "none" for "no change needed". Don't use "block_level" here.`,
    ];
  } else {
    intro = `User wants to ADD A NEW MODULE to the project and wants suggestions for what to scaffold.`;
    kindGuide = [`\`kind\` guide: use "detail" for all options here.`];
  }
  const summary =
    target.kind === "arrow"
      ? `Suggestions for this connection`
      : target.kind === "block"
        ? `Suggestions to modify`
        : `Suggestions for a new block`;
  return [
    `${VISUAL_EDIT_SENTINEL_PREFIX}${summary}${VISUAL_EDIT_SENTINEL_SUFFIX}`,
    buildTargetSentinel(target),
    "",
    `[Diagram edit, round 1 of 2] ${intro}`,
    "",
    ...ctx,
    "",
    `DO NOT CHANGE ANY CODE. Propose 3–5 concrete options. Be terse — \`title\` ≤8 words, \`detail\` ≤1 sentence (~15 words). No fluff.`,
    "",
    `Return ONLY a single fenced JSON code block:`,
    "```json",
    `{`,
    `  "options": [`,
    `    { "title": "...", "detail": "...", "kind": "block_level|detail|none", "label": "..." }`,
    `  ]`,
    `}`,
    "```",
    "",
    ...kindGuide,
    "",
    `Output ONLY the JSON, no surrounding prose.`,
  ].join("\n");
}

/**
 * Round-2 execute prompt for the "Describe yourself" path — the user
 * skips suggestions and types intent directly. Claude must decide
 * whether the description is concrete enough to act on; if vague,
 * fall back to options-shape JSON.
 */
export function composeExecuteDirectPrompt(
  target: EditTarget,
  schema: DiagramSchema,
  files: FileEntry[],
  userText: string,
  synthOptionTitle: string,
): string {
  const ctx = buildTargetContextLines(target, schema);
  const trimmed = userText.trim();
  let intro: string;
  if (target.kind === "arrow") {
    intro = `User drew a new arrow on the diagram and described what they want it to mean.`;
  } else if (target.kind === "block") {
    intro = `User clicked a block's "actions" affordance and described what they want done.`;
  } else {
    intro = `User wants to add a new module and described what it should be.`;
  }
  const summary = `User-described: ${synthOptionTitle}`;
  return [
    `${VISUAL_EDIT_SENTINEL_PREFIX}${summary}${VISUAL_EDIT_SENTINEL_SUFFIX}`,
    buildTargetSentinel(target),
    "",
    `[Diagram edit] ${intro}`,
    "",
    `User's description:`,
    `"${trimmed}"`,
    "",
    ...ctx,
    "",
    `FIRST decide whether this description is concrete enough to act on.`,
    "",
    `If the description is concrete (a specific change you can implement in 1–3 file edits with high confidence):`,
    `→ Realize it in code. Use \`read_project_file\` to confirm the relevant files, then \`edit_project_file\` (or \`write_project_file\` for new files). Keep edits minimal. Briefly summarize in 1–2 sentences.`,
    ...buildFileTreeBlock(files.map((f) => f.path)),
    ...buildArrowJsonSuffix(
      target.kind === "new-block" ? synthOptionTitle : "",
      schema.blocks.filter((b) => !b.pending).map((b) => b.label),
    ),
    "",
    `If the description is VAGUE or OPEN-ENDED (e.g. "add features", "make this better", "improve performance", "refactor", "clean up", "add tests" with no specifics, etc.):`,
    `→ DO NOT touch code. Instead respond with ONLY a JSON options block (same shape as round-1 suggestions), proposing 3–5 concrete interpretations the user might have meant. The user will then pick one:`,
    "",
    "```json",
    `{ "options": [ { "title": "...", "detail": "...", "kind": "block_level|detail|none", "label": "..." } ] }`,
    "```",
    "",
    `Be honest about vagueness — if you're guessing at intent, fall back to options. The cost of executing the wrong thing is high; the cost of asking one extra round is low.`,
  ].join("\n");
}

/**
 * Round-2 execute prompt after the user picks one of the cards from a
 * suggestions round. The picked option's kind drives the body shape.
 */
export function composeExecuteOptionPrompt(
  target: EditTarget,
  schema: DiagramSchema,
  files: FileEntry[],
  option: ConnectionOption,
): string {
  const summary = `Executing: ${option.title}`;
  const promptLines: string[] = [
    `${VISUAL_EDIT_SENTINEL_PREFIX}${summary}${VISUAL_EDIT_SENTINEL_SUFFIX}`,
    buildTargetSentinel(target),
    "",
    `[Diagram edit, round 2 of 2] User picked this option:`,
    "",
    `Title: ${option.title}`,
    `Detail: ${option.detail}`,
    `Kind: ${option.kind}`,
  ];
  // Readable target label(s) so the chat transcript can show which block /
  // connection this edit was about. Round-1 includes it via the target
  // context block; round-2's compact body did not, so the chip was missing
  // on "Executing:" cards. parseVisualEditMessage keys on this exact phrasing.
  if (target.kind === "block") {
    const label = schema.blocks.find((b) => b.id === target.id)?.label;
    if (label) promptLines.push(`Block ("${label}")`);
  } else if (target.kind === "arrow") {
    const from = schema.blocks.find((b) => b.id === target.from)?.label;
    const to = schema.blocks.find((b) => b.id === target.to)?.label;
    if (from) promptLines.push(`Source block ("${from}")`);
    if (to) promptLines.push(`Target block ("${to}")`);
  } else {
    promptLines.push(`Block ("${option.title.slice(0, 40)}")`);
  }
  if (
    target.kind === "arrow" &&
    option.kind === "block_level" &&
    option.label
  ) {
    promptLines.push(
      `Arrow label (already shown on diagram): ${option.label}`,
    );
  }
  promptLines.push(
    "",
    option.kind === "none"
      ? `The user picked an option with kind="none" — confirm in 1 sentence why no code change is needed. Do NOT use edit_project_file.`
      : `Now realize this change in code. Use \`read_project_file\` to confirm the relevant files, then \`edit_project_file\` (or \`write_project_file\` if creating new files) to make the edit. Keep the change minimal and focused on what this option described. Briefly summarize in 1–2 sentences.`,
  );
  if (option.kind !== "none") {
    promptLines.push(...buildFileTreeBlock(files.map((f) => f.path)));
    const newBlockLabel =
      target.kind === "new-block" ? option.title.slice(0, 40) : "";
    const existingLabels = schema.blocks
      .filter((b) => !b.pending)
      .map((b) => b.label);
    promptLines.push(
      ...buildArrowJsonSuffix(newBlockLabel, existingLabels),
    );
  }
  return promptLines.join("\n");
}

/**
 * Slow-path rename prompt: the user double-clicked a block label and
 * committed a new name. Diagram's schema was already updated; now ask
 * Claude to rewrite the corresponding identifier in source.
 */
export function composeRenamePrompt(
  block: DiagramBlock,
  newLabel: string,
): string {
  const oldLabel = block.label;
  const files = block.provenance?.files ?? [];
  const fns = block.provenance?.functions ?? [];
  const summary = `Renamed block: ${oldLabel} → ${newLabel}`;
  return [
    `${VISUAL_EDIT_SENTINEL_PREFIX}${summary}${VISUAL_EDIT_SENTINEL_SUFFIX}`,
    "",
    `[Diagram edit] User renamed block "${oldLabel}" → "${newLabel}" in the project diagram.`,
    "",
    "Block context:",
    `- Caption: ${block.caption}`,
    files.length > 0
      ? `- Files: ${files.join(", ")}`
      : "- Files: (none recorded)",
    fns.length > 0
      ? `- Functions in this block: ${fns.join(", ")}`
      : "- Functions: (none recorded)",
    "",
    `Please rename the identifier(s) in those files that correspond to this block so they reflect the new name "${newLabel}". The block label is descriptive — translate it to the appropriate code form (e.g. a class declaration, module name, or related identifier; preserve the casing convention already used in the file). Use \`edit_project_file\` for each change.`,
    "",
    `If you can't confidently determine which identifier this block refers to, make your best guess and clearly summarize what you changed in 1–2 sentences so the user can verify or revert.`,
  ].join("\n");
}
