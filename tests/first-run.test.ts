/**
 * The first sign-in on a server with no password: it asks for one, behind a one-time setup
 * code from the log; keeps only its hash, once; and JVINU_ADMIN_PASSWORD always takes over.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEYS = ["JVINU_ADMIN_PASSWORD", "JVINU_OIDC_ISSUER", "JVINU_OIDC_CLIENT_ID", "JVINU_OIDC_CLIENT_SECRET", "JVINU_PUBLIC_URL", "JVINU_OIDC_ALLOWED", "JVINU_DEMO"];
let saved: Record<string, string | undefined>;

beforeAll(() => {
  process.env.JVINU_DATA_DIR = mkdtempSync(path.join(tmpdir(), "jvinu-first-run-"));
  process.env.JVINU_SECRET = "first-run-test-secret-0123456789abcdef0123456";
  delete process.env.JVINU_DATABASE_URL;
});
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

const firstRun = () => import("../app/lib/server/first-run");

describe("first sign-in", () => {
  it("asks for a password only when there's no other way in", async () => {
    const { passwordMode } = await firstRun();
    expect(await passwordMode()).toBe("setup");
    Object.assign(process.env, {
      JVINU_OIDC_ISSUER: "https://accounts.google.com",
      JVINU_OIDC_CLIENT_ID: "id",
      JVINU_OIDC_CLIENT_SECRET: "secret",
      JVINU_PUBLIC_URL: "https://storage.example.com",
      JVINU_OIDC_ALLOWED: "@example.com",
    });
    expect(await passwordMode()).toBe("off");
    for (const key of KEYS) delete process.env[key];
    process.env.JVINU_DEMO = "1";
    expect(await passwordMode()).toBe("off");
  });

  it("uses JVINU_ADMIN_PASSWORD when it's set", async () => {
    const { adminName, adminPasswordMatches, passwordMode } = await firstRun();
    process.env.JVINU_ADMIN_PASSWORD = "from-the-environment";
    expect(await passwordMode()).toBe("env");
    expect(await adminPasswordMatches("from-the-environment")).toBe(true);
    expect(await adminPasswordMatches("something-else-entirely")).toBe(false);
    expect(await adminName()).toBe("Admin");
  });

  it("prints a one-time code that's forgiving about how it's typed", async () => {
    const { announceSetup, setupCode, setupCodeMatches } = await firstRun();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    announceSetup(true);
    const code = setupCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(log.mock.calls[0][0]).toContain(`http://localhost:3000/login?setup=${code}`);
    // Within the minute, a visit doesn't print it again.
    announceSetup();
    expect(log).toHaveBeenCalledTimes(1);
    expect(setupCodeMatches(code)).toBe(true);
    expect(setupCodeMatches(` ${code.toLowerCase().replaceAll("-", " ")} `)).toBe(true);
    expect(setupCodeMatches("AAAA-AAAA-AAAA")).toBe(false);
    expect(setupCodeMatches("")).toBe(false);
  });

  it("checks the password and name before keeping them", async () => {
    const { passwordProblem } = await firstRun();
    expect(passwordProblem("short")?.field).toBe("password");
    expect(passwordProblem("x".repeat(1025))?.field).toBe("password");
    expect(passwordProblem("long enough password", "n".repeat(61))?.field).toBe("name");
    expect(passwordProblem("long enough password", "Ana\u0007")?.field).toBe("name");
    expect(passwordProblem("long enough password", "Ana Pop")).toBeNull();
  });

  it("keeps the chosen password once, as a hash, and uses up the code", async () => {
    const { adminName, adminPasswordMatches, passwordMode, setAdminPassword, setupCode, setupCodeMatches } = await firstRun();
    const { db } = await import("../app/lib/server/db");
    const code = setupCode();
    expect(await setAdminPassword("correct horse battery staple", "Ana Pop")).toBe(true);
    expect(await passwordMode()).toBe("stored");
    expect(await adminPasswordMatches("correct horse battery staple")).toBe(true);
    expect(await adminPasswordMatches("correct horse battery stapler")).toBe(false);
    expect(await adminName()).toBe("Ana Pop");
    expect(setupCodeMatches(code)).toBe(false);

    const row = await (await db()).get<{ value: string }>(`select value from server_settings where key = 'admin_password'`);
    expect(row?.value).toMatch(/^scrypt\$/);
    expect(row?.value).not.toContain("correct horse");

    // The first to finish wins; a second setup changes nothing.
    expect(await setAdminPassword("another password entirely", "Mallory")).toBe(false);
    expect(await adminPasswordMatches("correct horse battery staple")).toBe(true);
    expect(await adminName()).toBe("Ana Pop");
  });

  it("changes the chosen password, given the current one", async () => {
    const { adminPasswordMatches, changeAdminPassword } = await firstRun();
    expect(await changeAdminPassword("not the current one", "a brand new password")).toBe("wrong");
    expect(await adminPasswordMatches("correct horse battery staple")).toBe(true);
    expect(await changeAdminPassword("correct horse battery staple", "a brand new password")).toBe("changed");
    expect(await adminPasswordMatches("a brand new password")).toBe(true);
    expect(await adminPasswordMatches("correct horse battery staple")).toBe(false);
  });

  it("lets JVINU_ADMIN_PASSWORD take over a chosen one, as the way back in", async () => {
    const { adminName, adminPasswordMatches, changeAdminPassword, passwordMode } = await firstRun();
    process.env.JVINU_ADMIN_PASSWORD = "recovery-password-123";
    expect(await passwordMode()).toBe("env");
    // That one is changed in the environment, not from the page.
    expect(await changeAdminPassword("recovery-password-123", "yet another password")).toBe("env");
    expect(await adminPasswordMatches("recovery-password-123")).toBe(true);
    expect(await adminPasswordMatches("a brand new password")).toBe(false);
    expect(await adminName()).toBe("Admin");
    delete process.env.JVINU_ADMIN_PASSWORD;
    expect(await passwordMode()).toBe("stored");
    expect(await adminPasswordMatches("a brand new password")).toBe(true);
  });

  it("signs password sessions out when the password changes outside the app", async () => {
    const { endSessionsIfPasswordChanged } = await firstRun();
    const { db } = await import("../app/lib/server/db");
    const database = await db();
    const session = async (id: string, userId: string, provider: string) =>
      database.run(
        `insert into sessions (id, user_id, user_name, user_email, provider, csrf, created_at, expires_at) values (?, ?, ?, null, ?, 'csrf', ?, ?)`,
        [id, userId, userId, provider, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()],
      );
    const left = async () => (await database.all<{ id: string }>(`select id from sessions order by id`)).map((row) => row.id);

    await session("a-password", "admin", "password");
    await session("b-sso", "ana@example.com", "oidc");
    // Changed in the browser already: that's not a change "outside", nothing more ends.
    expect(await endSessionsIfPasswordChanged()).toBe(0);
    expect(await left()).toEqual(["a-password", "b-sso"]);

    // A new JVINU_ADMIN_PASSWORD (or switching to one) ends the password sessions, not SSO ones.
    process.env.JVINU_ADMIN_PASSWORD = "rotated-password-one";
    expect(await endSessionsIfPasswordChanged()).toBe(1);
    expect(await left()).toEqual(["b-sso"]);
    expect(await endSessionsIfPasswordChanged()).toBe(0);

    await session("c-password", "admin", "password");
    process.env.JVINU_ADMIN_PASSWORD = "rotated-password-two";
    expect(await endSessionsIfPasswordChanged()).toBe(1);
    expect(await left()).toEqual(["b-sso"]);
  });
});
