import { driverFor } from "@/app/lib/server/drivers";
import { guardConnection } from "@/app/lib/server/guard";
import { fail, handle } from "@/app/lib/server/http";

/** One object's metadata, including how it's encrypted at rest (when the provider says). */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/head">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!key || key.startsWith("/") || key.endsWith("/") || Buffer.byteLength(key) > 1024) return fail("Invalid key.", 400);
  try {
    const driver = driverFor(guarded.connection);
    if (!driver.head) return Response.json({ encryption: { state: "unknown" } });
    return Response.json(await driver.head(key));
  } catch (error) {
    return handle(error);
  }
}
