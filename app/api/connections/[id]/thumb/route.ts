import { driverFor } from "@/app/lib/server/drivers";
import { guardConnection } from "@/app/lib/server/guard";
import { fail, handle } from "@/app/lib/server/http";
import { THUMBNAILABLE, thumbnailFor } from "@/app/lib/server/thumbs";

/**
 * GET ?key=…&v=<etag> → a WebP of at most 512 px. Made once per object version and cached
 * on disk; the browser may keep it for good, since a new version is a new URL.
 * 415 when there's no thumbnail to be had (the client shows the file's glyph).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/thumb">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  const params = new URL(request.url).searchParams;
  const key = params.get("key") ?? "";
  const version = (params.get("v") ?? "").slice(0, 200);
  if (!key || key.startsWith("/") || key.endsWith("/") || Buffer.byteLength(key) > 1024) return fail("Invalid key.", 400);
  if (!THUMBNAILABLE.test(key)) return fail("No thumbnail for this kind of file.", 415);

  try {
    const thumb = await thumbnailFor(driverFor(guarded.connection), guarded.connection.id, key, version);
    if (!thumb) {
      return new Response(null, { status: 415, headers: { "cache-control": "private, max-age=3600" } });
    }
    return new Response(new Uint8Array(thumb), {
      headers: {
        "content-type": "image/webp",
        "content-length": String(thumb.length),
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return handle(error);
  }
}
