import { actorOf, recordActivity } from "@/app/lib/server/activity";
import { tablesTouched } from "@/app/lib/server/data/lake";
import { driverFor } from "@/app/lib/server/drivers";
import { managedBlocks } from "@/app/lib/server/bundled-storage";
import { guardConnection } from "@/app/lib/server/guard";
import { cleanPrefix, fail, handle, readJson, tooLarge } from "@/app/lib/server/http";
import { startJob } from "@/app/lib/server/jobs";
import { prepareOperation, type Operation, type OperationItem } from "@/app/lib/server/operations";
import type { MetadataChange, MetadataSupport } from "@/app/lib/server/drivers/types";

const validKey = (key: unknown): key is string =>
  typeof key === "string" && key.length > 0 && !key.startsWith("/") && Buffer.byteLength(key) <= 1024;

/** A metadata edit from the page, checked against what this connection can change. */
function metadataChange(raw: unknown, support: MetadataSupport | undefined): MetadataChange | string {
  if (!support) return "This connection can't change object metadata.";
  if (!raw || typeof raw !== "object") return "Say what to change.";
  const input = raw as Record<string, unknown>;
  const change: MetadataChange = {};
  const text = (field: "contentType" | "cacheControl" | "contentDisposition", label: string, max: number) => {
    const value = input[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length > max || /[\r\n]/.test(value)) return `Invalid ${label}.`;
    if (!support[field]) return `This connection can't change ${label}.`;
    change[field] = value.trim();
    return null;
  };
  const problem =
    text("contentType", "Content-Type", 200) ?? text("cacheControl", "Cache-Control", 500) ?? text("contentDisposition", "Content-Disposition", 500);
  if (problem) return problem;
  if (change.contentType !== undefined && !/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(change.contentType)) return "Content-Type looks like type/subtype, e.g. text/html.";
  if (input.storageClass !== undefined && input.storageClass !== null) {
    if (typeof input.storageClass !== "string" || !support.storageClasses.includes(input.storageClass)) return "That storage class isn't offered here.";
    change.storageClass = input.storageClass;
  }
  if (input.tags !== undefined && input.tags !== null) {
    if (!support.tags) return "This connection can't tag objects.";
    if (typeof input.tags !== "object" || Array.isArray(input.tags)) return "Invalid tags.";
    const entries = Object.entries(input.tags as Record<string, unknown>);
    if (entries.length > 10) return "At most 10 tags per object.";
    for (const [key, value] of entries) {
      if (!key || key.length > 128 || typeof value !== "string" || value.length > 256) return `Invalid tag “${key}”.`;
    }
    change.tags = Object.fromEntries(entries) as Record<string, string>;
  }
  if (!Object.keys(change).length) return "Nothing to change.";
  return change;
}

const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

/**
 * Delete, copy, move or rename files and folders. Quick checks (names, conflicts) happen
 * here and fail at once; the work itself starts as a background job — 202 with the job.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/connections/[id]/operations">) {
  const guarded = await guardConnection(request, ctx.params, { write: true });
  if (guarded instanceof Response) return guarded;

  let body: { op?: unknown; items?: unknown; destination?: unknown; name?: unknown; acknowledgeTables?: unknown; change?: unknown };
  try {
    body = await readJson(request, 16 * 1024 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return fail("Expected a JSON body.", 400);
  }

  const raw = Array.isArray(body.items) ? body.items : [];
  const items: OperationItem[] = [];
  for (const entry of raw) {
    const { key, kind } = (entry ?? {}) as { key?: unknown; kind?: unknown };
    if (!validKey(key) || (kind !== "file" && kind !== "folder")) return fail("Invalid item.", 400);
    if (kind === "folder" ? !key.endsWith("/") : key.endsWith("/")) return fail("Folder keys end in “/”; file keys don't.", 400);
    items.push({ key, kind });
  }
  if (!items.length) return fail("Nothing selected.", 400);
  if (items.length > 1000) return fail("Select at most 1,000 items at once.", 400);

  let operation: Operation;
  let label: string;
  const what = items.length === 1 ? `“${items[0].key.replace(/\/$/, "").split("/").pop()}”` : plural(items.length, "item");
  switch (body.op) {
    case "delete":
      operation = { op: "delete", items };
      label = `Deleting ${what}`;
      break;
    case "copy":
    case "move": {
      const destination = cleanPrefix(typeof body.destination === "string" ? body.destination : null);
      if (destination === null) return fail("Invalid destination folder.", 400);
      operation = { op: body.op, items, destination };
      label = `${body.op === "copy" ? "Copying" : "Moving"} ${what} to ${destination || "the top level"}`;
      break;
    }
    case "rename":
      if (items.length !== 1) return fail("Rename one item at a time.", 400);
      operation = { op: "rename", items: [items[0]], name: typeof body.name === "string" ? body.name.trim() : "" };
      label = `Renaming ${what}`;
      break;
    case "metadata": {
      const driver = driverFor(guarded.connection);
      const change = metadataChange(body.change, driver.metadataSupport);
      if (typeof change === "string") return fail(change, 400);
      operation = { op: "metadata", items, change };
      label = `Updating metadata of ${what}`;
      break;
    }
    default:
      return fail("Unknown operation.", 400);
  }

  // Copies add data; on managed storage they stop at the same line uploads do.
  if (operation.op === "copy" && guarded.connection.managed) {
    const blocked = await managedBlocks(guarded.connection);
    if (blocked) return fail(blocked, 507);
  }

  try {
    const driver = driverFor(guarded.connection);
    // Files inside a Delta, Iceberg or Hudi table belong to the engine that wrote them: say so
    // first, and go ahead only once the person has seen what breaks.
    if (body.acknowledgeTables !== true && operation.op !== "metadata") {
      const tables = await tablesTouched(
        driver,
        guarded.connection.id,
        operation.op === "rename" ? "move" : operation.op,
        operation.items,
        operation.op === "copy" || operation.op === "move" ? operation.destination : undefined,
      );
      if (tables.length) {
        return Response.json(
          { error: tables.map((change) => change.message).join(" "), code: "lake-table", tables },
          { status: 409 },
        );
      }
    }
    const prepared = await prepareOperation(driver, operation);
    const job = await startJob(guarded.user.id, guarded.connection, prepared, label);
    // Moving something to where it already is does nothing, and isn't history.
    if (prepared.pairs.length) {
      const PAST = { delete: "deleted", copy: "copied", move: "moved", rename: "renamed", metadata: "metadata" } as const;
      await recordActivity({
        connectionId: guarded.connection.id,
        actor: actorOf(guarded.user),
        action: PAST[operation.op],
        items: prepared.pairs.map(({ item }) => item.key),
        destination: operation.op === "rename" ? prepared.pairs[0].to : operation.op === "copy" || operation.op === "move" ? operation.destination : null,
        jobId: job.id,
        detail: operation.op === "metadata" ? { change: operation.change } : undefined,
      });
    }
    return Response.json({ job }, { status: 202 });
  } catch (error) {
    return handle(error);
  }
}
