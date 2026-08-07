/**
 * Owns the capability_scan fetch lifecycle.
 *
 * Fires on USER-initiated project change (projectKey bump) and produces
 * a CapabilityScanState for the onboarding survey to consume. The survey
 * stays gated behind a loading overlay until this reaches `ready`/`error`
 * (see DiagramCanvas) — both survey branches pick from these candidates,
 * so opening before they arrive would show an empty picklist.
 *
 * Mirrors the filesKey + cleanup-via-abort pattern from
 * useDiagramStructureFetch; same caveat about omitting `state.kind`
 * from the deps array (would cause the abort-then-rerun cycle).
 */

import { useEffect, useMemo, useState } from "react";
import { logEvent } from "@/core/interactionLog";
import type { FileEntry } from "@/core/project";
import type { CapabilityCandidate, CapabilityScanState } from "../types";
import { buildScanContext, findSummaryDoc } from "../api/buildProjectContext";
import { fetchCapabilityScanStream } from "../api/fetchCapabilityScan";

export function useCapabilityScan({
  projectKey,
  files,
}: {
  projectKey: number;
  files: FileEntry[];
}): CapabilityScanState {
  const [state, setState] = useState<CapabilityScanState>({ kind: "idle" });

  const filesKey = useMemo(
    () =>
      files
        .map((f) => f.path)
        .sort()
        .join("|"),
    [files],
  );

  // Reset on USER-initiated project change.
  useEffect(() => {
    setState({ kind: "idle" });
  }, [projectKey]);

  useEffect(() => {
    if (files.length === 0) return;
    if (state.kind !== "idle") return;

    setState({ kind: "loading", startedAt: Date.now() });
    const controller = new AbortController();
    // Onboarding scan: read a trusted architecture doc (CLAUDE.md /
    // AGENTS.md) + tree when present instead of the whole codebase.
    // Falls back to full context otherwise.
    const summaryDoc = findSummaryDoc(files);
    // Record which context the scan used, so it's verifiable from the
    // interaction log whether a CLAUDE.md / AGENTS.md was read instead of the
    // full codebase (otherwise this frontend decision leaves no trace).
    logEvent(
      "capability-scan",
      {
        usedSummaryDoc: summaryDoc !== null,
        docPath: summaryDoc?.path ?? null,
        fileCount: files.length,
      },
      // A fetch decision, not a user action: keep it OUT of the
      // source="user" slice the engagement analysis filters on.
      "system",
    );
    const projectContext = buildScanContext(files);
    const candidates: CapabilityCandidate[] = [];

    (async () => {
      let errorMessage: string | null = null;
      try {
        await fetchCapabilityScanStream({
          projectContext,
          signal: controller.signal,
          onEvent: (evt) => {
            if (evt.kind === "capability") {
              candidates.push(evt.data);
            } else if (evt.kind === "error") {
              errorMessage = evt.message;
            }
          },
        });
        if (controller.signal.aborted) return;
        if (errorMessage) {
          setState({ kind: "error", message: errorMessage });
        } else if (candidates.length === 0) {
          // A dead backend behind the dev proxy answers 500 with an HTML
          // page: the stream "succeeds" with zero events, which used to
          // render as a silently EMPTY capability list. Zero candidates is
          // never a real outcome for a scanned codebase, so surface it as
          // a failure with a hint instead.
          setState({
            kind: "error",
            message: "the scan returned nothing (is the backend running?)",
          });
        } else {
          setState({ kind: "ready", candidates });
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setState({ kind: "error", message: String(e) });
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey]);

  return state;
}
