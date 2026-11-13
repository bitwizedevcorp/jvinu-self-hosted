import "server-only";
import { createHash } from "node:crypto";
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
  type StorageDriver,
} from "./types";

/**
 * OneDrive (personal, and OneDrive for Business) over Microsoft Graph. Like Dropbox, a
 * connection's "bucket" is a folder path — "/" for the whole drive — and keys are paths
 * below it, so "a/b.txt" under "/Work" is "/Work/a/b.txt" on OneDrive.
 *
 * Sign-in is the OAuth device-code flow: the user types a short code at microsoft.com, so
 * the server needs no public callback URL and the app registration needs no client secret.
 */
type Target = {
  /** "/" or a folder such as "/Documents". */
  root: string;
  /** The Application (client) ID of the user's app registration in Microsoft Entra. */
  clientId: string;
  /** "common", "consumers", "organizations", or a tenant ID / domain. */
  tenant: string;
  refreshToken: string;
  /**
   * Microsoft issues a new refresh token with every access token, and each one lapses
   * after about 90 days — so the newest has to be the one that's stored.
   */
  onRotate?: (refreshToken: string) => Promise<void> | void;
  /** Tests only: one origin serving both the sign-in and Graph hosts. */
  endpoint?: string;
};

const GRAPH = "https://graph.microsoft.com";
const LOGIN = "https://login.microsoftonline.com";
/** Files.ReadWrite: the signed-in user's own files. User.Read: their email, for the sidebar. */
const SCOPE = "Files.ReadWrite offline_access User.Read";
const PAGE = 200;
/** Upload-session fragments must be multiples of 320 KiB; this is 10 MiB. */
const FRAGMENT = 320 * 1024;
const CHUNK = 32 * FRAGMENT;
/** Folders listed at once when walking a tree: Graph has no recursive listing. */
const WALKERS = 4;
const SELECT = "name,size,file,folder,package,lastModifiedDateTime";

type Item = {
  id?: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { hashes?: { sha256Hash?: string; quickXorHash?: string; sha1Hash?: string } };
  folder?: { childCount?: number };
  /** OneNote notebooks and the like: folder-shaped, but not downloadable. */
  package?: unknown;
  parentReference?: { driveId?: string; id?: string };
};
type Children = { value: Item[]; "@odata.nextLink"?: string };

/** A Graph error response: its HTTP status and the code in its body ("itemNotFound"…). */
class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message || code || `HTTP ${status}`);
  }
}

/** "/", "/Photos", "Photos/2024/" → the canonical folder path, or null if it can't be one. */
export function oneDriveFolder(raw: string): string | null {
  const parts = raw.trim().split("/").filter(Boolean);
  // OneDrive refuses these characters in names, and names ending in a dot or a space.
  if (parts.some((part) => part === "." || part === ".." || /["*:<>?\\|\u0000-\u001f]/.test(part) || /[. ]$/.test(part))) return null;
  const path = `/${parts.join("/")}`;
  return path.length <= 400 ? path : null;
}

/** The sign-in authority: empty means "common" (work, school and personal accounts). */
export function oneDriveTenant(raw: string): string | null {
  const tenant = raw.trim() || "common";
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(tenant) ? tenant : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function networkError(error: unknown): never {
  if (networkCode(error)) throw unreachable(undefined, "OneDrive");
  throw error;
}

/* ------------------------------------------------------------------ */
/* OAuth: a public client (no secret). Access tokens last about an    */
/* hour; every refresh returns a new refresh token.                   */

type TokenBody = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

const loginBase = (tenant: string, endpoint?: string) => `${endpoint ?? LOGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0`;

async function loginRequest<T extends { error?: string }>(
  tenant: string,
  endpoint: string | undefined,
  route: "token" | "devicecode",
  params: Record<string, string>,
): Promise<{ ok: boolean; body: T }> {
  const response = await fetch(`${loginBase(tenant, endpoint)}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  }).catch(networkError);
  const body = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok && !body.error, body };
}

/**
 * Microsoft's own explanation, minus the trace IDs: the app registration is the user's, so
 * what's wrong with it ("…is not enabled for consumers", "…must contain client_secret") is
 * theirs to read.
 */
function appProblem(body: { error?: string; error_description?: string }): StorageUserError {
  const detail = (body.error_description ?? "")
    .split(/\s*(?:Trace ID|Correlation ID|Timestamp):/)[0]
    .replace(/^AADSTS\d+:\s*/, "")
    .trim()
    .slice(0, 300);
  console.error("[onedrive] sign-in refused", body.error, detail);
  return new StorageUserError(
    `Microsoft didn't accept that app registration — check the client ID and tenant, and that “Allow public client flows” is on.${detail ? ` (${detail})` : ""}`,
    400,
  );
}

const tokenId = (refreshToken: string) => createHash("sha256").update(refreshToken).digest("hex");
type Access = { value: string; expires: number; refreshToken: string };
const accessTokens = new Map<string, Access>();
const refreshing = new Map<string, Promise<string>>();

function remember(id: string, body: TokenBody, fallbackRefresh: string): Access {
  const entry = {
    value: body.access_token!,
    expires: Date.now() + (body.expires_in ?? 3600) * 1000,
    refreshToken: body.refresh_token ?? fallbackRefresh,
  };
  if (accessTokens.size > 500) {
    for (const [key, value] of accessTokens) if (value.expires < Date.now()) accessTokens.delete(key);
  }
  accessTokens.set(id, entry);
  // Also under the new refresh token, which is what the connection holds once it's saved.
  accessTokens.set(tokenId(entry.refreshToken), entry);
  return entry;
}

async function accessToken(target: Target, force: boolean): Promise<string> {
  const id = tokenId(target.refreshToken);
  const cached = accessTokens.get(id);
  if (!force && cached && cached.expires > Date.now() + 60_000) return cached.value;
  const running = refreshing.get(id);
  if (running) return running;
  const work = (async () => {
    // The newest refresh token this process has seen, in case the stored one is a step behind.
    const refreshToken = cached?.refreshToken ?? target.refreshToken;
    const out = await loginRequest<TokenBody>(target.tenant, target.endpoint, "token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: target.clientId,
      scope: SCOPE,
    });
    if (!out.ok || !out.body.access_token) {
      if (out.body.error === "invalid_grant" || out.body.error === "interaction_required")
        throw new StorageUserError("OneDrive access was revoked or has lapsed — reconnect this OneDrive.", 401);
      throw appProblem(out.body);
    }
    const entry = remember(id, out.body, refreshToken);
    if (entry.refreshToken !== refreshToken && target.onRotate) {
      try {
        await target.onRotate(entry.refreshToken);
      } catch (error) {
        // Not fatal: the old token still works for weeks, and the next refresh tries again.
        console.error("[onedrive] couldn't save the rotated refresh token", error);
      }
    }
    return entry.value;
  })().finally(() => refreshing.delete(id));
  refreshing.set(id, work);
  return work;
}

export type DeviceSignIn = {
  /** Sent back to Microsoft when polling; never shown to the user. */
  deviceCode: string;
  /** What the user types at `verificationUri`. */
  userCode: string;
  verificationUri: string;
  /** Seconds until the codes lapse (15 minutes, normally). */
  expiresIn: number;
  /** Seconds Microsoft wants between polls. */
  interval: number;
};

/** Step one of the device-code flow: get a code for the user to enter at microsoft.com. */
export async function startOneDriveSignIn(app: { clientId: string; tenant: string; endpoint?: string }): Promise<DeviceSignIn> {
  type Body = { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string; error_description?: string };
  const out = await loginRequest<Body>(app.tenant, app.endpoint, "devicecode", { client_id: app.clientId, scope: SCOPE });
  if (!out.ok || !out.body.device_code || !out.body.user_code) throw appProblem(out.body);
  return {
    deviceCode: out.body.device_code,
    userCode: out.body.user_code,
    verificationUri: out.body.verification_uri ?? "https://microsoft.com/devicelogin",
    expiresIn: out.body.expires_in ?? 900,
    interval: out.body.interval ?? 5,
  };
}

/** Device codes are single-use: a retry after a failed connect reuses the token it already bought. */
const redeemed = new Map<string, { refreshToken: string; expires: number }>();

/**
 * Step two: once the user has approved, trade the device code for a refresh token. Waits a
 * little (`waitMs`) in case they're a moment behind, then says to finish signing in.
 */
export async function redeemOneDriveSignIn(
  app: { clientId: string; tenant: string; endpoint?: string },
  deviceCode: string,
  { waitMs = 12_000, intervalMs = 5_000 } = {},
): Promise<string> {
  const id = createHash("sha256").update(`${app.clientId}\n${app.tenant}\n${deviceCode}`).digest("hex");
  const now = Date.now();
  for (const [key, value] of redeemed) if (value.expires < now) redeemed.delete(key);
  const cached = redeemed.get(id);
  if (cached) return cached.refreshToken;

  for (const started = Date.now(); ; ) {
    const out = await loginRequest<TokenBody>(app.tenant, app.endpoint, "token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: app.clientId,
      device_code: deviceCode,
    });
    if (out.ok && out.body.access_token) {
      if (!out.body.refresh_token) throw new StorageUserError("Microsoft didn't grant offline access. Sign in again.", 502);
      redeemed.set(id, { refreshToken: out.body.refresh_token, expires: Date.now() + 15 * 60_000 });
      remember(tokenId(out.body.refresh_token), out.body, out.body.refresh_token);
      return out.body.refresh_token;
    }
    switch (out.body.error) {
      case "authorization_pending":
      case "slow_down":
        if (Date.now() - started + intervalMs > waitMs)
          throw new StorageUserError("Microsoft is still waiting for the code — enter it in the Microsoft tab and approve, then click Connect again.", 400);
        await sleep(intervalMs);
        continue;
      case "authorization_declined":
        throw new StorageUserError("The sign-in was declined at Microsoft. Click “Sign in with Microsoft” to try again.", 400);
      case "expired_token":
      case "bad_verification_code":
      case "invalid_grant":
        throw new StorageUserError("That sign-in code has expired or was already used — click “Sign in with Microsoft” for a new one.", 400);
      default:
        throw appProblem(out.body);
    }
  }
}

/* ------------------------------------------------------------------ */

const isNotFound = (error: unknown) => error instanceof GraphError && (error.status === 404 || error.code === "itemNotFound");
const isConflict = (error: unknown) => error instanceof GraphError && (error.status === 409 || error.code === "nameAlreadyExists");
const isDenied = (error: unknown) => error instanceof GraphError && (error.status === 403 || error.status === 423);

function explain(error: unknown, target: Target): StorageUserError {
  if (error instanceof StorageUserError) return error;
  if (!(error instanceof GraphError)) {
    if (networkCode(error)) return unreachable(undefined, "OneDrive");
    console.error("[onedrive] unexpected error", error);
    return new StorageUserError("OneDrive returned an unexpected error. Try again.", 502);
  }
  if (isNotFound(error)) return new StorageUserError("That file or folder no longer exists.", 404);
  if (error.code === "nameAlreadyExists") return new StorageUserError("Something with that name is already there.", 409);
  if (error.code === "quotaLimitReached" || error.status === 507)
    return new StorageUserError(`The OneDrive holding “${target.root}” is full.`, 507);
  if (error.status === 423 || error.code === "resourceLocked" || error.code === "notAllowed")
    return new StorageUserError("That item is locked — it may be open in an Office app. Try again in a moment.", 423);
  if (error.status === 403) return new StorageUserError("OneDrive doesn't allow that here.", 403);
  if (error.status === 409) return new StorageUserError("OneDrive says that item changed in the meantime. Try again.", 409);
  if (error.status === 429 || error.status === 503) return new StorageUserError("OneDrive is busy — try again in a moment.", 429);
  // Bad names, paths that are too long, a drive that was never set up: Graph says which.
  if (error.status === 400) return new StorageUserError(`OneDrive didn't accept that: ${error.message.slice(0, 200)}`, 400);
  console.error("[onedrive] unexpected error", error.status, error.code, error.message.slice(0, 300));
  return new StorageUserError("OneDrive returned an unexpected error. Try again.", 502);
}

/** Cuts a byte stream into pieces of exactly `size` (the last may be shorter, or empty for an empty file). */
async function* pieces(body: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array, void, void> {
  const reader = body.getReader();
  let pending: Uint8Array[] = [];
  let bytes = 0;
  let yielded = false;
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending.push(value);
      bytes += value.byteLength;
      while (bytes >= size) {
        const all = Buffer.concat(pending, bytes);
        const rest = all.subarray(size);
        pending = rest.byteLength ? [rest] : [];
        bytes = rest.byteLength;
        yielded = true;
        yield new Uint8Array(all.buffer, all.byteOffset, size);
      }
    }
    finished = true;
    if (bytes || !yielded) {
      const all = Buffer.concat(pending, bytes);
      yield new Uint8Array(all.buffer, all.byteOffset, all.byteLength);
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
  }
}

const parentOf = (key: string) => {
  const trimmed = key.replace(/\/$/, "");
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
};
const nameOf = (key: string) => key.replace(/\/$/, "").split("/").pop() ?? "";
const modifiedOf = (item: Item) => (item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime).toISOString() : null);
const hashOf = (item: Item) => item.file?.hashes?.sha256Hash ?? item.file?.hashes?.quickXorHash ?? item.file?.hashes?.sha1Hash ?? null;

export function oneDriveDriver(target: Target): StorageDriver {
  const graph = `${target.endpoint ?? GRAPH}/v1.0`;
  const base = target.root === "/" ? "" : target.root;
  /** Key → OneDrive path; "" is the connection's root, and the root of a drive is "". */
  const pathOf = (key: string) => (key ? `${base}/${key.replace(/\/$/, "")}` : base);
  /** Graph's path addressing: /me/drive/root:/a/b:/children — or /me/drive/root/children at the top. */
  const itemUrl = (key: string, suffix = "") => {
    const path = pathOf(key);
    return path ? `${graph}/me/drive/root:${path.split("/").map(encodeURIComponent).join("/")}:${suffix}` : `${graph}/me/drive/root${suffix}`;
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const jsonBody = (token: string, method: string, body: unknown): RequestInit => ({
    method,
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  /**
   * One request, with a token refresh on 401 and backoff on throttling. Download, upload
   * and copy-monitor URLs are pre-authenticated: they're called with `auth: false`, and
   * must not be sent the token.
   */
  async function request(
    url: string,
    init: (token: string) => RequestInit,
    { auth = true, accept = [] as number[] } = {},
  ): Promise<Response> {
    let force = false;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = auth ? await accessToken(target, force) : "";
      force = false;
      const response = await fetch(url, init(token)).catch(networkError);
      if (response.ok || accept.includes(response.status)) return response;
      const text = await response.text().catch(() => "");
      let code = "";
      let message = "";
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code ?? "";
        message = parsed.error?.message ?? "";
      } catch {
        // Not JSON: storage hosts behind the pre-authenticated URLs answer in plain text.
      }
      if (response.status === 401 && auth) {
        if (!refreshed) {
          refreshed = force = true;
          continue;
        }
        throw new StorageUserError("OneDrive access was revoked or has lapsed — reconnect this OneDrive.", 401);
      }
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 4) {
        const wait = Number(response.headers.get("retry-after"));
        await sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 500 * 2 ** attempt, 15_000));
        continue;
      }
      if (response.status === 416) throw unsatisfiable();
      throw new GraphError(response.status, code, message);
    }
  }

  async function run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw explain(error, target);
    }
  }

  async function meta(key: string): Promise<Item> {
    const response = await request(`${itemUrl(key)}?$select=id,name,size,file,folder,parentReference`, (token) => ({ headers: bearer(token) }));
    return (await response.json()) as Item;
  }

  /** One page of a folder's children; `link` is the previous page's @odata.nextLink. */
  async function children(folder: string, link?: string): Promise<Children> {
    // The page token goes back to the browser and returns: only ever follow it to Graph.
    if (link && !link.startsWith(`${graph}/`)) throw new StorageUserError("Invalid page token.", 400);
    const url = link ?? `${itemUrl(folder, "/children")}?$top=${PAGE}&$select=${SELECT}`;
    const response = await request(url, (token) => ({ headers: bearer(token) }));
    return (await response.json()) as Children;
  }

  /** Files and folders only: not OneNote notebooks or links to other people's drives. */
  const listable = (item: Item) => !item.package && Boolean(item.file || item.folder);

  /**
   * Walks the tree under `prefix`, a few folders at a time, calling `onItem` with each
   * file ("a/b.txt") and folder ("a/b/") key. Stops when `onItem` returns false or the
   * budget runs out; resolves true when it stopped with more left to see.
   */
  async function walk(prefix: string, onItem: (key: string, item: Item) => boolean | void, maxPages = Infinity): Promise<boolean> {
    // A "page" elsewhere is about 1,000 objects; here it also bounds the requests made.
    const maxEntries = maxPages * 1000;
    const maxRequests = maxPages * 25;
    const queue = [prefix];
    let active = 0;
    let entries = 0;
    let requests = 0;
    let stopped = false;
    let truncated = false;
    let failure: unknown;

    async function visit(folder: string) {
      let link: string | undefined;
      do {
        if (stopped) return;
        if (requests >= maxRequests || entries >= maxEntries) {
          stopped = truncated = true;
          return;
        }
        requests++;
        let page: Children;
        try {
          page = await children(folder, link);
        } catch (error) {
          // A subfolder deleted mid-walk, or one that's locked (Personal Vault): skip it.
          if (folder !== prefix && (isNotFound(error) || isDenied(error))) return;
          throw error;
        }
        for (const item of page.value) {
          if (!listable(item)) continue;
          entries++;
          const key = folder + item.name + (item.folder ? "/" : "");
          if (item.folder && (item.folder.childCount ?? 1) > 0) queue.push(key);
          if (onItem(key, item) === false) {
            stopped = truncated = true;
            return;
          }
        }
        link = page["@odata.nextLink"];
      } while (link);
    }

    await new Promise<void>((resolve) => {
      const pump = () => {
        while (!stopped && failure === undefined && active < WALKERS && queue.length) {
          active++;
          visit(queue.shift()!)
            .catch((error: unknown) => {
              failure ??= error;
            })
            .finally(() => {
              active--;
              pump();
            });
        }
        if (!active) resolve();
      };
      pump();
    });
    if (failure !== undefined) throw failure;
    return truncated;
  }

  /** Makes a folder and any missing parents. Already there is fine. */
  async function ensureFolder(key: string): Promise<void> {
    if (!key) return;
    const parent = parentOf(key);
    const name = nameOf(key);
    const create = () =>
      request(itemUrl(parent, "/children"), (token) =>
        jsonBody(token, "POST", { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
      );
    try {
      await create();
    } catch (error) {
      if (isConflict(error)) {
        if (!(await meta(key)).folder) throw new StorageUserError(`“${name}” is a file, not a folder.`, 409);
        return;
      }
      if (!isNotFound(error) || !parent) throw error;
      await ensureFolder(parent);
      await create().catch((again: unknown) => {
        if (!isConflict(again)) throw again;
      });
    }
  }

  /** Runs a write; if OneDrive says the parent folder is missing, makes it and tries once more. */
  async function withParent<T>(key: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const parent = parentOf(key);
      if (!isNotFound(error) || !parent) throw error;
      await ensureFolder(parent);
      return work();
    }
  }

  /** A folder's id (made first if it doesn't exist), to move or copy something into it. */
  async function folderRef(key: string): Promise<{ id: string; driveId?: string }> {
    let item: Item;
    try {
      item = await meta(key);
    } catch (error) {
      if (!isNotFound(error) || !key) throw error;
      await ensureFolder(key);
      item = await meta(key);
    }
    if (!item.folder) throw new StorageUserError(`“${nameOf(key)}” is a file, not a folder.`, 400);
    if (!item.id) throw new StorageUserError("OneDrive returned an unexpected error. Try again.", 502);
    return { id: item.id, driveId: item.parentReference?.driveId };
  }

  /** One request: fine up to a few megabytes. */
  const putSmall = (key: string, body: Uint8Array) =>
    withParent(key, () =>
      request(itemUrl(key, "/content"), (token) => ({
        method: "PUT",
        headers: { ...bearer(token), "content-type": "application/octet-stream" },
        // Always backed by a plain ArrayBuffer here (from Buffer.concat or a caller's bytes).
        body: body as Uint8Array<ArrayBuffer>,
      })),
    );

  /** Copies run in the background on OneDrive: poll the monitor URL until one is done. */
  async function awaitCopy(monitor: string) {
    for (let polls = 0; polls < 400; polls++) {
      const response = await request(monitor, () => ({ redirect: "manual" }), { auth: false, accept: [302, 303] });
      // OneDrive for Business answers a finished copy by redirecting to the new item.
      if (response.status === 302 || response.status === 303) return void (await response.body?.cancel().catch(() => {}));
      const body = (await response.json().catch(() => ({}))) as { status?: string; error?: { code?: string; message?: string } };
      if (body.status === "completed") return;
      if (body.status === "failed" || body.error) {
        const code = body.error?.code ?? "";
        throw new GraphError(code === "nameAlreadyExists" ? 409 : 500, code, body.error?.message ?? "");
      }
      await sleep(Math.min(250 * (polls + 1), 1500));
    }
    throw new StorageUserError("OneDrive is still copying — check back in a minute.", 504);
  }

  return {
    // Folders are real on OneDrive: copy, rename and remove act on a whole tree at once.
    nativeFolders: true,

    verify: () =>
      run(async () => {
        try {
          const item = await meta("");
          if (!item.folder) throw new StorageUserError(`“${target.root}” is a file, not a folder.`, 400);
        } catch (error) {
          if (base && isNotFound(error)) throw new StorageUserError(`No folder “${target.root}” in this OneDrive.`, 404);
          throw error;
        }
        return {};
      }),

    list: (prefix, token) =>
      run(async () => {
        let page: Children;
        try {
          page = await children(prefix, token);
        } catch (error) {
          // A folder that's gone reads as empty, as a prefix with nothing under it does on S3.
          if (prefix && isNotFound(error)) return { folders: [], files: [] };
          if (!prefix && isNotFound(error)) throw new StorageUserError(`No folder “${target.root}” in this OneDrive.`, 404);
          throw error;
        }
        const listing: Listing = { folders: [], files: [], nextToken: page["@odata.nextLink"] };
        for (const item of page.value) {
          if (!listable(item)) continue;
          if (item.folder) listing.folders.push(`${prefix}${item.name}/`);
          else
            listing.files.push({
              key: prefix + item.name,
              size: item.size ?? 0,
              lastModified: modifiedOf(item),
              etag: hashOf(item),
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
            return { keys: (await meta(prefix)).file ? [prefix] : [], truncated: false };
          } catch (error) {
            if (isNotFound(error)) return { keys: [], truncated: false };
            throw error;
          }
        }
        const keys: string[] = [];
        let more: boolean;
        try {
          more = await walk(prefix, (key, item) => {
            if (item.file || (item.folder?.childCount ?? 1) === 0) keys.push(key);
            return keys.length <= max;
          });
        } catch (error) {
          if (isNotFound(error)) return { keys: [], truncated: false };
          throw error;
        }
        // The folder itself, when it exists and holds nothing.
        if (prefix && !keys.length) keys.push(prefix);
        return { keys: keys.slice(0, max), truncated: more || keys.length > max };
      }),

    stats: (prefix, maxPages = 20) =>
      run(async () => {
        const stats: FolderStats = { objects: 0, bytes: 0, lastModified: null, truncated: false };
        try {
          stats.truncated = await walk(
            prefix,
            (_key, item) => {
              if (!item.file) return;
              stats.objects += 1;
              stats.bytes += item.size ?? 0;
              const modified = modifiedOf(item);
              if (modified && (!stats.lastModified || modified > stats.lastModified)) stats.lastModified = modified;
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
            const item = await meta(prefix);
            if (item.file)
              return {
                files: [{ key: prefix, size: item.size ?? 0, lastModified: modifiedOf(item), etag: hashOf(item), storageClass: null }],
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
            (key, item) => {
              if (!item.file) return;
              files.push({ key, size: item.size ?? 0, lastModified: modifiedOf(item), etag: hashOf(item), storageClass: null });
            },
            maxPages,
          );
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        return { files, truncated };
      }),

    // OneDrive's download URLs lapse within the hour whatever expiry was chosen, and its
    // sharing links are public until revoked — so files are served through this app instead.
    signedUrl: () => Promise.resolve(null),

    read: (key, range) =>
      run(async () => {
        const wanted: Record<string, string> = range ? { range: rangeHeader(range) } : {};
        const url = itemUrl(key, "/content");
        let response = await request(url, (token) => ({ headers: { ...bearer(token), ...wanted }, redirect: "manual" }), {
          accept: [301, 302, 303, 307, 308],
        });
        // /content answers with a redirect to a pre-authenticated URL; the Range belongs on that one.
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => {});
          if (!location) throw new StorageUserError("OneDrive returned an unexpected error. Try again.", 502);
          response = await request(new URL(location, url).href, () => ({ headers: wanted }), { auth: false });
        }
        if (!response.body) throw new StorageUserError("That file is empty or gone.", 404);
        const served = response.status === 206 ? parseContentRange(response.headers.get("content-range")) : undefined;
        const length = Number(response.headers.get("content-length"));
        const size = response.headers.has("content-length") && Number.isFinite(length) && length >= 0 ? length : undefined;
        return {
          stream: response.body,
          contentType: mimeOf(key) ?? response.headers.get("content-type") ?? undefined,
          size,
          total: served ? served.total : size,
          range: served ? { start: served.start, end: served.end } : undefined,
        };
      }),

    write: (key, body) =>
      run(async () => {
        if (key.endsWith("/")) return ensureFolder(key);
        await putSmall(key, body);
      }),

    // One request below a chunk; above it, an upload session fed 10 MiB at a time.
    upload: (key, body, size) =>
      run(async () => {
        const parts = pieces(body, CHUNK);
        let session: string | undefined;
        try {
          const first = await parts.next();
          const second = await parts.next();
          if (first.done) return;
          if (second.done) return void (await putSmall(key, first.value));
          // Every fragment names the total, so a stream of unknown length can't be sent.
          if (size === undefined) throw new StorageUserError("OneDrive needs the file size up front — retry the upload.", 411);

          const created = await withParent(key, () =>
            request(itemUrl(key, "/createUploadSession"), (token) =>
              jsonBody(token, "POST", { item: { "@microsoft.graph.conflictBehavior": "replace" } }),
            ),
          );
          const uploadUrl = ((await created.json()) as { uploadUrl?: string }).uploadUrl;
          if (!uploadUrl) throw new StorageUserError("OneDrive didn't open an upload session. Try again.", 502);
          session = uploadUrl;

          let offset = 0;
          let complete = false;
          const put = async (part: Uint8Array) => {
            const response = await request(
              uploadUrl,
              () => ({
                method: "PUT",
                headers: { "content-range": `bytes ${offset}-${offset + part.byteLength - 1}/${size}` },
                body: part as Uint8Array<ArrayBuffer>,
              }),
              { auth: false },
            );
            await response.body?.cancel().catch(() => {});
            // 202 while it wants more; 200 or 201, with the new item, once it has it all.
            complete = response.status === 200 || response.status === 201;
            offset += part.byteLength;
          };
          await put(first.value);
          await put(second.value);
          for await (const part of parts) await put(part);
          if (!complete) throw new StorageUserError("The upload ended before the whole file arrived. Try again.", 400);
          session = undefined;
        } catch (error) {
          await parts.return().catch(() => {});
          if (session) await request(session, () => ({ method: "DELETE" }), { auth: false, accept: [404] }).catch(() => {});
          throw error;
        }
      }),

    // Deleted items go to the OneDrive recycle bin, where they can be restored for a while.
    remove: (keys) =>
      run(async () => {
        const failed: string[] = [];
        await eachLimit(keys, 4, async (key) => {
          // Never the connection's own root folder.
          if (!key) return void failed.push(key);
          try {
            await request(itemUrl(key), (token) => ({ method: "DELETE", headers: bearer(token) }));
          } catch (error) {
            if (isNotFound(error)) return; // already gone counts as deleted
            if (error instanceof StorageUserError && error.status === 401) throw error;
            failed.push(key);
          }
        });
        return { failed };
      }),

    copy: (source, destination) =>
      run(async () => {
        const parent = await folderRef(parentOf(destination));
        const response = await request(itemUrl(source, "/copy"), (token) =>
          jsonBody(token, "POST", {
            parentReference: parent.driveId ? { driveId: parent.driveId, id: parent.id } : { id: parent.id },
            name: nameOf(destination),
          }),
        );
        const monitor = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (monitor) await awaitCopy(monitor);
      }),

    rename: (source, destination) =>
      run(async () => {
        const change: { name: string; parentReference?: { id: string } } = { name: nameOf(destination) };
        if (parentOf(source) !== parentOf(destination)) change.parentReference = { id: (await folderRef(parentOf(destination))).id };
        await request(itemUrl(source), (token) => jsonBody(token, "PATCH", change));
      }),
  };
}

/** The account's sign-in name, for the sidebar hint; null if Graph won't say. */
export async function oneDriveAccount(target: Omit<Target, "root">): Promise<string | null> {
  try {
    const token = await accessToken({ ...target, root: "/" }, false);
    const response = await fetch(`${target.endpoint ?? GRAPH}/v1.0/me?$select=mail,userPrincipalName`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { mail?: string | null; userPrincipalName?: string };
    return body.mail || body.userPrincipalName || null;
  } catch {
    return null;
  }
}
