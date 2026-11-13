/**
 * The security fixes: roles, known-device sign-in throttling, display names that can't pass
 * for someone else, share-link limits a single sender can't use up for everyone, and request
 * bodies with a size limit.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.JVINU_DATA_DIR = mkdtempSync(path.join(tmpdir(), "jvinu-hardening-"));
  process.env.JVINU_SECRET = "hardening-test-secret-0123456789abcdef0123";
  delete process.env.JVINU_DATABASE_URL;
});

const auth = () => import("../app/lib/server/auth");

describe("roles", () => {
  beforeEach(() => {
    delete process.env.JVINU_ADMINS;
    delete process.env.JVINU_ADMIN_PASSWORD;
  });

  it("the admin password is an admin; the demo visitor never is", async () => {
    const { roleOf } = await auth();
    expect(await roleOf("admin", "password", null)).toBe("admin");
    expect(await roleOf("demo", "password", null)).toBe("member");
  });

  it("SSO accounts are admins only when JVINU_ADMINS lists them", async () => {
    const { roleOf } = await auth();
    process.env.JVINU_ADMINS = "boss@example.com,@ops.example.com";
    expect(await roleOf("oidc:1", "oidc", "boss@example.com")).toBe("admin");
    expect(await roleOf("oidc:2", "oidc", "anna@ops.example.com")).toBe("admin");
    expect(await roleOf("oidc:3", "oidc", "intern@example.com")).toBe("member");
    expect(await roleOf("oidc:4", "oidc", null)).toBe("member");
  });

  it("without a list, SSO accounts are members once an admin password exists", async () => {
    const { roleOf } = await auth();
    expect(await roleOf("oidc:1", "oidc", "a@example.com")).toBe("admin"); // nobody else could manage it
    process.env.JVINU_ADMIN_PASSWORD = "a-long-admin-password-123";
    expect(await roleOf("oidc:1", "oidc", "a@example.com")).toBe("member");
  });
});

describe("known devices", () => {
  it("only accept cookies this server signed", async () => {
    const { deviceCookieValue, deviceIdFrom } = await auth();
    expect(deviceIdFrom(deviceCookieValue("abc123"))).toBe("abc123");
    expect(deviceIdFrom("abc123.forged")).toBeNull();
    expect(deviceIdFrom(deviceCookieValue("abc123").replace("abc123", "other"))).toBeNull();
    expect(deviceIdFrom("")).toBeNull();
  });
});

describe("display names", () => {
  it("can't copy another person's name or a reserved one", async () => {
    const { db } = await import("../app/lib/server/db");
    const database = await db();
    const now = new Date().toISOString();
    await database.run(
      `insert into sessions (id, user_id, user_name, user_email, provider, csrf, created_at, expires_at) values ('s1', 'oidc:anna', 'Anna Pop', null, 'oidc', 'x', ?, ?)`,
      [now, now],
    );
    const { updateProfile } = await import("../app/lib/server/profiles");
    await expect(updateProfile("oidc:mallory", { name: "anna  POP" })).rejects.toMatchObject({ status: 409 });
    await expect(updateProfile("oidc:mallory", { name: "Someone with the link" })).rejects.toMatchObject({ status: 409 });
    await expect(updateProfile("oidc:mallory", { name: "Admin" })).rejects.toMatchObject({ status: 409 });
    await expect(updateProfile("admin", { name: "Admin" })).resolves.toBeUndefined();
    await expect(updateProfile("oidc:anna", { name: "Anna Pop" })).resolves.toBeUndefined();
    await expect(updateProfile("oidc:mallory", { name: "Mallory" })).resolves.toBeUndefined();
  });
});

describe("share-link limits", () => {
  it("a single sender runs out of their own allowance, not the link's", async () => {
    process.env.JVINU_TRUST_PROXY = "1";
    const { resetLimits } = await import("../app/lib/server/rate-limit");
    resetLimits();
    const { overLimit } = await import("../app/lib/server/share-access");
    const flooder = new Headers({ "x-forwarded-for": "203.0.113.9" });
    let refused = 0;
    for (let i = 0; i < 500; i++) if (overLimit("page", "token-1", flooder)) refused++;
    expect(refused).toBe(500 - 60);
    // Someone else can still open the same link.
    expect(overLimit("page", "token-1", new Headers({ "x-forwarded-for": "198.51.100.7" }))).toBeNull();
    delete process.env.JVINU_TRUST_PROXY;
  });
});

describe("request bodies", () => {
  it("stop being read past their limit", async () => {
    const { readJson, tooLarge } = await import("../app/lib/server/http");
    const big = new Request("http://x/", { method: "POST", body: JSON.stringify({ text: "a".repeat(5000) }) });
    const error = await readJson(big, 1024).catch((caught: unknown) => caught);
    expect(tooLarge(error)).toBe(true);
    expect(await readJson(new Request("http://x/", { method: "POST", body: '{"ok":1}' }), 1024)).toEqual({ ok: 1 });
  });
});
