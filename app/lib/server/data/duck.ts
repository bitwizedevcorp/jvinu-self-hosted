import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DuckDBConnection, DuckDBInstance, DuckDBValue } from "@duckdb/node-api";
import { StorageUserError } from "../drivers/types";

/**
 * One embedded DuckDB per server process, used only on local scratch files jvinu writes
 * itself — never on a user's SQL. It's kept small and offline: one thread, a memory cap,
 * and no extension downloads.
 */

const holder = globalThis as unknown as { __jvinuDuck?: Promise<DuckDBInstance> };

/** Where scratch files live while a preview runs; each run gets its own folder. */
export const scratchRoot = () => path.join(process.env.JVINU_SCRATCH_DIR || tmpdir(), "jvinu-data");

async function instance(): Promise<DuckDBInstance> {
  holder.__jvinuDuck ??= (async () => {
    let api: typeof import("@duckdb/node-api");
    try {
      api = await import("@duckdb/node-api");
    } catch (error) {
      console.error("[data] DuckDB couldn't load", error);
      throw new StorageUserError("Data previews aren't available on this server: DuckDB couldn't load.", 501);
    }
    const root = scratchRoot();
    await mkdir(path.join(root, "spill"), { recursive: true, mode: 0o700 });
    const created = await api.DuckDBInstance.create(":memory:", {
      threads: "1",
      memory_limit: process.env.JVINU_DUCKDB_MEMORY || "512MB",
      temp_directory: path.join(root, "spill"),
      // Offline by design: everything needed (Parquet, JSON, CSV) is built in.
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
      allow_community_extensions: "false",
      // Scratch files are read once and deleted: caching their contents only costs memory.
      enable_external_file_cache: "false",
    });
    const setup = await created.connect();
    try {
      // Times print in UTC, whatever the server's own zone. Then nothing can change settings.
      await setup.run("SET GLOBAL TimeZone = 'UTC'");
      await setup.run("SET GLOBAL lock_configuration = true");
    } finally {
      setup.closeSync();
    }
    return created;
  })().catch((error) => {
    holder.__jvinuDuck = undefined;
    throw error;
  });
  return holder.__jvinuDuck;
}

/* ---- At most a couple of DuckDB jobs at once: previews are interactive, not batch work ---- */

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

let lastSweep = 0;

/** Scratch folders left behind by a crash: anything over an hour old goes. */
async function sweep(root: string) {
  if (Date.now() - lastSweep < 10 * 60_000) return;
  lastSweep = Date.now();
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (name === "spill") continue;
    const full = path.join(root, name);
    const info = await stat(full).catch(() => null);
    if (info && Date.now() - info.mtimeMs > 3_600_000) await rm(full, { recursive: true, force: true }).catch(() => {});
  }
}

export type Scratch = {
  /** A path inside this run's private folder. */
  file: (name: string) => string;
};

/**
 * Runs `work` with a DuckDB connection and a private scratch folder, both cleaned up after.
 * Queries that run past `timeoutMs` are interrupted.
 */
export async function withDuck<T>(work: (db: Duck, scratch: Scratch) => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const duck = await instance();
  return slot(async () => {
    const root = scratchRoot();
    void sweep(root);
    const dir = path.join(root, randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const connection = await duck.connect();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      connection.interrupt();
    }, timeoutMs);
    try {
      return await work(new Duck(connection), { file: (name) => path.join(dir, name.replace(/[^\w.-]/g, "_")) });
    } catch (error) {
      if (timedOut) throw new StorageUserError("That took too long to read. Try a smaller file.", 504);
      throw error;
    } finally {
      clearTimeout(timer);
      connection.closeSync();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export type Table = { columns: string[]; types: string[]; rows: unknown[][] };

/** Strings DuckDB built from SQL we wrote, quoted as identifiers or literals. */
export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
export const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

export class Duck {
  constructor(readonly connection: DuckDBConnection) {}

  async all(sql: string, params?: DuckDBValue[]): Promise<Table> {
    const reader = await this.connection.runAndReadAll(sql, params);
    return {
      columns: reader.columnNames(),
      types: reader.columnTypes().map((type) => type.toString()),
      rows: reader.getRowsJson() as unknown[][],
    };
  }

  async run(sql: string, params?: DuckDBValue[]): Promise<void> {
    await this.connection.run(sql, params);
  }

  /** Column names and DuckDB types of a query, without running it. */
  async describe(sql: string): Promise<{ name: string; type: string }[]> {
    const table = await this.all(`DESCRIBE ${sql}`);
    const name = table.columns.indexOf("column_name");
    const type = table.columns.indexOf("column_type");
    return table.rows.map((row) => ({ name: String(row[name]), type: String(row[type]) }));
  }

  /**
   * Up to `limit` rows of a query, every value rendered as DuckDB prints it — the same text
   * a SQL console would show, nested types included — and cut to `maxCell` characters.
   */
  async preview(sql: string, limit: number, maxCell = 300): Promise<(string | null)[][]> {
    const table = await this.all(`SELECT COLUMNS(*)::VARCHAR FROM (${sql}) LIMIT ${Math.max(0, Math.floor(limit))}`);
    return table.rows.map((row) =>
      row.map((value) => {
        if (value === null || value === undefined) return null;
        const text = String(value);
        return text.length > maxCell ? `${text.slice(0, maxCell)}…` : text;
      }),
    );
  }
}

/** Turns DuckDB's own errors into something a person can act on. */
export function duckProblem(error: unknown, what: string): StorageUserError {
  if (error instanceof StorageUserError) return error;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[data] ${what} failed:`, message.slice(0, 500));
  // DuckDB's messages name the problem ("Invalid Input Error: …"): keep the first line.
  const first = message.split("\n")[0].replace(/^[A-Za-z ]+Error: /, "").slice(0, 200);
  return new StorageUserError(`Couldn't read this ${what}: ${first}`, 422);
}
