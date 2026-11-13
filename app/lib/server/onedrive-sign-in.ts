import "server-only";
import { openWith, sealWith } from "./crypto";

/**
 * Between "Sign in with Microsoft" and "Connect", the device code has to live somewhere.
 * It rides in the form, sealed under the master key and bound to the signed-in user, so
 * the server keeps no state and the page never sees the code Microsoft polls with.
 */
const PURPOSE = "onedrive-sign-in";

export type PendingSignIn = { deviceCode: string; clientId: string; tenant: string; expires: number };

export function sealSignIn(pending: PendingSignIn, userId: string): string {
  return sealWith(PURPOSE, pending, userId);
}

/** The pending sign-in, or null when the handle is forged, another user's, or expired. */
export function openSignIn(handle: string, userId: string): PendingSignIn | null {
  try {
    const pending = openWith<PendingSignIn>(PURPOSE, handle, userId);
    return typeof pending?.deviceCode === "string" && pending.expires > Date.now() ? pending : null;
  } catch {
    return null;
  }
}
