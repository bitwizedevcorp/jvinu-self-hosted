import { actorOf, recordActivity } from "@/app/lib/server/activity";
import { managedBlocks } from "@/app/lib/server/bundled-storage";
import { tablesTouched } from "@/app/lib/server/data/lake";
import { driverFor } from "@/app/lib/server/drivers";
import { saveItem } from "@/app/lib/server/user-items";
import { guardConnection } from "@/app/lib/server/guard";
import { fail, handle } from "@/app/lib/server/http";

/** Default 5 GB; raise with JVINU_MAX_UPLOAD_MB. Bodies stream — size costs no memory. */
const maxBytes = () => Number(process.env.JVINU_MAX_UPLOAD_MB || 5120) * 1024 * 1024;

/**
 * PUT /api/connections/:id/upload?key=folder/name.ext with the raw file as the body.
 * The body is streamed straight into the cloud's multipart/block/resumable upload.
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/connections/[id]/upload">) {
  const guarded = await guardConnection(request, ctx.params, { write: true });
  if (guarded instanceof Response) return guarded;

  const key = new URL(request.url).searchParams.get("key") ?? "";
  const name = key.split("/").pop() ?? "";
  if (!key || key.startsWith("/") || key.endsWith("/") || Buffer.byteLength(key) > 1024 || name === "." || name === "..") {
    return fail("Invalid file name.", 400);
  }
  const length = request.headers.get("content-length");
  const size = length === null ? undefined : Number(length);
  if (size !== undefined && (!Number.isFinite(size) || size < 0)) return fail("Invalid Content-Length.", 400);
  if (size !== undefined && size > maxBytes()) {
    return fail(`That file is over the ${Math.round(maxBytes() / 1024 / 1024).toLocaleString("en-US")} MB limit set for this server.`, 413);
  }
  if (!request.body) return fail("No file was sent.", 400);
  if (guarded.connection.managed) {
    const blocked = await managedBlocks(guarded.connection, size ?? 0);
    if (blocked) return fail(blocked, 507);
  }

  try {
    const driver = driverFor(guarded.connection);
    // A file dropped into a table's folder isn't part of the table; the next VACUUM may delete it.
    if (new URL(request.url).searchParams.get("acknowledgeTables") !== "1") {
      const tables = await tablesTouched(driver, guarded.connection.id, "upload", [], key.slice(0, key.lastIndexOf("/") + 1));
      if (tables.length) {
        return Response.json({ error: tables[0].message, code: "lake-table", tables }, { status: 409 });
      }
    }
    // The upload forgets the connection's scans and found tables (connection-changes.ts).
    await driver.upload(key, request.body, size, request.headers.get("content-type") || undefined);
    await saveItem(guarded.user.id, "recent", guarded.connection.id, key, {
      kind: "file",
      size: size ?? null,
      lastModified: new Date().toISOString(),
    });
    await recordActivity({ connectionId: guarded.connection.id, actor: actorOf(guarded.user), action: "uploaded", target: key, size });
    return Response.json({ uploaded: key }, { status: 201 });
  } catch (error) {
    return handle(error);
  }
}
