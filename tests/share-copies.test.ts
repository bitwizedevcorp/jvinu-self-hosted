/**
 * The share bucket: a shared file is copied there once per version, links serve the copy
 * once it's ready, the original is only ever read, and copies go when no link needs them.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StorageUserError, type StorageDriver } from "../app/lib/server/drivers/types";

beforeAll(() => {
  process.env.JVINU_DATA_DIR = mkdtempSync(path.join(tmpdir(), "jvinu-share-copies-"));
  process.env.JVINU_SECRET = "share-copies-test-secret-0123456789abcdef0123";
  delete process.env.JVINU_DATABASE_URL;
});

/** A bucket in memory that records every call made to it. */
function memoryBucket() {
  const objects = new Map<string, { data: Buffer; etag: string; type?: string }>();
  const calls: string[] = [];
  let version = 0;
  /** Set to hold reads open until released (to watch a copy in progress). */
  let gate: Promise<void> | null = null;
  const missing = () => new StorageUserError("That object no longer exists.", 404);
  const driver: StorageDriver = {
    verify: async () => ({}),
    list: async () => ({ folders: [], files: [] }),
    listKeys: async () => ({ keys: [...objects.keys()], truncated: false }),
    stats: async () => ({ objects: objects.size, bytes: 0, lastModified: null, truncated: false }),
    inventory: async () => ({ files: [], truncated: false }),
    signedUrl: async () => null,
    head: async (key) => {
      calls.push(`head ${key}`);
      const object = objects.get(key);
      if (!object) throw missing();
      return { size: object.data.length, etag: object.etag, encryption: { state: "unknown" } };
    },
    read: async (key) => {
      calls.push(`read ${key}`);
      const object = objects.get(key);
      if (!object) throw missing();
      const waitFor = gate;
      const body = object.data;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (waitFor) await waitFor;
          controller.enqueue(new Uint8Array(body));
          controller.close();
        },
      });
      return { stream, size: body.length, total: body.length, contentType: object.type };
    },
    write: async (key, body, type) => {
      calls.push(`write ${key}`);
      objects.set(key, { data: Buffer.from(body), etag: `v${++version}`, type });
    },
    upload: async (key, body, _size, type) => {
      calls.push(`upload ${key}`);
      objects.set(key, { data: Buffer.from(await new Response(body).arrayBuffer()), etag: `v${++version}`, type });
    },
    remove: async (keys) => {
      calls.push(`remove ${keys.join(",")}`);
      for (const key of keys) objects.delete(key);
      return { failed: [] };
    },
    copy: async (from, to) => {
      calls.push(`copy ${from} ${to}`);
      const object = objects.get(from);
      if (!object) throw missing();
      objects.set(to, { ...object });
    },
  };
  return {
    driver,
    objects,
    calls,
    hold: () => {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

const source = memoryBucket();
const bucket = memoryBucket();
const BUCKET = { id: "share-bucket", prefix: "jvinu-shares/" };

const copies = () => import("../app/lib/server/share-copies");
const shares = () => import("../app/lib/server/shares");

beforeAll(async () => {
  (await copies()).resolveDriversWith(async (id) => (id === "origin" ? source.driver : id === BUCKET.id ? bucket.driver : null));
});
afterAll(async () => (await copies()).resolveDriversWith(null));

async function settled(id: string) {
  const { getCopy } = await copies();
  for (let i = 0; i < 100; i++) {
    const copy = await getCopy(id);
    if (copy && copy.status !== "copying") return copy;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const { db } = await import("../app/lib/server/db");
  const database = await db();
  const row = await database.get(`select * from share_copies where id = ?`, [id]);
  const jobs = await database.all(`select op, status, error, total, done from jobs`);
  throw new Error(`the copy never finished: ${JSON.stringify({ row, jobs })}`);
}

async function share(key: string, version: string, options: { maxDownloads?: number | null; expiresAt?: string | null } = {}) {
  const { copyFor } = await copies();
  const copy = await copyFor({ userId: "alice", sourceConnectionId: "origin", key, version, size: null, bucket: BUCKET });
  const { link } = await (await shares()).createShareLink({
    connectionId: "origin",
    key,
    createdBy: "alice",
    expiresAt: options.expiresAt ?? null,
    maxDownloads: options.maxDownloads ?? null,
    copyId: copy.id,
    meta: { name: key.split("/").pop()!, size: null },
  });
  return { copy, link };
}

describe("the share bucket", () => {
  it("copies a file once, and reuses the copy for the same version", async () => {
    await source.driver.write("docs/report.pdf", Buffer.from("the original report"), "application/pdf");
    const first = await share("docs/report.pdf", "v1");
    const ready = await settled(first.copy.id);
    expect(ready.status).toBe("ready");
    expect(ready.targetKey).toBe(`jvinu-shares/${ready.id}/report.pdf`);
    expect(bucket.objects.get(ready.targetKey)?.data.toString()).toBe("the original report");
    expect(bucket.objects.get(ready.targetKey)?.type).toBe("application/pdf");

    const second = await share("docs/report.pdf", "v1");
    expect(second.copy.id).toBe(first.copy.id);
    // Two shares at the same moment wait for one copy, too.
    await source.driver.write("docs/burst.txt", Buffer.from("shared twice at once"));
    const [a, b] = await Promise.all([share("docs/burst.txt", "b1"), share("docs/burst.txt", "b1")]);
    expect(a.copy.id).toBe(b.copy.id);
    await settled(a.copy.id);
    expect(source.calls.filter((call) => call === "read docs/report.pdf")).toHaveLength(1);
    expect(source.calls.filter((call) => call === "read docs/burst.txt")).toHaveLength(1);
  });

  it("makes a new copy when the file has changed", async () => {
    await source.driver.write("docs/report.pdf", Buffer.from("the revised report"));
    const { copy } = await share("docs/report.pdf", "v2");
    const ready = await settled(copy.id);
    expect(bucket.objects.get(ready.targetKey)?.data.toString()).toBe("the revised report");
    expect(source.calls.filter((call) => call === "read docs/report.pdf")).toHaveLength(2);
  });

  it("never changes the original", () => {
    const writes = source.calls.filter((call) => !call.startsWith("read ") && !call.startsWith("head "));
    // Only this test file's own setup wrote to the source.
    expect(writes.every((call) => call.startsWith("write "))).toBe(true);
    expect(source.calls.some((call) => /^(upload|remove|copy) /.test(call))).toBe(false);
  });

  it("serves links from the copy once it's there, and from the original until then", async () => {
    const { servedFromCopy } = await copies();
    await source.driver.write("media/clip.mp4", Buffer.from("a big video"));
    const release = source.hold();
    const { copy, link } = await share("media/clip.mp4", "c1");
    expect(await servedFromCopy(link)).toBeNull();
    release();
    await settled(copy.id);
    const served = await servedFromCopy(link);
    expect(served?.driver).toBe(bucket.driver);
    expect(served?.key).toBe(`jvinu-shares/${copy.id}/clip.mp4`);
  });

  it("removes a copy once no working link needs it", async () => {
    const { sweepCopies, getCopy } = await copies();
    const { revokeShareLink, claimDownload } = await shares();
    await source.driver.write("out/once.zip", Buffer.from("zip bytes"));
    const soon = new Date(Date.now() + 60_000).toISOString();
    const revoked = await share("out/once.zip", "z1");
    const expiring = await share("out/once.zip", "z1", { expiresAt: soon });
    const capped = await share("out/once.zip", "z1", { maxDownloads: 1 });
    const copy = await settled(revoked.copy.id);
    expect(expiring.copy.id).toBe(copy.id);
    expect(capped.copy.id).toBe(copy.id);

    await revokeShareLink(revoked.link.id, "alice");
    await sweepCopies();
    expect(bucket.objects.has(copy.targetKey)).toBe(true); // two links still use it
    expect(await claimDownload(capped.link.id)).toBe(true);
    await sweepCopies();
    expect(bucket.objects.has(copy.targetKey)).toBe(true); // the expiring one still does
    await sweepCopies(Date.now() + 61_000);
    expect(bucket.objects.has(copy.targetKey)).toBe(false);
    expect(await getCopy(copy.id)).toBeUndefined();
  });

  it("keeps a fresh copy while its link is still being made", async () => {
    const { copyFor, sweepCopies, getCopy } = await copies();
    await source.driver.write("quick/tiny.txt", Buffer.from("copied in no time"));
    // The copy can finish before the link that asked for it is saved.
    const copy = await copyFor({ userId: "alice", sourceConnectionId: "origin", key: "quick/tiny.txt", version: "t1", size: 17, bucket: BUCKET });
    await settled(copy.id);
    await sweepCopies();
    expect(bucket.objects.has(copy.targetKey)).toBe(true);
    // One that never gets a link is cleared up after a while.
    await sweepCopies(Date.now() + 2 * 3600_000);
    expect(bucket.objects.has(copy.targetKey)).toBe(false);
    expect(await getCopy(copy.id)).toBeUndefined();
  });

  it("leaves nothing behind when a copy fails", async () => {
    const { copyFor, sweepCopies, getCopy } = await copies();
    const broken = memoryBucket();
    broken.driver.read = async () => ({
      stream: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error("connection reset"));
        },
      }),
      size: 100,
    });
    (await copies()).resolveDriversWith(async (id) => (id === "broken" ? broken.driver : id === BUCKET.id ? bucket.driver : null));
    try {
      const copy = await copyFor({ userId: "alice", sourceConnectionId: "broken", key: "x.bin", version: "1", size: 100, bucket: BUCKET });
      const done = await settled(copy.id);
      expect(done.status).toBe("failed");
      expect(bucket.objects.has(copy.targetKey)).toBe(false);
      await sweepCopies();
      expect(await getCopy(copy.id)).toBeUndefined();
    } finally {
      (await copies()).resolveDriversWith(async (id) => (id === "origin" ? source.driver : id === BUCKET.id ? bucket.driver : null));
    }
  });

  it("is only offered for encrypted files when the share bucket is encrypted too", async () => {
    const { shareBucketRefusal } = await copies();
    const key = { key: Buffer.alloc(80) };
    const plainBucket = { id: "b", readOnly: false, settings: { shareTarget: { prefix: "s/" } } };
    expect(shareBucketRefusal({ id: "a" }, plainBucket)).toBeNull();
    expect(shareBucketRefusal({ id: "a", crypt: key }, plainBucket)).toMatch(/encrypted/);
    expect(shareBucketRefusal({ id: "a", crypt: key }, { ...plainBucket, crypt: key })).toBeNull();
    expect(shareBucketRefusal({ id: "b" }, plainBucket)).toMatch(/itself/);
    expect(shareBucketRefusal({ id: "a" }, { ...plainBucket, readOnly: true })).toMatch(/read-only/);
    expect(shareBucketRefusal({ id: "a" }, undefined)).toMatch(/No connection/);
  });
});
