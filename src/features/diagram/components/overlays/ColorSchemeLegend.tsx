import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Check,
  Palette,
  Sparkles,
  Loader2,
  ArrowRight,
} from "lucide-react";
import type { DiagramBlock } from "../../types";
import { presentGroups, type ColorScheme } from "../../color/scheme";

/**
 * Slim color key pinned to the bottom-left of the canvas, driven by the
 * active color scheme.
 *
 * At rest it is the lean legend: the active encoding's name as a header
 * (click to expand each row's definition) plus the present groups. A
 * small round palette button on the top-right corner advertises that the
 * encoding is switchable.
 *
 * Pressing the palette button enters "picking" mode, which mirrors the
 * block-focus affordance: the rest of the canvas dims + blurs behind a
 * scrim, the legend lifts and scales up, and a small picker window floats
 * above it listing the available encodings. Choosing one recolors the
 * blocks and swaps these rows in lockstep.
 */
export function ColorSchemeLegend({
  schemes,
  active,
  onSelect,
  blocks,
  onGenerate,
  generating,
  genError,
  onClearGenError,
  topAccessory,
}: {
  schemes: ColorScheme[];
  active: ColorScheme;
  onSelect: (id: string) => void;
  blocks: DiagramBlock[];
  /** Generate a scheme. null instruction = let the model pick the
   *  encoding; non-empty = honor the user's described grouping. */
  onGenerate: (instruction: string | null) => void;
  generating: boolean;
  genError: string | null;
  onClearGenError: () => void;
  /** Rendered as a stacked control directly ABOVE the legend card (e.g. the
   *  "Add block" button), sharing this bottom-left corner. Hidden while the
   *  encoding picker is open so the picker popover has room. */
  topAccessory?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState("");

  const submitDraft = () => {
    const t = draft.trim();
    if (!t || generating) return;
    onGenerate(t);
    setDraft("");
  };
  // Picking auto-opens the full (definitions-shown) legend; closing it
  // falls back to the manual expand toggle.
  const showDefs = expanded || picking;

  const items = useMemo(
    () =>
      presentGroups(
        active,
        blocks.map((b) => ({
          id: b.id,
          label: b.label,
          category: b.category,
          fileCount: b.provenance.files.length,
        })),
      ),
    [active, blocks],
  );

  if (items.length === 0) return null;

  return (
    <>
      {/* Scrim: dims + blurs the canvas behind the legend, same focus cue
       *  as a clicked block. Click anywhere to dismiss. z-[45] so it also
       *  covers the focus-mode toggle (z-40, anchored to the outer container),
       *  which would otherwise stay clickable over the scrim; still below the
       *  legend stack (z-50) so the picker itself stays interactive. */}
      {picking && (
        <div
          className="absolute inset-0 z-[45] bg-black/10 backdrop-blur-[2px]"
          onClick={() => setPicking(false)}
        />
      )}

      {/* Bottom-left stack: the optional accessory (Add block) sits above the
       *  legend card. The scrim above is a SEPARATE sibling so it keeps
       *  covering the whole canvas, not just this corner. */}
      <div className="absolute bottom-4 left-4 z-50 flex flex-col items-start gap-2.5">
        {!picking && topAccessory}
        <div
          className={`relative rounded-lg border bg-[#FCFBF9]/95 px-2.5 py-2 backdrop-blur-sm transition-all duration-200 ${
            showDefs ? "w-56" : ""
          } ${
            picking
              ? "scale-[1.04] border-[#D2CABB] shadow-lg"
              : "border-[#E7E2DA] shadow-sm"
          }`}
          style={{ transformOrigin: "bottom left" }}
        >
        {/* Edit affordance: round palette button on the top-right corner. */}
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          title="Change color encoding"
          className="absolute -right-2 -top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-[#E2E0DC] bg-white text-[#A8A29E] shadow-sm transition-all hover:scale-105 hover:text-[#78716C]"
        >
          <Palette className="h-3 w-3" strokeWidth={2} />
        </button>

        {/* Picker window: floats above the legend while picking. */}
        {picking && (
          <div className="absolute bottom-full left-0 mb-2 w-64 overflow-hidden rounded-lg border border-[#E7E2DA] bg-white shadow-lg">
            <div className="border-b border-[#F0ECE4] px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[#999999]">
              Color encoding
            </div>
            <div className="flex flex-col py-1">
              {schemes.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    onSelect(s.id);
                    setPicking(false);
                  }}
                  className="flex items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-[#F5F1EA]"
                >
                  <Check
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                      s.id === active.id
                        ? "text-[#7F8A61] opacity-100"
                        : "opacity-0"
                    }`}
                    strokeWidth={3}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-1 text-[12px] font-medium leading-none text-[#2A2622]">
                      {s.name}
                      {s.source !== "builtin" && (
                        <Sparkles
                          className="h-2.5 w-2.5 text-[#B0975A]"
                          strokeWidth={2.5}
                        />
                      )}
                    </span>
                    {s.description && (
                      <span className="text-[10px] leading-snug text-[#888888]">
                        {s.description}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>

            {/* Generate / describe-your-own. Type a grouping idea and
             *  submit, or let the model pick the most insightful encoding
             *  for this project. */}
            <div className="border-t border-[#F0ECE4] p-2.5">
              <div className="flex items-center gap-1.5 rounded-md border border-[#E7E2DA] bg-[#FCFBF9] px-2 py-1 focus-within:border-[#C9BFA8]">
                <input
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (genError) onClearGenError();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitDraft();
                    }
                  }}
                  disabled={generating}
                  placeholder="Describe a color encoding…"
                  className="min-w-0 flex-1 bg-transparent text-[11px] text-[#2A2622] outline-none placeholder:text-[#A8A29E] disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={submitDraft}
                  disabled={generating || !draft.trim()}
                  title="Generate this encoding"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#78716C] transition-colors hover:bg-[#F0ECE4] disabled:opacity-30"
                >
                  <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  if (genError) onClearGenError();
                  onGenerate(null);
                }}
                disabled={generating}
                className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-[#78716C] transition-colors hover:bg-[#F5F1EA] disabled:opacity-60"
              >
                {generating ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
                    Generating…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3 w-3" strokeWidth={2.5} />
                    Suggest an encoding for me
                  </>
                )}
              </button>

              {genError && (
                <div className="mt-1.5 text-[10px] leading-snug text-[#9C5638]">
                  {genError}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Header doubles as the definitions toggle; shows the active
         *  encoding so the colors are never ambiguous. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mb-1 flex w-full items-center gap-1 pr-4 text-[9px] font-semibold uppercase tracking-wide text-[#999999] transition-colors hover:text-[#666666]"
          title={showDefs ? "Hide definitions" : "Show what each color means"}
        >
          {showDefs ? (
            <ChevronDown className="h-3 w-3 shrink-0" strokeWidth={2.5} />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" strokeWidth={2.5} />
          )}
          <span className="truncate">{active.name}</span>
        </button>

        <div className="flex flex-col gap-1">
          {items.map((g) => (
            <div key={g.key} className="flex items-start gap-1.5">
              {/* 1px outline, not 2px: on a swatch this small a thick ring
                  swallows the fill and the two colours stop being readable. */}
              <span
                className="mt-[3px] h-2.5 w-2.5 shrink-0 rounded-[3px] border"
                style={{ backgroundColor: g.tint, borderColor: g.accent }}
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] leading-none text-[#2A2622]">
                  {g.label}
                </span>
                {showDefs && g.blurb && (
                  <span className="text-[10px] leading-snug text-[#888888]">
                    {g.blurb}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        </div>
      </div>
    </>
  );
}
