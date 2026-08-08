import { useCallback, useEffect, useRef } from "react";
import { useDiagramBusSubscribe } from "../protocol/bus";

/**
 * Chat-side receiver for the diagram's "visual-edit" bus messages.
 *
 * Diagram-side visual edits (e.g. inline-rename a block) emit a
 * pre-formatted prompt on the bus; this hook routes it through the
 * caller's `send` path so the visual edit shows up in conversation
 * alongside typed messages.
 *
 * Prompts that arrive while Claude is mid-turn are queued (one slot,
 * last-write-wins) and flushed the moment the turn ends. See the
 * subscriber below for why mid-turn arrivals are normal, not a bug.
 *
 * Returns a reset function. The caller invokes it on "New chat" so a
 * queued prompt can't fire into the fresh session.
 */
export function useVisualEditSend({
  send,
  running,
  diagramBusy,
}: {
  /** The chat's send path; called with the pre-formatted prompt. */
  send: (prompt: string) => void;
  /** True while Claude is mid-turn; prompts arriving then are queued. */
  running: boolean;
  /** True while a diagram generation streams. A prompt sent then races
   *  the generation state machine (the historical canvas wedge), so
   *  arrivals queue exactly like mid-turn ones and flush when the
   *  generation settles. This mirrors the PromptInput disable, which
   *  this bus path would otherwise bypass. */
  diagramBusy: boolean;
}): () => void {
  // Latest `send`, so the deferred-flush effect below can call it without
  // a stale closure (and without asking the caller to memoize).
  const sendRef = useRef(send);
  sendRef.current = send;
  // A visual-edit prompt that arrived while Claude was mid-turn, held back to
  // send the instant the turn ends (see the subscriber + effect below).
  const pendingRef = useRef<string | null>(null);

  useDiagramBusSubscribe("visual-edit", (detail) => {
    if (!detail?.prompt) return;
    if (running || diagramBusy) {
      // Claude is still finishing a turn (e.g. the round-1 suggestions turn
      // is closing at the exact moment the user picks a card: the cards go
      // pickable as soon as the options JSON streams in, before the turn
      // ends), or a diagram generation is streaming. Don't silently drop
      // the pick, or the agent appears to do nothing. Queue it and flush
      // when both are clear. Last-write-wins is fine here (one pending
      // visual edit at a time).
      pendingRef.current = detail.prompt;
      return;
    }
    send(detail.prompt);
  });

  // Flush a queued visual-edit the moment Claude AND the diagram are
  // free. Watching diagramBusy too closes the settle-edge race: the
  // turn ends and the settle effect starts an edit-driven regen in the
  // very next commits; a flush gated on `running` alone would fire a
  // new turn straight into that regen's stream.
  useEffect(() => {
    if (running || diagramBusy) return;
    const queued = pendingRef.current;
    if (!queued) return;
    pendingRef.current = null;
    sendRef.current(queued);
  }, [running, diagramBusy]);

  return useCallback(() => {
    pendingRef.current = null;
  }, []);
}
