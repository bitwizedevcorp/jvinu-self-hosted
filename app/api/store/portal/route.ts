import { fail, readJson } from "@/app/lib/server/http";
import { bearerOrder, cleanReturnUrl } from "@/app/lib/server/store/http";
import { portalUrl, sellerConfig } from "@/app/lib/server/store/seller";

/** A Stripe billing-portal link for the order's customer: change size, update card, cancel. */
export async function POST(request: Request) {
  const config = sellerConfig();
  if (!config) return fail("This server doesn't sell storage.", 404);
  const order = await bearerOrder(request);
  if (!order) return fail("Unknown order.", 401);
  let body: { returnUrl?: unknown };
  try {
    body = await readJson(request, 4096);
  } catch {
    return fail("Expected a JSON body.", 400);
  }
  const returnUrl = cleanReturnUrl(body.returnUrl);
  if (!returnUrl) return fail("The return address must be an https URL.", 400);
  try {
    return Response.json({ url: await portalUrl(config, order, returnUrl) });
  } catch (error) {
    console.error("[store] portal failed", error);
    return fail("Couldn't open billing just now. Try again later.", 502);
  }
}
