import { requireUser } from "@/app/lib/server/auth";
import { fail, handle } from "@/app/lib/server/http";
import { getJob } from "@/app/lib/server/jobs";

export async function GET(request: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  try {
    const job = await getJob(user.id, (await ctx.params).id);
    return job ? Response.json({ job }) : fail("No such job.", 404);
  } catch (error) {
    return handle(error);
  }
}
