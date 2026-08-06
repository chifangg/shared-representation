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
 * The mode is fixed for the lifetime of a page load (read once at module
 * init). Flipping conditions requires a reload with the query param,
 * which is fine: the condition never changes mid-session by design, and
 * it keeps the panel tree static (see the AppShell layout note about
 * mounting/unmounting resizable panels).
 */

export type StudyMode = "tool" | "baseline";

const STORAGE_KEY = "study-mode";

function readMode(): StudyMode {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("mode");
    if (fromUrl === "baseline" || fromUrl === "tool") {
      window.localStorage.setItem(STORAGE_KEY, fromUrl);
      return fromUrl;
    }
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "baseline" || stored === "tool") return stored;
  } catch {
    // Storage unavailable (private mode etc.): fall through to default.
  }
  return "tool";
}

const MODE: StudyMode = readMode();

export function getStudyMode(): StudyMode {
  return MODE;
}
