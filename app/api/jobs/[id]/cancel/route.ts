import { requireUser } from "@/app/lib/server/auth";
import { fail, handle } from "@/app/lib/server/http";
import { cancelJob } from "@/app/lib/server/jobs";

/** Stops a running job after the objects already in flight. */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/cancel">) {
  const user = await requireUser(request, { mutating: true });
  if (user instanceof Response) return user;
  try {
    return (await cancelJob(user.id, (await ctx.params).id)) ? Response.json({ ok: true }) : fail("That job isn't running.", 409);
  } catch (error) {
    return handle(error);
  }
}
