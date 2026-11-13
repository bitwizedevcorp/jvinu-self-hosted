"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  applyResolvedTheme,
  readPreference,
  setPreference,
  subscribe,
  type ThemePreference,
} from "../lib/theme";
import { DisplayIcon, MoonIcon, SunIcon } from "./icons";

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, readPreference, () => "system");
}

/**
 * The <head> script sets the theme before paint; React's dev Strict Mode remount
 * then resets <html> attributes, so re-apply once, before paint. No-op in production.
 */
export function ThemeSync() {
  const preference = useThemePreference();
  useLayoutEffect(() => {
    applyResolvedTheme(preference);
  }, [preference]);
  return null;
}

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof SunIcon }[] = [
  { value: "system", label: "Auto", Icon: DisplayIcon },
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
];

/** macOS-style segmented control for System / Light / Dark. */
export function AppearanceControl() {
  const preference = useThemePreference();
  return (
    <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-3 gap-0.5 rounded-lg bg-surface-sunken p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setPreference(value)}
            className={`spring flex items-center justify-center gap-1 rounded-md py-1.5 text-[12px] font-medium transition active:scale-[0.97] ${
              active ? "bg-surface-raised text-ink shadow-card" : "text-ink-muted hover:text-ink"
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
