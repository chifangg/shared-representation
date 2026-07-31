import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNodes, useStore } from "@xyflow/react";
import type { ConnectionLensDetail, DiagramBlock } from "../../types";
import type { FileEntry } from "@/core/project";
import { NODE_H, NODE_W } from "../../layout/constants";
import {
  describeConnection,
  type ConnectionDetailResult,
} from "../../api/fetchConnectionDetail";
import {
  NOTE_H_RESERVE,
  NOTE_W,
  PILL_CLEAR_X,
  PILL_CLEAR_Y,
  nearestNotePoint,
  placeNote,
  type Rect,
} from "../../util/annotationLayout";

/**
 * What one arrow actually is, written as a MARGIN ANNOTATION on the canvas:
 * a leader line runs from a terminator dot on the clicked verb pill out to a
 * short column of writing placed in open space, the way a technical drawing
 * calls out a part.
 *
 * This replaces a floating inspector card, and the difference is the point.
 * No border, no shadow, no draggable header, no boxed panes with uppercase
 * labels: those are what made the old card read as a generic panel pasted over
 * the diagram. Legibility comes from a feathered paper halo instead.
 *
 * Placement: candidate spots around the anchor are scored by how much they
 * cover existing blocks, and the emptiest wins. Writing in the margin is the
 * whole idea, so landing on top of the drawing defeats it.
 *
 * Anchoring: the click point is converted to FLOW space once, then reprojected
 * on every viewport tick, so panning or zooming drags the dot and redraws the
 * leader. The canvas is deliberately NOT re-centred on open.
 *
 * Read-only: it never writes code.
 */

/** Cream used for the leader line + the margin rule, so the annotation reads
 *  as one quiet neutral mark rather than colour-coded chrome. */
const THREAD = "#CBC1B1";
/** Fallback tint when a block belongs to no scheme group (block-name wash). */
const NEUTRAL = "#A8A29E";
/** Exit animation budget before the overlay actually unmounts. */
const EXIT_MS = 220;

export function ConnectionLensOverlay({
  detail,
  blocks,
  files,
  onClose,
  fromColor,
  toColor,
}: {
  detail: ConnectionLensDetail;
  blocks: DiagramBlock[];
  files: FileEntry[];
  onClose: () => void;
  /** Scheme accent of the source / target block. Null when uncategorized. */
  fromColor: string | null;
  toColor: string | null;
}) {
  const fromBlock = blocks.find((b) => b.id === detail.from);
  const toBlock = blocks.find((b) => b.id === detail.to);

  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [result, setResult] = useState<ConnectionDetailResult>({});
  const [error, setError] = useState("");
  const [exiting, setExiting] = useState(false);
  // How many words of the realization sentence are revealed so far. The note
  // "writes itself" one word at a time, matching the hand-annotation feel,
  // instead of the whole paragraph snapping in at once.
  const [shownWords, setShownWords] = useState(0);
  // The note's top-left, frozen in FLOW coords so it stays glued to the diagram
  // through pans and zooms. Null until computed. Placed provisionally while the
  // note is still a loading skeleton, then re-fitted ONCE the real text has
  // arrived and been measured (see the placement block below).
  const placedFlowRef = useRef<{
    x: number;
    y: number;
    covered: number;
  } | null>(null);
  // The measured note height that the current placement was computed against.
  // Used to detect when the real (post-load) height differs from the skeleton
  // height so we re-fit exactly once, not every frame.
  const placedHRef = useRef(0);
  // When the last placement ran, so drift-triggered re-placements (camera
  // moved far enough that the note would pin to a pane edge) are throttled
  // instead of firing on every pan frame.
  const rePlacedAtRef = useRef(0);
  // The note's real rendered height, needed to know WHICH corner faces the
  // pill. 0 until measured; placement waits for it so the placement and the
  // leader use the SAME height (an estimate would put the join off the corner).
  const noteRef = useRef<HTMLDivElement | null>(null);
  const [noteH, setNoteH] = useState(0);
  useLayoutEffect(() => {
    if (noteRef.current) setNoteH(noteRef.current.offsetHeight);
  }, [state, result.realization, result.uses]);

  // ONE transform, from the store, drives EVERYTHING below: the block rects,
  // the anchor, the placement, and the per-frame reprojection. Because there is
  // a single source, the note and its leader can never drift apart (the earlier
  // two-source snapshot approach let them). Placement is deferred until
  // `settled` so this transform has finished the opening fit-view animation.
  const tx = useStore((s) => s.transform[0]);
  const ty = useStore((s) => s.transform[1]);
  const zoom = useStore((s) => s.transform[2]);
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);
  const nodes = useNodes();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(true), 140);
    return () => window.clearTimeout(t);
  }, []);

  // Blocks in pane space (same transform as the anchor + reprojection). The
  // lens's two ENDPOINT blocks are also returned separately (same object
  // references, as placeNote requires): they stay lit while everything else
  // dims, so placement treats a leader crossing them as expensive but a
  // leader brushing a dimmed background card as cheap.
  const { blockRects, hotRects } = useMemo(() => {
    const all: Rect[] = [];
    const hot: Rect[] = [];
    for (const n of nodes) {
      if (n.type !== "block") continue;
      const m = (n as { measured?: { width?: number; height?: number } })
        .measured;
      const r: Rect = {
        x: n.position.x * zoom + tx,
        y: n.position.y * zoom + ty,
        w: (m?.width ?? NODE_W) * zoom,
        h: (m?.height ?? NODE_H) * zoom,
      };
      all.push(r);
      if (n.id === detail.from || n.id === detail.to) hot.push(r);
    }
    // The bottom corners carry floating chrome (the Add block button with
    // the category legend, and the focus toggle). Reserved so the note
    // never lands underneath them; pane-relative, so no transform.
    if (paneW > 0 && paneH > 0) {
      all.push({ x: 0, y: paneH - 150, w: 260, h: 150 });
      all.push({ x: paneW - 260, y: paneH - 90, w: 260, h: 90 });
    }
    return { blockRects: all, hotRects: hot };
  }, [nodes, zoom, tx, ty, detail.from, detail.to, paneW, paneH]);

  /** Play the retract animation, THEN unmount. */
  const requestClose = useCallback(() => {
    setExiting((already) => {
      if (!already) window.setTimeout(onClose, EXIT_MS);
      return true;
    });
  }, [onClose]);

  // Union of both blocks' files, with content, sent to the backend.
  const detailFiles = useMemo(() => {
    const paths = new Set([
      ...(fromBlock?.provenance?.files ?? []),
      ...(toBlock?.provenance?.files ?? []),
    ]);
    return [...paths]
      .map((p) => files.find((f) => f.path === p))
      .filter((f): f is FileEntry => !!f)
      .map((f) => ({ path: f.path, content: f.content }));
  }, [fromBlock, toBlock, files]);

  const filesRef = useRef(detailFiles);
  filesRef.current = detailFiles;
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    setState("loading");
    if (!fromBlock || !toBlock) {
      setState("error");
      setError("Could not resolve both ends of this link.");
      return;
    }
    describeConnection({
      fromLabel: fromBlock.label,
      toLabel: toBlock.label,
      verb: detail.verb,
      fromCaption: fromBlock.caption,
      toCaption: toBlock.caption,
      files: filesRef.current,
    })
      .then((res) => {
        if (!aliveRef.current) return;
        setResult(res);
        setState("ready");
      })
      .catch((e) => {
        if (!aliveRef.current) return;
        setError(e instanceof Error ? e.message : "Could not read this link.");
        setState("error");
      });
    return () => {
      aliveRef.current = false;
    };
    // The parent keys this overlay by from-to-verb, so this runs once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.from, detail.to, detail.verb]);

  // Esc retracts the annotation, same as clicking away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // Write the realization sentence out one word at a time once it arrives.
  const words = useMemo(
    () => (result.realization ?? "").split(/\s+/).filter(Boolean),
    [result.realization],
  );
  // Guard so an unrelated re-render (a pan, a store tick) never restarts the
  // typewriter mid-sentence, which read as the text flickering.
  const streamedForRef = useRef<string>("");
  useEffect(() => {
    if (state !== "ready") return;
    const text = result.realization ?? "";
    if (!text || streamedForRef.current === text) return;
    streamedForRef.current = text;
    setShownWords(0);
    const count = text.split(/\s+/).filter(Boolean).length;
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setShownWords(i);
      if (i >= count) window.clearInterval(id);
    }, 45);
    return () => window.clearInterval(id);
  }, [state, result.realization]);

  // The edge's own label position, flow space -> pane space. Reprojected on
  // every transform tick, so the dot stays welded to the pill through pans
  // and zooms.
  const ax = detail.fx * zoom + tx;
  const ay = detail.fy * zoom + ty;

  // Choose the note's spot, using the SAME store transform this render draws
  // with, and freeze it in flow coords so it then tracks pans/zooms.
  //
  // It is placed AGAINST a reserved height (not the moment's measured height):
  // during loading the note is only a short skeleton, and placing against that
  // let the finished, taller note overrun the canvas bottom or a block below.
  // Reserving a full footprint keeps the loading spot and the final spot the
  // same for any note that fits the reserve, so it never visibly jumps. We then
  // re-fit exactly once, when the real text has loaded and been re-measured, so
  // an unusually long note (taller than the reserve) is still kept on-canvas.
  const contentFinal = state !== "loading";
  // Clamps shared by the drift check here and the reprojection below.
  const clampNx = (v: number) =>
    Math.min(Math.max(v, 16), Math.max(16, paneW - NOTE_W - 16));
  const clampNy = (v: number) =>
    Math.min(Math.max(v, 16), Math.max(16, paneH - noteH - 16));
  // If the camera has moved so far since placement that the note would sit
  // PINNED to a pane edge (clamped by more than a nudge), the spot it was
  // scored for no longer exists in this view: the pinned card would hang
  // off a stretching leader that crosses whatever scrolled in between,
  // which is exactly the "why is it in the far corner" failure. Re-place
  // against the CURRENT view instead. Throttled so a continuous pan
  // re-picks calmly a few times a second rather than skating every frame.
  let driftedOff = false;
  if (placedFlowRef.current) {
    const rx = placedFlowRef.current.x * zoom + tx;
    const ry = placedFlowRef.current.y * zoom + ty;
    const displaced =
      Math.abs(clampNx(rx) - rx) > 40 || Math.abs(clampNy(ry) - ry) > 40;
    driftedOff =
      displaced && performance.now() - rePlacedAtRef.current > 300;
  }
  const needPlace =
    placedFlowRef.current === null ||
    (contentFinal && noteH !== placedHRef.current) ||
    driftedOff;
  if (settled && noteH > 0 && paneW > 0 && paneH > 0 && needPlace) {
    const placeH = Math.max(noteH, NOTE_H_RESERVE);
    const best = placeNote(blockRects, ax, ay, paneW, paneH, placeH, hotRects);
    placedFlowRef.current = {
      x: (best.x - tx) / zoom,
      y: (best.y - ty) / zoom,
      covered: best.covered,
    };
    placedHRef.current = noteH;
    rePlacedAtRef.current = performance.now();
  }
  const placedFlow = placedFlowRef.current;
  const ready = placedFlow !== null;
  // Reproject to pane space each render, CLAMPED to the pane, so small
  // drifts never carry the card over the edge where it would clip
  // mid-word; big drifts re-place above instead of staying pinned.
  const nx = placedFlow ? clampNx(placedFlow.x * zoom + tx) : ax;
  const ny = placedFlow ? clampNy(placedFlow.y * zoom + ty) : ay;
  // The paper halo only exists to keep ink readable where it lands on a block.
  const needsHalo = (placedFlow?.covered ?? 0) > 400;

  // Leader: join the point on the note's edge NEAREST the pill (never crosses
  // the note, always points straight INTO it), as ONE straight line, exactly the
  // line placeNote scored for clearance.
  const [jx, jy] = ready
    ? nearestNotePoint(nx, ny, NOTE_W, noteH, ax, ay)
    : ([ax, ay] as [number, number]);
  // Begin the drawn line at the pill's box border (not its centre) so it never
  // paints over the verb label; the dot stays on the pill. Cap the trim short of
  // the full segment so a note that lands close to the pill still shows a stub
  // rather than collapsing to nothing.
  const dx = jx - ax;
  const dy = jy - ay;
  const tt = Math.min(
    PILL_CLEAR_X / (Math.abs(dx) || 1e-6),
    PILL_CLEAR_Y / (Math.abs(dy) || 1e-6),
    0.7,
  );
  const sx = ax + dx * tt;
  const sy = ay + dy * tt;
  const leaderPath = `M ${sx},${sy} L ${jx},${jy}`;

  const fromInk = fromColor ?? NEUTRAL;
  const toInk = toColor ?? NEUTRAL;

  const howP = !!result.realization;
  const usesP = !!result.uses && result.uses.length > 0;
  const nothing = state === "ready" && !howP && !usesP;

  return (
    <>
      {/* Click-away. Transparent: the diagram must stay fully visible, since
       *  the whole idea is that the note annotates what you are looking at. */}
      <div className="absolute inset-0 z-40" onClick={requestClose} />

      {/* Leader: one plain cream line from the pill to the note. Hidden until
       *  the placement has been computed, so it never flashes at a stale spot. */}
      {ready && (
        <svg
          className="pointer-events-none absolute inset-0 z-50 h-full w-full"
          aria-hidden="true"
        >
          <path
            className={exiting ? "annot-leader-path-out" : "annot-leader-path"}
            d={leaderPath}
            pathLength={1}
            fill="none"
            stroke={THREAD}
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle
            className={exiting ? "annot-leader-dot-out" : "annot-leader-dot"}
            cx={ax}
            cy={ay}
            r={3}
            fill={THREAD}
          />
        </svg>
      )}

      <div
        ref={noteRef}
        className={`margin-note absolute z-50 pl-3.5 text-[#3A352E] ${
          needsHalo ? "note-halo" : ""
        } ${exiting ? "margin-note-out" : ""}`}
        // Rendered even before placement so it can be MEASURED (height drives
        // corner choice), but kept invisible + off the pointer until the
        // settled placement lands, so it never appears at a stale spot.
        style={{
          left: nx,
          top: ny,
          width: NOTE_W,
          opacity: ready ? undefined : 0,
          pointerEvents: ready ? undefined : "none",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* The margin rule: a plain 2px cream line down the LEFT of the note,
         *  like a blockquote or a margin bar. Always on the left (not the
         *  pill-facing side): when the note lands up-left of the pill, a
         *  right-hand rule ran full-height right beside the pill and read as the
         *  leader overshooting past it. A warm neutral, deliberately NOT the
         *  block accent, keeps it calm and clear of the block colours. */}
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-0 top-0 w-[2px] rounded-full"
          style={{ backgroundColor: "#DCD4C4" }}
        />
        {/* Subject line: each block name carries a soft wash of its scheme
         *  colour behind the text. `-mx-1` cancels the highlight's own padding
         *  so the first word still sits flush with the paragraph below it
         *  (otherwise the wash indented the title by a space). */}
        <p className="mb-2 text-[13px] font-semibold leading-snug">
          <span
            className="rounded px-1 -ml-1 py-[1px]"
            style={{ backgroundColor: `${fromInk}2E` }}
          >
            {fromBlock?.label ?? detail.from}
          </span>
          <span className="px-1 text-[11px] font-normal lowercase text-[#8A8276]">
            {detail.verb}
          </span>
          <span
            className="rounded px-1 py-[1px]"
            style={{ backgroundColor: `${toInk}2E` }}
          >
            {toBlock?.label ?? detail.to}
          </span>
        </p>

        {/* Reserve roughly the finished note's height so the skeleton measures
         *  close to the real text. That keeps the placement it is fitted against
         *  stable, so the note does not shift when its words arrive. */}
        {state === "loading" && (
          <div className="flex min-h-[128px] flex-col gap-[7px] pt-0.5">
            <div className="annot-skeleton-bar w-full" />
            <div
              className="annot-skeleton-bar w-[94%]"
              style={{ animationDelay: "120ms" }}
            />
            <div
              className="annot-skeleton-bar w-[88%]"
              style={{ animationDelay: "240ms" }}
            />
            <div
              className="annot-skeleton-bar w-[68%]"
              style={{ animationDelay: "360ms" }}
            />
            <div
              className="annot-skeleton-bar mt-2 w-[52%]"
              style={{ animationDelay: "480ms" }}
            />
          </div>
        )}

        {state === "error" && (
          <p className="text-[12px] leading-[1.5] text-[#9C5638]">
            {error || "Could not read this link."}
          </p>
        )}

        {nothing && (
          <p className="text-[12px] leading-[1.5] text-[#8A8276]">
            No code-level detail found. This looks like an inferred link.
          </p>
        )}

        {/* The sentence writes itself out word by word, but the FULL text is in
         *  the layout from the first frame (the not-yet-written words are just
         *  invisible), so the note reserves its final footprint immediately and
         *  never grows downward, which was dragging the leader shorter as it
         *  streamed. The caret sits between the written and unwritten words. */}
        {state === "ready" && howP && (
          <p className="break-words text-[12.5px] leading-[1.55] text-[#4A453F]">
            <span>{words.slice(0, shownWords).join(" ")}</span>
            {shownWords < words.length && (
              <span className="mx-[1px] inline-block h-[1em] w-[1.5px] translate-y-[2px] animate-pulse bg-[#B8AFA0] align-baseline" />
            )}
            <span aria-hidden="true" style={{ opacity: 0 }}>
              {(shownWords > 0 ? " " : "") + words.slice(shownWords).join(" ")}
            </span>
          </p>
        )}

        {state === "ready" && usesP && (
          <p
            className="mt-2 text-[12px] leading-[1.55] text-[#6B6256] transition-opacity duration-300"
            style={{ opacity: shownWords >= words.length ? 1 : 0 }}
          >
            Uses{" "}
            {(result.uses ?? []).map((u, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <em className="annot-use">{u}</em>
              </span>
            ))}
          </p>
        )}
      </div>
    </>
  );
}
