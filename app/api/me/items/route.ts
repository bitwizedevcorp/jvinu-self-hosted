import { demoMode, requireUser } from "@/app/lib/server/auth";
import { getConnection } from "@/app/lib/server/connections";
import { fail, handle, readJson, tooLarge } from "@/app/lib/server/http";
import { ITEM_KINDS, listItems, removeItem, saveItem, type ItemKind, type ItemMeta } from "@/app/lib/server/user-items";

/** This user's starred objects, shared links and recent files — and the team's pins. */
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  try {
    return Response.json({ items: await listItems(user.id) });
  } catch (error) {
    return handle(error);
  }
}

const text = (value: unknown, max: number) => (typeof value === "string" && value.length <= max ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/** { kind, connectionId, key, on, meta } — star or unstar, record a share or a visit. */
export async function POST(request: Request) {
  const user = await requireUser(request, { mutating: true, demoAllowed: true });
  if (user instanceof Response) return user;
  let body: { kind?: unknown; connectionId?: unknown; key?: unknown; on?: unknown; meta?: Record<string, unknown> };
  try {
    body = await readJson(request, 64 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return fail("Expected a JSON body.", 400);
  }
  const kind = ITEM_KINDS.find((candidate) => candidate === body.kind) as ItemKind | undefined;
  const key = text(body.key, 1024);
  const connectionId = text(body.connectionId, 64);
  if (!kind || !key || key.startsWith("/") || !connectionId) return fail("Invalid item.", 400);
  // Everyone on the demo is the same visitor: stars and recents are theirs, team pins aren't.
  if (demoMode() && (kind === "team" || kind === "shared")) return fail("This is a read-only demo — install jvinu to pin for a team.", 403);

  try {
    if (!(await getConnection(connectionId))) return fail("No such connection.", 404);
    if (body.on === false) {
      await removeItem(user.id, kind, connectionId, key);
      return Response.json({ ok: true });
    }
    const raw = body.meta ?? {};
    const meta: ItemMeta = {
      kind: key.endsWith("/") ? "folder" : "file",
      size: num(raw.size),
      lastModified: text(raw.lastModified, 40),
      storageClass: text(raw.storageClass, 64),
      etag: text(raw.etag, 200),
      expiresAt: kind === "shared" ? text(raw.expiresAt, 40) : null,
      // Who pinned it is the server's to say, not the page's.
      by: kind === "team" ? user.name : null,
    };
    await saveItem(user.id, kind, connectionId, key, meta);
    return Response.json({ ok: true });
  } catch (error) {
    return handle(error);
  }
}
