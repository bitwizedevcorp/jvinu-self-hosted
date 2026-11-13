/**
 * A StorageDriver over an in-memory map of key → bytes, honouring byte ranges like a real
 * provider — and counting what it serves, so tests can prove a preview read only a little.
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

export function memoryDriver(initial: Record<string, Uint8Array | string> = {}, options: { ignoreRanges?: boolean } = {}): MemoryDriver {
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
    verify: async () => ({}),
    async list(prefix) {
      counters.lists++;
      const folders = new Set<string>();
      const out: Listing["files"] = [];
      for (const [key, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) folders.add(prefix + rest.slice(0, slash + 1));
        else out.push({ key, size: bytes.length, lastModified: modified, etag: null, storageClass: null });
      }
      return { folders: [...folders], files: out };
    },
    async listKeys(prefix, max) {
      counters.lists++;
      const keys = [...files.keys()].filter((key) => key.startsWith(prefix)).sort();
      return { keys: keys.slice(0, max), truncated: keys.length > max };
    },
    async stats() {
      return { objects: 0, bytes: 0, lastModified: null, truncated: false };
    },
    async inventory(prefix) {
      counters.lists++;
      const out = [...files]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, bytes]) => ({ key, size: bytes.length, lastModified: modified, etag: null, storageClass: null }));
      return { files: out, truncated: false };
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
      files.set(destination, files.get(source)!);
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
