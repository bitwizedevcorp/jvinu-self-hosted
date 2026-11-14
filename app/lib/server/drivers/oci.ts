import "server-only";
import { Readable } from "node:stream";
import * as common from "oci-common";
import * as objectstorage from "oci-objectstorage";
import {
  eachLimit,
  egressRefused, networkCode,
  StorageUserError,
  unreachable,
  unsatisfiable,
  type FolderStats,
  type Listing,
  type StorageDriver,
  fileFromHead,
} from "./types";

type Target = {
  bucket: string;
  region: string;
  endpoint?: string;
  namespace: string;
  tenancy: string;
  user: string;
  fingerprint: string;
  privateKey: string;
  passphrase?: string;
};

function regionOf(regionId: string): common.Region | undefined {
  try {
    return common.Region.fromRegionId(regionId) ?? common.Region.register(regionId, common.Realm.OC1);
  } catch {
    return undefined;
  }
}

function explain(error: unknown, target: Target): StorageUserError {
  if (error instanceof StorageUserError) return error;
  const refused = egressRefused(error);
  if (refused) return refused;
  if (networkCode(error)) return unreachable(target.endpoint, "Oracle Cloud");
  const e = error as { statusCode?: number; serviceCode?: string; message?: string };
  const code = e?.serviceCode ?? "";
  if (code === "BucketNotFound")
    return new StorageUserError(`No bucket named “${target.bucket}” exists in namespace ${target.namespace}.`, 404);
  if (code === "ObjectNotFound") return new StorageUserError("That object no longer exists.", 404);
  if (code === "NamespaceNotFound") return new StorageUserError(`Namespace “${target.namespace}” wasn't found.`, 404);
  if (e?.statusCode === 404) return new StorageUserError(`No bucket named “${target.bucket}” exists in namespace ${target.namespace}.`, 404);
  if (code === "NotAuthenticated" || e?.statusCode === 401)
    return new StorageUserError("Oracle rejected the API key — check the tenancy, user, fingerprint and private key.", 400);
  if (code === "NotAuthorized" || e?.statusCode === 403)
    return new StorageUserError(`This user isn't allowed to do that on “${target.bucket}”.`, 403);
  if (/private key|PEM|decrypt/i.test(e?.message ?? ""))
    return new StorageUserError("That private key couldn't be read — paste the whole PEM, including the BEGIN/END lines.", 400);
  console.error("[oci] unexpected error", e?.statusCode, code, e?.message);
  return new StorageUserError("Oracle Cloud returned an unexpected error. Try again.", 502);
}

export function ociDriver(target: Target): StorageDriver {
  function client() {
    const provider = new common.SimpleAuthenticationDetailsProvider(
      target.tenancy,
      target.user,
      target.fingerprint,
      target.privateKey,
      target.passphrase || null,
      regionOf(target.region),
    );
    const os = new objectstorage.ObjectStorageClient({ authenticationDetailsProvider: provider });
    if (target.endpoint) os.endpoint = target.endpoint;
    return os;
  }
  const base = { namespaceName: target.namespace, bucketName: target.bucket };

  async function run<T>(work: (os: objectstorage.ObjectStorageClient) => Promise<T>): Promise<T> {
    const os = client();
    try {
      return await work(os);
    } catch (error) {
      throw explain(error, target);
    } finally {
      os.close();
    }
  }

  const asNode = (value: Readable | ReadableStream): Readable =>
    value instanceof Readable ? value : Readable.fromWeb(value as import("node:stream/web").ReadableStream);

  async function streamCopy(os: objectstorage.ObjectStorageClient, source: string, destination: string) {
    const got = await os.getObject({ ...base, objectName: source });
    await os.putObject({
      ...base,
      objectName: destination,
      putObjectBody: asNode(got.value),
      contentLength: got.contentLength,
      contentType: got.contentType,
    });
  }

  return {
    verify: () =>
      run(async (os) => {
        await os.listObjects({ ...base, limit: 1 });
        return {};
      }),

    list: (prefix, token) =>
      run(async (os) => {
        const { listObjects } = await os.listObjects({
          ...base,
          prefix,
          delimiter: "/",
          start: token,
          limit: 1000,
          fields: "name,size,timeModified,etag,storageTier",
        });
        const listing: Listing = { folders: [...(listObjects.prefixes ?? [])], files: [], nextToken: listObjects.nextStartWith || undefined };
        for (const item of listObjects.objects) {
          if (item.name === prefix || item.name.endsWith("/")) continue;
          listing.files.push({
            key: item.name,
            size: item.size ?? 0,
            lastModified: item.timeModified ? new Date(item.timeModified).toISOString() : null,
            etag: item.etag ?? null,
            storageClass: item.storageTier ? String(item.storageTier) : null,
          });
        }
        return listing;
      }),

    listKeys: (prefix, max) =>
      run(async (os) => {
        const keys: string[] = [];
        let start: string | undefined;
        do {
          const { listObjects } = await os.listObjects({ ...base, prefix, start, limit: 1000 });
          keys.push(...listObjects.objects.map((item) => item.name));
          start = listObjects.nextStartWith || undefined;
        } while (start && keys.length <= max);
        return { keys: keys.slice(0, max), truncated: keys.length > max || Boolean(start) };
      }),

    stats: (prefix, maxPages = 20) =>
      run(async (os) => {
        const stats: FolderStats = { objects: 0, bytes: 0, lastModified: null, truncated: false };
        let start: string | undefined;
        for (let page = 0; page < maxPages; page++) {
          const { listObjects } = await os.listObjects({ ...base, prefix, start, limit: 1000, fields: "name,size,timeModified" });
          for (const item of listObjects.objects) {
            if (item.name.endsWith("/")) continue;
            stats.objects += 1;
            stats.bytes += item.size ?? 0;
            const modified = item.timeModified ? new Date(item.timeModified).toISOString() : null;
            if (modified && (!stats.lastModified || modified > stats.lastModified)) stats.lastModified = modified;
          }
          start = listObjects.nextStartWith;
          if (!start) break;
        }
        stats.truncated = Boolean(start);
        return stats;
      }),

    inventory: (prefix, maxPages = 100) =>
      run(async (os) => {
        const files: Listing["files"] = [];
        let start: string | undefined;
        let page = 0;
        do {
          const { listObjects } = await os.listObjects({
            ...base,
            prefix,
            start,
            limit: 1000,
            fields: "name,size,timeModified,etag,storageTier",
          });
          for (const item of listObjects.objects) {
            if (item.name.endsWith("/")) continue;
            files.push({
              key: item.name,
              size: item.size ?? 0,
              lastModified: item.timeModified ? new Date(item.timeModified).toISOString() : null,
              etag: item.etag ?? null,
              storageClass: item.storageTier ? String(item.storageTier) : null,
            });
          }
          start = listObjects.nextStartWith || undefined;
        } while (start && ++page < maxPages);
        return { files, truncated: Boolean(start) };
      }),

    // Public links on OCI are pre-authenticated requests — a resource you create and must
    // later revoke. Not done implicitly; objects are served through this app instead.
    signedUrl: () => Promise.resolve(null),

    // Oracle encrypts all Object Storage data at rest; the HEAD response doesn't say more.
    // The file at exactly this key: what its head says, or nothing on a 404.
    findFile(key) {
      return fileFromHead(key, () => this.head!(key));
    },

    head: (key) =>
      run(async (os) => {
        const out = await os.headObject({ ...base, objectName: key });
        // A date the SDK couldn't parse comes back as an invalid Date: report none, don't throw.
        const modified = out.lastModified ? new Date(out.lastModified) : null;
        return {
          size: out.contentLength,
          contentType: out.contentType,
          etag: out.eTag ?? null,
          storageClass: out.storageTier ? String(out.storageTier) : null,
          lastModified: modified && !Number.isNaN(modified.getTime()) ? modified.toISOString() : null,
          encryption: target.endpoint ? { state: "unknown" } : { state: "encrypted", keys: "provider", detail: "AES-256, Oracle-managed keys" },
        };
      }),

    read: (key, range) =>
      run(async (os) => {
        // The SDK never parses Content-Range (it lowercases "common.Range" before matching
        // it) and can't send an open-ended range, so a ranged read learns the object's size
        // first and works the range out itself.
        let total: number | undefined;
        if (range) {
          total = (await os.headObject({ ...base, objectName: key })).contentLength;
          if (total !== undefined && range.start >= total) throw unsatisfiable();
        }
        let response;
        try {
          // An open end must be spelled out: the SDK would send "bytes=7-null".
          const end = range && total !== undefined ? Math.min(range.end ?? total - 1, total - 1) : range?.end;
          response = await os.getObject({
            ...base,
            objectName: key,
            range: range ? new common.Range(range.start, end ?? null, null) : undefined,
          });
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode === 416) throw unsatisfiable();
          throw error;
        }
        const value = response.value;
        const stream =
          value instanceof Readable ? (Readable.toWeb(value) as ReadableStream<Uint8Array>) : (value as ReadableStream<Uint8Array>);
        let served: { start: number; end: number } | undefined;
        if (range && total !== undefined) {
          const end = Math.min(range.end ?? total - 1, total - 1);
          // Only call it partial if the body really is that slice; a server that ignored
          // the range sent the whole object, which goes out as an ordinary response.
          if (response.contentLength === end - range.start + 1) served = { start: range.start, end };
        }
        return {
          stream,
          contentType: response.contentType,
          size: response.contentLength,
          total: total ?? response.contentLength,
          range: served,
        };
      }),

    write: (key, body, contentType) =>
      run(async (os) => {
        await os.putObject({ ...base, objectName: key, putObjectBody: Buffer.from(body), contentLength: body.byteLength, contentType });
      }),

    // A single streamed PUT (OCI accepts up to 50 GB that way); the length must be known.
    upload: (key, body, size, contentType) =>
      run(async (os) => {
        if (size === undefined) throw new StorageUserError("Oracle needs the file size up front — retry the upload.", 411);
        await os.putObject({
          ...base,
          objectName: key,
          putObjectBody: Readable.fromWeb(body as import("node:stream/web").ReadableStream),
          contentLength: size,
          contentType,
        });
      }),

    remove: (keys) =>
      run(async (os) => {
        const failed: string[] = [];
        await eachLimit(keys, 8, async (key) => {
          try {
            await os.deleteObject({ ...base, objectName: key });
          } catch (error) {
            if ((error as { statusCode?: number }).statusCode !== 404) failed.push(key);
          }
        });
        return { failed };
      }),

    // OCI's own CopyObject is an asynchronous work request; within a bucket a stream copy is simpler.
    copy: (source, destination) => run((os) => streamCopy(os, source, destination)),

    // Object Storage changes an object's tier in place; its headers can't change without a copy.
    metadataSupport: {
      contentType: false,
      cacheControl: false,
      contentDisposition: false,
      tags: false,
      storageClasses: target.endpoint ? [] : ["Standard", "InfrequentAccess", "Archive"],
    },

    setMetadata: (key, change) =>
      run(async (os) => {
        if (change.contentType !== undefined || change.cacheControl !== undefined || change.contentDisposition !== undefined || change.tags) {
          throw new StorageUserError("Oracle Object Storage can only change an object's tier here.", 400);
        }
        if (!change.storageClass) return;
        await os.updateObjectStorageTier({
          ...base,
          updateObjectStorageTierDetails: { objectName: key, storageTier: change.storageClass as never },
        });
      }),

    // RenameObject is native and atomic; fall back to copy + delete where it's missing.
    rename: (source, destination) =>
      run(async (os) => {
        try {
          await os.renameObject({ ...base, renameObjectDetails: { sourceName: source, newName: destination } });
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status !== 404 && status !== 405 && status !== 501) throw error;
          await streamCopy(os, source, destination);
          await os.deleteObject({ ...base, objectName: source });
        }
      }),
  };
}
