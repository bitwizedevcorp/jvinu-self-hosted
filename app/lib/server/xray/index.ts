import "server-only";
import { findPreset } from "../../storage";
import type { XrayReport } from "../../xray";
import type { StoredConnection } from "../connections";
import { cloudDriver, driverFor } from "../drivers";
import { onContentsChanged } from "../connection-changes";
import { inventoryOf } from "../inventory";
import { xrayScan } from "./scan";

/**
 * A connection's latest X-Ray report. A scan is kept for ten minutes so the page and the
 * PDF made from it show the same numbers; "Scan again" replaces it.
 */
const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: Promise<XrayReport> }>();

export function xrayFor(connection: StoredConnection, refresh = false): Promise<XrayReport> {
  const hit = cache.get(connection.id);
  if (hit && !refresh && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = (async () =>
    xrayScan(
      {
        id: connection.id,
        name: connection.name,
        bucket: connection.bucket,
        presetId: connection.presetId,
        provider: findPreset(connection.presetId)?.name ?? connection.presetId,
        endpoint: connection.endpoint,
        pricePerGb: connection.pricePerGb,
        encrypted: Boolean(connection.crypt),
        publicBaseUrl: connection.settings?.publicBaseUrl,
      },
      driverFor(connection),
      // Bucket-level checks go to the cloud's own driver: encryption changes names, not settings.
      cloudDriver(connection).audit,
      await inventoryOf(connection, "", refresh),
    ))();
  value.catch(() => cache.delete(connection.id));
  cache.set(connection.id, { at: Date.now(), value });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return value;
}

/** Forget a connection's report: call after a fix changed what it would find. */
export function forgetXray(connectionId: string) {
  cache.delete(connectionId);
}
onContentsChanged(forgetXray);
