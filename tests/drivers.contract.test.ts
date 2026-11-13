/**
 * One contract, every driver: the same behaviour checked against each cloud's emulator
 * (Floci by default). An emulator that isn't running is skipped locally; in CI set
 * JVINU_CONTRACT_REQUIRED=1 so a missing one fails instead.
 *
 *   docker compose --profile floci up -d && npm run test:contract
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { CreateBucketCommand, DeleteBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { Storage } from "@google-cloud/storage";
import * as common from "oci-common";
import * as objectstorage from "oci-objectstorage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBucket, garage, prepareGarage } from "../app/lib/server/bundled-storage";
import { deriveDataKey, encryptedSize } from "../app/lib/server/crypt";
import { azureDriver } from "../app/lib/server/drivers/azure";
import { checkEncryptedBucket, cryptDriver } from "../app/lib/server/drivers/crypt";
import { dropboxDriver, dropboxFolder, exchangeDropboxCode } from "../app/lib/server/drivers/dropbox";
import { gcsDriver } from "../app/lib/server/drivers/gcs";
import { ociDriver } from "../app/lib/server/drivers/oci";
import { oneDriveDriver } from "../app/lib/server/drivers/onedrive";
import { s3Driver } from "../app/lib/server/drivers/s3";
import { StorageUserError, type StorageDriver } from "../app/lib/server/drivers/types";
import { runOperation } from "../app/lib/server/operations";
import { MOCK_APP_KEY, MOCK_CODE, MOCK_REFRESH_TOKEN, startDropboxMock } from "./dropbox-mock";
import { MOCK_CLIENT_ID, MOCK_REFRESH_TOKEN as ONEDRIVE_MOCK_REFRESH_TOKEN, MOCK_TENANT, startOneDriveMock } from "./onedrive-mock";

const env = (name: string, fallback: string) => process.env[name] || fallback;
const S3_ENDPOINT = env("JVINU_TEST_S3", "http://localhost:4566");
const AZURE_ENDPOINT = env("JVINU_TEST_AZURE", "http://localhost.floci.io:4577/devstoreaccount1");
const GCS_ENDPOINT = env("JVINU_TEST_GCS", "http://localhost:4588");
const OCI_ENDPOINT = env("JVINU_TEST_OCI", "http://localhost:4599");
const REQUIRED = process.env.JVINU_CONTRACT_REQUIRED === "1";

// Bundled storage: a Garage with its admin API published (CI starts one; see ci.yml).
const GARAGE = {
  adminUrl: env("JVINU_TEST_GARAGE_ADMIN", "http://localhost:3903"),
  s3Url: env("JVINU_TEST_GARAGE_S3", "http://localhost:3900"),
  token: env("JVINU_TEST_GARAGE_TOKEN", ""),
};
let garageKeys: { accessKeyId: string; secretAccessKey: string } | null = null;
const garageAdmin = async () => (garageKeys ??= await prepareGarage(GARAGE));

// Dropbox has no emulator: a real account when these are set, the in-process mock otherwise.
const DROPBOX_LIVE = Boolean(process.env.JVINU_TEST_DROPBOX_APP_KEY && process.env.JVINU_TEST_DROPBOX_REFRESH_TOKEN);
const dropboxMock = DROPBOX_LIVE ? null : await startDropboxMock();
const DROPBOX = {
  endpoint: dropboxMock?.url,
  appKey: process.env.JVINU_TEST_DROPBOX_APP_KEY || MOCK_APP_KEY,
  refreshToken: process.env.JVINU_TEST_DROPBOX_REFRESH_TOKEN || MOCK_REFRESH_TOKEN,
};
const dropbox = (root: string) => dropboxDriver({ root, ...DROPBOX });

// OneDrive likewise: a real account when these are set, the in-process Graph mock otherwise.
const ONEDRIVE_LIVE = Boolean(process.env.JVINU_TEST_ONEDRIVE_CLIENT_ID && process.env.JVINU_TEST_ONEDRIVE_REFRESH_TOKEN);
const oneDriveMock = ONEDRIVE_LIVE ? null : await startOneDriveMock();
const ONEDRIVE = {
  endpoint: oneDriveMock?.url,
  clientId: process.env.JVINU_TEST_ONEDRIVE_CLIENT_ID || MOCK_CLIENT_ID,
  tenant: process.env.JVINU_TEST_ONEDRIVE_TENANT || MOCK_TENANT,
  refreshToken: process.env.JVINU_TEST_ONEDRIVE_REFRESH_TOKEN || ONEDRIVE_MOCK_REFRESH_TOKEN,
};
const oneDrive = (root: string) => oneDriveDriver({ root, ...ONEDRIVE });

const AZURITE_ACCOUNT = "devstoreaccount1";
const AZURITE_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMh0==";

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/** A cloud under test: how to make a scratch bucket, and a driver for a given bucket. */
type Harness = {
  name: string;
  endpoint: string;
  createBucket(bucket: string): Promise<void>;
  deleteBucket(bucket: string): Promise<void>;
  driver(bucket: string): StorageDriver;
  /** S3-family only: the same driver with multipart copy kicking in at 5 MB, to test it. */
  multipartDriver?(bucket: string): StorageDriver;
  /** Where the service honours SSE-S3: the same driver asking for encryption at rest. */
  encryptingDriver?(bucket: string): StorageDriver;
  /** For jvinu encryption: the cloud's own driver underneath, to see what's really stored. */
  raw?(bucket: string): StorageDriver;
};

const oci = (() => {
  // Requests are signed client-side, so even an emulator needs a well-formed RSA key.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    namespace: "floci-local",
    region: "us-ashburn-1",
    tenancy: "ocid1.tenancy.oc1..jvinucontract",
    user: "ocid1.user.oc1..jvinucontract",
    fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
})();

function ociAdmin() {
  const provider = new common.SimpleAuthenticationDetailsProvider(
    oci.tenancy,
    oci.user,
    oci.fingerprint,
    oci.privateKey,
    null,
    common.Region.fromRegionId(oci.region),
  );
  const client = new objectstorage.ObjectStorageClient({ authenticationDetailsProvider: provider });
  client.endpoint = OCI_ENDPOINT;
  return client;
}

const s3Admin = () =>
  new S3Client({
    endpoint: S3_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
const azureAdmin = () => new BlobServiceClient(AZURE_ENDPOINT, new StorageSharedKeyCredential(AZURITE_ACCOUNT, AZURITE_KEY));
const gcsAdmin = () => new Storage({ apiEndpoint: GCS_ENDPOINT, projectId: "jvinu-contract" });

const HARNESSES: Harness[] = [
  {
    name: "s3",
    endpoint: S3_ENDPOINT,
    createBucket: async (bucket) => void (await s3Admin().send(new CreateBucketCommand({ Bucket: bucket }))),
    deleteBucket: async (bucket) => void (await s3Admin().send(new DeleteBucketCommand({ Bucket: bucket }))),
    driver: (bucket) =>
      s3Driver({ bucket, region: "us-east-1", endpoint: S3_ENDPOINT, accessKeyId: "test", secretAccessKey: "test" }),
    multipartDriver: (bucket) =>
      s3Driver({
        bucket,
        region: "us-east-1",
        endpoint: S3_ENDPOINT,
        accessKeyId: "test",
        secretAccessKey: "test",
        multipartCopyAbove: 5 * 1024 * 1024,
        copyPartSize: 5 * 1024 * 1024,
      }),
    encryptingDriver: (bucket) =>
      s3Driver({
        bucket,
        region: "us-east-1",
        endpoint: S3_ENDPOINT,
        accessKeyId: "test",
        secretAccessKey: "test",
        serverSideEncryption: true,
        atRest: "optional",
        // Small parts, so the multipart path is covered too.
        multipartCopyAbove: 5 * 1024 * 1024,
        copyPartSize: 5 * 1024 * 1024,
      }),
  },
  {
    name: "azure",
    endpoint: AZURE_ENDPOINT,
    createBucket: async (bucket) => void (await azureAdmin().getContainerClient(bucket).create()),
    deleteBucket: async (bucket) => void (await azureAdmin().getContainerClient(bucket).deleteIfExists()),
    driver: (bucket) => azureDriver({ container: bucket, accountName: AZURITE_ACCOUNT, accountKey: AZURITE_KEY, endpoint: AZURE_ENDPOINT }),
  },
  {
    name: "gcs",
    endpoint: GCS_ENDPOINT,
    createBucket: async (bucket) => void (await gcsAdmin().createBucket(bucket)),
    deleteBucket: async (bucket) => void (await gcsAdmin().bucket(bucket).delete({ ignoreNotFound: true })),
    driver: (bucket) => gcsDriver({ bucket, endpoint: GCS_ENDPOINT, projectId: "jvinu-contract" }),
  },
  {
    name: "oci",
    endpoint: OCI_ENDPOINT,
    createBucket: async (bucket) => {
      const client = ociAdmin();
      try {
        await client.createBucket({ namespaceName: oci.namespace, createBucketDetails: { name: bucket, compartmentId: oci.tenancy } });
      } finally {
        client.close();
      }
    },
    deleteBucket: async (bucket) => {
      const client = ociAdmin();
      try {
        await client.deleteBucket({ namespaceName: oci.namespace, bucketName: bucket });
      } finally {
        client.close();
      }
    },
    driver: (bucket) => ociDriver({ bucket, endpoint: OCI_ENDPOINT, ...oci }),
  },
  {
    // Bundled storage, through the S3 driver exactly as "My storage" uses it.
    name: "garage",
    endpoint: GARAGE.token ? `${GARAGE.adminUrl}/health` : "http://garage-token-not-set.invalid",
    createBucket: async (bucket) => {
      const keys = await garageAdmin();
      await ensureBucket(GARAGE, bucket, keys.accessKeyId);
    },
    deleteBucket: async (bucket) => {
      const info = await garage<{ id: string }>(GARAGE, `GetBucketInfo?globalAlias=${encodeURIComponent(bucket)}`);
      await garage(GARAGE, `DeleteBucket?id=${encodeURIComponent(info.id)}`, {});
    },
    driver: (bucket) =>
      s3Driver({
        bucket,
        region: "garage",
        endpoint: GARAGE.s3Url,
        accessKeyId: garageKeys?.accessKeyId ?? "",
        secretAccessKey: garageKeys?.secretAccessKey ?? "",
        service: "My storage",
      }),
    multipartDriver: (bucket) =>
      s3Driver({
        bucket,
        region: "garage",
        endpoint: GARAGE.s3Url,
        accessKeyId: garageKeys?.accessKeyId ?? "",
        secretAccessKey: garageKeys?.secretAccessKey ?? "",
        multipartCopyAbove: 5 * 1024 * 1024,
        copyPartSize: 5 * 1024 * 1024,
      }),
  },
  {
    // The "bucket" is a folder at the top of the Dropbox.
    name: "dropbox",
    endpoint: DROPBOX.endpoint ?? "https://api.dropboxapi.com",
    createBucket: (bucket) => dropbox("/").write(`${bucket}/`, new Uint8Array(0)),
    deleteBucket: async (bucket) => void (await dropbox("/").remove([`${bucket}/`])),
    driver: (bucket) => dropbox(`/${bucket}`),
  },
  {
    // Likewise: a folder at the top of the OneDrive.
    name: "onedrive",
    endpoint: ONEDRIVE.endpoint ?? "https://graph.microsoft.com",
    createBucket: (bucket) => oneDrive("/").write(`${bucket}/`, new Uint8Array(0)),
    deleteBucket: async (bucket) => void (await oneDrive("/").remove([`${bucket}/`])),
    driver: (bucket) => oneDrive(`/${bucket}`),
  },
];

// jvinu encryption runs over any driver: the whole contract again, through it, on S3 and
// on a driver that's nothing like S3.
const CRYPT_PASSPHRASE = "contract passphrase, not a secret";
const CRYPT_KEY = await deriveDataKey(CRYPT_PASSPHRASE);
function encrypted(name: string): Harness {
  const base = HARNESSES.find((harness) => harness.name === name)!;
  return {
    name: `${name}-crypt`,
    endpoint: base.endpoint,
    createBucket: base.createBucket,
    deleteBucket: base.deleteBucket,
    driver: (bucket) => cryptDriver(base.driver(bucket), CRYPT_KEY),
    raw: base.driver,
  };
}
HARNESSES.push(encrypted("s3"), encrypted("dropbox"));

const text = (value: string) => new TextEncoder().encode(value);
const pattern = (length: number) => new Uint8Array(length).map((_, i) => (i * 31) % 251);

function streamOf(bytes: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
}

async function readAll(driver: StorageDriver, key: string): Promise<Buffer> {
  const { stream } = await driver.read(key);
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/** Every file and folder at one level, following page tokens. */
async function listAll(driver: StorageDriver, prefix: string) {
  const files: string[] = [];
  const folders: string[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const page = await driver.list(prefix, token);
    files.push(...page.files.map((file) => file.key));
    folders.push(...page.folders);
    token = page.nextToken;
    pages += 1;
  } while (token && pages < 50);
  return { files, folders, pages };
}

const status = await Promise.all(HARNESSES.map((harness) => reachable(harness.endpoint)));

describe.each(HARNESSES.map((harness, index) => ({ harness, up: status[index] })))("$harness.name driver", ({ harness, up }) => {
  const bucket = `jvinu-contract-${harness.name}-${Date.now().toString(36)}`;
  let driver: StorageDriver;

  it.runIf(!up && REQUIRED)("has its emulator running", () => {
    expect.fail(`${harness.endpoint} isn't reachable`);
  });

  describe.skipIf(!up)("contract", () => {
    beforeAll(async () => {
      await harness.createBucket(bucket);
      driver = harness.driver(bucket);
    });

    afterAll(async () => {
      if (!driver) return;
      const { keys } = await driver.listKeys("", 10_000);
      await driver.remove(keys);
      await harness.deleteBucket(bucket).catch(() => {});
    });

    it("verifies a bucket it can list", async () => {
      await expect(driver.verify()).resolves.toBeTypeOf("object");
    });

    it("explains a bucket that doesn't exist", async () => {
      const missing = harness.driver(`${bucket}-missing`);
      const error = await missing.verify().then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(StorageUserError);
      expect((error as StorageUserError).status).toBe(404);
    });

    it("streams an upload and reads back the same bytes", async () => {
      const bytes = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => (i * 31) % 251);
      await driver.upload("blob/data.bin", streamOf(bytes), bytes.length, "application/octet-stream");
      const back = await readAll(driver, "blob/data.bin");
      expect(back.length).toBe(bytes.length);
      expect(back.equals(Buffer.from(bytes))).toBe(true);
    });

    it("reads byte ranges, for seeking and resumed downloads", async () => {
      await driver.write("range/digits.txt", text("0123456789"), "text/plain");
      const middle = await driver.read("range/digits.txt", { start: 2, end: 5 });
      expect(await new Response(middle.stream).text()).toBe("2345");
      expect(middle.range).toEqual({ start: 2, end: 5 });
      expect(middle.total).toBe(10);
      const tail = await driver.read("range/digits.txt", { start: 7 });
      expect(await new Response(tail.stream).text()).toBe("789");
      expect(tail.range).toEqual({ start: 7, end: 9 });
      const outside = await driver.read("range/digits.txt", { start: 50 }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(outside).toBeInstanceOf(StorageUserError);
      expect((outside as StorageUserError).status).toBe(416);
    });

    it("lists one level: folders apart, markers hidden", async () => {
      await driver.write("tree/", new Uint8Array(0));
      await driver.write("tree/top.txt", text("top"), "text/plain");
      await driver.write("tree/sub/deep.txt", text("deep"), "text/plain");
      const { files, folders } = await listAll(driver, "tree/");
      expect(files).toEqual(["tree/top.txt"]);
      expect(folders).toEqual(["tree/sub/"]);
    });

    it("pages past 1,000 entries without losing or repeating any", async () => {
      const keys = Array.from({ length: 1_010 }, (_, i) => `many/${String(i).padStart(4, "0")}.txt`);
      const batch = 25;
      for (let i = 0; i < keys.length; i += batch) {
        await Promise.all(keys.slice(i, i + batch).map((key) => driver.write(key, text(key))));
      }
      const { files, pages } = await listAll(driver, "many/");
      expect(pages).toBeGreaterThan(1);
      expect(new Set(files).size).toBe(files.length);
      expect([...files].sort()).toEqual(keys);
    });

    it("lists keys flat, up to a cap", async () => {
      const all = await driver.listKeys("many/", 10_000);
      expect(all.keys).toHaveLength(1_010);
      expect(all.truncated).toBe(false);
      const capped = await driver.listKeys("many/", 100);
      expect(capped.keys).toHaveLength(100);
      expect(capped.truncated).toBe(true);
    });

    it("totals a folder", async () => {
      const stats = await driver.stats("tree/");
      expect(stats.objects).toBe(2);
      expect(stats.bytes).toBe(7);
      expect(stats.truncated).toBe(false);
      expect(stats.lastModified).not.toBeNull();
    });

    it("inventories files flat, with sizes and dates", async () => {
      const { files, truncated } = await driver.inventory("tree/");
      expect(truncated).toBe(false);
      expect(files.map((file) => file.key).sort()).toEqual(["tree/sub/deep.txt", "tree/top.txt"]);
      expect(files.reduce((sum, file) => sum + file.size, 0)).toBe(7);
      expect(files.every((file) => file.lastModified)).toBe(true);
      const capped = await driver.inventory("many/", 1);
      expect(capped.truncated).toBe(true);
      expect(capped.files.length).toBeGreaterThan(0);
    });

    it("copies, leaving the source", async () => {
      await driver.copy("tree/top.txt", "copied/top.txt");
      expect((await readAll(driver, "copied/top.txt")).toString()).toBe("top");
      expect((await readAll(driver, "tree/top.txt")).toString()).toBe("top");
    });

    it.runIf(Boolean(harness.multipartDriver))("copies big objects part by part, keeping their type", async () => {
      const big = harness.multipartDriver!(bucket);
      const bytes = new Uint8Array(12 * 1024 * 1024 + 123).map((_, i) => (i * 13) % 251);
      await big.upload("big/source.bin", streamOf(bytes, 1024 * 1024), bytes.length, "video/mp4");
      await big.copy("big/source.bin", "big/copy.bin");
      const back = await big.read("big/copy.bin");
      expect(back.contentType).toBe("video/mp4");
      const copied = Buffer.from(await new Response(back.stream).arrayBuffer());
      expect(copied.length).toBe(bytes.length);
      expect(copied.equals(Buffer.from(bytes))).toBe(true);
    });

    // Other tools upload big files in parts, with the SDK's default checksums; reading them
    // back whole must work (Garage's composite CRC32 once failed every such read).
    it.runIf(harness.name === "s3" || harness.name === "garage")("reads back whole a file another tool uploaded in parts", async () => {
      const { Upload } = await import("@aws-sdk/lib-storage");
      const credentials =
        harness.name === "garage"
          ? { accessKeyId: garageKeys!.accessKeyId, secretAccessKey: garageKeys!.secretAccessKey }
          : { accessKeyId: "test", secretAccessKey: "test" };
      const client = new S3Client({
        endpoint: harness.name === "garage" ? GARAGE.s3Url : S3_ENDPOINT,
        region: harness.name === "garage" ? "garage" : "us-east-1",
        forcePathStyle: true,
        credentials,
      });
      const bytes = new Uint8Array(12 * 1024 * 1024 + 7).map((_, i) => (i * 17) % 251);
      await new Upload({ client, params: { Bucket: bucket, Key: "parts/by-another-tool.bin", Body: bytes }, partSize: 5 * 1024 * 1024 }).done();
      const back = await readAll(driver, "parts/by-another-tool.bin");
      expect(back.equals(Buffer.from(bytes))).toBe(true);
      await driver.remove(["parts/by-another-tool.bin"]);
    });

    it.runIf(Boolean(harness.encryptingDriver))("encrypts at rest when asked, on every kind of write", async () => {
      const sealed = harness.encryptingDriver!(bucket);
      const bytes = new Uint8Array(7 * 1024 * 1024).map((_, i) => (i * 7) % 251);
      await sealed.upload("sse/streamed.bin", streamOf(bytes, 1024 * 1024), bytes.length, "application/octet-stream");
      await sealed.write("sse/small.txt", text("secret"), "text/plain");
      await sealed.copy("sse/small.txt", "sse/small-copy.txt");
      await sealed.copy("sse/streamed.bin", "sse/streamed-copy.bin"); // multipart copy
      for (const key of ["sse/streamed.bin", "sse/small.txt", "sse/small-copy.txt", "sse/streamed-copy.bin"]) {
        const head = await sealed.head!(key);
        expect(head.encryption, key).toMatchObject({ state: "encrypted", keys: "provider", detail: "AES-256 (SSE-S3)" });
      }
      expect((await readAll(sealed, "sse/small-copy.txt")).toString()).toBe("secret");
      expect((await readAll(sealed, "sse/streamed-copy.bin")).equals(Buffer.from(bytes))).toBe(true);
      await sealed.remove(["sse/streamed.bin", "sse/small.txt", "sse/small-copy.txt", "sse/streamed-copy.bin"]);
    });

    it("reports an object's metadata, where the driver can", async () => {
      if (!driver.head) return;
      const head = await driver.head("tree/top.txt");
      expect(head.size).toBe(3);
      expect(["encrypted", "unencrypted", "unknown"]).toContain(head.encryption.state);
    });

    it("changes headers in place, keeping the bytes, where the driver can", async () => {
      if (!driver.setMetadata || !driver.metadataSupport?.contentType || !driver.head) return;
      await driver.write("meta/page.html", new TextEncoder().encode("<p>hi</p>"), "application/octet-stream");
      await driver.setMetadata("meta/page.html", { contentType: "text/html; charset=utf-8", cacheControl: "public, max-age=60" });
      const head = await driver.head("meta/page.html");
      expect(head.contentType).toMatch(/^text\/html/);
      if (driver.metadataSupport.cacheControl) expect(head.cacheControl).toBe("public, max-age=60");
      expect((await readAll(driver, "meta/page.html")).toString()).toBe("<p>hi</p>");
      // Changing one header leaves the others.
      await driver.setMetadata("meta/page.html", { cacheControl: "" });
      const after = await driver.head("meta/page.html");
      expect(after.contentType).toMatch(/^text\/html/);
      expect(after.cacheControl ?? null).toBeNull();
      if (driver.metadataSupport.tags) await driver.setMetadata("meta/page.html", { tags: { team: "data", env: "test" } });
      expect((await readAll(driver, "meta/page.html")).toString()).toBe("<p>hi</p>");
      await driver.remove(["meta/page.html"]);
    });

    it("renames, natively or by copy and delete", async () => {
      if (driver.rename) await driver.rename("copied/top.txt", "renamed/top.txt");
      else {
        await driver.copy("copied/top.txt", "renamed/top.txt");
        await driver.remove(["copied/top.txt"]);
      }
      expect((await readAll(driver, "renamed/top.txt")).toString()).toBe("top");
      expect((await listAll(driver, "copied/")).files).toEqual([]);
    });

    it("signs a working link, or says it can't", async () => {
      const url = await driver.signedUrl("tree/top.txt", true, 900);
      if (url === null) return;
      const response = await fetch(url);
      expect(response.ok).toBe(true);
      expect(await response.text()).toBe("top");
    });

    it("deletes in bulk, and a missing key isn't a failure", async () => {
      const { keys } = await driver.listKeys("many/", 10_000);
      const { failed } = await driver.remove([...keys, "many/never-existed.txt"]);
      expect(failed).toEqual([]);
      expect((await listAll(driver, "many/")).files).toEqual([]);
    });

    it("explains reading a missing object", async () => {
      const error = await driver.read("nope/missing.txt").then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(StorageUserError);
      expect((error as StorageUserError).status).toBe(404);
    });

    it.runIf(Boolean(harness.raw))("stores only ciphertext, in rclone's format", async () => {
      const raw = harness.raw!(bucket);
      const secret = `attack at dawn ${"·".repeat(200)}`;
      await driver.write("vault/plain.txt", text(secret), "text/plain");
      const stored = await readAll(raw, "vault/plain.txt.bin");
      expect(stored.subarray(0, 8).toString("latin1")).toBe("RCLONE\0\0");
      expect(stored.length).toBe(encryptedSize(Buffer.byteLength(secret)));
      expect(stored.includes(Buffer.from("attack at dawn"))).toBe(false);
      expect((await raw.listKeys("vault/", 10)).keys).toEqual(["vault/plain.txt.bin"]);
      // Another passphrase opens nothing.
      const stranger = cryptDriver(raw, await deriveDataKey("someone else's passphrase"));
      await expect(readAll(stranger, "vault/plain.txt")).rejects.toMatchObject({ status: 422 });
      // Files it didn't write stay out of its view, as with rclone.
      await raw.write("vault/stray.txt", text("left as it is"), "text/plain");
      expect((await listAll(driver, "vault/")).files).toEqual(["vault/plain.txt"]);
      await raw.remove(["vault/stray.txt", "vault/plain.txt.bin"]);
    });

    it.runIf(Boolean(harness.raw))("seeks anywhere in a large file, as a video player does", async () => {
      const bytes = pattern(1_000_000);
      await driver.upload("vault/movie.mp4", streamOf(bytes, 100_000), bytes.length, "video/mp4");
      const ranges: [number, number | undefined][] = [
        [0, 0],
        [0, 1023],
        [65_530, 65_545], // across a block boundary
        [131_072, 196_607], // exactly one block
        [500_000, 600_000],
        [999_990, undefined],
        [0, undefined],
      ];
      for (const [start, end] of ranges) {
        const part = await driver.read("vault/movie.mp4", { start, end });
        const last = end ?? bytes.length - 1;
        expect(part.range, `${start}-${end}`).toEqual({ start, end: last });
        expect(part.total).toBe(bytes.length);
        expect(part.size).toBe(last - start + 1);
        const got = Buffer.from(await new Response(part.stream).arrayBuffer());
        expect(got.equals(Buffer.from(bytes.subarray(start, last + 1))), `${start}-${end}`).toBe(true);
      }
      const head = await driver.head!("vault/movie.mp4");
      expect(head).toMatchObject({ size: bytes.length, contentType: "video/mp4", encryption: { state: "encrypted", keys: "jvinu" } });
      await driver.remove(["vault/movie.mp4"]);
    });

    it.runIf(Boolean(harness.raw))("checks a passphrase against what's already there before connecting", async () => {
      const raw = harness.raw!(bucket);
      await driver.write("check/note.txt", text("opened with the right passphrase"));
      await expect(checkEncryptedBucket(raw, CRYPT_KEY, "bucket")).resolves.toMatchObject({ encryptedFiles: expect.any(Number) });
      const wrong = await deriveDataKey("not the passphrase");
      await expect(checkEncryptedBucket(raw, wrong, "bucket")).rejects.toMatchObject({ status: 422 });
      await raw.write("check/plain.txt", text("never encrypted"));
      await expect(checkEncryptedBucket(raw, CRYPT_KEY, "bucket")).rejects.toMatchObject({ status: 409 });
      await raw.remove(["check/plain.txt", "check/note.txt.bin"]);
    });

    // rclone itself, against the same bucket: what jvinu wrote, rclone reads; and back.
    it.runIf(harness.name === "s3-crypt" && process.env.JVINU_TEST_RCLONE === "1")(
      "interoperates with rclone on the same bucket",
      async () => {
        const image = "rclone/rclone:1.75";
        const obscured = execFileSync("docker", ["run", "--rm", image, "obscure", CRYPT_PASSPHRASE]).toString().trim();
        const rclone = (args: string[], input?: Uint8Array) =>
          execFileSync(
            "docker",
            [
              "run", "--rm", "-i", "--add-host=host.docker.internal:host-gateway",
              "-e", "RCLONE_CONFIG_STORE_TYPE=s3",
              "-e", "RCLONE_CONFIG_STORE_PROVIDER=Other",
              "-e", `RCLONE_CONFIG_STORE_ENDPOINT=${S3_ENDPOINT.replace(/\/\/(localhost|127\.0\.0\.1)\b/, "//host.docker.internal")}`,
              "-e", "RCLONE_CONFIG_STORE_ACCESS_KEY_ID=test",
              "-e", "RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY=test",
              "-e", "RCLONE_CONFIG_STORE_REGION=us-east-1",
              "-e", "RCLONE_CONFIG_STORE_FORCE_PATH_STYLE=true",
              "-e", "RCLONE_CONFIG_STORE_NO_CHECK_BUCKET=true",
              "-e", "RCLONE_CONFIG_SECRET_TYPE=crypt",
              "-e", `RCLONE_CONFIG_SECRET_REMOTE=store:${bucket}`,
              "-e", `RCLONE_CONFIG_SECRET_PASSWORD=${obscured}`,
              "-e", "RCLONE_CONFIG_SECRET_FILENAME_ENCRYPTION=off",
              "-e", "RCLONE_CONFIG_SECRET_DIRECTORY_NAME_ENCRYPTION=false",
              image, ...args,
            ],
            { input, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] },
          );

        const ours = pattern(300_000);
        await driver.upload("interop/from-jvinu.bin", streamOf(ours), ours.length);
        expect(rclone(["cat", "secret:interop/from-jvinu.bin"]).equals(Buffer.from(ours))).toBe(true);

        const theirs = pattern(150_001).reverse();
        rclone(["rcat", "secret:interop/from-rclone.bin"], theirs);
        expect((await readAll(driver, "interop/from-rclone.bin")).equals(Buffer.from(theirs))).toBe(true);
        const part = await driver.read("interop/from-rclone.bin", { start: 70_000, end: 140_000 });
        expect(Buffer.from(await new Response(part.stream).arrayBuffer()).equals(Buffer.from(theirs.subarray(70_000, 140_001)))).toBe(true);
        expect(rclone(["lsf", "-R", "secret:interop"]).toString().trim().split("\n").sort()).toEqual(["from-jvinu.bin", "from-rclone.bin"]);
        await driver.remove(["interop/from-jvinu.bin", "interop/from-rclone.bin"]);
      },
      180_000,
    );
  });
});

describe("dropbox specifics", () => {
  const root = `/jvinu-dropbox-${Date.now().toString(36)}`;
  const driver = dropbox(root);

  beforeAll(() => dropbox("/").write(`${root.slice(1)}/`, new Uint8Array(0)));
  afterAll(() => dropbox("/").remove([`${root.slice(1)}/`]));

  it("normalises folder paths", () => {
    expect(dropboxFolder("")).toBe("/");
    expect(dropboxFolder("/")).toBe("/");
    expect(dropboxFolder("Photos/2024/")).toBe("/Photos/2024");
    expect(dropboxFolder("/a//b")).toBe("/a/b");
    expect(dropboxFolder("/a/../b")).toBeNull();
  });

  it("moves a folder as one tree, leaving nothing behind", async () => {
    await driver.write("album/one.jpg", new TextEncoder().encode("1"));
    await driver.write("album/nested/two.jpg", new TextEncoder().encode("22"));
    await driver.write("album/empty/", new Uint8Array(0));
    const result = await runOperation(driver, { op: "rename", items: [{ key: "album/", kind: "folder" }], name: "trip" });
    expect(result).toEqual({ done: 1, failed: [] });
    expect((await listAll(driver, "")).folders).toEqual(["trip/"]);
    expect([...(await driver.listKeys("trip/", 100)).keys].sort()).toEqual(["trip/empty/", "trip/nested/two.jpg", "trip/one.jpg"]);
  });

  it("copies a folder, and won't copy over one that exists", async () => {
    await expect(runOperation(driver, { op: "copy", items: [{ key: "trip/", kind: "folder" }], destination: "backup/" })).resolves.toEqual({
      done: 1,
      failed: [],
    });
    expect((await readAll(driver, "backup/trip/nested/two.jpg")).toString()).toBe("22");
    await expect(
      runOperation(driver, { op: "copy", items: [{ key: "trip/", kind: "folder" }], destination: "backup/" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("deletes a whole folder in one call", async () => {
    await expect(runOperation(driver, { op: "delete", items: [{ key: "backup/", kind: "folder" }] })).resolves.toEqual({
      done: 1,
      failed: [],
    });
    expect((await listAll(driver, "")).folders).toEqual(["trip/"]);
  });

  it("uploads in a session when the file spans several chunks", async () => {
    const bytes = new Uint8Array(17 * 1024 * 1024 + 5).map((_, i) => (i * 7) % 253);
    await driver.upload("big/video.mp4", streamOf(bytes, 1024 * 1024), bytes.length, "video/mp4");
    const { stream, size, contentType } = await driver.read("big/video.mp4");
    const back = Buffer.from(await new Response(stream).arrayBuffer());
    expect(size).toBe(bytes.length);
    expect(contentType).toBe("video/mp4");
    expect(back.equals(Buffer.from(bytes))).toBe(true);
  });

  it.skipIf(DROPBOX_LIVE)("trades a code once, and a retry reuses the token", async () => {
    const verifier = "v".repeat(64);
    await expect(exchangeDropboxCode(MOCK_APP_KEY, MOCK_CODE, verifier, DROPBOX.endpoint)).resolves.toBe(MOCK_REFRESH_TOKEN);
    await expect(exchangeDropboxCode(MOCK_APP_KEY, MOCK_CODE, verifier, DROPBOX.endpoint)).resolves.toBe(MOCK_REFRESH_TOKEN);
    await expect(exchangeDropboxCode(MOCK_APP_KEY, "wrong-code-123", verifier, DROPBOX.endpoint)).rejects.toMatchObject({ status: 400 });
    await expect(exchangeDropboxCode("notmyappkey0000", MOCK_CODE, verifier, DROPBOX.endpoint)).rejects.toThrow(/app key/);
  });

  it.skipIf(DROPBOX_LIVE)("explains a revoked refresh token", async () => {
    const revoked = dropboxDriver({ root, ...DROPBOX, refreshToken: "revoked" });
    await expect(revoked.verify()).rejects.toMatchObject({ status: 401 });
  });

  it.skipIf(DROPBOX_LIVE)("rides out throttling", () => {
    expect(dropboxMock!.stats.throttled).toBeGreaterThan(0);
  });
});
