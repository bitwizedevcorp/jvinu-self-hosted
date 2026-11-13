import "server-only";
import type { StoredConnection } from "./connections";
import { driverFor } from "./drivers";
import type { Listing } from "./drivers/types";

/**
 * A connection's flat object list, shared by search and analytics. One scan serves both for
 * a minute; any write through this app forgets that connection's scans, so results never
 * lag behind an upload, move or delete made here.
 */
export type Inventory = { files: Listing["files"]; truncated: boolean };

/** About 100,000 objects: enough for a picture, cheap in list requests. */
export const MAX_PAGES = 100;
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<Inventory> }>();

export function inventoryOf(connection: StoredConnection, prefix: string, refresh = false): Promise<Inventory> {
  const key = `${connection.id}|${prefix}`;
  const hit = cache.get(key);
  if (hit && !refresh && Date.now() - hit.at < TTL_MS) return hit.value;
  // Concurrent callers share one scan; a failed scan isn't kept.
  const value = driverFor(connection).inventory(prefix, MAX_PAGES);
  value.catch(() => cache.delete(key));
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return value;
}

/** Forget every scan of a connection: call after writing to it. */
export function forgetInventory(connectionId: string) {
  for (const key of cache.keys()) if (key.startsWith(`${connectionId}|`)) cache.delete(key);
}
