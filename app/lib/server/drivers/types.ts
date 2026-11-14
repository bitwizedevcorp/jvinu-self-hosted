import "server-only";

export class StorageUserError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type Listing = {
  folders: string[];
  files: {
    key: string;
    size: number;
    /**
     * Set when the service can't say how big the file is until it's read (a Google document,
     * exported on request); `size` is 0 then. Never set for a real empty file.
     */
    sizeUnknown?: boolean;
    lastModified: string | null;
    etag: string | null;
    storageClass: string | null;
  }[];
  /** Pass back to list() for the next page; absent on the last page. */
  nextToken?: string;
};

/** One file, as a listing shows it. */
export type ListedFile = Listing["files"][number];

/**
 * `findFile` for a driver that has `head`: the head's facts, or null when the provider says
 * there's nothing there (404).
 */
export async function fileFromHead(key: string, head: () => Promise<ObjectHead>): Promise<ListedFile | null> {
  if (!key || key.endsWith("/")) return null;
  try {
    const found = await head();
    return { key, size: found.size ?? 0, lastModified: found.lastModified ?? null, etag: found.etag ?? null, storageClass: found.storageClass ?? null };
  } catch (error) {
    if (error instanceof StorageUserError && error.status === 404) return null;
    throw error;
  }
}

/** Is something already at this key: the file, or for a folder key, anything below it? */
export async function isTaken(driver: StorageDriver, key: string): Promise<boolean> {
  if (key.endsWith("/")) return (await driver.listKeys(key, 1)).keys.length > 0;
  return (await driver.findFile(key)) !== null;
}

export type FolderStats = {
  objects: number;
  bytes: number;
  lastModified: string | null;
  /** True when the page cap was hit, so the totals are a lower bound. */
  truncated: boolean;
};

export type ObjectBody = {
  stream: ReadableStream<Uint8Array>;
  contentType?: string;
  /** Bytes in this body (the range's length when one was served). */
  size?: number;
  /** The whole object's size, when the service says. */
  total?: number;
  /** Set when only part of the object was served: inclusive byte offsets. */
  range?: { start: number; end: number };
};

/** How an object is encrypted at rest, as far as the provider says. */
export type Encryption = {
  state: "encrypted" | "unencrypted" | "unknown";
  /** Whose keys: the provider's own, a key-management service, the customer's, or jvinu's. */
  keys?: "provider" | "kms" | "customer" | "jvinu";
  /** "AES-256 (SSE-S3)", "always on at Azure"… */
  detail?: string;
};

export type ObjectHead = {
  size?: number;
  contentType?: string;
  cacheControl?: string | null;
  contentDisposition?: string | null;
  etag?: string | null;
  storageClass?: string | null;
  lastModified?: string | null;
  encryption: Encryption;
};

/**
 * One metadata edit, applied to each object it's given. Fields left out stay as they are;
 * an empty string clears Cache-Control or Content-Disposition; `tags` replaces the tag set.
 */
export type MetadataChange = {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  storageClass?: string;
  tags?: Record<string, string>;
};

/** Which parts of an object's metadata a connection can change, and to what classes. */
export type MetadataSupport = {
  contentType: boolean;
  cacheControl: boolean;
  contentDisposition: boolean;
  tags: boolean;
  storageClasses: string[];
};

/** Inclusive byte offsets; no `end` means "to the end of the object". */
export type ByteRange = { start: number; end?: number };

export const rangeHeader = (range: ByteRange) => `bytes=${range.start}-${range.end ?? ""}`;

/** "bytes 0-99/1234" → offsets and total; undefined when absent or unparseable. */
export function parseContentRange(value: string | null | undefined): { start: number; end: number; total?: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === "*" ? undefined : Number(match[3]) };
}

export const unsatisfiable = () => new StorageUserError("That byte range is outside the file.", 416);

/** A multipart upload that was started and never finished: its parts are billed, and no listing shows them. */
export type IncompleteUpload = { key: string; uploadId: string; initiated: string | null; bytes: number | null };

/** One version of an object, or a delete marker, on a versioned bucket. */
export type VersionEntry = {
  key: string;
  versionId: string;
  size: number;
  lastModified: string | null;
  latest: boolean;
  deleteMarker: boolean;
  storageClass: string | null;
};

/** Who can reach a bucket without credentials. null: this service wouldn't say. */
export type Exposure = {
  /** All four "block public access" switches are on. */
  blocked: boolean | null;
  policyPublic: boolean | null;
  aclPublic: boolean | null;
  /** A request with no credentials could list the bucket. */
  anonymousListing: boolean | null;
};

/** Bucket-level facts no file listing shows: what Storage X-Ray reads besides the inventory. */
export interface BucketAudit {
  incompleteUploads(maxPages?: number): Promise<{ uploads: IncompleteUpload[]; truncated: boolean }>;
  versioning(): Promise<"enabled" | "suspended" | "off" | "unknown">;
  versions(prefix: string, maxPages?: number): Promise<{ versions: VersionEntry[]; truncated: boolean }>;
  exposure(): Promise<Exposure>;
  /** Whether one object answers a request with no credentials. */
  publicObject(key: string): Promise<boolean | null>;
}

/**
 * Everything the app does to a connection's place, whichever provider holds it.
 *
 * The contract every driver keeps (tests/drivers.contract.test.ts holds each one to it):
 *
 * - **Keys.** "a/b.txt" names a file; a key ending in "/" ("a/") names a folder; "" is the
 *   connection's top. Keys never hold "." or ".." segments (driverFor refuses them).
 * - **Folder markers.** `write("a/", empty)` makes an empty folder. A marker is never listed
 *   as a file, never counted, and never inventoried; `listKeys` returns an empty folder's own
 *   key, since that's what must be deleted or copied to keep it.
 * - **Folders, and one file.** `list`, `listKeys`, `stats` and `inventory` take a folder key
 *   (or "") and cover what's below it; driverFor turns a folder named without its "/" ("a")
 *   into "a/" before any driver sees it. "Is there a file at exactly this key?" is `findFile`.
 * - **Pages.** `nextToken` is opaque: pass it back to `list` with the same prefix, nothing
 *   else. driverFor binds each token to its connection and prefix and refuses any other.
 * - **Sizes.** `size` is the bytes `read` will return. When the service can't know them until
 *   the file is read (a Google document's export), `size` is 0 and `sizeUnknown` is set.
 * - **Errors.** Failures a person can act on are `StorageUserError`s with an HTTP status:
 *   404 for a missing file or connection folder, 416 for a range outside the file, 409 for a
 *   name that's taken.
 */
export interface StorageDriver {
  /** Proves the credentials can list the bucket; returns its region if the service says. 404 if it isn't there. */
  verify(): Promise<{ region?: string }>;
  /** The file at exactly this key, as a listing would show it — or null when there's none (or the key is a folder key). */
  findFile(key: string): Promise<ListedFile | null>;
  /** One page (≤ 1,000 entries) of one folder level: files and the folders below. A folder that's gone reads as empty. */
  list(prefix: string, token?: string): Promise<Listing>;
  /** Every key below a folder, flat, up to `max`: files and empty folders' own keys. */
  listKeys(prefix: string, max: number): Promise<{ keys: string[]; truncated: boolean }>;
  /** Files and bytes below a folder, reading up to `maxPages` pages of about 1,000. */
  stats(prefix: string, maxPages?: number): Promise<FolderStats>;
  /**
   * Every file below a folder, flat, with size, class and date —
   * up to `maxPages` pages of about 1,000. For analytics, SQL, zips; `truncated` when the cap was hit.
   */
  inventory(prefix: string, maxPages?: number): Promise<{ files: Listing["files"]; truncated: boolean }>;
  /** A signed URL anyone can use, or null when this connection can't sign one. */
  signedUrl(key: string, download: boolean, expiresIn: number): Promise<string | null>;
  /** The object's bytes — or only `range` of them, for media seeking and resumed downloads. 404 if missing, 416 if out of range. */
  read(key: string, range?: ByteRange): Promise<ObjectBody>;
  /** Small, in-memory writes; a folder key with empty bytes makes an empty folder. Overwrites. */
  write(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  /** Streams a file of any size — multipart / block / resumable as the provider prefers. Overwrites. */
  upload(key: string, body: ReadableStream<Uint8Array>, size: number | undefined, contentType?: string): Promise<void>;
  /** Deletes keys; returns the ones that couldn't be deleted. A key that's already gone isn't a failure. */
  remove(keys: string[]): Promise<{ failed: string[] }>;
  /** Server-side where the provider supports it. 404 if the source is missing. */
  copy(source: string, destination: string): Promise<void>;
  /** One object's metadata, including how it's encrypted at rest. */
  head?(key: string): Promise<ObjectHead>;
  /** Changes headers, storage class or tags in place (a self-copy where the cloud needs one). */
  setMetadata?(key: string, change: MetadataChange): Promise<void>;
  /** What setMetadata can change here; absent with it. */
  metadataSupport?: MetadataSupport;
  /** A native rename, where one exists; otherwise callers copy then delete. */
  rename?(source: string, destination: string): Promise<void>;
  /**
   * Folders are real (Dropbox, OneDrive, Google Drive): copy, rename and remove take a folder
   * key ("a/") and act on the whole tree in one call, so callers needn't expand it object by object.
   */
  nativeFolders?: boolean;
  /** Bucket-level checks for Storage X-Ray; absent where the provider has no API for them. */
  audit?: BucketAudit;
  /**
   * Set when the bucket holds only ciphertext (jvinu encryption): whatever this server
   * keeps that's derived from the files' contents (thumbnails) is sealed with it too.
   */
  cacheCipher?: { seal(data: Uint8Array): Uint8Array; open(data: Uint8Array): Uint8Array };
}

/** Runs `work` over items with at most `limit` in flight. */
export async function eachLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(runners);
}

export const NETWORK_CODES = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "REQUEST_SEND_ERROR"];

export function unreachable(endpoint: string | undefined, fallback: string) {
  return new StorageUserError(
    endpoint ? `Couldn't reach ${endpoint} — is the service running?` : `Couldn't reach ${fallback}. Check the server's network connection.`,
    502,
  );
}

const codesOf = (error: unknown): unknown[] => {
  const e = error as { code?: unknown; cause?: { code?: unknown }; errors?: { code?: unknown }[] };
  return [e?.code, e?.cause?.code, ...(e?.errors ?? []).map((inner) => inner?.code)];
};

/** Pull a network error code out of whatever shape an SDK wrapped it in. */
export function networkCode(error: unknown): string | undefined {
  return codesOf(error).find((code): code is string => typeof code === "string" && NETWORK_CODES.includes(code));
}

/** The endpoint's name led to a cloud metadata address, and egress.ts wouldn't connect. */
export function egressRefused(error: unknown): StorageUserError | null {
  return codesOf(error).includes("EJVINUBLOCKED")
    ? new StorageUserError("This endpoint leads to a cloud metadata address, which jvinu doesn't connect to.", 400)
    : null;
}
