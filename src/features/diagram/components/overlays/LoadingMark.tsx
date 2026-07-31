/**
 * The loading mark: three capability blocks wired into a loop, with a single
 * clay point travelling the wiring, so the product's own metaphor (an
 * architecture graph being connected) IS the loading animation.
 *
 * It is a seamless infinite loop, NOT a scripted timeline, so it stays alive
 * and calm for a wait of unknown length without ever "finishing" while the
 * scan is still running.
 *
 * Standalone on purpose: swap this component for a real brand logo later and
 * nothing else about the intro changes.
 */
export function LoadingMark({ size = 76 }: { size?: number }) {
  // Rounded-triangle path through the three node centres. pathLength=100 lets
  // the travelling dash be defined in resolution-independent units.
  const RING = "M18,26 L58,18 L48,60 Z";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 76 76"
      fill="none"
      role="img"
      aria-label="Preparing your diagram"
    >
      {/* Faint wiring the point travels along. */}
      <path
        d={RING}
        pathLength={100}
        stroke="#DAD4C8"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {/* The travelling clay point: a short dash chasing round the loop. */}
      <path
        className="mark-comet"
        d={RING}
        pathLength={100}
        stroke="#A66B49"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="13 87"
      />
      {/* Three blocks at the corners; each breathes gently, staggered, so the
       *  graph feels alive without anything spinning. One carries the clay
       *  accent, echoing that blocks are the only real colour on the canvas. */}
      <g className="mark-node" style={{ animationDelay: "0ms" }}>
        <rect x="10" y="20" width="16" height="12" rx="3.5" fill="#F4F0E8" stroke="#C7BEAE" strokeWidth={1.5} />
      </g>
      <g className="mark-node" style={{ animationDelay: "520ms" }}>
        <rect x="50" y="12" width="16" height="12" rx="3.5" fill="#F3E7DE" stroke="#B98C74" strokeWidth={1.5} />
      </g>
      <g className="mark-node" style={{ animationDelay: "1040ms" }}>
        <rect x="40" y="54" width="16" height="12" rx="3.5" fill="#F4F0E8" stroke="#C7BEAE" strokeWidth={1.5} />
      </g>
    </svg>
  );
}
