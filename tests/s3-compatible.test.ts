/**
 * The S3-compatible clouds jvinu builds endpoints for: each one turns the form's parts into
 * its real endpoint, or says what's wrong — and MinIO, the self-hosted one, takes only a
 * clean http(s) address that isn't a cloud metadata service.
 */
import { describe, expect, it } from "vitest";
import { S3_COMPATIBLE } from "../app/lib/server/s3-compatible";
import { estimateCost, downloadCost } from "../app/lib/pricing";

const GB = 1024 ** 3;

describe("Scaleway", () => {
  const spec = S3_COMPATIBLE.scaleway;
  it("builds the regional endpoint", () => {
    expect(spec.locate({ region: "nl-ams" })).toEqual({ endpoint: "https://s3.nl-ams.scw.cloud", region: "nl-ams" });
    expect(spec.locate({ region: "us-east-1" })).toHaveProperty("error");
  });
  it("knows its key format", () => {
    expect(spec.accessKey.test("SCW1A2B3C4D5E6F7G8H9")).toBe(true);
    expect(spec.accessKey.test("AKIAIOSFODNN7EXAMPLE")).toBe(false);
  });
  it("prices storage by class and charges past 75 GB of downloads", () => {
    const cost = estimateCost("scaleway", "https://s3.fr-par.scw.cloud", [
      { storageClass: "STANDARD", bytes: 100 * GB },
      { storageClass: "GLACIER", bytes: 1000 * GB },
    ]);
    expect(cost.kind === "estimate" && cost.monthly).toBeCloseTo(100 * 0.0185 + 1000 * 0.0029, 6);
    expect(downloadCost("scaleway", undefined, "STANDARD", 10 * GB)).toMatchObject({ kind: "estimate", allowance: expect.stringContaining("75 GB") });
  });
});

describe("Storj", () => {
  it("always goes through the hosted gateway", () => {
    expect(S3_COMPATIBLE.storj.locate({})).toEqual({ endpoint: "https://gateway.storjshare.io", region: "us1" });
    expect(S3_COMPATIBLE.storj.accessKey.test("jw7example4accesskey3abcdefg")).toBe(true);
  });
});

describe("MinIO", () => {
  const spec = S3_COMPATIBLE.minio;
  it("takes the server's address as typed, tidied", () => {
    expect(spec.locate({ endpoint: "https://minio.example.com:9000/" })).toEqual({ endpoint: "https://minio.example.com:9000", region: "us-east-1" });
    expect(spec.locate({ endpoint: "http://192.168.1.20:9000", region: "eu-west-1" })).toEqual({ endpoint: "http://192.168.1.20:9000", region: "eu-west-1" });
  });
  it("refuses addresses it shouldn't connect to", () => {
    for (const endpoint of ["", "ftp://minio.example.com", "https://user:pass@minio.example.com", "http://169.254.169.254", "not a url"]) {
      expect(spec.locate({ endpoint })).toHaveProperty("error");
    }
  });
  it("accepts MinIO's shorter keys and secrets, and is self-hosted for cost", () => {
    expect(spec.accessKey.test("minioadmin")).toBe(true);
    expect(spec.secretMin).toBe(8);
    expect(estimateCost("minio", "https://minio.example.com", [{ storageClass: null, bytes: GB }])).toEqual({ kind: "self-hosted" });
  });
});

describe("provider list", () => {
  it("names each provider once, and every connectable one is listed", async () => {
    const { CONNECTABLE, PROVIDER_PRESETS } = await import("../app/lib/storage");
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of CONNECTABLE) expect(ids).toContain(id);
  });
});

describe("keys with dot segments", () => {
  it("are refused before any provider sees them", async () => {
    const { hasDotSegment } = await import("../app/lib/server/drivers");
    expect(hasDotSegment("Photos/../Private/secret.txt")).toBe(true);
    expect(hasDotSegment("../other-container/x")).toBe(true);
    expect(hasDotSegment("./x")).toBe(true);
    expect(hasDotSegment("folder/")).toBe(false);
    expect(hasDotSegment("a/.hidden/..file.txt")).toBe(false);
  });
});

describe("the key guard on a real driver", () => {
  const target = {
    presetId: "s3" as const,
    bucket: "photos",
    region: "us-east-1",
    // Nothing listens here: a call that gets past the guard fails on the network instead.
    endpoint: "http://127.0.0.1:9",
    credentials: { kind: "s3" as const, accessKeyId: "test", secretAccessKey: "test" },
  };

  it("refuses dot segments in every kind of call, before the network", async () => {
    const { driverFor } = await import("../app/lib/server/drivers");
    const driver = driverFor(target);
    for (const call of [
      () => driver.read("a/../b.txt"),
      () => driver.list("../"),
      () => driver.remove(["ok.txt", "x/./y.txt"]),
      () => driver.copy("ok.txt", "../other/ok.txt"),
      () => driver.signedUrl("../x", true, 60),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 400 });
    }
  });

  it("passes ordinary calls through untouched", async () => {
    const { driverFor } = await import("../app/lib/server/drivers");
    const driver = driverFor(target);
    await expect(driver.read("folder/file.txt")).rejects.not.toMatchObject({ status: 400 });
    expect(await driver.signedUrl("folder/file.txt", true, 60)).toMatch(/^http:\/\/127\.0\.0\.1:9\/photos\/folder\/file\.txt\?/);
  });
});
