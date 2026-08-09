import { Check, Loader2 } from "lucide-react";
import type {
  CapabilityCandidate,
  CapabilityScanState,
  IntentSelection,
} from "../../types";
import { capabilityIcon } from "../../util/capabilityIcon";

/**
 * Sub-step panels for the IntentSurvey state machine, plus the
 * goal-string composer. Kept together because all three steps + the
 * composer share the same survey-shape types — splitting each into its
 * own file would scatter the survey vocabulary.
 *
 * Both Understand and Edit/Reference pick from the SAME capability_scan
 * candidates (project-specific, not a fixed list), and both are
 * multi-select: the user can pick any number of capabilities to focus,
 * edit, or reference, or describe it in their own words instead.
 */

/**
 * The goal behind the Default card: a study-designed steer, kept to the
 * BIG direction on purpose. An earlier version enumerated every pipeline
 * stage and mechanism; the model then split each named thing into its
 * own block and blew past the prompt's 4-8 cap (~13 blocks). Naming the
 * kind of work instead lets the base prompt's structure rules hold while
 * still pulling the map toward what the tasks touch.
 *
 * It names no feature that only a later task reveals (back-references,
 * numbering resets, merging extensions), so a participant who has read
 * only the first brief learns nothing early. Note a hard limit of the
 * initial map: the files the tasks CREATE (callout.py, panel.py,
 * structure.py) do not exist yet, so the diagram can only show the
 * conversion flow and the existing extension points where that new code
 * will plug in; the task's own modules appear once the participant
 * writes them and the diagram regenerates.
 */
export const DEFAULT_GOAL =
  "I am going to extend this Markdown library: adding new block and " +
  "inline syntaxes, giving elements ids and anchors, cross-referencing " +
  "between parts of a document, and numbering things. Map the codebase " +
  "so I can understand how a document is converted from Markdown to " +
  "HTML and, above all, where extensions plug into that flow, so I can " +
  "see where work like this belongs.";

const SECTION_LABEL = "text-[12px] font-semibold text-[#5C544B]";
const TEXT_FIELD =
  "w-full rounded-xl border border-white/70 bg-white/80 px-3 py-2 text-[13px] text-[#2A2622] outline-none transition-colors placeholder:text-[#B6AC9E] hover:border-[#D8CFC2] focus:border-[#C9B58E]";
const CHIP_IDLE =
  "border border-white/70 bg-white/75 text-[#5C544B] hover:-translate-y-px hover:border-[#C9BFB1] hover:bg-white";
const CHIP_SELECTED = "border border-[#C99E84] bg-[#FBF1EB] text-[#8A5A3C]";

export function composeGoal(params: IntentSelection): string {
  const { verb } = params;
  if (verb === "understand") {
    const labels = params.understandCaps.map((c) => c.label);
    const focusPart = labels.length ? `Focus areas: ${labels.join(", ")}.` : "";
    const detailPart = params.understandText.trim()
      ? `Specifically wants to understand: ${params.understandText.trim()}.`
      : "";
    return ["Wants to understand this codebase.", focusPart, detailPart]
      .filter(Boolean)
      .join(" ");
  }
  if (verb === "edit" || verb === "reference") {
    const target = params.capabilities.length
      ? params.capabilities.map((c) => c.label).join(", ")
      : params.capFreeText.trim();
    return verb === "edit"
      ? `Want to edit: ${target}.`
      : `Looking for a reference of: ${target}.`;
  }
  // "default": the study-designed, task-aligned prompt.
  return DEFAULT_GOAL;
}

/** Short, human-readable "what you picked" line for the intent chip. Just
 *  the targets (the verb is shown separately as a label/icon). */
export function intentSummary(s: IntentSelection): string {
  if (s.verb === "understand") {
    if (s.understandCaps.length)
      return s.understandCaps.map((c) => c.label).join(", ");
    if (s.understandText.trim()) return s.understandText.trim();
    return "the whole codebase";
  }
  if (s.verb === "edit" || s.verb === "reference") {
    if (s.capabilities.length)
      return s.capabilities.map((c) => c.label).join(", ");
    return s.capFreeText.trim();
  }
  return "a ready-made map for working on this codebase";
}

function ScanStatus({ scanState }: { scanState: CapabilityScanState }) {
  if (scanState.kind === "loading" || scanState.kind === "idle") {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-[#E0D9CF] bg-[#FBF7F0] px-3 py-2.5 text-[12px] text-[#8A8178]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
        Analyzing project…
      </div>
    );
  }
  if (scanState.kind === "error") {
    return (
      <div className="rounded-xl border border-[#E4B9A6] bg-[#FBF1EB] px-3 py-2.5 text-[12px] text-[#9C5638]">
        Couldn't scan: {scanState.message}. Describe it below instead.
      </div>
    );
  }
  return null;
}

export function UnderstandStep({
  scanState,
  understandCaps,
  toggleUnderstandCap,
  understandText,
  setUnderstandText,
}: {
  scanState: CapabilityScanState;
  understandCaps: CapabilityCandidate[];
  toggleUnderstandCap: (c: CapabilityCandidate) => void;
  understandText: string;
  setUnderstandText: (s: string) => void;
}) {
  return (
    <div className="survey-rise flex flex-col gap-4">
      <div>
        <div className={`mb-2.5 ${SECTION_LABEL}`}>
          What do you want to see?{" "}
          <span className="font-normal text-[#A89D8E]">
            (pick any that apply)
          </span>
        </div>
        {scanState.kind === "ready" ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {scanState.candidates.map((c, i) => {
              const on = understandCaps.some((x) => x.id === c.id);
              const Icon = capabilityIcon(c.icon, `${c.label} ${c.caption}`);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleUnderstandCap(c)}
                  style={{ animationDelay: `${i * 40}ms` }}
                  className={`survey-rise flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[12.5px] transition-all ${
                    on ? `${CHIP_SELECTED} font-semibold` : `${CHIP_IDLE} font-medium`
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      on ? "text-[#A66B49]" : "text-[#A89D8E]"
                    }`}
                    strokeWidth={2}
                  />
                  <span className="leading-snug">{c.label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <ScanStatus scanState={scanState} />
        )}
      </div>
      <div>
        <div className={`mb-2 ${SECTION_LABEL}`}>
          Anything specific?{" "}
          <span className="font-normal text-[#A89D8E]">(optional)</span>
        </div>
        <textarea
          value={understandText}
          onChange={(e) => setUnderstandText(e.target.value)}
          placeholder="How the data flow works end-to-end"
          rows={2}
          className={`resize-none ${TEXT_FIELD}`}
        />
      </div>
    </div>
  );
}

export function CapabilityStep({
  scanState,
  capabilities,
  toggleCapability,
  clearCapabilities,
  freeText,
  setFreeText,
}: {
  scanState: CapabilityScanState;
  capabilities: CapabilityCandidate[];
  toggleCapability: (c: CapabilityCandidate) => void;
  clearCapabilities: () => void;
  freeText: string;
  setFreeText: (s: string) => void;
}) {
  return (
    <div className="survey-rise flex flex-col gap-3.5">
      <div>
        <div className={`mb-2 ${SECTION_LABEL}`}>
          Pick capabilities{" "}
          <span className="font-normal text-[#A89D8E]">
            (pick any that apply)
          </span>
        </div>
        {scanState.kind === "ready" ? (
          <div className="relative">
            <div className="flex max-h-[256px] flex-col gap-2 overflow-y-auto pb-1.5 pr-1.5">
              {scanState.candidates.map((c, i) => {
                const on = capabilities.some((x) => x.id === c.id);
                const Icon = capabilityIcon(c.icon, `${c.label} ${c.caption}`);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      toggleCapability(c);
                      if (!on) setFreeText("");
                    }}
                    style={{ animationDelay: `${i * 45}ms` }}
                    className={`survey-rise flex items-start gap-3 rounded-xl px-3.5 py-3 text-left transition-all ${
                      on
                        ? `${CHIP_SELECTED} shadow-[0_6px_16px_-10px_rgba(166,107,73,0.6)]`
                        : CHIP_IDLE
                    }`}
                  >
                    {/* Icon rides in a soft circle so the rows share the
                     *  same visual vocabulary as the verb cards. */}
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                        on ? "bg-[#F4E4D8] text-[#A66B49]" : "bg-[#F4F0E8] text-[#A89D8E]"
                      }`}
                    >
                      <Icon className="h-4 w-4" strokeWidth={2} />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13.5px] font-semibold text-[#2A2622]">
                        {c.label}
                      </span>
                      <span className="text-[11.5px] leading-snug text-[#8A8178]">
                        {c.caption}
                      </span>
                    </span>
                    <span
                      className={
                        on
                          ? "ml-auto mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#A66B49] text-white"
                          : "ml-auto mt-0.5 h-5 w-5 shrink-0 rounded-full border-[1.5px] border-[#DDD5C9]"
                      }
                    >
                      {on && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Soft fade hinting the list scrolls past the visible edge. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-xl bg-gradient-to-t from-[#FBFAF6]/90 to-transparent" />
          </div>
        ) : (
          <ScanStatus scanState={scanState} />
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-[#EDE7DD]" />
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[#B6AC9E]">
          or
        </span>
        <span className="h-px flex-1 bg-[#EDE7DD]" />
      </div>
      <input
        value={freeText}
        onChange={(e) => {
          setFreeText(e.target.value);
          if (e.target.value.trim()) clearCapabilities();
        }}
        placeholder="Describe it in your own words"
        className={TEXT_FIELD}
      />
    </div>
  );
}

