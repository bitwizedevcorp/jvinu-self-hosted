/**
 * Thumbnail cache: size cap with least-recently-used eviction, one read per original even
 * under concurrency, failures remembered, oversized originals refused.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptBuffer, encryptBuffer } from "../app/lib/server/crypt";
import type { StorageDriver } from "../app/lib/server/drivers/types";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "jvinu-thumbs-"));
  process.env.JVINU_DATA_DIR = dir;
  process.env.JVINU_THUMB_CACHE_MB = "1";
});

/** A driver serving generated images (or other bytes), counting how often each is read. */
function fakeDriver(files: Map<string, Buffer>) {
  const reads = new Map<string, number>();
  const driver = {
    read: async (key: string) => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      const data = files.get(key);
      if (!data) throw new Error("missing");
      // Arrive in pieces, like a real download.
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= data.length) return controller.close();
          controller.enqueue(new Uint8Array(data.subarray(offset, offset + 65536)));
          offset += 65536;
        },
      });
      return { stream, size: data.length, total: data.length };
    },
  } as unknown as StorageDriver;
  return { driver, reads };
}

/** Random noise compresses badly: each thumbnail is a few tens of KB. */
const noisyJpeg = (seed: number) => {
  const width = 900;
  const height = 700;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (Math.random() * 255 + seed) % 255;
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
};

const cacheBytes = () =>
  readdirSync(path.join(dir, "thumbs"))
    .filter((name) => name.endsWith(".webp") || name.endsWith(".none"))
    .reduce((sum, name) => sum + statSync(path.join(dir, "thumbs", name)).size, 0);

describe("thumbnail cache", () => {
  it("never grows past its cap, evicting the least recently used", async () => {
    const { thumbnailFor, thumbCacheStats } = await import("../app/lib/server/thumbs");
    const files = new Map<string, Buffer>();
    for (let i = 0; i < 40; i++) files.set(`pics/${i}.jpg`, await noisyJpeg(i));
    const { driver, reads } = fakeDriver(files);

    const first = await thumbnailFor(driver, "conn", "pics/0.jpg", "v1");
    expect(first).not.toBeNull();
    for (let i = 1; i < 40; i++) {
      await thumbnailFor(driver, "conn", `pics/${i}.jpg`, "v1");
      // Keep the first one in use: it should survive every eviction.
      await thumbnailFor(driver, "conn", "pics/0.jpg", "v1");
    }

    const stats = await thumbCacheStats();
    expect(stats.cap).toBe(1024 * 1024);
    expect(cacheBytes()).toBeLessThanOrEqual(stats.cap);
    expect(stats.bytes).toBeLessThanOrEqual(stats.cap);
    // 40 thumbnails don't fit in 1 MB, so some were evicted…
    expect(stats.files).toBeLessThan(40);
    // …but never the one in constant use, which was read only once.
    expect(reads.get("pics/0.jpg")).toBe(1);
    // An evicted one is made again on request (its original read a second time).
    await thumbnailFor(driver, "conn", "pics/1.jpg", "v1");
    expect(reads.get("pics/1.jpg")).toBe(2);
  }, 60_000);

  it("reads each original once, however many ask at the same time", async () => {
    const { thumbnailFor } = await import("../app/lib/server/thumbs");
    const { driver, reads } = fakeDriver(new Map([["burst.jpg", await noisyJpeg(99)]]));
    const results = await Promise.all(Array.from({ length: 12 }, () => thumbnailFor(driver, "conn", "burst.jpg", "v1")));
    expect(results.every((result) => result && result.length > 0)).toBe(true);
    expect(reads.get("burst.jpg")).toBe(1);
  });

  it("makes a new thumbnail for a new version", async () => {
    const { thumbnailFor } = await import("../app/lib/server/thumbs");
    const files = new Map([["changing.jpg", await noisyJpeg(1)]]);
    const { driver, reads } = fakeDriver(files);
    await thumbnailFor(driver, "conn", "changing.jpg", "etag-1");
    await thumbnailFor(driver, "conn", "changing.jpg", "etag-1");
    files.set("changing.jpg", await noisyJpeg(2));
    await thumbnailFor(driver, "conn", "changing.jpg", "etag-2");
    expect(reads.get("changing.jpg")).toBe(2);
  });

  it("remembers files it can't thumbnail, without fetching them again", async () => {
    const { thumbnailFor } = await import("../app/lib/server/thumbs");
    const { driver, reads } = fakeDriver(new Map([["not-really.jpg", Buffer.from("this is text, not a JPEG")]]));
    expect(await thumbnailFor(driver, "conn", "not-really.jpg", "v1")).toBeNull();
    expect(await thumbnailFor(driver, "conn", "not-really.jpg", "v1")).toBeNull();
    expect(reads.get("not-really.jpg")).toBe(1);
  });

  it("seals the cached thumbnails of an encrypted connection", async () => {
    const { thumbnailFor } = await import("../app/lib/server/thumbs");
    const key = randomBytes(32);
    const { driver, reads } = fakeDriver(new Map([["secret.jpg", await noisyJpeg(7)]]));
    const sealed: StorageDriver = { ...driver, cacheCipher: { seal: (data) => encryptBuffer(key, data), open: (data) => decryptBuffer(key, data) } };
    const thumb = await thumbnailFor(sealed, "vault", "secret.jpg", "v1");
    const isWebp = (data: Buffer) => data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP";
    expect(thumb && isWebp(thumb)).toBe(true);
    // On disk it's ciphertext…
    const file = createHash("sha256").update("vault\nsecret.jpg\nv1").digest("hex") + ".webp";
    const onDisk = readFileSync(path.join(dir, "thumbs", file));
    expect(isWebp(onDisk)).toBe(false);
    expect(onDisk.subarray(0, 6).toString("latin1")).toBe("RCLONE");
    // …and it still serves from the cache, without reading the original again.
    expect((await thumbnailFor(sealed, "vault", "secret.jpg", "v1"))?.equals(thumb!)).toBe(true);
    expect(reads.get("secret.jpg")).toBe(1);
  });

  it("refuses originals over 50 MB", async () => {
    const { thumbnailFor } = await import("../app/lib/server/thumbs");
    const huge = Buffer.alloc(51 * 1024 * 1024);
    const { driver } = fakeDriver(new Map([["huge.jpg", huge]]));
    expect(await thumbnailFor(driver, "conn", "huge.jpg", "v1")).toBeNull();
  });
});
