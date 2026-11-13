import { requireUser } from "@/app/lib/server/auth";
import { fail, handle, readJson } from "@/app/lib/server/http";
import { ProfileError, updateProfile } from "@/app/lib/server/profiles";

/** Change the name and email shown for the signed-in person. */
export async function PATCH(request: Request) {
  const user = await requireUser(request, { mutating: true });
  if (user instanceof Response) return user;
  let body: { name?: unknown; email?: unknown };
  try {
    body = await readJson(request, 4096);
  } catch {
    return fail("Expected a JSON body.", 400);
  }
  try {
    await updateProfile(user.id, body);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ProfileError) return fail(error.message, error.status);
    return handle(error);
  }
}
