# features/diagram/

The diagramming feature: an interactive architectural diagram of the
uploaded project (powered by `@xyflow/react` + `@dagrejs/dagre`) plus
a two-round visual-edit protocol that lets the user drive Claude Code
by drawing arrows, clicking block actions, or double-clicking the
canvas to add new modules.

For the user-facing walkthrough see
[docs/README.md §5–10](../../../docs/README.md). For the protocol
reference (events, sentinels, JSON tails, sequence diagrams) see
[docs/diagram.md](../../../docs/diagram.md). This README is the
internal map of the feature module itself.

## Public API

What this module exports (everything else is internal):

| Export                       | Used by                  | Role                                              |
| ---------------------------- | ------------------------ | ------------------------------------------------- |
| `DiagramCanvas`              | AppShell                 | the canvas component                              |
| `DiagramBusProvider`         | App.tsx                  | mounts the typed pub/sub bus                       |
| `useDiagramBusSubscribe`     | ChatView                 | subscribes ChatView to `visual-edit` from diagram  |
| `parseTargetMetadata`        | ChatView                 | recovers an EditTarget from a user-bubble prompt  |
| `parseVisualEditMessage`     | ChatView                 | extracts summary + body of a visual-edit bubble    |
| `parseOptionsBlock`          | ChatView                 | scans assistant text for an `options` JSON block   |
| `stripJsonCodeBlocks`        | ChatView                 | strips JSON fences from text before markdown render |
| `ArrowsAddedSink`            | ChatView                 | invisible component that emits `arrows-added`      |
| `OptionsHandoff`             | ChatView                 | minimal "look at canvas → N suggestions" + emit    |
| `DiagramView` type           | AppShell                 | "overview" \| "focus"                              |
| `EditTarget` type            | ChatView                 | discriminated union of edit kinds                  |
| `ConnectionOption` type      | ChatView                 | option-card shape                                  |

## Layout

```
features/diagram/
  index.ts                 public barrel — only what AppShell + ChatView need
  README.md                this file
  types.ts                 all types + DIAGRAM_VIEW_LABELS + serializeTarget

  protocol/                chat ↔ diagram contract
    events.ts              DiagramBusMessageMap (typed topic → payload map)
    bus.tsx                DiagramBusProvider, useDiagramBus, useDiagramBusSubscribe
    sentinels.ts           VISUAL_EDIT_* strings + build/parse helpers
    parsers.ts             parseOptionsBlock, parseAddedArrowsBlock,
                           allJsonBlocks, stripJsonCodeBlocks
    prompts.ts             composers: round-1 suggestions, round-2 execute,
                           describe-direct, rename, + the round-2 trailing
                           fragments (buildArrowJsonSuffix, buildFileTreeBlock)
    ChatBridge.tsx         ArrowsAddedSink + OptionsHandoff (rendered by ChatView)

  layout/                  pure dagre pass
    constants.ts           NODE_W, NODE_H, PANEL_MIN, PANEL_MAX, PROX
    layoutSchema.ts        layoutSchema + estimateExpandedHeight +
                           estimateMiniExpandedHeight

  api/                     streaming fetchers for /api/diagram
    fetchStructure.ts      view=structure NDJSON parser
    fetchFocus.ts          view=focus NDJSON parser
    buildProjectContext.ts XML-tagged project blob with size caps
    buildChatContext.ts    recent-turn transcript for focus polling

  hooks/                   the state machinery
    useDiagramStructureFetch.ts   initial fetch + reset on projectKey + retry
    useAdaptiveFocus.ts           debounced focus delta on each user turn
    useChatSettleEffect.ts        the 280-line settle effect (arrow outcomes,
                                  block/new-block commits, auto-regen, edit summary)
    useRecentChanges.ts           diff-on-ready glow + the per-regen structural
                                  delta (added/removed blocks + arrows) that
                                  feeds the interaction tracker via onDelta
    useEditSummary.ts             toast state slot
    useCanvasFit.ts               3 fitView effects + ResizeObserver
    useViewportFocusFit.ts        camera pan on focus delta
    useInteractionTracker.ts      ordered list of agent diagram changes +
                                  which step is being traced back
    useTraceFit.ts                camera pan to a traced step's block(s)

  components/
    DiagramCanvas.tsx             ReactFlowProvider wrapper + DiagramCanvasInner
                                  (the orchestrator)
    nodes/
      BlockNode.tsx + nodeTypes   block card with inline rename + handles
      LabeledEdge.tsx + edgeTypes smooth-stepped arrow with label pill
      ElapsedClock.tsx            MM:SS ticker
      DiagramLoadingCard.tsx      "Claude is drawing the diagram…" card
    overlays/
      DiagramFetchOverlay.tsx     loading / streaming-chip / error overlay
      ConnectionOptionsOverlay.tsx cards modal + "Others" inline form
      OptionCardButton.tsx        one card
      IntentGate.tsx              describe-vs-ask modal
      EditSummaryToast.tsx        "Just edited" floating card
      DiagramControls.tsx         focus-mode toggle, anchored to the diagram
                                  region's bottom-right (over the panel's
                                  corner when open). The "Add block" button
                                  lives above the legend, passed as
                                  ColorSchemeLegend's topAccessory.
      TrackerButton.tsx           header-right pill (+ step badge) that opens
                                  the interaction tracker.
      TrackerTray.tsx             dropdown list of agent-driven diagram
                                  changes; click a row to trace it back.
    panel/
      DiagramFocusPanel.tsx       side panel: open for all of focus mode.
                                  Welcome invite when nothing's prompted yet,
                                  then loading + "generating N" count, then the
                                  detail mini-graph. Resizable drag handle.
      FocusMiniGraph.tsx          nested ReactFlow inside the side panel
      MiniBlockNode.tsx + miniNodeTypes
      MiniLabeledEdge.tsx + miniEdgeTypes

  util/
    debug.ts                      dlog / dwarn gated on import.meta.env.DEV
                                  + VITE_DIAGRAM_DEBUG scope filter
```

## Dependency rule

This module imports from `@/core/*` (ProjectContext, useClaudeSession
types) but `src/core/*` MUST NOT import from `src/features/*`. ChatView
imports a tiny set of items from `@/features/diagram` — but those are
all protocol helpers that don't pull React Flow / dagre into core.

## Debugging

Diagram-internal state machines emit dev-only logs via the `dlog`
helper in `util/debug.ts`. Default is quiet; opt in via env var:

```bash
VITE_DIAGRAM_DEBUG=recent-debug,diagram/structure,diagram/focus bun run dev
VITE_DIAGRAM_DEBUG=* bun run dev
```

Production builds tree-shake the dev branch entirely.

## Where the heavy lifting happens

For someone tracing a bug:

- **"Diagram doesn't regenerate when Claude edits a file"** →
  `useChatSettleEffect.ts` decides regen vs no-regen by walking the
  just-finished assistant turn for `edit_project_file` /
  `write_project_file` tool_use blocks.
- **"Cards never appear after I draw an arrow"** → check the bus path:
  diagram emits `visual-edit` → ChatView's `useDiagramBusSubscribe`
  routes it to `handleSend` → Claude returns options JSON →
  `OptionsHandoff` parses + emits `options-ready` → diagram's
  subscriber sets `pendingOptions` → `ConnectionOptionsOverlay` renders.
- **"Recent-change glow doesn't fire"** → look at
  `useRecentChanges.ts` (diff-on-ready path) and the synchronous-
  compute section near the end of `useChatSettleEffect.ts` (settled-
  set path). Both write to `recentChanges` and both must see the new
  state.
- **"Focus panel never populates"** → enable
  `VITE_DIAGRAM_DEBUG=diagram/focus` to see the NDJSON events; the
  1.2 s debounce in `useAdaptiveFocus.ts` may be cancelling the fetch
  if `userMessageCount` hasn't actually incremented.
