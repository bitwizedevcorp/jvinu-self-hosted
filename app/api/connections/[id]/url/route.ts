import { guardConnection } from "@/app/lib/server/guard";
import { driverFor } from "@/app/lib/server/drivers";
import { fail, handle } from "@/app/lib/server/http";

/** Signed links: at least a minute, at most 7 days — the SigV4 and GCS v4 ceiling. */
const MIN_EXPIRY = 60;
const MAX_EXPIRY = 7 * 24 * 60 * 60;

/**
 * A URL for one object. Where the provider can sign one it's a direct link that
 * works for anyone for an hour; otherwise it's this app's own proxy, which only
 * works in the browser holding the connection.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/url">) {
  try {
    const guarded = await guardConnection(request, ctx.params);
    if (guarded instanceof Response) return guarded;
    const { connection } = guarded;
    const id = connection.id;
    const params = new URL(request.url).searchParams;
    const key = params.get("key") ?? "";
    if (!key || key.startsWith("/") || Buffer.byteLength(key) > 1024) return fail("Invalid key.", 400);
    const download = params.get("download") === "1";
    const requested = Number(params.get("expires") ?? 3600);
    if (!Number.isInteger(requested) || requested < MIN_EXPIRY || requested > MAX_EXPIRY)
      return fail("Link expiry must be between 1 minute and 7 days.", 400);
    const expiresIn = requested;

    const signed = await driverFor(connection).signedUrl(key, download, expiresIn);
    if (signed) {
      return Response.json({ url: signed, shareable: true, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() });
    }
    const proxied = `/api/connections/${id}/object?key=${encodeURIComponent(key)}${download ? "&download=1" : ""}`;
    return Response.json({ url: proxied, shareable: false, expiresAt: null });
  } catch (error) {
    return handle(error);
  }
}
