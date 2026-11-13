import { requireUser } from "@/app/lib/server/auth";
import { billingPortal } from "@/app/lib/server/storage-plan";
import { dashboardUrl, planFailure } from "@/app/lib/server/storage-plan-http";

/** A billing page for the plan: change its size, update the card, see invoices, cancel. */
export async function POST(request: Request) {
  const user = await requireUser(request, { mutating: true, admin: true });
  if (user instanceof Response) return user;
  try {
    const back = new URL(dashboardUrl(request));
    back.searchParams.set("storage", "managed");
    return Response.json({ url: await billingPortal(back.href) });
  } catch (error) {
    return planFailure(error);
  }
}
