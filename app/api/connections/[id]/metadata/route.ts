import { driverFor } from "@/app/lib/server/drivers";
import { guardConnection } from "@/app/lib/server/guard";

/** GET — what this connection can change on its objects: headers, tags, which storage classes. */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/metadata">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  const support = driverFor(guarded.connection).metadataSupport ?? null;
  return Response.json({ support: guarded.connection.readOnly ? null : support });
}
