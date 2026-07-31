import { useState, type Dispatch, type SetStateAction } from "react";

export type EditSummary = {
  files: string[];
  text: string;
  /** Labels of the blocks whose code changed this turn (so their drill-in
   *  capabilities get re-derived + they glow). Shown so the user knows
   *  WHICH block reflects the change, even if it differs from the one they
   *  clicked. */
  blocks?: string[];
  /** Optional notice shown when a user-drawn connection was NOT kept
   *  because the edit established no direct relationship between the two
   *  blocks. Lets the user understand why their line vanished instead of
   *  it silently disappearing. */
  note?: string;
};

/**
 * Owns the `editSummary` state: what the just-finished turn edited.
 *
 * The actual extraction happens inside `useChatSettleEffect`, which
 * walks the just-finished assistant turn for `edit/write_project_file`
 * tool_use blocks plus the closing text. This hook just owns the
 * state slot and the setter so the caller can clear it on the next
 * user action.
 *
 * There is no floating card for this anymore (it duplicated the chat's
 * own closing message); the summary now feeds the chat's "Updated the
 * diagram" entry, the tracker's edited rows, and the capability-refresh
 * queue.
 */
export function useEditSummary(): {
  editSummary: EditSummary | null;
  setEditSummary: Dispatch<SetStateAction<EditSummary | null>>;
} {
  const [editSummary, setEditSummary] = useState<EditSummary | null>(null);
  return { editSummary, setEditSummary };
}
