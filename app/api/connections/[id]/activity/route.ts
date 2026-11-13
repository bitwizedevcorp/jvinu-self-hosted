import { listActivity, parseCursor } from "@/app/lib/server/activity";
import { guardConnection } from "@/app/lib/server/guard";
import { cleanPrefix, fail, handle } from "@/app/lib/server/http";

/**
 * GET ?prefix=a/b/&before=… — this connection's history, newest first, a page at a time.
 * With a prefix, only what happened in that folder (or below it, or was put there).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/activity">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  const params = new URL(request.url).searchParams;
  const prefix = cleanPrefix(params.get("prefix"));
  if (prefix === null) return fail("Invalid folder.", 400);
  const raw = params.get("before");
  const before = raw ? parseCursor(raw) : null;
  if (raw && !before) return fail("Invalid page.", 400);
  try {
    return Response.json(await listActivity(guarded.connection.id, guarded.user.id, { prefix, before }));
  } catch (error) {
    return handle(error);
  }
}
