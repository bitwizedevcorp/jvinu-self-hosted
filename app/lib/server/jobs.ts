import "server-only";
import { randomUUID } from "node:crypto";
import type { StoredConnection } from "./connections";
import { db } from "./db";
import { driverFor, StorageUserError } from "./drivers";
import { forgetInventory } from "./inventory";
import { executeSteps, planSteps, type Prepared, type Progress } from "./operations";
import { forgetNotes, moveNotes } from "./notes";
import { forgetItems, moveItems } from "./user-items";

/**
 * Copies, moves, renames and deletes run here, after the request that asked for them has
 * returned — so a closed tab or a proxy timeout doesn't cut them short. Progress is kept in
 * the database; a job can be cancelled between objects. Jobs live in this server process:
 * one interrupted by a restart is marked "interrupted", with how far it got.
 */
export type JobStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";
export type Job = {
  id: string;
  connectionId: string;
  /**
   * An operation on objects; "share-copy" copies one file into the share bucket (counted in
   * bytes); "transfer" copies files to another connection.
   */
  op: Prepared["op"] | "share-copy" | "transfer";
  /** "Moving 3 items to photos/" — written when the job starts. */
  label: string;
  status: JobStatus;
  total: number;
  done: number;
  /** Keys that couldn't be processed (the first 100). */
  failed: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  connection_id: string;
  op: string;
  label: string;
  status: string;
  total: number | string;
  done: number | string;
  failed: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const fromRow = (row: Row): Job => ({
  id: row.id,
  connectionId: row.connection_id,
  op: row.op as Job["op"],
  label: row.label,
  status: row.status as JobStatus,
  total: Number(row.total),
  done: Number(row.done),
  failed: JSON.parse(row.failed) as string[],
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Cancel requests for jobs running in this process. */
const cancelled = new Set<string>();
/** Jobs this process is running — anything else marked running was interrupted. */
const live = new Set<string>();

async function update(id: string, fields: Partial<Pick<Job, "status" | "total" | "done" | "failed" | "error">>) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of [
    ["status", fields.status],
    ["total", fields.total],
    ["done", fields.done],
    ["failed", fields.failed === undefined ? undefined : JSON.stringify(fields.failed.slice(0, 100))],
    ["error", fields.error],
  ] as const) {
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  sets.push("updated_at = ?");
  values.push(new Date().toISOString(), id);
  await (await db()).run(`update jobs set ${sets.join(", ")} where id = ?`, values);
}

/** Starts a prepared operation in the background and returns its job at once. */
export async function startJob(userId: string, connection: StoredConnection, prepared: Prepared, label: string): Promise<Job> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await (await db()).run(
    `insert into jobs (id, user_id, connection_id, op, label, status, total, done, failed, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, 'running', 0, 0, '[]', null, ?, ?)`,
    [id, userId, connection.id, prepared.op, label, now, now],
  );
  live.add(id);
  void run(id, connection, prepared);
  return (await getJob(userId, id))!;
}

async function run(id: string, connection: StoredConnection, prepared: Prepared) {
  const driver = driverFor(connection);
  let lastWrite = 0;
  let pending: Promise<void> = Promise.resolve();
  const report = (progress: Progress, force = false) => {
    // At most twice a second, so a fast job doesn't hammer the database.
    if (!force && Date.now() - lastWrite < 500) return;
    lastWrite = Date.now();
    pending = pending.then(() => update(id, { total: progress.total, done: progress.done, failed: progress.failed })).catch(() => {});
  };

  try {
    const steps = await planSteps(driver, prepared);
    await update(id, { total: steps.length });
    const progress = await executeSteps(driver, prepared.op, steps, {
      onProgress: report,
      cancelled: () => cancelled.has(id),
      change: prepared.change,
    });
    await pending;

    // Saved stars and recent files follow what moved and forget what's gone.
    const moved = prepared.op === "move" || prepared.op === "rename";
    for (const { item, to } of prepared.pairs) {
      if (prepared.op === "delete") {
        await forgetItems(connection.id, [item.key]);
        if (item.kind === "folder") await forgetNotes(connection.id, item.key);
      } else if (moved && to) {
        await moveItems(connection.id, item.key, to);
        if (item.kind === "folder") await moveNotes(connection.id, item.key, to);
      }
    }

    const status: JobStatus = cancelled.has(id) ? "cancelled" : progress.failed.length && !progress.done ? "failed" : "done";
    await update(id, {
      status,
      total: progress.total,
      done: progress.done,
      failed: progress.failed,
      error: status === "failed" ? "None of the objects could be processed." : null,
    });
  } catch (error) {
    await pending;
    await update(id, {
      status: "failed",
      error: error instanceof StorageUserError ? error.message : "Something went wrong on the server.",
    });
    if (!(error instanceof StorageUserError)) console.error("[jobs] job failed", id, error);
  } finally {
    forgetInventory(connection.id);
    cancelled.delete(id);
    live.delete(id);
  }
}

/**
 * Any other work as a job, with the same progress, cancellation and restart handling:
 * `work` reports how far it got and checks `cancelled` as it goes.
 */
export async function startTask(
  userId: string,
  connectionId: string,
  op: "share-copy" | "transfer",
  label: string,
  /** Returns the keys it couldn't process, if any. */
  work: (report: (done: number, total: number) => void, cancelled: () => boolean) => Promise<void | { failed: string[] }>,
): Promise<Job> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await (await db()).run(
    `insert into jobs (id, user_id, connection_id, op, label, status, total, done, failed, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, 'running', 0, 0, '[]', null, ?, ?)`,
    [id, userId, connectionId, op, label, now, now],
  );
  live.add(id);
  let lastWrite = 0;
  let pending: Promise<void> = Promise.resolve();
  const latest = { done: 0, total: 0 };
  const report = (done: number, total: number) => {
    latest.done = done;
    latest.total = total;
    if (Date.now() - lastWrite < 500) return;
    lastWrite = Date.now();
    pending = pending.then(() => update(id, { done, total })).catch(() => {});
  };
  void (async () => {
    try {
      const outcome = await work(report, () => cancelled.has(id));
      await pending;
      const failed = outcome?.failed ?? [];
      const allFailed = failed.length > 0 && latest.done === 0;
      await update(id, {
        status: cancelled.has(id) ? "cancelled" : allFailed ? "failed" : "done",
        done: failed.length ? latest.done : latest.total || latest.done,
        total: latest.total,
        failed,
        error: allFailed ? "None of the objects could be processed." : null,
      });
    } catch (error) {
      await pending;
      await update(id, {
        status: cancelled.has(id) ? "cancelled" : "failed",
        error: error instanceof StorageUserError ? error.message : "Something went wrong on the server.",
      });
      if (!(error instanceof StorageUserError)) console.error("[jobs] task failed", id, error);
    } finally {
      cancelled.delete(id);
      live.delete(id);
    }
  })();
  return (await getJob(userId, id))!;
}

export async function getJob(userId: string, id: string): Promise<Job | undefined> {
  const row = await (await db()).get<Row>(`select * from jobs where id = ? and user_id = ?`, [id, userId]);
  return row ? withLiveness(fromRow(row)) : undefined;
}

/** This user's jobs from the last day, newest first. */
export async function listJobs(userId: string): Promise<Job[]> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const rows = await (await db()).all<Row>(`select * from jobs where user_id = ? and created_at > ? order by created_at desc limit 50`, [
    userId,
    since,
  ]);
  return rows.map(fromRow).map(withLiveness);
}

/** A job marked running that this process isn't running was cut off by a restart. */
function withLiveness(job: Job): Job {
  if (job.status !== "running" || live.has(job.id)) return job;
  void update(job.id, { status: "interrupted", error: "The server restarted before this finished." }).catch(() => {});
  return { ...job, status: "interrupted", error: "The server restarted before this finished." };
}

export async function cancelJob(userId: string, id: string): Promise<boolean> {
  const job = await getJob(userId, id);
  if (!job || job.status !== "running") return false;
  cancelled.add(id);
  return true;
}
