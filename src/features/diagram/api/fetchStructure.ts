/**
 * Streaming POST to /api/diagram with view=structure.
 *
 * Owns the NDJSON parsing loop: reads the response body line-by-line,
 * parses each line as a `StructureStreamEvent`, and forwards it to
 * the caller's `onEvent` callback. Returns when the stream ends or
 * the AbortSignal fires.
 *
 * The backend emits one JSON object per line: `block`, `arrow`, or
 * `error`. The caller is expected to accumulate blocks/arrows and
 * set the diagram state on completion; `error` events are surfaced
 * via onEvent so the caller can render the error overlay.
 */

import type { DiagramArrow, DiagramBlock } from "../types";
import { dlog } from "../util/debug";
import { STREAM_IDLE_MS as IDLE_MS, withIdleTimeout } from "./idleTimeout";

export type StructureStreamEvent =
  | { kind: "block"; data: DiagramBlock }
  | { kind: "arrow"; data: DiagramArrow }
  | { kind: "error"; message: string };

/** Best-effort runtime validation of an NDJSON line into a typed event. */
function parseStructureLine(line: string): StructureStreamEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { kind?: unknown; data?: unknown; message?: unknown };
  if (obj.kind === "block" && obj.data) {
    return { kind: "block", data: obj.data as DiagramBlock };
  }
  if (obj.kind === "arrow" && obj.data) {
    return { kind: "arrow", data: obj.data as DiagramArrow };
  }
  if (obj.kind === "error") {
    return {
      kind: "error",
      message: typeof obj.message === "string" ? obj.message : "stream error",
    };
  }
  return null;
}

export async function fetchStructureStream({
  projectContext,
  baseSchema,
  signal,
  onEvent,
}: {
  projectContext: string;
  /** Serialized on-screen schema for an ANCHORED regen: the backend
   *  re-emits unchanged blocks verbatim instead of re-deriving the map
   *  (which churns every id and label). Null/absent = fresh generate. */
  baseSchema?: string | null;
  signal: AbortSignal;
  onEvent: (evt: StructureStreamEvent) => void;
}): Promise<void> {
  const resp = await withIdleTimeout(
    fetch("/api/diagram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_context: projectContext,
        view: "structure",
        ...(baseSchema ? { base_schema: baseSchema } : {}),
      }),
      signal,
    }),
    IDLE_MS,
    "diagram request",
  );
  if (!resp.body) throw new Error("no response body");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await withIdleTimeout(
      reader.read(),
      IDLE_MS,
      "diagram stream",
    );
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const evt = parseStructureLine(line);
      if (!evt) continue;
      dlog("diagram/structure", evt);
      onEvent(evt);
    }
  }
}
