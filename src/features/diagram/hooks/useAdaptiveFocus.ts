import { useEffect, useRef, useState } from "react";
import type { FileEntry } from "@/core/project";
import type { ClaudeMessage } from "@/core/hooks/useClaudeSession";
import type {
  DiagramArrow,
  DiagramBlock,
  DiagramView,
  FetchState,
} from "../types";
import { buildProjectContext } from "../api/buildProjectContext";
import { buildChatContext } from "../api/buildChatContext";
import { fetchFocusStream } from "../api/fetchFocus";

export type FocusState = {
  ids: string[];
  blocks: DiagramBlock[];
  arrows: DiagramArrow[];
};

/**
 * Owns adaptive-focus polling.
 *
 * Watches the user-message count of the chat. When it ticks up while
 * the diagram is ready, in focus view, and a project is loaded, waits
 * 1.2s (debounce — so an active streaming turn doesn't fire on every
 * intermediate chunk) and then POSTs to `/api/diagram?view=focus`
 * with the current chat context + the base schema labels. Streaming
 * `focus` / `detail_block` / `detail_arrow` events accumulate into
 * `focused` so the side-panel mini-graph can render them live.
 *
 * The freshest chat history is captured via an internal ref so the
 * deferred fetch picks up tokens that landed during the debounce
 * window without retriggering the effect on every chunk.
 *
 * Resets `focused` + `regenerating` on USER-initiated project change
 * (projectKey).
 */
export function useAdaptiveFocus({
  view,
  state,
  files,
  chatMessages,
  projectKey,
}: {
  view: DiagramView;
  state: FetchState;
  files: FileEntry[];
  chatMessages: ClaudeMessage[];
  projectKey: number;
}): {
  focused: FocusState | null;
  regenerating: boolean;
  emptyRound: boolean;
} {
  const [focused, setFocused] = useState<FocusState | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  // True once a round has COMPLETED with nothing to show (no focus ids and no
  // detail blocks) or after a fetch error. Lets the panel tell "you haven't
  // asked yet" (welcome) apart from "asked, but nothing came back".
  const [emptyRound, setEmptyRound] = useState(false);

  // Capture the freshest chat messages without retriggering the
  // debounced fetch effect on every assistant chunk.
  const chatMessagesRef = useRef(chatMessages);
  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  // Reset on user-initiated project change.
  useEffect(() => {
    setFocused(null);
    setRegenerating(false);
    setEmptyRound(false);
  }, [projectKey]);

  // Count completed user turns. A turn increment signals "user just
  // sent a new message", which is the cue to refocus.
  const userMessageCount = chatMessages.reduce(
    (n, m) => n + ((m as { type?: string }).type === "user" ? 1 : 0),
    0,
  );
  const lastUserCountRef = useRef(0);
  useEffect(() => {
    if (view !== "focus") return;
    if (state.kind !== "ready") return;
    if (files.length === 0) return;
    if (userMessageCount === lastUserCountRef.current) return;
    lastUserCountRef.current = userMessageCount;
    if (userMessageCount === 0) return;

    // Open the side panel in its loading state IMMEDIATELY (before the
    // debounce + stream), so switching into adaptive focus animates the
    // panel open right away instead of waiting for the first detail block.
    // `regenerating` now stays true for the WHOLE stream (it is NOT flipped
    // off on the first block) so the panel can show a live "generating · N"
    // count and the user knows when the round has actually finished.
    setRegenerating(true);
    setEmptyRound(false);
    setFocused({ ids: [], blocks: [], arrows: [] });

    const controller = new AbortController();
    const debounceTimer = window.setTimeout(() => {
      const projectContext = buildProjectContext(files, null);
      const chatContext = buildChatContext(chatMessagesRef.current, 3);
      const baseSchemaJson = JSON.stringify({
        blocks: state.schema.blocks.map((b) => ({
          id: b.id,
          label: b.label,
          caption: b.caption,
        })),
      });

      const newDetailBlocks: DiagramBlock[] = [];
      const newDetailArrows: DiagramArrow[] = [];
      const newFocusedIds: string[] = [];

      (async () => {
        try {
          await fetchFocusStream({
            projectContext,
            chatContext,
            baseSchemaJson,
            signal: controller.signal,
            onEvent: (evt) => {
              if (evt.kind === "focus") {
                newFocusedIds.push(...evt.ids);
                // Commit the highlighted ids right away so the panel
                // header names what it is focusing on during loading.
                setFocused({
                  ids: [...newFocusedIds],
                  blocks: [...newDetailBlocks],
                  arrows: [...newDetailArrows],
                });
              } else if (evt.kind === "detail_block") {
                newDetailBlocks.push(evt.data);
                setFocused({
                  ids: [...newFocusedIds],
                  blocks: [...newDetailBlocks],
                  arrows: [...newDetailArrows],
                });
              } else if (evt.kind === "detail_arrow") {
                newDetailArrows.push(evt.data);
                setFocused({
                  ids: [...newFocusedIds],
                  blocks: [...newDetailBlocks],
                  arrows: [...newDetailArrows],
                });
              }
            },
          });
          if (controller.signal.aborted) return;
          // Edge: focus event arrived but no detail_block ever did.
          if (newDetailBlocks.length === 0 && newFocusedIds.length > 0) {
            setFocused({
              ids: [...newFocusedIds],
              blocks: [],
              arrows: [],
            });
          }
          // The round finished with genuinely nothing to show: mark it so the
          // panel shows "nothing related" rather than the first-run welcome.
          if (newDetailBlocks.length === 0 && newFocusedIds.length === 0) {
            setEmptyRound(true);
          }
          setRegenerating(false);
        } catch {
          if (controller.signal.aborted) return;
          setEmptyRound(true);
          setRegenerating(false);
        }
      })();
    }, 1200);

    return () => {
      window.clearTimeout(debounceTimer);
      controller.abort();
      // Torn down before the round finished (view switch away): don't
      // leave the panel stuck in its loading state.
      setRegenerating(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMessageCount, view, files.length]);

  return { focused, regenerating, emptyRound };
}
