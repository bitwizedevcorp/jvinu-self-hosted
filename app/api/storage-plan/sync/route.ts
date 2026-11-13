import { requireUser } from "@/app/lib/server/auth";
import { planView, syncPlan } from "@/app/lib/server/storage-plan";
import { planFailure } from "@/app/lib/server/storage-plan-http";

/** Asks the seller now (after paying, or after changing the plan) and returns the result. */
export async function POST(request: Request) {
  const user = await requireUser(request, { mutating: true, admin: true });
  if (user instanceof Response) return user;
  try {
    await syncPlan({ force: true });
    return Response.json(await planView());
  } catch (error) {
    return planFailure(error);
  }
}
