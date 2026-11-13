/**
 * A StorageDriver over an in-memory map of key → bytes, honouring byte ranges like a real
 * provider — and counting what it serves, so tests can prove a preview read only a little.
 * It keeps the same contract as every real driver, S3-style (keys match by string prefix);
 * tests/drivers.contract.test.ts holds it to that.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { StorageUserError, type ByteRange, type Listing, type StorageDriver } from "../app/lib/server/drivers/types";

export type MemoryDriver = StorageDriver & {
  files: Map<string, Uint8Array>;
  types: Map<string, string>;
  counters: { reads: number; bytesServed: number; lists: number };
  reset(): void;
};

const PAGE = 1000;
const isMarker = (key: string) => key.endsWith("/");

/**
 * `missing`: the bucket doesn't exist, so verify() says 404.
 * `ignoreRanges`: serve whole files whatever range was asked for, as some stores do.
 */
export function memoryDriver(
  initial: Record<string, Uint8Array | string> = {},
  options: { ignoreRanges?: boolean; missing?: boolean } = {},
): MemoryDriver {
  const files = new Map<string, Uint8Array>();
  for (const [key, value] of Object.entries(initial)) files.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
  const counters = { reads: 0, bytesServed: 0, lists: 0 };
  /** Content types given on upload, by key. */
  const types = new Map<string, string>();
  const modified = "2026-10-01T00:00:00.000Z";

  const streamOf = (bytes: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Several chunks, as a network stream would deliver.
        for (let i = 0; i < bytes.length; i += 64 * 1024) controller.enqueue(bytes.slice(i, i + 64 * 1024));
        controller.close();
      },
    });

  const driver: MemoryDriver = {
    files,
    types,
    counters,
    reset() {
      counters.reads = 0;
      counters.bytesServed = 0;
      counters.lists = 0;
    },
    verify: async () => {
      if (options.missing) throw new StorageUserError("That bucket doesn't exist.", 404);
      return {};
    },
    async list(prefix, token) {
      counters.lists++;
      // One level, folders apart; a folder's own marker is never a file. Paged like S3.
      const entries: ({ folder: string } | { file: Listing["files"][number] })[] = [];
      const folders = new Set<string>();
      for (const [key, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!key.startsWith(prefix) || key === prefix) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) {
          const folder = prefix + rest.slice(0, slash + 1);
          if (!folders.has(folder)) entries.push({ folder });
          folders.add(folder);
        } else entries.push({ file: { key, size: bytes.length, lastModified: modified, etag: null, storageClass: null } });
      }
      const from = token === undefined ? 0 : Number(token);
      if (!Number.isSafeInteger(from) || from < 0) throw new StorageUserError("Invalid page token.", 400);
      const page = entries.slice(from, from + PAGE);
      return {
        folders: page.flatMap((entry) => ("folder" in entry ? [entry.folder] : [])),
        files: page.flatMap((entry) => ("file" in entry ? [entry.file] : [])),
        nextToken: from + PAGE < entries.length ? String(from + PAGE) : undefined,
      };
    },
    async listKeys(prefix, max) {
      counters.lists++;
      const keys = [...files.keys()].filter((key) => key.startsWith(prefix)).sort();
      return { keys: keys.slice(0, max), truncated: keys.length > max };
    },
    async stats(prefix) {
      const inside = [...files].filter(([key]) => key.startsWith(prefix) && !isMarker(key));
      return {
        objects: inside.length,
        bytes: inside.reduce((sum, [, bytes]) => sum + bytes.length, 0),
        lastModified: inside.length ? modified : null,
        truncated: false,
      };
    },
    async inventory(prefix, maxPages = 100) {
      counters.lists++;
      const out = [...files]
        .filter(([key]) => key.startsWith(prefix) && !isMarker(key))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, bytes]) => ({ key, size: bytes.length, lastModified: modified, etag: null, storageClass: null }));
      return { files: out.slice(0, maxPages * PAGE), truncated: out.length > maxPages * PAGE };
    },
    signedUrl: async () => null,
    async read(key: string, range?: ByteRange) {
      counters.reads++;
      const bytes = files.get(key);
      if (!bytes) throw new StorageUserError("That object no longer exists.", 404);
      if (!range || options.ignoreRanges) {
        counters.bytesServed += bytes.length;
        return { stream: streamOf(bytes), size: bytes.length, total: bytes.length };
      }
      if (range.start >= bytes.length) throw new StorageUserError("That byte range is outside the file.", 416);
      const end = Math.min(range.end ?? bytes.length - 1, bytes.length - 1);
      const slice = bytes.slice(range.start, end + 1);
      counters.bytesServed += slice.length;
      return { stream: streamOf(slice), size: slice.length, total: bytes.length, range: { start: range.start, end } };
    },
    async write(key, body) {
      files.set(key, body);
    },
    async upload(key, body, _size, contentType) {
      const chunks: Uint8Array[] = [];
      const reader = body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      files.set(key, new Uint8Array(Buffer.concat(chunks)));
      if (contentType) types.set(key, contentType);
    },
    async remove(keys) {
      for (const key of keys) files.delete(key);
      return { failed: [] };
    },
    async copy(source, destination) {
      const bytes = files.get(source);
      if (!bytes) throw new StorageUserError("That object no longer exists.", 404);
      files.set(destination, bytes);
      const type = types.get(source);
      if (type) types.set(destination, type);
    },
  };
  return driver;
}

/** Loads a folder from disk into a memory driver under `prefix`. */
export function loadFolder(driver: MemoryDriver, dir: string, prefix: string) {
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else driver.files.set(prefix + path.relative(dir, full).split(path.sep).join("/"), new Uint8Array(readFileSync(full)));
    }
  };
  walk(dir);
}
