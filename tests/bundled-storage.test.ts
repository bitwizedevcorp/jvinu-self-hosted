/**
 * Bundled storage end to end against a real Garage: bootstrap from nothing, re-run without
 * duplicating anything, recover from a wiped storage volume, and keep the connection
 * server-owned. Needs a Garage with its admin API reachable (see the contract tests):
 *
 *   JVINU_TEST_GARAGE_TOKEN=… npm test
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ADMIN = process.env.JVINU_TEST_GARAGE_ADMIN || "http://localhost:3903";
const S3 = process.env.JVINU_TEST_GARAGE_S3 || "http://localhost:3900";
const TOKEN = process.env.JVINU_TEST_GARAGE_TOKEN || "";
const BUCKET = `jvinu-bundled-${Date.now().toString(36)}`;

const up = Boolean(TOKEN) && (await fetch(`${ADMIN}/health`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false));

describe.skipIf(!up)("bundled storage", () => {
  // Each test file gets its own database and server settings, set before the modules load.
  beforeAll(() => {
    process.env.JVINU_DATA_DIR = mkdtempSync(path.join(tmpdir(), "jvinu-bundled-"));
    process.env.JVINU_SECRET = "bundled-storage-test-secret-0123456789abcdef";
    process.env.JVINU_STORAGE_ADMIN_URL = ADMIN;
    process.env.JVINU_STORAGE_S3_URL = S3;
    process.env.JVINU_STORAGE_ADMIN_TOKEN = TOKEN;
    process.env.JVINU_STORAGE_BUCKET = BUCKET;
  });

  const load = async () => {
    const storage = await import("../app/lib/server/bundled-storage");
    const connections = await import("../app/lib/server/connections");
    const { driverFor } = await import("../app/lib/server/drivers");
    return { ...storage, ...connections, driverFor };
  };
  const admin = { adminUrl: ADMIN, token: TOKEN };

  afterAll(async () => {
    const { garage, findManaged, driverFor } = await load();
    const managed = await findManaged("bundled-storage");
    if (managed) {
      const driver = driverFor(managed);
      await driver.remove((await driver.listKeys("", 10_000)).keys);
    }
    const info = await garage<{ id: string }>(admin, `GetBucketInfo?globalAlias=${BUCKET}`).catch(() => null);
    if (info) await garage(admin, `DeleteBucket?id=${info.id}`, {}).catch(() => {});
  });

  it("is off without the admin token", async () => {
    const { bundledConfig } = await load();
    const saved = process.env.JVINU_STORAGE_ADMIN_TOKEN;
    delete process.env.JVINU_STORAGE_ADMIN_TOKEN;
    process.env.JVINU_STORAGE_ADMIN_TOKEN_FILE = "/nonexistent/admin_token";
    expect(bundledConfig()).toBeNull();
    process.env.JVINU_STORAGE_ADMIN_TOKEN = saved;
    delete process.env.JVINU_STORAGE_ADMIN_TOKEN_FILE;
  });

  it("bootstraps a working “My storage” connection", async () => {
    const { ensureBundledStorage, listConnections, toPublic, driverFor } = await load();
    expect(await ensureBundledStorage()).toBe(true);
    const all = await listConnections();
    expect(all).toHaveLength(1);
    const [mine] = all;
    expect(mine).toMatchObject({ name: "My storage", presetId: "garage", managed: "bundled-storage", bucket: BUCKET, endpoint: S3 });
    // Private endpoint, no public URL: files go through the app.
    expect(toPublic(mine)).toMatchObject({ managed: true, canShareLinks: false });
    const driver = driverFor(mine);
    await driver.write("hello.txt", new TextEncoder().encode("hi"));
    expect(await new Response((await driver.read("hello.txt")).stream).text()).toBe("hi");
    expect(await driver.signedUrl("hello.txt", false, 900)).toBeNull();
  });

  it("runs again without duplicating keys, buckets or connections", async () => {
    // As if a second server had raced this one and made its own key.
    await (await load()).garage(admin, "CreateKey", { name: "jvinu" });
    vi.resetModules(); // a restarted server: fresh module state, same database
    const { ensureBundledStorage, listConnections, garage } = await load();
    expect(await ensureBundledStorage()).toBe(true);
    expect(await listConnections()).toHaveLength(1);
    const keys = await garage<{ name: string }[]>(admin, "ListKeys");
    expect(keys.filter((key) => key.name === "jvinu")).toHaveLength(1);
    const buckets = await garage<{ globalAliases: string[] }[]>(admin, "ListBuckets");
    expect(buckets.filter((bucket) => bucket.globalAliases.includes(BUCKET))).toHaveLength(1);
  });

  it("follows a new key when the storage was reset, keeping the connection and its data", async () => {
    const { garage, findManaged } = await load();
    const before = await findManaged("bundled-storage");
    const keys = await garage<{ id: string; name: string }[]>(admin, "ListKeys");
    const old = keys.find((key) => key.name === "jvinu")!;
    await garage(admin, `DeleteKey?id=${old.id}`, {});

    vi.resetModules();
    const fresh = await load();
    expect(await fresh.ensureBundledStorage()).toBe(true);
    const after = await fresh.findManaged("bundled-storage");
    expect(after?.id).toBe(before?.id);
    expect(after?.credentials).not.toEqual(before?.credentials);
    const driver = fresh.driverFor(after!);
    expect(await new Response((await driver.read("hello.txt")).stream).text()).toBe("hi");
  });

  it("repairs itself after JVINU_SECRET changes, instead of adding a second one", async () => {
    const before = (await (await load()).findManaged("bundled-storage"))!;
    process.env.JVINU_SECRET = "a-different-master-key-after-a-mistake-0123456789";
    vi.resetModules();
    const fresh = await load();
    expect(await fresh.findManaged("bundled-storage")).toBeUndefined(); // unreadable now
    expect(await fresh.ensureBundledStorage()).toBe(true);
    const all = await fresh.listConnections();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: before.id, name: "My storage", managed: "bundled-storage" });
  });

  it("reports the disk and blocks at 95%", async () => {
    const { storageDisk, diskBlocks } = await load();
    const disk = await storageDisk();
    expect(disk).not.toBeNull();
    expect(disk!.total).toBeGreaterThan(0);
    expect(disk!.used + disk!.available).toBe(disk!.total);
    expect(["ok", "warn", "full"]).toContain(disk!.level);
    // Whatever is free now, asking for all of it crosses the line.
    expect(await diskBlocks(disk!.available)).toMatch(/95%|full/);
    if (disk!.ratio < 0.9) expect(await diskBlocks(0)).toBeNull();
  });
});
