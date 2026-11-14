import { describe, expect, it } from "vitest";
import { CONNECTABLE, PROVIDER_KINDS, PROVIDERS, S3_COMPATIBLE_IDS, isFolderRoot, placeLabel, profileOf } from "@/app/lib/providers";
import { PROVIDER_PRESETS } from "@/app/lib/storage";
import { S3_COMPATIBLE } from "@/app/lib/server/s3-compatible";
import { PRICE_SHEETS, sheetFor } from "@/app/lib/pricing";
import { prepareConnection } from "@/app/lib/server/provider-connect";

/** One profile per provider: every list that names providers agrees with it. */
describe("provider profiles", () => {
  it("cover every preset, and every connectable one has a preset card and a price sheet", () => {
    const ids = Object.keys(PROVIDERS).sort();
    expect(ids).toEqual([...PROVIDER_KINDS, ...S3_COMPATIBLE_IDS, "garage"].sort());
    expect(Object.keys(S3_COMPATIBLE).sort()).toEqual([...S3_COMPATIBLE_IDS].sort());
    for (const id of CONNECTABLE) {
      expect(PROVIDER_PRESETS.some((preset) => preset.id === id), id).toBe(true);
      expect(Object.hasOwn(PRICE_SHEETS, id), id).toBe(true);
    }
    expect(CONNECTABLE).not.toContain("garage");
  });

  it("say what a connection opens", () => {
    expect(isFolderRoot("gdrive")).toBe(true);
    expect(isFolderRoot("s3")).toBe(false);
    expect(placeLabel("azure")).toBe("Container");
    expect(placeLabel("dropbox")).toBe("Folder");
    expect(profileOf("onedrive")?.pathLabel).toBe("OneDrive path");
    expect(profileOf("nope")).toBeUndefined();
    expect(profileOf("__proto__")).toBeUndefined();
  });
});

describe("every provider, complete", () => {
  it("has a connector whose place agrees with its profile", () => {
    for (const id of CONNECTABLE) {
      const prepared = prepareConnection({ presetId: id, bucket: "/a/../b" });
      expect("error" in prepared, id).toBe(true);
      const error = (prepared as { error: string }).error;
      if (PROVIDERS[id].place === "folder") expect(error, id).toBe(`Enter a folder path such as /Photos, or / for the whole ${PROVIDERS[id].service}.`);
      else expect(error, id).toBe(`That isn't a valid ${PROVIDERS[id].place} name.`);
    }
  });

  it("names its at-rest encryption exactly where it's optional", () => {
    for (const [id, profile] of Object.entries(PROVIDERS)) expect(Boolean(profile.sseName), id).toBe(profile.atRest === "optional");
  });

  it("prices a custom S3 endpoint as unknown, in one place", () => {
    expect(typeof sheetFor("s3", undefined)).toBe("object");
    expect(sheetFor("s3", "http://localhost:9000")).toBe("unknown");
    expect(sheetFor("minio", "http://localhost:9000")).toBe("self-hosted");
    expect(sheetFor("nope", undefined)).toBe("unknown");
  });
});

/** The connect form, checked before anything goes over the network. */
describe("preparing a connection", () => {
  const ok = (body: Record<string, unknown>) => {
    const prepared = prepareConnection(body);
    if ("error" in prepared) throw new Error(prepared.error);
    return prepared;
  };
  const error = (body: Record<string, unknown>) => {
    const prepared = prepareConnection(body);
    return "error" in prepared ? prepared.error : null;
  };

  it("refuses providers it can't connect, including the server's own storage", () => {
    expect(error({ presetId: "garage", bucket: "x" })).toMatch(/can't be connected/);
    expect(error({ presetId: "ftp", bucket: "x" })).toMatch(/can't be connected/);
  });

  it("checks the place by the provider's own rules", () => {
    expect(error({ presetId: "azure", bucket: "Not_Valid", accountName: "acct", accountKey: "a".repeat(40) })).toBe("That isn't a valid container name.");
    expect(error({ presetId: "s3", bucket: "x", accessKeyId: "AKIAEXAMPLEKEY000000", secretAccessKey: "s".repeat(40) })).toBe("That isn't a valid bucket name.");
    expect(error({ presetId: "gdrive", bucket: "/a/../b" })).toBe("Enter a folder path such as /Photos, or / for the whole Google Drive.");
  });

  it("normalises folder roots and keeps endpoints off cloud metadata addresses", () => {
    const drive = ok({
      presetId: "gdrive",
      bucket: "Work/Reports/",
      clientId: "1-abc.apps.googleusercontent.com",
      clientSecret: "secret-123456",
      codeVerifier: "v".repeat(43),
      code: "4/abcdefgh",
    });
    expect(drive).toMatchObject({ bucket: "/Work/Reports", endpoint: undefined, link: { code: "4/abcdefgh" } });
    expect(error({ presetId: "s3", bucket: "data", endpoint: "http://169.254.169.254/" })).toMatch(/metadata address/);
  });

  it("checks each credential's shape and keeps only what's needed", () => {
    expect(error({ presetId: "s3", bucket: "data", accessKeyId: "short", secretAccessKey: "s".repeat(40) })).toMatch(/AWS access key/);
    const gcs = ok({
      presetId: "gcs",
      bucket: "data",
      serviceAccountKey: JSON.stringify({ client_email: "a@b.iam", private_key: "-----BEGIN PRIVATE KEY-----x", project_id: "p", extra: "dropped" }),
    });
    expect(gcs.credentials).toEqual({ kind: "gcs", projectId: "p", clientEmail: "a@b.iam", privateKey: "-----BEGIN PRIVATE KEY-----x" });
    expect(error({ presetId: "onedrive", bucket: "/", clientId: "not-a-guid" })).toMatch(/GUID/);
    expect(error({ presetId: "dropbox", bucket: "/", appKey: "abcdefgh1", codeVerifier: "short", code: "x" })).toMatch(/Allow access on Dropbox/);
  });

  it("builds S3-compatible endpoints itself, whatever endpoint the form sent", () => {
    const wasabi = ok({ presetId: "wasabi", bucket: "data", region: "eu-central-1", endpoint: "http://evil.example", accessKeyId: "WASABIEXAMPLEKEY0001", secretAccessKey: "s".repeat(40) });
    expect(wasabi.endpoint).toBe("https://s3.eu-central-1.wasabisys.com");
  });
});
