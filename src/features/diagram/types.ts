/**
 * Type definitions for the diagram feature.
 *
 * Pure types only — no React imports, no runtime side effects. This
 * module is the leaf of the diagram feature's dependency graph, so it
 * can be imported from anywhere (chat-side bridge, layout engine,
 * prompt builders, components) without pulling in `@xyflow/react` or
 * `@dagrejs/dagre`. Keep it that way.
 *
 * The small `serializeTarget` helper and `DIAGRAM_VIEW_LABELS` const
 * live here because they're tightly bound to the type definitions
 * above them — moving them out would require importing a type just to
 * stringify it.
 */

// ---------------------------------------------------------------------------
// Diagram views
// ---------------------------------------------------------------------------

export type DiagramView = "overview" | "focus";

export const DIAGRAM_VIEW_LABELS: Record<DiagramView, string> = {
  overview: "Project overview",
  focus: "Adaptive focus",
};

// ---------------------------------------------------------------------------
// Diagram schema (the structure the canvas renders)
// ---------------------------------------------------------------------------

export type DiagramSchema = {
  blocks: DiagramBlock[];
  arrows: DiagramArrow[];
};

/** Closed taxonomy the model assigns each block. Drives the canvas
 *  color-coding + legend (see util/blockCategory.ts). Optional because
 *  older cached schemas / detail blocks may omit it. */
export type BlockCategory =
  | "interface"
  | "logic"
  | "data"
  | "state"
  | "integration"
  | "config";

export type DiagramBlock = {
  id: string;
  label: string;
  caption: string;
  parent: string | null;
  /** Model-assigned category for color-coding. May be absent on detail
   *  blocks or schemas generated before categories existed. */
  category?: BlockCategory;
  /** Short plain-language sub-capabilities the model decomposes the block
   *  into (terse verb phrases). These drive the drill-in bubbles. Absent
   *  on schemas generated before this field existed, in which case the
   *  bubbles fall back to provenance.functions. */
  capabilities?: string[];
  provenance: { files: string[]; functions: string[] };
  /** Local-only marker for blocks the user just asked to create. Renders
   *  with a dashed blue border + marching-ants so it's obvious "this
   *  hasn't been scaffolded yet". Cleared once the auto-regen after
   *  Claude finishes replaces the placeholder with a real block. */
  pending?: boolean;
  /** Frontend-only marker: this block was promoted out of another block's
   *  detail view. Renders a small corner mark so back on the overview the
   *  user can tell a lifted detail from a top-level module. */
  promotedDetail?: boolean;
};

export type DiagramArrow = {
  from: string;
  to: string;
  label: string;
  /** Two-stage marker for arrows the user just pulled via hover-drag:
   *  - "intent": popover is open; user is describing what the arrow
   *    should mean (or hasn't clicked anything yet). Edge renders with
   *    the inline popover + marching-ants dashed blue stroke.
   *  - "claude": popover dismissed (submit/skip); Claude is reacting.
   *    Edge renders marching-ants dashed blue, no popover.
   *  - undefined: settled, regular arrow.
   *  Pending arrows survive focus dimming so the user's edit doesn't
   *  fade out while Claude is processing. Server never sets this. */
  pending?: "intent" | "claude";
};

// ---------------------------------------------------------------------------
// Fetch lifecycle (used by useDiagramStructureFetch + DiagramFetchOverlay)
// ---------------------------------------------------------------------------

export type FetchState =
  | { kind: "idle" }
  | { kind: "loading"; startedAt: number }
  | { kind: "ready"; schema: DiagramSchema }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Capability scan + onboarding survey
// ---------------------------------------------------------------------------

/** Lightweight block-like payload emitted by /api/diagram view=capability_scan.
 *  Just enough to render as a picklist option in the survey — no arrows,
 *  no provenance, no parent. */
export type CapabilityCandidate = {
  id: string;
  label: string;
  caption: string;
  /** Icon keyword chosen by the scan; resolved to a lucide glyph in the UI. */
  icon: string;
};

export type CapabilityScanState =
  | { kind: "idle" }
  | { kind: "loading"; startedAt: number }
  | { kind: "ready"; candidates: CapabilityCandidate[] }
  | { kind: "error"; message: string };

export type IntentVerb = "understand" | "edit" | "reference" | "default";

/** Fired when the user clicks an arrow-label pill: open the connection
 *  lenses for that relationship, anchored at the click point. */
export type ConnectionLensDetail = {
  /** Source block id. */
  from: string;
  /** Target block id. */
  to: string;
  /** The arrow's verb label. */
  verb: string;
  /** Screen coords of the click, to anchor the overlay. */
  x: number;
  y: number;
  /** The edge's label anchor in FLOW coords. This, not the click point, is
   *  what the annotation's leader line is tied to: it puts the terminator dot
   *  on the verb pill itself and survives pan and zoom exactly, with no
   *  screen-to-flow conversion to drift. */
  fx: number;
  fy: number;
};

/** The structured onboarding answer. Retained (not just the composed goal
 *  string) so the canvas can show the user what they chose and let them
 *  revise it without re-answering from scratch. composeGoal turns this
 *  into the `<user_goal>` string fed to the backend. */
export type IntentSelection = {
  verb: IntentVerb;
  understandCaps: CapabilityCandidate[];
  understandText: string;
  capabilities: CapabilityCandidate[];
  capFreeText: string;
};

// ---------------------------------------------------------------------------
// Visual-edit targets and options (the chat ↔ diagram protocol payloads)
// ---------------------------------------------------------------------------

/**
 * What kind of diagram element this visual-edit round is targeting.
 * Three kinds share the same cards-and-execute pipeline:
 *   - arrow: user just pulled a new connection between two blocks
 *   - block: user clicked the "actions" affordance on an existing block
 *   - new-block: user asked to create a new module from blank canvas
 */
export type EditTarget =
  | { kind: "arrow"; from: string; to: string }
  | { kind: "block"; id: string }
  | { kind: "new-block" };

export function serializeTarget(t: EditTarget): string {
  switch (t.kind) {
    case "arrow":
      return `arrow:${t.from}->${t.to}`;
    case "block":
      return `block:${t.id}`;
    case "new-block":
      return `new-block`;
  }
}

export interface ConnectionOption {
  title: string;
  detail: string;
  kind: "block_level" | "detail" | "none";
  /** Arrow label to apply when kind="block_level". Only meaningful when
   *  target.kind === "arrow". Optional otherwise. */
  label?: string;
  /** True when the user typed this option themselves ("Something else").
   *  The interaction log must then record a length, never the title,
   *  which holds the user's own prompt text. */
  custom?: boolean;
}

// ---------------------------------------------------------------------------
// Event detail payloads (carried by the four chat ↔ diagram events)
// ---------------------------------------------------------------------------

export interface VisualEditDetail {
  /** Pre-formatted user-message prompt ChatView will send verbatim. */
  prompt: string;
  /** Short label for UI (e.g. "Renamed block"). Currently unused but
   *  reserved for future styling of visual-edit bubbles. */
  kind: string;
}

export interface OptionsReadyDetail {
  target: EditTarget;
  options: ConnectionOption[];
}

export interface OptionExecutedDetail {
  target: EditTarget;
  option: ConnectionOption;
}

/** The user closed the cards overlay without picking any option. */
export interface OptionsCancelledDetail {
  target: EditTarget;
}

export interface ArrowsAddedDetail {
  arrows: Array<{ from: string; to: string; label: string }>;
}

// ---------------------------------------------------------------------------
// React Flow node data shapes (consumed by BlockNode + MiniBlockNode)
// ---------------------------------------------------------------------------

export type BlockNodeData = {
  label: string;
  caption: string;
  files: string[];
  functions: string[];
  /** Plain-language sub-capabilities the drill-in bubbles surface. */
  capabilities?: string[];
  /** Model-assigned category for color-coding. Undefined falls back to
   *  the neutral card style. */
  category?: BlockCategory;
  /** Fill + accent resolved through the active color scheme. Computed in
   *  DiagramCanvas so the node renderer stays scheme-agnostic; absent
   *  means the block falls outside every group (neutral style). */
  colorTint?: string;
  colorAccent?: string;
  isContainer: boolean;
  isFocused: boolean;
  isDimmed: boolean;
  /** Mirrors DiagramBlock.promotedDetail for the corner mark. */
  promotedDetail?: boolean;
  /** 1-based position in a natural-language search's reading path. Set
   *  only while a search result is live; drives the step badge so the
   *  ordering exists on the canvas, not just in the results tray. */
  searchOrder?: number;
  /** User clicked this block to drill in: the description un-clamps to
   *  full length AND the feature bubbles fan out, in lockstep. Driven by
   *  expandedBlockId (the bubble-focus state), not React Flow's
   *  `selected` prop, so a re-click collapses both together. */
  isExpanded?: boolean;
  /** User-asked-for placeholder waiting for Claude to scaffold. Renders
   *  with marching-ants dashed blue border instead of normal frame. */
  isPending: boolean;
  /** Block didn't exist before the most recent auto-regen — i.e. Claude
   *  just created it. Renders a one-shot blue glow that fades after
   *  ~3.5s so the user can see WHAT got added during the regen. */
  isRecentlyAdded: boolean;
  /** Claude is editing a file this block owns RIGHT NOW (turn in flight).
   *  Renders a live blue pulse. Injected by attachInteractive from
   *  useEditingBlocks; absent on the pure layout output. */
  isEditing?: boolean;
  /** Commit a new label. Triggers local schema update + slow-path chat
   *  message so Claude rewrites the corresponding code. */
  onLabelChange?: (newLabel: string) => void;
  /** Open the block-level action menu (cards overlay) for this block.
   *  Wired on the canvas via attachInteractive. */
  onActions?: () => void;
};

export type BubbleNodeData = {
  /** Raw function/method identifier from provenance.functions. Kept
   *  alongside displayLabel so future edit-flow can match against the
   *  literal name in source. Browser tooltip on the bubble. */
  label: string;
  /** Humanized version of `label` (e.g. `download_image` → "Download
   *  image"). What the bubble actually renders. */
  displayLabel: string;
  /** Id of the parent block this bubble belongs to. Used by the click
   *  handler to dismiss the bubble cluster + restore the previous
   *  viewport when the user clicks a bubble back through the parent. */
  parentBlockId: string;
  /** Label of the parent block, so dragging the bubble into chat can say
   *  "capability X in block Y". */
  parentBlockLabel: string;
  /** 1-based reading order within the fan, in the same emission order the
   *  capabilities carry from the generator. Shown as a small badge so a
   *  fan reads as a sequence, matching the diagram's top-down flow. */
  order: number;
  /** How many bubbles are in this fan, so a bubble can render "n of N"
   *  affordances if needed. */
  total: number;
  /** True while the cluster is animating OUT (user just collapsed it
   *  but bubbles are still in the DOM playing the exit animation). The
   *  bubble component branches its CSS animation class on this. */
  isExiting: boolean;
  /** Translate offset (px) from the bubble's final position back to the
   *  parent block's center. The pop-in animation starts at this offset
   *  and tweens to (0,0), so visually the bubble shoots OUT of the
   *  block; pop-out is the reverse. */
  enterDx: number;
  enterDy: number;
};

/** Faint annular-sector backdrop drawn behind the bubble cluster. Acts
 *  as a visual "this came from here" hint — too easy to lose track of
 *  which block the bubbles attach to once the viewport has zoomed in. */
export type BubbleSectorNodeData = {
  parentBlockId: string;
  outerRadius: number;
  innerRadius: number;
  /** Sector arc endpoints in degrees (0 = right, 90 = down). */
  startDeg: number;
  endDeg: number;
  /** Pop-out flag — same gating as BubbleNodeData. */
  isExiting: boolean;
};

export type MiniNodeData = {
  label: string;
  caption: string;
  /** Raw function/method names. Used only as the "features" fallback when a
   *  detail block carries no capabilities. Files are intentionally NOT part
   *  of this shape: a file count carries no signal in the mini graph. */
  functions: string[];
  /** Plain-language sub-capabilities. Shown as the block's "features"
   *  count/list. */
  capabilities?: string[];
  isGhost: boolean;
  isPromoted: boolean;
  isSelected: boolean;
  block: DiagramBlock | null;
  onPromote: ((b: DiagramBlock) => void) | null;
  onUnpromote: ((b: DiagramBlock) => void) | null;
  /** Category fill + accent for a ghost (on-canvas) node, so it re-stamps
   *  in the block's own colour instead of a generic amber. Absent = fall
   *  back to a neutral tint. */
  tint?: string;
  accent?: string;
};
