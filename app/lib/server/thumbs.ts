import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./db";
import type { StorageDriver } from "./drivers";

/**
 * Thumbnails: a 512 px WebP per image, made once from the original and kept on disk under
 * JVINU_DATA_DIR/thumbs, keyed by connection + key + version (the object's ETag), so a
 * changed file gets a new one. The cache has a size cap (JVINU_THUMB_CACHE_MB, default
 * 1 GB) and evicts what was used least recently. A file that can't be thumbnailed is
 * remembered too, so its original isn't downloaded again just to fail again. For an
 * encrypted connection the cached file is sealed with the connection's own key, so a copy
 * of the data directory shows nothing of what's in the bucket.
 */

/** Originals above this aren't fetched for a thumbnail. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_EDGE = 512;
/** Formats worth trying; anything sharp can't read falls back to the file's glyph. */
export const THUMBNAILABLE = /\.(jpe?g|png|gif|webp|avif|tiff?|heic|heif)$/i;

const capBytes = () => Math.max(1, Number(process.env.JVINU_THUMB_CACHE_MB || 1024)) * 1024 * 1024;
const directory = () => path.join(dataDir(), "thumbs");

type Entry = { size: number; used: number };
let index: Promise<Map<string, Entry>> | null = null;
let total = 0;

/** What's on disk, read once per process (so the cache survives restarts). */
function loadIndex(): Promise<Map<string, Entry>> {
  index ??= (async () => {
    const dir = directory();
    await mkdir(dir, { recursive: true });
    const entries = new Map<string, Entry>();
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".webp") && !name.endsWith(".none")) continue;
      try {
        const info = await stat(path.join(dir, name));
        entries.set(name, { size: info.size, used: info.mtimeMs });
        total += info.size;
      } catch {
        // Gone between readdir and stat.
      }
    }
    return entries;
  })();
  return index;
}

const nameOf = (connectionId: string, key: string, version: string) =>
  createHash("sha256").update(`${connectionId}\n${key}\n${version}`).digest("hex");

async function touch(entries: Map<string, Entry>, file: string) {
  const entry = entries.get(file);
  if (!entry) return;
  entry.used = Date.now();
  const now = new Date();
  await utimes(path.join(directory(), file), now, now).catch(() => {});
}

async function put(file: string, data: Buffer) {
  const entries = await loadIndex();
  const target = path.join(directory(), file);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, target);
  const previous = entries.get(file);
  if (previous) total -= previous.size;
  entries.set(file, { size: data.length, used: Date.now() });
  total += data.length;
  await evict(entries);
}

/** Least recently used first, down to 90% of the cap so eviction isn't constant. */
async function evict(entries: Map<string, Entry>) {
  const cap = capBytes();
  if (total <= cap) return;
  const oldest = [...entries].sort((a, b) => a[1].used - b[1].used);
  for (const [file, entry] of oldest) {
    if (total <= cap * 0.9) break;
    await unlink(path.join(directory(), file)).catch(() => {});
    entries.delete(file);
    total -= entry.size;
  }
}

/** Renders at most a couple at a time: thumbnails are CPU work. */
let rendering = 0;
const waiting: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (rendering >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  rendering += 1;
  try {
    return await work();
  } finally {
    rendering -= 1;
    waiting.shift()?.();
  }
}

async function render(source: Buffer): Promise<Buffer | null> {
  const sharp = (await import("sharp")).default;
  try {
    return await sharp(source, { failOn: "error", limitInputPixels: 120_000_000, animated: false })
      .rotate() // honour EXIF orientation
      .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 76, effort: 3 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** Reads an object fully, giving up (and cancelling the read) past `limit`. */
async function readAll(driver: StorageDriver, key: string, limit: number): Promise<Buffer | null> {
  const object = await driver.read(key);
  if (object.size !== undefined && object.size > limit) {
    await object.stream.cancel().catch(() => {});
    return null;
  }
  const reader = object.stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

const inFlight = new Map<string, Promise<Buffer | null>>();

/**
 * The thumbnail for one version of an object: from disk if made before, otherwise made
 * now (once, however many requests ask at the same time). null when the file can't be
 * thumbnailed — too large, or not an image sharp can read.
 */
export async function thumbnailFor(driver: StorageDriver, connectionId: string, key: string, version: string): Promise<Buffer | null> {
  const entries = await loadIndex();
  const name = nameOf(connectionId, key, version);
  const cipher = driver.cacheCipher;
  if (entries.has(`${name}.webp`)) {
    try {
      const data = await readFile(path.join(directory(), `${name}.webp`));
      void touch(entries, `${name}.webp`);
      return cipher ? Buffer.from(cipher.open(data)) : data;
    } catch {
      entries.delete(`${name}.webp`); // gone, or unreadable: make it again
    }
  }
  if (entries.has(`${name}.none`)) {
    void touch(entries, `${name}.none`);
    return null;
  }

  let pending = inFlight.get(name);
  if (!pending) {
    pending = (async () => {
      const source = await readAll(driver, key, MAX_SOURCE_BYTES);
      const thumb = source ? await slot(() => render(source)) : null;
      // Remember failures as an empty marker: the original isn't fetched again for nothing.
      const stored = thumb && cipher ? Buffer.from(cipher.seal(thumb)) : thumb;
      await put(stored ? `${name}.webp` : `${name}.none`, stored ?? Buffer.alloc(0));
      return thumb;
    })().finally(() => inFlight.delete(name));
    inFlight.set(name, pending);
  }
  return pending;
}

/** For tests and diagnostics: what the cache holds now. */
export async function thumbCacheStats() {
  const entries = await loadIndex();
  return { files: entries.size, bytes: total, cap: capBytes() };
}
