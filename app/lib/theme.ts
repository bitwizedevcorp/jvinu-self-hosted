export type ThemePreference = "system" | "light" | "dark";

export const THEME_KEY = "jvinu-theme";
const EVENT = "jvinu-theme-change";

/**
 * Runs in <head> before first paint (see layout.tsx). Kept as a string so the
 * exact same logic resolves the theme on the server-rendered page and in React.
 */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_KEY}")||"system";var d=p==="dark"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light")}catch(e){}})()`;

export function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function resolve(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyResolvedTheme(preference: ThemePreference = readPreference()) {
  document.documentElement.setAttribute("data-theme", resolve(preference));
}

export function setPreference(preference: ThemePreference) {
  const commit = () => {
    try {
      if (preference === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, preference);
    } catch {
      // Storage blocked: the choice still applies for this page.
    }
    applyResolvedTheme(preference);
    window.dispatchEvent(new Event(EVENT));
  };

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Cross-fade the whole window where the browser supports it.
  if (!reduce && "startViewTransition" in document) {
    (document as Document & { startViewTransition: (cb: () => void) => unknown }).startViewTransition(commit);
  } else {
    commit();
  }
}

export function subscribe(callback: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    if (readPreference() === "system") applyResolvedTheme("system");
    callback();
  };
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  media.addEventListener("change", onSystemChange);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
    media.removeEventListener("change", onSystemChange);
  };
}
