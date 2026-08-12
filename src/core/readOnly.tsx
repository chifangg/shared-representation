import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { logEvent } from "@/core/interactionLog";

/**
 * Read-only mode: the app as a place to UNDERSTAND a codebase rather than
 * change one.
 *
 * With it on, the chat panel is gone and every route from the diagram into
 * an edit is closed: no renaming a block, no block actions, no drawing a
 * connection to describe an intent, no dragging a block into chat as
 * context. What survives is everything that only reads: opening files, the
 * code viewer, both search modes, the drill-in bubbles and the connection
 * lens, selection and camera.
 *
 * Why a mode rather than just closing the chat panel: the diagram's edit
 * affordances are the actual hazard. Someone reading code should not be one
 * stray double-click away from renaming a block or one dragged arrow away
 * from queuing a prompt. Taking the panel away without taking those away
 * would leave edits that fire into a surface the user cannot see.
 *
 * Deliberately NOT persisted. It is a stance for the current session, and a
 * mode that silently survives a reload is one people forget they are in.
 */
type ReadOnlyValue = {
  readOnly: boolean;
  toggle: () => void;
};

const ReadOnlyContext = createContext<ReadOnlyValue | null>(null);

export function ReadOnlyProvider({ children }: { children: ReactNode }) {
  const [readOnly, setReadOnly] = useState(false);
  const toggle = useCallback(() => {
    setReadOnly((prev) => {
      logEvent("read-only-toggle", { on: !prev });
      return !prev;
    });
  }, []);
  const value = useMemo(() => ({ readOnly, toggle }), [readOnly, toggle]);
  return (
    <ReadOnlyContext.Provider value={value}>
      {children}
    </ReadOnlyContext.Provider>
  );
}

/**
 * Read the current mode.
 *
 * Returns false outside a provider rather than throwing, unlike the other
 * core contexts. A missing provider here should degrade to "everything is
 * editable", which is the app's normal state, not take the tree down; and
 * it keeps the feature's components mountable in isolation.
 */
export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext)?.readOnly ?? false;
}

/** The toggle itself. Separate from `useReadOnly` so the many read sites
 *  cannot accidentally flip the mode. */
export function useReadOnlyToggle(): () => void {
  const ctx = useContext(ReadOnlyContext);
  if (!ctx) {
    throw new Error("useReadOnlyToggle must be used within ReadOnlyProvider");
  }
  return ctx.toggle;
}
