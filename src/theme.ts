// Light / dark / follow-the-system, remembered per browser.
//
// Three states rather than two: with no explicit choice the CSS follows
// prefers-color-scheme, so a reader who never touches this still gets the theme
// their machine asked for. Picking one stamps data-theme on <html>, which wins
// over the media query in both directions.

export type Theme = "light" | "dark" | "system";
const KEY = "bp:theme";

export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch { return "system"; }
}

export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", t);
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch { /* private mode: the choice just won't persist */ }
}

// Called before React mounts so the first paint is already the right theme.
export function initTheme() {
  applyTheme(storedTheme());
}
