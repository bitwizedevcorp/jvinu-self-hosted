"use client";

import { useSyncExternalStore } from "react";

/**
 * The time, shared by every component that shows "in 3 days" or "an hour ago", ticking
 * every half minute while any of them is on screen.
 */
let now = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now || (now = Date.now()), () => 0);
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "in 3 days", "2 hours ago", "in under a minute". */
export function relativeTime(iso: string, at: number): string {
  const diff = Date.parse(iso) - at;
  for (const [unit, size] of UNITS) if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit);
  return diff >= 0 ? "in under a minute" : "just now";
}
