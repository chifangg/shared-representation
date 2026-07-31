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
import { isUserPrompt } from "../util/chatEdits";

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

  // Files change on every agent write mid-turn. Read them through a ref so
  // a `write_project_file` during the round does NOT re-fire this effect
  // (which would abort the in-flight focus fetch and leave the panel empty).
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  // Reset on user-initiated project change. The consumed-round counter
  // resets too: with consume-on-completion it would otherwise carry the
  // OLD project's count and swallow the new project's first focus round.
  useEffect(() => {
    setFocused(null);
    setRegenerating(false);
    setEmptyRound(false);
    lastUserCountRef.current = 0;
  }, [projectKey]);

  // Count completed user turns. A turn increment signals "user just
  // sent a new message", which is the cue to refocus. Tool-result
  // round-trips (also role:user) are excluded, so the round is driven by
  // the user's prompt / executed edit, not by the agent's mid-turn output.
  const userMessageCount = chatMessages.reduce(
    (n, m) => n + (isUserPrompt(m) ? 1 : 0),
    0,
  );
  const lastUserCountRef = useRef(0);
  useEffect(() => {
    if (view !== "focus") return;
    if (state.kind !== "ready") return;
    if (filesRef.current.length === 0) return;
    if (userMessageCount === lastUserCountRef.current) return;
    // NOT consumed here: the count is only consumed when the round
    // COMPLETES (see below). Consuming at start meant a round aborted by
    // closing the panel could never re-run: on re-entry the count looked
    // already handled and the panel dead-ended on the wiped focus state.
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
      const projectContext = buildProjectContext(filesRef.current, null);
      const chatContext = buildChatContext(chatMessagesRef.current, 3);
      const baseSchemaJson = JSON.stringify({
        blocks: state.schema.blocks.map((b) => ({
          id: b.id,
          label: b.label,
          caption: b.caption,
        })),
      });
      const canvasIds = new Set(state.schema.blocks.map((b) => b.id));

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
                // Dedup: a re-emitted / duplicate focus event must not append
                // repeats. Duplicates would change focused.ids identity (which
                // resets the mini-graph's drags) and collide ghost-node keys.
                for (const id of evt.ids) {
                  if (!newFocusedIds.includes(id)) newFocusedIds.push(id);
                }
                // Commit the highlighted ids right away so the panel
                // header names what it is focusing on during loading.
                setFocused({
                  ids: [...newFocusedIds],
                  blocks: [...newDetailBlocks],
                  arrows: [...newDetailArrows],
                });
              } else if (evt.kind === "detail_block") {
                // Best-effort repair of the parent link before it enters
                // state: the model sometimes emits the parent's LABEL
                // instead of its id, or an id that does not exist. The
                // parent is a detail's ONLY tie back to the canvas
                // (detail arrows are detail-to-detail by design), so an
                // unresolved parent leaves the block floating in the mini
                // graph and islanded if promoted.
                const block = { ...evt.data };
                if (block.parent && !canvasIds.has(block.parent)) {
                  const wanted = String(block.parent).trim().toLowerCase();
                  const byLabel = state.schema.blocks.find(
                    (b) => b.label.toLowerCase() === wanted,
                  );
                  block.parent = byLabel ? byLabel.id : null;
                }
                newDetailBlocks.push(block);
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
          // The round genuinely finished: consume its trigger. Errors and
          // aborts deliberately do NOT consume, so toggling the panel
          // re-runs the interrupted round instead of showing it empty.
          lastUserCountRef.current = userMessageCount;
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
    // files is read via filesRef so mid-turn writes don't re-fire / abort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMessageCount, view]);

  return { focused, regenerating, emptyRound };
}
