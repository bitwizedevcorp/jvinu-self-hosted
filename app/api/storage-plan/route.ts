import { requireUser } from "@/app/lib/server/auth";
import { fail, readJson } from "@/app/lib/server/http";
import { beginCheckout, planView } from "@/app/lib/server/storage-plan";
import { dashboardUrl, planFailure } from "@/app/lib/server/storage-plan-http";
import { isBilling, validBlocks } from "@/app/lib/storage-plan";

/** This server's storage plan: price, status, quota and usage. */
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  try {
    return Response.json(await planView());
  } catch (error) {
    return planFailure(error);
  }
}

/** Starts buying storage: returns the payment page to send the person to. */
export async function POST(request: Request) {
  const user = await requireUser(request, { mutating: true, admin: true });
  if (user instanceof Response) return user;
  let body: { blocks?: unknown; billing?: unknown };
  try {
    body = await readJson(request, 1024);
  } catch {
    return fail("Expected a JSON body.", 400);
  }
  if (!validBlocks(body.blocks)) return fail("Choose between 100 GB and 10 TB, in steps of 100 GB.", 400);
  const billing = body.billing ?? "month";
  if (!isBilling(billing)) return fail("Billing is monthly or yearly.", 400);
  try {
    return Response.json({ checkoutUrl: await beginCheckout(body.blocks, dashboardUrl(request), user.email, billing) });
  } catch (error) {
    return planFailure(error);
  }
}
