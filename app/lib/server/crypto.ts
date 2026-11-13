import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export class ConfigError extends Error {}

/** JVINU_SECRET is the master key. Every use derives its own sub-key from it. */
export function masterSecret(): string {
  const secret = process.env.JVINU_SECRET;
  if (!secret || secret.length < 32) {
    throw new ConfigError("JVINU_SECRET is missing or shorter than 32 characters. Set it and restart.");
  }
  return secret;
}

function subKey(purpose: string): Buffer {
  // The salt is part of every derived key: changing it makes every stored credential unreadable.
  return Buffer.from(hkdfSync("sha256", masterSecret(), "jvinu", purpose, 32));
}

/**
 * AES-256-GCM. The AAD binds a ciphertext to its context (the connection id), so a
 * sealed row copied onto another connection fails to open.
 */
export function sealWith(purpose: string, value: unknown, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", subKey(purpose), iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

export function openWith<T>(purpose: string, sealed: string, aad: string): T {
  if (!sealed.startsWith("v1:")) throw new Error("Unknown sealed format");
  const raw = Buffer.from(sealed.slice(3), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", subKey(purpose), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as T;
}
