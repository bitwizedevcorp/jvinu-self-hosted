import { actorOf, recordActivity } from "@/app/lib/server/activity";
import { managedBlocks } from "@/app/lib/server/bundled-storage";
import { getConnection } from "@/app/lib/server/connections";
import { tablesTouched } from "@/app/lib/server/data/lake";
import { driverFor } from "@/app/lib/server/drivers";
import { guardConnection } from "@/app/lib/server/guard";
import { cleanPrefix, fail, handle, readJson, tooLarge } from "@/app/lib/server/http";
import { startTask } from "@/app/lib/server/jobs";
import type { OperationItem } from "@/app/lib/server/operations";
import { pairsFor, planTransfer, runTransfer, TRANSFER_LIMIT, type TransferPair } from "@/app/lib/server/transfer";

const validKey = (key: unknown): key is string =>
  typeof key === "string" && key.length > 0 && !key.startsWith("/") && Buffer.byteLength(key) <= 1024;

/**
 * Copies from this connection to another, as a background job (202 with the job).
 *  { targetConnectionId, items, destination } — selected files and folders into a folder;
 *    nothing already there is overwritten.
 *  { targetConnectionId, paths, sourcePrefix, targetPrefix } — files a comparison found
 *    missing or different, by their path inside each folder; these replace what's there.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/connections/[id]/transfer">) {
  // Reading is all this side needs: a read-only connection can be copied from.
  const guarded = await guardConnection(request, ctx.params, { mutating: true });
  if (guarded instanceof Response) return guarded;
  let body: {
    targetConnectionId?: unknown;
    items?: unknown;
    destination?: unknown;
    paths?: unknown;
    sourcePrefix?: unknown;
    targetPrefix?: unknown;
    acknowledgeTables?: unknown;
  };
  try {
    body = await readJson(request, 16 * 1024 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return fail("Expected a JSON body.", 400);
  }

  try {
    const target = typeof body.targetConnectionId === "string" ? await getConnection(body.targetConnectionId) : undefined;
    if (!target) return fail("Choose a connection to copy to.", 400);
    if (target.readOnly) return fail(`“${target.name}” is read-only. Turn that off in its settings to copy there.`, 403);
    if (target.managed) {
      const blocked = await managedBlocks(target);
      if (blocked) return fail(blocked, 507);
    }
    const source = driverFor(guarded.connection);
    const targetDriver = driverFor(target);

    let pairs: TransferPair[];
    let landing: string;
    let label: string;
    /** For the history: what was chosen here (items, or files a comparison found), and where each lands. */
    let chosen: string[];
    let arrived: string[];
    if (Array.isArray(body.paths)) {
      const sourcePrefix = cleanPrefix(typeof body.sourcePrefix === "string" ? body.sourcePrefix : null);
      const targetPrefix = cleanPrefix(typeof body.targetPrefix === "string" ? body.targetPrefix : null);
      if (sourcePrefix === null || targetPrefix === null) return fail("Invalid folder.", 400);
      if (!body.paths.length) return fail("Nothing to copy.", 400);
      if (body.paths.length > TRANSFER_LIMIT) return fail(`At most ${TRANSFER_LIMIT.toLocaleString("en-US")} files at once.`, 413);
      if (!body.paths.every((path) => validKey(path) && !String(path).split("/").includes(".."))) return fail("Invalid file path.", 400);
      pairs = pairsFor(body.paths as string[], sourcePrefix, targetPrefix);
      landing = targetPrefix;
      chosen = pairs.map((pair) => pair.from);
      arrived = pairs.map((pair) => pair.to);
      label = `Copying ${pairs.length.toLocaleString("en-US")} file${pairs.length === 1 ? "" : "s"} to ${target.name}`;
    } else {
      const destination = cleanPrefix(typeof body.destination === "string" ? body.destination : null);
      if (destination === null) return fail("Invalid destination folder.", 400);
      const items: OperationItem[] = [];
      for (const entry of Array.isArray(body.items) ? body.items : []) {
        const { key, kind } = (entry ?? {}) as { key?: unknown; kind?: unknown };
        if (!validKey(key) || (kind !== "file" && kind !== "folder")) return fail("Invalid item.", 400);
        if (kind === "folder" ? !key.endsWith("/") : key.endsWith("/")) return fail("Folder keys end in “/”; file keys don't.", 400);
        items.push({ key, kind });
      }
      if (!items.length) return fail("Nothing selected.", 400);
      if (items.length > 1000) return fail("Select at most 1,000 items at once.", 400);
      pairs = await planTransfer(source, targetDriver, items, destination);
      landing = destination;
      chosen = items.map((item) => item.key);
      arrived = items.map((item) => destination + item.key.slice(item.key.replace(/\/$/, "").lastIndexOf("/") + 1));
      const what = items.length === 1 ? `“${items[0].key.replace(/\/$/, "").split("/").pop()}”` : `${items.length} items`;
      label = `Copying ${what} to ${target.name}${destination ? `/${destination}` : ""}`;
    }

    if (body.acknowledgeTables !== true) {
      const tables = await tablesTouched(targetDriver, target.id, "copy", [], landing);
      if (tables.length) {
        return Response.json({ error: tables.map((change) => change.message).join(" "), code: "lake-table", tables }, { status: 409 });
      }
    }

    const job = await startTask(guarded.user.id, guarded.connection.id, "transfer", label, async (report, cancelled) => {
      // Each write to the target forgets what was remembered about it (connection-changes.ts).
      return runTransfer(source, targetDriver, pairs, report, cancelled);
    });
    // On both sides: what left this connection, and what arrived on the other.
    const actor = actorOf(guarded.user);
    await recordActivity({
      connectionId: guarded.connection.id,
      actor,
      action: "copied-out",
      items: chosen,
      destination: landing,
      jobId: job.id,
      detail: { connectionId: target.id, connection: target.name },
    });
    await recordActivity({
      connectionId: target.id,
      actor,
      action: "copied-in",
      items: arrived,
      folder: landing,
      jobId: job.id,
      detail: { connectionId: guarded.connection.id, connection: guarded.connection.name },
    });
    return Response.json({ job, targetConnectionId: target.id }, { status: 202 });
  } catch (error) {
    return handle(error);
  }
}
