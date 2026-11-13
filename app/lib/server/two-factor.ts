import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { openWith, sealWith } from "./crypto";
import { db } from "./db";

/**
 * Two-step sign-in for the admin-password account: a code from an authenticator app
 * (TOTP, RFC 6238: SHA-1, 6 digits, 30 seconds — what every app expects), or one of ten
 * single-use recovery codes. Single sign-on accounts get theirs from the identity provider.
 *
 * The secret is sealed under JVINU_SECRET; recovery codes are kept only as hashes. A code
 * can't be used twice. If the phone and the recovery codes are both lost, whoever runs the
 * server sets JVINU_RESET_TWO_FACTOR=1 and restarts once (see resetIfAsked).
 */
const KEY = "admin_two_factor";
const PENDING_KEY = "admin_two_factor_pending";
const SEAL = "two-factor";
const STEP = 30;
const DIGITS = 6;
const RECOVERY_CODES = 10;
/** A code from the step before or after also counts: phone clocks drift. */
const WINDOW = 1;
/** How long a started setup waits for its first code. */
const PENDING_MS = 15 * 60_000;

type Stored = { secret: string; lastStep: number; recovery: string[]; enabledAt: string };
type Pending = { secret: string; startedAt: number };

/* ---- RFC 4648 base32 and RFC 6238 TOTP ----------------------------------------------------- */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Not base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for one time step. */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const number = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(number).padStart(DIGITS, "0");
}

export const stepOf = (time = Date.now()) => Math.floor(time / 1000 / STEP);

/** The step a code belongs to, within the drift window — or null. Compared in constant time. */
export function matchingStep(secret: string, code: string, time = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepOf(time);
  let found: number | null = null;
  for (let step = now - WINDOW; step <= now + WINDOW; step++) {
    const expected = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code)) && found === null) found = step;
  }
  return found;
}

export const otpauthUri = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent(`jvinu:${account}`)}?secret=${secret}&issuer=jvinu&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;

/* ---- Storage ------------------------------------------------------------------------------- */

const hashCode = (code: string) => createHash("sha256").update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");

async function read<T>(key: string): Promise<T | null> {
  const row = await (await db()).get<{ value: string }>(`select value from server_settings where key = ?`, [key]);
  if (!row) return null;
  try {
    return openWith<T>(SEAL, row.value, key);
  } catch {
    return null;
  }
}

async function write(key: string, value: unknown | null) {
  const database = await db();
  if (value === null) {
    await database.run(`delete from server_settings where key = ?`, [key]);
    return;
  }
  await database.run(
    `insert into server_settings (key, value, updated_at) values (?, ?, ?)
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [key, sealWith(SEAL, value, key), new Date().toISOString()],
  );
}

export async function twoFactorEnabled(): Promise<boolean> {
  return (await read<Stored>(KEY)) !== null;
}

/** Starts setting it up: a new secret, shown once as a QR code and as text. */
export async function startSetup(account: string): Promise<{ secret: string; uri: string }> {
  const secret = base32Encode(randomBytes(20));
  await write(PENDING_KEY, { secret, startedAt: Date.now() } satisfies Pending);
  return { secret, uri: otpauthUri(secret, account) };
}

/** Turns it on once the app shows a matching code. Returns the recovery codes, shown once. */
export async function confirmSetup(code: string): Promise<string[] | null> {
  const pending = await read<Pending>(PENDING_KEY);
  if (!pending || Date.now() - pending.startedAt > PENDING_MS) return null;
  const step = matchingStep(pending.secret, code.trim());
  if (step === null) return null;
  const recovery = Array.from({ length: RECOVERY_CODES }, () => {
    const raw = base32Encode(randomBytes(5)).slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  await write(KEY, { secret: pending.secret, lastStep: step, recovery: recovery.map(hashCode), enabledAt: new Date().toISOString() } satisfies Stored);
  await write(PENDING_KEY, null);
  return recovery;
}

/**
 * Checks a code at sign-in (or to turn it off): an app code not used before, or an unused
 * recovery code, which is then spent. true when it may proceed — also when it's off.
 */
export async function checkSecondFactor(code: string | undefined): Promise<boolean> {
  const stored = await read<Stored>(KEY);
  if (!stored) return true;
  const given = (code ?? "").trim();
  if (!given) return false;
  const step = matchingStep(stored.secret, given);
  if (step !== null) {
    if (step <= stored.lastStep) return false; // already used: a replayed code
    await write(KEY, { ...stored, lastStep: step });
    return true;
  }
  const hashed = hashCode(given);
  const index = stored.recovery.indexOf(hashed);
  if (index === -1) return false;
  await write(KEY, { ...stored, recovery: stored.recovery.filter((_, i) => i !== index) });
  console.warn(`[auth] A recovery code was used to sign in; ${stored.recovery.length - 1} left.`);
  return true;
}

export async function recoveryCodesLeft(): Promise<number | null> {
  return (await read<Stored>(KEY))?.recovery.length ?? null;
}

export async function disableTwoFactor(): Promise<void> {
  await write(KEY, null);
  await write(PENDING_KEY, null);
}

/** At startup: JVINU_RESET_TWO_FACTOR=1 turns it off, for someone locked out. */
export async function resetIfAsked(): Promise<void> {
  if (process.env.JVINU_RESET_TWO_FACTOR !== "1") return;
  if (!(await twoFactorEnabled())) return;
  await disableTwoFactor();
  console.warn("[auth] JVINU_RESET_TWO_FACTOR=1: two-step sign-in was turned off. Remove the setting, then turn it on again in your profile.");
}
