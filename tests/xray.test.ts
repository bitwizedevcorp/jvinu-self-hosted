import { describe, expect, it } from "vitest";
import { coolerClass, formatUsd, storageRate } from "../app/lib/pricing";
import { formatBytes } from "../app/lib/storage";
import { xrayHeadline } from "../app/lib/xray";
import type { BucketAudit, Listing } from "../app/lib/server/drivers/types";
import { renderXrayPdf } from "../app/lib/server/xray/pdf";
import { xrayScan, type XrayTarget } from "../app/lib/server/xray/scan";
import {
  nameRule,
  scanText,
  worthReading,
} from "../app/lib/server/xray/secrets";
import { memoryDriver } from "./memory-driver";

const GB = 1024 ** 3;
const NOW = Date.parse("2026-11-01T00:00:00Z");
const target: XrayTarget = {
  id: "c1",
  name: "Production",
  bucket: "prod-assets",
  presetId: "s3",
  provider: "Amazon S3",
  encrypted: false,
};

const file = (
  key: string,
  size: number,
  extra: Partial<Listing["files"][number]> = {},
): Listing["files"][number] => ({
  key,
  size,
  lastModified: "2026-10-01T00:00:00.000Z",
  etag: null,
  storageClass: "STANDARD",
  ...extra,
});

const audit = (over: Partial<BucketAudit> = {}): BucketAudit => ({
  incompleteUploads: async () => ({ uploads: [], truncated: false }),
  versioning: async () => "off",
  versions: async () => ({ versions: [], truncated: false }),
  exposure: async () => ({
    blocked: true,
    policyPublic: false,
    aclPublic: false,
    anonymousListing: false,
  }),
  publicObject: async () => false,
  ...over,
});

describe("secret rules", () => {
  it("flags credential files by name, but not their examples", () => {
    expect(nameRule("app/.env")?.rule).toMatch(/Environment/);
    expect(nameRule("app/.env.production")?.severity).toBe("high");
    expect(nameRule("app/.env.example")).toBeNull();
    expect(nameRule("home/.ssh/id_ed25519")?.rule).toBe("SSH private key");
    expect(nameRule("infra/terraform.tfstate.backup")?.rule).toMatch(
      /Terraform/,
    );
    expect(nameRule("home/.aws/credentials")?.rule).toBe(
      "AWS credentials file",
    );
    expect(nameRule("docs/credentials")).toBeNull();
    expect(nameRule("backups/db-2026.sql.gz")?.severity).toBe("medium");
    expect(nameRule("photos/key-west.jpg")).toBeNull();
  });

  it("finds credentials inside text and reports the line, never the value", () => {
    const hits = scanText(
      "# config\nregion=eu\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nDATABASE_URL=postgres://app:hunter2secret@db.internal:5432/app\n",
    );
    expect(hits.map((hit) => hit.rule)).toEqual(
      expect.arrayContaining([
        "AWS access key",
        "Database URL with a password",
      ]),
    );
    expect(hits.find((hit) => hit.rule === "AWS access key")?.line).toBe(3);
    expect(JSON.stringify(hits)).not.toContain("AKIA");
  });

  it("leaves placeholders and prose alone", () => {
    expect(
      scanText(
        "password: ${DB_PASSWORD}\napi_key=<your-key-here>\nThe password policy is strict.",
      ),
    ).toEqual([]);
  });

  it("opens only small text files", () => {
    expect(worthReading("a/config.yml", 2000, 256 * 1024)).toBe(true);
    expect(worthReading("a/video.mp4", 2000, 256 * 1024)).toBe(false);
    expect(worthReading("a/huge.json", 10 * 1024 * 1024, 256 * 1024)).toBe(
      false,
    );
    expect(worthReading("a/.env", 500, 256 * 1024)).toBe(true);
  });
});

describe("per-file rates", () => {
  it("prices a class, and suggests a cooler one where the provider has it", () => {
    expect(storageRate("s3", undefined, "GLACIER")).toBe(0.0036);
    expect(storageRate("s3", "http://minio:9000", null)).toBeNull();
    expect(storageRate("minio", undefined, null, 0.01)).toBe(0.01);
    expect(coolerClass("s3", undefined)?.storageClass).toBe("STANDARD_IA");
    expect(coolerClass("b2", undefined)).toBeNull();
  });
});

/**
 * A made-up Stripe live key, assembled at run time: written out whole, GitHub's push
 * protection takes it for a real one and refuses the push.
 */
const FAKE_STRIPE_KEY = ["sk", "live", "0000fake0000fake0000fake00"].join("_");

describe("x-ray scan", () => {
  it("prices folders and finds each kind of waste", async () => {
    const driver = memoryDriver({
      "app/.env": `STRIPE=${FAKE_STRIPE_KEY}\n`,
      "notes/readme.md": "hello",
    });
    const files = [
      file("media/a.mov", 100 * GB),
      file("media/b.mov", 2 * GB, { etag: "aaa" }),
      file("backup/b-copy.mov", 2 * GB, { etag: "aaa" }),
      file("archive/2019.tar", 50 * GB, {
        lastModified: "2025-01-01T00:00:00.000Z",
      }),
      file("media/.DS_Store", 6148),
      file("app/.env", 44),
      file("notes/readme.md", 5),
    ];
    const report = await xrayScan(
      target,
      driver,
      audit({
        incompleteUploads: async () => ({
          uploads: [
            {
              key: "media/c.mov",
              uploadId: "u1",
              initiated: "2026-01-01T00:00:00.000Z",
              bytes: 10 * GB,
            },
          ],
          truncated: false,
        }),
        versioning: async () => "enabled",
        versions: async () => ({
          versions: [
            {
              key: "media/a.mov",
              versionId: "v2",
              size: 100 * GB,
              lastModified: null,
              latest: true,
              deleteMarker: false,
              storageClass: "STANDARD",
            },
            {
              key: "media/a.mov",
              versionId: "v1",
              size: 20 * GB,
              lastModified: null,
              latest: false,
              deleteMarker: false,
              storageClass: "STANDARD",
            },
          ],
          truncated: false,
        }),
      }),
      { files, truncated: false },
      NOW,
    );

    expect(report.folders[0]).toMatchObject({ folder: "media/", objects: 3 });
    expect(report.folders[0].monthlyUsd).toBeCloseTo(102 * 0.023, 2);
    const byId = Object.fromEntries(
      report.waste.map((finding) => [finding.id, finding]),
    );
    expect(byId["incomplete-uploads"].monthlyUsd).toBeCloseTo(0.23, 6);
    expect(byId["old-versions"].bytes).toBe(20 * GB);
    expect(byId.duplicates).toMatchObject({ objects: 1, bytes: 2 * GB });
    expect(byId.junk.objects).toBe(1);
    // 50 GB at $0.023 → $0.0125 in Standard-IA.
    expect(byId.cold.monthlyUsd).toBeCloseTo(50 * (0.023 - 0.0125), 6);
    // Cold data is a saving, not something to delete: it isn't counted in removable bytes.
    expect(report.wasteBytes).toBe(10 * GB + 20 * GB + 2 * GB + 6148);
    expect(report.wasteMonthlyUsd).toBeCloseTo(0.23 + 0.46 + 0.046 + 0.525, 2);

    expect(
      report.secrets.map((secret) => `${secret.source}:${secret.rule}`),
    ).toEqual(
      expect.arrayContaining([
        "name:Environment file (.env)",
        "content:Stripe live key",
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("sk_live_");
    expect(report.exposure.state).toBe("private");
    expect(xrayHeadline(report, formatUsd, formatBytes)).toMatch(
      /^jvinu found \$1\.\d\d\/month of waste$/,
    );
  });

  it("calls a bucket public when anyone can list it, and marks flagged files that answer strangers", async () => {
    const driver = memoryDriver({
      "keys/id_rsa": "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
    });
    const report = await xrayScan(
      target,
      driver,
      audit({
        exposure: async () => ({
          blocked: false,
          policyPublic: true,
          aclPublic: false,
          anonymousListing: true,
        }),
        publicObject: async () => true,
      }),
      { files: [file("keys/id_rsa", 40)], truncated: false },
      NOW,
    );
    expect(report.exposure).toMatchObject({ state: "public", publicFiles: 1 });
    expect(report.secrets.every((secret) => secret.public)).toBe(true);
  });

  it("still reports on a provider with no bucket-level API", async () => {
    const report = await xrayScan(
      { ...target, presetId: "dropbox", provider: "Dropbox" },
      memoryDriver({}),
      undefined,
      { files: [file("a.bin", GB)], truncated: false },
      NOW,
    );
    expect(report.costKind).toBe("plan");
    expect(report.wasteMonthlyUsd).toBeNull();
    expect(report.exposure.state).toBe("unknown");
    expect(report.notes.join(" ")).toMatch(/no API/);
  });

  it("renders a PDF that names files but holds no secret", async () => {
    const driver = memoryDriver({
      "app/.env": "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
    });
    const report = await xrayScan(
      target,
      driver,
      audit(),
      {
        files: [
          file("app/.env", 50),
          file("media/ünï—code “file”.mov", 3 * GB),
        ],
        truncated: false,
      },
      NOW,
    );
    const pdf = Buffer.from(renderXrayPdf(report));
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("Storage X-Ray");
    expect(text).toContain("app/.env");
    expect(text).not.toContain("ghp_");
    // The cross-reference table points at each object.
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const first = Number(/\n(\d{10}) 00000 n /.exec(text)![1]);
    expect(text.slice(first, first + 7)).toBe("1 0 obj");
  });
});
