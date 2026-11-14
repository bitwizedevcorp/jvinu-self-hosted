import { actorOf, recordActivity } from "@/app/lib/server/activity";
import { driverFor } from "@/app/lib/server/drivers";
import { guardConnection } from "@/app/lib/server/guard";
import { fail, handle, readJson, tooLarge } from "@/app/lib/server/http";
import { issueTicket, planZip, redeemTicket, zipDownload, type ZipItem, type ZipPlan } from "@/app/lib/server/zip-plan";

/** A ticket can be fetched again (a retried download); the history has it once. */
const recorded = new WeakSet<ZipPlan>();

/**
 * Download a folder or a selection as one zip, in two steps:
 * POST { items, base, name } works out what's in it — counts, size, storage classes — and
 * refuses past the limits; it answers with a ticket. GET ?ticket=… then streams the archive,
 * which the browser saves like any download. Reading only, so read-only connections can too.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/connections/[id]/zip">) {
  try {
    const guarded = await guardConnection(request, ctx.params, { mutating: true, demoAllowed: true });
    if (guarded instanceof Response) return guarded;
    const { user, connection } = guarded;
    let body: { items?: unknown; base?: unknown; name?: unknown };
    try {
      body = await readJson(request, 16 * 1024 * 1024);
    } catch (error) {
      if (tooLarge(error)) return fail("That request is too large.", 413);
      return fail("Expected a JSON body.", 400);
    }
    const items = Array.isArray(body.items)
      ? body.items.filter(
          (item): item is ZipItem =>
            Boolean(item) && typeof item.key === "string" && Buffer.byteLength(item.key) <= 1024 && (item.kind === "file" || item.kind === "folder"),
        )
      : [];
    if (!Array.isArray(body.items) || items.length !== body.items.length) return fail("Invalid selection.", 400);
    const plan = await planZip({
      connection,
      driver: driverFor(connection),
      userId: user.id,
      items,
      base: typeof body.base === "string" ? body.base : "",
      name: typeof body.name === "string" ? body.name : "download",
    });
    const ticket = issueTicket(plan);
    return Response.json({
      url: `/api/connections/${connection.id}/zip?ticket=${ticket}`,
      name: plan.name,
      files: plan.files.length,
      bytes: plan.bytes,
      byClass: plan.byClass,
      archived: plan.archived,
    });
  } catch (error) {
    return handle(error);
  }
}

export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/zip">) {
  try {
    const guarded = await guardConnection(request, ctx.params);
    if (guarded instanceof Response) return guarded;
    const plan = redeemTicket(new URL(request.url).searchParams.get("ticket") ?? "", guarded.user.id, guarded.connection.id);
    if (!plan) return fail("This download link has expired. Start the download again.", 410);
    if (!recorded.has(plan)) {
      recorded.add(plan);
      await recordActivity({
        connectionId: guarded.connection.id,
        actor: actorOf(guarded.user),
        action: "zipped",
        items: plan.items,
        folder: plan.base,
        size: plan.bytes,
        detail: { name: plan.name, files: plan.files.length },
      });
    }

    const { stream, length } = zipDownload(plan, driverFor(guarded.connection));
    const headers = new Headers({
      "content-type": "application/zip",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(plan.name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    if (length !== null) headers.set("content-length", String(length));
    return new Response(stream, { headers });
  } catch (error) {
    return handle(error);
  }
}
