import "server-only";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DuckDBConnection } from "@duckdb/node-api";
import { eachLimit, StorageUserError, type StorageDriver } from "../drivers/types";
import { Duck, scratchRoot } from "./duck";

/**
 * SQL over files in a bucket, on any provider. A query names files the way DuckDB does —
 * FROM 'sales/2024/*.parquet' — and those names are bucket paths. jvinu finds the
 * matching objects, fetches them into a private scratch folder (decrypted, if the
 * connection encrypts), points the query at those copies, and runs it in a DuckDB of its
 * own that can see nothing but that folder: no other files, no network, no extensions,
 * settings locked, a memory cap and a time limit. Only one SELECT (or EXPLAIN) runs.
 */

export type SqlColumn = { name: string; type: string };
export type SqlResult = {
  columns: SqlColumn[];
  rows: (string | null)[][];
  /** True when the query returned more rows than were sent. */
  truncated: boolean;
  /** The files the query read, as bucket keys. */
  files: string[];
  bytesRead: number;
  elapsedMs: number;
};

export const SQL_MAX_LENGTH = 20_000;
export const RESULT_ROWS = 1_000;
const MAX_FILES = 5_000;

const limits = () => ({
  bytes: Number(process.env.JVINU_SQL_MAX_MB || 1024) * 1024 * 1024,
  memory: process.env.JVINU_SQL_MEMORY || "1GB",
  timeoutMs: Number(process.env.JVINU_SQL_TIMEOUT_S || 60) * 1000,
  threads: process.env.JVINU_SQL_THREADS || "2",
});

/* ---- Finding the file names in a query --------------------------------------------- */

export type Literal = { start: number; end: number; value: string };

/** Every single-quoted string in the SQL, skipping comments and quoted identifiers. */
export function stringLiterals(sql: string): Literal[] {
  const found: Literal[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      i = j + 1;
    } else if (c === "'") {
      let j = i + 1;
      let value = "";
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          value += "'";
          j += 2;
        } else if (sql[j] === "'") break;
        else value += sql[j++];
      }
      found.push({ start: i, end: j + 1, value });
      i = j + 1;
    } else i++;
  }
  return found;
}

const DATA_EXTENSION = /\.(parquet|parq|pqt|csv|tsv|tab|txt|json|jsonl|ndjson)(\.(gz|gzip|zst))?$/i;
const GLOB = /[*?[{]/;

/**
 * Whether a string in the query names files: it ends in a data extension, or it's a glob
 * with a path in it. Plain strings ('RO', '%2024%') are left alone.
 */
export function looksLikeFiles(value: string): boolean {
  if (!value || value.length > 1024 || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("/")) return false;
  if (/\s{2,}|\n/.test(value)) return false;
  return DATA_EXTENSION.test(value) || (value.includes("*") && (value.includes("/") || value.includes(".")));
}

/** A DuckDB-style glob as a regular expression: ** crosses folders, * and ? don't. */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "a/**/b" also matches "a/b".
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) out += "\\[";
      else {
        const body = glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
        out += `[${body}]`;
        i = end;
      }
    } else if (c === "{") {
      const end = glob.indexOf("}", i + 1);
      if (end === -1) out += "\\{";
      else {
        out += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((part) => part.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = end;
      }
    } else out += c.replace(/[.+^$()|\\\]]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

/** The folder a glob starts in: everything before its first wildcard, cut at a "/". */
export function staticPrefix(glob: string): string {
  const first = glob.search(GLOB);
  const fixed = first === -1 ? glob : glob.slice(0, first);
  return fixed.slice(0, fixed.lastIndexOf("/") + 1);
}

/** A key as a path under the scratch folder: never above it, whatever the key holds. */
export function localPath(dir: string, key: string): string {
  const parts = key.split("/").map((part) => (part === "" || part === "." || part === ".." ? "_" : part));
  return path.join(dir, ...parts);
}

type Match = { key: string; size: number };

async function matchFiles(driver: StorageDriver, pattern: string): Promise<Match[]> {
  if (!GLOB.test(pattern)) {
    const hit = await driver.findFile(pattern);
    return hit ? [{ key: hit.key, size: hit.size }] : [];
  }
  const regex = globToRegExp(pattern);
  const { files, truncated } = await driver.inventory(staticPrefix(pattern), Math.ceil(MAX_FILES / 1000) + 5);
  const matches = files.filter((file) => regex.test(file.key) && !file.key.endsWith("/")).map((file) => ({ key: file.key, size: file.size }));
  if (truncated && !matches.length) {
    throw new StorageUserError(`“${pattern}” starts in a folder with too many objects to scan. Start the path further down.`, 413);
  }
  return matches;
}

/* ---- Running a query ------------------------------------------------------------------ */

const MAX_ACTIVE = 2;
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await work();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

type Prepared = { dir: string; sql: string; files: string[]; bytes: number };

/** Finds and fetches every file the query names, and rewrites the query to read the copies. */
async function prepare(driver: StorageDriver, sql: string, dir: string, bucket?: string): Promise<Prepared> {
  const literals = stringLiterals(sql).filter((literal) => looksLikeFiles(stripBucket(literal.value, bucket)));
  const wanted = new Map<string, Match>();
  const replacements: { literal: Literal; local: string }[] = [];
  for (const literal of literals) {
    const pattern = stripBucket(literal.value, bucket);
    const matches = await matchFiles(driver, pattern);
    if (!matches.length) {
      throw new StorageUserError(`No files match “${literal.value}”. Paths start at the top of the bucket.`, 404);
    }
    for (const match of matches) wanted.set(match.key, match);
    if (wanted.size > MAX_FILES) throw new StorageUserError(`That query names more than ${MAX_FILES.toLocaleString("en-US")} files.`, 413);
    replacements.push({ literal, local: localPath(dir, pattern) });
  }
  if (!replacements.length) {
    throw new StorageUserError("Name the files to query in quotes, like FROM 'folder/*.parquet'. Paths start at the top of the bucket.", 400);
  }
  const files = [...wanted.values()];
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const { bytes: budget } = limits();
  if (bytes > budget) {
    throw new StorageUserError(
      `Those files add up to ${(bytes / 1024 / 1024).toFixed(0)} MB; queries here read at most ${(budget / 1024 / 1024).toFixed(0)} MB (JVINU_SQL_MAX_MB). Narrow the path.`,
      413,
    );
  }

  await eachLimit(files, 8, async (file) => {
    const target = localPath(dir, file.key);
    await mkdir(path.dirname(target), { recursive: true });
    const body = await driver.read(file.key);
    await pipeline(Readable.fromWeb(body.stream as import("node:stream/web").ReadableStream), createWriteStream(target));
  });

  // Replace from the end so earlier offsets stay right.
  let rewritten = sql;
  for (const { literal, local } of [...replacements].sort((a, b) => b.literal.start - a.literal.start)) {
    rewritten = rewritten.slice(0, literal.start) + `'${local.replace(/'/g, "''")}'` + rewritten.slice(literal.end);
  }
  return { dir, sql: rewritten, files: files.map((file) => file.key), bytes };
}

/** "s3://my-bucket/a/b.parquet" → "a/b.parquet", when it's this connection's bucket. */
function stripBucket(value: string, bucket?: string): string {
  if (!bucket) return value;
  for (const scheme of ["s3://", "gs://", "gcs://", "az://", "abfss://", "r2://"]) {
    const prefix = `${scheme}${bucket}/`;
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}

/**
 * A DuckDB that can read and write one folder and nothing else. Settings are locked
 * before the person's SQL ever reaches it.
 */
async function sandbox(dir: string): Promise<{ connection: DuckDBConnection; close: () => void }> {
  let api: typeof import("@duckdb/node-api");
  try {
    api = await import("@duckdb/node-api");
  } catch {
    throw new StorageUserError("SQL isn't available on this server: DuckDB couldn't load.", 501);
  }
  const { memory, threads } = limits();
  const spill = path.join(dir, ".spill");
  await mkdir(spill, { recursive: true });
  const instance = await api.DuckDBInstance.create(":memory:", {
    threads,
    memory_limit: memory,
    temp_directory: spill,
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
    allow_community_extensions: "false",
    enable_external_file_cache: "false",
  });
  const connection = await instance.connect();
  await connection.run("SET TimeZone = 'UTC'");
  await connection.run(`SET allowed_directories = ['${(dir + path.sep).replace(/'/g, "''")}']`);
  await connection.run("SET enable_external_access = false");
  await connection.run("SET lock_configuration = true");
  return {
    connection,
    close: () => {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

/** One SELECT, checked by DuckDB's own parser rather than by guessing at keywords. */
async function checkStatement(connection: DuckDBConnection, sql: string): Promise<"select" | "explain"> {
  const { StatementType } = await import("@duckdb/node-api");
  const extracted = await connection.extractStatements(sql);
  if (extracted.count !== 1) throw new StorageUserError("Run one statement at a time.", 400);
  const prepared = await extracted.prepare(0);
  if (prepared.statementType !== StatementType.SELECT && prepared.statementType !== StatementType.EXPLAIN) {
    throw new StorageUserError("Only queries that read run here: SELECT, WITH, FROM, DESCRIBE, SUMMARIZE or EXPLAIN.", 400);
  }
  const kind = prepared.statementType === StatementType.EXPLAIN ? "explain" : "select";
  prepared.destroySync();
  return kind;
}

function trimSql(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) throw new StorageUserError("Write a query first.", 400);
  if (trimmed.length > SQL_MAX_LENGTH) throw new StorageUserError("That query is too long.", 400);
  return trimmed;
}

/** DuckDB's message, with scratch paths turned back into bucket paths. */
function sqlProblem(error: unknown, dir: string, timedOut: boolean): StorageUserError {
  if (timedOut) return new StorageUserError(`The query ran past the ${limits().timeoutMs / 1000}-second limit and was stopped.`, 504);
  if (error instanceof StorageUserError) return error;
  // DuckDB quotes paths whole or cut short ("/tmp/…/sql-1a2b…"): either way, back to bucket paths.
  const scratch = new RegExp(`${scratchRoot().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/sql-[0-9a-f-]*(?:\\.\\.\\.)?/?`, "g");
  const message = (error instanceof Error ? error.message : String(error)).split(dir + path.sep).join("").split(dir).join("").replace(scratch, "");
  return new StorageUserError(message.split("\n").slice(0, 3).join(" ").slice(0, 600), 422);
}

/** Runs `work` in a fresh sandbox over the query's files; everything is deleted after. */
async function withQuery<T>(
  driver: StorageDriver,
  rawSql: string,
  bucket: string | undefined,
  work: (duck: Duck, prepared: Prepared, kind: "select" | "explain") => Promise<T>,
): Promise<T> {
  const sql = trimSql(rawSql);
  return slot(async () => {
    const dir = path.join(scratchRoot(), `sql-${randomUUID()}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let timedOut = false;
    let box: Awaited<ReturnType<typeof sandbox>> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      box?.connection.interrupt();
    }, limits().timeoutMs);
    try {
      const prepared = await prepare(driver, sql, dir, bucket);
      if (timedOut) throw new Error("timed out");
      box = await sandbox(dir);
      const kind = await checkStatement(box.connection, prepared.sql);
      return await work(new Duck(box.connection), prepared, kind);
    } catch (error) {
      throw sqlProblem(error, dir, timedOut);
    } finally {
      clearTimeout(timer);
      box?.close();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function runSql(driver: StorageDriver, sql: string, bucket?: string): Promise<SqlResult> {
  const started = Date.now();
  return withQuery(driver, sql, bucket, async (duck, prepared, kind) => {
    if (kind === "explain") {
      // A plan is text to read, not rows to page through.
      const plan = await duck.all(prepared.sql);
      return {
        columns: plan.columns.map((name) => ({ name, type: "VARCHAR" })),
        rows: plan.rows.map((row) => row.map((value) => (value === null ? null : String(value)))),
        truncated: false,
        files: prepared.files,
        bytesRead: prepared.bytes,
        elapsedMs: Date.now() - started,
      };
    }
    const columns = await duck.describe(`(${prepared.sql})`);
    const rows = await duck.preview(prepared.sql, RESULT_ROWS + 1, 2000);
    return {
      columns,
      rows: rows.slice(0, RESULT_ROWS),
      truncated: rows.length > RESULT_ROWS,
      files: prepared.files,
      bytesRead: prepared.bytes,
      elapsedMs: Date.now() - started,
    };
  });
}

export type ExportFormat = "csv" | "parquet" | "json";
const FORMAT_OPTIONS: Record<ExportFormat, string> = {
  csv: "FORMAT csv, HEADER true",
  parquet: "FORMAT parquet, COMPRESSION zstd",
  json: "FORMAT json",
};
const CONTENT_TYPES: Record<ExportFormat, string> = { csv: "text/csv", parquet: "application/vnd.apache.parquet", json: "application/x-ndjson" };

/**
 * The query's whole result, written as CSV, Parquet or JSON Lines and uploaded to `key` on
 * `target` — which may be another connection. Returns how many rows and bytes were saved.
 */
export async function exportSql(
  driver: StorageDriver,
  sql: string,
  bucket: string | undefined,
  format: ExportFormat,
  target: StorageDriver,
  key: string,
): Promise<{ rows: number; bytes: number }> {
  return withQuery(driver, sql, bucket, async (duck, prepared, kind) => {
    if (kind === "explain") throw new StorageUserError("Save the results of a SELECT, not a plan.", 400);
    const out = path.join(prepared.dir, `.result-${randomUUID()}.${format}`);
    const result = await duck.all(`COPY (${prepared.sql}) TO '${out.replace(/'/g, "''")}' (${FORMAT_OPTIONS[format]})`);
    const rows = Number(result.rows[0]?.[0] ?? 0);
    const { size } = await stat(out);
    const body = Readable.toWeb(createReadStream(out)) as unknown as ReadableStream<Uint8Array>;
    await target.upload(key, body, size, CONTENT_TYPES[format]);
    return { rows, bytes: size };
  });
}
