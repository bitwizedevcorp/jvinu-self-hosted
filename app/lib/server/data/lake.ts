import "server-only";
import { writeFile } from "node:fs/promises";
import { StorageUserError, type StorageDriver } from "../drivers/types";
import { readPrefix } from "./bytes";
import { duckProblem, literal, withDuck, type Duck } from "./duck";

/**
 * Data-lake tables in plain folders: Delta Lake (a `_delta_log/` beside the data), Apache
 * Iceberg (`metadata/*.metadata.json`) and Apache Hudi (`.hoodie/`). jvinu finds them, reads
 * what they are from their own metadata, and — because deleting or moving the files inside
 * one breaks it for every engine — warns before anyone does.
 */

export type LakeFormat = "delta" | "iceberg" | "hudi";

export type LakeRoot = {
  /** The table's folder, ending in "/" ("" for a bucket that is one table). */
  root: string;
  format: LakeFormat;
  /** A Delta table that also carries Iceberg metadata (Delta UniForm). */
  alsoIceberg?: boolean;
};

export const FORMAT_NAMES: Record<LakeFormat, string> = { delta: "Delta", iceberg: "Iceberg", hudi: "Hudi" };

const ICEBERG_METADATA = /(^|\/)[^/]*(\.metadata\.json(\.gz)?|\.gz\.metadata\.json)$/;

/* ---- Finding tables ------------------------------------------------------------------- */

const CACHE_MS = 2 * 60_000;
const cache = new Map<string, { at: number; value: LakeRoot | null }>();

/** Forget what's known about a connection's folders — after jvinu itself changed them. */
export function forgetTables(scope: string) {
  for (const key of cache.keys()) if (key.startsWith(`${scope}|`)) cache.delete(key);
}

async function hasIcebergMetadata(driver: StorageDriver, metadata: string): Promise<boolean> {
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const listing = await driver.list(metadata, token);
    if (listing.files.some((file) => ICEBERG_METADATA.test(file.key) || file.key.endsWith("/version-hint.text"))) return true;
    token = listing.nextToken;
    if (!token) return false;
  }
  return false;
}

const notEmpty = async (driver: StorageDriver, prefix: string) => {
  const listing = await driver.list(prefix);
  return listing.files.length > 0 || listing.folders.length > 0;
};

/** Whether the folder `prefix` is itself a table's root. One listing, usually. */
export async function tableAt(driver: StorageDriver, scope: string, prefix: string): Promise<LakeRoot | null> {
  const id = `${scope}|${prefix}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const listing = await driver.list(prefix);
  const folders = new Set(listing.folders);
  // Marker folders sort early ("_" and "." before letters), so a first page almost always shows
  // them; when it's cut short without them, ask for each directly.
  const has = async (name: string) => folders.has(prefix + name) || (Boolean(listing.nextToken) && (await notEmpty(driver, prefix + name)));

  let value: LakeRoot | null = null;
  if (await has("_delta_log/")) {
    value = { root: prefix, format: "delta" };
    if ((await has("metadata/")) && (await hasIcebergMetadata(driver, `${prefix}metadata/`))) value.alsoIceberg = true;
  } else if (await has(".hoodie/")) value = { root: prefix, format: "hudi" };
  else if ((await has("metadata/")) && (await hasIcebergMetadata(driver, `${prefix}metadata/`))) value = { root: prefix, format: "iceberg" };

  cache.set(id, { at: Date.now(), value });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return value;
}

const parentOf = (key: string) => {
  const trimmed = key.replace(/\/$/, "");
  return trimmed.includes("/") ? trimmed.slice(0, trimmed.lastIndexOf("/") + 1) : "";
};

/** The table a folder sits in — the folder itself or its nearest ancestor that is one. */
export async function enclosingTable(driver: StorageDriver, scope: string, prefix: string): Promise<LakeRoot | null> {
  let current = prefix;
  for (let depth = 0; depth < 16; depth++) {
    const found = await tableAt(driver, scope, current);
    if (found) return found;
    if (!current) return null;
    current = parentOf(current);
  }
  return null;
}

/** Tables anywhere below a folder, from a bounded flat listing of it. */
async function tablesBelow(driver: StorageDriver, folder: string): Promise<LakeRoot[]> {
  const { keys } = await driver.listKeys(folder, 5000);
  const roots = new Map<string, LakeRoot>();
  for (const key of keys) {
    let match: RegExpExecArray | null;
    if ((match = /^(.*\/)?_delta_log\//.exec(key.slice(folder.length)))) {
      const root = folder + (match[1] ?? "");
      roots.set(root, { root, format: "delta" });
    } else if ((match = /^(.*\/)?\.hoodie\//.exec(key.slice(folder.length)))) {
      const root = folder + (match[1] ?? "");
      if (!roots.has(root)) roots.set(root, { root, format: "hudi" });
    } else if ((match = /^(.*\/)?metadata\/[^/]+$/.exec(key.slice(folder.length))) && ICEBERG_METADATA.test(key)) {
      const root = folder + (match[1] ?? "");
      if (!roots.has(root)) roots.set(root, { root, format: "iceberg" });
    }
    if (roots.size >= 20) break;
  }
  return [...roots.values()];
}

/* ---- Guarding changes ----------------------------------------------------------------- */

export type TableChange = {
  /** The item the change touches. */
  key: string;
  table: LakeRoot;
  /** inside: a file or folder within the table; root: the table's own folder; contains: a
   *  folder holding the table; into: a destination inside the table. */
  relation: "inside" | "root" | "contains" | "into";
  message: string;
};

const label = (table: LakeRoot) => `${FORMAT_NAMES[table.format]} table “${table.root.replace(/\/$/, "") || "/"}”`;
const nameOf = (key: string) => key.replace(/\/$/, "").split("/").pop() || key;

function explain(key: string, table: LakeRoot, relation: TableChange["relation"], op: "delete" | "move" | "copy" | "upload"): string {
  switch (relation) {
    case "inside":
      return `“${nameOf(key)}” is inside the ${label(table)}. ${
        op === "delete" ? "Deleting" : "Moving or renaming"
      } files there breaks the table for Databricks, Spark, Snowflake and every other engine — change it through the engine instead (DELETE, OPTIMIZE, VACUUM).`;
    case "root":
      return op === "delete"
        ? `“${nameOf(key)}” is a ${FORMAT_NAMES[table.format]} table. Deleting it deletes the table's data; if a catalog (Unity Catalog, Glue, Hive) still lists it, that entry will point at nothing.`
        : table.format === "iceberg"
          ? `“${nameOf(key)}” is an Iceberg table. Its metadata records full paths, so after a move the table won't open.`
          : `“${nameOf(key)}” is a ${FORMAT_NAMES[table.format]} table. Any catalog (Unity Catalog, Glue, Hive) that points at this location will lose it.`;
    case "contains":
      return `“${nameOf(key)}” contains the ${label(table)}.`;
    case "into":
      return `“${nameOf(key)}” is inside the ${label(table)}. Files added there aren't part of the table, and the next VACUUM may delete them.`;
  }
}

/**
 * Every table an operation would touch. Sources being deleted, moved or renamed count when
 * they're inside a table, are one, or hold one; a destination counts when it's inside one.
 */
export async function tablesTouched(
  driver: StorageDriver,
  scope: string,
  op: "delete" | "move" | "copy" | "upload",
  items: { key: string; kind: "file" | "folder" }[],
  destination?: string,
): Promise<TableChange[]> {
  const changes: TableChange[] = [];
  const seen = new Set<string>();
  // One message per table: the first reason found is the one that matters.
  const add = (key: string, table: LakeRoot, relation: TableChange["relation"]) => {
    if (seen.has(table.root)) return;
    seen.add(table.root);
    changes.push({ key, table, relation, message: explain(key, table, relation, op) });
  };

  if (op !== "copy" && op !== "upload") {
    for (const item of items) {
      const inside = await enclosingTable(driver, scope, parentOf(item.key));
      if (inside) {
        add(item.key, inside, "inside");
        continue;
      }
      if (item.kind !== "folder") continue;
      const own = await tableAt(driver, scope, item.key);
      if (own) {
        add(item.key, own, "root");
        continue;
      }
      for (const table of await tablesBelow(driver, item.key)) add(item.key, table, "contains");
    }
  }
  if (destination !== undefined && op !== "delete") {
    const into = await enclosingTable(driver, scope, destination);
    if (into) add(destination, into, "into");
  }
  return changes;
}

/* ---- Reading a table's metadata ---------------------------------------------------------- */

export type LakeTableInfo = LakeRoot & {
  name?: string;
  description?: string;
  /** Delta: the latest version. Iceberg: the current snapshot id. */
  version?: string;
  /** Delta: protocol versions. Iceberg: format version. */
  formatVersion?: string;
  lastUpdated?: string | null;
  files: number | null;
  bytes: number | null;
  rows: number | null;
  partitionColumns: string[];
  columns: { name: string; type: string; nullable?: boolean }[];
  properties: { key: string; value: string }[];
  features: string[];
  history: { version: string; timestamp: string | null; operation: string; summary: string }[];
  /** Iceberg's recorded location — moving the folder breaks it. */
  location?: string;
  notes: string[];
};

const HISTORY = 20;
const JSON_MAX = 16 * 1024 * 1024;
const checkpointBudget = () => Math.max(1, Number(process.env.JVINU_LAKE_CHECKPOINT_MAX_MB) || 256) * 1024 * 1024;

const isMissing = (error: unknown) => error instanceof StorageUserError && error.status === 404;

/** A small text object, or null when it doesn't exist. Gzipped when the name says so. */
async function readText(driver: StorageDriver, key: string, max = JSON_MAX): Promise<string | null> {
  try {
    const prefix = await readPrefix(driver, key, max, /\.gz(\.|$)/.test(key));
    if (!prefix.complete) throw new StorageUserError(`“${nameOf(key)}” is too large to read.`, 422);
    return new TextDecoder().decode(prefix.bytes);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** JSON.parse, keeping integers too large for a JavaScript number (Iceberg snapshot ids) as text. */
export function parseJson(text: string): unknown {
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) && Number.isInteger(value) && context?.source ? context.source : value;
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

const iso = (ms: unknown) => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

const count = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export async function tableInfo(driver: StorageDriver, table: LakeRoot): Promise<LakeTableInfo> {
  switch (table.format) {
    case "delta":
      return deltaInfo(driver, table);
    case "iceberg":
      return icebergInfo(driver, table);
    case "hudi":
      return hudiInfo(driver, table);
  }
}

/* ---- Delta Lake --------------------------------------------------------------------------- */

type DeltaAction = {
  add?: { path: string; size?: number; stats?: string | null; deletionVector?: { cardinality?: number } | null };
  remove?: { path: string };
  metaData?: DeltaMetadata;
  protocol?: { minReaderVersion?: number; minWriterVersion?: number; readerFeatures?: string[]; writerFeatures?: string[] };
  commitInfo?: { timestamp?: number; operation?: string; operationMetrics?: Record<string, unknown>; engineInfo?: string; userName?: string };
  sidecar?: { path: string };
};
type DeltaMetadata = {
  id?: string;
  name?: string | null;
  description?: string | null;
  schemaString?: string;
  partitionColumns?: string[];
  configuration?: Record<string, string> | [string, string][] | null;
  createdTime?: number;
};

const pad = (n: number, width = 20) => String(n).padStart(width, "0");

function recordsOf(add: NonNullable<DeltaAction["add"]>): number | null {
  if (!add.stats) return null;
  try {
    const stats = JSON.parse(add.stats) as { numRecords?: number };
    if (typeof stats.numRecords !== "number") return null;
    return stats.numRecords - (add.deletionVector?.cardinality ?? 0);
  } catch {
    return null;
  }
}

function parseActions(text: string): DeltaAction[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as DeltaAction;
      } catch {
        return {};
      }
    });
}

/** Spark's JSON type names as one compact line: struct<a: int>, array<string>, map<string, long>. */
export function sparkType(type: unknown): string {
  if (typeof type === "string") return type;
  const t = type as { type?: string; fields?: { name: string; type: unknown }[]; elementType?: unknown; keyType?: unknown; valueType?: unknown };
  switch (t?.type) {
    case "struct":
      return `struct<${(t.fields ?? []).map((field) => `${field.name}: ${sparkType(field.type)}`).join(", ")}>`;
    case "array":
      return `array<${sparkType(t.elementType)}>`;
    case "map":
      return `map<${sparkType(t.keyType)}, ${sparkType(t.valueType)}>`;
    default:
      return String(t?.type ?? "unknown");
  }
}

const METRICS: [RegExp, (n: number) => string][] = [
  [/^(numOutputRows|num_added_rows|numTargetRowsInserted)$/, (n) => `${plural(n, "row")} written`],
  [/^(numDeletedRows|num_deleted_rows|numTargetRowsDeleted)$/, (n) => `${plural(n, "row")} deleted`],
  [/^(numUpdatedRows|num_updated_rows|numTargetRowsUpdated)$/, (n) => `${plural(n, "row")} updated`],
  [/^(numAddedFiles|num_added_files|numFilesAdded|numFiles)$/, (n) => `${plural(n, "file")} added`],
  [/^(numRemovedFiles|num_removed_files|numFilesRemoved)$/, (n) => `${plural(n, "file")} removed`],
];

function deltaSummary(metrics: Record<string, unknown> | undefined): string {
  if (!metrics) return "";
  const parts: string[] = [];
  for (const [pattern, say] of METRICS) {
    const entry = Object.entries(metrics).find(([key]) => pattern.test(key));
    const n = entry ? Number(entry[1]) : NaN;
    if (Number.isFinite(n) && n > 0) parts.push(say(n));
  }
  return parts.join(" · ");
}

const configEntries = (configuration: DeltaMetadata["configuration"]): [string, string][] =>
  !configuration ? [] : Array.isArray(configuration) ? configuration : Object.entries(configuration);

/** The checkpoint `_last_checkpoint` names — or, without one, the newest found by listing. */
async function findCheckpoint(
  driver: StorageDriver,
  log: string,
): Promise<{ version: number; files: string[] }> {
  const pointer = await readText(driver, `${log}_last_checkpoint`, 1024 * 1024);
  if (pointer) {
    try {
      const last = JSON.parse(pointer) as { version: number; parts?: number; v2Checkpoint?: { path: string } };
      if (last.v2Checkpoint?.path) return { version: last.version, files: [log + last.v2Checkpoint.path] };
      if (last.parts && last.parts > 1)
        return {
          version: last.version,
          files: Array.from({ length: last.parts }, (_, i) => `${log}${pad(last.version)}.checkpoint.${pad(i + 1, 10)}.${pad(last.parts!, 10)}.parquet`),
        };
      return { version: last.version, files: [`${log}${pad(last.version)}.checkpoint.parquet`] };
    } catch {
      // Unreadable pointer: fall back to listing.
    }
  }
  // No pointer: list the log (bounded) and take the newest complete checkpoint.
  const { keys, truncated } = await driver.listKeys(log, 50_000);
  if (truncated) throw new StorageUserError("This Delta table's log is too long to read without a _last_checkpoint file.", 422);
  // version → the checkpoint's files, and how many there should be
  const checkpoints = new Map<number, { files: string[]; expected: number }>();
  for (const key of keys) {
    const name = key.slice(log.length);
    let match: RegExpExecArray | null;
    if ((match = /^(\d{20})\.checkpoint(\.[0-9a-f-]{36})?\.(parquet|json)$/.exec(name))) {
      checkpoints.set(Number(match[1]), { files: [key], expected: 1 });
    } else if ((match = /^(\d{20})\.checkpoint\.(\d{10})\.(\d{10})\.parquet$/.exec(name))) {
      const entry = checkpoints.get(Number(match[1])) ?? { files: [], expected: Number(match[3]) };
      entry.files.push(key);
      checkpoints.set(Number(match[1]), entry);
    }
  }
  const complete = [...checkpoints.entries()].filter(([, entry]) => entry.files.length === entry.expected).sort(([a], [b]) => b - a);
  return complete.length ? { version: complete[0][0], files: complete[0][1].files.sort() } : { version: -1, files: [] };
}

/** Commit JSON files from `from` upward, until one doesn't exist. */
async function commitsFrom(driver: StorageDriver, log: string, from: number, limit = 1000): Promise<{ version: number; actions: DeltaAction[] }[]> {
  const out: { version: number; actions: DeltaAction[] }[] = [];
  for (let base = from; out.length < limit; base += 8) {
    const batch = await Promise.all(Array.from({ length: 8 }, (_, i) => readText(driver, `${log}${pad(base + i)}.json`)));
    for (let i = 0; i < batch.length; i++) {
      const text = batch[i];
      if (text === null) return out;
      out.push({ version: base + i, actions: parseActions(text) });
    }
  }
  return out;
}

async function deltaInfo(driver: StorageDriver, table: LakeRoot): Promise<LakeTableInfo> {
  const log = `${table.root}_delta_log/`;
  const notes: string[] = [];
  const checkpoint = await findCheckpoint(driver, log);
  const READ_AT_ONCE = 1000;
  const commits = await commitsFrom(driver, log, checkpoint.version + 1, READ_AT_ONCE);
  if (commits.length >= READ_AT_ONCE)
    notes.push(`Shows the table as of version ${commits[commits.length - 1].version}: newer commits weren't read, because the last checkpoint is far behind.`);
  if (checkpoint.version < 0 && !commits.length) throw new StorageUserError("This Delta table's log has no commits.", 422);
  const latest = commits.length ? commits[commits.length - 1].version : checkpoint.version;

  let metadata: DeltaMetadata | undefined;
  let protocol: DeltaAction["protocol"];
  let files = 0;
  let bytes = 0;
  let rows: number | null = 0;

  // Replay the commits after the checkpoint: what they add and what they take away.
  const added = new Map<string, { size: number; records: number | null }>();
  const touched = new Set<string>();
  for (const commit of commits) {
    for (const action of commit.actions) {
      if (action.add) {
        added.set(action.add.path, { size: Number(action.add.size ?? 0), records: recordsOf(action.add) });
        touched.add(action.add.path);
      } else if (action.remove) {
        added.delete(action.remove.path);
        touched.add(action.remove.path);
      } else if (action.metaData) metadata = action.metaData;
      else if (action.protocol) protocol = action.protocol;
    }
  }

  if (checkpoint.version >= 0) {
    const fromCheckpoint = await readDeltaCheckpoint(driver, log, checkpoint.files, touched);
    files += fromCheckpoint.files;
    bytes += fromCheckpoint.bytes;
    rows = fromCheckpoint.rows;
    metadata ??= fromCheckpoint.metadata;
    protocol ??= fromCheckpoint.protocol;
  }
  for (const file of added.values()) {
    files += 1;
    bytes += file.size;
    rows = rows === null || file.records === null ? null : rows + file.records;
  }
  if (!metadata) throw new StorageUserError("This Delta table's log has no table metadata.", 422);

  // The latest commits, for history: those already read, plus older ones still in the log.
  const byVersion = new Map(commits.map((commit) => [commit.version, commit.actions]));
  const wanted = Array.from({ length: Math.min(HISTORY, latest + 1) }, (_, i) => latest - i).filter((v) => !byVersion.has(v));
  const older = await Promise.all(wanted.map((v) => readText(driver, `${log}${pad(v)}.json`).catch(() => null)));
  wanted.forEach((v, i) => {
    if (older[i] !== null) byVersion.set(v, parseActions(older[i]!));
  });
  const history = [...byVersion.entries()]
    .sort(([a], [b]) => b - a)
    .slice(0, HISTORY)
    .map(([version, actions]) => {
      const info = actions.find((action) => action.commitInfo)?.commitInfo;
      return {
        version: String(version),
        timestamp: iso(info?.timestamp),
        operation: info?.operation ?? "—",
        summary: [deltaSummary(info?.operationMetrics), info?.userName].filter(Boolean).join(" · "),
      };
    });

  let columns: LakeTableInfo["columns"] = [];
  try {
    const schema = JSON.parse(metadata.schemaString ?? "{}") as { fields?: { name: string; type: unknown; nullable?: boolean }[] };
    columns = (schema.fields ?? []).map((field) => ({ name: field.name, type: sparkType(field.type), nullable: field.nullable }));
  } catch {
    notes.push("The table's schema couldn't be read.");
  }
  const properties = configEntries(metadata.configuration).map(([key, value]) => ({ key, value: String(value) }));
  const mapping = properties.find((p) => p.key === "delta.columnMapping.mode")?.value;
  if (mapping && mapping !== "none")
    notes.push("This table uses column mapping: its data files name columns differently from the table, so previewing a file shows other names.");
  if (rows === null) notes.push("Some files carry no row counts, so the table's row total isn't known.");

  return {
    ...table,
    name: metadata.name ?? undefined,
    description: metadata.description ?? undefined,
    version: String(latest),
    formatVersion:
      protocol?.minReaderVersion !== undefined ? `reader ${protocol.minReaderVersion}, writer ${protocol.minWriterVersion ?? "?"}` : undefined,
    lastUpdated: history[0]?.timestamp ?? null,
    files,
    bytes,
    rows,
    partitionColumns: metadata.partitionColumns ?? [],
    columns,
    properties,
    features: [...new Set([...(protocol?.readerFeatures ?? []), ...(protocol?.writerFeatures ?? [])])].sort(),
    history,
    notes,
  };
}

/**
 * A checkpoint holds the table's state at its version: one row per live file, plus the table's
 * metadata. DuckDB reads it — classic, multi-part or v2 (with sidecars) — and totals the
 * files the later commits didn't touch.
 */
async function readDeltaCheckpoint(
  driver: StorageDriver,
  log: string,
  keys: string[],
  touched: Set<string>,
): Promise<{ files: number; bytes: number; rows: number | null; metadata?: DeltaMetadata; protocol?: DeltaAction["protocol"] }> {
  return withDuck(async (db, scratch) => {
    let budget = checkpointBudget();
    const download = async (key: string, name: string) => {
      const prefix = await readPrefix(driver, key, budget + 1, false);
      if (!prefix.complete) throw new StorageUserError("This Delta table's checkpoint is too large to summarise.", 422);
      budget -= prefix.bytes.length;
      const file = scratch.file(name);
      await writeFile(file, prefix.bytes, { mode: 0o600 });
      return file;
    };

    try {
      await db.run(`CREATE TEMP TABLE files (path VARCHAR, size BIGINT, records BIGINT)`);
      let metadata: DeltaMetadata | undefined;
      let protocol: DeltaAction["protocol"];
      const parquet: string[] = [];
      const sidecars: string[] = [];

      for (const [index, key] of keys.entries()) {
        if (key.endsWith(".json")) {
          // A v2 checkpoint in JSON: actions, one per line — sidecars hold the files.
          const text = await readText(driver, key);
          if (text === null) throw new StorageUserError("This Delta table's checkpoint is missing.", 422);
          const rows: (string | number | null)[][] = [];
          for (const action of parseActions(text)) {
            if (action.metaData) metadata = action.metaData;
            else if (action.protocol) protocol = action.protocol;
            else if (action.sidecar) sidecars.push(action.sidecar.path);
            else if (action.add) rows.push([action.add.path, Number(action.add.size ?? 0), recordsOf(action.add)]);
          }
          await insertFiles(db, rows);
        } else parquet.push(await download(key, `checkpoint-${index}.parquet`));
      }

      if (parquet.length) {
        const list = `[${parquet.map(literal).join(", ")}]`;
        const source = `read_parquet(${list}, union_by_name=true)`;
        const fields = new Set((await db.describe(`SELECT add.* FROM ${source}`).catch(() => [])).map((c) => c.name));
        const records = fields.has("stats")
          ? `TRY_CAST(json_extract_string(add.stats, '$.numRecords') AS BIGINT)`
          : fields.has("stats_parsed")
            ? `TRY_CAST(add.stats_parsed.numRecords AS BIGINT)`
            : `NULL::BIGINT`;
        const deleted = fields.has("deletionVector") ? `COALESCE(add.deletionVector.cardinality, 0)` : `0`;
        if (fields.size)
          await db.run(`INSERT INTO files SELECT add.path, add.size, ${records} - ${deleted} FROM ${source} WHERE add IS NOT NULL`);
        const columns = new Set((await db.describe(`SELECT * FROM ${source}`)).map((c) => c.name));
        if (!metadata && columns.has("metaData")) {
          const row = (await db.all(`SELECT to_json(metaData) FROM ${source} WHERE metaData IS NOT NULL LIMIT 1`)).rows[0];
          if (row) metadata = JSON.parse(String(row[0])) as DeltaMetadata;
        }
        if (!protocol && columns.has("protocol")) {
          const row = (await db.all(`SELECT to_json(protocol) FROM ${source} WHERE protocol IS NOT NULL LIMIT 1`)).rows[0];
          if (row) protocol = JSON.parse(String(row[0]));
        }
        if (columns.has("sidecar")) {
          for (const row of (await db.all(`SELECT sidecar.path FROM ${source} WHERE sidecar IS NOT NULL`)).rows) sidecars.push(String(row[0]));
        }
      }

      if (sidecars.length) {
        const files: string[] = [];
        for (const [index, path] of sidecars.entries()) files.push(await download(`${log}_sidecars/${path}`, `sidecar-${index}.parquet`));
        const source = `read_parquet([${files.map(literal).join(", ")}], union_by_name=true)`;
        const fields = new Set((await db.describe(`SELECT add.* FROM ${source}`)).map((c) => c.name));
        const records = fields.has("stats") ? `TRY_CAST(json_extract_string(add.stats, '$.numRecords') AS BIGINT)` : `NULL::BIGINT`;
        const deleted = fields.has("deletionVector") ? `COALESCE(add.deletionVector.cardinality, 0)` : `0`;
        await db.run(`INSERT INTO files SELECT add.path, add.size, ${records} - ${deleted} FROM ${source} WHERE add IS NOT NULL`);
      }

      await db.run(`CREATE TEMP TABLE touched (path VARCHAR)`);
      if (touched.size) {
        const appender = await db.connection.createAppender("touched", "main", "temp");
        for (const path of touched) {
          appender.appendVarchar(path);
          appender.endRow();
        }
        appender.closeSync();
      }
      const totals = (
        await db.all(
          `SELECT count(*), coalesce(sum(size), 0), sum(records), count(records) FROM files WHERE path NOT IN (SELECT path FROM touched)`,
        )
      ).rows[0];
      const files = Number(totals[0]);
      return {
        files,
        bytes: Number(totals[1]),
        rows: Number(totals[3]) === files ? Number(totals[2] ?? 0) : null,
        metadata,
        protocol,
      };
    } catch (error) {
      throw duckProblem(error, "Delta checkpoint");
    }
  }, 120_000);
}

async function insertFiles(db: Duck, rows: (string | number | null)[][]) {
  if (!rows.length) return;
  const appender = await db.connection.createAppender("files", "main", "temp");
  for (const [path, size, records] of rows) {
    appender.appendVarchar(String(path));
    appender.appendBigInt(BigInt(size ?? 0));
    if (records === null) appender.appendNull();
    else appender.appendBigInt(BigInt(records));
    appender.endRow();
  }
  appender.closeSync();
}

/* ---- Apache Iceberg ----------------------------------------------------------------------- */

type IcebergField = { id: number; name: string; required?: boolean; type: unknown };
type IcebergSchema = { "schema-id"?: number; fields?: IcebergField[] };
type IcebergSnapshot = {
  "snapshot-id": string | number;
  "parent-snapshot-id"?: string | number;
  "timestamp-ms"?: number;
  summary?: Record<string, string>;
};
type IcebergMetadata = {
  "format-version"?: number;
  "table-uuid"?: string;
  location?: string;
  "last-updated-ms"?: number;
  "current-schema-id"?: number;
  schemas?: IcebergSchema[];
  schema?: IcebergSchema;
  "default-spec-id"?: number;
  "partition-specs"?: { "spec-id": number; fields: { name: string; transform: string; "source-id": number }[] }[];
  "partition-spec"?: { name: string; transform: string; "source-id": number }[];
  properties?: Record<string, string>;
  "current-snapshot-id"?: string | number;
  snapshots?: IcebergSnapshot[];
};

/** Iceberg's JSON types as one compact line. */
export function icebergType(type: unknown): string {
  if (typeof type === "string") return type;
  const t = type as { type?: string; fields?: IcebergField[]; element?: unknown; key?: unknown; value?: unknown };
  switch (t?.type) {
    case "struct":
      return `struct<${(t.fields ?? []).map((field) => `${field.name}: ${icebergType(field.type)}`).join(", ")}>`;
    case "list":
      return `array<${icebergType(t.element)}>`;
    case "map":
      return `map<${icebergType(t.key)}, ${icebergType(t.value)}>`;
    default:
      return String(t?.type ?? "unknown");
  }
}

/** Which metadata file is current: version-hint.text when present, else the highest version. */
async function currentIcebergMetadata(driver: StorageDriver, root: string): Promise<{ key: string; notes: string[] }> {
  const folder = `${root}metadata/`;
  const notes: string[] = [];
  const hint = await readText(driver, `${folder}version-hint.text`, 1024).catch(() => null);
  const { files, truncated } = await driver.inventory(folder, 20);
  const candidates = files.filter((file) => ICEBERG_METADATA.test(file.key));
  if (hint !== null && /^\s*\d+\s*$/.test(hint)) {
    const named = candidates.find((file) => new RegExp(`(^|/)v${hint.trim()}(\\.gz)?\\.metadata\\.json(\\.gz)?$`).test(file.key));
    if (named) return { key: named.key, notes };
  }
  if (!candidates.length) throw new StorageUserError(truncated ? "This Iceberg table's metadata folder is too large to search." : "This Iceberg table has no metadata file.", 422);
  const versionOf = (key: string) => {
    const name = key.slice(folder.length);
    const match = /^v(\d+)\./.exec(name) ?? /^(\d+)-/.exec(name);
    return match ? Number(match[1]) : -1;
  };
  candidates.sort((a, b) => versionOf(b.key) - versionOf(a.key) || (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
  notes.push("Shows the newest metadata file in the folder. If a catalog manages this table, the catalog decides which one is current.");
  return { key: candidates[0].key, notes };
}

async function icebergInfo(driver: StorageDriver, table: LakeRoot): Promise<LakeTableInfo> {
  const { key, notes } = await currentIcebergMetadata(driver, table.root);
  const text = await readText(driver, key);
  if (text === null) throw new StorageUserError("This Iceberg table's metadata file disappeared. Try again.", 409);
  let metadata: IcebergMetadata;
  try {
    metadata = parseJson(text) as IcebergMetadata;
  } catch {
    throw new StorageUserError("This Iceberg table's metadata isn't valid JSON.", 422);
  }

  const schema =
    metadata.schemas?.find((s) => s["schema-id"] === metadata["current-schema-id"]) ?? metadata.schema ?? metadata.schemas?.[metadata.schemas.length - 1];
  const names = new Map<number, string>();
  const walk = (fields: IcebergField[] | undefined, path: string) => {
    for (const field of fields ?? []) {
      names.set(field.id, path + field.name);
      const nested = field.type as { type?: string; fields?: IcebergField[] };
      if (nested && typeof nested === "object" && nested.type === "struct") walk(nested.fields, `${path}${field.name}.`);
    }
  };
  walk(schema?.fields, "");
  const spec = metadata["partition-specs"]?.find((s) => s["spec-id"] === metadata["default-spec-id"])?.fields ?? metadata["partition-spec"] ?? [];
  const partitionColumns = spec.map((field) => {
    const source = names.get(field["source-id"]) ?? field.name;
    return field.transform === "identity" ? source : `${field.transform}(${source})`;
  });

  const snapshots = metadata.snapshots ?? [];
  const current = snapshots.find((s) => String(s["snapshot-id"]) === String(metadata["current-snapshot-id"]));
  const summary = current?.summary ?? {};
  const history = [...snapshots]
    .sort((a, b) => Number(b["timestamp-ms"] ?? 0) - Number(a["timestamp-ms"] ?? 0))
    .slice(0, HISTORY)
    .map((snapshot) => {
      const s = snapshot.summary ?? {};
      const parts = [
        Number(s["added-records"]) > 0 ? `${plural(Number(s["added-records"]), "row")} added` : "",
        Number(s["deleted-records"]) > 0 ? `${plural(Number(s["deleted-records"]), "row")} deleted` : "",
        Number(s["added-data-files"]) > 0 ? `${plural(Number(s["added-data-files"]), "file")} added` : "",
        Number(s["deleted-data-files"]) > 0 ? `${plural(Number(s["deleted-data-files"]), "file")} removed` : "",
      ].filter(Boolean);
      return { version: String(snapshot["snapshot-id"]), timestamp: iso(snapshot["timestamp-ms"]), operation: s.operation ?? "—", summary: parts.join(" · ") };
    });
  if (!current) notes.push("The table has no current snapshot: it holds no data yet.");

  return {
    ...table,
    version: current ? String(current["snapshot-id"]) : undefined,
    formatVersion: metadata["format-version"] !== undefined ? `v${metadata["format-version"]}` : undefined,
    lastUpdated: iso(metadata["last-updated-ms"]),
    files: current ? count(summary["total-data-files"]) : 0,
    bytes: current ? count(summary["total-files-size"]) : 0,
    rows: current ? count(summary["total-records"]) : 0,
    partitionColumns,
    columns: (schema?.fields ?? []).map((field) => ({ name: field.name, type: icebergType(field.type), nullable: !field.required })),
    properties: Object.entries(metadata.properties ?? {}).map(([k, value]) => ({ key: k, value: String(value) })),
    features: [],
    history,
    location: metadata.location,
    notes,
  };
}

/* ---- Apache Hudi -------------------------------------------------------------------------- */

async function hudiInfo(driver: StorageDriver, table: LakeRoot): Promise<LakeTableInfo> {
  const text = (await readText(driver, `${table.root}.hoodie/hoodie.properties`, 1024 * 1024)) ?? "";
  const props = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*([^#=\s][^=]*?)\s*=\s*(.*)$/.exec(line);
    if (match) props.set(match[1], match[2].trim());
  }
  return {
    ...table,
    name: props.get("hoodie.table.name"),
    formatVersion: props.get("hoodie.table.version") ? `v${props.get("hoodie.table.version")}` : undefined,
    files: null,
    bytes: null,
    rows: null,
    partitionColumns: (props.get("hoodie.table.partition.fields") ?? "").split(",").filter(Boolean),
    columns: [],
    properties: [...props.entries()].filter(([k]) => /table\.(type|recordkey|precombine|base\.file\.format)/.test(k)).map(([k, value]) => ({ key: k, value })),
    features: [],
    history: [],
    notes: ["jvinu recognises Hudi tables to protect them, but doesn't read their timeline yet."],
  };
}
