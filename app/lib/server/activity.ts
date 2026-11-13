import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import type { ConnectionSettings } from "../connection-settings";
import { getJob, type JobStatus } from "./jobs";

/**
 * Each connection's history: who uploaded, created, copied, moved, renamed or deleted what;
 * who shared a file, and when someone downloaded it through the link; zip downloads; and
 * changes to the connection itself. It's kept in this server's database (never in the
 * bucket) for KEEP_DAYS. Browsing, previews and single downloads aren't recorded.
 */
export type ActivityAction =
  /** The connection was added. detail: { presetId, bucket, encrypted, readOnly } */
  | "connected"
  /** detail: { from, to } */
  | "connection-renamed"
  /** detail: { on } */
  | "read-only"
  /** detail: { changes } — each already in words, e.g. "set a public URL". */
  | "settings"
  | "uploaded"
  | "folder-created"
  | "deleted"
  | "copied"
  | "moved"
  /** destination: the new key. */
  | "renamed"
  /** detail: { change } */
  | "metadata"
  /** Copied to another connection. detail: { connectionId, connection } — where to. */
  | "copied-out"
  /** Copied here from another connection. detail: { connectionId, connection } — where from. */
  | "copied-in"
  /** A query's result saved as a file. detail: { format, rows, connection? } (the source, if another) */
  | "exported"
  /** A folder's note written, or (detail.removed) removed. */
  | "note"
  /** A share link made. detail: { linkId, expiresAt, maxDownloads, password, viaShareBucket } */
  | "shared"
  /** detail: { linkId } */
  | "unshared"
  /** Someone downloaded a file through a share link. detail: { linkId } */
  | "link-downloaded"
  /** Files and folders downloaded as one zip. detail: { name, files } */
  | "zipped";

/** Who did it. `via` names the access token when an AI agent acted for them. */
export type Actor = { id: string | null; name: string; via?: string };

/** A download through a share link has no signed-in person behind it. */
export const LINK_VISITOR: Actor = { id: null, name: "Someone with the link" };

export const actorOf = (user: { id: string; name: string }): Actor => ({ id: user.id, name: user.name });

/** How long entries are kept. */
export const KEEP_DAYS = 180;
/** Keys stored per entry; beyond these, items are only counted. */
const ITEMS_KEPT = 20;

/** The folder something is in: "a/b/c.txt" → "a/b/", "a/b/" → "a/", "c.txt" → "". */
export function folderOf(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
}

/** The deepest folder that holds all of these keys. */
export function commonFolder(keys: string[]): string {
  if (!keys.length) return "";
  let common = folderOf(keys[0]);
  for (const key of keys.slice(1)) {
    const folder = folderOf(key);
    while (!folder.startsWith(common)) common = folderOf(common);
  }
  return common;
}

// Entries made in the same millisecond keep their order. (A clock set back further than
// a second is taken as it is.)
let lastStamp = 0;
function stamp(): string {
  const now = Date.now();
  lastStamp = now > lastStamp || lastStamp - now > 1000 ? now : lastStamp + 1;
  return new Date(lastStamp).toISOString();
}

/**
 * When this server started keeping history: a marker row, written the first time it's
 * needed. Changes made before then were never recorded, and the dialog says so.
 */
let started: Promise<string> | null = null;
function recordingSince(): Promise<string> {
  started ??= (async () => {
    const database = await db();
    await database.run(
      `insert into activity (id, connection_id, at, actor_name, action) values ('started', '*', ?, '', 'started')
       on conflict (id) do nothing`,
      [new Date().toISOString()],
    );
    return (await database.get<{ at: string }>(`select at from activity where id = 'started'`))!.at;
  })().catch((error) => {
    started = null;
    throw error;
  });
  return started;
}

let prunedAt = 0;
/** Drops entries past KEEP_DAYS, at most once an hour. */
async function prune() {
  if (Date.now() - prunedAt < 3600_000) return;
  prunedAt = Date.now();
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
  await (await db()).run(`delete from activity where at < ? and id <> 'started'`, [cutoff]);
}

export type ActivityInput = {
  connectionId: string;
  actor: Actor;
  action: ActivityAction;
  /** The file or folder it's about: the first one, when there are several. */
  target?: string | null;
  /** Everything it was about; the first ITEMS_KEPT are kept and the rest counted. */
  items?: string[];
  /** Where it happened. Defaults to the folder holding the target, or all the items. */
  folder?: string;
  /** Where things went: a folder for copies and moves, the new key for a rename. */
  destination?: string | null;
  /** The background job doing the work: its outcome shows with the entry. */
  jobId?: string | null;
  /** Bytes, where known. */
  size?: number | null;
  detail?: Record<string, unknown>;
};

/** Adds an entry. Never throws: work that's done shouldn't fail because its history couldn't be written. */
export async function recordActivity(input: ActivityInput): Promise<void> {
  try {
    await recordingSince();
    const items = input.items ?? (input.target ? [input.target] : []);
    const target = input.target ?? items[0] ?? null;
    const detail: Record<string, unknown> = { ...input.detail };
    if (input.items) {
      detail.items = items.slice(0, ITEMS_KEPT);
      detail.count = items.length;
    }
    if (typeof input.size === "number" && Number.isFinite(input.size)) detail.size = input.size;
    if (input.actor.via) detail.via = input.actor.via;
    await (await db()).run(
      `insert into activity (id, connection_id, at, actor_id, actor_name, action, folder, target, destination, job_id, detail)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.connectionId,
        stamp(),
        input.actor.id,
        input.actor.name,
        input.action,
        input.folder ?? (input.items ? commonFolder(items) : target ? folderOf(target) : ""),
        target,
        input.destination ?? null,
        input.jobId ?? null,
        JSON.stringify(detail),
      ],
    );
  } catch (error) {
    console.error("[activity] couldn't record", input.action, error);
    return;
  }
  await prune().catch((error) => console.error("[activity] couldn't prune", error));
}

type Configurable = { pricePerGb?: number | null; settings?: ConnectionSettings };

/** What a settings change did, in words: "turned on encryption at rest". */
export function settingsChanges(before: Configurable, after: Configurable): string[] {
  const changes: string[] = [];
  const rate = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
  if (after.pricePerGb !== undefined && (after.pricePerGb ?? null) !== (before.pricePerGb ?? null)) {
    changes.push(after.pricePerGb === null ? "went back to list prices for storage" : `set the storage rate to ${rate(after.pricePerGb)} per GB-month`);
  }
  if (!after.settings) return changes;
  const was: Record<string, unknown> = before.settings ?? {};
  const now: Record<string, unknown> = after.settings;
  for (const field of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const [from, to] = [was[field], now[field]];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    switch (field) {
      case "egressPerGb":
        changes.push(typeof to === "number" ? `set the download rate to ${rate(to)} per GB` : "went back to list prices for downloads");
        break;
      case "providerEncryption":
        if (Boolean(from) !== Boolean(to)) changes.push(to ? "turned on encryption at rest" : "turned off encryption at rest");
        break;
      case "publicBaseUrl":
        changes.push(typeof to === "string" && to ? `set the public URL to ${to}` : "removed the public URL");
        break;
      case "shareTarget": {
        const prefix = (to as ConnectionSettings["shareTarget"])?.prefix;
        changes.push(to ? `made this the share bucket${prefix ? `, under ${prefix}` : ""}` : "stopped using this as the share bucket");
        break;
      }
      default:
        changes.push(`changed ${field}`);
    }
  }
  return changes;
}

/** A connection was disconnected: its history goes with it. */
export async function forgetConnectionActivity(connectionId: string): Promise<void> {
  await (await db()).run(`delete from activity where connection_id = ?`, [connectionId]);
}

/* ---- Reading it back --------------------------------------------------------------- */

/** How a background job went; `failed` counts what it couldn't do (only once it's finished). */
export type JobOutcome = { status: JobStatus; done: number; total: number; failed: number; error: string | null };

export type ActivityEntry = {
  id: string;
  action: ActivityAction;
  actor: { name: string; via?: string; you: boolean };
  /** When it happened; for a run of the same thing, the latest time. */
  at: string;
  /** When a run started (the same as `at` for one entry). */
  since: string;
  folder: string;
  target: string | null;
  destination: string | null;
  /** The keys it was about, at most ENTRY_ITEMS. */
  items: string[];
  /** How many things: files uploaded, items deleted, downloads through a link… */
  count: number;
  /** Bytes, where known. */
  size: number | null;
  detail: Record<string, unknown>;
  job: JobOutcome | null;
};

export type ActivityPage = {
  entries: ActivityEntry[];
  /** Pass as `before` for older entries; null once there are none. */
  next: string | null;
  /** When this server started keeping history. */
  recordingSince: string;
  keepDays: number;
};

type Row = {
  id: string;
  at: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  folder: string;
  target: string | null;
  destination: string | null;
  job_id: string | null;
  detail: string;
};

/** Repeats that read as one line, such as "uploaded 12 files to photos/". */
const RUNS = new Set<string>(["uploaded", "folder-created", "deleted", "copied", "moved", "metadata", "copied-out", "copied-in", "link-downloaded"]);
/** A longer pause between two of them starts a new line. */
const RUN_GAP = 15 * 60_000;
const ENTRY_ITEMS = 50;
const BATCH = 500;
/** Rows one page may read through, so a very long run can't make a request slow. */
const SCAN_LIMIT = 20_000;

const parseDetail = (raw: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Rows that belong on one line share this. */
function runKey(row: Row, detail: Record<string, unknown>, via: unknown): string | null {
  if (!RUNS.has(row.action)) return null;
  const extra =
    row.action === "link-downloaded"
      ? row.target
      : row.action === "copied-out" || row.action === "copied-in"
        ? detail.connectionId
        : row.action === "metadata"
          ? JSON.stringify(detail.change)
          : "";
  return JSON.stringify([row.action, row.actor_id, row.actor_name, via ?? null, row.folder, row.destination, extra]);
}

/** While a page is put together: what each entry's run is keyed by, and its jobs. */
type Draft = { entry: ActivityEntry; key: string | null; jobIds: string[] };

/** "2026-10-12T09:30:00.000Z|<id>" — the last entry a page ended on. */
export function parseCursor(raw: string): { at: string; id: string } | null {
  const cut = raw.lastIndexOf("|");
  const at = raw.slice(0, cut);
  const id = raw.slice(cut + 1);
  if (cut < 1 || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(at) || !/^[\w-]{1,64}$/.test(id)) return null;
  return { at, id };
}

/**
 * This connection's history, newest first: a page of entries, with runs of the same thing
 * (twelve uploads into one folder, say) folded into one. With `prefix`, only what happened
 * in that folder or below it, or was moved or copied there.
 */
export async function listActivity(
  connectionId: string,
  viewerId: string,
  { prefix = "", before = null, limit = 40 }: { prefix?: string; before?: { at: string; id: string } | null; limit?: number } = {},
): Promise<ActivityPage> {
  const database = await db();
  const since = await recordingSince();
  // Character counts, as SQL's substr counts them (an emoji is one, not two).
  const length = [...prefix].length;
  const where = prefix
    ? ` and (substr(folder, 1, ?) = ? or substr(coalesce(destination, ''), 1, ?) = ? or substr(coalesce(target, ''), 1, ?) = ?)`
    : "";
  const filter = prefix ? [length, prefix, length, prefix, length, prefix] : [];

  const drafts: Draft[] = [];
  let cursor = before;
  let last: Row | null = null;
  let scanned = 0;
  let more = true;
  scan: while (scanned < SCAN_LIMIT) {
    const rows = await database.all<Row>(
      `select id, at, actor_id, actor_name, action, folder, target, destination, job_id, detail from activity
       where connection_id = ?${cursor ? " and (at < ? or (at = ? and id < ?))" : ""}${where}
       order by at desc, id desc limit ?`,
      [connectionId, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []), ...filter, BATCH],
    );
    for (const row of rows) {
      const { items: kept, count: counted, size: bytes, via, ...detail } = parseDetail(row.detail);
      const key = runKey(row, detail, via);
      const items = Array.isArray(kept) ? (kept as string[]) : row.target ? [row.target] : [];
      const count = typeof counted === "number" ? counted : 1;
      const size = typeof bytes === "number" ? bytes : null;
      const open = drafts.at(-1);
      if (open && key !== null && open.key === key && Date.parse(open.entry.since) - Date.parse(row.at) <= RUN_GAP) {
        const entry = open.entry;
        entry.since = row.at;
        entry.count += count;
        if (size !== null) entry.size = (entry.size ?? 0) + size;
        for (const item of items) if (entry.items.length < ENTRY_ITEMS && !entry.items.includes(item)) entry.items.push(item);
        if (row.job_id) open.jobIds.push(row.job_id);
      } else {
        // The next entry would be one too many: this page ends with the run before it.
        if (drafts.length === limit) break scan;
        const entry: ActivityEntry = {
          id: row.id,
          action: row.action as ActivityAction,
          actor: { name: row.actor_name, ...(typeof via === "string" ? { via } : {}), you: row.actor_id !== null && row.actor_id === viewerId },
          at: row.at,
          since: row.at,
          folder: row.folder,
          target: row.target,
          destination: row.destination,
          items: items.slice(0, ENTRY_ITEMS),
          count,
          size,
          detail,
          job: null,
        };
        drafts.push({ entry, key, jobIds: row.job_id ? [row.job_id] : [] });
      }
      last = row;
      scanned += 1;
    }
    if (rows.length < BATCH) {
      more = false;
      break;
    }
    cursor = { at: rows.at(-1)!.at, id: rows.at(-1)!.id };
  }

  const outcomes = await jobOutcomes(drafts.flatMap((draft) => draft.jobIds));
  return {
    entries: drafts.map(({ entry, jobIds }) => ({
      ...entry,
      job: jobIds.reduce<JobOutcome | null>((merged, id) => combine(merged, outcomes.get(id) ?? null), null),
    })),
    next: more && last ? `${last.at}|${last.id}` : null,
    recordingSince: since,
    keepDays: KEEP_DAYS,
  };
}

const SEVERITY: Record<JobStatus, number> = { running: 4, failed: 3, interrupted: 2, cancelled: 1, done: 0 };

/** Several jobs on one line read as one: still running if any is, and their counts added up. */
function combine(a: JobOutcome | null, b: JobOutcome | null): JobOutcome | null {
  if (!a || !b) return a ?? b;
  return {
    status: SEVERITY[a.status] >= SEVERITY[b.status] ? a.status : b.status,
    done: a.done + b.done,
    total: a.total + b.total,
    failed: a.failed + b.failed,
    error: a.error ?? b.error,
  };
}

type JobRow = { id: string; user_id: string; status: string; total: number | string; done: number | string; error: string | null };

async function jobOutcomes(ids: string[]): Promise<Map<string, JobOutcome>> {
  const outcomes = new Map<string, JobOutcome>();
  const database = await db();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = await database.all<JobRow>(
      `select id, user_id, status, total, done, error from jobs where id in (${chunk.map(() => "?").join(", ")})`,
      chunk,
    );
    for (const row of rows) {
      let status = row.status as JobStatus;
      let error = row.error;
      // jobs.ts knows whether a job marked running is still running, or was cut off by a restart.
      if (status === "running") {
        const job = await getJob(row.user_id, row.id);
        if (job) ({ status, error } = job);
      }
      const total = Number(row.total);
      const done = Number(row.done);
      outcomes.set(row.id, { status, done, total, failed: status === "done" || status === "failed" ? Math.max(0, total - done) : 0, error });
    }
  }
  return outcomes;
}
