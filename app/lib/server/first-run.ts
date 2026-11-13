import "server-only";
import { createHash, createHmac, hkdfSync, randomInt, timingSafeEqual } from "node:crypto";
import { authConfig, passwordMatches as envPasswordMatches } from "./auth";
import { masterSecret } from "./crypto";
import { db } from "./db";
import { hashPassword, passwordMatches } from "./passwords";

/**
 * A server with no password (no JVINU_ADMIN_PASSWORD) and no single sign-on asks for one at
 * the first sign-in, in the browser. The page also asks for a one-time setup code that only
 * the server's log shows, so it's the server's owner who chooses the password and not
 * whoever reaches a new server first. JVINU_ADMIN_PASSWORD, when set, always takes over:
 * that's also the way back in if the chosen password is forgotten.
 */
export type PasswordMode =
  /** JVINU_ADMIN_PASSWORD holds the password. */
  | "env"
  /** It was chosen in the browser; the database keeps its hash. */
  | "stored"
  /** No password yet, and no other way in: the sign-in page asks for one. */
  | "setup"
  /** Single sign-on, or the demo, only. */
  | "off";

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 1024;
export const MAX_NAME = 60;
/** Password sign-in is one account; this is its id in sessions and the history. */
export const ADMIN_ID = "admin";

const PASSWORD_KEY = "admin_password";
const NAME_KEY = "admin_name";
const FINGERPRINT_KEY = "admin_password_fingerprint";

// Survive dev hot reloads, so the code in the log stays the one the page accepts.
const state = globalThis as unknown as {
  __jvinuAdmin?: { hash: string; name: string | null };
  __jvinuSetupCode?: string;
  __jvinuSetupAnnounced?: number;
};

/** The chosen password's hash and the name that goes with it. Once found it's remembered; "none yet" is checked afresh. */
async function stored(): Promise<{ hash: string; name: string | null } | null> {
  if (state.__jvinuAdmin) return state.__jvinuAdmin;
  const rows = await (await db()).all<{ key: string; value: string }>(`select key, value from server_settings where key in (?, ?)`, [
    PASSWORD_KEY,
    NAME_KEY,
  ]);
  const hash = rows.find((row) => row.key === PASSWORD_KEY)?.value;
  if (!hash) return null;
  state.__jvinuAdmin = { hash, name: rows.find((row) => row.key === NAME_KEY)?.value ?? null };
  return state.__jvinuAdmin;
}

export async function passwordMode(): Promise<PasswordMode> {
  const config = authConfig();
  if (config.password) return "env";
  if (await stored()) return "stored";
  return config.oidc || config.demo ? "off" : "setup";
}

/** Whether this is the admin password, wherever it's kept. */
export async function adminPasswordMatches(input: string): Promise<boolean> {
  const mode = await passwordMode();
  if (mode === "env") return envPasswordMatches(input);
  const admin = mode === "stored" ? await stored() : null;
  return admin ? passwordMatches(input, admin.hash) : false;
}

/** Who password sign-in is: the name given at setup, or "Admin". */
export async function adminName(): Promise<string> {
  return (authConfig().password ? null : (await stored())?.name) || "Admin";
}

/** What's wrong with a new password (or the name that goes with it) before it's kept, or null. */
export function passwordProblem(password: string, name = ""): { field: "password" | "name"; message: string } | null {
  if (password.length < MIN_PASSWORD) return { field: "password", message: `Use at least ${MIN_PASSWORD} characters. A few unrelated words work well.` };
  if (password.length > MAX_PASSWORD) return { field: "password", message: "That password is too long." };
  if (name.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name)) return { field: "name", message: `Names are up to ${MAX_NAME} characters.` };
  return null;
}

/**
 * Keeps the password chosen at first sign-in, and the name to show for it. False if a
 * password was set meanwhile: the first to finish wins, and anyone else must sign in.
 */
export async function setAdminPassword(password: string, name: string): Promise<boolean> {
  const database = await db();
  const now = new Date().toISOString();
  const changed = await database.run(`insert into server_settings (key, value, updated_at) values (?, ?, ?) on conflict (key) do nothing`, [
    PASSWORD_KEY,
    await hashPassword(password),
    now,
  ]);
  if (!changed) return false;
  if (name) {
    await database.run(
      `insert into server_settings (key, value, updated_at) values (?, ?, ?)
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [NAME_KEY, name, now],
    );
  }
  state.__jvinuAdmin = undefined;
  state.__jvinuSetupCode = undefined; // used up
  await rememberFingerprint();
  return true;
}

/**
 * Changes the password chosen in the browser, given the current one. One from
 * JVINU_ADMIN_PASSWORD is changed where it's set, so that's refused here ("env").
 */
export async function changeAdminPassword(current: string, next: string): Promise<"changed" | "wrong" | "env" | "none"> {
  const mode = await passwordMode();
  if (mode === "env") return "env";
  if (mode !== "stored") return "none";
  if (!(await adminPasswordMatches(current))) return "wrong";
  const changed = await (await db()).run(`update server_settings set value = ?, updated_at = ? where key = ?`, [
    await hashPassword(next),
    new Date().toISOString(),
    PASSWORD_KEY,
  ]);
  state.__jvinuAdmin = undefined;
  if (!changed) return "none";
  await rememberFingerprint();
  return "changed";
}

/* ---- Sessions follow the password ----------------------------------------------------- */

/** The password in force, as a keyed hash: it changes whenever the password does. */
async function fingerprint(): Promise<string | null> {
  const mode = await passwordMode();
  const source = mode === "env" ? `env\0${process.env.JVINU_ADMIN_PASSWORD}` : mode === "stored" ? `stored\0${(await stored())?.hash}` : null;
  if (source === null) return null;
  // Its own key, derived from the master key as every other use of it is.
  const key = Buffer.from(hkdfSync("sha256", masterSecret(), "jvinu", "admin-password-fingerprint", 32));
  return createHmac("sha256", key).update(source).digest("base64url");
}

async function rememberFingerprint(value?: string | null) {
  const current = value ?? (await fingerprint());
  if (!current) return;
  await (await db()).run(
    `insert into server_settings (key, value, updated_at) values (?, ?, ?)
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [FINGERPRINT_KEY, current, new Date().toISOString()],
  );
}

/**
 * Password sessions end when the password in force changed outside the app since the last
 * start: a new JVINU_ADMIN_PASSWORD, or a switch between that and one chosen in the
 * browser. Changing it in the browser ends the other sessions itself. Returns how many ended.
 */
export async function endSessionsIfPasswordChanged(): Promise<number> {
  const current = await fingerprint();
  if (!current) return 0;
  const database = await db();
  const known = await database.get<{ value: string }>(`select value from server_settings where key = ?`, [FINGERPRINT_KEY]);
  if (known?.value === current) return 0;
  await rememberFingerprint(current);
  // The first start that keeps a fingerprint has nothing to compare it with.
  if (!known) return 0;
  return database.run(`delete from sessions where user_id = ? and provider = 'password'`, [ADMIN_ID]);
}

/* ---- The one-time setup code --------------------------------------------------------- */

// No 0/O or 1/I, so it can be read off a terminal and typed without doubt.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Twelve characters in three groups (60 bits); a new one each time the server starts. */
export function setupCode(): string {
  state.__jvinuSetupCode ??= Array.from({ length: 3 }, () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""),
  ).join("-");
  return state.__jvinuSetupCode;
}

/** Case, spaces and dashes don't matter: "k7qf 2m9x h4tp" is "K7QF-2M9X-H4TP". */
const normalized = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function setupCodeMatches(input: string): boolean {
  const expected = state.__jvinuSetupCode;
  if (!expected || !input) return false;
  const digest = (value: string) => createHash("sha256").update(normalized(value)).digest();
  return timingSafeEqual(digest(input), digest(expected));
}

/** Where the setup link points: this server's public address, or localhost. */
function setupLink(code: string): string {
  const base = (process.env.JVINU_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, "");
  return `${base}/login?setup=${code}`;
}

/**
 * Puts the setup link and code in the server's log, framed so they stand out. At most once
 * a minute unless `force`: the sign-in page calls it on every visit while setup is pending.
 */
export function announceSetup(force = false): void {
  const now = Date.now();
  if (!force && state.__jvinuSetupAnnounced && now - state.__jvinuSetupAnnounced < 60_000) return;
  state.__jvinuSetupAnnounced = now;
  const code = setupCode();
  const lines = [
    "jvinu has no admin password yet. To choose one, open:",
    "",
    `  ${setupLink(code)}`,
    "",
    `or go to the sign-in page and enter the setup code ${code}.`,
    "To set it in the environment instead, use JVINU_ADMIN_PASSWORD.",
  ];
  const width = Math.max(...lines.map((line) => line.length));
  const rule = "─".repeat(width + 2);
  console.log(["", `┌${rule}┐`, ...lines.map((line) => `│ ${line.padEnd(width)} │`), `└${rule}┘`, ""].join("\n"));
}

/**
 * At startup: sessions made with a password that's since been replaced end, and a server
 * waiting for its first password says in the log how to set it.
 */
export async function atStartup(): Promise<void> {
  if (authConfig().problems.length) return;
  const { resetIfAsked } = await import("./two-factor");
  await resetIfAsked();
  const ended = await endSessionsIfPasswordChanged();
  if (ended) console.log(`[auth] The admin password changed since the last start: ${ended} session(s) signed out.`);
  if ((await passwordMode()) === "setup") announceSetup(true);
}
