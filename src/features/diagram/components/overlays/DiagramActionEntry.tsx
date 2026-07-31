import { ArrowRight } from "lucide-react";

export type DiagramActionChip = { label: string; accent: string };

/**
 * The "agent did something on the diagram" record shown inline in the
 * chat transcript (pushed through the core chat-activity channel after a
 * code-editing turn). Same recessed sand material as the agent's other
 * diagram actions, with block chips tinted in their real category accent
 * so the entry ties back to the matching block on the canvas. On mount it
 * flashes a brief blue ring (see `diagram-action-in` in styles.css) to
 * sync with the canvas glow firing at the same moment.
 */
export function DiagramActionEntry({
  verb,
  chips,
  arrow,
  note,
}: {
  verb: string;
  chips: DiagramActionChip[];
  arrow?: boolean;
  /** Optional notice, e.g. "your drawn connection was not kept". Shown as
   *  a small amber line under the chips. */
  note?: string;
}) {
  return (
    // Indented into the agent's lane (past the avatar + timeline rail).
    <div className="flex justify-start pl-[37px]">
      {/* The verb sits on its OWN line above the chips rather than sharing a
       *  wrap row with them. Mixing the two let the first chip ride up beside
       *  the verb while the rest wrapped underneath, so the block never lined
       *  up into a readable column. */}
      <div className="diagram-action-in flex max-w-[92%] flex-col gap-1.5 rounded-[10px] bg-[#ECE1CB] px-3.5 py-2.5 text-[13px] leading-snug text-[#6E6353]">
        <span className="font-medium text-[#544A36]">{verb}</span>
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {chips.map((chip, i) => (
            <span key={i} className="inline-flex min-w-0 items-center gap-1.5">
              {arrow && i > 0 && (
                <ArrowRight
                  size={14}
                  className="shrink-0 text-[#9A8A66]"
                  aria-hidden="true"
                />
              )}
              <span
                title={chip.label}
                className="inline-flex min-w-0 max-w-[190px] items-center gap-1.5 rounded-md border bg-white px-2 py-0.5 text-[11.5px] font-medium"
                style={{ borderColor: chip.accent, color: chip.accent }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-[2px]"
                  style={{ background: chip.accent }}
                />
                {/* truncate needs its own block box: on the flex parent it
                 *  clipped mid-word without ever showing an ellipsis. */}
                <span className="min-w-0 truncate">{chip.label}</span>
              </span>
            </span>
          ))}
        </span>
        {note && (
          <span className="rounded-md border border-[#E0C089] bg-[#FBF3DE] px-2 py-1 text-[11px] leading-snug text-[#8A6D1F]">
            {note}
          </span>
        )}
      </div>
    </div>
  );
}
