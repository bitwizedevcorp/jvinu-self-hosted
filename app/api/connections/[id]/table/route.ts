import { enclosingTable, tableInfo, type LakeTableInfo } from "@/app/lib/server/data/lake";
import { driverFor } from "@/app/lib/server/drivers";
import { guardConnection } from "@/app/lib/server/guard";
import { cleanPrefix, fail, handle } from "@/app/lib/server/http";

const CACHE_MS = 2 * 60_000;
const cache = new Map<string, { at: number; body: LakeTableInfo }>();

/**
 * GET ?prefix=a/b/ — the Delta, Iceberg or Hudi table this folder is, or sits in; null when
 * none. Add &details=1 for what the table holds, read from its own metadata.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/table">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  const params = new URL(request.url).searchParams;
  const prefix = cleanPrefix(params.get("prefix"));
  if (prefix === null) return fail("Invalid prefix.", 400);
  try {
    const driver = driverFor(guarded.connection);
    const table = await enclosingTable(driver, guarded.connection.id, prefix);
    if (!table || params.get("details") !== "1") return Response.json({ table });

    const id = `${guarded.connection.id}|${table.root}`;
    const hit = cache.get(id);
    if (hit && params.get("refresh") !== "1" && Date.now() - hit.at < CACHE_MS) return Response.json({ table: hit.body });
    const body = await tableInfo(driver, table);
    cache.set(id, { at: Date.now(), body });
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return Response.json({ table: body });
  } catch (error) {
    return handle(error);
  }
}
