import { runSql } from "@/app/lib/server/data/sql";
import { driverFor } from "@/app/lib/server/drivers";
import { guardConnection } from "@/app/lib/server/guard";
import { fail, handle, readJson, tooLarge } from "@/app/lib/server/http";

/**
 * POST { sql } — runs one read-only query over files in this connection's bucket and
 * returns the first 1,000 rows. File paths in the query start at the top of the bucket.
 * Reading needs no write access, so read-only connections can be queried too.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/connections/[id]/sql">) {
  const guarded = await guardConnection(request, ctx.params, { mutating: true, demoAllowed: true });
  if (guarded instanceof Response) return guarded;
  let body: { sql?: unknown };
  try {
    body = await readJson(request, 256 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return fail("Expected a JSON body.", 400);
  }
  if (typeof body.sql !== "string") return fail("Expected a query.", 400);
  try {
    return Response.json(await runSql(driverFor(guarded.connection), body.sql, guarded.connection.bucket));
  } catch (error) {
    return handle(error);
  }
}
