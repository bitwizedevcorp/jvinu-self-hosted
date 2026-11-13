import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";

/** One small interface over SQLite and Postgres. SQL is written with `?` placeholders. */
export interface Database {
  kind: "sqlite" | "postgres";
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Returns the number of rows changed. */
  run(sql: string, params?: unknown[]): Promise<number>;
}

/**
 * Each entry runs once, in order, recorded in schema_migrations. Plain SQL that both
 * engines accept: TEXT and INTEGER only, timestamps as ISO strings.
 */
const MIGRATIONS: string[][] = [
  [
    `create table if not exists connections (
      id text primary key,
      preset_id text not null,
      name text not null unique,
      bucket text not null,
      region text not null,
      endpoint text,
      credentials text not null,
      read_only integer not null default 0,
      created_by text not null,
      created_at text not null
    )`,
    `create table if not exists sessions (
      id text primary key,
      user_id text not null,
      user_name text not null,
      user_email text,
      provider text not null,
      csrf text not null,
      created_at text not null,
      expires_at text not null
    )`,
    `create index if not exists sessions_expires on sessions (expires_at)`,
  ],
  // Connections the server creates and owns (bundled storage): not deletable, keys not editable.
  [`alter table connections add column managed text`],
  // At most one of each managed connection (NULLs — user connections — don't collide).
  // Any extras an earlier build made become ordinary connections the user can remove.
  [
    `update connections set managed = null where managed is not null
       and id <> (select min(other.id) from connections other where other.managed = connections.managed)`,
    `create unique index if not exists connections_managed on connections (managed)`,
  ],
  // A rate (USD per GB-month) that overrides list prices in the cost estimate.
  [`alter table connections add column price_per_gb text`],
  // Per-user stars, shared links and recently opened files.
  [
    `create table if not exists user_items (
      user_id text not null,
      kind text not null,
      connection_id text not null,
      item_key text not null,
      meta text not null,
      at text not null,
      primary key (user_id, kind, connection_id, item_key)
    )`,
    `create index if not exists user_items_by_user on user_items (user_id, kind, at)`,
    `create index if not exists user_items_by_connection on user_items (connection_id, item_key)`,
  ],
  // Copies, moves, renames and deletes run as background jobs with progress.
  [
    `create table if not exists jobs (
      id text primary key,
      user_id text not null,
      connection_id text not null,
      op text not null,
      label text not null,
      status text not null,
      total integer not null default 0,
      done integer not null default 0,
      failed text not null default '[]',
      error text,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists jobs_by_user on jobs (user_id, created_at)`,
  ],
  // Non-secret per-connection options (download rate, encryption at rest, public URL,
  // share bucket), as one JSON object.
  [`alter table connections add column settings text not null default '{}'`],
  // jvinu encryption: the passphrase-derived key, sealed under the master key. Null for
  // connections whose files are stored as they are.
  [`alter table connections add column crypt text`],
  // Share links this app serves: limits, password, revocation. Only a hash of each token
  // is looked up; a copy sealed under the master key lets its owner copy the link again.
  [
    `create table if not exists share_links (
      id text primary key,
      token_hash text not null unique,
      token_sealed text not null,
      connection_id text not null,
      item_key text not null,
      created_by text not null,
      created_at text not null,
      expires_at text,
      max_downloads integer,
      download_count integer not null default 0,
      password_hash text,
      revoked_at text,
      last_download_at text,
      copy_id text,
      meta text not null default '{}'
    )`,
    `create index if not exists share_links_by_creator on share_links (created_by, created_at)`,
    `create index if not exists share_links_by_object on share_links (connection_id, item_key)`,
  ],
  // The share bucket: copies of shared files in the connection marked "share from here",
  // one per version of a file, deleted once no link needs them.
  [
    `create table if not exists share_copies (
      id text primary key,
      source_connection_id text not null,
      source_key text not null,
      source_version text not null,
      target_connection_id text not null,
      target_key text not null,
      size integer,
      status text not null,
      error text,
      job_id text,
      created_at text not null,
      ready_at text
    )`,
    `create index if not exists share_copies_by_source on share_copies (source_connection_id, source_key, source_version, target_connection_id)`,
  ],
  // Notes on folders ("don't delete — pipeline X reads this"), shared by everyone.
  [
    `create table if not exists folder_notes (
      connection_id text not null,
      prefix text not null,
      body text not null,
      updated_by text not null,
      updated_at text not null,
      primary key (connection_id, prefix)
    )`,
  ],
  // Tokens for AI agents (MCP), a jvinu Cloud feature. Unused here, but the table stays so
  // databases from versions that had it keep the same migration history.
  [
    `create table if not exists api_tokens (
      id text primary key,
      user_id text not null,
      user_name text not null,
      name text not null,
      token_hash text not null unique,
      connections text not null,
      allow_write integer not null default 0,
      created_at text not null,
      last_used_at text,
      revoked_at text
    )`,
    `create index if not exists api_tokens_by_user on api_tokens (user_id, created_at)`,
  ],
  // What happened on each connection, and who did it: see activity.ts.
  [
    `create table if not exists activity (
      id text primary key,
      connection_id text not null,
      at text not null,
      actor_id text,
      actor_name text not null,
      action text not null,
      folder text not null default '',
      target text,
      destination text,
      job_id text,
      detail text not null default '{}'
    )`,
    `create index if not exists activity_by_connection on activity (connection_id, at)`,
    `create index if not exists activity_by_time on activity (at)`,
  ],
  // Server-wide values set from the browser, such as the admin password chosen at first
  // sign-in (only its scrypt hash).
  [`create table if not exists server_settings (key text primary key, value text not null, updated_at text not null)`],
  // Storage this server sells (store/seller.ts): one row per customer's order, with the
  // bucket and its key sealed under the master key. Empty unless selling is turned on.
  [
    `create table if not exists storage_orders (
      id text primary key,
      token_hash text not null,
      status text not null,
      blocks integer not null,
      email text,
      stripe_session text,
      stripe_customer text,
      stripe_subscription text,
      target text,
      access text,
      used_bytes integer not null default 0,
      measured_at text,
      provisioning_at text,
      canceled_at text,
      delete_at text,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists storage_orders_by_subscription on storage_orders (stripe_subscription)`,
  ],
  // What each person chose to be called, their email, and whether they have a photo (the
  // image itself is a file under JVINU_DATA_DIR/avatars). Overrides what sign-in provided.
  [
    `create table if not exists user_profiles (
      user_id text primary key,
      name text,
      email text,
      avatar text,
      updated_at text not null
    )`,
  ],
  // Abuse handling: why the seller suspended an order (no access at all while set).
  [`alter table storage_orders add column suspended text`],
  // Which browser each session is, for the "Signed-in devices" list.
  [`alter table sessions add column user_agent text`],
  // Which emails each storage order's customer has been sent, so none goes twice.
  [`alter table storage_orders add column notices text not null default '[]'`],
  // Whether a storage order is billed monthly or yearly.
  [`alter table storage_orders add column billing text not null default 'month'`],
];

export function dataDir(): string {
  return process.env.JVINU_DATA_DIR || path.join(process.cwd(), ".data");
}

/**
 * node:sqlite is still marked experimental in Node 22, so loading it prints a warning —
 * which Next's dev overlay shows as a "Console Error". It's used on purpose (no native
 * dependency to build), so that one warning is dropped while it loads; every other
 * warning still goes through.
 */
async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (rest[0] === "ExperimentalWarning" && text.startsWith("SQLite is an experimental feature")) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
}

async function openSqlite(): Promise<Database> {
  const { DatabaseSync } = await loadSqlite();
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, "jvinu.db"));
  db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000; pragma foreign_keys = on;");
  const bind = (params: unknown[]) => params.map((value) => (typeof value === "boolean" ? Number(value) : value)) as never[];
  return {
    kind: "sqlite",
    all: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...bind(params)) as T[],
    get: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...bind(params)) as T | undefined,
    run: async (sql: string, params: unknown[] = []) => Number(db.prepare(sql).run(...bind(params)).changes),
  };
}

async function openPostgres(url: string): Promise<Database> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 10 });
  // `?` → `$1, $2…`, so every query is written once for both engines.
  const numbered = (sql: string) => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  };
  const bind = (params: unknown[]) => params.map((value) => (typeof value === "boolean" ? Number(value) : value));
  return {
    kind: "postgres",
    all: async <T,>(sql: string, params: unknown[] = []) => (await pool.query(numbered(sql), bind(params))).rows as T[],
    get: async <T,>(sql: string, params: unknown[] = []) => (await pool.query(numbered(sql), bind(params))).rows[0] as T | undefined,
    run: async (sql: string, params: unknown[] = []) => (await pool.query(numbered(sql), bind(params))).rowCount ?? 0,
  };
}

async function migrate(db: Database) {
  await db.run(`create table if not exists schema_migrations (version integer primary key, applied_at text not null)`);
  const done = new Set((await db.all<{ version: number }>(`select version from schema_migrations`)).map((row) => Number(row.version)));
  for (let version = 1; version <= MIGRATIONS.length; version++) {
    if (done.has(version)) continue;
    for (const statement of MIGRATIONS[version - 1]) await db.run(statement);
    await db.run(`insert into schema_migrations (version, applied_at) values (?, ?)`, [version, new Date().toISOString()]);
  }
}

// Survives dev hot-reloads, so there is one connection pool per process.
const holder = globalThis as unknown as { __jvinuDb?: Promise<Database>; __jvinuMigrations?: number };

export function db(): Promise<Database> {
  // A hot reload in development can add migrations while the database is already open.
  if (holder.__jvinuDb && holder.__jvinuMigrations !== MIGRATIONS.length) {
    const opened = holder.__jvinuDb;
    holder.__jvinuDb = opened.then(async (database) => {
      try {
        await migrate(database);
      } catch (error) {
        // Keep the open database; the new migrations are tried again on the next call.
        holder.__jvinuDb = opened;
        holder.__jvinuMigrations = undefined;
        throw error;
      }
      return database;
    });
  }
  holder.__jvinuMigrations = MIGRATIONS.length;
  holder.__jvinuDb ??= (async () => {
    const url = process.env.JVINU_DATABASE_URL;
    const database = url && /^postgres(ql)?:\/\//.test(url) ? await openPostgres(url) : await openSqlite();
    await migrate(database);
    return database;
  })().catch((error) => {
    holder.__jvinuDb = undefined; // let the next request retry
    throw error;
  });
  return holder.__jvinuDb;
}
