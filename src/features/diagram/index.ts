/**
 * Public barrel for the diagram feature.
 *
 * AppShell and ChatView consume this module. Internal files import
 * from deep paths (`./types`, `./protocol/sentinels`, etc.); keep the
 * barrel narrow so the chat side can't reach into rendering internals.
 */

// Components rendered by AppShell.
export { DiagramCanvas } from "./components/DiagramCanvas";

// Provider mounted by App.tsx and the subscribe hook ChatView uses
// to receive the diagram's visual-edit prompts.
export { DiagramBusProvider, useDiagramBusSubscribe } from "./protocol/bus";

// Sentinel parsers used by ChatView to render diagram-edit user bubbles
// and to pair an assistant turn's options block to its EditTarget.
export {
  parseTargetMetadata,
  parseVisualEditMessage,
} from "./protocol/sentinels";

// Chat-side bridge components ChatView renders inline alongside an
// assistant text block. Each emits on the bus once per unique payload.
export { ArrowsAddedSink, OptionsHandoff } from "./protocol/ChatBridge";

// Parsers ChatView needs for the assistant text path (find options
// JSON, strip JSON fences before markdown render).
export {
  parseOptionsBlock,
  stripJsonCodeBlocks,
} from "./protocol/parsers";

// Public types ChatView consumes. The other types
// (DiagramSchema/DiagramBlock/DiagramArrow/FetchState/BlockNodeData/
// MiniNodeData/serializeTarget/DIAGRAM_VIEW_LABELS/the *Detail
// interfaces) are intentionally internal to the feature.
export type { DiagramView, EditTarget, ConnectionOption } from "./types";
