import "server-only";
import type { StorageDriver } from "./drivers/types";

/**
 * Connection changes: anything that alters what a connection holds — in one place, so no
 * caller has to remember what to forget.
 *
 * - Every write through `driverFor` reports itself: the driver it returns is tracked here,
 *   so an upload, copy, move, delete or metadata change from any route, job or share copy
 *   forgets what this server remembered about that connection's files.
 * - Whatever keeps such memory (the file scans behind search and analytics, found tables,
 *   X-Ray reports) registers with `onConnectionChange` where it's defined.
 * - Disconnecting reports one too (remove-connection.ts).
 *
 * Imports nothing at runtime, so drivers and caches can all use it.
 */
type Listener = (connectionId: string) => void;
const listeners = new Set<Listener>();

/** Called with a connection's id whenever it changes through this server. */
export function onConnectionChange(listener: Listener): void {
  listeners.add(listener);
}

/** Forgets everything remembered about a connection's files. */
export function connectionChanged(connectionId: string): void {
  for (const listener of listeners) {
    try {
      listener(connectionId);
    } catch (error) {
      console.error("[connection-changes] a cache couldn't forget", connectionId, error);
    }
  }
}

/** The driver's methods that change what's stored. */
const WRITES = new Set<keyof StorageDriver>(["write", "upload", "remove", "copy", "rename", "setMetadata"]);

/**
 * A driver whose writes report themselves — once they've finished, whether or not they
 * succeeded, since a failed copy or delete may still have changed part of what's there.
 */
export function trackWrites(driver: StorageDriver, connectionId: string): StorageDriver {
  return new Proxy(driver, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (!WRITES.has(property as keyof StorageDriver)) return value.bind(target);
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        return Promise.resolve(result).finally(() => connectionChanged(connectionId));
      };
    },
  });
}
