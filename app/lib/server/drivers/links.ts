import "server-only";
import type { StoredConnection } from "../connections";

/**
 * Which connections can hand out a provider's own signed links, kept beside the drivers that
 * make them (s3.ts, azure.ts, gcs.ts; garage through s3.ts). Imports nothing at runtime, so
 * both connections.ts and drivers/index.ts can use it.
 */
type LinkTarget = Pick<StoredConnection, "presetId" | "endpoint" | "credentials" | "crypt">;

/**
 * Where bundled storage is reachable from outside (a tunnel, a reverse proxy), if anywhere.
 * Only then can it hand out links; otherwise its files are served through this app.
 */
export function storagePublicUrl(): string | null {
  const raw = process.env.JVINU_STORAGE_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin + url.pathname.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * Whether this connection's driver gives out signed links (its `signedUrl` returns one), so
 * the page can offer them. Kept beside the drivers it describes: change one, change this.
 * Encrypted files can only be read through this app, so no provider link would open them.
 */
export function signsLinks(connection: LinkTarget): boolean {
  const c = connection.credentials;
  if (connection.crypt) return false;
  if (connection.presetId === "garage") return Boolean(storagePublicUrl());
  // s3.ts signs always; azure.ts not against an emulator; gcs.ts only with a key; the rest never.
  return c.kind === "s3" || (c.kind === "azure" && !connection.endpoint) || (c.kind === "gcs" && Boolean(c.privateKey));
}
