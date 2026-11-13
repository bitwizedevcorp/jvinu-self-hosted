import { DEMO_USER, endOtherSessions, endSession, listSessions, requireUser } from "@/app/lib/server/auth";
import { fail, handle } from "@/app/lib/server/http";

/** Where the signed-in person is signed in. */
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  // Every demo visitor is the same account: never show one visitor the others.
  if (user.id === DEMO_USER.id) return Response.json({ sessions: [] });
  try {
    return Response.json({ sessions: await listSessions(user.id) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handle(error);
  }
}

/** ?id=<handle> signs out that device; ?id=others signs out every device but this one. */
export async function DELETE(request: Request) {
  const user = await requireUser(request, { mutating: true });
  if (user instanceof Response) return user;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  try {
    if (id === "others") return Response.json({ signedOut: await endOtherSessions(user.id) });
    return (await endSession(user.id, id)) ? new Response(null, { status: 204 }) : fail("No such session.", 404);
  } catch (error) {
    return handle(error);
  }
}
