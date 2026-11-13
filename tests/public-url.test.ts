/**
 * Public URLs (a CDN or custom domain in front of a bucket): base + key, encoded so the
 * provider finds the object. Checked against the emulators with keys that trip up naive
 * encoding — spaces, "+", "%", "#", "?", accents, CJK and emoji — fetched anonymously.
 */
import { CreateBucketCommand, PutBucketPolicyCommand, S3Client } from "@aws-sdk/client-s3";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { Storage } from "@google-cloud/storage";
import { describe, expect, it } from "vitest";
import { publicUrlFor } from "../app/lib/public-url";
import { azureDriver } from "../app/lib/server/drivers/azure";
import { gcsDriver } from "../app/lib/server/drivers/gcs";
import { s3Driver } from "../app/lib/server/drivers/s3";
import type { StorageDriver } from "../app/lib/server/drivers/types";

const KEYS = [
  "plain.txt",
  "my folder/naïve café — notes (1).txt",
  "a+b = c.txt",
  "100% sure.txt",
  "hash#tag and question?.txt",
  "日本語/ファイル.txt",
  "emoji 😀/smile.txt",
  "it's [really] {odd}! * ~.txt",
];

describe("public URLs", () => {
  it("encode each segment, keeping the slashes", () => {
    expect(publicUrlFor("https://cdn.example.com/files/", "my folder/naïve café — notes (1).txt")).toBe(
      "https://cdn.example.com/files/my%20folder/na%C3%AFve%20caf%C3%A9%20%E2%80%94%20notes%20%281%29.txt",
    );
    // A bare "+" would read as a space on S3; "%" and "#" must not start an escape or a fragment.
    expect(publicUrlFor("https://cdn.example.com", "a+b = c.txt")).toBe("https://cdn.example.com/a%2Bb%20%3D%20c.txt");
    expect(publicUrlFor("https://cdn.example.com", "100% sure.txt")).toBe("https://cdn.example.com/100%25%20sure.txt");
    expect(publicUrlFor("https://cdn.example.com", "hash#tag and question?.txt")).toBe(
      "https://cdn.example.com/hash%23tag%20and%20question%3F.txt",
    );
    expect(publicUrlFor("https://cdn.example.com", "it's [really] {odd}! * ~.txt")).toBe(
      "https://cdn.example.com/it%27s%20%5Breally%5D%20%7Bodd%7D%21%20%2A%20~.txt",
    );
  });

  const env = (name: string, fallback: string) => process.env[name] || fallback;
  const S3_ENDPOINT = env("JVINU_TEST_S3", "http://localhost:4566");
  const AZURE_ENDPOINT = env("JVINU_TEST_AZURE", "http://localhost.floci.io:4577/devstoreaccount1");
  const GCS_ENDPOINT = env("JVINU_TEST_GCS", "http://localhost:4588");
  const AZURITE_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMh0==";
  const up = (url: string) => fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  const name = `jvinu-public-${Date.now().toString(36)}`;

  /** Uploads every key through the driver, then reads each back anonymously from base + key. */
  async function roundTrip(driver: StorageDriver, base: string) {
    for (const key of KEYS) await driver.write(key, new TextEncoder().encode(key), "text/plain");
    for (const key of KEYS) {
      const response = await fetch(publicUrlFor(base, key));
      expect(response.status, key).toBe(200);
      expect(await response.text(), key).toBe(key);
    }
    await driver.remove(KEYS);
  }

  it("finds the object on S3", async (context) => {
    if (!(await up(S3_ENDPOINT))) return context.skip();
    const admin = new S3Client({ endpoint: S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    await admin.send(new CreateBucketCommand({ Bucket: name }));
    // Public read, as the bucket behind a CDN would have.
    await admin.send(
      new PutBucketPolicyCommand({
        Bucket: name,
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::${name}/*` }],
        }),
      }),
    );
    await roundTrip(s3Driver({ bucket: name, region: "us-east-1", endpoint: S3_ENDPOINT, accessKeyId: "test", secretAccessKey: "test" }), `${S3_ENDPOINT}/${name}`);
  });

  it("finds the object on Azure", async (context) => {
    if (!(await up(AZURE_ENDPOINT))) return context.skip();
    const service = new BlobServiceClient(AZURE_ENDPOINT, new StorageSharedKeyCredential("devstoreaccount1", AZURITE_KEY));
    const container = service.getContainerClient(name);
    await container.create({ access: "blob" });
    try {
      await roundTrip(azureDriver({ container: name, accountName: "devstoreaccount1", accountKey: AZURITE_KEY, endpoint: AZURE_ENDPOINT }), `${AZURE_ENDPOINT}/${name}`);
    } finally {
      await container.deleteIfExists();
    }
  });

  it("finds the object on Google Cloud Storage", async (context) => {
    if (!(await up(GCS_ENDPOINT))) return context.skip();
    const storage = new Storage({ apiEndpoint: GCS_ENDPOINT, projectId: "jvinu-public" });
    await storage.createBucket(name);
    try {
      await roundTrip(gcsDriver({ bucket: name, endpoint: GCS_ENDPOINT, projectId: "jvinu-public" }), `${GCS_ENDPOINT}/${name}`);
    } finally {
      await storage.bucket(name).delete({ ignoreNotFound: true });
    }
  });
});
