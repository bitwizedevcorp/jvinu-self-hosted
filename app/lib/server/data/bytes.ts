import "server-only";
import { StorageUserError, type StorageDriver } from "../drivers/types";

/**
 * Reads up to `limit` bytes from a stream, skipping `skip` first, then cancels it — so a
 * provider that ignored a range request (and sent the whole object) costs only what's used.
 */
export async function take(stream: ReadableStream<Uint8Array>, limit: number, skip = 0): Promise<{ bytes: Uint8Array; ended: boolean }> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let have = 0;
  let toSkip = skip;
  let ended = false;
  try {
    while (have < limit) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      let chunk = value;
      if (toSkip) {
        if (chunk.byteLength <= toSkip) {
          toSkip -= chunk.byteLength;
          continue;
        }
        chunk = chunk.subarray(toSkip);
        toSkip = 0;
      }
      if (have + chunk.byteLength > limit) chunk = chunk.subarray(0, limit - have);
      parts.push(chunk);
      have += chunk.byteLength;
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(have);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, ended };
}

/** Bytes `start`…`end` (inclusive) of an object, and the object's size when the provider says. */
export async function readBytes(
  driver: StorageDriver,
  key: string,
  start: number,
  end: number,
): Promise<{ bytes: Uint8Array; total?: number }> {
  const body = await driver.read(key, { start, end });
  // No `range` on the body: the provider sent the object from its first byte.
  const skip = body.range ? 0 : start;
  if (!body.range && start > 256 * 1024 * 1024) {
    await body.stream.cancel().catch(() => {});
    throw new StorageUserError("This storage service doesn't support reading part of a file, so it can't be previewed.", 501);
  }
  const { bytes } = await take(body.stream, end - start + 1, skip);
  return { bytes, total: body.total ?? (body.range ? undefined : body.size) };
}

/** An object's size, from a one-byte read. */
export async function objectSize(driver: StorageDriver, key: string): Promise<{ size: number; head: Uint8Array }> {
  const { bytes, total } = await readBytes(driver, key, 0, 3);
  if (total === undefined) throw new StorageUserError("The storage service didn't say how big this file is.", 502);
  return { size: total, head: bytes };
}

export type Prefix = {
  /** The first bytes of the content — decompressed, for a gzipped file. */
  bytes: Uint8Array;
  /** True when `bytes` is all of it. */
  complete: boolean;
  /** The object's size as stored (compressed, for a gzipped file). */
  size: number;
  /** Stored bytes that produced `bytes`: with `size`, a way to estimate the whole from a part. */
  consumed: number;
};

const isEmptyObject = (error: unknown) => error instanceof StorageUserError && error.status === 416;

/** The first `limit` bytes of an object, decompressing on the way when it's gzipped. */
export async function readPrefix(driver: StorageDriver, key: string, limit: number, gzip: boolean): Promise<Prefix> {
  // Text compresses well, but leave room for data that doesn't.
  const stored = gzip ? limit * 4 : limit;
  let body: Awaited<ReturnType<StorageDriver["read"]>>;
  try {
    body = await driver.read(key, { start: 0, end: stored - 1 });
  } catch (error) {
    if (isEmptyObject(error)) return { bytes: new Uint8Array(0), complete: true, size: 0, consumed: 0 };
    throw error;
  }
  const size = body.total ?? body.size ?? 0;

  if (!gzip) {
    const { bytes, ended } = await take(body.stream, limit);
    return { bytes, complete: body.total !== undefined ? body.total <= limit : ended && bytes.length < limit, size, consumed: bytes.length };
  }

  const { createGunzip } = await import("node:zlib");
  const reader = body.stream.getReader();
  const gunzip = createGunzip();
  const parts: Buffer[] = [];
  let have = 0;
  let consumed = 0;
  let sourceDone = false;
  let finished = false;

  const result = await new Promise<{ complete: boolean }>((resolve, reject) => {
    gunzip.on("data", (chunk: Buffer) => {
      if (finished) return;
      parts.push(chunk);
      have += chunk.length;
      if (have >= limit) {
        finished = true;
        resolve({ complete: false });
      }
    });
    gunzip.on("end", () => {
      if (finished) return;
      finished = true;
      resolve({ complete: sourceDone && size <= stored });
    });
    gunzip.on("error", (error: Error & { code?: string }) => {
      if (finished) return;
      finished = true;
      // The range ended mid-stream: what came out so far is still a valid prefix.
      if (error.code === "Z_BUF_ERROR" || /unexpected end/i.test(error.message)) resolve({ complete: false });
      else reject(new StorageUserError("This file isn't valid gzip.", 422));
    });
    void (async () => {
      try {
        while (!finished) {
          const { value, done } = await reader.read();
          if (done) {
            sourceDone = true;
            gunzip.end();
            return;
          }
          consumed += value.byteLength;
          if (!gunzip.write(value))
            await new Promise((r) => {
              gunzip.once("drain", r);
              gunzip.once("close", r);
            });
        }
      } catch (error) {
        if (!finished) {
          finished = true;
          reject(error);
        }
      }
    })();
  }).finally(async () => {
    if (!sourceDone) await reader.cancel().catch(() => {});
    gunzip.destroy();
  });

  const all = Buffer.concat(parts);
  return { bytes: new Uint8Array(all.buffer, all.byteOffset, Math.min(all.length, limit)), complete: result.complete, size, consumed };
}
