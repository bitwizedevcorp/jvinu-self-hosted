import "server-only";
import {
  BLOCK_DATA,
  BLOCK_SIZE,
  decryptBlocks,
  decryptBuffer,
  decryptedSize,
  encryptBuffer,
  encryptedSize,
  encryptStream,
  HEADER_SIZE,
  parseHeader,
  splitHeader,
  SUFFIX,
} from "../crypt";
import { mimeOf } from "../mime";
import { StorageUserError, unsatisfiable, type Listing, type ObjectHead, type StorageDriver } from "./types";

/**
 * jvinu encryption: wraps any driver so the provider only ever stores ciphertext, in
 * rclone's crypt format with names left readable (each object gets rclone's ".bin"
 * suffix). Everything else — listing, previews, ranges, search, analytics, operations —
 * works through it unchanged, because sizes, keys and byte ranges are translated here.
 */

const isFolderKey = (key: string) => key.endsWith("/");
/** App key → stored key: files get the suffix; folder markers stay as they are. */
const stored = (key: string) => (isFolderKey(key) ? key : `${key}${SUFFIX}`);
/** Stored key → app key, or null for an object that isn't one of ours (rclone skips those too). */
const shown = (key: string): string | null => (isFolderKey(key) ? key : key.endsWith(SUFFIX) ? key.slice(0, -SUFFIX.length) : null);
const plainSize = (size: number) => decryptedSize(size) ?? 0;

async function readExactly(stream: ReadableStream<Uint8Array>, length: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  while (got < length) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks, got).subarray(0, length);
}

export function cryptDriver(inner: StorageDriver, key: Uint8Array): StorageDriver {
  const mapFiles = (files: Listing["files"]) =>
    files.flatMap((file) => {
      const name = shown(file.key);
      return name ? [{ ...file, key: name, size: plainSize(file.size) }] : [];
    });

  return {
    nativeFolders: inner.nativeFolders,

    // Thumbnails of these files are kept sealed with the same key on this server's disk.
    cacheCipher: { seal: (data) => encryptBuffer(key, data), open: (data) => decryptBuffer(key, data) },

    verify: () => inner.verify(),

    list: async (prefix, token) => {
      const page = await inner.list(prefix, token);
      return { folders: page.folders, files: mapFiles(page.files), nextToken: page.nextToken };
    },

    // Same prefix, so "a" still matches "a/…" and "a.txt": every stored key starts with
    // its app key. The filter drops the rare stored key that matched only on its suffix.
    listKeys: async (prefix, max) => {
      const mine = (keys: string[]) => keys.flatMap((key) => shown(key) ?? []).filter((key) => key.startsWith(prefix));
      const { keys, truncated } = await inner.listKeys(prefix, max);
      const found = mine(keys);
      // A file's own key sorts after siblings such as "a.txt (1)" once ".bin" is added, so a
      // short listing could miss it; callers checking "is this name taken" need it first.
      if (prefix && !isFolderKey(prefix) && !found.includes(prefix)) {
        const exact = await inner.listKeys(stored(prefix), 1);
        if (exact.keys[0] === stored(prefix)) return { keys: [prefix, ...found].slice(0, max), truncated: truncated || found.length >= max };
      }
      return { keys: found, truncated };
    },

    inventory: async (prefix, maxPages) => {
      const { files, truncated } = await inner.inventory(prefix, maxPages);
      const mapped = mapFiles(files);
      // One exact name is stored with the suffix: a store that matches whole names (Dropbox,
      // OneDrive, Google Drive) only finds it under that name.
      if (prefix && !isFolderKey(prefix) && !mapped.some((file) => file.key === prefix)) {
        const exact = mapFiles((await inner.inventory(stored(prefix), 1)).files).find((file) => file.key === prefix);
        if (exact) return { files: [exact, ...mapped], truncated };
      }
      return { files: mapped, truncated };
    },

    // Totals in plaintext bytes, from the same flat listing.
    stats: async (prefix, maxPages = 20) => {
      const { files, truncated } = await inner.inventory(prefix, maxPages);
      const mine = mapFiles(files);
      return {
        objects: mine.length,
        bytes: mine.reduce((sum, file) => sum + file.size, 0),
        lastModified: mine.reduce<string | null>((latest, file) => (file.lastModified && (!latest || file.lastModified > latest) ? file.lastModified : latest), null),
        truncated,
      };
    },

    // Nobody but this app can read the bytes: links are always served through it.
    signedUrl: () => Promise.resolve(null),

    head: async (appKey) => {
      let head: Omit<ObjectHead, "encryption"> & { encryption?: ObjectHead["encryption"] };
      if (inner.head) head = await inner.head(stored(appKey));
      else {
        // No metadata call (Dropbox): the header's 32 bytes come with the file's size.
        const object = await inner.read(stored(appKey), { start: 0, end: HEADER_SIZE - 1 });
        await object.stream.cancel().catch(() => {});
        head = { size: object.total };
      }
      const atRest = head.encryption?.state === "encrypted" ? ` · ${head.encryption.detail ?? "also encrypted by the provider"}` : "";
      return {
        ...head,
        size: head.size !== undefined ? plainSize(head.size) : undefined,
        contentType: mimeOf(appKey),
        encryption: { state: "encrypted", keys: "jvinu", detail: `jvinu (rclone crypt, XSalsa20-Poly1305)${atRest}` },
      };
    },

    read: async (appKey, range) => {
      const objectKey = stored(appKey);
      if (!range) {
        const object = await inner.read(objectKey);
        const { nonce, rest } = await splitHeader(object.stream);
        const total = object.size !== undefined ? plainSize(object.size) : undefined;
        return { stream: decryptBlocks(key, nonce, rest, 0), size: total, total };
      }

      // A range means the header first, for the nonce and the file's real size. A range in
      // the first block gets both in one request, which is how players start; a seek
      // further in reads the header, then only the blocks it needs.
      const firstBlock = Math.floor(range.start / BLOCK_DATA);
      let nonce: Uint8Array;
      let cipherTotal: number | undefined;
      let blocks: ReadableStream<Uint8Array> | null = null;
      if (firstBlock === 0) {
        const lastCipherByte = range.end === undefined ? undefined : HEADER_SIZE + (Math.floor(range.end / BLOCK_DATA) + 1) * BLOCK_SIZE - 1;
        const object = await inner.read(objectKey, { start: 0, end: lastCipherByte });
        ({ nonce, rest: blocks } = await splitHeader(object.stream));
        cipherTotal = object.total ?? (object.range ? undefined : object.size);
      } else {
        const header = await inner.read(objectKey, { start: 0, end: HEADER_SIZE - 1 });
        nonce = parseHeader(await readExactly(header.stream, HEADER_SIZE));
        cipherTotal = header.total;
      }
      if (cipherTotal === undefined) {
        await blocks?.cancel().catch(() => {});
        throw new StorageUserError("The service didn't report this file's size, so it can't be read in parts.", 502);
      }
      const total = plainSize(cipherTotal);
      if (range.start >= total) {
        await blocks?.cancel().catch(() => {});
        throw unsatisfiable();
      }
      const end = Math.min(range.end ?? total - 1, total - 1);
      if (!blocks) {
        const lastBlock = Math.floor(end / BLOCK_DATA);
        const cipherStart = HEADER_SIZE + firstBlock * BLOCK_SIZE;
        const cipherEnd = Math.min(cipherTotal - 1, HEADER_SIZE + (lastBlock + 1) * BLOCK_SIZE - 1);
        blocks = (await inner.read(objectKey, { start: cipherStart, end: cipherEnd })).stream;
      }
      const take = end - range.start + 1;
      return {
        stream: decryptBlocks(key, nonce, blocks, firstBlock, range.start - firstBlock * BLOCK_DATA, take),
        size: take,
        total,
        range: { start: range.start, end },
      };
    },

    write: (appKey, body, contentType) =>
      isFolderKey(appKey) ? inner.write(appKey, body, contentType) : inner.write(stored(appKey), encryptBuffer(key, body), "application/octet-stream"),

    upload: (appKey, body, size) =>
      inner.upload(stored(appKey), encryptStream(key, body), size === undefined ? undefined : encryptedSize(size), "application/octet-stream"),

    remove: async (keys) => {
      const { failed } = await inner.remove(keys.map(stored));
      return { failed: failed.flatMap((key) => shown(key) ?? []) };
    },

    // Ciphertext copies as it is: the nonce travels in the file's own header.
    copy: (source, destination) => inner.copy(stored(source), stored(destination)),

    // Headers describe ciphertext here, so only the class and tags are worth changing.
    metadataSupport: inner.metadataSupport
      ? { ...inner.metadataSupport, contentType: false, cacheControl: false, contentDisposition: false }
      : undefined,
    setMetadata: inner.setMetadata
      ? (appKey, change) => inner.setMetadata!(stored(appKey), { storageClass: change.storageClass, tags: change.tags })
      : undefined,

    rename: inner.rename ? (source, destination) => inner.rename!(stored(source), stored(destination)) : undefined,
  };
}

/** New stores need a passphrase at least this long; existing rclone stores keep theirs. */
export const MIN_PASSPHRASE = 12;

/**
 * Before an encrypted connection is saved, what's already in the bucket must suit it.
 * Files that aren't encrypted would drop out of sight (the connection shows only what it
 * can decrypt), so they're refused; files that are must open with this key, or the
 * passphrase — or rclone's salt — is wrong. Checks the first page of files.
 */
export async function checkEncryptedBucket(inner: StorageDriver, key: Uint8Array, place: string): Promise<{ encryptedFiles: number }> {
  const { files } = await inner.inventory("", 1);
  const notOurs = (name: string) =>
    new StorageUserError(
      `This ${place} already holds files that aren't encrypted, such as “${name}”. An encrypted connection shows only the files it can decrypt, so they'd drop out of sight. Choose an empty ${place}, or one that only rclone crypt writes to.`,
      409,
    );
  const plain = files.find((file) => !isFolderKey(file.key) && !file.key.endsWith(SUFFIX));
  if (plain) throw notOurs(plain.key);
  const sealed = files.filter((file) => file.key.endsWith(SUFFIX));
  // One file with data is enough: every file in a store shares the key.
  const sample = sealed.find((file) => file.size > HEADER_SIZE) ?? sealed[0];
  if (sample) {
    const object = await inner.read(sample.key, { start: 0, end: HEADER_SIZE + BLOCK_SIZE - 1 });
    const start = await readExactly(object.stream, HEADER_SIZE + BLOCK_SIZE);
    try {
      parseHeader(start);
    } catch {
      throw notOurs(sample.key);
    }
    try {
      decryptBuffer(key, start);
    } catch {
      throw new StorageUserError(
        `That passphrase doesn't open the files already in this ${place}, such as “${shown(sample.key)}”. Check it — and the salt (rclone's password2), if rclone was set up with one.`,
        422,
      );
    }
  }
  return { encryptedFiles: sealed.length };
}
