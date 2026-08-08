/**
 * Streaming POST to /api/diagram with view=capability_scan.
 *
 * Lighter than fetchStructureStream: the backend emits only `capability`
 * tool calls (id + label + caption + icon) and a terminal `done`. No
 * arrows, no provenance. Used by the onboarding survey to populate the
 * picklist for both the Understand and Edit / Reference branches.
 *
 * The survey is gated behind a loading overlay until this stream
 * resolves, so the picklist is always populated when the user sees it.
 */

import type { CapabilityCandidate } from "../types";
import { dlog } from "../util/debug";
import { STREAM_IDLE_MS as IDLE_MS, withIdleTimeout } from "./idleTimeout";

export type CapabilityScanEvent =
  | { kind: "capability"; data: CapabilityCandidate }
  | { kind: "error"; message: string };

function parseCapabilityLine(line: string): CapabilityScanEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { kind?: unknown; data?: unknown; message?: unknown };
  if (obj.kind === "capability" && obj.data) {
    return { kind: "capability", data: obj.data as CapabilityCandidate };
  }
  if (obj.kind === "error") {
    return {
      kind: "error",
      message: typeof obj.message === "string" ? obj.message : "stream error",
    };
  }
  return null;
}

export async function fetchCapabilityScanStream({
  projectContext,
  signal,
  onEvent,
}: {
  projectContext: string;
  signal: AbortSignal;
  onEvent: (evt: CapabilityScanEvent) => void;
}): Promise<void> {
  // Same inactivity guard as the structure stream: a hung backend
  // otherwise leaves the scan at "loading" forever and the onboarding
  // survey never opens.
  const resp = await withIdleTimeout(
    fetch("/api/diagram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_context: projectContext,
        view: "capability_scan",
      }),
      signal,
    }),
    IDLE_MS,
    "capability scan request",
  );
  if (!resp.body) throw new Error("no response body");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await withIdleTimeout(
      reader.read(),
      IDLE_MS,
      "capability scan stream",
    );
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const evt = parseCapabilityLine(line);
      if (!evt) continue;
      dlog("diagram/capability_scan", evt);
      onEvent(evt);
    }
  }
}
