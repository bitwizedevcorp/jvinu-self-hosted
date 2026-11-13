import "server-only";
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { ConfigError, masterSecret } from "./crypto";
import { db } from "./db";

export type SessionUser = {
  id: string;
  name: string;
  email?: string;
  provider: "password" | "oidc";
  /** A version tag for the person's photo, when they've uploaded one (see profiles.ts). */
  avatar?: string;
  /**
   * Admins manage connections (add, disconnect, settings, read-only, endpoints) and the
   * storage plan. Members browse, preview, upload where a connection allows it, and share.
   */
  role: Role;
  /** Echoed back in the x-csrf-token header on every state-changing request. */
  csrf: string;
};

export type OidcSettings = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Exact emails and "@domain.com" entries. Empty lets nobody in, unless `allowAny`. */
  allowed: string[];
  /** JVINU_OIDC_ALLOW_ANY=1: every account the identity provider signs in gets access. */
  allowAny: boolean;
  publicUrl: string;
};

export const SESSION_COOKIE = "jvinu_session";

export type Role = "admin" | "member";

/**
 * Who's an admin. The admin-password account always is; the demo visitor never is. With
 * single sign-on, JVINU_ADMINS lists the emails and @domains that are. Without that list,
 * SSO accounts are admins only on a server with no admin password (someone has to be).
 * The email is the one the identity provider vouched for, never one typed into a profile.
 */
export async function roleOf(userId: string, provider: string, providerEmail: string | null): Promise<Role> {
  if (userId === DEMO_USER.id) return "member";
  if (provider !== "oidc") return "admin";
  const admins = (process.env.JVINU_ADMINS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (admins.length) return emailAllowed(providerEmail ?? undefined, admins) ? "admin" : "member";
  const { passwordMode } = await import("./first-run");
  const mode = await passwordMode();
  return mode === "env" || mode === "stored" ? "member" : "admin";
}

/**
 * JVINU_DEMO=1: a public, read-only showcase. Anyone can enter without a password; every
 * change is refused except running queries and comparisons.
 */
export const demoMode = () => process.env.JVINU_DEMO === "1";
export const DEMO_USER = { id: "demo", name: "Demo visitor", provider: "password" as const };
const SESSION_DAYS = 7;

/** Which sign-in methods the environment sets up; a password chosen in the browser is in first-run.ts. */
export function authConfig(): { password: boolean; oidc: OidcSettings | null; demo: boolean; problems: string[] } {
  const problems: string[] = [];
  const password = process.env.JVINU_ADMIN_PASSWORD ?? "";
  if (password && password.length < 12) problems.push("JVINU_ADMIN_PASSWORD must be at least 12 characters.");

  let oidc: OidcSettings | null = null;
  const issuer = process.env.JVINU_OIDC_ISSUER;
  if (issuer) {
    const clientId = process.env.JVINU_OIDC_CLIENT_ID ?? "";
    const clientSecret = process.env.JVINU_OIDC_CLIENT_SECRET ?? "";
    const publicUrl = (process.env.JVINU_PUBLIC_URL ?? "").replace(/\/+$/, "");
    if (!clientId || !clientSecret) problems.push("OIDC needs JVINU_OIDC_CLIENT_ID and JVINU_OIDC_CLIENT_SECRET.");
    if (!/^https?:\/\//.test(publicUrl)) problems.push("OIDC needs JVINU_PUBLIC_URL, e.g. https://storage.example.com.");
    const allowed = (process.env.JVINU_OIDC_ALLOWED ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    const allowAny = process.env.JVINU_OIDC_ALLOW_ANY === "1";
    // Fail closed: with Google (or any public IdP) as the issuer, an empty list would let
    // every account in the world sign in with full access.
    if (!allowed.length && !allowAny) {
      problems.push(
        "JVINU_OIDC_ALLOWED is empty, so single sign-on would admit every account the provider signs in. List the emails or @domains allowed in — or set JVINU_OIDC_ALLOW_ANY=1 if your provider only has your own people.",
      );
    }
    if (clientId && clientSecret && publicUrl && (allowed.length || allowAny)) {
      oidc = { issuer, clientId, clientSecret, publicUrl, allowed, allowAny };
    }
  }
  try {
    masterSecret();
  } catch (error) {
    if (error instanceof ConfigError) problems.push(error.message);
  }
  // With no password and no single sign-on, the first sign-in chooses a password (first-run.ts).
  return { password: password.length >= 12, oidc, demo: demoMode(), problems };
}

/** Whether an email may sign in. An empty list admits nobody unless `allowAny` is set. */
export function emailAllowed(email: string | undefined, allowed: string[], allowAny = false): boolean {
  if (allowAny) return true;
  if (!allowed.length || !email) return false;
  const lower = email.toLowerCase();
  return allowed.some((entry) => (entry.startsWith("@") ? lower.endsWith(entry) : lower === entry));
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** JVINU_ADMIN_PASSWORD, compared in constant time: both sides are hashed to equal length first. */
export function passwordMatches(input: string): boolean {
  const expected = process.env.JVINU_ADMIN_PASSWORD ?? "";
  if (expected.length < 12) return false;
  return timingSafeEqual(digest(input), digest(expected));
}

/** HTTPS as the browser sees it — so Secure cookies work behind a TLS-terminating proxy. */
export function isHttps(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  return new URL(request.url).protocol === "https:";
}

export async function createSession(
  user: Omit<SessionUser, "csrf" | "role">,
  secure: boolean,
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  const database = await db();
  // Expired sessions are pruned whenever someone signs in.
  await database.run(`delete from sessions where expires_at < ?`, [now.toISOString()]);
  const userAgent = ((await headers()).get("user-agent") ?? "").slice(0, 300) || null;
  await database.run(
    `insert into sessions (id, user_id, user_name, user_email, provider, csrf, created_at, expires_at, user_agent)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      digest(token).toString("hex"),
      user.id,
      user.name,
      user.email ?? null,
      user.provider,
      randomBytes(24).toString("base64url"),
      now.toISOString(),
      expires.toISOString(),
      userAgent,
    ],
  );
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Lax, not Strict: a Strict cookie isn't sent on the redirect back from an OIDC
    // provider. Cross-site writes are stopped by the CSRF token and Origin check instead.
    sameSite: "lax",
    secure,
    path: "/",
    expires,
  });
}

/**
 * The signed-in user, or null. Only the token's hash is ever stored. A name, email or photo
 * the person set in their profile takes the place of what sign-in provided.
 */
export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length > 128) return null;
  type Row = {
    user_id: string;
    user_name: string;
    user_email: string | null;
    provider: string;
    csrf: string;
    expires_at: string;
    profile_name: string | null;
    profile_email: string | null;
    profile_avatar: string | null;
  };
  const row = await (await db()).get<Row>(
    `select s.*, p.name as profile_name, p.email as profile_email, p.avatar as profile_avatar
       from sessions s left join user_profiles p on p.user_id = s.user_id
      where s.id = ?`,
    [digest(token).toString("hex")],
  );
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return {
    id: row.user_id,
    name: row.profile_name || row.user_name,
    email: row.profile_email || row.user_email || undefined,
    provider: row.provider === "oidc" ? "oidc" : "password",
    avatar: row.profile_avatar ?? undefined,
    role: await roleOf(row.user_id, row.provider, row.user_email),
    csrf: row.csrf,
  };
}

/** Signs this user out everywhere but here, as after a password change. Returns how many sessions ended. */
export async function endOtherSessions(userId: string): Promise<number> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return (await db()).run(`delete from sessions where user_id = ? and id <> ?`, [userId, token ? digest(token).toString("hex") : ""]);
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await (await db()).run(`delete from sessions where id = ?`, [digest(token).toString("hex")]);
  store.delete(SESSION_COOKIE);
}

/** State changes must come from this site: Origin (or Referer) has to match the host. */
export function sameOrigin(request: Request): boolean {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const source = request.headers.get("origin") ?? request.headers.get("referer");
  if (!source || !host) return false;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

const json = (body: unknown, status: number) => Response.json(body, { status });

/**
 * Every API route starts here. Reads need a session; writes also need a same-origin
 * request carrying the session's CSRF token.
 */
export async function requireUser(
  request: Request,
  { mutating = false, demoAllowed = false, admin = false }: { mutating?: boolean; demoAllowed?: boolean; admin?: boolean } = {},
): Promise<SessionUser | Response> {
  const config = authConfig();
  if (config.problems.length) return json({ error: config.problems[0] }, 503);
  const user = await currentUser();
  if (!user) return json({ error: "Sign in to continue." }, 401);
  if (mutating) {
    const token = request.headers.get("x-csrf-token") ?? "";
    const ok =
      sameOrigin(request) &&
      token.length === user.csrf.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(user.csrf));
    if (!ok) return json({ error: "This request didn't come from jvinu — reload the page and try again." }, 403);
    if (demoMode() && !demoAllowed) {
      return json({ error: "This is a read-only demo — browse, preview, query and compare. Install jvinu to make changes." }, 403);
    }
  }
  if (admin && user.role !== "admin") return json({ error: "Only an admin can do that. Ask whoever runs this server." }, 403);
  return user;
}

/* ---- Known devices ---------------------------------------------------------------------- */

/**
 * A browser that has signed in successfully gets a signed, long-lived device cookie. Wrong
 * passwords are then counted per device for it, apart from everyone else's: a flood of
 * guesses from elsewhere can't lock the owner out of a browser they've used before.
 */
export const DEVICE_COOKIE = "jvinu_device";
const DEVICE_DAYS = 365;

function deviceSignature(id: string): string {
  const key = Buffer.from(hkdfSync("sha256", masterSecret(), "jvinu", "known-device", 32));
  return createHmac("sha256", key).update(id).digest("base64url");
}

/** The id of this browser's device cookie, if it carries a valid one. */
export async function knownDevice(): Promise<string | null> {
  return deviceIdFrom((await cookies()).get(DEVICE_COOKIE)?.value ?? "");
}

/** A device cookie's value: "<id>.<signature>". */
export const deviceCookieValue = (id: string) => `${id}.${deviceSignature(id)}`;

/** The id in a device cookie's value, or null when it isn't one this server signed. */
export function deviceIdFrom(value: string): string | null {
  const [id, signature] = value.split(".");
  if (!id || !signature || id.length > 64) return null;
  const expected = Buffer.from(deviceSignature(id));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}

/** After a successful sign-in: this browser is a known device from now on. */
export async function rememberDevice(secure: boolean): Promise<void> {
  if (await knownDevice()) return;
  const id = randomBytes(18).toString("base64url");
  (await cookies()).set(DEVICE_COOKIE, deviceCookieValue(id), {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/api/auth",
    maxAge: DEVICE_DAYS * 86_400,
  });
}

/** What wrong guesses are counted against: this known device, or the client's address. */
export async function throttleKey(request: Request): Promise<string> {
  const device = await knownDevice();
  return device ? `device:${device}` : `address:${clientAddress(request)}`;
}

/* ---- Login throttling: per known device or client address, in memory (one process) --- */

const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

/**
 * Forwarded-for headers can be set by anyone talking to the app directly, so they're
 * only trusted behind a proxy that sets them (JVINU_TRUST_PROXY=1). Otherwise every
 * attempt shares one bucket — right for a single admin password.
 */
export function clientAddress(request: Request): string {
  if (process.env.JVINU_TRUST_PROXY !== "1") return "all";
  return (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}

export function throttled(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) return false;
  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailure(key: string) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
}

export function clearFailures(key: string) {
  attempts.delete(key);
}

/* ---- Signed-in devices -------------------------------------------------------------------- */

/** A session as its owner sees it. `id` is a short public handle, not the token or its hash. */
export type DeviceSession = { id: string; current: boolean; device: string; createdAt: string; expiresAt: string };

const handleOf = (hash: string) => hash.slice(0, 16);

/** "Chrome on macOS", "Safari on iPhone"… from a user-agent string. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : /curl\//i.test(userAgent)
              ? "curl"
              : "Browser";
  const system = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(userAgent)
            ? "macOS"
            : /Linux/.test(userAgent)
              ? "Linux"
              : "";
  return system ? `${browser} on ${system}` : browser;
}

/** This person's sessions that haven't expired, newest first. */
export async function listSessions(userId: string): Promise<DeviceSession[]> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const mine = token ? digest(token).toString("hex") : "";
  type Row = { id: string; user_agent: string | null; created_at: string; expires_at: string };
  const rows = await (await db()).all<Row>(
    `select id, user_agent, created_at, expires_at from sessions where user_id = ? and expires_at > ? order by created_at desc`,
    [userId, new Date().toISOString()],
  );
  return rows.map((row) => ({
    id: handleOf(row.id),
    current: row.id === mine,
    device: describeDevice(row.user_agent),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}

/** Signs out one of this person's sessions by its handle. Never another person's. */
export async function endSession(userId: string, handle: string): Promise<boolean> {
  if (!/^[0-9a-f]{16}$/.test(handle)) return false;
  return (await (await db()).run(`delete from sessions where user_id = ? and substr(id, 1, 16) = ?`, [userId, handle])) > 0;
}
