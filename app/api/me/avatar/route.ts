import { readFile } from "node:fs/promises";
import { requireUser } from "@/app/lib/server/auth";
import { StorageUserError } from "@/app/lib/server/drivers/types";
import { fail, handle, readBody } from "@/app/lib/server/http";
import { avatarPath, MAX_AVATAR_BYTES, ProfileError, removeAvatar, saveAvatar } from "@/app/lib/server/profiles";

/** The signed-in person's photo. The URL carries a version, so it can be cached for good. */
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  if (!user.avatar) return fail("No photo.", 404);
  try {
    const image = await readFile(avatarPath(user.id));
    return new Response(new Uint8Array(image), {
      headers: { "content-type": "image/webp", "cache-control": "private, max-age=31536000, immutable" },
    });
  } catch {
    return fail("No photo.", 404);
  }
}

/** Upload a photo: the raw image as the body. It's resized and re-encoded on this server. */
export async function PUT(request: Request) {
  const user = await requireUser(request, { mutating: true });
  if (user instanceof Response) return user;
  try {
    const image = await readBody(request, MAX_AVATAR_BYTES);
    if (!image.byteLength) return fail("Choose an image.", 400);
    return Response.json({ avatar: await saveAvatar(user.id, image) });
  } catch (error) {
    if (error instanceof ProfileError) return fail(error.message, error.status);
    if (error instanceof StorageUserError && error.status === 413) return fail("Use an image under 8 MB.", 413);
    return handle(error);
  }
}

export async function DELETE(request: Request) {
  const user = await requireUser(request, { mutating: true });
  if (user instanceof Response) return user;
  try {
    await removeAvatar(user.id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return handle(error);
  }
}
