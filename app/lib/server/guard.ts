import "server-only";
import { requireUser, type SessionUser } from "./auth";
import { getConnection, type StoredConnection } from "./connections";

type Guarded = { user: SessionUser; connection: StoredConnection };

/**
 * The common start of every per-connection route: a signed-in user, the connection,
 * and — for writes — a CSRF-checked request on a connection that isn't read-only.
 */
export async function guardConnection(
  request: Request,
  params: Promise<{ id: string }>,
  {
    write = false,
    mutating,
    demoAllowed = false,
    admin = false,
  }: { write?: boolean; mutating?: boolean; demoAllowed?: boolean; admin?: boolean } = {},
): Promise<Guarded | Response> {
  // Writes always need the CSRF check; other mutations (rename, forget) ask for it too.
  const user = await requireUser(request, { mutating: mutating ?? write, demoAllowed: demoAllowed && !write, admin });
  if (user instanceof Response) return user;
  const connection = await getConnection((await params).id);
  if (!connection) return Response.json({ error: "No such connection." }, { status: 404 });
  if (write && connection.readOnly) {
    return Response.json({ error: `“${connection.name}” is read-only. Turn that off in its settings to make changes.` }, { status: 403 });
  }
  return { user, connection };
}
