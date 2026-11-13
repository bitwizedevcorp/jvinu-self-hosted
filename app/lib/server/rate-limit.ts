import "server-only";

/**
 * Limits for the public share routes, kept in memory (one process; a restart forgets
 * them). Request rates use fixed windows. Wrong passwords back off exponentially.
 */

type Window = { count: number; resetAt: number };
type Misses = { count: number; last: number };

const windows = new Map<string, Window>();
const misses = new Map<string, Misses>();

/** Wrong guesses allowed before waits begin. */
export const FREE_MISSES = 5;
/** The longest wait between guesses, once a link has been guessed at many times. */
const MAX_WAIT_MS = 15 * 60_000;
/** Misses are forgotten after this long without another. */
const MISS_MEMORY_MS = 60 * 60_000;
const MAX_ENTRIES = 50_000;

function prune(now: number) {
  if (windows.size > MAX_ENTRIES) for (const [key, entry] of windows) if (entry.resetAt <= now) windows.delete(key);
  if (misses.size > MAX_ENTRIES) for (const [key, entry] of misses) if (now - entry.last > MISS_MEMORY_MS) misses.delete(key);
}

/** Counts one request against `key`. Past `limit` within `windowMs`, it's refused, with the seconds to wait. */
export function take(key: string, limit: number, windowMs: number, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
  prune(now);
  const entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (entry.count >= limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  entry.count += 1;
  return { ok: true };
}

/**
 * Seconds before `key` may guess again; 0 when it may now. The first `free` misses cost
 * nothing, then each one doubles the wait: 1 s, 2 s, 4 s… up to 15 minutes.
 */
export function waitBeforeGuess(key: string, free = FREE_MISSES, now = Date.now()): number {
  const entry = misses.get(key);
  if (!entry) return 0;
  if (now - entry.last > MISS_MEMORY_MS) {
    misses.delete(key);
    return 0;
  }
  if (entry.count < free) return 0;
  const wait = Math.min(MAX_WAIT_MS, 1000 * 2 ** (entry.count - free));
  return Math.max(0, Math.ceil((entry.last + wait - now) / 1000));
}

export function recordMiss(key: string, now = Date.now()) {
  prune(now);
  const entry = misses.get(key);
  if (!entry || now - entry.last > MISS_MEMORY_MS) misses.set(key, { count: 1, last: now });
  else {
    entry.count += 1;
    entry.last = now;
  }
}

export function clearMisses(key: string) {
  misses.delete(key);
}

/** For tests: forget every window and miss. */
export function resetLimits() {
  windows.clear();
  misses.clear();
}
