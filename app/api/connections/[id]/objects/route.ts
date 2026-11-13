import { actorOf, recordActivity } from "@/app/lib/server/activity";
import { driverFor } from "@/app/lib/server/drivers";
import { forgetInventory } from "@/app/lib/server/inventory";
import { guardConnection } from "@/app/lib/server/guard";
import { cleanPrefix, fail, handle, readJson } from "@/app/lib/server/http";

/** One page of a folder level; pass `token` from the previous page for the next. */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/objects">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  const params = new URL(request.url).searchParams;
  const prefix = cleanPrefix(params.get("prefix"));
  if (prefix === null) return fail("Invalid prefix.", 400);
  const token = params.get("token") ?? undefined;
  if (token && token.length > 4096) return fail("Invalid page token.", 400);
  try {
    return Response.json(await driverFor(guarded.connection).list(prefix, token));
  } catch (error) {
    return handle(error);
  }
}

/** { prefix, folder } → create a folder (uploads go to /upload). */
export async function POST(request: Request, ctx: RouteContext<"/api/connections/[id]/objects">) {
  const guarded = await guardConnection(request, ctx.params, { write: true });
  if (guarded instanceof Response) return guarded;
  try {
    const body = (await readJson(request, 16 * 1024)) as { prefix?: string; folder?: string };
    const prefix = cleanPrefix(body.prefix ?? "");
    const folder = (body.folder ?? "").trim().replace(/\/+$/, "");
    if (prefix === null) return fail("Invalid prefix.", 400);
    if (!folder || folder.includes("/") || folder === "." || folder === "..")
      return fail("Folder names can't be empty or contain “/”.", 400);
    // Object stores have no folders: a zero-byte object ending in "/" is the convention.
    await driverFor(guarded.connection).write(`${prefix}${folder}/`, new Uint8Array());
    forgetInventory(guarded.connection.id);
    await recordActivity({ connectionId: guarded.connection.id, actor: actorOf(guarded.user), action: "folder-created", target: `${prefix}${folder}/` });
    return Response.json({ created: `${prefix}${folder}/` }, { status: 201 });
  } catch (error) {
    return handle(error);
  }
}
