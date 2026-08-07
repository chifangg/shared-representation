import { useCallback, useEffect, useState } from "react";
import { logEvent } from "@/core/interactionLog";
import type { IntentSelection } from "../types";

/**
 * Onboarding intent: the structured survey answer plus whether the revise
 * editor is open. Extracted from DiagramCanvas so the orchestrator does
 * not carry this feature's state and submit handlers inline.
 *
 * The hook owns intent / editingIntent and the two submit paths. The
 * canvas wipe needed on a real regenerate is passed in as `onRegenerate`,
 * since those setters belong to the canvas, not this feature.
 */
export function useOnboardingIntent({
  projectKey,
  userGoal,
  setUserGoal,
  onRegenerate,
}: {
  projectKey: number;
  userGoal: string | null;
  setUserGoal: (goal: string | null) => void;
  onRegenerate: () => void;
}) {
  const [intent, setIntent] = useState<IntentSelection | null>(null);
  const [editingIntent, setEditingIntent] = useState(false);

  // Reset on USER-initiated project change.
  useEffect(() => {
    setIntent(null);
    setEditingIntent(false);
  }, [projectKey]);

  /** First-time onboarding submit: store the selection + composed goal.
   *  Setting userGoal (from null) lets the structure fetch fire. */
  const complete = useCallback(
    (goal: string, selection: IntentSelection) => {
      // Deliberate exception to the lengths-not-bodies policy: the goal
      // text reaches only the diagram request, which is never persisted,
      // so unlike chat prompts it has NO transcript backup. It is short,
      // it is the participant's stated intent (analytically central), so
      // the event carries it verbatim.
      logEvent("survey-submit", {
        verb: selection.verb,
        caps: selection.capabilities.length,
        understandCaps: selection.understandCaps.length,
        goalLen: goal.length,
        goal: goal.slice(0, 300),
      });
      setIntent(selection);
      setUserGoal(goal);
    },
    [setUserGoal],
  );

  /** Revise submit (from reopening the chip). Close the editor; only if
   *  the goal actually changed do we set it and regenerate, so just
   *  looking never forces a regenerate. */
  const revise = useCallback(
    (goal: string, selection: IntentSelection) => {
      logEvent("survey-revise", {
        verb: selection.verb,
        changed: goal !== userGoal,
        goalLen: goal.length,
        // Same exception as survey-submit: no transcript backup exists.
        goal: goal.slice(0, 300),
      });
      setEditingIntent(false);
      setIntent(selection);
      if (goal === userGoal) return;
      setUserGoal(goal);
      onRegenerate();
    },
    [userGoal, setUserGoal, onRegenerate],
  );

  // Both are reached only from direct user actions (the chip's Change
  // button and the editor's cancel), so source stays "user". A revise
  // SUBMIT goes through revise() above and is not a cancel.
  const openEditor = useCallback(() => {
    logEvent("intent-edit-open", {});
    setEditingIntent(true);
  }, []);
  const closeEditor = useCallback(() => {
    logEvent("intent-edit-cancel", {});
    setEditingIntent(false);
  }, []);

  return { intent, editingIntent, complete, revise, openEditor, closeEditor };
}
