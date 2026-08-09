import { AlertCircle, Loader2, Upload } from "lucide-react";
import type { FetchState } from "../../types";
import { DiagramLoadingCard } from "../nodes/DiagramLoadingCard";
import { ElapsedClock } from "../nodes/ElapsedClock";

/**
 * Loading / streaming / error overlay states for the diagram canvas.
 *
 * Layouts:
 *  - no project yet → centered "upload a project" prompt
 *  - state.loading + no nodes yet → full-canvas blur + DiagramLoadingCard
 *  - state.loading + nodes streaming → bottom-right chip with count
 *  - state.error → centered red alert with Retry button
 *  - otherwise → renders nothing
 */
export function DiagramFetchOverlay({
  state,
  hasFiles,
  nodeCount,
  onRetry,
}: {
  state: FetchState;
  hasFiles: boolean;
  nodeCount: number;
  onRetry: () => void;
}) {
  // Before any project exists the canvas is a blank grid, so the
  // "upload something" nudge lives here rather than in the chat panel:
  // the empty diagram is the biggest thing on screen, and the Files
  // rail it points at sits directly beside it.
  if (!hasFiles) {
    return (
      <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 px-4 text-center text-sm text-[#9A9081]">
        <Upload size={28} className="opacity-40" />
        <p>Upload a project in the Files panel to begin.</p>
      </div>
    );
  }

  if (state.kind === "loading") {
    // Once any blocks have arrived, drop the full-canvas blur so the
    // user can actually see what's been generated. Replace it with a
    // small bottom-right chip indicating Claude is still streaming.
    if (nodeCount > 0) {
      // Header-chrome material (#DCDBD6 band, #33322F ink), sized up a
      // step from the old white pill that vanished against the canvas.
      // Progress indicators are chrome, so they wear the chrome palette
      // instead of introducing yet another color family.
      return (
        <div className="pointer-events-none absolute bottom-3 right-3 z-50 flex items-center gap-2 rounded-full border border-[#C9C8C3] bg-[#DCDBD6] px-3.5 py-2 text-[12.5px] text-[#5A5954] shadow-[0_8px_20px_-8px_rgba(51,50,47,0.4)]">
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-[#6E6D68]"
            strokeWidth={2}
          />
          <span>
            Generating more ·{" "}
            <span className="font-semibold text-[#33322F]">{nodeCount}</span>{" "}
            so far
          </span>
          <ElapsedClock startedAt={state.startedAt} />
        </div>
      );
    }
    return (
      // Same warm scrim as the gate and survey overlays. The old pale
      // white wash left NOTHING for the frosted card to show through, so
      // the glass read as a plain white rectangle.
      <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-[#2A2622]/25 backdrop-blur-[2px]">
        <DiagramLoadingCard startedAt={state.startedAt} />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="absolute inset-0 z-50 flex items-center justify-center px-4">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-red-200 bg-white px-6 py-4 shadow-md">
          <AlertCircle className="h-5 w-5 text-red-500" strokeWidth={2} />
          <span className="text-center text-sm text-[#484848]">
            {state.message}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md bg-[#484848] px-3 py-1 text-xs font-medium text-white hover:bg-[#222]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return null;
}
