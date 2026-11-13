import { db } from "@/app/lib/server/db";

/** Liveness + database check for load balancers and Docker. Reveals nothing sensitive. */
export async function GET() {
  try {
    const database = await db();
    await database.get(`select 1 as ok`);
    return Response.json({ status: "ok", database: database.kind }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "error", database: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
