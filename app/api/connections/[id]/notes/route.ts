import { actorOf, recordActivity } from "@/app/lib/server/activity";
import { guardConnection } from "@/app/lib/server/guard";
import { cleanPrefix, fail, handle, readJson, tooLarge } from "@/app/lib/server/http";
import { getNote, NOTE_LIMIT, notesUnder, setNote } from "@/app/lib/server/notes";

/**
 * GET ?prefix=a/b/ — the note on this folder, and which folders right inside it have one.
 * Notes live on this server, not in the bucket, so read-only connections can have them too.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/notes">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  const prefix = cleanPrefix(new URL(request.url).searchParams.get("prefix"));
  if (prefix === null) return fail("Invalid folder.", 400);
  try {
    const all = await notesUnder(guarded.connection.id, prefix);
    const children = all
      .filter((note) => note.prefix !== prefix && !note.prefix.slice(prefix.length, -1).includes("/"))
      .map((note) => note.prefix);
    return Response.json({ note: all.find((note) => note.prefix === prefix) ?? (await getNote(guarded.connection.id, prefix)), children });
  } catch (error) {
    return handle(error);
  }
}

/** PUT { prefix, body } — write the folder's note; an empty body removes it. */
export async function PUT(request: Request, ctx: RouteContext<"/api/connections/[id]/notes">) {
  const guarded = await guardConnection(request, ctx.params, { mutating: true });
  if (guarded instanceof Response) return guarded;
  let body: { prefix?: unknown; body?: unknown };
  try {
    body = await readJson(request, 256 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return fail("Expected a JSON body.", 400);
  }
  const prefix = cleanPrefix(typeof body.prefix === "string" ? body.prefix : null);
  if (prefix === null) return fail("Invalid folder.", 400);
  if (typeof body.body !== "string") return fail("Expected the note's text.", 400);
  if (body.body.length > NOTE_LIMIT) return fail(`Keep notes under ${NOTE_LIMIT.toLocaleString("en-US")} characters.`, 400);
  try {
    const note = await setNote(guarded.connection.id, prefix, body.body, guarded.user.name);
    await recordActivity({
      connectionId: guarded.connection.id,
      actor: actorOf(guarded.user),
      action: "note",
      target: prefix,
      folder: prefix,
      detail: note ? {} : { removed: true },
    });
    return Response.json({ note });
  } catch (error) {
    return handle(error);
  }
}
