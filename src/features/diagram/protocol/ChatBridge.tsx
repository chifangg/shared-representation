/**
 * Chat-side bridge components that mediate between Claude's assistant
 * responses and the diagram bus.
 *
 * ChatView renders these inline alongside the assistant's markdown:
 *  - ArrowsAddedSink: invisible component that watches its text prop
 *    for a trailing `added_arrows` JSON and emits "arrows-added" on
 *    the diagram bus once per unique payload.
 *  - OptionsHandoff: visible 1-line UI plus an "options-ready" emit;
 *    surfaces a "look at the canvas → N suggestions" prompt where the
 *    JSON would otherwise have rendered.
 *
 * Both components live in the diagram feature module — they belong
 * with the rest of the protocol code, not in core/. ChatView imports
 * them as small JSX building blocks and remains unaware of the
 * underlying bus topics or JSON shapes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, X } from "lucide-react";
import type { ConnectionOption, EditTarget } from "../types";
import { useDiagramBus, useDiagramBusSubscribe } from "./bus";
import { parseAddedArrowsBlock } from "./parsers";

/**
 * Invisible component: when its `text` contains an `added_arrows`
 * JSON block, emits "arrows-added" on the diagram bus exactly once
 * per unique payload. Lives next to the markdown render so the emit
 * happens as soon as the streaming text settles.
 */
export function ArrowsAddedSink({ text }: { text: string }) {
  const bus = useDiagramBus();
  const parsed = useMemo(() => parseAddedArrowsBlock(text), [text]);
  const key = useMemo(
    () =>
      parsed
        ? parsed.arrows.map((a) => `${a.from}|${a.to}|${a.label}`).join("·")
        : null,
    [parsed],
  );
  const lastKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!parsed || !key) return;
    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;
    bus.emit("arrows-added", { arrows: parsed.arrows });
  }, [parsed, key, bus]);
  return null;
}

/** Stable key for matching outcome events back to this chip's target. */
function targetKeyOf(t: EditTarget): string {
  return t.kind === "arrow"
    ? `arrow:${t.from}->${t.to}`
    : t.kind === "block"
      ? `block:${t.id}`
      : "new-block";
}

/**
 * Chat-side stub for the cards UI. Parses Claude's JSON options
 * inline, but the clickable cards live on the canvas (rendered by the
 * diagram next to the new arrow). This component:
 *   1. Emits "options-ready" on the diagram bus once per unique
 *      (target, options) payload.
 *   2. Shows a minimal "look at the canvas" prompt where the JSON
 *      would otherwise have been.
 *   3. Tracks the round's OUTCOME: once the user picks an option (or
 *      dismisses the overlay), the chip flips to "picked ..." or
 *      "dismissed" so a later scroll-back reads as a settled record,
 *      never as suggestions still waiting on the canvas.
 */
export function OptionsHandoff({
  options,
  target,
}: {
  options: ConnectionOption[];
  target: EditTarget;
}) {
  const bus = useDiagramBus();
  // Cheap content-based key so we only dispatch when the parsed body
  // actually changes (e.g. streaming finishes; React re-renders on
  // every chunk). Without this we'd flood the diagram with duplicate
  // events on every keystroke of Claude's streaming response.
  const targetKey = targetKeyOf(target);
  const optionsKey = useMemo(
    () => `${targetKey}|${options.map((o) => o.title).join("·")}`,
    [targetKey, options],
  );
  const lastSentKeyRef = useRef<string | null>(null);
  const [outcome, setOutcome] = useState<
    null | { kind: "dismissed" } | { kind: "picked"; title: string }
  >(null);
  useEffect(() => {
    if (lastSentKeyRef.current === optionsKey) return;
    lastSentKeyRef.current = optionsKey;
    // A NEW round for this chip resets any outcome from a previous one.
    setOutcome(null);
    bus.emit("options-ready", { target, options });
  }, [optionsKey, target, options, bus]);
  useDiagramBusSubscribe("options-cancelled", (detail) => {
    if (detail && targetKeyOf(detail.target) === targetKey) {
      setOutcome({ kind: "dismissed" });
    }
  });
  useDiagramBusSubscribe("option-executed", (detail) => {
    if (detail && targetKeyOf(detail.target) === targetKey) {
      setOutcome({ kind: "picked", title: detail.option.title });
    }
  });

  // Same material as the agent's other diagram actions (e.g. "refreshed a
  // capability on X"): a sand-toned block recessed into the chat surface,
  // pinned to the agent (left) side. Both are "the agent did something on
  // the diagram", so they read as one family. The dismissed state mutes
  // the whole chip; the picked state names the chosen option.
  return (
    <div
      className={`inline-flex max-w-[92%] items-center gap-2.5 self-start rounded-[10px] bg-[#ECE1CB] px-3.5 py-2.5 text-[13px] leading-snug text-[#6E6353] ${
        outcome?.kind === "dismissed" ? "opacity-60" : ""
      }`}
      style={{
        boxShadow:
          "inset 0 2px 5px rgba(120,98,55,0.22), inset 0 -1px 0 rgba(255,255,255,0.55)",
      }}
    >
      {outcome === null && (
        <>
          <span>
            <span className="font-medium text-[#544A36]">
              {options.length} suggestion{options.length === 1 ? "" : "s"}
            </span>{" "}
            ready on the canvas
          </span>
          <ArrowRight size={14} className="shrink-0 text-[#9A8A66]" />
        </>
      )}
      {outcome?.kind === "dismissed" && (
        <>
          <X size={14} className="shrink-0 text-[#9A8A66]" />
          <span>
            <span className="font-medium text-[#544A36]">
              {options.length} suggestion{options.length === 1 ? "" : "s"}
            </span>{" "}
            dismissed, nothing applied
          </span>
        </>
      )}
      {outcome?.kind === "picked" && (
        <>
          <Check size={14} className="shrink-0 text-[#7A8A5A]" />
          <span>
            Picked{" "}
            <span className="font-medium text-[#544A36]">{outcome.title}</span>
          </span>
        </>
      )}
    </div>
  );
}
