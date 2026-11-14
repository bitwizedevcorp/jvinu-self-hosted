import { actorOf, recordActivity } from "@/app/lib/server/activity";
import { getConnection } from "@/app/lib/server/connections";
import { exportSql, type ExportFormat } from "@/app/lib/server/data/sql";
import { driverFor } from "@/app/lib/server/drivers";
import { isTaken } from "@/app/lib/server/drivers/types";
import { guardConnection } from "@/app/lib/server/guard";
import { admitWrite, refusalResponse } from "@/app/lib/server/write-admission";
import { fail, handle, readJson, tooLarge } from "@/app/lib/server/http";

const FORMATS: ExportFormat[] = ["csv", "parquet", "json"];

/**
 * POST { sql, format, targetConnectionId, key } — runs the query and saves its whole result
 * as CSV, Parquet or JSON Lines at `key` on the target connection (this one or another).
 * Nothing is overwritten: an existing object at `key` stops it.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/connections/[id]/sql/export">) {
  const guarded = await guardConnection(request, ctx.params, { mutating: true });
  if (guarded instanceof Response) return guarded;
  let body: { sql?: unknown; format?: unknown; targetConnectionId?: unknown; key?: unknown; acknowledgeTables?: unknown };
  try {
    body = await readJson(request, 256 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return fail("Expected a JSON body.", 400);
  }
  const format = FORMATS.find((candidate) => candidate === body.format);
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const name = key.split("/").pop() ?? "";
  if (typeof body.sql !== "string") return fail("Expected a query.", 400);
  if (!format) return fail("Save as csv, parquet or json.", 400);
  if (!key || key.startsWith("/") || key.endsWith("/") || Buffer.byteLength(key) > 1024 || name === "." || name === "..") {
    return fail("Invalid file name.", 400);
  }

  try {
    const targetId = typeof body.targetConnectionId === "string" ? body.targetConnectionId : guarded.connection.id;
    const target = targetId === guarded.connection.id ? guarded.connection : await getConnection(targetId);
    if (!target) return fail("No such connection to save to.", 404);
    const targetDriver = driverFor(target);
    const refused = await admitWrite({
      connection: target,
      kind: "upload",
      tables: { driver: targetDriver, items: [], destination: key.slice(0, key.lastIndexOf("/") + 1), acknowledged: body.acknowledgeTables === true },
    });
    if (refused) return refusalResponse(refused);
    if (await isTaken(targetDriver, key)) return fail(`Something named “${name}” is already there.`, 409);
    const saved = await exportSql(driverFor(guarded.connection), body.sql, guarded.connection.bucket, format, targetDriver, key);
    await recordActivity({
      connectionId: target.id,
      actor: actorOf(guarded.user),
      action: "exported",
      target: key,
      size: saved.bytes,
      detail: { format, rows: saved.rows, ...(target.id !== guarded.connection.id ? { connection: guarded.connection.name } : {}) },
    });
    return Response.json({ ...saved, connectionId: target.id, key }, { status: 201 });
  } catch (error) {
    return handle(error);
  }
}
