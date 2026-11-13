import "server-only";
import type { Listing, StorageDriver } from "./drivers/types";

/**
 * Two folders side by side — on one connection or two, on any clouds: what only one side
 * has, and what both have but differs. Files match by their path inside each folder;
 * "differs" means another size, or another checksum where both sides report a comparable one.
 */

export type CompareSide = { files: number; bytes: number; truncated: boolean };
export type CompareEntry = { path: string; size: number; lastModified: string | null };
export type CompareDiff = { path: string; left: CompareEntry; right: CompareEntry; reason: "size" | "checksum" };
export type Comparison = {
  left: CompareSide;
  right: CompareSide;
  onlyLeft: CompareEntry[];
  onlyRight: CompareEntry[];
  different: CompareDiff[];
  counts: { onlyLeft: number; onlyRight: number; different: number; same: number };
  /** Bytes the missing files on each side add up to. */
  bytes: { onlyLeft: number; onlyRight: number; different: number };
  /** Whether checksums were compared, or sizes only. */
  checksums: boolean;
};

/** Pages scanned per side: about 1,000 objects each. */
const MAX_PAGES = 200;
/** Entries sent back per list; the counts cover everything. */
const LIST_LIMIT = 5_000;

/** A plain MD5 ETag: the only kind two different services compute the same way. */
const md5 = (etag: string | null) => (etag && /^[0-9a-f]{32}$/i.test(etag.replaceAll('"', "")) ? etag.replaceAll('"', "").toLowerCase() : null);

function byPath(files: Listing["files"], prefix: string) {
  const map = new Map<string, Listing["files"][number]>();
  for (const file of files) {
    if (file.key.endsWith("/")) continue;
    map.set(file.key.slice(prefix.length), file);
  }
  return map;
}

const entry = (path: string, file: Listing["files"][number]): CompareEntry => ({ path, size: file.size, lastModified: file.lastModified });

export async function compareFolders(
  left: { driver: StorageDriver; prefix: string; encrypted?: boolean },
  right: { driver: StorageDriver; prefix: string; encrypted?: boolean },
): Promise<Comparison> {
  const [a, b] = await Promise.all([left.driver.inventory(left.prefix, MAX_PAGES), right.driver.inventory(right.prefix, MAX_PAGES)]);
  const leftFiles = byPath(a.files, left.prefix);
  const rightFiles = byPath(b.files, right.prefix);
  // Encrypted connections checksum ciphertext, which differs every time it's written.
  const checksums = !left.encrypted && !right.encrypted;

  const onlyLeft: CompareEntry[] = [];
  const onlyRight: CompareEntry[] = [];
  const different: CompareDiff[] = [];
  let same = 0;
  for (const [path, file] of leftFiles) {
    const other = rightFiles.get(path);
    if (!other) {
      onlyLeft.push(entry(path, file));
      continue;
    }
    if (file.size !== other.size) different.push({ path, left: entry(path, file), right: entry(path, other), reason: "size" });
    else if (checksums && md5(file.etag) && md5(other.etag) && md5(file.etag) !== md5(other.etag)) {
      different.push({ path, left: entry(path, file), right: entry(path, other), reason: "checksum" });
    } else same++;
  }
  for (const [path, file] of rightFiles) if (!leftFiles.has(path)) onlyRight.push(entry(path, file));

  const sum = (list: { size: number }[]) => list.reduce((total, item) => total + item.size, 0);
  const sorted = <T extends { path: string }>(list: T[]) => list.sort((x, y) => (x.path < y.path ? -1 : 1)).slice(0, LIST_LIMIT);
  return {
    left: { files: leftFiles.size, bytes: sum([...leftFiles.values()]), truncated: a.truncated },
    right: { files: rightFiles.size, bytes: sum([...rightFiles.values()]), truncated: b.truncated },
    counts: { onlyLeft: onlyLeft.length, onlyRight: onlyRight.length, different: different.length, same },
    bytes: { onlyLeft: sum(onlyLeft), onlyRight: sum(onlyRight), different: sum(different.map((diff) => diff.left)) },
    onlyLeft: sorted(onlyLeft),
    onlyRight: sorted(onlyRight),
    different: sorted(different),
    checksums,
  };
}
