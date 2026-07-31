/**
 * Typed message map for the chat ↔ diagram pub/sub bus.
 *
 * One entry per topic; the payload type for each topic must match
 * what the emit-side passes and the subscribe-side expects. Both
 * sides import from this single source of truth, so a schema change
 * on the wire shape becomes a compile-time error.
 */

import type {
  ArrowsAddedDetail,
  ConnectionLensDetail,
  OptionExecutedDetail,
  OptionsCancelledDetail,
  OptionsReadyDetail,
  VisualEditDetail,
} from "../types";

export type DiagramBusMessageMap = {
  /**
   * Diagram → ChatView. The diagram dispatches a pre-formatted user-
   * message prompt; ChatView's listener routes it through `handleSend`
   * so it shows up in conversation alongside typed messages.
   */
  "visual-edit": VisualEditDetail;

  /**
   * ChatView → Diagram. Once ChatView's response parser finds a JSON
   * options block in an assistant turn whose preceding user turn
   * carried an edit-target sentinel, it dispatches this with the
   * parsed options + the target. Diagram opens the cards overlay.
   */
  "options-ready": OptionsReadyDetail;

  /**
   * Diagram → Diagram (intra-feature). Fired when the user clicks a
   * card in the options overlay (or submits "Others", or picks via
   * IntentGate's describe path). The settle-effect's per-target
   * outcome handling reads from chosenOptionsRef keyed by the
   * serialized target; this event populates that ref.
   */
  "option-executed": OptionExecutedDetail;

  /**
   * Diagram → ChatView (intra-transcript). The user closed the cards
   * overlay WITHOUT picking anything. The chat's "N suggestions ready
   * on the canvas" chip flips to its dismissed state, so scrolling back
   * later cannot read as if the suggestions were still waiting.
   */
  "options-cancelled": OptionsCancelledDetail;

  /**
   * ChatView → Diagram. Once the assistant turn has a trailing
   * `added_arrows` JSON block (see buildArrowJsonSuffix), the parser
   * dispatches this with the resolved arrow list. Diagram adds them
   * to the schema with pending="claude" until chatRunning settles.
   */
  "arrows-added": ArrowsAddedDetail;

  /**
   * LabeledEdge -> Diagram (intra-feature). The user clicked an arrow's
   * label pill; the diagram opens the connection lenses anchored at the
   * click point. Emitted from the edge component (which only knows the
   * source/target/verb), resolved to blocks + files by the canvas.
   */
  "connection-lens": ConnectionLensDetail;

  /**
   * A chat-driven diagram tool (change_block_color / delete_block) ->
   * Diagram. Lets the chat edit the diagram itself, not just code:
   * recolor a block (reassign its category) or remove it. The canvas
   * applies it to the current schema best-effort, matched by block label.
   */
  "diagram-op": DiagramOpDetail;
};

/** Payload for the "diagram-op" topic: a chat-initiated edit of the
 *  diagram view (block matched by its displayed label). */
export type DiagramOpDetail =
  | { op: "recolor"; block: string; category: string }
  | { op: "delete"; block: string };

export type DiagramBusTopic = keyof DiagramBusMessageMap;
