import { clientAddress } from "@/app/lib/server/auth";
import { fail, readJson } from "@/app/lib/server/http";
import { take } from "@/app/lib/server/rate-limit";
import { cleanReturnUrl } from "@/app/lib/server/store/http";
import { alert } from "@/app/lib/server/store/notify";
import { sellerConfig, startCheckout } from "@/app/lib/server/store/seller";
import { isBilling, validBlocks } from "@/app/lib/storage-plan";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/**
 * Starts a purchase for a buyer's jvinu (server to server). Returns the Stripe Checkout
 * address for the person, and a token only the buyer's server keeps.
 */
export async function POST(request: Request) {
  const config = sellerConfig();
  if (!config) return fail("This server doesn't sell storage.", 404);
  // Per address behind a trusted proxy; otherwise every caller shares one generous bucket,
  // so a flood can slow checkouts down but can't run up unbounded Stripe sessions.
  const address = clientAddress(request);
  const limit = take(`store-checkout:${address}`, address === "all" ? 300 : 20, 10 * 60_000);
  if (!limit.ok) return fail("Too many checkouts started. Try again in a few minutes.", 429);

  let body: { blocks?: unknown; returnUrl?: unknown; email?: unknown; billing?: unknown };
  try {
    body = await readJson(request, 4096);
  } catch {
    return fail("Expected a JSON body.", 400);
  }
  if (!validBlocks(body.blocks) || body.blocks < config.minBlocks) {
    return fail(`Choose between ${config.minBlocks} and 100 blocks of 100 GB.`, 400);
  }
  const billing = body.billing === undefined ? "month" : body.billing;
  if (!isBilling(billing) || (billing === "year" && !config.yearlyPriceCents)) return fail("That billing period isn't offered.", 400);
  const returnUrl = cleanReturnUrl(body.returnUrl);
  if (!returnUrl) return fail("The return address must be an https URL.", 400);
  const email = typeof body.email === "string" && EMAIL.test(body.email.trim()) ? body.email.trim() : undefined;

  try {
    return Response.json(await startCheckout(config, { blocks: body.blocks, returnUrl, email, billing }), { status: 201 });
  } catch (error) {
    console.error("[store] checkout failed", error);
    await alert("checkout", `A customer couldn't start paying: ${(error as Error).message}`);
    return fail("Couldn't start the payment just now. Try again later.", 502);
  }
}
