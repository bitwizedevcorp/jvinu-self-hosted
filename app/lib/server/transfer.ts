import "server-only";
import { eachLimit, StorageUserError, type StorageDriver } from "./drivers/types";
import type { OperationItem } from "./operations";

/**
 * Copies between two connections — any cloud to any other. Bytes stream through this
 * server: read from one driver, uploaded by the other, so encryption on either side is
 * handled by its driver (decrypted coming out, encrypted going in).
 */

/** Files one transfer may copy; it runs as a background job. */
export const TRANSFER_LIMIT = 100_000;
const CONCURRENCY = 4;

export type TransferPair = { from: string; to: string };

const nameOf = (item: OperationItem) => item.key.replace(/\/$/, "").split("/").pop() ?? "";

/**
 * Selected files and folders → every key to copy, and where each lands under
 * `destination`. Refuses up front if anything is already there.
 */
export async function planTransfer(
  source: StorageDriver,
  target: StorageDriver,
  items: OperationItem[],
  destination: string,
): Promise<TransferPair[]> {
  const pairs: TransferPair[] = [];
  for (const item of items) {
    const to = destination + nameOf(item) + (item.kind === "folder" ? "/" : "");
    const { keys: taken } = await target.listKeys(to, 5);
    if (item.kind === "folder" ? taken.length > 0 : taken.includes(to)) {
      throw new StorageUserError(`Something named “${nameOf(item)}” is already there.`, 409);
    }
    if (item.kind === "file") {
      pairs.push({ from: item.key, to });
      continue;
    }
    const { keys } = await source.listKeys(item.key, TRANSFER_LIMIT + 1);
    // A folder with nothing listed under it (a native folder, or an empty one) still exists.
    for (const key of keys.length ? keys : [item.key]) pairs.push({ from: key, to: to + key.slice(item.key.length) });
    if (pairs.length > TRANSFER_LIMIT) {
      throw new StorageUserError(`That's more than ${TRANSFER_LIMIT.toLocaleString("en-US")} files at once. Copy folder by folder.`, 413);
    }
  }
  return pairs;
}

/** Relative paths from a comparison → pairs, from one folder to another. */
export function pairsFor(paths: string[], sourcePrefix: string, targetPrefix: string): TransferPair[] {
  return paths.map((path) => ({ from: sourcePrefix + path, to: targetPrefix + path }));
}

/** Streams each pair across, a few at a time. Returns the keys that failed. */
export async function runTransfer(
  source: StorageDriver,
  target: StorageDriver,
  pairs: TransferPair[],
  report: (done: number, total: number) => void,
  cancelled: () => boolean,
): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  let done = 0;
  report(0, pairs.length);
  await eachLimit(pairs, CONCURRENCY, async ({ from, to }) => {
    if (cancelled()) return;
    try {
      if (from.endsWith("/")) {
        // A folder marker: an empty object, so the folder shows up on the other side.
        if (!target.nativeFolders) await target.write(to, new Uint8Array(0));
      } else {
        const body = await source.read(from);
        await target.upload(to, body.stream, body.size, body.contentType);
      }
      done += 1;
    } catch (error) {
      if (!(error instanceof StorageUserError)) console.error("[transfer] copy failed", from, error);
      failed.push(from);
    }
    report(done, pairs.length);
  });
  return { failed };
}
