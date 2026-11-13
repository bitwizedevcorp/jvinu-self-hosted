import "server-only";
import { createHash } from "node:crypto";
import { mimeOf } from "../mime";
import {
  networkCode,
  parseContentRange,
  rangeHeader,
  StorageUserError,
  unreachable,
  unsatisfiable,
  type FolderStats,
  type Listing,
  type StorageDriver,
} from "./types";

/**
 * Dropbox over its HTTP API (the JS SDK buffers whole files; this streams them).
 * A connection's "bucket" is a folder path — "/" for the whole Dropbox — and keys are
 * paths below it, so "a/b.txt" under "/Work" is "/Work/a/b.txt" on Dropbox.
 */
type Target = {
  /** "/" or a folder such as "/Photos". */
  root: string;
  appKey: string;
  refreshToken: string;
  /** Tests only: one origin serving both the API and content hosts. */
  endpoint?: string;
};

const API = "https://api.dropboxapi.com";
const CONTENT = "https://content.dropboxapi.com";
const PAGE = 1000;
/** Upload-session chunk; Dropbox takes up to 150 MB a request. */
const CHUNK = 8 * 1024 * 1024;

type Entry = {
  ".tag": "file" | "folder" | "deleted";
  name: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
};
type Page = { entries: Entry[]; cursor: string; has_more: boolean };

/** A 409 from Dropbox: the route-specific error, e.g. "path/not_found/...". */
class DropboxError extends Error {
  constructor(readonly summary: string) {
    super(summary);
  }
}

/** "/", "/Photos", "Photos/2024/" → the canonical folder path, or null if it can't be one. */
export function dropboxFolder(raw: string): string | null {
  const parts = raw.trim().split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || /[\\\u0000-\u001f]/.test(part))) return null;
  const path = `/${parts.join("/")}`;
  return Buffer.byteLength(path) <= 1024 ? path : null;
}

/** Dropbox-API-Arg is a header: anything outside ASCII must be \u-escaped. */
const headerJson = (value: unknown) =>
  JSON.stringify(value).replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function networkError(error: unknown): never {
  if (networkCode(error)) throw unreachable(undefined, "Dropbox");
  throw error;
}

/* ------------------------------------------------------------------ */
/* OAuth: PKCE, no client secret. Access tokens last ~4 h; the refresh  */
/* token doesn't expire until the user revokes the app.                 */

async function tokenRequest(base: string, params: Record<string, string>) {
  const response = await fetch(`${base}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  }).catch(networkError);
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (response.ok && body.access_token) return body;
  // Dropbox puts the detail in the code itself: "invalid_client: Invalid client_id".
  const code = (body.error ?? "").split(":")[0];
  if (code === "invalid_grant") return { error: "invalid_grant" as const };
  if (code === "invalid_client") throw new StorageUserError("Dropbox doesn't recognise that app key.", 400);
  console.error("[dropbox] token request failed", response.status, body.error);
  throw new StorageUserError("Dropbox didn't accept the sign-in. Try again.", 502);
}

/** Codes are single-use: a retry after a failed connect reuses the token it already bought. */
const exchanged = new Map<string, { refreshToken: string; expires: number }>();

/** Trades the code Dropbox showed the user for a long-lived refresh token. */
export async function exchangeDropboxCode(appKey: string, code: string, verifier: string, endpoint?: string): Promise<string> {
  const id = createHash("sha256").update(`${appKey}\n${code}\n${verifier}`).digest("hex");
  const now = Date.now();
  for (const [key, value] of exchanged) if (value.expires < now) exchanged.delete(key);
  const cached = exchanged.get(id);
  if (cached) return cached.refreshToken;

  const out = await tokenRequest(endpoint ?? API, { grant_type: "authorization_code", code, client_id: appKey, code_verifier: verifier });
  if ("error" in out) throw new StorageUserError("That access code has expired or was already used — get a new one.", 400);
  if (!out.refresh_token) throw new StorageUserError("Dropbox didn't grant offline access. Get a new code and try again.", 502);
  exchanged.set(id, { refreshToken: out.refresh_token, expires: now + 10 * 60_000 });
  return out.refresh_token;
}

const accessTokens = new Map<string, { value: string; expires: number }>();

async function accessToken(target: Target, force: boolean): Promise<string> {
  const id = createHash("sha256").update(target.refreshToken).digest("hex");
  const cached = accessTokens.get(id);
  if (!force && cached && cached.expires > Date.now() + 60_000) return cached.value;
  const out = await tokenRequest(target.endpoint ?? API, {
    grant_type: "refresh_token",
    refresh_token: target.refreshToken,
    client_id: target.appKey,
  });
  if ("error" in out) throw new StorageUserError("Dropbox access was revoked or has lapsed — reconnect this Dropbox.", 401);
  accessTokens.set(id, { value: out.access_token!, expires: Date.now() + (out.expires_in ?? 14_400) * 1000 });
  return out.access_token!;
}

/* ------------------------------------------------------------------ */

function explain(error: unknown, target: Target): StorageUserError {
  if (error instanceof StorageUserError) return error;
  if (!(error instanceof DropboxError)) {
    if (networkCode(error)) return unreachable(undefined, "Dropbox");
    console.error("[dropbox] unexpected error", error);
    return new StorageUserError("Dropbox returned an unexpected error. Try again.", 502);
  }
  const summary = error.summary;
  if (/not_found/.test(summary)) return new StorageUserError("That file or folder no longer exists.", 404);
  if (/conflict/.test(summary)) return new StorageUserError("Something with that name is already there.", 409);
  if (/insufficient_space/.test(summary)) return new StorageUserError(`The Dropbox holding “${target.root}” is full.`, 507);
  if (/too_many_(write_operations|files)/.test(summary)) return new StorageUserError("Dropbox is busy — try again in a moment.", 429);
  if (/not_folder/.test(summary)) return new StorageUserError("That path is a file, not a folder.", 400);
  if (/malformed_path|disallowed_name/.test(summary)) return new StorageUserError("Dropbox doesn't allow that name.", 400);
  if (/restricted_content|no_write_permission|team_folder/.test(summary))
    return new StorageUserError("Dropbox doesn't allow that here.", 403);
  console.error("[dropbox] unexpected error", summary);
  return new StorageUserError("Dropbox returned an unexpected error. Try again.", 502);
}

export function dropboxDriver(target: Target): StorageDriver {
  const api = target.endpoint ?? API;
  const content = target.endpoint ?? CONTENT;
  const base = target.root === "/" ? "" : target.root;
  /** Key → Dropbox path; "" is the connection's root, and the root of a Dropbox is "". */
  const pathOf = (key: string) => (key ? `${base}/${key.replace(/\/$/, "")}` : base);

  /** One request, with a token refresh on 401 and backoff on 429 / 503. */
  async function send(url: string, init: (token: string) => RequestInit): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken(target, refreshed);
      const response = await fetch(url, init(token)).catch(networkError);
      if (response.ok) return response;
      const text = await response.text().catch(() => "");
      let summary = text;
      let detail: { error?: { ".tag"?: string; required_scope?: string } } = {};
      try {
        detail = JSON.parse(text);
        summary = (detail as { error_summary?: string }).error_summary ?? text;
      } catch {
        // Not JSON: Dropbox answers 400s in plain text.
      }
      if (response.status === 401) {
        if (detail.error?.[".tag"] === "missing_scope") {
          throw new StorageUserError(
            `This Dropbox app lacks the ${detail.error.required_scope ?? "needed"} permission — enable it under Permissions in the App Console, then link again.`,
            403,
          );
        }
        if (!refreshed) {
          refreshed = true;
          continue;
        }
        throw new StorageUserError("Dropbox access was revoked or has lapsed — reconnect this Dropbox.", 401);
      }
      if ((response.status === 429 || response.status === 503) && attempt < 4) {
        const wait = Number(response.headers.get("retry-after"));
        await sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 500 * 2 ** attempt, 10_000));
        continue;
      }
      if (response.status === 409) throw new DropboxError(summary);
      if (response.status === 416) throw unsatisfiable();
      console.error("[dropbox] request failed", response.status, summary.slice(0, 300));
      throw new StorageUserError("Dropbox returned an unexpected error. Try again.", 502);
    }
  }

  /** RPC endpoints: JSON in, JSON out. */
  async function rpc<T>(route: string, args: unknown): Promise<T> {
    const response = await send(`${api}/2/${route}`, (token) => ({
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    }));
    return (await response.json()) as T;
  }

  /** Content endpoints: arguments in a header, bytes in the body. */
  function contentCall(route: string, arg: unknown, body?: Uint8Array, extra: Record<string, string> = {}) {
    return send(`${content}/2/${route}`, (token) => ({
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "dropbox-api-arg": headerJson(arg),
        ...(body ? { "content-type": "application/octet-stream" } : {}),
        ...extra,
      },
      // Always backed by a plain ArrayBuffer here (from Buffer.concat or a stream chunk).
      body: body as Uint8Array<ArrayBuffer> | undefined,
    }));
  }

  async function run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw explain(error, target);
    }
  }

  /** Walks a folder level (or the whole tree), page by page, until `enough` says stop. */
  async function walk(prefix: string, recursive: boolean, onPage: (entries: Entry[]) => boolean | void, maxPages = Infinity) {
    let page = await rpc<Page>("files/list_folder", {
      path: pathOf(prefix),
      recursive,
      limit: PAGE,
      include_non_downloadable_files: false,
    });
    for (let n = 1; ; n++) {
      if (onPage(page.entries) === false || !page.has_more || n >= maxPages) return page.has_more;
      page = await rpc<Page>("files/list_folder/continue", { cursor: page.cursor });
    }
  }

  const isNotFound = (error: unknown) => error instanceof DropboxError && /not_found/.test(error.summary);

  /** The key of an entry from a recursive listing under `prefix`. */
  const keyFrom = (prefix: string, entry: Entry) => {
    // Only the last path component is guaranteed to be cased as stored, so keep the
    // caller's prefix and take the rest from the entry.
    const below = (entry.path_display ?? "").slice(pathOf(prefix).length + 1);
    // A recursive listing includes the folder itself.
    if (!below) return prefix;
    return prefix + below + (entry[".tag"] === "folder" ? "/" : "");
  };

  async function upload(key: string, body: Uint8Array) {
    await contentCall("files/upload", { path: pathOf(key), mode: "overwrite", mute: true }, body);
  }

  return {
    // Folders are real on Dropbox: copy, rename and remove act on a whole tree at once.
    nativeFolders: true,

    verify: () =>
      run(async () => {
        if (!base) {
          await rpc("files/list_folder", { path: "", limit: 1 });
          return {};
        }
        try {
          const meta = await rpc<Entry>("files/get_metadata", { path: base });
          if (meta[".tag"] !== "folder") throw new StorageUserError(`“${target.root}” is a file, not a folder.`, 400);
        } catch (error) {
          if (isNotFound(error)) throw new StorageUserError(`No folder “${target.root}” in this Dropbox.`, 404);
          throw error;
        }
        return {};
      }),

    list: (prefix, token) =>
      run(async () => {
        let page: Page;
        try {
          page = token
            ? await rpc<Page>("files/list_folder/continue", { cursor: token })
            : await rpc<Page>("files/list_folder", { path: pathOf(prefix), limit: PAGE, include_non_downloadable_files: false });
        } catch (error) {
          // A folder that's gone reads as empty, as a prefix with nothing under it does on S3.
          if (prefix && isNotFound(error)) return { folders: [], files: [] };
          if (!prefix && isNotFound(error)) throw new StorageUserError(`No folder “${target.root}” in this Dropbox.`, 404);
          throw error;
        }
        const listing: Listing = { folders: [], files: [], nextToken: page.has_more ? page.cursor : undefined };
        for (const entry of page.entries) {
          if (entry[".tag"] === "folder") listing.folders.push(`${prefix}${entry.name}/`);
          else if (entry[".tag"] === "file")
            listing.files.push({
              key: prefix + entry.name,
              size: entry.size ?? 0,
              lastModified: entry.server_modified ? new Date(entry.server_modified).toISOString() : null,
              etag: entry.content_hash ?? null,
              storageClass: null,
            });
        }
        return listing;
      }),

    // Files, plus each empty folder as its own "marker" — a non-empty folder is implied
    // by what's in it, exactly as on S3.
    listKeys: (prefix, max) =>
      run(async () => {
        if (prefix && !prefix.endsWith("/")) {
          try {
            const meta = await rpc<Entry>("files/get_metadata", { path: pathOf(prefix) });
            return { keys: meta[".tag"] === "file" ? [prefix] : [], truncated: false };
          } catch (error) {
            if (isNotFound(error)) return { keys: [], truncated: false };
            throw error;
          }
        }
        const files: string[] = [];
        const folders = new Set<string>(prefix ? [prefix] : []);
        const parents = new Set<string>();
        let more: boolean;
        try {
          more = await walk(prefix, true, (entries) => {
            for (const entry of entries) {
              if (entry[".tag"] === "deleted") continue;
              const key = keyFrom(prefix, entry);
              if (key === prefix) continue; // the folder itself
              if (entry[".tag"] === "folder") folders.add(key);
              else files.push(key);
              const trimmed = key.replace(/\/$/, "");
              parents.add(trimmed.slice(0, trimmed.lastIndexOf("/") + 1));
            }
            return files.length + folders.size <= max;
          });
        } catch (error) {
          if (isNotFound(error)) return { keys: [], truncated: false };
          throw error;
        }
        const keys = [...files, ...[...folders].filter((folder) => !parents.has(folder))];
        return { keys: keys.slice(0, max), truncated: more || keys.length > max };
      }),

    stats: (prefix, maxPages = 20) =>
      run(async () => {
        const stats: FolderStats = { objects: 0, bytes: 0, lastModified: null, truncated: false };
        try {
          stats.truncated = await walk(
            prefix,
            true,
            (entries) => {
              for (const entry of entries) {
                if (entry[".tag"] !== "file") continue;
                stats.objects += 1;
                stats.bytes += entry.size ?? 0;
                const modified = entry.server_modified ? new Date(entry.server_modified).toISOString() : null;
                if (modified && (!stats.lastModified || modified > stats.lastModified)) stats.lastModified = modified;
              }
            },
            maxPages,
          );
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        return stats;
      }),

    inventory: (prefix, maxPages = 100) =>
      run(async () => {
        // One exact name (SQL's FROM 'sales.csv') is that file; otherwise it's a folder.
        if (prefix && !prefix.endsWith("/")) {
          try {
            const meta = await rpc<Entry>("files/get_metadata", { path: pathOf(prefix) });
            if (meta[".tag"] === "file")
              return {
                files: [
                  {
                    key: prefix,
                    size: meta.size ?? 0,
                    lastModified: meta.server_modified ? new Date(meta.server_modified).toISOString() : null,
                    etag: meta.content_hash ?? null,
                    storageClass: null,
                  },
                ],
                truncated: false,
              };
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
          prefix = `${prefix}/`;
        }
        const files: Listing["files"] = [];
        let truncated = false;
        try {
          truncated = await walk(
            prefix,
            true,
            (entries) => {
              for (const entry of entries) {
                if (entry[".tag"] !== "file") continue;
                files.push({
                  key: keyFrom(prefix, entry),
                  size: entry.size ?? 0,
                  lastModified: entry.server_modified ? new Date(entry.server_modified).toISOString() : null,
                  etag: entry.content_hash ?? null,
                  storageClass: null,
                });
              }
            },
            maxPages,
          );
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        return { files, truncated };
      }),

    // Dropbox's temporary links always last four hours, whatever expiry was chosen, and its
    // shared links are public until revoked — so files are served through this app instead.
    signedUrl: () => Promise.resolve(null),

    read: (key, range) =>
      run(async () => {
        const response = await contentCall("files/download", { path: pathOf(key) }, undefined, range ? { range: rangeHeader(range) } : {});
        let total: number | undefined;
        try {
          total = (JSON.parse(response.headers.get("dropbox-api-result") ?? "{}") as Entry).size;
        } catch {
          total = undefined;
        }
        if (!response.body) throw new StorageUserError("That file is empty or gone.", 404);
        const served = response.status === 206 ? parseContentRange(response.headers.get("content-range")) : undefined;
        const length = Number(response.headers.get("content-length"));
        return {
          stream: response.body,
          contentType: mimeOf(key),
          size: Number.isFinite(length) && length >= 0 ? length : total,
          total: served?.total ?? total,
          range: served ? { start: served.start, end: served.end } : undefined,
        };
      }),

    write: (key, body) =>
      run(async () => {
        if (!key.endsWith("/")) return upload(key, body);
        try {
          await rpc("files/create_folder_v2", { path: pathOf(key), autorename: false });
        } catch (error) {
          // Already there is fine: on S3 writing a marker twice is a no-op too.
          if (!(error instanceof DropboxError && /conflict\/folder/.test(error.summary))) throw error;
        }
      }),

    // One request below a chunk; above it, an upload session fed chunk by chunk.
    upload: (key, body) =>
      run(async () => {
        const reader = body.getReader();
        let pending: Uint8Array[] = [];
        let pendingBytes = 0;
        let session: string | undefined;
        let offset = 0;
        const drain = () => {
          const chunk = Buffer.concat(pending, pendingBytes);
          pending = [];
          pendingBytes = 0;
          return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        };
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            pending.push(value);
            pendingBytes += value.byteLength;
            if (pendingBytes < CHUNK) continue;
            const chunk = drain();
            if (!session) {
              const response = await contentCall("files/upload_session/start", { close: false }, chunk);
              session = ((await response.json()) as { session_id: string }).session_id;
            } else {
              await contentCall("files/upload_session/append_v2", { cursor: { session_id: session, offset }, close: false }, chunk);
            }
            offset += chunk.byteLength;
          }
          const rest = drain();
          if (!session) return await upload(key, rest);
          await contentCall(
            "files/upload_session/finish",
            { cursor: { session_id: session, offset }, commit: { path: pathOf(key), mode: "overwrite", mute: true } },
            rest,
          );
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        }
      }),

    remove: (keys) =>
      run(async () => {
        const failed: string[] = [];
        for (let i = 0; i < keys.length; i += 1000) {
          const batch = keys.slice(i, i + 1000);
          type Result = { ".tag": string; entries?: { ".tag": string; failure?: { ".tag": string; path_lookup?: { ".tag": string } } }[]; async_job_id?: string };
          let result = await rpc<Result>("files/delete_batch", { entries: batch.map((key) => ({ path: pathOf(key) })) });
          for (let polls = 0; result[".tag"] === "async_job_id" || result[".tag"] === "in_progress"; polls++) {
            if (polls > 120) throw new StorageUserError("Dropbox is still deleting — check back in a minute.", 504);
            const job = result.async_job_id;
            await sleep(Math.min(250 * (polls + 1), 1000));
            const next = await rpc<Result>("files/delete_batch/check", { async_job_id: job });
            result = { ...next, async_job_id: job };
          }
          if (result[".tag"] !== "complete") {
            failed.push(...batch);
            continue;
          }
          result.entries?.forEach((entry, index) => {
            // Already gone counts as deleted.
            const missing = entry.failure?.[".tag"] === "path_lookup" && entry.failure.path_lookup?.[".tag"] === "not_found";
            if (entry[".tag"] !== "success" && !missing) failed.push(batch[index]);
          });
        }
        return { failed };
      }),

    copy: (source, destination) =>
      run(async () => {
        await rpc("files/copy_v2", { from_path: pathOf(source), to_path: pathOf(destination), autorename: false });
      }),

    rename: (source, destination) =>
      run(async () => {
        await rpc("files/move_v2", { from_path: pathOf(source), to_path: pathOf(destination), autorename: false });
      }),
  };
}

/** The account's email, for the sidebar hint; null if the app can't read account info. */
export async function dropboxAccount(target: Omit<Target, "root">): Promise<string | null> {
  try {
    const token = await accessToken({ ...target, root: "/" }, false);
    const response = await fetch(`${target.endpoint ?? API}/2/users/get_current_account`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { email?: string };
    return body.email ?? null;
  } catch {
    return null;
  }
}
