import "server-only";
import { StorageUserError, type ObjectBody, type StorageDriver } from "./drivers/types";
import { effectiveType } from "./mime";
import { claimDownload, type ShareLink } from "./shares";

/**
 * Handing a shared file to whoever holds the link: the provider's own signed link where it
 * can make one (the bytes then never pass through this server), otherwise the bytes
 * streamed through this app — OCI, Dropbox, OneDrive, My storage without a public URL,
 * and encrypted connections.
 */

/** How long a handed-off provider link lasts: long enough to start, short enough not to matter. */
export const HANDOFF_SECONDS = 300;

export type Delivery = { kind: "redirect"; url: string } | { kind: "stream"; object: ObjectBody };

const usedUp = () => new StorageUserError("This link has reached its download limit.", 410);

/**
 * Counts one download and says how to deliver it. Nothing is counted for a file that's no
 * longer there; a download that loses the race for the last slot is refused.
 */
export async function startDownload(link: ShareLink, driver: StorageDriver, key = link.key): Promise<Delivery> {
  const signed = await driver.signedUrl(key, true, HANDOFF_SECONDS);
  if (signed) {
    if (driver.head) await driver.head(key); // a 404 here, before anything is counted
    if (!(await claimDownload(link.id))) throw usedUp();
    return { kind: "redirect", url: signed };
  }
  const object = await driver.read(key);
  if (!(await claimDownload(link.id))) {
    await object.stream.cancel().catch(() => {});
    throw usedUp();
  }
  return { kind: "stream", object };
}

const ACTIVE = /html|svg|xml|javascript|ecmascript/i;

/** A download, never a page: always an attachment, and nothing a browser would run. */
export function attachmentResponse(object: ObjectBody, name: string): Response {
  const type = effectiveType(name, object.contentType);
  const headers = new Headers({
    "content-type": ACTIVE.test(type) ? "application/octet-stream" : type,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
  });
  if (object.size !== undefined) headers.set("content-length", String(object.size));
  return new Response(object.stream, { headers });
}
