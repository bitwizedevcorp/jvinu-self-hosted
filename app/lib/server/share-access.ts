import "server-only";
import { clearMisses, recordMiss, take, waitBeforeGuess } from "./rate-limit";
import { findShareByToken, hashToken, passwordMatches, stateOf, type ShareLink } from "./shares";

/**
 * The checks every visit to a share link goes through, for the recipient's page and the
 * download alike: request rates, the link's state, and its password.
 */

export const REFUSALS = {
  missing: { status: 404, message: "This link doesn't exist. Check that it was copied whole." },
  expired: { status: 410, message: "This link has expired." },
  "used-up": { status: 410, message: "This link has reached its download limit." },
  revoked: { status: 410, message: "The person who shared this link has turned it off." },
  gone: { status: 410, message: "The shared file isn't there any more." },
  busy: { status: 429, message: "This link is busy right now. Wait a moment and try again." },
  "password-needed": { status: 401, message: "This link needs a password." },
  "wrong-password": { status: 403, message: "That password isn't right." },
  "slow-down": { status: 429, message: "Too many wrong passwords. Wait a little before trying again." },
} as const;

export type RefusalCode = keyof typeof REFUSALS;
export type Refusal = { code: RefusalCode; status: number; message: string; retryAfter?: number };

export const refusal = (code: RefusalCode, retryAfter?: number): Refusal => ({ code, ...REFUSALS[code], retryAfter });

/**
 * Who's asking, for sharing the limits out fairly. Behind a trusted proxy that's its
 * forwarded-for; otherwise it's what the server recorded, which a client can forge, so the
 * per-link and overall limits are the ones that really hold.
 */
export function addressOf(headers: Headers): string {
  const forwarded = (headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  return (process.env.JVINU_TRUST_PROXY === "1" ? forwarded[0] : forwarded.at(-1)) || "unknown";
}

const MINUTE = 60_000;
/**
 * Per sender, per link, and (downloads only) for the whole server. Pages have no server-wide
 * cap: a flood aimed at one link mustn't make every other link look busy. Downloads keep a
 * high one, since each can stream a whole file through this server.
 */
const LIMITS = {
  page: { link: 120, address: 60, all: null },
  download: { link: 60, address: 20, all: 3000 },
} as const;

/**
 * Counts a visit against the limits; a refusal when one is used up. The sender's own limit
 * is checked first and only a visit that passes it counts towards the link's and the
 * server's: one sender flooding a link uses up their own allowance, not everyone's. (Without
 * a trusted proxy the sender's address can be forged, so a flood from many forged addresses
 * can still make that one link busy — run jvinu behind a proxy with JVINU_TRUST_PROXY=1.)
 */
export function overLimit(kind: keyof typeof LIMITS, token: string, headers: Headers): Refusal | null {
  const limits = LIMITS[kind];
  const checks: [string, number | null][] = [
    [`${kind}:address:${addressOf(headers)}`, limits.address],
    [`${kind}:link:${hashToken(token)}`, limits.link],
    [`${kind}:all`, limits.all],
  ];
  for (const [key, limit] of checks) {
    if (limit === null) continue;
    const verdict = take(key, limit, MINUTE);
    if (!verdict.ok) return refusal("busy", verdict.retryAfter);
  }
  return null;
}

/** The link behind a token, if it works; otherwise why not. */
export async function openLink(token: string): Promise<{ link: ShareLink; passwordHash: string | null } | Refusal> {
  const found = await findShareByToken(token);
  if (!found) return refusal("missing");
  const state = stateOf(found.link);
  return state === "active" ? found : refusal(state);
}

/** Wrong guesses from one address back off after 5; from everyone together, after 20. */
const PER_ADDRESS_FREE = 5;
const PER_LINK_FREE = 20;

/** null when the password is right (or none is needed). */
export async function checkPassword(
  link: ShareLink,
  passwordHash: string | null,
  given: string | null,
  headers: Headers,
): Promise<Refusal | null> {
  if (!passwordHash) return null;
  if (!given) return refusal("password-needed");
  const mine = `password:${link.id}:${addressOf(headers)}`;
  const everyone = `password:${link.id}`;
  const wait = () => Math.max(waitBeforeGuess(mine, PER_ADDRESS_FREE), waitBeforeGuess(everyone, PER_LINK_FREE));
  const before = wait();
  if (before > 0) return refusal("slow-down", before);
  if (!(await passwordMatches(given, passwordHash))) {
    recordMiss(mine);
    recordMiss(everyone);
    return refusal("wrong-password", wait() || undefined);
  }
  clearMisses(mine);
  return null;
}
