import { useEffect, useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { logEvent } from "@/core/interactionLog";
import type { IntentSelection } from "../../types";
import { VERBS } from "./IntentSurvey";
import { intentSummary } from "./IntentSurveySteps";
import { capabilityIcon } from "../../util/capabilityIcon";

/**
 * Compact chip showing the user's current onboarding intent, in the panel
 * header (portaled there from the canvas so it does not cover the diagram).
 *
 * Collapsed it is ONE small button: the verb plus a count. It deliberately
 * does NOT spell the selections out inline. Listing them made the chip run
 * the width of the header and read as a row of separate controls, so it was
 * never clear what was clickable or where to press.
 *
 * Clicking opens a popover that lists exactly what is being emphasized, with
 * a single "Change" action at the bottom that reopens the survey pre-filled.
 * So the chip answers "what am I focused on?" on its own, and only the
 * explicit Change re-enters the flow (looking never regenerates).
 */
export function IntentChip({
  intent,
  onEdit,
}: {
  intent: IntentSelection;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Keep the popover mounted through its close animation, then drop it.
  const [render, setRender] = useState(false);
  useEffect(() => {
    if (open) {
      setRender(true);
      return;
    }
    if (!render) return;
    const t = window.setTimeout(() => setRender(false), 150);
    return () => window.clearTimeout(t);
  }, [open, render]);
  const meta = VERBS.find((v) => v.value === intent.verb);
  const Icon = meta?.icon;
  // Discrete selections that can be listed. Free-text verbs (or free-text
  // answers) fall back to a plain summary string inside the popover.
  const caps =
    intent.verb === "understand"
      ? intent.understandCaps
      : intent.verb === "edit" || intent.verb === "reference"
        ? intent.capabilities
        : [];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          // Consulting the intent chip is a pure inspection act; the study
          // wants to see who checks their stated focus and how often.
          logEvent("intent-chip-toggle", { open: !open });
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        title="Your current focus. Click to see what the diagram is emphasizing."
        className={`flex items-center gap-1.5 rounded-full py-1 pl-1.5 pr-2 transition-colors ${
          open
            ? "rounded-bl-none bg-black/[0.07]"
            : "hover:bg-black/[0.05]"
        }`}
      >
        {Icon && meta && (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
            style={{ background: meta.tint, color: meta.accent }}
          >
            <Icon className="h-3 w-3" strokeWidth={2.2} />
          </span>
        )}
        <span
          className="text-[12px] font-semibold leading-none"
          style={{ color: meta?.accent }}
        >
          {meta?.label}
        </span>
        {caps.length > 0 && (
          <span className="rounded-full bg-black/[0.07] px-1.5 text-[10px] font-medium leading-4 text-[#6E6D68]">
            {caps.length}
          </span>
        )}
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-[#8C8B87] transition-transform ${
            open ? "rotate-180" : ""
          }`}
          strokeWidth={2.5}
        />
      </button>

      {render && (
        <>
          {/* Click-away catcher. */}
          <div
            className="fixed inset-0 z-[59]"
            onClick={() => {
              logEvent("intent-chip-toggle", { open: false });
              setOpen(false);
            }}
          />
          {/* Flush against the chip (no gap) and sharing its left edge, so the
           *  two read as one surface. Grows down out of the chip on open and
           *  folds back up on close (transform-origin at the top). */}
          <div
            className={`absolute left-0 top-full z-[60] w-64 overflow-hidden rounded-b-xl rounded-tr-xl border border-[#E7E4DD] bg-white shadow-[0_10px_28px_-8px_rgba(60,53,47,0.18)] ${
              open ? "intent-pop-in" : "intent-pop-out"
            }`}
          >
            {/* Header: just the label + the single change action. No tint, no
             *  leading icon: kept colourless on purpose so nothing here reads
             *  as tied to a block colour (those may be re-tuned). */}
            <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[#9A968D]">
                Emphasizing
              </span>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onEdit();
                }}
                title="Change what is emphasized"
                aria-label="Change what is emphasized"
                className="-mr-1 flex h-6 w-6 items-center justify-center rounded-md text-[#A3A29D] transition-colors hover:bg-black/[0.06] hover:text-[#3A3A38]"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </div>
            {/* Selected capabilities: black label, its own type icon trailing.
             *  The icon (not a colour) is what distinguishes them, so the list
             *  stays legible whatever the category colours become. */}
            <div className="px-1.5 pb-1.5">
              {caps.length > 0 ? (
                caps.map((c) => {
                  const CapIcon = capabilityIcon(
                    c.icon,
                    `${c.label} ${c.caption ?? ""}`,
                  );
                  return (
                    <div
                      key={c.id}
                      className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5"
                    >
                      <span className="min-w-0 break-words text-[12.5px] leading-snug text-[#2C2A26]">
                        {c.label}
                      </span>
                      <CapIcon
                        className="h-3.5 w-3.5 shrink-0 text-[#9A968D]"
                        strokeWidth={2}
                      />
                    </div>
                  );
                })
              ) : (
                <div className="px-2 py-1.5 text-[12.5px] leading-snug text-[#2C2A26]">
                  {intentSummary(intent)}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
