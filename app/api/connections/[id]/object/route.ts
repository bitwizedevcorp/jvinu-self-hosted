import { guardConnection } from "@/app/lib/server/guard";
import { driverFor } from "@/app/lib/server/drivers";
import type { ByteRange } from "@/app/lib/server/drivers/types";
import { fail, handle } from "@/app/lib/server/http";
import { effectiveType } from "@/app/lib/server/mime";

const ACTIVE = /html|svg|xml|javascript|ecmascript/i;
const ACTIVE_EXT = /\.(html?|xhtml|svgz?|xml|js|mjs)$/i;

/**
 * One "bytes=start-end" or "bytes=start-" range. Suffix ranges ("bytes=-500") and
 * multiple ranges are ignored — the whole file is sent, which HTTP allows.
 */
function parseRange(header: string | null): ByteRange | undefined {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (end !== undefined && end < start) return undefined;
  return { start, end };
}

/**
 * Streams an object's bytes for connections that can't hand out signed links, and for
 * previews that must come from this origin (PDFs, text). Honours Range, so video can seek
 * and downloads can resume.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/object">) {
  try {
    const guarded = await guardConnection(request, ctx.params);
    if (guarded instanceof Response) return guarded;
    const { connection } = guarded;
    const params = new URL(request.url).searchParams;
    const key = params.get("key") ?? "";
    if (!key || key.startsWith("/") || key.endsWith("/") || Buffer.byteLength(key) > 1024) return fail("Invalid key.", 400);

    const range = parseRange(request.headers.get("range"));
    const object = await driverFor(connection).read(key, range);
    const type = effectiveType(key, object.contentType);
    const filename = key.split("/").pop() ?? "download";
    const active = ACTIVE.test(type) || ACTIVE_EXT.test(key);
    const pdf = /^application\/pdf\b/i.test(type);
    const headers = new Headers({
      "content-type": type,
      // Never let a stored HTML or SVG file run as this app's own page. PDFs skip the
      // sandbox only because browsers refuse to show a PDF inside one; their viewer runs
      // in its own isolated context.
      "content-security-policy": `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'${pdf ? "" : "; sandbox"}`,
      "x-frame-options": "SAMEORIGIN",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=60",
      "accept-ranges": "bytes",
      // Anything a browser could execute (HTML, SVG, XML) is never rendered inline; <img>
      // still shows SVG previews because images ignore Content-Disposition.
      "content-disposition": `${params.get("download") === "1" || active ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    if (object.size !== undefined) headers.set("content-length", String(object.size));
    if (object.range) {
      headers.set("content-range", `bytes ${object.range.start}-${object.range.end}/${object.total ?? "*"}`);
      return new Response(object.stream, { status: 206, headers });
    }
    return new Response(object.stream, { headers });
  } catch (error) {
    return handle(error);
  }
}
