import "server-only";
import { createHash, randomInt } from "node:crypto";
import { auth as googleAuth, drive as driveApi, type drive_v3 } from "googleapis/build/src/apis/drive";
import { mimeOf } from "../mime";
import {
  eachLimit,
  networkCode,
  parseContentRange,
  rangeHeader,
  StorageUserError,
  unreachable,
  unsatisfiable,
  type FolderStats,
  type Listing,
  type ObjectHead,
  type StorageDriver,
} from "./types";

/**
 * Google Drive ("My Drive") through the googleapis client for sign-in and metadata, and
 * plain fetch for the bytes, so files of any size stream in both directions.
 *
 * A connection's "bucket" is a folder path — "/" for the whole Drive — and keys are paths
 * below it. Drive itself knows files by ID, not by path, so each key is resolved a folder
 * at a time (folder IDs are remembered briefly). Two things Drive allows that paths can't
 * express are left out of listings: names containing "/", and a second file with the same
 * name in the same folder (the oldest one is shown).
 *
 * Google Docs, Sheets, Slides and Drawings have no bytes of their own. They're listed with
 * ".pdf" added to the name and read as a PDF export, so they open like any other document.
 */
type Target = {
  /** "/" or a folder such as "/Photos". */
  root: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Google granted read-only access: a refused write says so, rather than a generic 403. */
  readOnlyAccess?: boolean;
};

/** Everything jvinu does: browse, read, upload, move, trash. */
export const GDRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
/** For a read-only connection: Google itself then refuses any change, whatever jvinu sends. */
export const GDRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** What a granted scope list allows: full access, read-only, or nothing jvinu can use. */
export function driveAccessOf(scope: string): "full" | "read" | null {
  const granted = scope.split(/\s+/);
  if (granted.includes(GDRIVE_SCOPE)) return "full";
  if (granted.includes(GDRIVE_READONLY_SCOPE)) return "read";
  return null;
}
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const NATIVE = /^application\/vnd\.google-apps\./;
/** Google's own formats that can be read as a PDF; the rest (forms, sites, shortcuts) are skipped. */
const EXPORTABLE = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.drawing",
]);
const EXPORT_EXT = ".pdf";
const EXPORT_TYPE = "application/pdf";
const FIELDS = "id,name,mimeType,size,modifiedTime,md5Checksum";
const PAGE = 1000;
/** Resumable-upload chunk: Drive wants multiples of 256 KiB. */
const CHUNK = 8 * 1024 * 1024;
const FOLDER_TTL = 60_000;

export type Node = { id: string; name: string; mimeType: string; size?: string | null; modifiedTime?: string | null; md5Checksum?: string | null };

/** "/", "/Photos", "Photos/2024/" → the canonical folder path, or null if it can't be one. */
export function driveFolder(raw: string): string | null {
  const parts = raw.trim().split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || /[\\\u0000-\u001f]/.test(part))) return null;
  const path = `/${parts.join("/")}`;
  return Buffer.byteLength(path) <= 1024 ? path : null;
}

/** A name inside a Drive search query: backslashes and single quotes are escaped. */
export const driveQuote = (name: string) => `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** The name a Drive entry is listed under, or null when a path can't express it. */
export function driveListedName(node: Pick<Node, "name" | "mimeType">): string | null {
  if (!node.name || node.name === "." || node.name === ".." || node.name.includes("/")) return null;
  if (node.mimeType === FOLDER) return node.name;
  if (!NATIVE.test(node.mimeType)) return node.name;
  return EXPORTABLE.has(node.mimeType) ? node.name + EXPORT_EXT : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const accountId = (target: Pick<Target, "clientId" | "refreshToken">) =>
  createHash("sha256").update(`${target.clientId}\n${target.refreshToken}`).digest("hex");

/* ------------------------------------------------------------------ */
/* OAuth: authorization code + PKCE with the user's own OAuth client.   */
/* Google requires the client secret for "Web application" clients.     */

type OAuthClient = InstanceType<typeof googleAuth.OAuth2>;
const clients = new Map<string, OAuthClient>();

/**
 * The client library would otherwise load its own copy of node-fetch on the server. Node's
 * fetch, looked up at call time, keeps every Google request on the same path as the rest of
 * the app (the egress guard, tests' stand-ins).
 */
const transporterOptions = { fetchImplementation: (url: string | URL, init?: RequestInit) => globalThis.fetch(url, init) };
const newClient = (clientId: string, clientSecret: string, redirectUri?: string): OAuthClient =>
  new googleAuth.OAuth2({ clientId, clientSecret, redirectUri, transporterOptions } as ConstructorParameters<typeof googleAuth.OAuth2>[0]);

function oauthFor(target: Pick<Target, "clientId" | "clientSecret" | "refreshToken">): OAuthClient {
  const id = accountId(target);
  let client = clients.get(id);
  if (!client) {
    client = newClient(target.clientId, target.clientSecret);
    client.setCredentials({ refresh_token: target.refreshToken });
    clients.set(id, client);
  }
  return client;
}

type GoogleFailure = {
  code?: number | string;
  status?: number;
  message?: string;
  response?: { status?: number; data?: { error?: string | { message?: string; errors?: { reason?: string }[] }; error_description?: string } };
  errors?: { reason?: string }[];
};

const statusOf = (error: unknown): number | undefined => {
  const e = error as GoogleFailure;
  const status = e?.response?.status ?? e?.status ?? (typeof e?.code === "number" ? e.code : Number(e?.code));
  return Number.isFinite(status) ? Number(status) : undefined;
};
const reasonOf = (error: unknown): string => {
  const e = error as GoogleFailure;
  const data = e?.response?.data?.error;
  if (typeof data === "string") return data;
  return data?.errors?.[0]?.reason ?? e?.errors?.[0]?.reason ?? "";
};
const lapsed = () => new StorageUserError("Google Drive access was revoked or has lapsed — reconnect this Drive.", 401);

/** Codes are single-use: a retry after a failed connect reuses the token it already bought. */
const exchanged = new Map<string, { refreshToken: string; readOnlyAccess: boolean; expires: number }>();

/**
 * Trades the code Google handed back for a long-lived refresh token, and says whether the
 * access granted is read-only — from what Google granted, not what the form asked for.
 */
export async function exchangeDriveCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<{ refreshToken: string; readOnlyAccess: boolean }> {
  const id = createHash("sha256").update(`${input.clientId}\n${input.code}\n${input.verifier}`).digest("hex");
  const now = Date.now();
  for (const [key, value] of exchanged) if (value.expires < now) exchanged.delete(key);
  const cached = exchanged.get(id);
  if (cached) return { refreshToken: cached.refreshToken, readOnlyAccess: cached.readOnlyAccess };

  const client = newClient(input.clientId, input.clientSecret, input.redirectUri);
  let refreshToken: string | null | undefined;
  let access: "full" | "read" | null;
  try {
    const { tokens } = await client.getToken({ code: input.code, codeVerifier: input.verifier, redirect_uri: input.redirectUri });
    refreshToken = tokens.refresh_token;
    access = driveAccessOf(tokens.scope ?? "");
    if (!access) throw new StorageUserError("Google didn't grant access to Drive. Sign in again and tick the Drive permission.", 400);
  } catch (error) {
    if (error instanceof StorageUserError) throw error;
    if (networkCode(error)) throw unreachable(undefined, "Google");
    const reason = reasonOf(error);
    if (reason === "invalid_grant") throw new StorageUserError("That sign-in code has expired or was already used — click “Sign in with Google” again.", 400);
    if (reason === "invalid_client" || reason === "unauthorized_client")
      throw new StorageUserError("Google doesn't recognise that client ID and secret. Copy both again from the OAuth client in Google Cloud.", 400);
    if (reason === "redirect_uri_mismatch")
      throw new StorageUserError(`Add ${input.redirectUri} to the OAuth client's authorised redirect URIs in Google Cloud, then sign in again.`, 400);
    console.error("[gdrive] token request failed", statusOf(error), reason);
    throw new StorageUserError("Google didn't accept the sign-in. Try again.", 502);
  }
  if (!refreshToken)
    throw new StorageUserError(
      "Google didn't grant offline access. Remove jvinu under myaccount.google.com → Security → Third-party access, then sign in again.",
      502,
    );
  const readOnlyAccess = access === "read";
  exchanged.set(id, { refreshToken, readOnlyAccess, expires: now + 10 * 60_000 });
  return { refreshToken, readOnlyAccess };
}

/* ------------------------------------------------------------------ */

function explain(error: unknown, target: Target): StorageUserError {
  if (error instanceof StorageUserError) return error;
  if (networkCode(error)) return unreachable(undefined, "Google Drive");
  const status = statusOf(error);
  const reason = reasonOf(error);
  if (reason === "invalid_grant" || status === 401) return lapsed();
  if (status === 404) return new StorageUserError("That file or folder no longer exists.", 404);
  if (status === 416) return unsatisfiable();
  if (reason === "storageQuotaExceeded") return new StorageUserError(`The Google Drive holding “${target.root}” is full.`, 507);
  if (reason === "exportSizeLimitExceeded") return new StorageUserError("This Google document is too large to export. Open it in Google Drive instead.", 413);
  if (status === 429 || /rateLimitExceeded/i.test(reason)) return new StorageUserError("Google Drive is busy — try again in a moment.", 429);
  if (reason === "accessNotConfigured")
    return new StorageUserError("Turn on the Google Drive API for this project in Google Cloud (APIs & Services → Library), then try again.", 403);
  if (target.readOnlyAccess && (status === 403 || reason === "insufficientPermissions"))
    return new StorageUserError("This Google Drive was connected with read-only access. Reconnect it without Read-only to make changes.", 403);
  if (reason === "insufficientPermissions" || reason === "insufficientFilePermissions" || reason === "appNotAuthorizedToFile")
    return new StorageUserError("Google Drive doesn't allow that here.", 403);
  if (status === 403) return new StorageUserError("Google Drive refused that request.", 403);
  console.error("[gdrive] unexpected error", status, reason || (error as Error)?.message);
  return new StorageUserError("Google Drive returned an unexpected error. Try again.", 502);
}

/** One listed entry of a folder: its name in paths, and the Drive item it stands for. */
export type FolderEntry = { name: string; folder: boolean; exported: boolean; node: Node };

/**
 * A folder's entries from all its items, oldest first — the same choices the path lookups
 * make, so a listed path always opens the listed item:
 * - a folder name: the oldest folder;
 * - a file name: the oldest stored file;
 * - "Name.pdf" for a Google document: only if no stored file has that name, then the oldest.
 * Names a path can't express (with "/", or "." and "..") are left out.
 */
export function pickEntries(nodes: Node[]): FolderEntry[] {
  const folders = new Map<string, FolderEntry>();
  const stored = new Map<string, FolderEntry>();
  const exported = new Map<string, FolderEntry>();
  for (const node of nodes) {
    const name = driveListedName(node);
    if (!name) continue;
    if (node.mimeType === FOLDER) {
      if (!folders.has(name)) folders.set(name, { name, folder: true, exported: false, node });
    } else if (NATIVE.test(node.mimeType)) {
      if (!exported.has(name)) exported.set(name, { name, folder: false, exported: true, node });
    } else if (!stored.has(name)) stored.set(name, { name, folder: false, exported: false, node });
  }
  for (const name of stored.keys()) exported.delete(name);
  return [...folders.values(), ...stored.values(), ...exported.values()];
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
/** Folders first, then names in natural order: how a listing reads. */
const sortForDisplay = (entries: FolderEntry[]) =>
  [...entries].sort((a, b) => Number(b.folder) - Number(a.folder) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** A folder is listed from at most this many Drive pages: 100,000 entries. */
const FOLDER_PAGES = 100;
/** How long a read folder serves the pages after its first. */
const LISTING_TTL = 60_000;
/** Recent whole-folder listings, by account and folder ID, for paging through them. */
const listings = new Map<string, { entries: FolderEntry[]; expires: number }>();

/** Folder IDs by absolute path, per account: resolving "a/b/c" needn't ask three times every call. */
const folderIds = new Map<string, { id: string; expires: number }>();
/** Folders being created right now, so parallel uploads into a new folder make it once. */
const creating = new Map<string, Promise<string | null>>();

export function googleDriveDriver(target: Target): StorageDriver {
  const oauth = oauthFor(target);
  const drive = driveApi({ version: "v3", auth: oauth });
  const account = accountId(target);
  const rootParts = target.root.split("/").filter(Boolean);
  const partsOf = (key: string) => [...rootParts, ...key.split("/").filter(Boolean)];
  const cacheKey = (parts: string[]) => `${account}\n${parts.join("/")}`;
  const forgetFolders = () => {
    for (const key of folderIds.keys()) if (key.startsWith(`${account}\n`)) folderIds.delete(key);
  };

  /** A metadata call, retried on rate limits and passing server errors. */
  async function call<T>(work: () => Promise<{ data: T }>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await work()).data;
      } catch (error) {
        const status = statusOf(error);
        const busy = status === 429 || (status !== undefined && status >= 500) || /rateLimitExceeded/i.test(reasonOf(error));
        if (!busy || attempt >= 4) throw error;
        await sleep(Math.min(500 * 2 ** attempt, 8000) + randomInt(250));
      }
    }
  }

  /** A request for bytes, with a fresh token on 401 and backoff on 429 / 5xx. */
  async function send(url: string, init: RequestInit = {}, authorised = true): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      if (authorised) {
        const { token } = await oauth.getAccessToken();
        if (!token) throw lapsed();
        headers.set("authorization", `Bearer ${token}`);
      }
      // A redirect to another origin drops the Authorization header (fetch does that itself).
      const response = await fetch(url, { ...init, headers, redirect: authorised ? "follow" : "error" }).catch((error) => {
        if (networkCode(error)) throw unreachable(undefined, "Google Drive");
        throw error;
      });
      // 308 is how a resumable upload says "got that chunk, send the next".
      if (response.ok || response.status === 308) return response;
      const text = await response.text().catch(() => "");
      let reason = "";
      try {
        reason = (JSON.parse(text) as { error?: { errors?: { reason?: string }[] } }).error?.errors?.[0]?.reason ?? "";
      } catch {
        // Not JSON: the status is all there is.
      }
      if (response.status === 401 && authorised && !refreshed) {
        refreshed = true;
        oauth.setCredentials({ refresh_token: target.refreshToken });
        continue;
      }
      const busy = response.status === 429 || response.status >= 500 || /rateLimitExceeded/i.test(reason);
      // A request body that's a stream can't be sent twice; only bodiless and buffered ones are retried.
      if (busy && attempt < 4 && !(init.body instanceof ReadableStream)) {
        await sleep(Math.min(500 * 2 ** attempt, 8000) + randomInt(250));
        continue;
      }
      throw Object.assign(new Error(`Google Drive answered ${response.status}`), { status: response.status, errors: [{ reason }] });
    }
  }

  async function run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw explain(error, target);
    }
  }

  /** Everything named `name` directly inside a folder, oldest first. */
  async function childrenNamed(parentId: string, name: string): Promise<Node[]> {
    const data = await call(() =>
      drive.files.list({
        q: `${driveQuote(parentId)} in parents and name = ${driveQuote(name)} and trashed = false`,
        fields: `files(${FIELDS})`,
        orderBy: "createdTime",
        pageSize: 20,
        spaces: "drive",
      }),
    );
    return (data.files ?? []) as Node[];
  }

  /** The ID of the folder at these absolute path parts; null when it isn't there (unless `create`). */
  async function folderId(parts: string[], create = false): Promise<string | null> {
    if (!parts.length) return "root";
    const key = cacheKey(parts);
    const cached = folderIds.get(key);
    if (cached && cached.expires > Date.now()) return cached.id;
    const pending = creating.get(key);
    if (pending) return pending;

    const resolve = async (): Promise<string | null> => {
      const parent = await folderId(parts.slice(0, -1), create);
      if (!parent) return null;
      const name = parts[parts.length - 1];
      let id = (await childrenNamed(parent, name)).find((node) => node.mimeType === FOLDER)?.id;
      if (!id && create) {
        const made = await call(() => drive.files.create({ requestBody: { name, mimeType: FOLDER, parents: [parent] }, fields: "id" }));
        id = made.id ?? undefined;
      }
      if (!id) return null;
      folderIds.set(key, { id, expires: Date.now() + FOLDER_TTL });
      return id;
    };
    if (!create) return resolve();
    const work = resolve().finally(() => creating.delete(key));
    creating.set(key, work);
    return work;
  }

  type Found = { node: Node; parentId: string; exported: boolean };

  /** The file a key names: a stored file, or a Google document under its ".pdf" name. */
  async function fileAt(key: string): Promise<Found | null> {
    const parts = partsOf(key);
    const name = parts.pop();
    if (!name) return null;
    const parentId = await folderId(parts);
    if (!parentId) return null;
    const stored = (await childrenNamed(parentId, name)).find((node) => !NATIVE.test(node.mimeType));
    if (stored) return { node: stored, parentId, exported: false };
    if (!name.endsWith(EXPORT_EXT) || name.length === EXPORT_EXT.length) return null;
    const native = (await childrenNamed(parentId, name.slice(0, -EXPORT_EXT.length))).find((node) => EXPORTABLE.has(node.mimeType));
    return native ? { node: native, parentId, exported: true } : null;
  }

  /** A file or a folder ("a/"), with the folder that holds it. */
  async function entryAt(key: string): Promise<Found | null> {
    if (!key.endsWith("/")) return fileAt(key);
    const parts = partsOf(key);
    const id = await folderId(parts);
    if (!id || !parts.length) return null;
    const parentId = await folderId(parts.slice(0, -1));
    return parentId ? { node: { id, name: parts[parts.length - 1], mimeType: FOLDER }, parentId, exported: false } : null;
  }

  /** A listing entry. A Google document's size isn't known until it's exported, so it says so. */
  const fileOf = (key: string, node: Node, exported: boolean): Listing["files"][number] => ({
    key,
    size: exported ? 0 : Number(node.size ?? 0) || 0,
    ...(exported ? { sizeUnknown: true } : {}),
    lastModified: node.modifiedTime ? new Date(node.modifiedTime).toISOString() : null,
    etag: exported ? null : (node.md5Checksum ?? null),
    storageClass: null,
  });

  /**
   * Every entry of one folder, up to `maxPages` Drive pages. Duplicates are settled over the
   * whole folder, not page by page, so what's listed is always what a path opens.
   */
  async function readFolder(id: string, maxPages: number): Promise<{ entries: FolderEntry[]; pages: number; truncated: boolean }> {
    const nodes: Node[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      if (pages >= maxPages) return { entries: pickEntries(nodes), pages, truncated: true };
      const data = await call(() =>
        drive.files.list({
          q: `${driveQuote(id)} in parents and trashed = false`,
          fields: `nextPageToken,files(${FIELDS})`,
          // Oldest first, the order the path lookups use to choose between duplicates.
          orderBy: "createdTime",
          pageSize: PAGE,
          pageToken: token,
          spaces: "drive",
        }),
      );
      pages += 1;
      nodes.push(...((data.files ?? []) as Node[]));
      token = data.nextPageToken ?? undefined;
    } while (token);
    return { entries: pickEntries(nodes), pages, truncated: false };
  }

  /** A folder's entries as keys below `prefix`. */
  const keyed = (entries: FolderEntry[], prefix: string) => {
    const folders: { key: string; id: string }[] = [];
    const files: Listing["files"] = [];
    for (const entry of entries) {
      if (entry.folder) folders.push({ key: `${prefix}${entry.name}/`, id: entry.node.id });
      else files.push(fileOf(prefix + entry.name, entry.node, entry.exported));
    }
    return { folders, files };
  };

  /**
   * Walks the tree under a folder, breadth first. A "page" elsewhere is about 1,000 objects;
   * here `maxPages` allows that many entries, and bounds the requests too (most folders are
   * small, so a page of S3 keys can span many of them). Returns whether it stopped short.
   */
  async function walk(
    prefix: string,
    visit: (found: { folders: { key: string; id: string }[]; files: Listing["files"] }) => boolean | void,
    maxPages = Infinity,
  ): Promise<boolean> {
    // "Reports" and "Reports/" are the same folder; keys below it always follow a "/".
    const base = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
    const start = await folderId(partsOf(base));
    if (!start) return false;
    const maxEntries = maxPages * PAGE;
    const maxRequests = maxPages * 25;
    const queue: { id: string; prefix: string }[] = [{ id: start, prefix: base }];
    let requests = 0;
    let entries = 0;
    while (queue.length) {
      if (requests >= maxRequests || entries >= maxEntries) return true;
      const folder = queue.shift()!;
      const read = await readFolder(folder.id, maxRequests - requests);
      requests += read.pages;
      // Past the entry budget, this folder is cut where the budget ends.
      const room = maxEntries - entries;
      const over = read.entries.length > room;
      entries += read.entries.length;
      const found = keyed(over ? read.entries.slice(0, room) : read.entries, folder.prefix);
      for (const child of found.folders) queue.push({ id: child.id, prefix: child.key });
      if (visit(found) === false || read.truncated || over) return true;
    }
    return false;
  }

  /** Starts a resumable upload and feeds it chunk by chunk, so memory stays at one chunk. */
  async function put(key: string, body: ReadableStream<Uint8Array>, contentType?: string) {
    const parts = partsOf(key);
    const name = parts.pop();
    if (!name) throw new StorageUserError("That isn't a file name.", 400);
    const parentId = await folderId(parts, true);
    if (!parentId) throw new StorageUserError("That folder no longer exists.", 404);
    const existing = (await childrenNamed(parentId, name)).find((node) => !NATIVE.test(node.mimeType));
    const type = contentType || mimeOf(key) || "application/octet-stream";
    const start = await send(existing ? `${UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=resumable` : `${UPLOAD}/files?uploadType=resumable`, {
      method: existing ? "PATCH" : "POST",
      headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": type },
      body: JSON.stringify(existing ? {} : { name, parents: [parentId] }),
    });
    const session = start.headers.get("location") ?? "";
    // The session address is the credential for this upload: only ever Google's own.
    if (!session.startsWith(`${UPLOAD}/`)) throw new StorageUserError("Google Drive didn't start the upload. Try again.", 502);

    const reader = body.getReader();
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let offset = 0;
    const take = (bytes: number) => {
      const all = Buffer.concat(pending, pendingBytes);
      const chunk = all.subarray(0, bytes);
      const rest = all.subarray(bytes);
      pending = rest.byteLength ? [rest] : [];
      pendingBytes = rest.byteLength;
      return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) as Uint8Array<ArrayBuffer>;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending.push(value);
        pendingBytes += value.byteLength;
        while (pendingBytes > CHUNK) {
          const chunk = take(CHUNK);
          await send(session, { method: "PUT", headers: { "content-range": `bytes ${offset}-${offset + chunk.byteLength - 1}/*` }, body: chunk }, false);
          offset += chunk.byteLength;
        }
      }
      const last = take(pendingBytes);
      const total = offset + last.byteLength;
      const range = last.byteLength ? `bytes ${offset}-${total - 1}/${total}` : `bytes */${total}`;
      const done = await send(session, { method: "PUT", headers: { "content-range": range }, body: last }, false);
      if (done.status === 308) throw new StorageUserError("Google Drive didn't finish the upload. Try again.", 502);
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
  }

  const occupied = async (parentId: string, name: string) => (await childrenNamed(parentId, name)).length > 0;
  const taken = () => new StorageUserError("Something with that name is already there.", 409);

  /** Where a copy or move lands: the folder (created if need be) and the name to give it there. */
  async function destination(key: string, exported: boolean) {
    const parts = partsOf(key);
    let name = parts.pop();
    if (!name) throw new StorageUserError("That isn't a valid destination.", 400);
    // A Google document keeps its own name: the ".pdf" is only how it's listed.
    if (exported && name.endsWith(EXPORT_EXT) && name.length > EXPORT_EXT.length) name = name.slice(0, -EXPORT_EXT.length);
    const parentId = await folderId(parts, true);
    if (!parentId) throw new StorageUserError("That folder no longer exists.", 404);
    if (await occupied(parentId, name)) throw taken();
    return { parentId, name };
  }

  /** Drive can't copy a folder: make the new one, then copy what's inside, level by level. */
  async function copyTree(sourceId: string, parentId: string, name: string) {
    const made = await call(() => drive.files.create({ requestBody: { name, mimeType: FOLDER, parents: [parentId] }, fields: "id" }));
    const targetId = made.id!;
    let token: string | undefined;
    do {
      const data = await call(() =>
        drive.files.list({
          q: `${driveQuote(sourceId)} in parents and trashed = false`,
          fields: "nextPageToken,files(id,name,mimeType)",
          pageSize: PAGE,
          pageToken: token,
          spaces: "drive",
        }),
      );
      const children = (data.files ?? []) as Node[];
      await eachLimit(children, 4, async (child) => {
        if (child.mimeType === FOLDER) return copyTree(child.id, targetId, child.name);
        await call(() => drive.files.copy({ fileId: child.id, requestBody: { name: child.name, parents: [targetId] }, fields: "id" }));
      });
      token = data.nextPageToken ?? undefined;
    } while (token);
  }

  const noFolder = () => new StorageUserError(`No folder “${target.root}” in this Google Drive.`, 404);

  return {
    // Folders are real on Drive: copy, rename and remove act on a whole tree at once.
    nativeFolders: true,

    verify: () =>
      run(async () => {
        const id = await folderId(rootParts);
        if (!id) throw noFolder();
        await call(() => drive.files.list({ q: `${driveQuote(id)} in parents and trashed = false`, pageSize: 1, fields: "files(id)", spaces: "drive" }));
        return {};
      }),

    // The folder is read whole (so duplicates are settled the same on every page), then
    // handed out a page at a time. The first page always reads afresh; later pages come
    // from that read, so paging through doesn't read the folder again for every page.
    list: (prefix, token) =>
      run(async () => {
        const offset = token === undefined ? 0 : /^o:(\d{1,9})$/.exec(token) ? Number(token.slice(2)) : NaN;
        if (!Number.isSafeInteger(offset)) throw new StorageUserError("That page of the listing is no longer valid. Refresh.", 400);
        const id = await folderId(partsOf(prefix));
        if (!id) {
          // A folder that's gone reads as empty, as a prefix with nothing under it does on S3.
          if (prefix) return { folders: [], files: [] };
          throw noFolder();
        }
        const cacheKey = `${account}\n${id}`;
        const cached = offset > 0 ? listings.get(cacheKey) : undefined;
        let entries: FolderEntry[];
        if (cached && cached.expires > Date.now()) entries = cached.entries;
        else {
          entries = sortForDisplay((await readFolder(id, FOLDER_PAGES)).entries);
          listings.delete(cacheKey);
          listings.set(cacheKey, { entries, expires: Date.now() + LISTING_TTL });
          if (listings.size > 50) listings.delete(listings.keys().next().value!);
        }
        const slice = entries.slice(offset, offset + PAGE);
        const { folders, files } = keyed(slice, prefix);
        const next = offset + PAGE < entries.length ? `o:${offset + PAGE}` : undefined;
        return { folders: folders.map((folder) => folder.key), files, nextToken: next };
      }),

    // Files, plus each empty folder as its own "marker" — a non-empty folder is implied
    // by what's in it, exactly as on S3.
    listKeys: (prefix, max) =>
      run(async () => {
        if (prefix && !prefix.endsWith("/")) return { keys: (await fileAt(prefix)) ? [prefix] : [], truncated: false };
        if (!(await folderId(partsOf(prefix)))) return { keys: [], truncated: false };
        const files: string[] = [];
        const folders = new Set<string>(prefix ? [prefix] : []);
        const parents = new Set<string>();
        const parentOf = (key: string) => {
          const trimmed = key.replace(/\/$/, "");
          return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
        };
        const more = await walk(prefix, (found) => {
          for (const folder of found.folders) {
            folders.add(folder.key);
            parents.add(parentOf(folder.key));
          }
          for (const file of found.files) {
            files.push(file.key);
            parents.add(parentOf(file.key));
          }
          return files.length + folders.size <= max;
        });
        const keys = [...files, ...[...folders].filter((folder) => !parents.has(folder))];
        return { keys: keys.slice(0, max), truncated: more || keys.length > max };
      }),

    stats: (prefix, maxPages = 20) =>
      run(async () => {
        const stats: FolderStats = { objects: 0, bytes: 0, lastModified: null, truncated: false };
        stats.truncated = await walk(
          prefix,
          (found) => {
            for (const file of found.files) {
              stats.objects += 1;
              stats.bytes += file.size;
              if (file.lastModified && (!stats.lastModified || file.lastModified > stats.lastModified)) stats.lastModified = file.lastModified;
            }
          },
          maxPages,
        );
        return stats;
      }),

    inventory: (prefix, maxPages = 100) =>
      run(async () => {
        // An exact file name (SQL's FROM 'sales.csv') is that file; otherwise it's a folder.
        if (prefix && !prefix.endsWith("/")) {
          const found = await fileAt(prefix);
          if (found) return { files: [fileOf(prefix, found.node, found.exported)], truncated: false };
        }
        const files: Listing["files"] = [];
        const truncated = await walk(
          prefix,
          (found) => {
            files.push(...found.files);
          },
          maxPages,
        );
        return { files, truncated };
      }),

    // Drive's links are either public until switched off or tied to a Google sign-in, so
    // files are served through this app instead.
    signedUrl: () => Promise.resolve(null),

    read: (key, range) =>
      run(async () => {
        const found = await fileAt(key);
        if (!found) throw new StorageUserError("That file or folder no longer exists.", 404);
        const id = encodeURIComponent(found.node.id);
        if (found.exported) {
          // An export is made on request: there's no size to seek within, so it's sent whole.
          const response = await send(`${API}/files/${id}/export?mimeType=${encodeURIComponent(EXPORT_TYPE)}`);
          if (!response.body) throw new StorageUserError("That document is empty or gone.", 404);
          const length = Number(response.headers.get("content-length"));
          return { stream: response.body, contentType: EXPORT_TYPE, size: Number.isFinite(length) && length > 0 ? length : undefined };
        }
        const response = await send(`${API}/files/${id}?alt=media`, range ? { headers: { range: rangeHeader(range) } } : {});
        if (!response.body) throw new StorageUserError("That file is empty or gone.", 404);
        const total = Number(found.node.size ?? NaN);
        const served = response.status === 206 ? parseContentRange(response.headers.get("content-range")) : undefined;
        const length = Number(response.headers.get("content-length"));
        return {
          stream: response.body,
          contentType: mimeOf(key) ?? found.node.mimeType,
          size: Number.isFinite(length) && length >= 0 && response.headers.has("content-length") ? length : Number.isFinite(total) ? total : undefined,
          total: served?.total ?? (Number.isFinite(total) ? total : undefined),
          range: served ? { start: served.start, end: served.end } : undefined,
        };
      }),

    write: (key, body, contentType) =>
      run(async () => {
        if (key.endsWith("/")) {
          await folderId(partsOf(key), true);
          return;
        }
        await put(
          key,
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (body.byteLength) controller.enqueue(body);
              controller.close();
            },
          }),
          contentType,
        );
      }),

    upload: (key, body, _size, contentType) => run(() => put(key, body, contentType)),

    // Deletes go to the Drive bin, where Google keeps them for 30 days.
    remove: (keys) =>
      run(async () => {
        const failed: string[] = [];
        await eachLimit(keys, 4, async (key) => {
          try {
            const found = await entryAt(key);
            if (!found) return; // already gone counts as deleted
            await call(() => drive.files.update({ fileId: found.node.id, requestBody: { trashed: true }, fields: "id" }));
          } catch (error) {
            if (statusOf(error) === 404) return;
            const known = explain(error, target);
            if (known.status === 401) throw known;
            failed.push(key);
          }
        });
        if (keys.some((key) => key.endsWith("/"))) forgetFolders();
        return { failed };
      }),

    copy: (source, to) =>
      run(async () => {
        const found = await entryAt(source);
        if (!found) throw new StorageUserError("That file or folder no longer exists.", 404);
        const { parentId, name } = await destination(to, found.exported);
        if (found.node.mimeType === FOLDER) return copyTree(found.node.id, parentId, name);
        await call(() => drive.files.copy({ fileId: found.node.id, requestBody: { name, parents: [parentId] }, fields: "id" }));
      }),

    rename: (source, to) =>
      run(async () => {
        const found = await entryAt(source);
        if (!found) throw new StorageUserError("That file or folder no longer exists.", 404);
        const { parentId, name } = await destination(to, found.exported);
        await call(() =>
          drive.files.update({
            fileId: found.node.id,
            requestBody: { name },
            ...(parentId === found.parentId ? {} : { addParents: parentId, removeParents: found.parentId }),
            fields: "id",
          }),
        );
        if (found.node.mimeType === FOLDER) forgetFolders();
      }),

    head: (key) =>
      run(async (): Promise<ObjectHead> => {
        const found = await fileAt(key);
        if (!found) throw new StorageUserError("That file or folder no longer exists.", 404);
        const size = Number(found.node.size ?? NaN);
        return {
          size: Number.isFinite(size) ? size : undefined,
          contentType: found.exported ? EXPORT_TYPE : (mimeOf(key) ?? found.node.mimeType),
          etag: found.node.md5Checksum ?? null,
          storageClass: null,
          lastModified: found.node.modifiedTime ? new Date(found.node.modifiedTime).toISOString() : null,
          encryption: { state: "encrypted", keys: "provider", detail: "always on at Google" },
        };
      }),
  };
}

/** The account's email, for the sidebar hint; null if Google won't say. */
export async function googleDriveAccount(target: Omit<Target, "root">): Promise<string | null> {
  try {
    const drive = driveApi({ version: "v3", auth: oauthFor(target) });
    const about = await drive.about.get({ fields: "user(emailAddress)" });
    return (about.data as drive_v3.Schema$About).user?.emailAddress ?? null;
  } catch {
    return null;
  }
}
