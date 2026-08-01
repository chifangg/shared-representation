import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "@xyflow/react";
import { logEvent } from "@/core/interactionLog";
import {
  X,
  Loader2,
  ArrowRight,
  Check,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import {
  describeFunction,
  previewFunctionChange,
  type FunctionDetailFile,
} from "../../api/fetchFunctionDetail";
import {
  CARD_GAP,
  CARD_MARGIN,
  CARD_RESERVE_H,
  CARD_W,
} from "../../layout/detailCardLayout";

/**
 * Drill-in edit card for a single function bubble.
 *
 * Lifecycle:
 *   1. On open, read the function's real source (describe mode) and show
 *      a plain-language account of what it does. The description is
 *      editable: the user can rewrite it to express the behavior they
 *      want (the "pen").
 *   2. The user types a change and/or edits the description, then asks
 *      for a preview. Preview mode restates, in plain language, what the
 *      behavior will become. It never names files or identifiers: the
 *      confirmation is about the capability change, not the code.
 *   3. On confirm, we hand the composed change up to the parent, which
 *      routes it through the existing block-target visual-edit pipeline
 *      so code is written and the parent block glows.
 *
 * This component is read-only against the project: it never writes code
 * itself. All writes go through the parent's dispatch.
 *
 * Presentation: the card is PULLED OUT of the bubble. It anchors to the
 * bubble in flow space (reprojected each transform tick, like the connection
 * lens), lands beside the bubble on whichever side has room, and a leader line
 * grows from the bubble's rim to the card's near edge. It waits for `settled`
 * (the open zoom-out has finished) before it draws, so nothing skates while
 * the camera is still easing.
 */

type Phase = "loading" | "detail" | "previewing" | "preview" | "error";

/** Card geometry. Imported (never re-declared) so the hook that reframes the
 *  camera on open and this placement always agree about how much room the
 *  card needs; local copies drifted apart and broke the outward direction. */
const GAP = CARD_GAP;
const MARGIN = CARD_MARGIN;
/** Cream leader, matching the connection lens. */
const THREAD = "#CBC1B1";

type Side = "right" | "left" | "top" | "bottom";

/** The card's top-left (pane coords) for a given side of the bubble. Left/right
 *  sit beside the bubble, centred on it vertically; top/bottom sit above/below,
 *  centred on it horizontally. Vertical extent uses the reserved height so a
 *  top card is lifted fully clear before its real height is known. */
function rectForSide(
  side: Side,
  ax: number,
  ay: number,
  rp: number,
  gap: number,
): { left: number; top: number } {
  switch (side) {
    case "right":
      return { left: ax + rp + gap, top: ay - CARD_RESERVE_H / 2 };
    case "left":
      return { left: ax - rp - gap - CARD_W, top: ay - CARD_RESERVE_H / 2 };
    case "top":
      return { left: ax - CARD_W / 2, top: ay - rp - gap - CARD_RESERVE_H };
    case "bottom":
      return { left: ax - CARD_W / 2, top: ay + rp + gap };
  }
}

export function CapabilityDetailCard({
  functionName,
  displayLabel,
  blockLabel,
  files,
  anchor,
  settled,
  onClose,
  onConfirm,
}: {
  functionName: string;
  displayLabel: string;
  blockLabel: string;
  files: FunctionDetailFile[];
  /** Bubble centre + radius in FLOW coords, plus the outward direction the
   *  card should extend (bubble relative to its block/fan centre). */
  anchor: { fx: number; fy: number; r: number; dirX: number; dirY: number };
  /** True once the open zoom-out has settled; the card draws only then. */
  settled: boolean;
  onClose: () => void;
  onConfirm: (finalInstruction: string, summary: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [description, setDescription] = useState("");
  const [behaviors, setBehaviors] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const [previewSummary, setPreviewSummary] = useState("");
  const [error, setError] = useState("");
  // Behaviors are hidden by default: the canvas should stay light on
  // text. The user can expand them when they want more than the one-liner.
  const [showBehaviors, setShowBehaviors] = useState(false);

  // Fetch the description once per function. `files` is read through a
  // ref, NOT the dependency array: the parent recomputes the files array
  // on every render, so depending on its identity would re-fire describe
  // on every parent re-render and make the text flicker. The parent also
  // keys this card by block+function, so a fresh function remounts.
  const filesRef = useRef(files);
  filesRef.current = files;
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    setPhase("loading");
    describeFunction({ functionName, files: filesRef.current })
      .then((res) => {
        if (!aliveRef.current) return;
        setDescription(res.description);
        setBehaviors(res.behaviors);
        setPhase("detail");
      })
      .catch((e) => {
        if (!aliveRef.current) return;
        setError(e instanceof Error ? e.message : "Could not read this function.");
        setPhase("error");
      });
    return () => {
      aliveRef.current = false;
    };
  }, [functionName]);

  // One instruction drives the change. The description above is read-only
  // context (the current behaviour), not a second, competing way to edit.
  const changeText = instruction.trim();
  const canPreview = changeText.length > 0;

  const runPreview = () => {
    if (!canPreview) return;
    // The button disables while previewing, but the Cmd/Ctrl+Enter path
    // lands here directly; without this guard it double-fires the fetch
    // (and the log event) mid-flight.
    if (phase === "previewing") return;
    logEvent("detail-preview", {
      functionName,
      textLen: changeText.length,
    });
    setPhase("previewing");
    setError("");
    previewFunctionChange({ functionName, files, instruction: changeText })
      .then((res) => {
        if (!aliveRef.current) return;
        setPreviewSummary(res.summary);
        setPhase("preview");
      })
      .catch((e) => {
        if (!aliveRef.current) return;
        setError(e instanceof Error ? e.message : "Could not preview the change.");
        setPhase("detail");
      });
  };

  const confirm = () => {
    const base = description.trim()
      ? ` (currently: ${description.trim()})`
      : "";
    const finalInstruction =
      `In the block "${blockLabel}", change the function \`${functionName}\`${base}. ` +
      changeText;
    // Concise chat summary: lead with what the user asked to change, not the
    // block/function boilerplate that the full instruction needs for Claude.
    const summary = changeText || `${displayLabel} behaviour changed`;
    // Logged here, beside detail-preview, so both measure the user's own
    // typed text (the composed instruction adds template boilerplate).
    logEvent("detail-apply", {
      functionName,
      textLen: changeText.length,
    });
    onConfirm(finalInstruction, summary);
  };

  // ONE transform, from the store, drives the bubble anchor, the card
  // placement, and the leader, so the card and its line can never drift apart.
  const tx = useStore((s) => s.transform[0]);
  const ty = useStore((s) => s.transform[1]);
  const zoom = useStore((s) => s.transform[2]);
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);

  // Bubble centre + radius, flow space -> pane space, reprojected each tick.
  const ax = anchor.fx * zoom + tx;
  const ay = anchor.fy * zoom + ty;
  const rp = anchor.r * zoom;

  // The card's real rendered height, so the leader joins its actual near edge.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardH, setCardH] = useState(0);
  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [phase, description, instruction, previewSummary, showBehaviors]);

  // Place the card ONCE, the frame the zoom-out has settled. It extends in the
  // bubble's OUTWARD direction (following the fan into the space it opened): the
  // dominant axis of dirX/dirY picks the side. If that side has no room it falls
  // back to the opposite, then to whichever side is roomiest; the result is
  // always clamped fully into the pane. Frozen in FLOW coords so it then tracks
  // the view.
  const clampX = (l: number) =>
    Math.min(Math.max(l, MARGIN), Math.max(MARGIN, paneW - CARD_W - MARGIN));
  const clampY = (t: number) =>
    Math.min(
      Math.max(t, MARGIN),
      Math.max(MARGIN, paneH - CARD_RESERVE_H - MARGIN),
    );
  // Fan-bulge gap: the fan bulges along the outward axis further than the
  // clicked bubble reaches (its neighbours stick out past it), so add that
  // overshoot to the gap and the card clears the WHOLE fan, not just this
  // bubble. reach = bubble-to-fan-centre distance; its component off the
  // outward axis is exactly how far the fan bulges past this bubble.
  const { dirX, dirY } = anchor;
  const reach = Math.hypot(dirX, dirY);
  const axisComp =
    Math.abs(dirX) >= Math.abs(dirY) ? Math.abs(dirX) : Math.abs(dirY);
  const egap = GAP + Math.max(0, reach - axisComp) * zoom;

  const placedRef = useRef<{ x: number; y: number; side: Side } | null>(null);
  if (placedRef.current === null && settled && paneW > 0 && paneH > 0) {
    // Room from the bubble rim to each pane edge.
    const room: Record<Side, number> = {
      right: paneW - (ax + rp),
      left: ax - rp,
      top: ay - rp,
      bottom: paneH - (ay + rp),
    };
    const need = {
      horiz: CARD_W + egap + MARGIN,
      vert: CARD_RESERVE_H + egap + MARGIN,
    };
    const fitsSide = (s: Side) =>
      s === "right" || s === "left" ? room[s] >= need.horiz : room[s] >= need.vert;
    // Preferred side from the outward vector's dominant axis.
    const preferred: Side =
      Math.abs(dirX) >= Math.abs(dirY)
        ? dirX >= 0
          ? "right"
          : "left"
        : dirY >= 0
          ? "bottom"
          : "top";
    const opposite: Record<Side, Side> = {
      right: "left",
      left: "right",
      top: "bottom",
      bottom: "top",
    };
    const order: Side[] = [
      preferred,
      opposite[preferred],
      ...(["right", "left", "top", "bottom"] as Side[]).sort(
        (a, b) => room[b] - room[a],
      ),
    ];
    const side = order.find(fitsSide) ?? order[2];
    const topLeft = rectForSide(side, ax, ay, rp, egap);
    placedRef.current = {
      x: (clampX(topLeft.left) - tx) / zoom,
      y: (clampY(topLeft.top) - ty) / zoom,
      side,
    };
  }
  const placed = placedRef.current;
  const ready = placed !== null;
  // Reprojected each render, CLAMPED to the pane (same guard as the
  // connection lens note): the note is fixed-pixel text glued to a flow
  // point, and a camera move after placement would otherwise drag it over
  // the pane edge where it clips mid-word.
  const cardLeft = placed ? clampX(placed.x * zoom + tx) : ax;
  const cardTop = placed ? clampY(placed.y * zoom + ty) : ay;
  const side: Side = placed?.side ?? "right";
  const maxHeight = Math.max(220, paneH - cardTop - MARGIN);

  // Leader: from the bubble rim to the card's near edge, meeting it square-on.
  // For a left/right card that edge is vertical (join at the bubble's height);
  // for a top/bottom card it is horizontal (join at the bubble's x). The join
  // is clamped inside the card so it always lands on the edge, not past it.
  const cardBottom = cardTop + Math.max(80, cardH);
  let jx: number;
  let jy: number;
  if (side === "right") {
    jx = cardLeft;
    jy = Math.min(Math.max(ay, cardTop + 20), cardBottom - 20);
  } else if (side === "left") {
    jx = cardLeft + CARD_W;
    jy = Math.min(Math.max(ay, cardTop + 20), cardBottom - 20);
  } else if (side === "top") {
    jx = Math.min(Math.max(ax, cardLeft + 20), cardLeft + CARD_W - 20);
    jy = cardBottom;
  } else {
    jx = Math.min(Math.max(ax, cardLeft + 20), cardLeft + CARD_W - 20);
    jy = cardTop;
  }
  const dx = jx - ax;
  const dy = jy - ay;
  const len = Math.hypot(dx, dy) || 1;
  // Start the drawn line at the bubble's rim, not its centre.
  const sx = ax + (dx / len) * rp;
  const sy = ay + (dy / len) * rp;
  const leaderPath = `M ${sx},${sy} L ${jx},${jy}`;
  const cardOrigin =
    side === "right"
      ? "left center"
      : side === "left"
        ? "right center"
        : side === "top"
          ? "center bottom"
          : "center top";

  return (
    <>
      {/* Transparent dismiss layer, over the diagram pane only. */}
      <div className="absolute inset-0 z-40" onClick={onClose} />

      {/* Leader: one cream line from the bubble to the card. Hidden until the
       *  placement is known, so it never flashes at a stale spot. */}
      {ready && (
        <svg
          className="pointer-events-none absolute inset-0 z-50 h-full w-full"
          aria-hidden="true"
        >
          <path
            className="annot-leader-path"
            d={leaderPath}
            pathLength={1}
            fill="none"
            stroke={THREAD}
            strokeWidth={1.2}
            strokeLinecap="round"
          />
          <circle
            className="annot-leader-dot"
            cx={sx}
            cy={sy}
            r={3}
            fill={THREAD}
          />
        </svg>
      )}

      {/* Annotation, not a card: same written-on-the-canvas language as
       *  the connection lens note (left margin rule, no surface chrome).
       *  The card version read as a floating form; this reads as a note
       *  pulled out of the bubble. */}
      <div
        ref={cardRef}
        className={`bubble-note-halo absolute z-50 flex flex-col border-l-2 border-[#DCD4C4] pl-3.5 ${
          ready ? "bubble-card-in" : ""
        }`}
        style={{
          left: cardLeft,
          top: cardTop,
          width: CARD_W,
          maxHeight,
          transformOrigin: cardOrigin,
          opacity: ready ? undefined : 0,
          pointerEvents: ready ? undefined : "none",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Headline: the block name as a tinted chip (the lens note's
         *  vocabulary) with the capability title under it. */}
        <div className="flex shrink-0 items-start gap-2 pb-1">
          <div className="min-w-0 flex-1">
            <span className="inline-block max-w-full truncate rounded bg-[#EAE4D8] px-1.5 py-0.5 text-[11px] font-medium text-[#6E6353]">
              {blockLabel}
            </span>
            <div className="mt-1 truncate text-[15px] font-semibold text-[#2A2622]">
              {displayLabel}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[#999] transition-colors hover:bg-black/[0.05] hover:text-[#555]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pb-1 pr-1 pt-1">
          {phase === "loading" && (
            <div className="flex items-center gap-2 py-6 text-sm text-[#8A8276]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading this capability…
            </div>
          )}

          {phase === "error" && (
            <div className="py-3 text-sm text-[#A66B49]">
              {error || "Could not read this capability."}
            </div>
          )}

          {(phase === "detail" ||
            phase === "previewing" ||
            phase === "preview") && (
            <>
              {/* What it does: read-only PROSE, not a field. This is context to
                  read, not a second thing to edit. */}
              <p className="text-[13.5px] leading-[1.55] text-[#3A352E]">
                {description}
              </p>

              {behaviors.length > 0 && (
                <div className="mt-2.5">
                  <button
                    onClick={() => setShowBehaviors((v) => !v)}
                    className="flex items-center gap-1 text-[11.5px] text-[#A3A29D] transition-colors hover:text-[#6B6256]"
                  >
                    {showBehaviors ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    {showBehaviors ? "Hide details" : `Details (${behaviors.length})`}
                  </button>
                  {showBehaviors && (
                    <ul className="mt-1.5 space-y-1.5 border-l border-[#EDE7DC] pl-3">
                      {behaviors.map((b, i) => (
                        <li
                          key={i}
                          className="text-[12px] leading-snug text-[#8A8276]"
                        >
                          {b}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* The one action: describe the change. Whitespace (not a
                  rule) separates it from the read-only context above. */}
              <div className="mt-4">
                <label className="mb-1.5 block text-[11px] font-medium text-[#8A7B5C]">
                  What you want to change
                </label>
                <textarea
                  autoFocus
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      (e.metaKey || e.ctrlKey) &&
                      canPreview
                    ) {
                      e.preventDefault();
                      runPreview();
                    }
                  }}
                  rows={2}
                  placeholder="Describe the change…"
                  className="w-full resize-none rounded-lg border border-[#E3DCCD] bg-white/60 px-3 py-2.5 text-[13px] leading-snug text-[#2A2622] outline-none transition-colors placeholder:text-[#B5AFA4] focus:border-[#C9B58E] focus:bg-white/90"
                />
              </div>

              {error && phase !== "preview" && (
                <div className="mt-2 text-[12px] text-[#A66B49]">{error}</div>
              )}

              {/* Preview block. */}
              {phase === "preview" && (
                <div className="mt-3 rounded-lg border border-[#E3DCC9] bg-[#F7F2E6] px-3 py-2.5">
                  <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[#A0894F]">
                    After this change
                  </div>
                  <div className="text-[13px] leading-snug text-[#4A4234]">
                    {previewSummary}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer actions. */}
        {(phase === "detail" ||
          phase === "previewing" ||
          phase === "preview" ||
          phase === "error") && (
          <div className="flex shrink-0 items-center justify-end gap-2 pb-0.5 pr-1 pt-2">
            {phase === "preview" ? (
              <>
                <button
                  onClick={() => setPhase("detail")}
                  className="rounded-lg px-3 py-1.5 text-sm text-[#777] transition-colors hover:bg-[#F0EBE2]"
                >
                  Back
                </button>
                <button
                  onClick={confirm}
                  className="flex items-center gap-1.5 rounded-lg bg-[#A66B49] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#925d3f]"
                >
                  <Check className="h-3.5 w-3.5" />
                  Apply change
                </button>
              </>
            ) : (
              <button
                onClick={runPreview}
                disabled={!canPreview || phase === "previewing"}
                className="flex items-center gap-1.5 rounded-lg bg-[#2A2622] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#403a33] disabled:cursor-not-allowed disabled:bg-[#E4DDD0] disabled:text-[#AFA697]"
              >
                {phase === "previewing" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowRight className="h-3.5 w-3.5" />
                )}
                Preview change
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
