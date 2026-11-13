import "server-only";
import { randomBytes, scrypt } from "node:crypto";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { StorageUserError } from "./drivers/types";

/**
 * rclone's "crypt" file format, implemented from its documentation and source
 * (github.com/rclone/rclone, backend/crypt, MIT licence) so files stay readable by rclone:
 *
 *   header  "RCLONE\0\0" + a random 24-byte nonce                         (32 bytes)
 *   blocks  each 64 KiB of plaintext sealed with NaCl secretbox (XSalsa20-Poly1305):
 *           a 16-byte tag, then the ciphertext; the nonce counts up by one per block
 *
 * The key is scrypt(passphrase, salt, N=16384, r=8, p=1) → 80 bytes, of which the first 32
 * encrypt contents. The rest are for names, which jvinu leaves readable (rclone's
 * filename_encryption = off, where each object gets a ".bin" suffix).
 */

export const MAGIC = Buffer.from("RCLONE\x00\x00", "latin1");
const NONCE_SIZE = 24;
export const HEADER_SIZE = MAGIC.length + NONCE_SIZE;
export const BLOCK_DATA = 64 * 1024;
const TAG_SIZE = 16;
export const BLOCK_SIZE = BLOCK_DATA + TAG_SIZE;
/** rclone's salt when none is configured ("password2" left empty). */
const DEFAULT_SALT = Buffer.from([0xa8, 0x0d, 0xf4, 0x3a, 0x8f, 0xbd, 0x03, 0x08, 0xa7, 0xca, 0xb8, 0x3e, 0x58, 0x1f, 0x86, 0xb1]);
/** The suffix rclone gives encrypted objects when names aren't encrypted. */
export const SUFFIX = ".bin";

/** Bytes of key material rclone derives: the content key (32), then the name key (32) and tweak (16). */
export const KEY_MATERIAL = 80;

/**
 * All of rclone's key material for a passphrase and optional salt (rclone's "password2").
 * jvinu keeps all 80 bytes, so names could be encrypted later without asking again.
 */
export function deriveKey(passphrase: string, salt?: string): Promise<Buffer> {
  if (!passphrase) throw new Error("A passphrase is required.");
  return new Promise((resolve, reject) =>
    scrypt(passphrase, salt ? Buffer.from(salt, "utf8") : DEFAULT_SALT, KEY_MATERIAL, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

/** The 32-byte content key out of the key material. */
export const dataKeyOf = (material: Uint8Array) => material.subarray(0, 32);

/** The 32-byte content key for a passphrase, as rclone derives it. */
export async function deriveDataKey(passphrase: string, salt?: string): Promise<Buffer> {
  return Buffer.from(dataKeyOf(await deriveKey(passphrase, salt)));
}

/** Ciphertext size for `size` bytes of plaintext. */
export function encryptedSize(size: number): number {
  const blocks = Math.floor(size / BLOCK_DATA);
  const residue = size % BLOCK_DATA;
  return HEADER_SIZE + blocks * BLOCK_SIZE + (residue ? TAG_SIZE + residue : 0);
}

/** Plaintext size for `size` bytes of ciphertext; null if no valid file has that size. */
export function decryptedSize(size: number): number | null {
  const body = size - HEADER_SIZE;
  if (body < 0) return null;
  const blocks = Math.floor(body / BLOCK_SIZE);
  let residue = body % BLOCK_SIZE;
  if (residue) {
    residue -= TAG_SIZE;
    if (residue <= 0) return null;
  }
  return blocks * BLOCK_DATA + residue;
}

/** The nonce for block `index`: the file's nonce plus `index`, little-endian with carry. */
function nonceFor(base: Uint8Array, index: number): Uint8Array {
  const nonce = Uint8Array.from(base);
  let carry = index;
  for (let i = 0; i < nonce.length && carry > 0; i++) {
    const sum = nonce[i] + (carry % 256);
    nonce[i] = sum & 0xff;
    carry = Math.floor(carry / 256) + (sum >> 8);
  }
  return nonce;
}

const badFile = () =>
  new StorageUserError("This file couldn't be decrypted: wrong passphrase, or it wasn't encrypted with this connection's key.", 422);

function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return xsalsa20poly1305(key, nonce).encrypt(plaintext);
}

function open(key: Uint8Array, nonce: Uint8Array, block: Uint8Array): Uint8Array {
  try {
    return xsalsa20poly1305(key, nonce).decrypt(block);
  } catch {
    throw badFile();
  }
}

/** Reads a 32-byte header; returns the file's nonce. */
export function parseHeader(header: Uint8Array): Uint8Array {
  if (header.length < HEADER_SIZE || !Buffer.from(header.subarray(0, MAGIC.length)).equals(MAGIC)) throw badFile();
  return header.slice(MAGIC.length, HEADER_SIZE);
}

/** Small writes: the whole file at once. */
export function encryptBuffer(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_SIZE);
  const out = new Uint8Array(encryptedSize(plaintext.length));
  out.set(MAGIC, 0);
  out.set(nonce, MAGIC.length);
  let offset = HEADER_SIZE;
  for (let index = 0, start = 0; start < plaintext.length; index++, start += BLOCK_DATA) {
    const sealed = seal(key, nonceFor(nonce, index), plaintext.subarray(start, start + BLOCK_DATA));
    out.set(sealed, offset);
    offset += sealed.length;
  }
  return out;
}

/** Small reads: a whole file (header included) at once. */
export function decryptBuffer(key: Uint8Array, file: Uint8Array): Uint8Array {
  const nonce = parseHeader(file);
  if (decryptedSize(file.length) === null) throw badFile();
  const out: Uint8Array[] = [];
  for (let index = 0, offset = HEADER_SIZE; offset < file.length; index++, offset += BLOCK_SIZE) {
    out.push(open(key, nonceFor(nonce, index), file.subarray(offset, offset + BLOCK_SIZE)));
  }
  return Buffer.concat(out);
}

/** Collects a stream into exact `size`-byte pieces (the last may be shorter). */
async function* pieces(source: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  const reader = source.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending.push(value);
      pendingBytes += value.byteLength;
      while (pendingBytes >= size) {
        const joined = Buffer.concat(pending, pendingBytes);
        yield joined.subarray(0, size);
        const rest = joined.subarray(size);
        pending = rest.length ? [rest] : [];
        pendingBytes = rest.length;
      }
    }
    if (pendingBytes) yield Buffer.concat(pending, pendingBytes);
  } finally {
    reader.releaseLock();
  }
}

/** Uploads: plaintext in, ciphertext out, one 64 KiB block at a time. */
export function encryptStream(key: Uint8Array, source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const nonce = randomBytes(NONCE_SIZE);
  const blocks = pieces(source, BLOCK_DATA);
  let index = 0;
  let headerSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(Buffer.concat([MAGIC, nonce]));
        return;
      }
      const { value, done } = await blocks.next();
      if (done) return controller.close();
      controller.enqueue(seal(key, nonceFor(nonce, index++), value));
    },
    async cancel(reason) {
      await blocks.return(undefined);
      await source.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Downloads: ciphertext blocks in (starting at block `firstBlock`), plaintext out —
 * skipping `skip` bytes of the first block and stopping after `take` bytes (for ranges).
 * Cancelling the result cancels the upstream read.
 */
export function decryptBlocks(
  key: Uint8Array,
  nonce: Uint8Array,
  source: ReadableStream<Uint8Array>,
  firstBlock: number,
  skip = 0,
  take = Number.POSITIVE_INFINITY,
): ReadableStream<Uint8Array> {
  const blocks = pieces(source, BLOCK_SIZE);
  let index = firstBlock;
  let toSkip = skip;
  let left = take;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (left <= 0) {
        await blocks.return(undefined);
        await source.cancel().catch(() => {});
        return controller.close();
      }
      const { value, done } = await blocks.next();
      if (done) return controller.close();
      if (value.length <= TAG_SIZE) throw badFile();
      let plain = open(key, nonceFor(nonce, index++), value);
      if (toSkip) {
        plain = plain.subarray(Math.min(toSkip, plain.length));
        toSkip = 0;
      }
      if (plain.length > left) plain = plain.subarray(0, left);
      left -= plain.length;
      if (plain.length) controller.enqueue(plain);
    },
    async cancel(reason) {
      await blocks.return(undefined);
      await source.cancel(reason).catch(() => {});
    },
  });
}

/** Splits the header off a stream that starts at byte 0. */
export async function splitHeader(source: ReadableStream<Uint8Array>): Promise<{ nonce: Uint8Array; rest: ReadableStream<Uint8Array> }> {
  const reader = source.getReader();
  const head: Uint8Array[] = [];
  let length = 0;
  while (length < HEADER_SIZE) {
    const { value, done } = await reader.read();
    if (done) break;
    head.push(value);
    length += value.byteLength;
  }
  const joined = Buffer.concat(head, length);
  const nonce = parseHeader(joined);
  const leftover = joined.subarray(HEADER_SIZE);
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      if (leftover.length) controller.enqueue(new Uint8Array(leftover));
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
  return { nonce, rest };
}
