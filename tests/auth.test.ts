import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authConfig, emailAllowed } from "../app/lib/server/auth";

const OIDC = {
  JVINU_OIDC_ISSUER: "https://accounts.google.com",
  JVINU_OIDC_CLIENT_ID: "client-id",
  JVINU_OIDC_CLIENT_SECRET: "client-secret",
  JVINU_PUBLIC_URL: "https://storage.example.com",
};
const KEYS = [...Object.keys(OIDC), "JVINU_OIDC_ALLOWED", "JVINU_OIDC_ALLOW_ANY", "JVINU_ADMIN_PASSWORD", "JVINU_SECRET"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  process.env.JVINU_SECRET = "auth-test-secret-0123456789abcdef0123456789";
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("OIDC allowlist", () => {
  it("refuses to run single sign-on with an empty allowlist", () => {
    Object.assign(process.env, OIDC);
    const config = authConfig();
    expect(config.oidc).toBeNull();
    expect(config.problems.join(" ")).toMatch(/JVINU_OIDC_ALLOWED is empty/);
  });

  it("stays closed even when a password is also set", () => {
    Object.assign(process.env, OIDC, { JVINU_ADMIN_PASSWORD: "a-long-enough-password" });
    const config = authConfig();
    expect(config.oidc).toBeNull();
    expect(config.problems.length).toBeGreaterThan(0);
  });

  it("runs with an allowlist", () => {
    Object.assign(process.env, OIDC, { JVINU_OIDC_ALLOWED: "Alice@Example.com, @team.example.com" });
    const config = authConfig();
    expect(config.problems).toEqual([]);
    expect(config.oidc).toMatchObject({ allowed: ["alice@example.com", "@team.example.com"], allowAny: false });
  });

  it("admits everyone only with the explicit opt-in", () => {
    Object.assign(process.env, OIDC, { JVINU_OIDC_ALLOW_ANY: "1" });
    const config = authConfig();
    expect(config.problems).toEqual([]);
    expect(config.oidc?.allowAny).toBe(true);
    // Anything but exactly "1" isn't an opt-in.
    process.env.JVINU_OIDC_ALLOW_ANY = "true";
    expect(authConfig().oidc).toBeNull();
  });

  it("matches exact emails and whole domains, case-insensitively", () => {
    const allowed = ["alice@example.com", "@team.example.com"];
    expect(emailAllowed("ALICE@example.com", allowed)).toBe(true);
    expect(emailAllowed("bob@team.example.com", allowed)).toBe(true);
    expect(emailAllowed("bob@example.com", allowed)).toBe(false);
    expect(emailAllowed("mallory@evil-team.example.com.attacker.io", allowed)).toBe(false);
    expect(emailAllowed(undefined, allowed)).toBe(false);
  });

  it("lets nobody in through an empty list", () => {
    expect(emailAllowed("anyone@gmail.com", [])).toBe(false);
    expect(emailAllowed("anyone@gmail.com", [], true)).toBe(true);
  });
});
