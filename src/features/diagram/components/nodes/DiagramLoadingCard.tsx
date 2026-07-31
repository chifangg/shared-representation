import { Loader2 } from "lucide-react";
import { ElapsedClock } from "./ElapsedClock";

/**
 * The full-canvas card shown before the first block streams in.
 * Replaced by a small bottom-right chip (in DiagramFetchOverlay) once
 * blocks start arriving so the user can see what's been generated.
 */
export function DiagramLoadingCard({ startedAt }: { startedAt: number }) {
  // Colors follow the app's HEADER chrome (#DCDBD6 band, #33322F ink):
  // this card is chrome talking about progress, not diagram content, so it
  // wears the chrome palette instead of adding one more color family.
  return (
    <div className="glass-card flex w-72 flex-col items-center gap-3 rounded-2xl px-6 py-4">
      <div className="flex items-center gap-2 text-sm">
        <Loader2
          className="h-4 w-4 animate-spin text-[#6E6D68]"
          strokeWidth={2}
        />
        <span className="font-medium text-[#33322F]">
          Claude is drawing the diagram…
        </span>
      </div>
      <div className="flex w-full items-center justify-between text-xs text-[#8A8983]">
        <span>Reading project…</span>
        <ElapsedClock startedAt={startedAt} />
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-[#DCDBD6]/80">
        <div className="h-full w-1/3 animate-[loading-bar_1.4s_ease-in-out_infinite] rounded-full bg-[#8A8983]" />
      </div>
    </div>
  );
}
