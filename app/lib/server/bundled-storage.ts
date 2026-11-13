import "server-only";
import { readFileSync } from "node:fs";
import { insertConnection, managedRow, nameTaken, newConnectionId, retarget, type S3Credentials } from "./connections";
import { driverFor } from "./drivers";

/**
 * Bundled storage: the Garage server from `docker compose --profile storage`. jvinu
 * bootstraps it through Garage's admin API (layout, key, bucket) and keeps one
 * server-managed "My storage" connection pointing at it. Every step checks before it
 * creates, so restarts and re-runs change nothing.
 *
 * Enabled when JVINU_STORAGE_ADMIN_URL is set and the admin token can be read — the
 * compose file only makes the token exist when the storage profile has run.
 */
export type BundledConfig = {
  adminUrl: string;
  s3Url: string;
  token: string;
  region: string;
  bucket: string;
};

export const STORAGE_NAME = "My storage";
/** The Garage key's name. */
const KEY_NAME = "jvinu";
/** Disk thresholds: warn at 85 %, refuse uploads at 95 %. */
export const DISK_WARN = 0.85;
export const DISK_BLOCK = 0.95;

export function bundledConfig(): BundledConfig | null {
  const adminUrl = process.env.JVINU_STORAGE_ADMIN_URL?.replace(/\/+$/, "");
  if (!adminUrl) return null;
  let token = process.env.JVINU_STORAGE_ADMIN_TOKEN?.trim();
  const file = process.env.JVINU_STORAGE_ADMIN_TOKEN_FILE;
  if (!token && file) {
    try {
      token = readFileSync(file, "utf8").trim();
    } catch {
      return null; // the storage profile hasn't run: no token, no bundled storage
    }
  }
  if (!token) return null;
  return {
    adminUrl,
    s3Url: (process.env.JVINU_STORAGE_S3_URL || "http://garage:3900").replace(/\/+$/, ""),
    token,
    region: process.env.JVINU_STORAGE_REGION || "garage",
    bucket: process.env.JVINU_STORAGE_BUCKET || "my-files",
  };
}

class GarageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One admin API call. GET without a body, POST with one. */
export async function garage<T>(config: { adminUrl: string; token: string }, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${config.adminUrl}/v2/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GarageError(response.status, `Garage ${route}: ${response.status} ${text.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

type Node = { id: string; isUp: boolean; role?: { capacity?: number | null } | null; dataPartition?: { available: number; total: number } | null };

type Admin = Pick<BundledConfig, "adminUrl" | "token">;

async function thisNode(config: Admin): Promise<Node> {
  const status = await garage<{ nodes: Node[] }>(config, "GetClusterStatus");
  const node = status.nodes.find((item) => item.isUp) ?? status.nodes[0];
  if (!node) throw new Error("Garage reports no nodes yet.");
  return node;
}

/** A single-node layout: this node holds every partition. */
async function ensureLayout(config: Admin) {
  const node = await thisNode(config);
  if (node.role) return;
  const layout = await garage<{ version: number }>(config, "GetClusterLayout");
  await garage(config, "UpdateClusterLayout", {
    roles: [{ id: node.id, zone: "local", capacity: node.dataPartition?.total || 1_000_000_000_000, tags: ["jvinu"] }],
  });
  await garage(config, "ApplyClusterLayout", { version: layout.version + 1 });
}

/**
 * The access key jvinu uses, made once and found by name afterwards. Garage doesn't keep
 * names unique, so two bootstraps racing could each make one: everyone settles on the
 * oldest and removes the rest.
 */
async function ensureKey(config: Admin): Promise<S3Credentials> {
  type Listed = { id: string; name: string; created?: string | null };
  type KeyInfo = { accessKeyId: string; secretAccessKey?: string | null };
  const ours = async () =>
    (await garage<Listed[]>(config, "ListKeys"))
      .filter((key) => key.name === KEY_NAME)
      .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? "") || a.id.localeCompare(b.id));
  let keys = await ours();
  if (!keys.length) {
    await garage(config, "CreateKey", { name: KEY_NAME });
    keys = await ours();
  }
  const [keep, ...extra] = keys;
  for (const key of extra) await garage(config, `DeleteKey?id=${encodeURIComponent(key.id)}`, {}).catch(() => {});
  const info = await garage<KeyInfo>(config, `GetKeyInfo?id=${encodeURIComponent(keep.id)}&showSecretKey=true`);
  if (!info.secretAccessKey) throw new Error("Garage didn't return the key's secret.");
  return { kind: "s3", accessKeyId: info.accessKeyId, secretAccessKey: info.secretAccessKey };
}

/** A bucket by global alias, created if missing, with read/write for `accessKeyId`. */
export async function ensureBucket(config: Admin, alias: string, accessKeyId: string) {
  let bucket: { id: string };
  try {
    bucket = await garage<{ id: string }>(config, `GetBucketInfo?globalAlias=${encodeURIComponent(alias)}`);
  } catch (error) {
    if (!(error instanceof GarageError && error.status === 404)) throw error;
    bucket = await garage<{ id: string }>(config, "CreateBucket", { globalAlias: alias });
  }
  await garage(config, "AllowBucketKey", { bucketId: bucket.id, accessKeyId, permissions: { read: true, write: true, owner: true } });
  return bucket.id;
}

/** A usable single-node Garage and jvinu's key on it. Idempotent. */
export async function prepareGarage(config: Admin): Promise<S3Credentials> {
  await ensureLayout(config);
  return ensureKey(config);
}

/** Layout, key and bucket — then the connection. Safe to run any number of times. */
async function bootstrap(config: BundledConfig) {
  const credentials = await prepareGarage(config);
  await ensureBucket(config, config.bucket, credentials.accessKeyId);

  const target = { bucket: config.bucket, region: config.region, endpoint: config.s3Url, credentials };
  const row = await managedRow("bundled-storage");
  if (row) {
    const current = row.connection;
    // Unreadable (JVINU_SECRET changed) counts as different: re-sealing repairs it.
    const same =
      current !== undefined &&
      current.credentials.kind === "s3" &&
      current.credentials.accessKeyId === credentials.accessKeyId &&
      current.credentials.secretAccessKey === credentials.secretAccessKey &&
      current.endpoint === config.s3Url &&
      current.bucket === config.bucket;
    // The storage volume was reset, settings changed, or the master key did: same
    // connection, new target, sealed under the current key.
    if (!same) await retarget(row.id, target);
    return;
  }

  // Through the normal driver path: nothing is saved until the bucket can be listed.
  await driverFor({ presetId: "garage", ...target }).verify();
  let name = STORAGE_NAME;
  for (let n = 2; await nameTaken(name); n++) name = `${STORAGE_NAME} (${n})`;
  await insertConnection({
    id: newConnectionId(),
    presetId: "garage",
    name,
    ...target,
    readOnly: false,
    managed: "bundled-storage",
    createdBy: "system",
    createdAt: new Date().toISOString(),
  });
  console.info(`[storage] connected bundled storage as “${name}” (bucket ${config.bucket})`);
}

let running: Promise<boolean> | null = null;
let settled: { ok: boolean; at: number } | null = null;
let failures = 0;

/**
 * Makes sure bundled storage is set up, at most one attempt at a time. A success is final
 * for this process; a failure is retried on the next call after a short pause.
 */
export function ensureBundledStorage(): Promise<boolean> {
  const config = bundledConfig();
  if (!config) return Promise.resolve(false);
  if (settled?.ok) return Promise.resolve(true);
  if (running) return running;
  if (settled && Date.now() - settled.at < 5_000) return Promise.resolve(false);
  running = bootstrap(config)
    .then(() => {
      settled = { ok: true, at: Date.now() };
      return true;
    })
    .catch((error: unknown) => {
      settled = { ok: false, at: Date.now() };
      // Garage often starts a moment after jvinu: say so once, then quietly every 10th try.
      if (failures++ % 10 === 0) console.warn("[storage] bundled storage isn't ready yet:", (error as Error).message);
      return false;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** Waits for the bootstrap, but never longer than `ms` — a listing shouldn't hang on it. */
export async function ensureBundledStorageWithin(ms: number): Promise<void> {
  await Promise.race([ensureBundledStorage(), new Promise((resolve) => setTimeout(resolve, ms))]);
}

export type DiskStatus = {
  total: number;
  available: number;
  used: number;
  /** used / total, 0–1. */
  ratio: number;
  level: "ok" | "warn" | "full";
  /** The share of `total` at which uploads stop: 0.95 for a disk, 1 for a paid plan. */
  blockAt: number;
};

let diskCache: { at: number; value: DiskStatus } | null = null;

/** Space on the volume holding the storage data, cached for a few seconds. */
export async function storageDisk(): Promise<DiskStatus | null> {
  const config = bundledConfig();
  if (!config) return null;
  if (diskCache && Date.now() - diskCache.at < 10_000) return diskCache.value;
  const partition = (await thisNode(config)).dataPartition;
  if (!partition?.total) return null;
  const used = partition.total - partition.available;
  const ratio = used / partition.total;
  const value: DiskStatus = {
    total: partition.total,
    available: partition.available,
    used,
    ratio,
    level: ratio >= DISK_BLOCK ? "full" : ratio >= DISK_WARN ? "warn" : "ok",
    blockAt: DISK_BLOCK,
  };
  diskCache = { at: Date.now(), value };
  return value;
}

/**
 * Refuses a write that would take the storage disk to 95 % or beyond. Returns the message
 * to show, or null when there's room (or the disk can't be read — the write then decides).
 */
export async function diskBlocks(incomingBytes = 0): Promise<string | null> {
  const disk = await storageDisk().catch(() => null);
  if (!disk) return null;
  if ((disk.used + incomingBytes) / disk.total < DISK_BLOCK) return null;
  const free = (disk.available / 1024 ** 3).toFixed(1);
  return disk.ratio >= DISK_BLOCK
    ? `${STORAGE_NAME} is ${Math.floor(disk.ratio * 100)}% full (${free} GB free). Delete something before uploading more.`
    : `That would fill ${STORAGE_NAME} past 95% (${free} GB free). Free up space or upload less.`;
}

/**
 * The limit for whichever managed connection is being written to: the disk for bundled
 * storage, the quota for a paid plan. Returns the message to show, or null.
 */
export async function managedBlocks(connection: { managed?: string }, incomingBytes = 0): Promise<string | null> {
  if (connection.managed === "bundled-storage") return diskBlocks(incomingBytes);
  if (connection.managed === "cloud-storage") {
    const { planBlocks } = await import("./storage-plan");
    return planBlocks(incomingBytes);
  }
  return null;
}
