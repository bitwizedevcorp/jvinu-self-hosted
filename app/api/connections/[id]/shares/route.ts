import { actorOf, recordActivity } from "@/app/lib/server/activity";
import { driverFor } from "@/app/lib/server/drivers";
import { StorageUserError, type StorageDriver } from "@/app/lib/server/drivers/types";
import { guardConnection } from "@/app/lib/server/guard";
import { fail, handle, readJson, tooLarge } from "@/app/lib/server/http";
import { copyFor, shareBucket, shareBucketRefusal } from "@/app/lib/server/share-copies";
import { admitWrite, refusalResponse } from "@/app/lib/server/write-admission";
import { createShareLink, shareView } from "@/app/lib/server/shares";

/** Links last at most a year; "no expiry" is chosen explicitly (null). */
const MAX_LIFETIME = 365 * 24 * 3600;
const MAX_DOWNLOADS = 100_000;

/** Size and version of the file being shared, which must exist. */
async function describe(driver: StorageDriver, key: string): Promise<{ size: number | null; etag: string | null }> {
  if (driver.head) {
    const head = await driver.head(key);
    return { size: head.size ?? null, etag: head.etag ?? null };
  }
  try {
    const first = await driver.read(key, { start: 0, end: 0 });
    await first.stream.cancel().catch(() => {});
    return { size: first.total ?? null, etag: null };
  } catch (error) {
    // An empty file has no first byte to read.
    if (error instanceof StorageUserError && error.status === 416) return { size: 0, etag: null };
    throw error;
  }
}

/**
 * POST { key, expiresIn: seconds | null, maxDownloads: number | null, password?,
 * fromShareBucket? } → a new share link. Sharing reads, so read-only connections can share
 * too. With fromShareBucket, the file is copied to the share bucket (once per version) and
 * the link serves the copy as soon as it's there.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/connections/[id]/shares">) {
  try {
    const guarded = await guardConnection(request, ctx.params, { mutating: true });
    if (guarded instanceof Response) return guarded;
    const { user, connection } = guarded;

    let body: Record<string, unknown>;
    try {
      body = await readJson(request, 64 * 1024);
    } catch (error) {
      if (tooLarge(error)) return fail("That request is too large.", 413);
      return fail("Expected a JSON body.", 400);
    }
    const key = typeof body.key === "string" ? body.key : "";
    if (!key || key.startsWith("/") || key.endsWith("/") || Buffer.byteLength(key) > 1024) return fail("Choose a file to share.", 400);
    const expiresIn = body.expiresIn === null ? null : Number(body.expiresIn);
    if (expiresIn !== null && (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > MAX_LIFETIME))
      return fail("A link can last from a minute to a year, or have no expiry.", 400);
    const maxDownloads = body.maxDownloads === null || body.maxDownloads === undefined ? null : Number(body.maxDownloads);
    if (maxDownloads !== null && (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > MAX_DOWNLOADS))
      return fail(`Allow from 1 to ${MAX_DOWNLOADS.toLocaleString("en-US")} downloads, or no limit.`, 400);
    const password = typeof body.password === "string" ? body.password : "";
    if (password && (password.length < 6 || password.length > 256)) return fail("A link password is 6 to 256 characters.", 400);

    const { size, etag } = await describe(driverFor(connection), key);

    let copy;
    if (body.fromShareBucket === true) {
      const bucket = await shareBucket();
      const refusal = shareBucketRefusal(connection, bucket);
      if (refusal) return fail(refusal, 400);
      // The copy adds data to the share bucket, which may be a managed connection.
      const refused = await admitWrite({ connection: bucket!, kind: "copy", bytes: size ?? 0 });
      if (refused) return refusalResponse(refused);
      // Reusing a copy is only safe when the original says which version it is.
      if (!etag) return fail("This connection doesn't report file versions, so its files can't go through the share bucket.", 400);
      copy = await copyFor({
        userId: user.id,
        sourceConnectionId: connection.id,
        key,
        version: etag,
        size,
        bucket: { id: bucket!.id, prefix: bucket!.settings!.shareTarget!.prefix },
      });
    }

    const { link, token } = await createShareLink({
      connectionId: connection.id,
      key,
      createdBy: user.id,
      expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000).toISOString(),
      maxDownloads,
      password: password || undefined,
      copyId: copy?.id ?? null,
      meta: { name: key.split("/").pop() ?? key, size, etag },
    });
    await recordActivity({
      connectionId: connection.id,
      actor: actorOf(user),
      action: "shared",
      target: key,
      detail: { linkId: link.id, expiresAt: link.expiresAt, maxDownloads, password: Boolean(password), viaShareBucket: Boolean(copy) },
    });
    return Response.json(
      { link: shareView(link, token, copy ? { connectionId: copy.targetConnectionId, status: copy.status } : null), jobId: copy?.jobId ?? null },
      { status: 201 },
    );
  } catch (error) {
    return handle(error);
  }
}
