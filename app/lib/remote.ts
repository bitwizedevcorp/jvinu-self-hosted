import type { ConnectionSettings } from "./connection-settings";
import type { PlanView } from "./storage-plan";
import type { XrayReport } from "./xray";

/** One place the signed-in person is signed in. */
export type DeviceSession = { id: string; current: boolean; device: string; createdAt: string; expiresAt: string };
import { describeFile, type Bucket, type Provider, type StorageNode } from "./storage";
import type { DataPreview, LakeRoot, LakeTableInfo, TableChange } from "./data-types";
import { isFolderRoot, PROVIDERS, type PresetId } from "./providers";

/** Mirrors PublicConnection on the server — no secrets ever reach the client. */
export type RemoteConnection = {
  id: string;
  presetId: PresetId;
  name: string;
  bucket: string;
  region: string;
  /** Present for S3-compatible services; absent means AWS. */
  endpoint?: string;
  accessKeyHint: string;
  /** False when links can only be served through this app (OCI, Dropbox, OneDrive, GCS emulator). */
  canShareLinks: boolean;
  /** The server refuses every write on a read-only connection. */
  readOnly: boolean;
  /** Created by the server (bundled storage): it can't be disconnected here. */
  managed: boolean;
  /** A rate the user set, USD per GB-month, instead of list prices. */
  pricePerGb?: number;
  /** Non-secret per-connection options. */
  settings: ConnectionSettings;
  /** jvinu encryption: files are encrypted before they leave the server (rclone crypt). */
  encrypted: boolean;
  createdAt: string;
};

type Usage = { objects: number; bytes: number };
/** A bucket's (or folder's) make-up, from one flat listing. Mirrors the analytics route. */
export type Analytics = {
  prefix: string;
  scannedAt: string;
  truncated: boolean;
  objects: number;
  bytes: number;
  oldest: string | null;
  newest: string | null;
  byClass: ({ storageClass: string | null } & Usage)[];
  byKind: ({ kind: import("./storage").PreviewKind } & Usage)[];
  byFolder: ({ folder: string } & Usage)[];
  byMonth: ({ month: string } & Usage)[];
  largest: { key: string; size: number; lastModified: string | null; storageClass: string | null }[];
};

/** Space on the volume behind bundled storage, or a paid plan's quota. Uploads stop at `blockAt` (a share of total). */
export type DiskStatus = { total: number; available: number; used: number; ratio: number; level: "ok" | "warn" | "full"; blockAt: number };

export type RemoteListing = {
  folders: string[];
  files: {
    key: string;
    size: number;
    lastModified: string | null;
    etag: string | null;
    storageClass: string | null;
  }[];
  /** Present when the folder has more entries than this page. */
  nextToken?: string;
};

/** An app-issued share link, as its owner sees it. Mirrors the share routes. */
export type ShareLink = {
  id: string;
  connectionId: string;
  key: string;
  name: string;
  size: number | null;
  createdAt: string;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloads: number;
  hasPassword: boolean;
  revokedAt: string | null;
  lastDownloadAt: string | null;
  state: "active" | "expired" | "used-up" | "revoked";
  /** "/s/<token>"; null if the server can no longer open the token. */
  path: string | null;
  /** The full link when the server knows its public address. */
  url: string | null;
  /** Served from a copy in the share bucket: which connection, and whether the copy is there yet. */
  copy: { connectionId: string; status: "copying" | "ready" | "failed" } | null;
};

/** The address to hand out: the server's public one if set, else wherever this page is open. */
export const shareUrlOf = (link: ShareLink): string | null => link.url ?? (link.path ? `${window.location.origin}${link.path}` : null);

/** Mirrors app/lib/server/compare.ts. */
export type CompareEntry = { path: string; size: number; lastModified: string | null };
export type Comparison = {
  left: { files: number; bytes: number; truncated: boolean };
  right: { files: number; bytes: number; truncated: boolean };
  onlyLeft: CompareEntry[];
  onlyRight: CompareEntry[];
  different: { path: string; left: CompareEntry; right: CompareEntry; reason: "size" | "checksum" }[];
  counts: { onlyLeft: number; onlyRight: number; different: number; same: number };
  bytes: { onlyLeft: number; onlyRight: number; different: number };
  checksums: boolean;
};

/** A query's answer. Mirrors app/lib/server/data/sql.ts. */
export type SqlResult = {
  columns: { name: string; type: string }[];
  rows: (string | null)[][];
  truncated: boolean;
  files: string[];
  bytesRead: number;
  elapsedMs: number;
};

/** A note on a folder, shared by everyone. Mirrors app/lib/server/notes.ts. */
export type FolderNote = { prefix: string; body: string; updatedBy: string; updatedAt: string };

/** One line of a connection's history. Mirrors activity.ts. */
export type ActivityEntry = {
  id: string;
  action:
    | "connected"
    | "connection-renamed"
    | "read-only"
    | "settings"
    | "uploaded"
    | "folder-created"
    | "deleted"
    | "copied"
    | "moved"
    | "renamed"
    | "metadata"
    | "copied-out"
    | "copied-in"
    | "exported"
    | "note"
    | "shared"
    | "unshared"
    | "link-downloaded"
    | "zipped";
  actor: { name: string; via?: string; you: boolean };
  /** For a run of the same thing (twelve uploads, say), the latest time and the first. */
  at: string;
  since: string;
  folder: string;
  target: string | null;
  destination: string | null;
  /** The keys it was about (up to 50); `count` says how many there were in all. */
  items: string[];
  count: number;
  size: number | null;
  detail: Record<string, unknown>;
  job: { status: Job["status"]; done: number; total: number; failed: number; error: string | null } | null;
};
export type ActivityPage = { entries: ActivityEntry[]; next: string | null; recordingSince: string; keepDays: number };

export type OperationItem = { key: string; kind: "file" | "folder" };
export type OperationRequest =
  | { op: "delete"; items: OperationItem[] }
  | { op: "copy" | "move"; items: OperationItem[]; destination: string }
  | { op: "rename"; items: [OperationItem]; name: string }
  | { op: "metadata"; items: OperationItem[]; change: MetadataChange };

/** One metadata edit; fields left out stay as they are. Mirrors the drivers' MetadataChange. */
export type MetadataChange = {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  storageClass?: string;
  tags?: Record<string, string>;
};
export type MetadataSupport = { contentType: boolean; cacheControl: boolean; contentDisposition: boolean; tags: boolean; storageClasses: string[] };

/**
 * A failed request, with the server's status and whole answer: some refusals carry more
 * than a message (a 409 "lake-table" lists the tables a change would touch).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: { error?: string; code?: string; [key: string]: unknown },
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The tables a refused change would touch, when that's why it was refused. */
export function tableChangesOf(error: unknown): TableChange[] | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.body.code !== "lake-table") return null;
  return Array.isArray(error.body.tables) ? (error.body.tables as TableChange[]) : null;
}

/* ---- Session: every write carries the session's CSRF token ---------------------- */

let csrf: string | null = null;

function signedOut(): never {
  // A full page load on purpose: it drops all in-memory state, CSRF token included.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/login");
  throw new Error("Signed out.");
}

async function csrfToken(force = false): Promise<string> {
  if (csrf && !force) return csrf;
  const response = await fetch("/api/session", { cache: "no-store" });
  if (response.status === 401) signedOut();
  const data = (await response.json().catch(() => ({}))) as { csrf?: string; error?: string };
  if (!response.ok || !data.csrf) throw new Error(data.error ?? "Couldn't check your session.");
  csrf = data.csrf;
  return csrf;
}

async function call<T>(input: string, init: RequestInit = {}, retried = false): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") headers.set("x-csrf-token", await csrfToken());
  const response = await fetch(input, { cache: "no-store", ...init, headers });
  if (response.status === 401) signedOut();
  // A 403 on a write can just mean the token rotated (signed in elsewhere): refresh once.
  if (response.status === 403 && method !== "GET" && !retried) {
    await csrfToken(true);
    return call<T>(input, init, true);
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 207) throw new ApiError(data.error ?? `Request failed (${response.status})`, response.status, data);
  return data as T;
}

const json = (body: unknown): RequestInit => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  list: () => call<{ connections: RemoteConnection[] }>("/api/connections").then((d) => d.connections),

  /** Field names follow the server's connect route; each cloud sends its own. */
  create: (input: Record<string, string | boolean | undefined>) =>
    call<{ connection: RemoteConnection }>("/api/connections", { method: "POST", ...json(input) }).then((d) => d.connection),

  update: (
    id: string,
    patch: { name?: string; readOnly?: boolean; pricePerGb?: number | null; settings?: { [K in keyof ConnectionSettings]?: ConnectionSettings[K] | null } },
  ) =>
    call<{ connection: RemoteConnection }>(`/api/connections/${id}`, { method: "PATCH", ...json(patch) }).then((d) => d.connection),

  remove: (id: string) => call<void>(`/api/connections/${id}`, { method: "DELETE" }),

  objects: (id: string, prefix: string, token?: string) =>
    call<RemoteListing>(
      `/api/connections/${id}/objects?prefix=${encodeURIComponent(prefix)}${token ? `&token=${encodeURIComponent(token)}` : ""}`,
    ),

  folder: (id: string, prefix: string, folder: string) =>
    call<{ created: string }>(`/api/connections/${id}/objects`, { method: "POST", ...json({ prefix, folder }) }),

  /** Starts the operation as a background job; quick problems (conflicts, names) throw. */
  operation: (id: string, request: OperationRequest, acknowledgeTables = false) =>
    call<{ job: Job }>(`/api/connections/${id}/operations`, {
      method: "POST",
      ...json(acknowledgeTables ? { ...request, acknowledgeTables: true } : request),
    }).then((d) => d.job),

  /** Runs one read-only query over files in the bucket; the first 1,000 rows come back. */
  sql: (id: string, sql: string) => call<SqlResult>(`/api/connections/${id}/sql`, { method: "POST", ...json({ sql }) }),

  /** Saves a query's whole result as a file, on this connection or another. */
  sqlExport: (
    id: string,
    input: { sql: string; format: "csv" | "parquet" | "json"; targetConnectionId: string; key: string; acknowledgeTables?: boolean },
  ) => call<{ rows: number; bytes: number; connectionId: string; key: string }>(`/api/connections/${id}/sql/export`, { method: "POST", ...json(input) }),

  /**
   * Copies to another connection as a job: selected items into a folder, or — after a
   * comparison — files by their path inside two folders.
   */
  transfer: (
    id: string,
    input:
      | { targetConnectionId: string; items: OperationItem[]; destination: string; acknowledgeTables?: boolean }
      | { targetConnectionId: string; paths: string[]; sourcePrefix: string; targetPrefix: string; acknowledgeTables?: boolean },
  ) => call<{ job: Job; targetConnectionId: string }>(`/api/connections/${id}/transfer`, { method: "POST", ...json(input) }),

  /** Two folders side by side, on one connection or two. */
  compare: (left: { connectionId: string; prefix: string }, right: { connectionId: string; prefix: string }) =>
    call<Comparison>("/api/compare", { method: "POST", ...json({ left, right }) }),

  /** What this connection can change on its objects (null: nothing, or read-only). */
  metadataSupport: (id: string) => call<{ support: MetadataSupport | null }>(`/api/connections/${id}/metadata`).then((d) => d.support),

  /** The note on a folder (null: none), and which folders right inside it have one. */
  note: (id: string, prefix: string) =>
    call<{ note: FolderNote | null; children: string[] }>(`/api/connections/${id}/notes?prefix=${encodeURIComponent(prefix)}`),

  /** Writes a folder's note; an empty body removes it. */
  setNote: (id: string, prefix: string, body: string) =>
    call<{ note: FolderNote | null }>(`/api/connections/${id}/notes`, { method: "PUT", ...json({ prefix, body }) }).then((d) => d.note),

  /** A data file's columns and first rows (Parquet, CSV, JSON, Avro), read from part of the file. */
  dataPreview: (id: string, key: string, refresh = false) =>
    call<DataPreview>(`/api/connections/${id}/data?key=${encodeURIComponent(key)}${refresh ? "&refresh=1" : ""}`),

  /** The Delta, Iceberg or Hudi table this folder is or sits in (null: none); `details` reads its metadata. */
  table: (id: string, prefix: string, details = false, refresh = false) =>
    call<{ table: LakeRoot | LakeTableInfo | null }>(
      `/api/connections/${id}/table?prefix=${encodeURIComponent(prefix)}${details ? "&details=1" : ""}${refresh ? "&refresh=1" : ""}`,
    ),

  job: (id: string) => call<{ job: Job }>(`/api/jobs/${id}`).then((d) => d.job),
  jobs: () => call<{ jobs: Job[] }>("/api/jobs").then((d) => d.jobs),
  cancelJob: (id: string) => call<{ ok: true }>(`/api/jobs/${id}/cancel`, { method: "POST" }),

  disk: (id: string) => call<DiskStatus>(`/api/connections/${id}/disk`),

  /** One object's metadata, including how it's encrypted at rest. */
  head: (id: string, key: string) =>
    call<{
      size?: number;
      contentType?: string;
      cacheControl?: string | null;
      contentDisposition?: string | null;
      etag?: string | null;
      storageClass?: string | null;
      encryption: { state: "encrypted" | "unencrypted" | "unknown"; keys?: string; detail?: string };
    }>(`/api/connections/${id}/head?key=${encodeURIComponent(key)}`),

  /** This user's stars, shared links and recent files, saved on the server. */
  items: () => call<{ items: SavedItem[] }>("/api/me/items").then((d) => d.items),

  setItem: (item: { kind: SavedItem["kind"]; connectionId: string; key: string; on: boolean; meta?: Partial<SavedItem["meta"]> }) =>
    call<{ ok: true }>("/api/me/items", { method: "POST", ...json(item) }),

  search: (id: string, query: string, prefix = "") =>
    call<SearchResult>(`/api/connections/${id}/search?q=${encodeURIComponent(query)}&prefix=${encodeURIComponent(prefix)}`),

  joinWaitlist: (entry: { email: string; size?: string; note?: string }) =>
    call<{ ok: true }>("/api/waitlist", { method: "POST", ...json(entry) }),

  updateProfile: (profile: { name: string; email: string }) => call<{ ok: true }>("/api/me/profile", { method: "PATCH", ...json(profile) }),
  uploadAvatar: (image: Blob) =>
    call<{ avatar: string }>("/api/me/avatar", { method: "PUT", headers: { "content-type": image.type || "application/octet-stream" }, body: image }),
  removeAvatar: () => call<void>("/api/me/avatar", { method: "DELETE" }),

  sessions: () => call<{ sessions: DeviceSession[] }>("/api/me/sessions"),
  endSession: (id: string) => call<void | { signedOut: number }>(`/api/me/sessions?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  twoFactor: () => call<{ enabled: boolean; recoveryCodesLeft: number | null }>("/api/auth/two-factor"),
  startTwoFactor: () => call<{ secret: string; uri: string }>("/api/auth/two-factor", { method: "POST", ...json({ action: "start" }) }),
  confirmTwoFactor: (code: string) =>
    call<{ recoveryCodes: string[] }>("/api/auth/two-factor", { method: "POST", ...json({ action: "confirm", code }) }),
  disableTwoFactor: (code: string) => call<{ ok: true }>("/api/auth/two-factor", { method: "POST", ...json({ action: "disable", code }) }),

  storagePlan: () => call<PlanView>("/api/storage-plan"),
  buyStorage: (blocks: number, billing: "month" | "year" = "month") =>
    call<{ checkoutUrl: string }>("/api/storage-plan", { method: "POST", ...json({ blocks, billing }) }),
  syncStoragePlan: () => call<PlanView>("/api/storage-plan/sync", { method: "POST" }),
  storagePortal: () => call<{ url: string }>("/api/storage-plan/portal", { method: "POST" }),

  /** Storage X-Ray: waste, public access and possible secrets for one connection. */
  xray: (id: string, refresh = false) => call<XrayReport>(`/api/connections/${id}/xray${refresh ? "?refresh=1" : ""}`),

  analytics: (id: string, prefix: string, refresh = false) =>
    call<Analytics>(`/api/connections/${id}/analytics?prefix=${encodeURIComponent(prefix)}${refresh ? "&refresh=1" : ""}`),

  stats: (id: string, prefix: string) =>
    call<{ objects: number; bytes: number; lastModified: string | null; truncated: boolean }>(
      `/api/connections/${id}/stats?prefix=${encodeURIComponent(prefix)}`,
    ),

  /** `expiresIn` (seconds) only matters for links the provider signs. */
  url: (id: string, key: string, download = false, expiresIn = 3600) =>
    call<{ url: string; shareable: boolean; expiresAt: string | null }>(
      `/api/connections/${id}/url?key=${encodeURIComponent(key)}${download ? "&download=1" : ""}&expires=${expiresIn}`,
    ),

  /** Plans a zip of files and folders (keys under `base`); the archive then downloads from `url`. */
  zip: (id: string, input: { items: OperationItem[]; base: string; name: string }) =>
    call<{ url: string; name: string; files: number; bytes: number; byClass: { storageClass: string | null; bytes: number }[]; archived: number }>(
      `/api/connections/${id}/zip`,
      { method: "POST", ...json(input) },
    ),

  /** This person's share links, newest first. */
  shares: () => call<{ links: ShareLink[] }>("/api/shares").then((d) => d.links),

  /**
   * expiresIn in seconds (null: never); maxDownloads null: no limit. fromShareBucket copies
   * the file to the share bucket first; jobId is that copy's job (null when one was reused).
   */
  createShare: (
    id: string,
    input: { key: string; expiresIn: number | null; maxDownloads: number | null; password?: string; fromShareBucket?: boolean },
  ) => call<{ link: ShareLink; jobId: string | null }>(`/api/connections/${id}/shares`, { method: "POST", ...json(input) }),

  revokeShare: (shareId: string) => call<{ link: ShareLink }>(`/api/shares/${shareId}`, { method: "DELETE" }).then((d) => d.link),

  /** A page of a connection's history, newest first; pass `next` from one page for the one after. */
  activity: (id: string, prefix: string, before?: string | null) =>
    call<ActivityPage>(
      `/api/connections/${id}/activity?prefix=${encodeURIComponent(prefix)}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    ),

  logout: () => fetch("/api/auth/logout", { method: "POST" }),

  /** Changes the admin password chosen in the browser; every other session is signed out. */
  changePassword: (current: string, password: string) =>
    call<{ ok: true; signedOut: number }>("/api/auth/password", { method: "POST", ...json({ current, password }) }),

  /** Starts a OneDrive sign-in: a code to enter at Microsoft, and a handle to send with Connect. */
  oneDriveSignIn: (clientId: string, tenant: string) =>
    call<{ userCode: string; verificationUri: string; expiresIn: number; handle: string }>("/api/sign-in/onedrive", {
      method: "POST",
      ...json({ clientId, tenant }),
    }),

  /**
   * Streams one file to the server, which streams it on to the cloud. XHR rather than
   * fetch, because only XHR reports upload progress.
   */
  upload(id: string, key: string, file: File, onProgress: (loaded: number) => void, acknowledgeTables = false) {
    let request: XMLHttpRequest | null = null;
    const done = csrfToken().then(
      (token) =>
        new Promise<void>((resolve, reject) => {
          request = new XMLHttpRequest();
          request.open("PUT", `/api/connections/${id}/upload?key=${encodeURIComponent(key)}${acknowledgeTables ? "&acknowledgeTables=1" : ""}`);
          request.setRequestHeader("x-csrf-token", token);
          if (file.type) request.setRequestHeader("content-type", file.type);
          request.upload.onprogress = (event) => onProgress(event.loaded);
          request.onload = () => {
            if (request!.status === 401) signedOut();
            if (request!.status >= 200 && request!.status < 300) return resolve();
            let body: { error?: string } = {};
            try {
              body = JSON.parse(request!.responseText) as { error?: string };
            } catch {}
            reject(new ApiError(body.error ?? `Upload failed (${request!.status})`, request!.status, body));
          };
          request.onerror = () => reject(new Error("The connection dropped during the upload."));
          request.onabort = () => reject(new Error("Cancelled."));
          request.send(file);
        }),
    );
    return { done, cancel: () => request?.abort() };
  },
};

export function bucketIdFor(connection: RemoteConnection): string {
  // A folder root (Dropbox, OneDrive, Google Drive) is a path that may hold ":" or "|", which node IDs use as separators.
  return `${connection.id}/${isFolderRoot(connection.presetId) ? connection.presetId : connection.bucket}`;
}

/** Folder roots are paths: show the service's name for the whole account, else the folder's. */
function bucketNames(connection: RemoteConnection): { name: string; title: string } {
  if (!isFolderRoot(connection.presetId)) return { name: connection.bucket, title: connection.bucket };
  const whole = PROVIDERS[connection.presetId].service;
  if (connection.bucket === "/") return { name: whole, title: whole };
  return { name: connection.bucket.split("/").pop() ?? connection.bucket, title: connection.bucket };
}

export function connectionToProvider(connection: RemoteConnection): Provider {
  return {
    id: connection.id,
    name: connection.name,
    locked: true,
    presetId: connection.presetId,
    accessKeyHint: connection.accessKeyHint,
    endpoint: connection.endpoint,
    readOnly: connection.readOnly,
    managed: connection.managed,
    encrypted: connection.encrypted,
    buckets: [
      {
        id: bucketIdFor(connection),
        ...bucketNames(connection),
        region: connection.region,
        nodes: [],
        remote: { connectionId: connection.id },
      } satisfies Bucket,
    ],
  };
}

export function prefixOf(path: string[]): string {
  return path.length ? `${path.join("/")}/` : "";
}

export function keyOf(node: StorageNode): string {
  return [...node.path, node.name].join("/") + (node.kind === "folder" ? "/" : "");
}

/** Images the server makes thumbnails of; matches THUMBNAILABLE in thumbs.ts. */
const THUMBNAILABLE = /\.(jpe?g|png|gif|webp|avif|tiff?|heic|heif)$/i;
const THUMB_SOURCE_LIMIT = 50 * 1024 * 1024;

/**
 * A 512 px thumbnail for an image node, or null when there won't be one. The URL names
 * the object's version (its ETag), so a changed file gets a fresh thumbnail and an
 * unchanged one comes from the browser's cache.
 */
export function thumbUrlFor(node: StorageNode): string | null {
  if (node.kind !== "file" || !THUMBNAILABLE.test(node.name) || (node.size ?? 0) > THUMB_SOURCE_LIMIT) return null;
  const bucketId = node.id.slice(0, node.id.indexOf(":"));
  const connectionId = bucketId.slice(0, bucketId.indexOf("/"));
  const version = node.etag ?? `${node.size ?? 0}-${node.modified}`;
  return `/api/connections/${connectionId}/thumb?key=${encodeURIComponent(keyOf(node))}&v=${encodeURIComponent(version)}`;
}

const STORAGE_CLASSES: Record<string, string> = {
  STANDARD: "Standard",
  STANDARD_IA: "Infrequent Access",
  ONEZONE_IA: "One Zone-IA",
  INTELLIGENT_TIERING: "Intelligent-Tiering",
  GLACIER: "Glacier",
  GLACIER_IR: "Glacier Instant Retrieval",
  DEEP_ARCHIVE: "Deep Archive",
  REDUCED_REDUNDANCY: "Reduced Redundancy",
  EXPRESS_ONEZONE: "Express One Zone",
};

/** One S3 listing level → the app's object model. */
/** A folder node from its prefix ("a/b/"), wherever in the bucket it is. */
export function folderNode(bucketId: string, prefix: string): StorageNode {
  const segments = prefix.slice(0, -1).split("/");
  const name = segments.pop() ?? prefix;
  return {
    id: `${bucketId}:${[...segments, name].join("/")}`,
    name,
    kind: "folder",
    type: "Folder",
    size: null,
    // Folders have no timestamp of their own.
    modified: "",
    path: segments,
    preview: "folder",
  };
}

/** A file node from a listed object, wherever in the bucket it is. */
export function fileNode(bucketId: string, file: RemoteListing["files"][number]): StorageNode {
  const segments = file.key.split("/");
  const name = segments.pop() ?? file.key;
  const descriptor = describeFile(name);
  return {
    id: `${bucketId}:${file.key}`,
    name,
    kind: "file",
    type: descriptor.type,
    size: file.size,
    modified: file.lastModified ? file.lastModified.slice(0, 10) : "",
    path: segments,
    preview: descriptor.preview,
    storageClass: file.storageClass ? (STORAGE_CLASSES[file.storageClass] ?? file.storageClass) : "Standard",
    storageClassId: file.storageClass ?? undefined,
    etag: file.etag ?? undefined,
  };
}

export function listingToNodes(bucketId: string, _path: string[], listing: RemoteListing): StorageNode[] {
  return [...listing.folders.map((prefix) => folderNode(bucketId, prefix)), ...listing.files.map((file) => fileNode(bucketId, file))];
}

/** A copy, move, rename or delete running (or run) on the server. Mirrors jobs.ts. */
export type Job = {
  id: string;
  connectionId: string;
  /** "share-copy" puts one file in the share bucket; its progress is counted in bytes. */
  op: "delete" | "copy" | "move" | "rename" | "metadata" | "transfer" | "share-copy";
  label: string;
  status: "running" | "done" | "failed" | "cancelled" | "interrupted";
  total: number;
  done: number;
  failed: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A star, shared link or recent file, as the server keeps it for this user. */
export type SavedItem = {
  kind: "star" | "shared" | "recent" | "team";
  connectionId: string;
  key: string;
  meta: {
    kind: "file" | "folder";
    size?: number | null;
    lastModified?: string | null;
    storageClass?: string | null;
    etag?: string | null;
    expiresAt?: string | null;
    /** Team pins: who pinned it. */
    by?: string | null;
  };
  at: string;
};

/** The node a saved item stands for, without its folder having been listed. */
export function savedNode(bucketId: string, item: SavedItem): StorageNode {
  if (item.meta.kind === "folder") return folderNode(bucketId, item.key.endsWith("/") ? item.key : `${item.key}/`);
  return fileNode(bucketId, {
    key: item.key,
    size: item.meta.size ?? 0,
    lastModified: item.meta.lastModified ?? null,
    etag: item.meta.etag ?? null,
    storageClass: item.meta.storageClass ?? null,
  });
}

/** What's worth keeping about a node, so it can be shown again later. */
export function metaOf(node: StorageNode): SavedItem["meta"] {
  return {
    kind: node.kind,
    size: node.size,
    lastModified: node.modified || null,
    storageClass: node.storageClass ?? null,
    etag: node.etag ?? null,
  };
}

/** Server search over a whole bucket: matching folders and files, anywhere in it. */
export type SearchResult = { files: RemoteListing["files"]; folders: string[]; total: number; truncated: boolean };

export function searchToNodes(bucketId: string, result: SearchResult): StorageNode[] {
  return [...result.folders.map((prefix) => folderNode(bucketId, prefix)), ...result.files.map((file) => fileNode(bucketId, file))];
}
