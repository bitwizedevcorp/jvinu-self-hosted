import { requireUser } from "@/app/lib/server/auth";
import { compareFolders } from "@/app/lib/server/compare";
import { getConnection } from "@/app/lib/server/connections";
import { driverFor } from "@/app/lib/server/drivers";
import { cleanPrefix, fail, handle, readJson, tooLarge } from "@/app/lib/server/http";

/**
 * POST { left: { connectionId, prefix }, right: { connectionId, prefix } } — what each
 * folder has that the other doesn't, and what differs. Read-only on both sides.
 */
export async function POST(request: Request) {
  const user = await requireUser(request, { mutating: true, demoAllowed: true });
  if (user instanceof Response) return user;
  let body: { left?: { connectionId?: unknown; prefix?: unknown }; right?: { connectionId?: unknown; prefix?: unknown } };
  try {
    body = await readJson(request, 16 * 1024 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return fail("Expected a JSON body.", 400);
  }
  try {
    const sides = [];
    for (const side of [body.left, body.right]) {
      const connection = typeof side?.connectionId === "string" ? await getConnection(side.connectionId) : undefined;
      const prefix = cleanPrefix(typeof side?.prefix === "string" ? side.prefix : null);
      if (!connection) return fail("No such connection.", 404);
      if (prefix === null) return fail("Folders end in “/” (or are empty, for the top level).", 400);
      sides.push({ driver: driverFor(connection), prefix, encrypted: Boolean(connection.crypt) });
    }
    const [left, right] = sides;
    if (body.left?.connectionId === body.right?.connectionId && (left.prefix.startsWith(right.prefix) || right.prefix.startsWith(left.prefix))) {
      return fail("Pick two folders where neither is inside the other.", 400);
    }
    return Response.json(await compareFolders(left, right));
  } catch (error) {
    return handle(error);
  }
}
