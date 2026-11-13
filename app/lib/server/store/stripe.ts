import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The few Stripe calls the storage seller makes, over its REST API (no SDK). Requests are
 * form-encoded, as Stripe expects; nested fields use bracket keys.
 */
const API = "https://api.stripe.com/v1";

export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Form = Record<string, string | number | boolean | undefined>;

export function formBody(fields: Form): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.append(key, String(value));
  return body.toString();
}

export async function stripe<T>(secretKey: string, method: "GET" | "POST", path: string, fields: Form = {}): Promise<T> {
  const query = method === "GET" && Object.keys(fields).length ? `?${formBody(fields)}` : "";
  const response = await fetch(`${API}/${path}${query}`, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? formBody(fields) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!response.ok) throw new StripeError(response.status, `Stripe ${path}: ${data.error?.message ?? response.status}`);
  return data as T;
}

/** Stripe's tolerance for a webhook's timestamp: older deliveries are refused as replays. */
const TOLERANCE_S = 300;

/**
 * Checks a webhook's Stripe-Signature header against the raw body: an HMAC-SHA256 of
 * "timestamp.body" under the endpoint's signing secret, compared in constant time.
 */
export function verifyWebhook(rawBody: string, header: string | null, secret: string, now = Date.now()): boolean {
  if (!header || !secret) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = value ?? "";
    if (key === "v1" && value) signatures.push(value);
  }
  const seconds = Number(timestamp);
  if (!timestamp || !Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  return signatures.some((signature) => {
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Builds a header the way Stripe does, for tests. */
export function signWebhook(rawBody: string, secret: string, now = Date.now()): string {
  const timestamp = Math.floor(now / 1000);
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export type StripeSubscription = {
  id: string;
  customer: string;
  status: "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused";
  metadata?: Record<string, string>;
  items: { data: { quantity?: number }[] };
};

export type StripeCheckoutSession = {
  id: string;
  url?: string | null;
  client_reference_id?: string | null;
  customer?: string | null;
  customer_details?: { email?: string | null } | null;
  subscription?: string | null;
  payment_status?: string;
  status?: string;
};
