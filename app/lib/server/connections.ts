import "server-only";
import { randomUUID } from "node:crypto";
import { openWith, sealWith } from "./crypto";
import { db } from "./db";
import { readLegacyConnections } from "./legacy";
import type { ConnectionSettings } from "../connection-settings";

function parseSettings(raw: string | null | undefined): ConnectionSettings {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as ConnectionSettings) : {};
  } catch {
    return {};
  }
}

/**
 * Where bundled storage is reachable from outside (a tunnel, a reverse proxy), if anywhere.
 * Only then can it hand out links; otherwise its files are served through this app.
 */
export function storagePublicUrl(): string | null {
  const raw = process.env.JVINU_STORAGE_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin + url.pathname.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

export type ProviderKind = "s3" | "azure" | "gcs" | "oci" | "dropbox" | "onedrive";
/** What the user picked. S3-compatible clouds run on the S3 driver with their own endpoint. */
export type PresetId = ProviderKind | "r2" | "wasabi" | "b2" | "spaces" | "scaleway" | "storj" | "minio" | "garage";

/** Why the server, not a user, owns a connection: bundled Garage, or storage bought from a seller. */
export type Managed = "bundled-storage" | "cloud-storage";

export type S3Credentials = { kind: "s3"; accessKeyId: string; secretAccessKey: string };
export type AzureCredentials = { kind: "azure"; accountName: string; accountKey: string };
export type GcsCredentials = {
  kind: "gcs";
  projectId?: string;
  /** From a service-account key. Optional only against an emulator. */
  clientEmail?: string;
  privateKey?: string;
};
export type OciCredentials = {
  kind: "oci";
  namespace: string;
  tenancy: string;
  user: string;
  fingerprint: string;
  privateKey: string;
  passphrase?: string;
};
export type DropboxCredentials = {
  kind: "dropbox";
  appKey: string;
  /** From the PKCE code exchange; lasts until the user revokes the app. */
  refreshToken: string;
  /** The account's email, shown as the connection hint. */
  account?: string;
};
export type OneDriveCredentials = {
  kind: "onedrive";
  /** The Application (client) ID of the user's app registration in Microsoft Entra. */
  clientId: string;
  /** "common", "consumers", "organizations", or a tenant ID / domain. */
  tenant: string;
  /** From the device-code sign-in. Microsoft replaces it on every use; the newest is kept. */
  refreshToken: string;
  /** The account's sign-in name, shown as the connection hint. */
  account?: string;
};
export type Credentials =
  | S3Credentials
  | AzureCredentials
  | GcsCredentials
  | OciCredentials
  | DropboxCredentials
  | OneDriveCredentials;

/** What the server keeps. Never serialised to the client. */
export type StoredConnection = {
  id: string;
  presetId: PresetId;
  name: string;
  /** Bucket; container on Azure; root folder ("/", "/Photos") on Dropbox and OneDrive. */
  bucket: string;
  region: string;
  /** Set for emulators and S3-compatible services; absent means the provider's public cloud. */
  endpoint?: string;
  credentials: Credentials;
  /** When set, every write is refused on the server. */
  readOnly: boolean;
  /** Set on connections the server created itself; users can't delete them or change their keys. */
  managed?: Managed;
  /** Overrides list prices in the cost estimate, USD per GB-month. */
  pricePerGb?: number;
  /** Non-secret options: download rate, encryption at rest, public URL, share bucket. */
  settings?: ConnectionSettings;
  /**
   * jvinu encryption (rclone crypt): the key material derived from the user's passphrase.
   * Chosen when connecting and fixed for the connection's life. Never sent to the client.
   */
  crypt?: { key: Buffer };
  createdBy: string;
  createdAt: string;
};

/** What the client is allowed to see. */
export type PublicConnection = {
  id: string;
  presetId: PresetId;
  name: string;
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyHint: string;
  canShareLinks: boolean;
  readOnly: boolean;
  managed: boolean;
  pricePerGb?: number;
  settings: ConnectionSettings;
  /** Files are encrypted by jvinu before they leave this server. */
  encrypted: boolean;
  createdAt: string;
};

type Row = {
  id: string;
  preset_id: string;
  name: string;
  bucket: string;
  region: string;
  endpoint: string | null;
  credentials: string;
  read_only: number | boolean;
  managed: string | null;
  price_per_gb: string | null;
  settings: string | null;
  crypt: string | null;
  created_by: string;
  created_at: string;
};

export const MAX_CONNECTIONS = 100;
const PURPOSE = "connection-credentials";
const CRYPT_PURPOSE = "connection-crypt";

type SealedCrypt = { format: "rclone-crypt"; key: string };
const sealCrypt = (crypt: StoredConnection["crypt"], id: string) =>
  crypt ? sealWith(CRYPT_PURPOSE, { format: "rclone-crypt", key: crypt.key.toString("base64url") } satisfies SealedCrypt, id) : null;
function openCrypt(sealed: string | null, id: string): StoredConnection["crypt"] {
  if (!sealed) return undefined;
  const { key } = openWith<SealedCrypt>(CRYPT_PURPOSE, sealed, id);
  return { key: Buffer.from(key, "base64url") };
}

function fromRow(row: Row): StoredConnection | null {
  try {
    return {
      id: row.id,
      presetId: row.preset_id as PresetId,
      name: row.name,
      bucket: row.bucket,
      region: row.region,
      endpoint: row.endpoint ?? undefined,
      credentials: openWith<Credentials>(PURPOSE, row.credentials, row.id),
      readOnly: Boolean(Number(row.read_only)),
      managed: (row.managed as Managed | null) ?? undefined,
      pricePerGb: row.price_per_gb === null || row.price_per_gb === undefined ? undefined : Number(row.price_per_gb),
      settings: parseSettings(row.settings),
      crypt: openCrypt(row.crypt, row.id),
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  } catch {
    // Only happens if JVINU_SECRET changed: the row can't be opened, so leave it out.
    console.error(`[connections] can't decrypt connection ${row.id} — was JVINU_SECRET changed?`);
    return null;
  }
}

export async function listConnections(): Promise<StoredConnection[]> {
  const rows = await (await db()).all<Row>(`select * from connections order by created_at`);
  return rows.map(fromRow).filter((connection): connection is StoredConnection => connection !== null);
}

export async function getConnection(id: string): Promise<StoredConnection | undefined> {
  const row = await (await db()).get<Row>(`select * from connections where id = ?`, [id]);
  return row ? (fromRow(row) ?? undefined) : undefined;
}

export async function nameTaken(name: string, exceptId?: string): Promise<boolean> {
  const row = await (await db()).get<{ id: string }>(`select id from connections where lower(name) = lower(?)`, [name]);
  return Boolean(row && row.id !== exceptId);
}

export async function countConnections(): Promise<number> {
  const row = await (await db()).get<{ n: number | string }>(`select count(*) as n from connections`);
  return Number(row?.n ?? 0);
}

export async function insertConnection(connection: StoredConnection): Promise<void> {
  await (await db()).run(
    `insert into connections (id, preset_id, name, bucket, region, endpoint, credentials, read_only, managed, settings, crypt, created_by, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      connection.id,
      connection.presetId,
      connection.name,
      connection.bucket,
      connection.region,
      connection.endpoint ?? null,
      sealWith(PURPOSE, connection.credentials, connection.id),
      connection.readOnly ? 1 : 0,
      connection.managed ?? null,
      JSON.stringify(connection.settings ?? {}),
      sealCrypt(connection.crypt, connection.id),
      connection.createdBy,
      connection.createdAt,
    ],
  );
}

export async function updateConnection(
  id: string,
  patch: { name?: string; readOnly?: boolean; pricePerGb?: number | null; settings?: ConnectionSettings },
): Promise<boolean> {
  const database = await db();
  let changed = 0;
  if (patch.settings !== undefined)
    changed += await database.run(`update connections set settings = ? where id = ?`, [JSON.stringify(patch.settings), id]);
  if (patch.pricePerGb !== undefined)
    changed += await database.run(`update connections set price_per_gb = ? where id = ?`, [
      patch.pricePerGb === null ? null : String(patch.pricePerGb),
      id,
    ]);
  if (patch.name !== undefined) changed += await database.run(`update connections set name = ? where id = ?`, [patch.name, id]);
  if (patch.readOnly !== undefined)
    changed += await database.run(`update connections set read_only = ? where id = ?`, [patch.readOnly ? 1 : 0, id]);
  return changed > 0;
}

/** There's one share bucket: marking a connection as it unmarks any other. */
export async function clearOtherShareTargets(keepId: string): Promise<void> {
  const database = await db();
  const rows = await database.all<Pick<Row, "id" | "settings">>(`select id, settings from connections where id <> ?`, [keepId]);
  for (const row of rows) {
    const settings = parseSettings(row.settings);
    if (!settings.shareTarget) continue;
    delete settings.shareTarget;
    await database.run(`update connections set settings = ? where id = ?`, [JSON.stringify(settings), row.id]);
  }
}

export async function findManaged(managed: Managed): Promise<StoredConnection | undefined> {
  return (await managedRow(managed))?.connection;
}

/**
 * The managed connection's row, even when it can't be decrypted (JVINU_SECRET changed):
 * the server can then re-seal it with fresh keys instead of adding a second one.
 */
export async function managedRow(managed: Managed): Promise<{ id: string; connection?: StoredConnection } | undefined> {
  const row = await (await db()).get<Row>(`select * from connections where managed = ?`, [managed]);
  return row ? { id: row.id, connection: fromRow(row) ?? undefined } : undefined;
}

/** For server-owned connections only: point one at new keys or a new endpoint. */
export async function retarget(
  id: string,
  target: Pick<StoredConnection, "bucket" | "region" | "endpoint" | "credentials">,
): Promise<void> {
  await (await db()).run(`update connections set bucket = ?, region = ?, endpoint = ?, credentials = ? where id = ?`, [
    target.bucket,
    target.region,
    target.endpoint ?? null,
    sealWith(PURPOSE, target.credentials, id),
    id,
  ]);
}

/**
 * Re-seals a connection's credentials in place — for providers whose tokens change as
 * they're used (OneDrive's refresh token), not for edits a user makes.
 */
export async function saveCredentials(id: string, credentials: Credentials): Promise<void> {
  await (await db()).run(`update connections set credentials = ? where id = ?`, [sealWith(PURPOSE, credentials, id), id]);
}

export async function deleteConnection(id: string): Promise<boolean> {
  return (await (await db()).run(`delete from connections where id = ?`, [id])) > 0;
}

export function newConnectionId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

/**
 * Pulls connections saved by earlier versions (inside this browser) into the database,
 * once. Names that already exist get a suffix rather than being dropped.
 */
export async function importLegacy(createdBy: string): Promise<number> {
  const legacy = await readLegacyConnections();
  if (!legacy) return 0;
  let imported = 0;
  for (const old of legacy.list) {
    if (await getConnection(old.id)) continue;
    let name = old.name;
    for (let n = 2; await nameTaken(name); n++) name = `${old.name} (${n})`;
    await insertConnection({ ...old, name, readOnly: false, createdBy, createdAt: old.createdAt ?? new Date().toISOString() });
    imported++;
  }
  await legacy.cleanup();
  return imported;
}

function withoutPublicBase(settings: ConnectionSettings): ConnectionSettings {
  const rest = { ...settings };
  delete rest.publicBaseUrl;
  return rest;
}

function mask(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}••••••${value.slice(-4)}` : "••••";
}

function hintFor(credentials: Credentials): string {
  switch (credentials.kind) {
    case "s3":
      return mask(credentials.accessKeyId);
    case "azure":
      return credentials.accountName;
    case "gcs":
      return credentials.clientEmail ?? "no key (emulator)";
    case "oci":
      return `${credentials.namespace} · ${mask(credentials.fingerprint)}`;
    case "dropbox":
      return credentials.account ?? `app ${mask(credentials.appKey)}`;
    case "onedrive":
      return credentials.account ?? `app ${mask(credentials.clientId)}`;
  }
}

export function toPublic(connection: StoredConnection): PublicConnection {
  const c = connection.credentials;
  return {
    id: connection.id,
    presetId: connection.presetId,
    name: connection.name,
    bucket: connection.bucket,
    region: connection.region,
    endpoint: connection.endpoint,
    accessKeyHint: hintFor(c),
    // Encrypted files can only be read through this app, so the provider can't link to them.
    canShareLinks: connection.crypt
      ? false
      : connection.presetId === "garage"
        ? Boolean(storagePublicUrl())
        : c.kind === "s3" || (c.kind === "azure" && !connection.endpoint) || (c.kind === "gcs" && Boolean(c.privateKey)),
    // The public demo changes nothing, whatever a connection's own setting says.
    readOnly: connection.readOnly || process.env.JVINU_DEMO === "1",
    managed: Boolean(connection.managed),
    pricePerGb: connection.pricePerGb,
    // A public base URL means nothing for ciphertext: ignored on encrypted connections.
    settings: connection.crypt ? withoutPublicBase(connection.settings ?? {}) : (connection.settings ?? {}),
    encrypted: Boolean(connection.crypt),
    createdAt: connection.createdAt,
  };
}
