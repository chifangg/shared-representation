import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  useClaudeSession,
  type ClaudeMessage,
  type PendingToolCall,
} from "@/core/hooks/useClaudeSession";
import { PromptInput } from "@/core/components/PromptInput";
import { ChatContextChip } from "@/core/components/ChatContextChip";
import {
  appendContextToPrompt,
  extractAttachedContext,
  type ChatContextItem,
} from "@/core/chatContext";
import { useChatContextDropZone } from "@/core/chatContextDrag";
import { useChatActivity } from "@/core/chatActivity";
import { useReadOnly } from "@/core/readOnly";
import { getStudyMode } from "@/core/studyMode";
import { logEvent, setLogContext } from "@/core/interactionLog";
import { ThinkingBubble } from "@/core/components/ThinkingBubble";
import { Markdown } from "@/core/components/Markdown";
import {
  clientToolRegistry,
  toolResultRegistry,
} from "@/core/tools/registry";
import {
  Bot,
  User,
  Upload,
  Sparkles,
  ChevronRight,
  Box,
  SquarePen,
} from "lucide-react";
import { useProject, buildChatSystemPrompt } from "@/core/project";
import {
  ArrowsAddedSink,
  OptionsHandoff,
  parseOptionsBlock,
  parseTargetMetadata,
  parseVisualEditMessage,
  stripJsonCodeBlocks,
  useVisualEditSend,
  type EditTarget,
} from "@/features/diagram";

/**
 * Default customer-facing chat view. Renders turns as bubbles, collapses
 * thinking blocks, and inlines client-tool calls as live components —
 * paired with the originating `tool_use` block via (name, input) match
 * so the picker renders in conversation flow, not as a dock.
 *
 * This is the seam forks edit most. Swap bubble styling, add avatars,
 * add rich tool-result cards, etc. The logical core (message projection,
 * pending-call correlation, tool-call routing) stays here and in
 * `useClaudeSession`.
 */
export function ChatView({ model }: { model?: string }) {
  const session = useClaudeSession({ model });
  const { files, setChatMessages, setChatRunning, projectKey, diagramBusy } =
    useProject();
  const { entries: activityEntries, clear: clearActivity } = useChatActivity();
  const readOnly = useReadOnly();
  const running = session.status === "running";

  const hasFiles = files.length > 0;

  // Publish chat history into ProjectContext so other panels (notably
  // the Diagram canvas in adaptive-focus mode) can react to it.
  useEffect(() => {
    setChatMessages(session.messages);
  }, [session.messages, setChatMessages]);

  // Publish "is Claude currently busy?" so sibling panels can react —
  // diagram uses this to clear the marching-ants "pending" style on
  // user-pulled arrows once Claude has finished reacting to them.
  useEffect(() => {
    setChatRunning(running);
  }, [running, setChatRunning]);

  // Stamp interaction-log rows with the conversation id so analysis
  // can join them onto the persisted transcript. The study condition is
  // logged at project upload (see loadFiles), NOT here: binding happens
  // on every page load, and logging it here minted a junk one-event
  // session for every reload.
  useEffect(() => {
    setLogContext({ sessionId: session.sessionId });
  }, [session.sessionId]);

  const handleNewChat = () => {
    logEvent("chat-new", { messages: session.messages.length });
    session.reset();
    clearActivity();
    // Drop any queued visual-edit so it can't fire into the fresh session.
    resetVisualEditQueue();
  };

  // A NEW project upload starts a fresh conversation. Keeping the old
  // transcript next to a new project misled a dry run badly: a stale
  // "Created highlight.py" message read as if it applied to the freshly
  // re-cloned folder, whose disk copy of that work was gone.
  const projectKeySeenRef = useRef(projectKey);
  useEffect(() => {
    if (projectKeySeenRef.current === projectKey) return;
    projectKeySeenRef.current = projectKey;
    logEvent("chat-new", { messages: session.messages.length, via: "project-upload" }, "system");
    session.reset();
    clearActivity();
    resetVisualEditQueue();
    // Reading refs/state from the render that saw the upload is fine here:
    // the reset APIs are all stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey]);

  const handleSend = (prompt: string) => {
    const isFirstTurn = session.messages.length === 0;
    if (isFirstTurn && hasFiles) {
      const context = buildChatSystemPrompt(files, null);
      session.send(prompt, { append_system_prompt: context });
    } else {
      session.send(prompt);
    }
  };

  // Bridge: diagram-side visual edits (e.g. inline-rename a block) arrive
  // on the bus as pre-formatted prompts; the hook routes them through the
  // same `handleSend` path (queueing while Claude is mid-turn) so they
  // show up in conversation alongside typed messages.
  const resetVisualEditQueue = useVisualEditSend({
    send: handleSend,
    running,
    diagramBusy,
  });

  // Context attachments dragged in from the diagram (blocks, capability
  // bubbles, connections). Per-message: folded into the prompt on send,
  // then cleared. The serialized block stays in the message (so the chat
  // memory keeps it), but the input chips do not persist across turns.
  const [contextItems, setContextItems] = useState<ChatContextItem[]>([]);

  const handleUserSubmit = (text: string) => {
    logEvent("chat-send", {
      promptLength: text.length,
      contextChips: contextItems.length,
      firstTurn: session.messages.length === 0,
    });
    handleSend(appendContextToPrompt(text, contextItems));
    setContextItems([]);
  };

  // Register the input area as a drop zone for the custom pointer drag.
  const { ref: dropRef, dragging } = useChatContextDropZone((item) => {
    logEvent("context-drop", { kind: item.kind, label: item.label });
    setContextItems((prev) =>
      prev.some((p) => p.id === item.id) ? prev : [...prev, item],
    );
  });

  const turns = useMemo(() => projectTurns(session.messages), [session.messages]);

  // `tool_use.id` → bare tool name. Used by `tool_result` bubbles to
  // look up a custom result renderer, since those blocks only carry
  // `tool_use_id`.
  const toolNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of turns) {
      if (t.role !== "assistant") continue;
      for (const b of t.blocks) {
        if (b.kind === "tool_use") m.set(b.id, stripMcpPrefix(b.name));
      }
    }
    return m;
  }, [turns]);

  // Set of `tool_use.id`s that already have a `tool_result`. Used to
  // stop rendering the live input component once Claude has received a
  // result for that call (either because the user resolved it or the
  // backend timed out).
  const resolvedToolUseIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of turns) {
      if (t.role !== "assistant") continue;
      for (const b of t.blocks) {
        if (b.kind === "tool_result") s.add(b.tool_use_id);
      }
    }
    return s;
  }, [turns]);

  // Correlate each pending client-tool call to a `tool_use` block by
  // matching tool name + JSON-equal input. FIFO on both sides, so two
  // pending calls of the same tool with the same input get paired in
  // insertion order (rare but defensive).
  //
  // The two IDs are unrelated on the wire — backend-generated
  // `tool_call_id` vs. Claude-generated `tool_use.id` — so we need this
  // matching pass to render the live component alongside the right
  // bubble. See docs/tools.md for the full id story.
  const pendingByToolUseId = useMemo(() => {
    const out = new Map<string, PendingToolCall>();
    const used = new Set<string>();
    for (const t of turns) {
      if (t.role !== "assistant") continue;
      for (const b of t.blocks) {
        if (b.kind !== "tool_use") continue;
        if (resolvedToolUseIds.has(b.id)) continue;
        const name = stripMcpPrefix(b.name);
        const match = session.pendingToolCalls.find(
          (p) =>
            !used.has(p.tool_call_id) &&
            p.name === name &&
            stableStringify(p.input) === stableStringify(b.input),
        );
        if (match) {
          used.add(match.tool_call_id);
          out.set(b.id, match);
        }
      }
    }
    return out;
  }, [turns, session.pendingToolCalls, resolvedToolUseIds]);

  // Safety net: if a `tool_result` arrived for a pending call (e.g. the
  // backend timed out and Claude got an error result), the live
  // component would otherwise sit forever. Drop the pending entry.
  useEffect(() => {
    const toRemove: string[] = [];
    for (const p of session.pendingToolCalls) {
      const pairedToolUseId = [...pendingByToolUseId.entries()].find(
        ([, pp]) => pp.tool_call_id === p.tool_call_id,
      )?.[0];
      if (pairedToolUseId && resolvedToolUseIds.has(pairedToolUseId)) {
        toRemove.push(p.tool_call_id);
      }
    }
    for (const id of toRemove) session.removePendingToolCall(id);
    // `session.removePendingToolCall` is stable (useCallback).
  }, [
    pendingByToolUseId,
    resolvedToolUseIds,
    session.pendingToolCalls,
    session.removePendingToolCall,
  ]);

  // Stick the transcript to the bottom as content streams in, UNLESS the
  // user has scrolled up to read history (then leave them where they are
  // until they scroll back down near the bottom).
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [
    session.messages,
    session.pendingToolCalls.length,
    running,
    activityEntries.length,
  ]);
  // The effect above only fires when React state identities change, but the
  // transcript also GROWS between those commits: streamed markdown, code
  // blocks expanding, diagram chips mounting. Mid-turn the view visibly
  // stalled while the agent kept writing below the fold. Watch the DOM
  // itself and re-pin on every mutation while stuck to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pin = () => {
      if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    };
    const mo = new MutationObserver(pin);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);

  return (
    <div
      ref={dropRef}
      className="relative flex h-full w-full flex-col bg-[#F2F1EF] text-[#2E2A25]"
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-[#C9C7C1] bg-[#F2F1EF]/70 backdrop-blur-[1px]">
          <span className="rounded-md border border-[#E2DACB] bg-white/95 px-3 py-1.5 text-sm font-medium text-[#6E6457] shadow-sm">
            Drop to add as context
          </span>
        </div>
      )}
      {/* Minimal header: just enough to identify the panel as Chat and keep
       *  New chat reachable (needed after a backend rebuild). Same warm-paper
       *  header as the other panels, no session-id debug line. */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[#C9C8C3] bg-[#DCDBD6] px-3 text-sm font-medium text-[#33322F]">
        <span>Chat</span>
        {/* Also gated by read-only. It starts no edit itself, but it throws
         *  the transcript away, and the transcript is the one thing
         *  read-only is meant to leave you with. */}
        <button
          onClick={handleNewChat}
          disabled={readOnly}
          title={readOnly ? "Not available in read-only mode" : "New chat"}
          aria-label="New chat"
          className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
            readOnly
              ? "cursor-not-allowed text-[#C4C2BC]"
              : "text-[#8C8B87] hover:bg-black/[0.06] hover:text-[#2C2B28]"
          }`}
        >
          <SquarePen className="h-4 w-4" strokeWidth={2} />
        </button>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        // contain:layout paint keeps the (long, fully wrapped) transcript out
        // of the document-wide reflow that a panel resize triggers.
        className="flex-1 overflow-y-auto px-3 py-4 space-y-4 [contain:layout_paint]"
      >
        {/* The upload nudge normally lives on the empty diagram canvas.
         *  Baseline runs never mount that panel, so the chat keeps it
         *  there and those participants still get told what to do. */}
        {turns.length === 0 && !hasFiles && getStudyMode() === "baseline" && (
          <NoProjectPrompt />
        )}
        {turns.length === 0 && hasFiles && <ReadyPrompt />}
        {turns.map((t, idx) => {
          // For assistant turns: look back to the immediately preceding
          // user turn and parse out the diagram-edit target sentinel,
          // if any. Cards rendered inside this turn need the target to
          // fire OPTION_EXECUTED_EVENT correctly when the user clicks
          // one (so the diagram knows what to do with the chosen kind).
          let editTarget: EditTarget | null = null;
          if (t.role === "assistant") {
            for (let j = idx - 1; j >= 0; j--) {
              const prev = turns[j];
              if (prev.role !== "user") continue;
              editTarget = parseTargetMetadata(prev.text);
              break;
            }
          }
          // Diagram-action records (pushed by the diagram feature) whose
          // turn-sequence falls in this turn's range render right after it.
          const nextKey = turns[idx + 1]?.key ?? Number.POSITIVE_INFINITY;
          const afterEntries = activityEntries.filter(
            (e) => e.afterSeq >= t.key && e.afterSeq < nextKey,
          );
          return (
            <Fragment key={t.key}>
              <TurnBubble
                turn={t}
                editTarget={editTarget}
                pendingByToolUseId={pendingByToolUseId}
                resolvedToolUseIds={resolvedToolUseIds}
                toolNameById={toolNameById}
                onResolve={session.resolveToolCall}
              />
              {afterEntries.map((e) => (
                <div key={e.id}>{e.node}</div>
              ))}
            </Fragment>
          );
        })}
        {running && <ThinkingBubble />}
      </div>

      {session.error && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap border-t border-red-200 bg-red-50 p-2 font-mono text-xs text-red-700">
          {session.error}
        </pre>
      )}

      <PromptInput
        onSubmit={handleUserSubmit}
        onCancel={() => {
          logEvent("chat-cancel");
          session.cancel();
        }}
        // Read-only gates the composer but NOT the transcript above it. In
        // the tool condition this panel is collapsed anyway, so the case
        // that matters is baseline, where chat is the whole app: the past
        // conversation stays readable and scrollable, and only sending a
        // new prompt is closed off.
        disabled={readOnly || running || !hasFiles || diagramBusy}
        running={running}
        placeholder={
          readOnly
            ? "Read-only mode. You can read the conversation, but not send new prompts."
            : diagramBusy
              ? "Diagram is being drawn, chat opens when it settles…"
              : undefined
        }
        attachments={
          contextItems.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {contextItems.map((it) => (
                <ChatContextChip
                  key={it.id}
                  kind={it.kind}
                  label={it.label}
                  sublabel={it.sublabel}
                  accent={it.accent}
                  onRemove={() =>
                    setContextItems((prev) =>
                      prev.filter((p) => p.id !== it.id),
                    )
                  }
                />
              ))}
            </div>
          ) : null
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message → turn projection.
// Stream-json arrives as a flat sequence of {type: "user"|"assistant"|...}.
// For display we group contiguous entries into "turns" and extract the
// rendering-relevant bits.
// ---------------------------------------------------------------------------

type Turn =
  | {
      role: "user";
      key: number;
      text: string;
    }
  | {
      role: "assistant";
      key: number;
      blocks: AssistantBlock[];
    };

type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; tool_use_id: string; content: unknown };

function projectTurns(messages: ClaudeMessage[]): Turn[] {
  const out: Turn[] = [];
  for (const m of messages) {
    const type = m["type"] as string | undefined;
    const inner = (m["message"] as any)?.content;
    if (type === "user") {
      if (typeof inner === "string") {
        out.push({ role: "user", key: m._seq, text: inner });
      } else if (Array.isArray(inner)) {
        const last = out[out.length - 1];
        if (last && last.role === "assistant") {
          for (const b of inner) {
            if (b?.type === "tool_result") {
              last.blocks.push({
                kind: "tool_result",
                tool_use_id: b.tool_use_id,
                content: b.content,
              });
            }
          }
        }
      }
    } else if (type === "assistant" && Array.isArray(inner)) {
      const blocks: AssistantBlock[] = [];
      for (const b of inner) {
        if (b?.type === "text") blocks.push({ kind: "text", text: b.text });
        else if (b?.type === "thinking")
          blocks.push({ kind: "thinking", text: b.thinking ?? "" });
        else if (b?.type === "tool_use") {
          blocks.push({ kind: "tool_use", id: b.id, name: b.name, input: b.input });
        }
      }
      const last = out[out.length - 1];
      if (last && last.role === "assistant") {
        last.blocks.push(...blocks);
      } else {
        out.push({ role: "assistant", key: m._seq, blocks });
      }
    }
  }
  return out;
}

function Avatar({ role }: { role: "user" | "assistant" }) {
  if (role === "user") {
    return (
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#5E5A51] text-[#EFE9DD]">
        <User size={14} />
      </div>
    );
  }
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#EDE4D2] text-[#9A7E4E]">
      <Bot size={14} />
    </div>
  );
}

/** Small chip naming the block / connection a visual edit was about, so
 *  the transcript shows which element was touched (the canvas highlight
 *  alone is not visible when scrolling back). Readable on the gray block. */
function TargetChip({ label }: { label: string }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-black/[0.06] bg-white/90 px-2 py-[3px] text-[11px] font-medium text-[#3A352B]">
      <Box
        className="h-3 w-3 shrink-0 text-[#8C8275]"
        strokeWidth={2}
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function TurnBubble({
  turn,
  editTarget,
  pendingByToolUseId,
  resolvedToolUseIds,
  toolNameById,
  onResolve,
}: {
  turn: Turn;
  /** Set when this turn (assistant) is replying about a freshly-drawn
   *  arrow, a clicked block, or a new-block request — gives downstream
   *  cards the target context to fire back when the user picks one. */
  editTarget: EditTarget | null;
  pendingByToolUseId: Map<string, PendingToolCall>;
  resolvedToolUseIds: Set<string>;
  toolNameById: Map<string, string>;
  onResolve: (id: string, content: unknown) => void;
}) {
  if (turn.role === "user") {
    const visualEdit = parseVisualEditMessage(turn.text);
    // User-initiated diagram action: a recessed warm-gray "record" block,
    // pinned to the user's (right) side. Distinct material from a speech
    // bubble: pressed into the surface, not floating.
    if (visualEdit) {
      const target = visualEdit.target;
      return (
        <div className="flex items-start justify-end gap-2">
          <div
            className="inline-flex min-w-0 max-w-[82%] flex-col gap-1.5 rounded-[10px] bg-[#DBD8D1] px-3.5 py-2.5"
            style={{
              boxShadow:
                "inset 0 1px 3px rgba(40,35,28,0.13), inset 0 -1px 0 rgba(255,255,255,0.45)",
            }}
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[#2A251D]">
              Diagram edit
            </span>
            <span className="text-[13px] font-medium leading-snug text-[#1C1813]">
              {visualEdit.summary}
            </span>
            {target && (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                {target.kind === "block" ? (
                  <TargetChip label={target.label} />
                ) : (
                  <>
                    <TargetChip label={target.from} />
                    <span className="text-[#3A352B]">&rarr;</span>
                    <TargetChip label={target.to} />
                  </>
                )}
              </div>
            )}
            {visualEdit.body && (
              <details className="text-[11px] text-[#2A251D]">
                <summary className="cursor-pointer select-none hover:text-[#0F0D09]">
                  see prompt
                </summary>
                <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/10 p-2 font-mono text-[11px] leading-relaxed text-[#1C1813]">
                  {visualEdit.body}
                </pre>
              </details>
            )}
          </div>
          <div className="mt-1 shrink-0">
            <Avatar role="user" />
          </div>
        </div>
      );
    }
    // Spoken user prompt: a raised espresso bubble on the right, with any
    // dragged-in context attached as chips inside.
    const { text: userText, items: ctxItems } = extractAttachedContext(
      turn.text,
    );
    return (
      <div className="flex items-start justify-end gap-2">
        <div className="flex max-w-[78%] flex-col items-end">
          <div
            className="rounded-[16px_16px_6px_16px] bg-[#2E2A25] px-3.5 py-2.5"
            style={{ boxShadow: "0 1px 2px rgba(60,50,30,0.13)" }}
          >
            {ctxItems.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {ctxItems.map((c, i) => (
                  <ChatContextChip
                    key={i}
                    kind={c.kind}
                    label={c.label}
                    accent={c.accent}
                  />
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[14px] leading-snug text-[#EFE9DD]">
              {userText}
            </div>
          </div>
        </div>
        <div className="mt-1 shrink-0">
          <Avatar role="user" />
        </div>
      </div>
    );
  }
  // Assistant turn: avatar on the left with a thin timeline rail running
  // down through the turn, and each block as its own element (speech
  // bubble, ghost line, or tool card) stacked in the column beside it.
  return (
    <div className="flex gap-2.5">
      <div className="flex flex-none flex-col items-center">
        <Avatar role="assistant" />
        <div className="mt-1.5 w-px flex-1 rounded bg-[#E7E0D2]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2.5 pb-1">
        {turn.blocks.map((b, i) => (
          <AssistantBlockView
            key={i}
            block={b}
            editTarget={editTarget}
            pendingByToolUseId={pendingByToolUseId}
            resolvedToolUseIds={resolvedToolUseIds}
            toolNameById={toolNameById}
            onResolve={onResolve}
          />
        ))}
      </div>
    </div>
  );
}

function AssistantBlockView({
  block,
  editTarget,
  pendingByToolUseId,
  resolvedToolUseIds,
  toolNameById,
  onResolve,
}: {
  block: AssistantBlock;
  editTarget: EditTarget | null;
  pendingByToolUseId: Map<string, PendingToolCall>;
  resolvedToolUseIds: Set<string>;
  toolNameById: Map<string, string>;
  onResolve: (id: string, content: unknown) => void;
}) {
  if (block.kind === "text") {
    // Round-1 of an arrow / block / new-block flow: Claude returned a
    // JSON options block. The cards UI itself lives on the canvas, so
    // here we just (a) push the parsed options + target across to the
    // diagram via OPTIONS_READY_EVENT and (b) render a minimal prompt
    // pointing the user at the canvas. Falls back to plain markdown
    // if parsing fails (Claude went off-format).
    const parsed = editTarget ? parseOptionsBlock(block.text) : null;
    if (parsed && editTarget) {
      return (
        <OptionsHandoff options={parsed.options} target={editTarget} />
      );
    }
    // Round-2 may include an added_arrows JSON tail describing real
    // dependencies just wired in code. Push those to the diagram and
    // continue to render the human-readable summary text as markdown.
    const clean = stripJsonCodeBlocks(block.text);
    return (
      <>
        <ArrowsAddedSink text={block.text} />
        {clean.trim() && (
          <div
            className="max-w-[80%] self-start break-words [overflow-wrap:anywhere] rounded-[16px_16px_16px_5px] border border-[#EDE6DA] bg-white px-3.5 py-2 text-[14px] leading-snug text-[#2E2A25]"
            style={{ boxShadow: "0 1px 2px rgba(60,50,30,0.05)" }}
          >
            <Markdown className="[&_p]:!my-0 [&_p]:!leading-snug [&_p+p]:!mt-2 [&_ul]:!my-1.5 [&_ol]:!my-1.5 [&_li]:!my-0 [&_li]:!leading-snug [&_pre]:!my-2">
              {clean.trim()}
            </Markdown>
          </div>
        )}
      </>
    );
  }
  if (block.kind === "thinking") {
    return (
      <details className="group self-start text-[12px] text-[#A89E8E]">
        <summary className="cursor-pointer select-none list-none hover:text-[#8A8175]">
          <span className="inline-flex items-center gap-1.5">
            <ChevronRight
              size={12}
              className="text-[#C2B79F] transition-transform group-open:rotate-90"
            />
            <Sparkles size={12} className="text-[#C2B79F]" />
            thinking
          </span>
        </summary>
        <div className="mt-1 border-l-2 border-[#EAE3D6] pl-2.5">
          <Markdown className="prose-xs">{block.text}</Markdown>
        </div>
      </details>
    );
  }
  if (block.kind === "tool_use") {
    const name = stripMcpPrefix(block.name);
    // ToolSearch is internal plumbing: this Claude CLI version defers client
    // (MCP) tools and the model calls ToolSearch to load them before use.
    // Hide that step so the transcript shows only the real tool calls.
    if (name === "ToolSearch") return null;
    const pending = pendingByToolUseId.get(block.id);
    const isResolved = resolvedToolUseIds.has(block.id);
    const Component = pending ? clientToolRegistry[pending.name] : undefined;

    if (!isResolved && pending && Component) {
      return (
        <div className="w-full self-stretch">
          <Component
            input={pending.input}
            resolve={(content) => onResolve(pending.tool_call_id, content)}
          />
        </div>
      );
    }
    // Resolved: the tool_result card renders the outcome, so the bare
    // tool_use needs no duplicate label.
    if (isResolved) return null;
    // Pending but no live UI registered: a quiet "running" ghost.
    return (
      <div className="self-start font-mono text-[11px] text-[#A89E8E]">
        {name}…
      </div>
    );
  }
  if (block.kind === "tool_result") {
    const toolName = toolNameById.get(block.tool_use_id);
    const ResultComponent = toolName
      ? toolResultRegistry[toolName]
      : undefined;
    const parsed = parseToolResultContent(block.content);
    // Hide ToolSearch's output (a `tool_reference` pointer to a deferred
    // tool). It is plumbing, not a result worth showing.
    const resultValue = parsed.value as { type?: string } | null;
    if (toolName === "ToolSearch" || resultValue?.type === "tool_reference") {
      return null;
    }

    if (ResultComponent) {
      return (
        <div className="w-full self-stretch">
          <ResultComponent
            content={parsed.value}
            toolUseId={block.tool_use_id}
          />
        </div>
      );
    }
    // Unrecognized tool result (a non-MCP / builtin tool, or an odd
    // tool_reference payload). Keep it collapsed AND truncated so the chat
    // never floods with raw dumps like full file contents.
    const preview =
      parsed.preview.length > 500
        ? `${parsed.preview.slice(0, 500)}\n…`
        : parsed.preview;
    return (
      <details className="self-start text-[11.5px] text-[#A89E8E]">
        <summary className="cursor-pointer select-none font-mono hover:text-[#8A8175]">
          {toolName ?? "tool"} result
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-[#EAE3D6] bg-[#FBF7EF] p-2 font-mono text-[11px] leading-relaxed text-[#857F75]">
          {preview}
        </pre>
      </details>
    );
  }
  return null;
}

/** Strip the MCP server prefix (`mcp__template-tools__`) off a tool name. */
function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__[^_]+(?:__)?/, "");
}

/**
 * Order-stable JSON stringify used to compare tool inputs across
 * Claude's stream-json and the backend's `tool_call_for_ui` payload.
 * Object key order isn't guaranteed to match across the two paths, so
 * sort before stringifying.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortedReplacer);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * The wire shape of `tool_result.content` is either a plain string or
 * an array of content blocks like `[{type:"text", text:"<json>"}]`
 * (the bridge currently always emits the array form). Flatten to a
 * single text preview, then try to parse as JSON so custom renderers
 * get a structured value.
 */
function parseToolResultContent(raw: unknown): {
  value: unknown;
  preview: string;
} {
  const preview =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw
            .map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n")
        : JSON.stringify(raw);
  try {
    return { value: JSON.parse(preview), preview };
  } catch {
    return { value: preview, preview };
  }
}

/**
 * Step 1 of the chat onboarding flow: shown when no project has been
 * uploaded yet. The chat is effectively gated until files arrive.
 */
function NoProjectPrompt() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-[#9A9081]">
      <Upload size={28} className="opacity-40" />
      <p>Upload a project in the Files panel to begin.</p>
    </div>
  );
}

function ReadyPrompt() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-[#A89E8E]">
      <p>Project loaded. Type a message below to start.</p>
    </div>
  );
}

/**
 * Try to find a JSON code block of shape `{ "options": [...] }` in an
 * assistant text response. Returns the validated option list, or null
 * if the body doesn't fit the schema (parse error, missing fields,
 * unknown kind). Lenient on surrounding prose, strict on shape.
 */
// Diagram-protocol parsers + sink components (parseOptionsBlock,
// parseAddedArrowsBlock, allJsonBlocks, stripJsonCodeBlocks,
// ArrowsAddedSink, OptionsHandoff) moved to
// @/features/diagram/protocol/{parsers,ChatBridge}. ChatView imports
// them as small JSX building blocks and stays unaware of the JSON
// shapes / bus topics underneath.

