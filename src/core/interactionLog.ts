/**
 * Interaction log for the user study: a tiny fire-and-forget event
 * buffer that batches UI events to POST /api/log, where they land in
 * sqlite (`interaction_events`, keyed by the guest cookie).
 *
 * Design rules:
 *  - Never block or break the UI. A failed flush drops the batch with
 *    a console.warn; nothing retries, nothing throws.
 *  - Small payloads only: ids, labels, counts, lengths. No file
 *    contents, no prompt bodies. Full transcripts are already
 *    persisted server-side; analysis joins them via
 *    `chat_session` = conversation id.
 *  - `source` says who acted: "user" for direct interactions, "agent"
 *    for Claude-driven actions, "system" for lifecycle marks. The
 *    study's engagement analysis filters on source = "user".
 *
 * The module also self-subscribes to the adapter's window events for
 * turn lifecycle marks. It listens on the GENERIC event names only
 * (the adapter fires each event twice: generic + session-scoped), so
 * no dedupe is needed for those.
 */

export type LogSource = "user" | "agent" | "system";

type PendingEvent = {
  ts: number;
  event: string;
  source: LogSource;
  chat_session: string | null;
  project_key: number | null;
  payload: Record<string, unknown>;
};

const FLUSH_MS = 5000;
const FLUSH_AT = 25;
/** Hard cap so a dead backend can't grow the buffer forever. */
const BUFFER_CAP = 200;

const ctx: { sessionId: string | null; projectKey: number | null } = {
  sessionId: null,
  projectKey: null,
};

/** Bind the ids stamped onto every subsequent event. Owners of the
 *  values call this (ChatView for sessionId, ProjectProvider for
 *  projectKey); leaving a field undefined keeps its current value. */
export function setLogContext(next: {
  sessionId?: string | null;
  projectKey?: number | null;
}) {
  if (next.sessionId !== undefined) ctx.sessionId = next.sessionId;
  if (next.projectKey !== undefined) ctx.projectKey = next.projectKey;
}

let buf: PendingEvent[] = [];
let timer: number | null = null;
const seen = new Set<string>();

/**
 * Queue one event. `dedupeId` is for call sites that can fire twice
 * with the same meaning (StrictMode double-invoked effects); handlers
 * for plain user clicks don't need it.
 */
export function logEvent(
  event: string,
  payload: Record<string, unknown> = {},
  source: LogSource = "user",
  dedupeId?: string,
) {
  if (dedupeId) {
    if (seen.has(dedupeId)) return;
    seen.add(dedupeId);
    if (seen.size > 2000) seen.clear();
  }
  if (buf.length >= BUFFER_CAP) buf.shift();
  buf.push({
    ts: Date.now(),
    event,
    source,
    chat_session: ctx.sessionId,
    project_key: ctx.projectKey,
    payload,
  });
  if (buf.length >= FLUSH_AT) {
    void flush();
  } else if (timer === null) {
    timer = window.setTimeout(() => void flush(), FLUSH_MS);
  }
}

async function flush() {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (buf.length === 0) return;
  const events = buf;
  buf = [];
  try {
    await fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
      // keepalive lets a flush issued right before navigation finish,
      // but caps the body at ~64KB, so only use it for small batches.
      keepalive: events.length <= FLUSH_AT,
    });
  } catch (e) {
    console.warn("[interaction-log] dropped", events.length, "events", e);
  }
}

if (typeof window !== "undefined") {
  // Tail flush on page hide; sendBeacon survives the unload.
  window.addEventListener("pagehide", () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (buf.length === 0) return;
    const events = buf;
    buf = [];
    try {
      navigator.sendBeacon(
        "/api/log",
        new Blob([JSON.stringify({ events })], { type: "application/json" }),
      );
    } catch {
      // Best effort only.
    }
  });

  // Turn lifecycle marks, straight off the adapter's generic events.
  window.addEventListener("claude-complete", (e) => {
    const success = (e as CustomEvent).detail as boolean;
    logEvent("turn-complete", { success }, "system");
  });
  window.addEventListener("claude-cancelled", () => {
    logEvent("turn-cancelled", {}, "system");
  });
  // Every client-tool call Claude makes (read/edit/write project file,
  // diagram ops). Log the tool name and target path, never contents.
  window.addEventListener("claude-tool-call", (e) => {
    const d = (e as CustomEvent).detail as {
      name?: string;
      input?: Record<string, unknown>;
    } | null;
    const name = d?.name ?? "unknown";
    const path =
      d?.input && typeof d.input.path === "string" ? d.input.path : undefined;
    logEvent("tool-call", path ? { name, path } : { name }, "agent");
  });
}
