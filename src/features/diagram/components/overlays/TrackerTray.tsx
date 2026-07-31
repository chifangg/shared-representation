import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { History, X } from "lucide-react";
import type { TrackerEntry } from "../../hooks/useInteractionTracker";
import { TrackerGlyph } from "./TrackerGlyph";

/**
 * The dropdown tray for the interaction tracker: a horizontally scrolling
 * strip of compact CARDS, one per agent-driven diagram change, oldest first.
 *
 * Cards rather than a text list because each change is fundamentally a
 * picture (a block appeared, two blocks joined, a link broke). Each card
 * leads with a small mark for its kind in the block's accent colour, so the
 * strip is scannable by shape and colour before any reading.
 *
 * Width follows the CONTENT up to a two-card cap: one change should not open
 * a tray sized for four. Past the cap the strip scrolls, and it opens scrolled
 * to the newest change, which is the one the user just caused and therefore
 * the one they came to look at.
 *
 * Anchored beneath the Tracker button (measured via `anchorRef`) with a small
 * upward notch, so it reads as belonging to that button. Clicking a card asks
 * the canvas to trace-highlight the affected block(s); it never changes
 * diagram state. A "remove" card is a dead record (its block is gone) so it is
 * shown muted and is not clickable.
 */

/** Card width, the gap between cards, and the strip's horizontal padding.
 *  Cards are deliberately slim (half their earlier width): each is a mark
 *  plus two short lines, and long names loop sideways instead of widening
 *  the card. */
const CARD_W = 74;
const CARD_GAP = 8;
const STRIP_PAD = 28;
/** The widest the tray may get (about four slim cards), then it scrolls. */
const TRAY_MAX_W = 340;
/** Blank run between the two text copies of a looping name, in px. */
const MARQUEE_GAP = 24;

/**
 * Tray width for a given number of cards. Computed rather than left to
 * `width: fit-content`: the strip is a scroll container, whose min-content
 * contribution is zero, so an intrinsically-sized tray collapsed to its
 * border box (measured at 2px) instead of hugging its cards.
 */
function trayWidth(count: number): number {
  if (count === 0) return CARD_W * 2 + STRIP_PAD;
  const content = STRIP_PAD + count * CARD_W + (count - 1) * CARD_GAP;
  return Math.min(content, TRAY_MAX_W);
}

/**
 * Single-line block name that loops sideways when it does not fit its card.
 * The cards are too slim for most names, and a loop keeps the full text
 * readable without growing the card or reserving extra lines. At rest the
 * name sits clipped with a right-edge fade; the loop runs only while the
 * card is hovered (see styles.css), because every card looping at once made
 * the tray shimmer. Two copies of the text ride the same track a fixed gap
 * apart, and one cycle travels exactly one copy's width, so the loop point
 * is invisible. Duration scales with the overflow so long names move at the
 * same speed as short ones. Under prefers-reduced-motion it never loops;
 * the full text stays on the card's tooltip either way.
 */
function MarqueeName({
  text,
  accent,
  strike,
}: {
  text: string;
  accent: string;
  strike: boolean;
}) {
  const outerRef = useRef<HTMLSpanElement | null>(null);
  const [dist, setDist] = useState(0);
  useLayoutEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    // Measured on the static single-copy render: scrollWidth is the full
    // text width even while overflow is clipped.
    const overflow = outer.scrollWidth - outer.clientWidth;
    setDist(overflow > 1 ? outer.scrollWidth + MARQUEE_GAP : 0);
  }, [text]);
  return (
    <span
      ref={outerRef}
      className={`trk-names block text-[11px] font-medium leading-snug ${
        dist > 0 ? "trk-names-clip" : ""
      } ${strike ? "line-through" : ""}`}
      style={{ color: accent }}
    >
      {dist > 0 ? (
        <span
          className="trk-marquee"
          style={
            {
              "--trk-marquee-dist": `${dist}px`,
              "--trk-marquee-dur": `${Math.max(4, dist / 28)}s`,
            } as CSSProperties
          }
        >
          <span className="shrink-0" style={{ paddingRight: MARQUEE_GAP }}>
            {text}
          </span>
          <span
            aria-hidden="true"
            className="shrink-0"
            style={{ paddingRight: MARQUEE_GAP }}
          >
            {text}
          </span>
        </span>
      ) : (
        text
      )}
    </span>
  );
}

export function TrackerTray({
  entries,
  selectedId,
  anchorRef,
  onSelect,
  onClose,
}: {
  entries: TrackerEntry[];
  selectedId: string | null;
  /** The Tracker button this dropdown hangs from; used to position it. */
  anchorRef: RefObject<HTMLButtonElement>;
  onSelect: (e: TrackerEntry) => void;
  onClose: () => void;
}) {
  // Position the dropdown right-aligned under the button. Measured in a
  // layout effect (before paint) and kept fresh on resize; fixed-positioned
  // so it escapes the canvas container and pins to the button in viewport
  // space. The notch is offset from the right to sit under the button.
  const [pos, setPos] = useState<{
    top: number;
    right: number;
    notchRight: number;
  } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const right = Math.max(8, window.innerWidth - r.right);
      setPos({
        top: r.bottom + 8,
        right,
        notchRight: Math.max(12, r.width / 2 - 6),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchorRef]);

  // Open at the START of the history, then run quickly along it to the newest
  // card ("now"). The travel is the point: it shows the user there IS a
  // history behind the change they are looking at, and which direction it
  // runs, which an instant jump to the end hides completely.
  const stripRef = useRef<HTMLOListElement | null>(null);
  // The ride runs ONCE per tray open (the tray unmounts on close). Entries
  // can be appended while the tray sits open (mid-turn diagram ops, the
  // settle delta), and replaying the ride then would yank the strip back to
  // zero mid-read; appended cards get a smooth scroll onto "now" instead.
  // The flag flips only when the ride COMPLETES: StrictMode's dev
  // double-invoke tears the first run down mid-hold, and a flag set at
  // start made the re-invoke skip straight to the end, so the opening
  // pause never showed at all.
  const rideDoneRef = useRef(false);
  // When the current ride began, so a re-run can tell StrictMode's dev
  // double-invoke (teardown and re-run within the same commit, ride
  // barely started: replay the full ride) apart from an entry APPENDED
  // mid-ride (tray open during a streaming turn: glide to the new end
  // instead of yanking the strip back to zero and holding again).
  const rideStartedAtRef = useRef(0);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const target = el.scrollWidth - el.clientWidth;
    if (target <= 0) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (rideDoneRef.current) {
      if (reduced) el.scrollLeft = target;
      else el.scrollTo({ left: target, behavior: "smooth" });
      return;
    }
    const sinceStart = performance.now() - rideStartedAtRef.current;
    if (rideStartedAtRef.current > 0 && sinceStart > 150) {
      rideDoneRef.current = true;
      el.style.scrollSnapType = "";
      if (reduced) el.scrollLeft = target;
      else el.scrollTo({ left: target, behavior: "smooth" });
      return;
    }
    if (reduced) {
      el.scrollLeft = target;
      rideDoneRef.current = true;
      return;
    }
    rideStartedAtRef.current = performance.now();
    // Scroll snap fights the per-frame scrollLeft writes (each write gets
    // coerced toward the nearest snap stop, which reads as stutter), so it
    // is switched off for the ride and restored once the strip lands.
    el.style.scrollSnapType = "none";
    el.scrollLeft = 0;
    let raf = 0;
    let start: number | null = null;
    const DURATION = 520;
    // A beat on the FIRST card before the ride, so the start of the
    // history registers as a place rather than a blur out of the corner
    // of the eye. A long beat on purpose: at 450ms the user reported the
    // start was gone before their eye had landed on it.
    const HOLD_MS = 900;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const t = Math.min(1, Math.max(0, (ts - start - HOLD_MS) / DURATION));
      // Ease-out cubic: quick off the mark, settling gently onto "now".
      el.scrollLeft = target * (1 - Math.pow(1 - t, 3));
      if (t < 1) {
        raf = window.requestAnimationFrame(step);
      } else {
        el.style.scrollSnapType = "";
        rideDoneRef.current = true;
      }
    };
    raf = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(raf);
      el.style.scrollSnapType = "";
    };
  }, [entries.length]);

  return (
    <>
      {/* Upward notch (a fixed sibling above the tray, so the tray keeps
       *  clean clipped corners) so it reads as dropping from the button. */}
      {pos && (
        <span
          aria-hidden="true"
          className="trk-notch fixed z-[71] h-3 w-3 rounded-[2px] border-l border-t border-white/70 bg-[#FBFAF6]"
          style={{ top: pos.top - 6, right: pos.right + pos.notchRight }}
        />
      )}
      <div
        className="trk-drop glass-card fixed z-[70] flex flex-col overflow-hidden rounded-2xl"
        style={{
          top: pos?.top ?? 0,
          right: pos?.right ?? 16,
          width: trayWidth(entries.length),
          maxWidth: "calc(100vw - 24px)",
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {/* The header carries ONLY the close control: the count lives on the
         *  Tracker button badge, and the empty state introduces itself in
         *  the centered body below instead of an awkward header sentence. */}
        <header className="flex items-center justify-end px-2.5 pt-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close tracker"
            className="-mr-1 ml-auto shrink-0 rounded p-0.5 text-[#A8A29E] transition-colors hover:bg-black/[0.05] hover:text-[#484848]"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </header>

        {entries.length === 0 ? (
          // Empty state: a small centered stack (mark, title, one quiet
          // line), not a header sentence with a paragraph hanging under it.
          <div className="flex flex-col items-center gap-1.5 px-4 pb-5 pt-1 text-center">
            <History
              className="h-[18px] w-[18px] text-[#C4BBA9]"
              strokeWidth={1.8}
            />
            <div className="text-[12px] font-medium text-[#6E6353]">
              Nothing tracked yet
            </div>
            <div className="text-[11px] leading-snug text-[#9A938A]">
              Agent changes to the diagram will land here.
            </div>
          </div>
        ) : (
          <ol
            ref={stripRef}
            className="trk-strip flex snap-x snap-mandatory gap-2 overflow-x-auto px-3.5 pb-3.5 pt-0.5"
          >
            {entries.map((e, i) => {
              const isNow = i === entries.length - 1;
              const isSelected = e.id === selectedId;
              const isRemoval = e.kind === "remove";
              const accent = e.chips[0]?.accent ?? "#978B77";
              const names = e.chips.map((c) => c.label).join(" → ");

              const inner = (
                <>
                  {/* Mark and step marker share one row. The slim card has
                      room for one right-hand marker, so the newest card
                      shows the NOW pill INSTEAD of its number. */}
                  <span className="mb-1 flex items-center justify-between gap-1">
                    <span className="h-[18px] w-[18px] shrink-0">
                      <TrackerGlyph kind={e.kind} accent={accent} />
                    </span>
                    {isNow ? (
                      <span className="shrink-0 rounded-full bg-[#EDE6D6] px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-wide text-[#8A7A50]">
                        now
                      </span>
                    ) : (
                      <span className="shrink-0 text-[10px] font-medium tabular-nums text-[#B8B0A4]">
                        {e.seq}
                      </span>
                    )}
                  </span>

                  <span className="block text-[10.5px] leading-snug text-[#8A8276]">
                    {e.verb}
                  </span>
                  <MarqueeName
                    text={names}
                    accent={accent}
                    strike={isRemoval}
                  />
                </>
              );

              const base =
                "trk-card relative flex shrink-0 snap-start flex-col rounded-xl border px-2 py-2 text-left";

              return (
                <li key={e.id} className="flex">
                  {isRemoval ? (
                    <div
                      className={`${base} border-[#EAE5DB] bg-white/40 opacity-70`}
                      style={{ width: CARD_W }}
                      title={`${e.verb} ${names}. This is no longer on the canvas.`}
                    >
                      {inner}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelect(e)}
                      title={`${e.verb} ${names}`}
                      style={{ width: CARD_W }}
                      className={`${base} transition-colors ${
                        isSelected
                          ? "border-[#DCCFB4] bg-[#F5EFE2]"
                          : "border-white/70 bg-white/55 hover:bg-white/85"
                      }`}
                    >
                      {inner}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </>
  );
}
