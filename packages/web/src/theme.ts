// The person's theme (users.theme, the same in the app and the dashboard): light, dark, or the device's. <html>
// always carries the theme in effect as data-theme, so the stylesheets hold one dark palette (tokens.css); with
// "system" it follows the device, live. A copy in localStorage lets index.html set it before the first paint; the
// server's value, once it arrives, wins (it follows the person to every device).

export type ThemeChoice = "system" | "light" | "dark";
export const THEME_KEY = "bongsu-theme";

const dark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
let choice: ThemeChoice = "system";
let watching = false;

const paint = () => {
  document.documentElement.dataset.theme = choice === "system" ? (dark() ? "dark" : "light") : choice;
};

/** Applies a choice (the server's null is "system"), and remembers it on this device. */
export function applyTheme(t: string | null | undefined): ThemeChoice {
  choice = t === "light" || t === "dark" ? t : "system";
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // storage refused (private mode): the server's copy still applies on each load
  }
  paint();
  if (!watching && typeof matchMedia === "function") {
    watching = true;
    matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", paint);
  }
  return choice;
}

/** The choice in effect on this device. */
export const currentTheme = (): ThemeChoice => choice;
