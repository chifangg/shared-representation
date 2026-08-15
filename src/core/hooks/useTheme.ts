import { useEffect, useState } from "react";

/**
 * Minimal two-mode theme hook (dark / light).
 *
 * How it works:
 *  - Default is LIGHT. The app's own UI is authored light-only, so the
 *    OS appearance is deliberately ignored: following it rendered a
 *    broken half-dark hybrid on dark-mode machines (the dark tokens
 *    only cover the template's base layer, not the app's components).
 *  - Dark mode is the `@theme` block in styles.css; light mode adds
 *    `theme-light` to the <html> element, which overrides the tokens.
 *  - An explicit choice is persisted in localStorage under `ui-theme`.
 *
 * Forks that want more palettes can add `.theme-<name>` blocks to
 * styles.css alongside the existing `.theme-light` and extend the Theme
 * type + this hook. The toggle UI is in `ThemeToggle.tsx`.
 */
export type Theme = "dark" | "light";

const STORAGE_KEY = "ui-theme";

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("theme-light", theme === "light");
  // `color-scheme` tells the browser to render native form controls,
  // scrollbars, etc. in the matching palette.
  root.style.colorScheme = theme;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readInitialTheme());

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignore quota / privacy-mode errors — in-memory state still works.
    }
  }, [theme]);

  return {
    theme,
    setTheme,
    toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
  };
}
