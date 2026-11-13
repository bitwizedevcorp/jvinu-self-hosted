import { timingSafeEqual } from "node:crypto";
import { fail, readJson, tooLarge } from "@/app/lib/server/http";
import { listOrders, sellerConfig, setSuspended, sweepHealth } from "@/app/lib/server/store/seller";

/**
 * The seller's own admin API, for handling abuse. Off unless JVINU_SELLER_ADMIN_TOKEN is
 * set (32+ characters); every call sends it as "Authorization: Bearer <token>".
 *
 *   GET  /api/store/admin?q=<order id, email, bucket or Stripe customer>
 *   POST /api/store/admin  { "orderId": "…", "action": "suspend", "reason": "…" }
 *   POST /api/store/admin  { "orderId": "…", "action": "resume" }
 */
function authorized(request: Request, token: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: Request) {
  const config = sellerConfig();
  if (!config?.adminToken) return fail("Not found.", 404);
  if (!authorized(request, config.adminToken)) return fail("Not allowed.", 401);
  const query = new URL(request.url).searchParams.get("q") ?? undefined;
  return Response.json({ health: sweepHealth, orders: await listOrders({ query }) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const config = sellerConfig();
  if (!config?.adminToken) return fail("Not found.", 404);
  if (!authorized(request, config.adminToken)) return fail("Not allowed.", 401);
  let body: { orderId?: unknown; action?: unknown; reason?: unknown };
  try {
    body = await readJson(request, 8 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return fail("Expected a JSON body.", 400);
  }
  const orderId = typeof body.orderId === "string" ? body.orderId : "";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (body.action === "suspend" && !reason) return fail("Say why it's suspended (reason).", 400);
  if (body.action !== "suspend" && body.action !== "resume") return fail("The action is suspend or resume.", 400);
  try {
    const order = await setSuspended(config, orderId, body.action === "suspend" ? reason : null);
    if (!order) return fail("No such order.", 404);
    return Response.json({ id: order.id, status: order.status, suspended: order.suspended, access: order.access });
  } catch (error) {
    console.error("[store] suspend/resume failed", error);
    return fail("Couldn't change the bucket's access just now. Try again.", 502);
  }
}
