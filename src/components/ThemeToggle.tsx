import { useState } from "react";
import { Theme, applyTheme, storedTheme } from "../theme";

// Cycles light → dark → system. "System" is the default and is worth keeping
// reachable: it's the only setting that follows the reader's machine when they
// change it later.
const NEXT: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };
const LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", system: "Auto" };
const ICON: Record<Theme, string> = { light: "☀", dark: "☾", system: "◐" };

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const set = (t: Theme) => { applyTheme(t); setTheme(t); };
  return (
    <button
      className="nav-link btn-nav theme-toggle"
      onClick={() => set(NEXT[theme])}
      title={`Theme: ${LABEL[theme]}${theme === "system" ? " (follows your device)" : ""} — click for ${LABEL[NEXT[theme]]}`}
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[NEXT[theme]]}.`}
    >
      <span aria-hidden="true">{ICON[theme]}</span> {LABEL[theme]}
    </button>
  );
}
