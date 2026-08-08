/**
 * Study condition for the user study: "tool" (full system, diagram panel
 * mounted) vs "baseline" (chat-only, the diagram panel is never mounted,
 * so the app reads as plain chat + files + code).
 *
 * The researcher sets the condition ONCE per participant by opening the
 * app with `?mode=baseline` or `?mode=tool`. The value persists in
 * localStorage so mid-session reloads keep the participant in their
 * group. There is deliberately NO visible toggle: participants must not
 * discover or flip their condition.
 *
 * A page opened with NO mode anywhere (no query param, nothing stored)
 * gets null, and the shell refuses to start the session: a participant
 * who types the bare URL instead of opening the moderator's link must
 * not fall into a silent default condition. The moderator's link is
 * the only way in the first time.
 *
 * The mode is fixed for the lifetime of a page load (read once at module
 * init). Flipping conditions requires a reload with the query param,
 * which is fine: the condition never changes mid-session by design, and
 * it keeps the panel tree static (see the AppShell layout note about
 * mounting/unmounting resizable panels).
 */

export type StudyMode = "tool" | "baseline";

const STORAGE_KEY = "study-mode";

function readMode(): StudyMode | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("mode");
    if (fromUrl === "baseline" || fromUrl === "tool") {
      window.localStorage.setItem(STORAGE_KEY, fromUrl);
      return fromUrl;
    }
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "baseline" || stored === "tool") return stored;
  } catch {
    // Storage unavailable (private mode etc.): fall through to unset.
  }
  return null;
}

const MODE: StudyMode | null = readMode();

export function getStudyMode(): StudyMode | null {
  return MODE;
}
