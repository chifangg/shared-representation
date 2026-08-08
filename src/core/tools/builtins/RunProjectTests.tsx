import { useEffect, useRef } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import type { ClientToolProps } from "@/core/tools/registry";
import { useProject } from "@/core/project";

interface RunProjectTestsInput {
  /** Optional pytest target forwarded to the backend runner. */
  selector?: string;
}

type RunProjectTestsResult =
  | {
      ok: boolean;
      exit_code: number | null;
      output: string;
      duration_ms: number;
    }
  | { ok: false; error: string };

/** Generous client-side ceiling over the backend's own per-step
 *  timeouts (venv 120s + pip 300s + pytest 300s worst case). */
const FETCH_TIMEOUT_MS = 360_000;

/**
 * Client tool handler for `run_project_tests`: posts the CURRENT
 * in-memory project to the backend's isolated pytest sandbox and
 * resolves with the run's output. The browser is the source of truth
 * for file contents (the agent's edits land here first), so the
 * sandbox always tests exactly what the agent just wrote, even if the
 * disk sync is still in flight.
 */
export function RunProjectTests({
  input,
  resolve,
}: ClientToolProps<RunProjectTestsInput, RunProjectTestsResult>) {
  const { files } = useProject();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const controller = new AbortController();
    const timer = window.setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS,
    );
    (async () => {
      try {
        const resp = await fetch("/api/run-tests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: files.map((f) => ({ path: f.path, content: f.content })),
            ...(input.selector ? { selector: input.selector } : {}),
          }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          resolve({
            ok: false,
            error: `test runner responded ${resp.status} (is the backend running?)`,
          });
          return;
        }
        resolve((await resp.json()) as RunProjectTestsResult);
      } catch (e) {
        resolve({
          ok: false,
          error:
            controller.signal.aborted
              ? `test run exceeded ${FETCH_TIMEOUT_MS / 1000}s`
              : `test run failed: ${String(e).slice(0, 200)}`,
        });
      } finally {
        window.clearTimeout(timer);
      }
    })();
    // Snapshot semantics: the run uses the files as of the call. Deps
    // stay empty on purpose; a mid-run file change belongs to the NEXT run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex items-center gap-2 rounded-md border border-[#78716C]/20 bg-[#F5F5F4] px-3 py-1.5 text-xs text-[#78716C]">
      <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
      <FlaskConical className="h-3 w-3" strokeWidth={2} />
      <span className="truncate">
        running tests{input.selector ? `: ${input.selector}` : ""}
      </span>
    </div>
  );
}
