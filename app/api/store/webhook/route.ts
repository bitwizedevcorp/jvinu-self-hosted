import { StorageUserError } from "@/app/lib/server/drivers/types";
import { fail, readBody } from "@/app/lib/server/http";
import { alert } from "@/app/lib/server/store/notify";
import { handleEvent, sellerConfig } from "@/app/lib/server/store/seller";
import { verifyWebhook } from "@/app/lib/server/store/stripe";

/**
 * Stripe's webhook. Register <public URL>/api/store/webhook for checkout.session.completed,
 * customer.subscription.created/updated/deleted and invoice.paid/payment_failed.
 */
export async function POST(request: Request) {
  const config = sellerConfig();
  if (!config) return fail("This server doesn't sell storage.", 404);
  // Anyone can post here: stop reading past 1 MB rather than buffering whatever is sent.
  let raw: string;
  try {
    raw = new TextDecoder().decode(await readBody(request, 1024 * 1024));
  } catch (error) {
    if (error instanceof StorageUserError) return fail(error.message, error.status);
    throw error;
  }
  if (!verifyWebhook(raw, request.headers.get("stripe-signature"), config.webhookSecret)) {
    return fail("Bad signature.", 400);
  }
  try {
    await handleEvent(config, JSON.parse(raw));
    return Response.json({ received: true });
  } catch (error) {
    // A 500 makes Stripe deliver it again later.
    console.error("[store] webhook failed", error);
    await alert("webhook", `A Stripe event couldn't be processed (Stripe will retry): ${(error as Error).message}`);
    return fail("Couldn't process that event.", 500);
  }
}
