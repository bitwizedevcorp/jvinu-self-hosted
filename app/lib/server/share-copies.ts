import "server-only";
import { randomBytes } from "node:crypto";
import { getConnection, listConnections, type StoredConnection } from "./connections";
import { db } from "./db";
import { driverFor } from "./drivers";
import { StorageUserError, type StorageDriver } from "./drivers/types";
import { startTask } from "./jobs";
import { effectiveType } from "./mime";
import { linksForCopy, stateOf, type ShareLink } from "./shares";

/**
 * The share bucket: one connection marked "share from here". A file shared from another
 * connection is copied there once, in the background, and its links are served from the
 * copy, where downloads cost less. The same unchanged file reuses its copy; a copy is
 * deleted once no working link needs it. The original is only ever read.
 */

export type CopyStatus = "copying" | "ready" | "failed";

export type ShareCopy = {
  id: string;
  sourceConnectionId: string;
  sourceKey: string;
  /** The original's ETag when copied: a changed file gets a new copy. */
  sourceVersion: string;
  targetConnectionId: string;
  targetKey: string;
  size: number | null;
  status: CopyStatus;
  error: string | null;
  jobId: string | null;
  createdAt: string;
  readyAt: string | null;
};

type Row = {
  id: string;
  source_connection_id: string;
  source_key: string;
  source_version: string;
  target_connection_id: string;
  target_key: string;
  size: number | string | null;
  status: string;
  error: string | null;
  job_id: string | null;
  created_at: string;
  ready_at: string | null;
};

const fromRow = (row: Row): ShareCopy => ({
  id: row.id,
  sourceConnectionId: row.source_connection_id,
  sourceKey: row.source_key,
  sourceVersion: row.source_version,
  targetConnectionId: row.target_connection_id,
  targetKey: row.target_key,
  size: row.size === null ? null : Number(row.size),
  status: row.status as CopyStatus,
  error: row.error,
  jobId: row.job_id,
  createdAt: row.created_at,
  readyAt: row.ready_at,
});

/** Drivers by connection id. Tests swap in their own. */
type Resolver = (connectionId: string) => Promise<StorageDriver | null>;
const fromDatabase: Resolver = async (connectionId) => {
  const connection = await getConnection(connectionId);
  return connection ? driverFor(connection) : null;
};
let resolveDriver: Resolver = fromDatabase;
export function resolveDriversWith(resolver: Resolver | null) {
  resolveDriver = resolver ?? fromDatabase;
}

/** The connection marked "share from here", if any. */
export async function shareBucket(): Promise<StoredConnection | undefined> {
  return (await listConnections()).find((connection) => connection.settings?.shareTarget);
}

/** Why files from `source` can't be shared through `bucket`; null when they can. */
export function shareBucketRefusal(
  source: Pick<StoredConnection, "id" | "crypt">,
  bucket: Pick<StoredConnection, "id" | "crypt" | "readOnly" | "settings"> | undefined,
): string | null {
  if (!bucket?.settings?.shareTarget) return "No connection is set up as the share bucket.";
  if (bucket.id === source.id) return "This connection is the share bucket itself.";
  if (bucket.readOnly) return "The share bucket is read-only, so nothing can be copied into it.";
  if (source.crypt && !bucket.crypt) return "Files from an encrypted connection can only go to an encrypted share bucket.";
  return null;
}

export async function getCopy(id: string): Promise<ShareCopy | undefined> {
  const row = await (await db()).get<Row>(`select * from share_copies where id = ?`, [id]);
  return row ? fromRow(row) : undefined;
}

async function setStatus(id: string, status: CopyStatus, error: string | null = null) {
  await (await db()).run(`update share_copies set status = ?, error = ?, ready_at = ? where id = ?`, [
    status,
    error,
    status === "ready" ? new Date().toISOString() : null,
    id,
  ]);
}

/** Two shares of the same file at once wait for one copy. */
const starting = new Map<string, Promise<ShareCopy>>();

/**
 * The share bucket's copy of this version of a file: the existing one (ready, or still
 * being made) if there is one; otherwise a new one, made by a background job.
 */
export async function copyFor(input: {
  userId: string;
  sourceConnectionId: string;
  key: string;
  version: string;
  size: number | null;
  bucket: { id: string; prefix: string };
}): Promise<ShareCopy> {
  const identity = [input.sourceConnectionId, input.key, input.version, input.bucket.id].join("\n");
  const already = starting.get(identity);
  if (already) return already;
  const pending = (async () => {
    const database = await db();
    const existing = await database.get<Row>(
      `select * from share_copies where source_connection_id = ? and source_key = ? and source_version = ? and target_connection_id = ?
         and status <> 'failed' order by created_at desc`,
      [input.sourceConnectionId, input.key, input.version, input.bucket.id],
    );
    if (existing) return fromRow(existing);

    const id = randomBytes(9).toString("base64url");
    const name = input.key.split("/").pop() ?? input.key;
    const copy: ShareCopy = {
      id,
      sourceConnectionId: input.sourceConnectionId,
      sourceKey: input.key,
      sourceVersion: input.version,
      targetConnectionId: input.bucket.id,
      // Its own folder keeps the original name, which downloads are saved under.
      targetKey: `${input.bucket.prefix}${id}/${name}`,
      size: input.size,
      status: "copying",
      error: null,
      jobId: null,
      createdAt: new Date().toISOString(),
      readyAt: null,
    };
    await database.run(
      `insert into share_copies (id, source_connection_id, source_key, source_version, target_connection_id, target_key, size, status,
         error, job_id, created_at, ready_at)
       values (?, ?, ?, ?, ?, ?, ?, 'copying', null, null, ?, null)`,
      [copy.id, copy.sourceConnectionId, copy.sourceKey, copy.sourceVersion, copy.targetConnectionId, copy.targetKey, copy.size, copy.createdAt],
    );
    const job = await startTask(input.userId, input.sourceConnectionId, "share-copy", `Copying ${name} to the share bucket`, (report, cancelled) =>
      runCopy(copy, report, cancelled),
    );
    await database.run(`update share_copies set job_id = ? where id = ?`, [job.id, copy.id]);
    return { ...copy, jobId: job.id };
  })().finally(() => starting.delete(identity));
  starting.set(identity, pending);
  return pending;
}

/** Streams the original into the share bucket; a failed or cancelled copy leaves nothing behind. */
async function runCopy(copy: ShareCopy, report: (done: number, total: number) => void, cancelled: () => boolean) {
  const [source, target] = await Promise.all([resolveDriver(copy.sourceConnectionId), resolveDriver(copy.targetConnectionId)]);
  if (!source || !target) {
    await setStatus(copy.id, "failed", "A connection was removed.");
    throw new StorageUserError("A connection was removed before the copy could be made.", 410);
  }
  try {
    const object = await source.read(copy.sourceKey);
    const total = object.size ?? copy.size ?? 0;
    let done = 0;
    report(0, total);
    const counted = object.stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (cancelled()) return controller.error(new StorageUserError("Cancelled.", 409));
          done += chunk.byteLength;
          report(done, total);
          controller.enqueue(chunk);
        },
      }),
    );
    await target.upload(copy.targetKey, counted, object.size, effectiveType(copy.sourceKey, object.contentType));
    report(total, total);
    await setStatus(copy.id, "ready");
  } catch (error) {
    await setStatus(copy.id, "failed", error instanceof StorageUserError ? error.message : "The copy failed.");
    await target.remove([copy.targetKey]).catch(() => {});
    throw error;
  }
  // The link may have been revoked, or run out, while this was copying.
  await sweepCopies();
}

/**
 * Where a link's bytes come from: its copy in the share bucket once that's ready.
 * null means the original (no copy, still copying, or the copy failed).
 */
export async function servedFromCopy(link: ShareLink): Promise<{ driver: StorageDriver; key: string } | null> {
  if (!link.copyId) return null;
  const copy = await getCopy(link.copyId);
  if (!copy || copy.status !== "ready") return null;
  const driver = await resolveDriver(copy.targetConnectionId).catch(() => null);
  return driver ? { driver, key: copy.targetKey } : null;
}

/** A copy no link points to yet is probably still having its link made: it's kept this long. */
const UNLINKED_GRACE_MS = 60 * 60_000;

/**
 * Deletes copies that no working link needs any more — their links expired, ran out,
 * were revoked or have been purged — and copies that failed. Returns how many went.
 */
export async function sweepCopies(now = Date.now()): Promise<number> {
  const database = await db();
  const rows = await database.all<Row>(`select * from share_copies where status <> 'copying'`);
  let removed = 0;
  for (const row of rows) {
    const links = await linksForCopy(row.id);
    if (row.status === "ready") {
      if (links.some((link) => stateOf(link, now) === "active")) continue;
      // A small file can finish copying before the link that asked for it is saved.
      if (!links.length && now - Date.parse(row.created_at) < UNLINKED_GRACE_MS) continue;
    }
    if (row.status === "ready") {
      const target = await resolveDriver(row.target_connection_id).catch(() => null);
      if (target) {
        const { failed } = await target.remove([row.target_key]).catch(() => ({ failed: [row.target_key] }));
        if (failed.length) continue; // try again on the next sweep
      }
    }
    await database.run(`delete from share_copies where id = ?`, [row.id]);
    removed += 1;
  }
  return removed;
}

let sweeper: ReturnType<typeof setInterval> | null = null;

/** Sweeps every few minutes for as long as the server runs. */
export function startCopySweeper(everyMs = 5 * 60_000) {
  if (sweeper) return;
  sweeper = setInterval(() => {
    sweepCopies().catch((error) => console.error("[share-copies] sweep failed", error));
  }, everyMs);
  sweeper.unref?.();
}
