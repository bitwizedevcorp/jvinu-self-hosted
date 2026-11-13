/**
 * App-issued share links: limits (expiry, download cap, revoke) checked atomically,
 * tokens and passwords kept only as hashes, wrong passwords throttled, and delivery that
 * works on every kind of provider — a short signed link where the provider makes one,
 * the bytes through this app everywhere else.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { StorageDriver } from "../app/lib/server/drivers/types";
import { MOCK_APP_KEY, MOCK_REFRESH_TOKEN, startDropboxMock } from "./dropbox-mock";
import { MOCK_CLIENT_ID, MOCK_REFRESH_TOKEN as ONEDRIVE_REFRESH_TOKEN, MOCK_TENANT, startOneDriveMock } from "./onedrive-mock";

beforeAll(() => {
  process.env.JVINU_DATA_DIR = mkdtempSync(path.join(tmpdir(), "jvinu-shares-"));
  process.env.JVINU_SECRET = "shares-test-secret-0123456789abcdef0123456789";
  delete process.env.JVINU_DATABASE_URL;
});

const shares = () => import("../app/lib/server/shares");
const access = () => import("../app/lib/server/share-access");
const serve = () => import("../app/lib/server/share-serve");

const meta = { name: "report.pdf", size: 1234 };
const newLink = async (options: { maxDownloads?: number | null; expiresAt?: string | null; password?: string; createdBy?: string } = {}) =>
  (await shares()).createShareLink({
    connectionId: "conn",
    key: "docs/report.pdf",
    createdBy: options.createdBy ?? "alice",
    expiresAt: options.expiresAt ?? null,
    maxDownloads: options.maxDownloads ?? null,
    password: options.password,
    meta,
  });

const headersFrom = (address: string) => new Headers({ "x-forwarded-for": address });

describe("share links", () => {
  it("stop at the download cap", async () => {
    const { claimDownload, getShareLink, stateOf } = await shares();
    const { link } = await newLink({ maxDownloads: 2 });
    expect(await claimDownload(link.id)).toBe(true);
    expect(await claimDownload(link.id)).toBe(true);
    expect(await claimDownload(link.id)).toBe(false);
    const after = (await getShareLink(link.id))!.link;
    expect(after.downloads).toBe(2);
    expect(stateOf(after)).toBe("used-up");
  });

  it("stop at expiry", async () => {
    const { claimDownload, stateOf } = await shares();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const { link } = await newLink({ expiresAt });
    expect(await claimDownload(link.id)).toBe(true);
    const later = new Date(Date.now() + 61_000);
    expect(await claimDownload(link.id, later)).toBe(false);
    expect(stateOf(link, later.getTime())).toBe("expired");
  });

  it("stop when revoked — by their creator only", async () => {
    const { claimDownload, revokeShareLink, stateOf } = await shares();
    const { link } = await newLink();
    expect(await revokeShareLink(link.id, "mallory")).toBeUndefined();
    expect(await claimDownload(link.id)).toBe(true);
    const revoked = await revokeShareLink(link.id, "alice");
    expect(revoked?.revokedAt).toBeTruthy();
    expect(stateOf(revoked!)).toBe("revoked");
    expect(await claimDownload(link.id)).toBe(false);
  });

  it("give the last download to exactly one of many racing for it", async () => {
    const { claimDownload } = await shares();
    const { link } = await newLink({ maxDownloads: 5 });
    const results = await Promise.all(Array.from({ length: 25 }, () => claimDownload(link.id)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it("keep only hashes of tokens and passwords", async () => {
    const { db } = await import("../app/lib/server/db");
    const { findShareByToken, getShareLink, passwordMatches } = await shares();
    const { link, token } = await newLink({ password: "open sesame" });
    const row = await (await db()).get<Record<string, string>>(`select * from share_links where id = ?`, [link.id]);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain("open sesame");
    expect((await findShareByToken(token))?.link.id).toBe(link.id);
    expect(await findShareByToken(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeUndefined();
    expect(await findShareByToken("not a token")).toBeUndefined();
    // Its owner can still copy it again: the token is sealed under the master key.
    expect((await getShareLink(link.id))?.token).toBe(token);
    const found = await findShareByToken(token);
    expect(await passwordMatches("open sesame", found!.passwordHash!)).toBe(true);
    expect(await passwordMatches("open sesame!", found!.passwordHash!)).toBe(false);
  });

  it("throttle wrong passwords, from one address and from everyone", async () => {
    const { checkPassword } = await access();
    const { resetLimits, FREE_MISSES } = await import("../app/lib/server/rate-limit");
    resetLimits();
    process.env.JVINU_TRUST_PROXY = "1";
    const { link, token } = await newLink({ password: "correct password" });
    const { passwordHash } = (await (await shares()).findShareByToken(token))!;
    const guess = (password: string, address = "203.0.113.7") => checkPassword(link, passwordHash, password, headersFrom(address));

    expect((await guess(""))?.code).toBe("password-needed");
    for (let i = 0; i < FREE_MISSES; i++) expect((await guess(`wrong ${i}`))?.code).toBe("wrong-password");
    // Now even the right password has to wait its turn…
    const slowed = await guess("correct password");
    expect(slowed?.code).toBe("slow-down");
    expect(slowed?.status).toBe(429);
    expect(slowed?.retryAfter).toBeGreaterThanOrEqual(1);
    // …and each further miss doubles the wait.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await guess("wrong again"))?.retryAfter).toBeGreaterThanOrEqual(2);
    // Another address isn't held up by this one…
    expect(await guess("correct password", "198.51.100.1")).toBeNull();
    // …until the link as a whole has had too many misses.
    for (let i = 0; i < 20; i++) await guess(`spray ${i}`, `192.0.2.${i}`);
    expect((await guess("correct password", "198.51.100.99"))?.code).toBe("slow-down");
    delete process.env.JVINU_TRUST_PROXY;
    resetLimits();
  });

  it("refuse links that don't exist or no longer work, and rate-limit visits", async () => {
    const { openLink, overLimit } = await access();
    const { revokeShareLink } = await shares();
    const { resetLimits } = await import("../app/lib/server/rate-limit");
    expect(await openLink("A".repeat(32))).toMatchObject({ code: "missing", status: 404 });
    const { link, token } = await newLink();
    await revokeShareLink(link.id, "alice");
    expect(await openLink(token)).toMatchObject({ code: "revoked", status: 410 });

    resetLimits();
    const headers = headersFrom("203.0.113.50");
    let refused = null;
    for (let i = 0; i < 100 && !refused; i++) refused = overLimit("download", token, headers);
    expect(refused).toMatchObject({ code: "busy", status: 429 });
    expect(refused!.retryAfter).toBeGreaterThan(0);
    resetLimits();
  });
});

describe("delivering a shared file", () => {
  const bytes = Buffer.from("the shared bytes, exactly as stored\n".repeat(500));

  async function shareOn(driver: StorageDriver, key: string, maxDownloads: number | null = 2) {
    await driver.upload(key, new Response(bytes).body!, bytes.length, "text/plain");
    const { link } = await (await shares()).createShareLink({
      connectionId: "conn",
      key,
      createdBy: "alice",
      expiresAt: null,
      maxDownloads,
      meta: { name: key.split("/").pop()!, size: bytes.length },
    });
    return link;
  }

  /** Streams where the provider can't sign; either way the recipient gets the same bytes. */
  async function fetchVia(driver: StorageDriver, link: Awaited<ReturnType<typeof shareOn>>) {
    const { startDownload, attachmentResponse } = await serve();
    const delivery = await startDownload(link, driver);
    if (delivery.kind === "redirect") {
      const response = await fetch(delivery.url);
      expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
      return { kind: delivery.kind, body: Buffer.from(await response.arrayBuffer()) };
    }
    const response = attachmentResponse(delivery.object, link.meta.name);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
    return { kind: delivery.kind, body: Buffer.from(await response.arrayBuffer()) };
  }

  it("streams through this app from Dropbox and OneDrive, and from encrypted connections", async () => {
    const { dropboxDriver } = await import("../app/lib/server/drivers/dropbox");
    const { oneDriveDriver } = await import("../app/lib/server/drivers/onedrive");
    const { cryptDriver } = await import("../app/lib/server/drivers/crypt");
    const { deriveDataKey } = await import("../app/lib/server/crypt");
    const dropboxMock = await startDropboxMock();
    const oneDriveMock = await startOneDriveMock();
    try {
      const root = `/shares-${Date.now().toString(36)}`;
      const dropbox = dropboxDriver({ root: "/", appKey: MOCK_APP_KEY, refreshToken: MOCK_REFRESH_TOKEN, endpoint: dropboxMock.url });
      const oneDrive = oneDriveDriver({ root: "/", clientId: MOCK_CLIENT_ID, tenant: MOCK_TENANT, refreshToken: ONEDRIVE_REFRESH_TOKEN, endpoint: oneDriveMock.url });
      const encrypted = cryptDriver(dropbox, await deriveDataKey("a passphrase for the share test"));
      for (const [name, driver] of [
        ["dropbox", dropbox],
        ["onedrive", oneDrive],
        ["encrypted", encrypted],
      ] as const) {
        const link = await shareOn(driver, `${root.slice(1)}/${name}.txt`);
        const got = await fetchVia(driver, link);
        expect(got.kind, name).toBe("stream");
        expect(got.body.equals(bytes), name).toBe(true);
      }
    } finally {
      dropboxMock.close();
      oneDriveMock.close();
    }
  });

  it("counts nothing for a file that's gone, and refuses past the cap", async () => {
    const { dropboxDriver } = await import("../app/lib/server/drivers/dropbox");
    const { startDownload } = await serve();
    const { getShareLink } = await shares();
    const mock = await startDropboxMock();
    try {
      const driver = dropboxDriver({ root: "/", appKey: MOCK_APP_KEY, refreshToken: MOCK_REFRESH_TOKEN, endpoint: mock.url });
      const link = await shareOn(driver, "cap/once.txt", 1);
      await driver.remove(["cap/once.txt"]);
      await expect(startDownload(link, driver)).rejects.toMatchObject({ status: 404 });
      expect((await getShareLink(link.id))!.link.downloads).toBe(0);

      const again = await shareOn(driver, "cap/once-more.txt", 1);
      const first = await startDownload(again, driver);
      if (first.kind === "stream") await first.object.stream.cancel();
      await expect(startDownload(again, driver)).rejects.toMatchObject({ status: 410 });
    } finally {
      mock.close();
    }
  });

  // Emulators: skipped when not running (CI starts them; see ci.yml).
  const S3_ENDPOINT = process.env.JVINU_TEST_S3 || "http://localhost:4566";
  const OCI_ENDPOINT = process.env.JVINU_TEST_OCI || "http://localhost:4599";
  const up = async (url: string) => fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);

  it("hands off to a short signed link on S3", async (context) => {
    if (!(await up(S3_ENDPOINT))) return context.skip();
    const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
    const { s3Driver } = await import("../app/lib/server/drivers/s3");
    const bucket = `jvinu-shares-${Date.now().toString(36)}`;
    const admin = new S3Client({ endpoint: S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    const driver = s3Driver({ bucket, region: "us-east-1", endpoint: S3_ENDPOINT, accessKeyId: "test", secretAccessKey: "test" });
    const link = await shareOn(driver, "public/report.txt");
    const got = await fetchVia(driver, link);
    expect(got.kind).toBe("redirect");
    expect(got.body.equals(bytes)).toBe(true);
    await driver.remove(["public/report.txt"]);
    const { DeleteBucketCommand } = await import("@aws-sdk/client-s3");
    await admin.send(new DeleteBucketCommand({ Bucket: bucket }));
  });

  it("streams from My storage when it has no public address", async (context) => {
    const token = process.env.JVINU_TEST_GARAGE_TOKEN;
    const adminUrl = process.env.JVINU_TEST_GARAGE_ADMIN || "http://localhost:3903";
    const s3Url = process.env.JVINU_TEST_GARAGE_S3 || "http://localhost:3900";
    if (!token || !(await up(`${adminUrl}/health`))) return context.skip();
    const { ensureBucket, prepareGarage } = await import("../app/lib/server/bundled-storage");
    const { s3Driver } = await import("../app/lib/server/drivers/s3");
    const garage = { adminUrl, s3Url, token };
    const keys = await prepareGarage(garage);
    const bucket = `jvinu-shares-${Date.now().toString(36)}`;
    await ensureBucket(garage, bucket, keys.accessKeyId);
    // As driverFor builds it for "My storage" without JVINU_STORAGE_PUBLIC_URL.
    const driver = s3Driver({ bucket, region: "garage", endpoint: s3Url, ...keys, service: "My storage", linkEndpoint: null });
    const link = await shareOn(driver, "mine.txt");
    const got = await fetchVia(driver, link);
    expect(got.kind).toBe("stream");
    expect(got.body.equals(bytes)).toBe(true);
    await driver.remove(["mine.txt"]);
  });

  it("streams from Oracle Cloud", async (context) => {
    if (!(await up(OCI_ENDPOINT))) return context.skip();
    const { generateKeyPairSync } = await import("node:crypto");
    const common = await import("oci-common");
    const objectstorage = await import("oci-objectstorage");
    const { ociDriver } = await import("../app/lib/server/drivers/oci");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const oci = {
      namespace: "floci-local",
      region: "us-ashburn-1",
      tenancy: "ocid1.tenancy.oc1..jvinushares",
      user: "ocid1.user.oc1..jvinushares",
      fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    const provider = new common.SimpleAuthenticationDetailsProvider(oci.tenancy, oci.user, oci.fingerprint, oci.privateKey, null, common.Region.fromRegionId(oci.region));
    const client = new objectstorage.ObjectStorageClient({ authenticationDetailsProvider: provider });
    client.endpoint = OCI_ENDPOINT;
    const bucket = `jvinu-shares-${Date.now().toString(36)}`;
    await client.createBucket({ namespaceName: oci.namespace, createBucketDetails: { name: bucket, compartmentId: oci.tenancy } });
    try {
      const driver = ociDriver({ bucket, endpoint: OCI_ENDPOINT, ...oci });
      const link = await shareOn(driver, "oracle.txt");
      const got = await fetchVia(driver, link);
      expect(got.kind).toBe("stream");
      expect(got.body.equals(bytes)).toBe(true);
      await driver.remove(["oracle.txt"]);
      await client.deleteBucket({ namespaceName: oci.namespace, bucketName: bucket });
    } finally {
      client.close();
    }
  });
});
