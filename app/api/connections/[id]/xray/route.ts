import { guardConnection } from "@/app/lib/server/guard";
import { handle } from "@/app/lib/server/http";
import { xrayFor } from "@/app/lib/server/xray";

/**
 * Storage X-Ray: cost by folder, hidden waste, public access and possible leaked secrets
 * for one connection. Reads only; `refresh=1` scans again instead of using the last report.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/xray">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  try {
    return Response.json(await xrayFor(guarded.connection, new URL(request.url).searchParams.get("refresh") === "1"));
  } catch (error) {
    return handle(error);
  }
}
