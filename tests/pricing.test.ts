import { describe, expect, it } from "vitest";
import { describeDownloadCost, downloadCost, estimateCost, formatUsd, normaliseClass, PRICE_SHEETS, restoreDelay, retrievalRate } from "../app/lib/pricing";

const GB = 1024 ** 3;
const usd = (estimate: ReturnType<typeof estimateCost>) => (estimate.kind === "estimate" ? estimate.monthly : null);

describe("cost estimate", () => {
  it("prices S3 per storage class", () => {
    const cost = estimateCost("s3", undefined, [
      { storageClass: "STANDARD", bytes: 100 * GB },
      { storageClass: "DEEP_ARCHIVE", bytes: 1000 * GB },
    ]);
    expect(usd(cost)).toBeCloseTo(100 * 0.023 + 1000 * 0.00099, 6);
  });

  it("treats an unreported class as the default", () => {
    expect(usd(estimateCost("s3", undefined, [{ storageClass: null, bytes: 10 * GB }]))).toBeCloseTo(0.23, 6);
  });

  it("matches Azure and OCI tier names whatever their case", () => {
    expect(normaliseClass("Hot")).toBe("HOT");
    expect(normaliseClass("InfrequentAccess")).toBe("INFREQUENTACCESS");
    expect(usd(estimateCost("azure", undefined, [{ storageClass: "Cool", bytes: 100 * GB }]))).toBeCloseTo(1.52, 6);
  });

  it("takes R2's free 10 GB off standard storage only", () => {
    expect(usd(estimateCost("r2", undefined, [{ storageClass: "STANDARD", bytes: 8 * GB }]))).toBe(0);
    expect(usd(estimateCost("r2", undefined, [{ storageClass: "STANDARD", bytes: 110 * GB }]))).toBeCloseTo(1.5, 6);
    expect(usd(estimateCost("r2", undefined, [{ storageClass: "STANDARD_IA", bytes: 100 * GB }]))).toBeCloseTo(1, 6);
  });

  it("charges Spaces its $5 base with 250 GB included", () => {
    expect(usd(estimateCost("spaces", undefined, [{ storageClass: null, bytes: 100 * GB }]))).toBe(5);
    expect(usd(estimateCost("spaces", undefined, [{ storageClass: null, bytes: 350 * GB }]))).toBeCloseTo(7, 6);
  });

  it("bills Wasabi at least 1 TB", () => {
    expect(usd(estimateCost("wasabi", undefined, [{ storageClass: null, bytes: 10 * GB }]))).toBeCloseTo(7.99, 6);
    expect(usd(estimateCost("wasabi", undefined, [{ storageClass: null, bytes: 2000 * GB }]))).toBeCloseTo(15.98, 6);
  });

  it("uses a connection's own rate over list prices", () => {
    const cost = estimateCost("s3", undefined, [{ storageClass: "GLACIER", bytes: 100 * GB }], 0.05);
    expect(cost).toMatchObject({ kind: "estimate", custom: true });
    expect(usd(cost)).toBeCloseTo(5, 6);
  });

  it("knows when there's no per-GB price", () => {
    expect(estimateCost("garage", "http://garage:3900", [])).toEqual({ kind: "self-hosted" });
    expect(estimateCost("dropbox", undefined, [])).toEqual({ kind: "plan" });
    expect(estimateCost("s3", "http://localhost:9000", [{ storageClass: null, bytes: GB }])).toEqual({ kind: "unknown" });
  });

  it("formats small and large amounts", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("< $0.01");
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatUsd(1234.5)).toBe("$1,235");
  });
});

describe("download cost", () => {
  it("charges S3 egress per GB, mentioning the free allowance", () => {
    const cost = downloadCost("s3", undefined, "STANDARD", 5 * GB);
    expect(cost).toMatchObject({ kind: "estimate", custom: false });
    if (cost.kind !== "estimate") throw new Error("expected an estimate");
    expect(cost.usd).toBeCloseTo(0.45, 6);
    expect(cost.retrievalUsd).toBe(0);
    expect(describeDownloadCost(cost)).toBe("About $0.45 per download — the first 100 GB a month (across AWS) are free");
  });

  it("adds retrieval fees for cold classes, and knows which need restoring", () => {
    const cost = downloadCost("s3", undefined, "DEEP_ARCHIVE", 10 * GB);
    if (cost.kind !== "estimate") throw new Error("expected an estimate");
    expect(cost.egressUsd).toBeCloseTo(0.9, 6);
    expect(cost.retrievalUsd).toBeCloseTo(0.2, 6);
    expect(cost.usd).toBeCloseTo(1.1, 6);
    expect(restoreDelay("s3", undefined, "DEEP_ARCHIVE")).toBe("12 to 48 hours");
    expect(restoreDelay("s3", undefined, "STANDARD_IA")).toBeNull();
    // The class means the same behind any S3 endpoint, priced or not.
    expect(restoreDelay("s3", "http://localhost:4566", "GLACIER")).toBe("minutes to 12 hours");
    expect(retrievalRate("azure", undefined, "Cool")).toBe(0.01);
    expect(restoreDelay("azure", undefined, "Archive")).toMatch(/15 hours/);
  });

  it("shows zero-egress providers as free — unless the class charges to read", () => {
    expect(downloadCost("r2", undefined, "STANDARD", 50 * GB)).toEqual({ kind: "free", note: undefined });
    expect(downloadCost("wasabi", undefined, null, 50 * GB).kind).toBe("free");
    const infrequent = downloadCost("r2", undefined, "STANDARD_IA", 50 * GB);
    if (infrequent.kind !== "estimate") throw new Error("expected an estimate");
    expect(infrequent.egressUsd).toBe(0);
    expect(infrequent.retrievalUsd).toBeCloseTo(0.5, 6);
  });

  it("gives an estimate or 'free' for every provider with a price sheet", () => {
    for (const [presetId, sheet] of Object.entries(PRICE_SHEETS)) {
      const cost = downloadCost(presetId, undefined, null, GB);
      if (typeof sheet === "string") expect(cost.kind).toBe(sheet);
      else expect(["estimate", "free"]).toContain(cost.kind);
    }
  });

  it("has no estimate for a custom endpoint, and says why for the rest", () => {
    expect(downloadCost("s3", "http://localhost:9000", null, GB)).toEqual({ kind: "unknown" });
    expect(describeDownloadCost({ kind: "unknown" })).toBe("No download estimate for this connection");
    expect(describeDownloadCost(downloadCost("garage", "http://garage:3900", null, GB))).toMatch(/your own server/);
    expect(describeDownloadCost(downloadCost("dropbox", undefined, null, GB))).toMatch(/bills by plan/);
  });

  it("uses a connection's own download rate over list prices", () => {
    const cost = downloadCost("s3", "http://localhost:9000", null, 10 * GB, 0.05);
    expect(cost).toMatchObject({ kind: "estimate", custom: true });
    if (cost.kind !== "estimate") throw new Error("expected an estimate");
    expect(cost.usd).toBeCloseTo(0.5, 6);
    expect(downloadCost("s3", undefined, null, GB, 0)).toEqual({ kind: "free" });
  });
});
