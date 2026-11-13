import { previewData, type DataPreview } from "@/app/lib/server/data/preview";
import { driverFor } from "@/app/lib/server/drivers";
import { guardConnection } from "@/app/lib/server/guard";
import { fail, handle } from "@/app/lib/server/http";

/** Previews are a few requests and some decoding: reopening one within a minute or two is free. */
const CACHE_MS = 2 * 60_000;
const cache = new Map<string, { at: number; body: DataPreview }>();

/**
 * GET ?key=folder/file.parquet — a data file's columns, row count and first rows. Parquet,
 * CSV, TSV, JSON, JSON Lines (gzipped text too) and Avro. Add &refresh=1 to skip the cache.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/data">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  const params = new URL(request.url).searchParams;
  const key = params.get("key") ?? "";
  if (!key || key.startsWith("/") || key.endsWith("/") || Buffer.byteLength(key) > 1024) return fail("Invalid key.", 400);

  const id = `${guarded.connection.id}|${key}`;
  const hit = cache.get(id);
  if (hit && params.get("refresh") !== "1" && Date.now() - hit.at < CACHE_MS) return Response.json(hit.body);
  try {
    const body = await previewData(driverFor(guarded.connection), key);
    cache.set(id, { at: Date.now(), body });
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return Response.json(body);
  } catch (error) {
    return handle(error);
  }
}
