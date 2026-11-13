import { requireUser } from "@/app/lib/server/auth";
import { handle } from "@/app/lib/server/http";
import { listJobs } from "@/app/lib/server/jobs";

/** This user's background jobs from the last day. */
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  try {
    return Response.json({ jobs: await listJobs(user.id) });
  } catch (error) {
    return handle(error);
  }
}
