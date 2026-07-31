import type { TrackerEntry } from "../../hooks/useInteractionTracker";

/**
 * The small mark on a tracker card: a compact sign for the KIND of change,
 * drawn in the affected block's accent colour.
 *
 * Deliberately slim. An earlier version drew a little scene per change (two
 * plates and an arrow, and so on) inside a bordered plate, which made every
 * card tall and the strip heavy to scan. These are single marks at icon
 * scale, so the card can be read by shape at a glance and stay small.
 */

/** Shared 24x24 box, so every mark has the same optical weight. */
const BOX = 24;

export function TrackerGlyph({
  kind,
  accent,
}: {
  kind: TrackerEntry["kind"];
  accent: string;
}) {
  const stroke = accent;
  return (
    <svg
      viewBox={`0 0 ${BOX} ${BOX}`}
      className="h-full w-full"
      fill="none"
      stroke={stroke}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      role="presentation"
    >
      {/* A new block: the dashed plate it arrives as, plus the "+". */}
      {kind === "add" && (
        <>
          <rect
            x={3.5}
            y={5.5}
            width={17}
            height={13}
            rx={3}
            strokeDasharray="3 2.4"
          />
          <path d="M12 9.5 V14.5 M9.5 12 H14.5" />
        </>
      )}

      {/* A new relationship: a link. */}
      {kind === "link" && (
        <>
          <path d="M10 14 L14 10" />
          <path d="M13.2 7.4 L14.6 6 A3.4 3.4 0 0 1 19.4 10.8 L18 12.2" />
          <path d="M10.8 16.6 L9.4 18 A3.4 3.4 0 0 1 4.6 13.2 L6 11.8" />
        </>
      )}

      {/* A relationship removed: the same link, broken apart. */}
      {kind === "unlink" && (
        <>
          <path d="M13.2 7.4 L14.6 6 A3.4 3.4 0 0 1 19.4 10.8 L18 12.2" />
          <path d="M10.8 16.6 L9.4 18 A3.4 3.4 0 0 1 4.6 13.2 L6 11.8" />
          <path d="M8.6 8.6 L15.4 15.4" opacity={0.45} />
        </>
      )}

      {/* A block rewritten: its text being changed. */}
      {kind === "edit" && (
        <>
          <rect x={3.5} y={5.5} width={17} height={13} rx={3} />
          <path d="M7.5 10.5 H16.5 M7.5 14 H13" opacity={0.75} />
        </>
      )}

      {/* A block recoloured: one swatch replacing another. */}
      {kind === "recolor" && (
        <>
          <rect x={3.5} y={5.5} width={17} height={13} rx={3} />
          <circle cx={10} cy={12} r={2.4} opacity={0.4} />
          <circle cx={15.4} cy={12} r={2.4} fill={accent} strokeWidth={0} />
        </>
      )}

      {/* A capability lifted up into a block of its own. */}
      {kind === "promote" && (
        <>
          <rect x={4.5} y={3.5} width={15} height={8} rx={2.5} />
          <circle cx={12} cy={19} r={2.6} />
          <path d="M12 16 V13" />
        </>
      )}

      {/* A block deleted: struck through. */}
      {kind === "remove" && (
        <>
          <rect x={3.5} y={6} width={17} height={12} rx={3} opacity={0.5} />
          <path d="M6 17.5 L18 6.5" />
        </>
      )}
    </svg>
  );
}
