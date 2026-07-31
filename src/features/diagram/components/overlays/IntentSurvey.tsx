import { BookOpen, Copy, MessageCircle, PenLine, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type {
  CapabilityCandidate,
  CapabilityScanState,
  IntentSelection,
  IntentVerb,
} from "../../types";
import {
  CapabilityStep,
  OtherStep,
  UnderstandStep,
  composeGoal,
} from "./IntentSurveySteps";

/**
 * Onboarding survey modal. Blocks the diagram structure fetch until the
 * user answers two questions:
 *
 *   1. Verb — Understand / Edit / Reference / Other
 *   2. Branched follow-up:
 *      - Understand → role multi-select + optional detail text
 *      - Edit / Reference → pick one or more capability candidates
 *        (from the parallel capability_scan) OR free text
 *      - Other → free text
 *
 * The composed goal string flows into buildProjectContext as `<user_goal>`,
 * shaping the capability-centric overview prompt.
 *
 * State is internal; parent only sees the final composed goal via
 * onComplete. Mounting/unmounting the survey resets its state.
 */

type VerbSpec = {
  value: IntentVerb;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Warm tint for the icon chip background. */
  tint: string;
  /** Warm accent for the icon glyph. */
  accent: string;
};

export const VERBS: VerbSpec[] = [
  {
    value: "understand",
    label: "Understand",
    hint: "Get oriented in this codebase",
    icon: BookOpen,
    tint: "#F3ECDD",
    accent: "#B8995A",
  },
  {
    value: "edit",
    label: "Edit",
    hint: "Modify or extend something",
    icon: PenLine,
    tint: "#F4E6DE",
    accent: "#B57A57",
  },
  {
    value: "reference",
    label: "Reference",
    hint: "Borrow a pattern for my own project",
    icon: Copy,
    tint: "#E8EDE3",
    accent: "#7C8C63",
  },
  {
    value: "other",
    label: "Other",
    hint: "Tell me in your own words",
    icon: MessageCircle,
    tint: "#ECE9E4",
    accent: "#8A8178",
  },
];

export function IntentSurvey({
  scanState,
  onComplete,
  initialSelection,
  onCancel,
}: {
  scanState: CapabilityScanState;
  onComplete: (goal: string, selection: IntentSelection) => void;
  /** Pre-fill the survey when revising an existing intent (vs first-time
   *  onboarding, where everything starts empty). */
  initialSelection?: IntentSelection;
  /** When provided, the survey is dismissable (revise mode): backdrop
   *  click or the X closes it without changing anything. Absent during
   *  first-time onboarding, which must be answered. */
  onCancel?: () => void;
}) {
  const [verb, setVerb] = useState<IntentVerb | null>(
    initialSelection?.verb ?? null,
  );
  const [understandCaps, setUnderstandCaps] = useState<CapabilityCandidate[]>(
    initialSelection?.understandCaps ?? [],
  );
  const [understandText, setUnderstandText] = useState(
    initialSelection?.understandText ?? "",
  );
  const [capabilities, setCapabilities] = useState<CapabilityCandidate[]>(
    initialSelection?.capabilities ?? [],
  );
  const [capFreeText, setCapFreeText] = useState(
    initialSelection?.capFreeText ?? "",
  );
  const [otherText, setOtherText] = useState(initialSelection?.otherText ?? "");

  const toggleUnderstandCap = (c: CapabilityCandidate) =>
    setUnderstandCaps((prev) =>
      prev.some((x) => x.id === c.id)
        ? prev.filter((x) => x.id !== c.id)
        : [...prev, c],
    );

  const toggleCapability = (c: CapabilityCandidate) =>
    setCapabilities((prev) =>
      prev.some((x) => x.id === c.id)
        ? prev.filter((x) => x.id !== c.id)
        : [...prev, c],
    );

  const canSubmit = (() => {
    if (verb === "understand")
      return understandCaps.length > 0 || understandText.trim().length > 0;
    if (verb === "edit" || verb === "reference")
      return capabilities.length > 0 || capFreeText.trim().length > 0;
    if (verb === "other") return otherText.trim().length > 0;
    return false;
  })();

  const handleSubmit = () => {
    if (!verb || !canSubmit) return;
    const selection: IntentSelection = {
      verb,
      understandCaps,
      understandText,
      capabilities,
      capFreeText,
      otherText,
    };
    const goal = composeGoal(selection);
    if (!goal.trim()) return;
    onComplete(goal, selection);
  };

  const activeVerb = VERBS.find((v) => v.value === verb) ?? null;

  return (
    <div
      className="survey-overlay-in pointer-events-auto absolute inset-0 z-[80] flex items-center justify-center bg-[#2A2622]/30 backdrop-blur-[3px]"
      onMouseDown={(e) => {
        if (onCancel && e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="survey-card-in relative w-[min(660px,calc(100%-48px))] overflow-hidden rounded-[22px] border border-[#E7E2DA] bg-[#FCFBF9] shadow-[0_24px_70px_-20px_rgba(60,53,47,0.45)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Warm header band with a soft sand to paper gradient. */}
        <div className="bg-gradient-to-br from-[#F6F0E6] to-[#FCFBF9] px-6 pb-4 pt-5">
          <div className="flex items-center justify-between">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#A89D8E]">
              {verb ? "Tell us a bit more" : "Before we draw"}
            </div>
            <div className="flex items-center gap-2.5">
              <StepDots step={verb ? 2 : 1} />
              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  title="Close"
                  className="-mr-1 rounded-lg p-1 text-[#A89D8E] transition-colors hover:bg-[#F1ECE4] hover:text-[#5C544B]"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-2.5">
            {activeVerb && (
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                style={{ background: activeVerb.tint, color: activeVerb.accent }}
              >
                <activeVerb.icon className="h-[15px] w-[15px]" strokeWidth={2.2} />
              </span>
            )}
            <div className="text-[16px] font-semibold leading-snug text-[#2A2622]">
              {verb
                ? "Your answer shapes which capabilities get emphasized."
                : "What do you want to do with this codebase?"}
            </div>
          </div>
        </div>

        <div className="px-6 pb-6 pt-1">
          {!verb && (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {VERBS.map((v, i) => (
                <button
                  key={v.value}
                  type="button"
                  onClick={() => setVerb(v.value)}
                  style={{ animationDelay: `${i * 55}ms` }}
                  className="survey-rise group flex items-start gap-3 rounded-2xl border border-[#E7E2DA] bg-white px-3.5 py-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-[#D8CFC2] hover:shadow-[0_10px_26px_-14px_rgba(60,53,47,0.5)]"
                >
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105"
                    style={{ background: v.tint, color: v.accent }}
                  >
                    <v.icon className="h-[18px] w-[18px]" strokeWidth={2} />
                  </span>
                  <span className="flex flex-col gap-0.5 pt-0.5">
                    <span className="text-[13.5px] font-semibold text-[#2A2622]">
                      {v.label}
                    </span>
                    <span className="text-[11.5px] leading-snug text-[#8A8178]">
                      {v.hint}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {verb === "understand" && (
            <UnderstandStep
              scanState={scanState}
              understandCaps={understandCaps}
              toggleUnderstandCap={toggleUnderstandCap}
              understandText={understandText}
              setUnderstandText={setUnderstandText}
            />
          )}

          {(verb === "edit" || verb === "reference") && (
            <CapabilityStep
              scanState={scanState}
              capabilities={capabilities}
              toggleCapability={toggleCapability}
              clearCapabilities={() => setCapabilities([])}
              freeText={capFreeText}
              setFreeText={setCapFreeText}
            />
          )}

          {verb === "other" && (
            <OtherStep text={otherText} setText={setOtherText} />
          )}

          {verb && (
            <div className="mt-5 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setVerb(null)}
                className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-[#8A8178] transition-colors hover:bg-[#F1ECE4] hover:text-[#5C544B]"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="rounded-xl bg-gradient-to-b from-[#B57A57] to-[#A66B49] px-4 py-2 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_-6px_rgba(166,107,73,0.7)] transition-all duration-200 hover:from-[#A66B49] hover:to-[#955d3e] hover:shadow-[0_8px_20px_-6px_rgba(166,107,73,0.8)] disabled:cursor-not-allowed disabled:from-[#E0D9CF] disabled:to-[#E0D9CF] disabled:text-[#B6AC9E] disabled:shadow-none"
              >
                Generate diagram
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Two-step progress affordance in the header. */
function StepDots({ step }: { step: 1 | 2 }) {
  return (
    <div className="flex items-center gap-1.5">
      {[1, 2].map((n) => (
        <span
          key={n}
          className="h-1.5 rounded-full transition-all duration-300"
          style={{
            width: n === step ? 16 : 6,
            background: n <= step ? "#B57A57" : "#DDD5C9",
          }}
        />
      ))}
    </div>
  );
}
