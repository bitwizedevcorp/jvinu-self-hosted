/**
 * A share copy adds data to the share bucket, which may be a managed connection (bundled
 * storage, a paid plan): a new copy must fit, but reusing a ready one needs no room.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { memoryDriver } from "./memory-driver";

/** A stand-in for the managed limit: full or not, as each test says. */
const limit = { full: false };
vi.mock("@/app/lib/server/bundled-storage", () => ({
  managedBlocks: async () => (limit.full ? "My storage is 96% full (1 GB free). Delete something before uploading more." : null),
}));

beforeAll(() => {
  process.env.JVINU_DATA_DIR = mkdtempSync(path.join(tmpdir(), "jvinu-share-quota-"));
  process.env.JVINU_SECRET = "share-quota-test-secret-0123456789abcdef0123";
  delete process.env.JVINU_DATABASE_URL;
});

const source = memoryDriver({ "docs/report.pdf": "the report" });
const bucket = memoryDriver();
const BUCKET = { id: "managed-share-bucket", prefix: "jvinu-shares/" };
const copies = () => import("../app/lib/server/share-copies");

beforeAll(async () => {
  const { insertConnection } = await import("../app/lib/server/connections");
  await insertConnection({
    id: BUCKET.id,
    presetId: "garage",
    name: "My storage",
    bucket: "shares",
    region: "garage",
    credentials: { kind: "s3", accessKeyId: "test", secretAccessKey: "test" },
    readOnly: false,
    managed: "bundled-storage",
    settings: { shareTarget: { prefix: BUCKET.prefix } },
    createdBy: "system",
    createdAt: new Date().toISOString(),
  });
  (await copies()).resolveDriversWith(async (id) => (id === "origin" ? source : id === BUCKET.id ? bucket : null));
});
afterAll(async () => (await copies()).resolveDriversWith(null));

const copyOf = async (version: string) =>
  (await copies()).copyFor({ userId: "alice", sourceConnectionId: "origin", key: "docs/report.pdf", version, size: 10, bucket: BUCKET });

describe("share copies into a share bucket on a managed connection", () => {
  it("refuse a new copy when it's full, but reuse an existing one", async () => {
    limit.full = false;
    const first = await copyOf("v1");
    limit.full = true;
    // Same version: the copy already there is reused, nothing is written, nothing to refuse.
    expect((await copyOf("v1")).id).toBe(first.id);
    // A new version needs a new copy, which doesn't fit.
    await expect(copyOf("v2")).rejects.toMatchObject({ status: 507, message: expect.stringMatching(/full/) });
  });
});
