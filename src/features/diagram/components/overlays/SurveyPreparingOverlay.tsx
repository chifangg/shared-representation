import { useEffect, useState } from "react";
import type { CapabilityScanState } from "../../types";
import { LoadingMark } from "./LoadingMark";

/**
 * Post-upload intro, kept to almost nothing: the product's own mark looping
 * while the codebase scan (~15s) runs, plus one line of copy. No headline, no
 * spinner, no seconds counter, no paragraph to read. The looping mark is the
 * liveness signal, so a wait of unknown length stays calm without a progress
 * bar that could stall or lie.
 *
 * onReady fires after a short beat so the parent can swap in the survey the
 * moment the scan resolves.
 */

const READY_MS = 1400;

const LINE = "We'll start your diagram with a quick onboarding.";
const LINE_LONG = "Reading your files. This can take a moment.";

export function SurveyPreparingOverlay({
  scanState,
  onReady,
}: {
  scanState: CapabilityScanState;
  onReady: () => void;
}) {
  const [longWait, setLongWait] = useState(false);

  useEffect(() => {
    const ready = window.setTimeout(onReady, READY_MS);
    const long = window.setTimeout(() => setLongWait(true), 12000);
    return () => {
      window.clearTimeout(ready);
      window.clearTimeout(long);
    };
  }, [onReady]);

  const errored = scanState.kind === "error";
  const line = errored
    ? "Could not finish reading. You can still describe what you want."
    : longWait
      ? LINE_LONG
      : LINE;

  return (
    <div className="survey-overlay-in pointer-events-auto absolute inset-0 z-[80] flex items-center justify-center bg-[#2A2622]/28 backdrop-blur-[3px]">
      <div className="edp-plane flex w-[min(400px,calc(100%-48px))] flex-col items-center gap-5 rounded-2xl border border-[#E7E2DA] bg-[#FCFBF9] px-8 py-10 text-center shadow-[0_18px_50px_-24px_rgba(60,53,47,0.35)]">
        <LoadingMark />
        <p
          className="mark-fade-in max-w-[30ch] text-[14.5px] leading-relaxed text-[#5C554B] transition-opacity duration-300"
          style={{ animationDelay: "200ms" }}
        >
          {line}
        </p>
      </div>
    </div>
  );
}
