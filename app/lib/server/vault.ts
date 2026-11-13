import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export class VaultConfigError extends Error {}

function key(): Buffer {
  const secret = process.env.JVINU_SECRET;
  if (!secret || secret.length < 32) {
    throw new VaultConfigError(
      "JVINU_SECRET is missing or shorter than 32 characters. Add it to .env.local and restart the server.",
    );
  }
  return createHash("sha256").update(secret).digest();
}

/** AES-256-GCM: iv(12) | tag(16) | ciphertext. Tampering fails the auth tag. */
function encrypt(value: unknown, keyBytes: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt<T>(raw: Buffer, keyBytes: Buffer): T | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(text) as T;
  } catch {
    // Wrong key, truncated or tampered: treat as nothing saved.
    return null;
  }
}

/** Sealed with the server secret alone — used for the small cookie. */
export function seal(value: unknown): string {
  return encrypt(value, key()).toString("base64url");
}

export function unseal<T>(token: string): T | null {
  const keyBytes = key();
  return decrypt<T>(Buffer.from(token, "base64url"), keyBytes);
}

/**
 * Sealed with the server secret AND a per-browser key that lives only in that
 * browser's cookie: a vault file on disk is useless without both.
 */
function vaultKey(browserKey: string): Buffer {
  return createHash("sha256").update(key()).update(Buffer.from(browserKey, "base64url")).digest();
}

export function sealForBrowser(value: unknown, browserKey: string): Buffer {
  return encrypt(value, vaultKey(browserKey));
}

export function unsealForBrowser<T>(raw: Buffer, browserKey: string): T | null {
  return decrypt<T>(raw, vaultKey(browserKey));
}

export function newBrowserKey(): string {
  return randomBytes(32).toString("base64url");
}
