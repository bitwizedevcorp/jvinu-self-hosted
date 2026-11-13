import "server-only";
import packageJson from "../../../package.json";

/**
 * The cloud-backup waitlist. Off unless a URL is set: then the account menu offers a
 * short form, and only what someone types into it is forwarded there — by this server,
 * so browsers never contact a third party. Nothing is sent otherwise.
 *
 *   JVINU_WAITLIST_URL=https://…   where sign-ups are POSTed as JSON
 *   JVINU_WAITLIST=off             hide it even when a URL is set
 */
export function waitlistUrl(): string | null {
  if ((process.env.JVINU_WAITLIST ?? "").toLowerCase() === "off") return null;
  const raw = process.env.JVINU_WAITLIST_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    // https only: an email address shouldn't cross the internet in the clear.
    return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost") ? url.href : null;
  } catch {
    return null;
  }
}

export const SIZES = ["under-100gb", "100gb-1tb", "1-10tb", "over-10tb", "not-sure"] as const;
export type WaitlistEntry = { email: string; size?: (typeof SIZES)[number]; note?: string };

/** Exactly what leaves the server — the form shows the same list. */
export function waitlistPayload(entry: WaitlistEntry) {
  return {
    email: entry.email,
    size: entry.size ?? null,
    note: entry.note ?? null,
    source: "jvinu-app",
    version: packageJson.version,
  };
}

export async function forwardToWaitlist(url: string, entry: WaitlistEntry): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(waitlistPayload(entry)),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    return response.ok;
  } catch {
    return false;
  }
}
