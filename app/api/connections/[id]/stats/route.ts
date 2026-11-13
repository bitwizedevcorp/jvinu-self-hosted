import { guardConnection } from "@/app/lib/server/guard";
import { driverFor } from "@/app/lib/server/drivers";
import { cleanPrefix, fail, handle } from "@/app/lib/server/http";

/** Object count, total bytes and newest change under a prefix, at every depth. */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/stats">) {
  try {
    const guarded = await guardConnection(request, ctx.params);
    if (guarded instanceof Response) return guarded;
    const { connection } = guarded;
    const prefix = cleanPrefix(new URL(request.url).searchParams.get("prefix"));
    if (prefix === null || prefix === "") return fail("Give a folder prefix ending in “/”.", 400);
    return Response.json(await driverFor(connection).stats(prefix));
  } catch (error) {
    return handle(error);
  }
}
