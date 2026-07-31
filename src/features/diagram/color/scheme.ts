/**
 * Color-encoding schemes for the diagram.
 *
 * A `ColorScheme` is a switchable answer to the question "what should a
 * block's color MEAN?". It partitions blocks into named groups and gives
 * each group a fill (`tint`) + edge (`accent`). The canvas resolves a
 * block's color through the active scheme (see DiagramCanvas), so the
 * node renderer + legend stay scheme-agnostic.
 *
 * Design (locked with the user):
 *  - The original 6-way Category taxonomy is kept as one built-in scheme,
 *    with its hand-tuned colors UNCHANGED (see util/blockCategory.ts).
 *  - Every OTHER scheme (the deterministic test scheme here, and the
 *    AI-generated ones in Phase 2) draws from a single fixed, hue-
 *    separated palette below. Same palette across schemes; only the
 *    grouping (and therefore the legend) differs. This guarantees any
 *    generated scheme is legible and never regresses to "colors too
 *    close to tell apart".
 */

import { BLOCK_CATEGORIES, CATEGORY_ORDER } from "../util/blockCategory";

/** A named color group within a scheme: the legend row + the swatch a
 *  block in this group wears. */
export type ColorGroup = {
  key: string;
  label: string;
  tint: string;
  accent: string;
  blurb?: string;
};

/** The minimal block info any scheme needs to decide a block's group.
 *  Built from either a DiagramBlock or a rendered node's data so the
 *  resolver works in both places. The built-in schemes group by
 *  category / fileCount; AI + custom schemes assign per-block by `id`. */
export type SchemeBlock = {
  id: string;
  label: string;
  category?: string;
  fileCount: number;
};

export type ColorScheme = {
  id: string;
  name: string;
  description?: string;
  source: "builtin" | "ai" | "custom";
  /** Ordered groups: drives the legend and palette lookup. */
  groups: ColorGroup[];
  /** Map a block to a group key, or null when it falls outside every
   *  group (rendered with the neutral uncategorized style). */
  assign: (block: SchemeBlock) => string | null;
};

/**
 * Fixed, hue-separated palette shared by every NON-category scheme. Tints
 * are light card fills; accents are the border + legend swatch. Hues are
 * pushed apart on purpose so adjacent groups never blur together. Order
 * is the assignment order for generated groups.
 */
export const SCHEME_PALETTE: { tint: string; accent: string }[] = [
  { tint: "#F6DFD6", accent: "#C66B52" }, // terracotta
  { tint: "#F4E7C8", accent: "#C0982E" }, // amber
  { tint: "#DFEAD0", accent: "#6E8A4E" }, // olive
  { tint: "#CFE6E1", accent: "#3F8C82" }, // teal
  { tint: "#D6E0F0", accent: "#5476A6" }, // slate blue
  { tint: "#E2DAF0", accent: "#7B5EA8" }, // violet
  { tint: "#F0D9E5", accent: "#B05483" }, // rose
  { tint: "#E5E1D8", accent: "#8A8276" }, // warm gray
];

/**
 * Build a scheme from a list of named groups, coloring them from the
 * fixed palette in order. Used by the deterministic test scheme below
 * and (Phase 2) by AI-generated schemes, so they share the same legible
 * palette and only differ in how blocks are grouped.
 */
export function colorSchemeFromGroups(args: {
  id: string;
  name: string;
  description?: string;
  source: ColorScheme["source"];
  groups: { key: string; label: string; blurb?: string }[];
  assign: (block: SchemeBlock) => string | null;
}): ColorScheme {
  const groups: ColorGroup[] = args.groups.map((g, i) => {
    const swatch = SCHEME_PALETTE[i % SCHEME_PALETTE.length];
    return { key: g.key, label: g.label, blurb: g.blurb, ...swatch };
  });
  return {
    id: args.id,
    name: args.name,
    description: args.description,
    source: args.source,
    groups,
    assign: args.assign,
  };
}

/** The payload the backend's `scheme` tool emits for the color_scheme
 *  view: a named grouping plus a per-block assignment. The model only
 *  decides the grouping; colors are filled here from SCHEME_PALETTE. */
export type AISchemePayload = {
  name: string;
  description?: string;
  groups: { key: string; label: string; blurb?: string }[];
  assignments: { block_id: string; group_key: string }[];
};

/** Slugify a scheme name into an id fragment (lowercase, alnum + dashes). */
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "scheme"
  );
}

/**
 * Build a runnable ColorScheme from a backend-generated payload. The
 * assignment is keyed by block id (the model assigns each block
 * explicitly), so the resolver looks the block's id up in a map rather
 * than re-deriving a rule. Colors come from the shared palette in group
 * order, exactly like the deterministic schemes, so a generated scheme is
 * always as legible as a built-in one.
 *
 * The id is namespaced + suffixed with a nonce so regenerating never
 * silently overwrites a previous scheme the user may still want.
 */
export function colorSchemeFromAI(
  payload: AISchemePayload,
  source: "ai" | "custom",
): ColorScheme {
  const assignMap = new Map(
    payload.assignments.map((a) => [a.block_id, a.group_key]),
  );
  const nonce = Date.now().toString(36).slice(-4);
  return colorSchemeFromGroups({
    id: `${source}_${slugify(payload.name)}_${nonce}`,
    name: payload.name,
    description: payload.description,
    source,
    groups: payload.groups.map((g) => ({
      key: g.key,
      label: g.label,
      blurb: g.blurb,
    })),
    assign: (b) => assignMap.get(b.id) ?? null,
  });
}

/** Built-in: the original Category taxonomy, colors untouched. */
export const CATEGORY_SCHEME: ColorScheme = {
  id: "category",
  name: "Category",
  description: "Role of each component in the architecture (the default).",
  source: "builtin",
  groups: CATEGORY_ORDER.map((c) => ({
    key: c,
    label: BLOCK_CATEGORIES[c].label,
    tint: BLOCK_CATEGORIES[c].tint,
    accent: BLOCK_CATEGORIES[c].accent,
    blurb: BLOCK_CATEGORIES[c].blurb,
  })),
  assign: (b) => b.category ?? null,
};

/**
 * Built-in (Phase 1 test fixture): color by how many files a block spans,
 * a rough proxy for where complexity concentrates. Exists mainly to
 * exercise the switch + legend-sync machinery before the AI-generated
 * schemes land in Phase 2; keep or drop then.
 */
export const COMPLEXITY_SCHEME: ColorScheme = colorSchemeFromGroups({
  id: "complexity",
  name: "Complexity (files)",
  description: "How many files a block spans, as a proxy for complexity.",
  source: "builtin",
  groups: [
    { key: "compact", label: "Compact (1 file)", blurb: "Spans a single file." },
    {
      key: "moderate",
      label: "Moderate (2-4)",
      blurb: "Spans a handful of files.",
    },
    { key: "large", label: "Large (5+)", blurb: "Spans many files." },
  ],
  assign: (b) => {
    if (b.fileCount <= 1) return "compact";
    if (b.fileCount <= 4) return "moderate";
    return "large";
  },
});

/** Schemes available at startup. AI/custom schemes get appended later. */
export const BUILTIN_SCHEMES: ColorScheme[] = [
  CATEGORY_SCHEME,
  COMPLEXITY_SCHEME,
];

/** Resolve a block's fill + accent under a scheme, or null when the block
 *  belongs to no group (caller falls back to the neutral card style). */
export function resolveBlockColor(
  scheme: ColorScheme,
  block: SchemeBlock,
): { tint: string; accent: string } | null {
  const key = scheme.assign(block);
  if (!key) return null;
  const group = scheme.groups.find((g) => g.key === key);
  return group ? { tint: group.tint, accent: group.accent } : null;
}

/**
 * resolveBlockColor plus NEIGHBOR INHERITANCE for blocks the scheme does
 * not know. Custom schemes freeze their per-block assignments at
 * generation time, so a block created or promoted afterwards resolves to
 * null and kept the old encoding's neutral look, sticking out of whatever
 * encoding the user had switched to. Such a block inherits the color of
 * its first scheme-known arrow neighbor instead (a promoted block reaches
 * its origin through the "detail" arrow). The category scheme is exempt:
 * there color IS the block's own category, and guessing it from a
 * neighbor would lie. Pure, so every call site (canvas nodes, lens
 * header) shares one behavior and it stays unit-testable.
 */
export function resolveBlockColorWithFallback(
  scheme: ColorScheme,
  block: SchemeBlock,
  arrows: ReadonlyArray<{ from: string; to: string }>,
  neighborById: (id: string) => SchemeBlock | undefined,
): { tint: string; accent: string } | null {
  const own = resolveBlockColor(scheme, block);
  if (own || scheme.id === "category") return own;
  for (const a of arrows) {
    const otherId =
      a.from === block.id ? a.to : a.to === block.id ? a.from : null;
    if (!otherId) continue;
    const other = neighborById(otherId);
    if (!other) continue;
    const inherited = resolveBlockColor(scheme, other);
    if (inherited) return inherited;
  }
  return null;
}

/** The scheme's groups that actually contain at least one block, in
 *  scheme order, so the legend lists only what is on screen. */
export function presentGroups(
  scheme: ColorScheme,
  blocks: SchemeBlock[],
): ColorGroup[] {
  const keys = new Set(
    blocks
      .map((b) => scheme.assign(b))
      .filter((k): k is string => k !== null),
  );
  return scheme.groups.filter((g) => keys.has(g.key));
}
