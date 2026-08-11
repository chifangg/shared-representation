import { useState } from "react";
import { Search } from "lucide-react";
import { logEvent } from "@/core/interactionLog";
import { useDiagramBus } from "../../protocol/bus";

/**
 * The "now go understand it" card, pushed into the chat transcript right
 * under the agent's reply on a turn that changed code (next to the
 * "Updated the diagram" chip).
 *
 * The diagram already knows which blocks the turn touched, so the question
 * worth asking is knowable without the user typing anything. Clicking runs
 * it: the search box opens pre-filled and the ordered reading path renders
 * on the canvas. Nothing is sent to the agent, so this cannot cost the
 * user a turn by accident.
 *
 * It flips to an "asked" state rather than disappearing, matching
 * OptionsHandoff: scrolling back through the transcript later should still
 * show what was offered, and re-clicking re-runs the search.
 */
export function DiagramSearchNudge({ query }: { query: string }) {
  const bus = useDiagramBus();
  const [asked, setAsked] = useState(false);

  const ask = () => {
    setAsked(true);
    logEvent("diagram-search-nudge-click", { query, repeat: asked });
    bus.emit("diagram-search-ask", { query, source: "nudge" });
  };

  return (
    // Indented into the agent's lane (past the avatar + timeline rail), the
    // same way DiagramActionEntry is, so the two stack as one column.
    <div className="flex justify-start pl-[37px]">
      <div className="diagram-action-in flex max-w-[92%] flex-col gap-2 rounded-[10px] bg-[#ECE1CB] px-3.5 py-2.5 text-[13px] leading-snug text-[#6E6353]">
        <span className="font-medium text-[#544A36]">
          {asked ? "Asked on the diagram" : "Want to see how this fits together?"}
        </span>
        <button
          type="button"
          onClick={ask}
          title={asked ? "Run this search again" : query}
          className={`inline-flex max-w-full items-center gap-2 self-start rounded-md border bg-white px-2.5 py-1 text-left text-[12px] font-medium transition-colors ${
            asked
              ? "text-[#8B7F68] hover:text-[#544A36]"
              : "text-[#6B5C3C] hover:bg-[#FBF6EA]"
          }`}
          // borderColor inline, not as a `border-[#hex]` class: a global rule
          // wins over those utilities app-wide, which is the same reason
          // DiagramActionEntry's chips set theirs inline.
          style={{ borderColor: asked ? "#C9BCA0" : "#B9A87F" }}
        >
          {/* The magnifier stays in both states. The button is still a
           *  "run this search" control after it has been asked once, and a
           *  bare checkmark read as a finished, dead receipt. The label
           *  above carries the asked/not-asked distinction instead. */}
          <Search
            size={13}
            className={`shrink-0 ${asked ? "text-[#B0A48C]" : "text-[#9A8A66]"}`}
          />
          {/* truncate needs its own block box, otherwise it clips mid-word
           *  on the flex parent without ever showing an ellipsis. */}
          <span className="min-w-0 truncate">{query}</span>
        </button>
      </div>
    </div>
  );
}
