import "server-only";

/** Where Google sends the browser back after "Sign in with Google": a page that shows the code. */
export const DRIVE_CALLBACK_PATH = "/connect/google-drive";

/**
 * The redirect URI the sign-in used. The browser built it from the page's own origin, and
 * Connect is a same-origin request (checked before this runs), so its Origin is that origin.
 * Google checks it against the code, so a wrong one only makes the exchange fail.
 */
export function driveRedirectUri(request: Request): string {
  const origin = request.headers.get("origin");
  const base = origin && origin !== "null" ? origin : (process.env.JVINU_PUBLIC_URL ?? "").replace(/\/+$/, "");
  return `${base}${DRIVE_CALLBACK_PATH}`;
}
