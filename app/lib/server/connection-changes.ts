import "server-only";
import type { StorageDriver } from "./drivers/types";
import { forgetConnectionActivity } from "./activity";
import { deleteConnection } from "./connections";
import { forgetConnectionNotes } from "./notes";
import { forgetConnectionLinks } from "./shares";
import { forgetConnectionItems } from "./user-items";

/**
 * What happens when a connection's contents change, or the connection goes away — in one
 * place, so no caller has to remember it.
 *
 * - Every write through `driverFor` reports itself: the driver it returns is tracked here,
 *   so an upload, copy, move, delete or metadata change from any route, job or share copy
 *   forgets what this server remembered about that connection's files.
 * - Whatever keeps such memory (the file scans behind search and analytics, found tables,
 *   X-Ray reports) registers with `onContentsChanged` where it's defined.
 * - `removeConnection` is the one way to disconnect: the row, and everything kept about it.
 */
type Listener = (connectionId: string) => void;
const listeners = new Set<Listener>();

/** Called with a connection's id whenever its contents change through this server. */
export function onContentsChanged(listener: Listener): void {
  listeners.add(listener);
}

/** Forgets everything remembered about a connection's files. */
export function contentsChanged(connectionId: string): void {
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
        return Promise.resolve(result).finally(() => contentsChanged(connectionId));
      };
    },
  });
}

/**
 * Disconnects: deletes the connection and everything this server keeps about it — starred
 * and recent items, notes, share links, its history, and remembered scans. False if it
 * wasn't there.
 */
export async function removeConnection(id: string): Promise<boolean> {
  const removed = await deleteConnection(id);
  await forgetConnectionItems(id);
  await forgetConnectionNotes(id);
  await forgetConnectionLinks(id);
  await forgetConnectionActivity(id);
  contentsChanged(id);
  return removed;
}
