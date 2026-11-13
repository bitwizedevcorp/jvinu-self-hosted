import "server-only";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Storage, type File } from "@google-cloud/storage";
import { eachLimit, egressRefused, networkCode, StorageUserError, unreachable, unsatisfiable, type FolderStats, type Listing, type StorageDriver, fileFromHead } from "./types";

type Target = {
  bucket: string;
  endpoint?: string;
  projectId?: string;
  clientEmail?: string;
  privateKey?: string;
};

function explain(error: unknown, target: Target): StorageUserError {
  if (error instanceof StorageUserError) return error;
  const refused = egressRefused(error);
  if (refused) return refused;
  if (networkCode(error)) return unreachable(target.endpoint, "Google Cloud Storage");
  const e = error as { code?: number | string; message?: string };
  if (e?.code === 404) {
    return /bucket/i.test(e.message ?? "")
      ? new StorageUserError(`No bucket named “${target.bucket}” exists.`, 404)
      : new StorageUserError("That object no longer exists.", 404);
  }
  if (e?.code === 401) return new StorageUserError("Google rejected the service-account key.", 400);
  if (e?.code === 403)
    return new StorageUserError(`This service account isn't allowed to do that on “${target.bucket}”.`, 403);
  console.error("[gcs] unexpected error", e?.code, e?.message);
  return new StorageUserError("Google Cloud Storage returned an unexpected error. Try again.", 502);
}

type ListResponse = { prefixes?: string[]; nextPageToken?: string };

export function gcsDriver(target: Target): StorageDriver {
  const signed = Boolean(target.clientEmail && target.privateKey);
  const storage = new Storage({
    projectId: target.projectId || undefined,
    apiEndpoint: target.endpoint,
    // Emulators take no auth; the public service gets the service-account key.
    credentials: signed ? { client_email: target.clientEmail, private_key: target.privateKey } : undefined,
  });
  const bucket = storage.bucket(target.bucket);

  async function run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw explain(error, target);
    }
  }

  async function page(prefix: string, delimiter: string | undefined, pageToken: string | undefined) {
    const [files, , response] = await bucket.getFiles({ prefix, delimiter, pageToken, autoPaginate: false, maxResults: 1000 });
    return { files: files as File[], response: (response ?? {}) as ListResponse };
  }

  const timestamp = (file: File) => (file.metadata.updated ? new Date(file.metadata.updated).toISOString() : null);

  return {
    verify: () =>
      run(async () => {
        await page("", undefined, undefined);
        const [metadata] = await bucket.getMetadata();
        return { region: typeof metadata.location === "string" ? metadata.location.toLowerCase() : undefined };
      }),

    list: (prefix, token) =>
      run(async () => {
        const { files, response } = await page(prefix, "/", token);
        const listing: Listing = { folders: [...(response.prefixes ?? [])], files: [], nextToken: response.nextPageToken || undefined };
        for (const file of files) {
          if (file.name === prefix || file.name.endsWith("/")) continue;
          listing.files.push({
            key: file.name,
            size: Number(file.metadata.size ?? 0),
            lastModified: timestamp(file),
            etag: file.metadata.etag ?? null,
            storageClass: file.metadata.storageClass ?? null,
          });
        }
        return listing;
      }),

    listKeys: (prefix, max) =>
      run(async () => {
        const keys: string[] = [];
        let token: string | undefined;
        do {
          const { files, response } = await page(prefix, undefined, token);
          keys.push(...files.map((file) => file.name));
          token = response.nextPageToken || undefined;
        } while (token && keys.length <= max);
        return { keys: keys.slice(0, max), truncated: keys.length > max || Boolean(token) };
      }),

    stats: (prefix, maxPages = 20) =>
      run(async () => {
        const stats: FolderStats = { objects: 0, bytes: 0, lastModified: null, truncated: false };
        let token: string | undefined;
        for (let pageNo = 0; pageNo < maxPages; pageNo++) {
          const { files, response } = await page(prefix, undefined, token);
          for (const file of files) {
            if (file.name.endsWith("/")) continue;
            stats.objects += 1;
            stats.bytes += Number(file.metadata.size ?? 0);
            const modified = timestamp(file);
            if (modified && (!stats.lastModified || modified > stats.lastModified)) stats.lastModified = modified;
          }
          token = response.nextPageToken;
          if (!token) break;
        }
        stats.truncated = Boolean(token);
        return stats;
      }),

    inventory: (prefix, maxPages = 100) =>
      run(async () => {
        const files: Listing["files"] = [];
        let token: string | undefined;
        let pageNo = 0;
        do {
          const { files: batch, response } = await page(prefix, undefined, token);
          for (const file of batch) {
            if (file.name.endsWith("/")) continue;
            files.push({
              key: file.name,
              size: Number(file.metadata.size ?? 0),
              lastModified: timestamp(file),
              etag: file.metadata.etag ?? null,
              storageClass: file.metadata.storageClass ?? null,
            });
          }
          token = response.nextPageToken || undefined;
        } while (token && ++pageNo < maxPages);
        return { files, truncated: Boolean(token) };
      }),

    // Signing needs the service account's private key; emulator connections have none.
    signedUrl: (key, download, expiresIn) =>
      signed
        ? run(async () => {
            const filename = key.split("/").pop() ?? "download";
            const [url] = await bucket.file(key).getSignedUrl({
              version: "v4",
              action: "read",
              expires: Date.now() + expiresIn * 1000,
              responseDisposition: download ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` : undefined,
            });
            return url;
          })
        : Promise.resolve(null),

    // Google encrypts every object at rest; a KMS key or a customer key shows in its metadata.
    // The file at exactly this key: what its head says, or nothing on a 404.
    findFile(key) {
      return fileFromHead(key, () => this.head!(key));
    },

    head: (key) =>
      run(async () => {
        const [metadata] = await bucket.file(key).getMetadata();
        return {
          size: metadata.size !== undefined ? Number(metadata.size) : undefined,
          contentType: metadata.contentType,
          cacheControl: metadata.cacheControl ?? null,
          contentDisposition: metadata.contentDisposition ?? null,
          etag: metadata.etag ?? null,
          storageClass: metadata.storageClass ?? null,
          lastModified: metadata.updated ? new Date(metadata.updated).toISOString() : null,
          encryption: metadata.customerEncryption
            ? { state: "encrypted", keys: "customer", detail: "Customer-supplied key" }
            : metadata.kmsKeyName
              ? { state: "encrypted", keys: "kms", detail: `Cloud KMS · ${String(metadata.kmsKeyName).split("/").pop()}` }
              : target.endpoint
                ? { state: "unknown" }
                : { state: "encrypted", keys: "provider", detail: "AES-256, Google-managed keys" },
        };
      }),

    read: (key, range) =>
      run(async () => {
        const file = bucket.file(key);
        const [metadata] = await file.getMetadata();
        const total = metadata.size !== undefined ? Number(metadata.size) : undefined;
        if (!range || total === undefined) {
          return { stream: Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>, contentType: metadata.contentType, size: total, total };
        }
        if (range.start >= total) throw unsatisfiable();
        const end = Math.min(range.end ?? total - 1, total - 1);
        return {
          stream: Readable.toWeb(file.createReadStream({ start: range.start, end })) as ReadableStream<Uint8Array>,
          contentType: metadata.contentType,
          size: end - range.start + 1,
          total,
          range: { start: range.start, end },
        };
      }),

    write: (key, body, contentType) =>
      run(async () => {
        await bucket.file(key).save(Buffer.from(body), { contentType, resumable: false });
      }),

    // Resumable sessions on Google Cloud for anything sizeable; emulators take a plain upload.
    upload: (key, body, size, contentType) =>
      run(async () => {
        const resumable = !target.endpoint && (size === undefined || size > 8 * 1024 * 1024);
        await pipeline(
          Readable.fromWeb(body as import("node:stream/web").ReadableStream),
          bucket.file(key).createWriteStream({ resumable, contentType, metadata: contentType ? { contentType } : undefined }),
        );
      }),

    remove: (keys) =>
      run(async () => {
        const failed: string[] = [];
        await eachLimit(keys, 8, async (key) => {
          try {
            await bucket.file(key).delete({ ignoreNotFound: true });
          } catch {
            failed.push(key);
          }
        });
        return { failed };
      }),

    copy: (source, destination) =>
      run(async () => {
        await bucket.file(source).copy(bucket.file(destination));
      }),

    // Google has no object tags; its classes change by rewriting the object, server-side.
    metadataSupport: {
      contentType: true,
      cacheControl: true,
      contentDisposition: true,
      tags: false,
      storageClasses: target.endpoint ? [] : ["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"],
    },

    setMetadata: (key, change) =>
      run(async () => {
        const file = bucket.file(key);
        const headers: Record<string, string | null> = {};
        if (change.contentType) headers.contentType = change.contentType;
        if (change.cacheControl !== undefined) headers.cacheControl = change.cacheControl || null;
        if (change.contentDisposition !== undefined) headers.contentDisposition = change.contentDisposition || null;
        if (Object.keys(headers).length) await file.setMetadata(headers);
        if (change.storageClass) await file.setStorageClass(change.storageClass);
      }),
  };
}
