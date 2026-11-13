import { fail } from "@/app/lib/server/http";
import { bearerOrder } from "@/app/lib/server/store/http";
import { freshOrder, orderView, sellerConfig } from "@/app/lib/server/store/seller";

/** A buyer's order: status, quota, usage, and the bucket's key once it's paid. */
export async function GET(request: Request) {
  const config = sellerConfig();
  if (!config) return fail("This server doesn't sell storage.", 404);
  const order = await bearerOrder(request);
  if (!order) return fail("Unknown order.", 401);
  return Response.json(orderView(await freshOrder(config, order)), { headers: { "cache-control": "no-store" } });
}
