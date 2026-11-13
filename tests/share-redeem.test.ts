/**
 * Redeeming a share link, start to finish: limits, the link's state, the password, the
 * connection, and the bytes — through redeemLink, as the download route uses it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryDriver } from "./memory-driver";

beforeAll(() => {
  process.env.JVINU_DATA_DIR = mkdtempSync(path.join(tmpdir(), "jvinu-redeem-"));
  process.env.JVINU_SECRET = "redeem-test-secret-0123456789abcdef0123456789";
  delete process.env.JVINU_DATABASE_URL;
});

const files = memoryDriver({ "docs/report.pdf": "the report" });
const redeem = async () => (await import("../app/lib/server/share-redeem")).redeemLink;
const newLink = async (options: { maxDownloads?: number; password?: string; key?: string } = {}) =>
  (await import("../app/lib/server/shares")).createShareLink({
    connectionId: "conn",
    key: options.key ?? "docs/report.pdf",
    createdBy: "alice",
    expiresAt: null,
    maxDownloads: options.maxDownloads ?? null,
    password: options.password,
    meta: { name: "report.pdf", size: 10 },
  });
let address = 0;
const visitor = () => new Headers({ "x-forwarded-for": `198.51.100.${++address}` });

beforeAll(async () => {
  const { resolveDriversWith } = await import("../app/lib/server/share-copies");
  resolveDriversWith(async (id) => (id === "conn" ? files : null));
});
afterAll(async () => (await import("../app/lib/server/share-copies")).resolveDriversWith(null));

describe("redeeming a share link", () => {
  it("delivers the bytes, and counts each download up to the limit", async () => {
    const redeemLink = await redeem();
    const { token } = await newLink({ maxDownloads: 1 });
    const first = await redeemLink(token, null, visitor());
    if (!("delivery" in first) || first.delivery.kind !== "stream") throw new Error("expected the bytes");
    expect(await new Response(first.delivery.object.stream).text()).toBe("the report");
    expect(await redeemLink(token, null, visitor())).toMatchObject({ refused: { code: "used-up" } });
  });

  it("asks for the password, refuses a wrong one, and takes the right one", async () => {
    const redeemLink = await redeem();
    const { token } = await newLink({ password: "open sesame" });
    expect(await redeemLink(token, null, visitor())).toMatchObject({ refused: { code: "password-needed" } });
    expect(await redeemLink(token, "wrong", visitor())).toMatchObject({ refused: { code: "wrong-password" } });
    expect(await redeemLink(token, "open sesame", visitor())).toHaveProperty("delivery");
  });

  it("says the file is gone, without counting a download, and refuses unknown links", async () => {
    const redeemLink = await redeem();
    const { token } = await newLink({ key: "docs/deleted.pdf", maxDownloads: 1 });
    expect(await redeemLink(token, null, visitor())).toMatchObject({ refused: { code: "gone" } });
    expect(await redeemLink(token, null, visitor())).toMatchObject({ refused: { code: "gone" } });
    expect(await redeemLink("x".repeat(32), null, visitor())).toMatchObject({ refused: { code: "missing" } });
  });
});
