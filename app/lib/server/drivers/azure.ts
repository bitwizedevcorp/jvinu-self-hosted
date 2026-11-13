import "server-only";
import { Readable } from "node:stream";
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  RestError,
  StorageSharedKeyCredential,
  type ContainerClient,
} from "@azure/storage-blob";
import {
  eachLimit,
  egressRefused, networkCode,
  parseContentRange,
  StorageUserError,
  unreachable,
  unsatisfiable,
  type FolderStats,
  type Listing,
  type StorageDriver,
} from "./types";

type Target = { container: string; accountName: string; accountKey: string; endpoint?: string };

function explain(error: unknown, target: Target): StorageUserError {
  if (error instanceof StorageUserError) return error;
  const refused = egressRefused(error);
  if (refused) return refused;
  if (networkCode(error)) return unreachable(target.endpoint, "Azure");
  if (error instanceof RestError) {
    const code = String(error.code ?? (error.details as { errorCode?: string } | undefined)?.errorCode ?? "");
    if (code === "ContainerNotFound")
      return new StorageUserError(`No container named “${target.container}” exists in ${target.accountName}.`, 404);
    if (code === "BlobNotFound" || error.statusCode === 404) return new StorageUserError("That blob no longer exists.", 404);
    if (code === "AuthenticationFailed" || code === "InvalidAuthenticationInfo")
      return new StorageUserError("Azure rejected the account name or key.", 400);
    if (code.startsWith("AuthorizationPermission") || code === "AuthorizationFailure" || error.statusCode === 403)
      return new StorageUserError(`This key isn't allowed to do that on “${target.container}”.`, 403);
    if (code === "InvalidResourceName") return new StorageUserError(`“${target.container}” isn't a valid container name.`, 400);
    console.error("[azure] unexpected error", code, error.statusCode);
  } else {
    console.error("[azure] unexpected error", error);
  }
  return new StorageUserError("Azure returned an unexpected error. Try again.", 502);
}

const toNode = (stream: ReadableStream<Uint8Array>) => Readable.fromWeb(stream as import("node:stream/web").ReadableStream);

export function azureDriver(target: Target): StorageDriver {
  const credential = new StorageSharedKeyCredential(target.accountName, target.accountKey);
  const serviceUrl = target.endpoint ?? `https://${target.accountName}.blob.core.windows.net`;
  const container: ContainerClient = new BlobServiceClient(serviceUrl, credential).getContainerClient(target.container);

  async function run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw explain(error, target);
    }
  }

  function sas(key: string, expiresIn: number, download: boolean) {
    const filename = key.split("/").pop() ?? "download";
    return generateBlobSASQueryParameters(
      {
        containerName: target.container,
        blobName: key,
        permissions: BlobSASPermissions.parse("r"),
        startsOn: new Date(Date.now() - 60_000),
        expiresOn: new Date(Date.now() + expiresIn * 1000),
        contentDisposition: download ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` : undefined,
      },
      credential,
    ).toString();
  }

  return {
    verify: () =>
      run(async () => {
        // Properties first: some emulators answer a listing of a missing container with
        // an empty page instead of 404. Then a listing proves the key can browse it.
        await container.getProperties();
        await container.listBlobsFlat().byPage({ maxPageSize: 1 }).next();
        return {};
      }),

    list: (prefix, token) =>
      run(async () => {
        const page = (await container.listBlobsByHierarchy("/", { prefix }).byPage({ maxPageSize: 1000, continuationToken: token }).next()).value;
        const listing: Listing = { folders: [], files: [], nextToken: page?.continuationToken || undefined };
        if (!page) return listing;
        for (const folder of page.segment.blobPrefixes ?? []) listing.folders.push(folder.name);
        for (const blob of page.segment.blobItems) {
          // A zero-byte blob named like the folder is the folder's marker, not a file.
          if (blob.name === prefix || blob.name.endsWith("/")) continue;
          listing.files.push({
            key: blob.name,
            size: blob.properties.contentLength ?? 0,
            lastModified: blob.properties.lastModified?.toISOString() ?? null,
            etag: blob.properties.etag?.replaceAll('"', "") ?? null,
            storageClass: blob.properties.accessTier ?? null,
          });
        }
        return listing;
      }),

    listKeys: (prefix, max) =>
      run(async () => {
        const keys: string[] = [];
        for await (const blob of container.listBlobsFlat({ prefix })) {
          keys.push(blob.name);
          if (keys.length > max) break;
        }
        return { keys: keys.slice(0, max), truncated: keys.length > max };
      }),

    stats: (prefix, maxPages = 20) =>
      run(async () => {
        const stats: FolderStats = { objects: 0, bytes: 0, lastModified: null, truncated: false };
        let pages = 0;
        for await (const page of container.listBlobsFlat({ prefix }).byPage({ maxPageSize: 1000 })) {
          for (const blob of page.segment.blobItems) {
            if (blob.name.endsWith("/")) continue;
            stats.objects += 1;
            stats.bytes += blob.properties.contentLength ?? 0;
            const modified = blob.properties.lastModified?.toISOString() ?? null;
            if (modified && (!stats.lastModified || modified > stats.lastModified)) stats.lastModified = modified;
          }
          if (++pages >= maxPages) {
            stats.truncated = Boolean(page.continuationToken);
            break;
          }
        }
        return stats;
      }),

    inventory: (prefix, maxPages = 100) =>
      run(async () => {
        const files: Listing["files"] = [];
        let pages = 0;
        let truncated = false;
        for await (const page of container.listBlobsFlat({ prefix }).byPage({ maxPageSize: 1000 })) {
          for (const blob of page.segment.blobItems) {
            if (blob.name.endsWith("/")) continue;
            files.push({
              key: blob.name,
              size: blob.properties.contentLength ?? 0,
              lastModified: blob.properties.lastModified?.toISOString() ?? null,
              etag: blob.properties.etag?.replaceAll('"', "") ?? null,
              storageClass: blob.properties.accessTier ?? null,
            });
          }
          if (++pages >= maxPages) {
            truncated = Boolean(page.continuationToken);
            break;
          }
        }
        return { files, truncated };
      }),

    // A read-only SAS on one blob: works for anyone until it expires. Emulators
    // (Floci's included) don't all honour SAS, so those are served through the app.
    signedUrl: (key, download, expiresIn) =>
      target.endpoint
        ? Promise.resolve(null)
        : run(async () => `${container.getBlobClient(key).url}?${sas(key, expiresIn, download)}`),

    head: (key) =>
      run(async () => {
        const properties = await container.getBlobClient(key).getProperties();
        return {
          size: properties.contentLength,
          contentType: properties.contentType,
          cacheControl: properties.cacheControl ?? null,
          contentDisposition: properties.contentDisposition ?? null,
          etag: properties.etag?.replaceAll('"', "") ?? null,
          storageClass: properties.accessTier ?? null,
          lastModified: properties.lastModified?.toISOString() ?? null,
          encryption: properties.encryptionKeySha256
            ? { state: "encrypted", keys: "customer", detail: "Customer-provided key" }
            : properties.isServerEncrypted
              ? { state: "encrypted", keys: properties.encryptionScope ? "kms" : "provider", detail: properties.encryptionScope ? `Encryption scope ${properties.encryptionScope}` : "AES-256, Microsoft-managed keys" }
              : target.endpoint
                ? { state: "unknown" }
                : { state: "unencrypted" },
        };
      }),

    read: (key, range) =>
      run(async () => {
        const count = range?.end === undefined ? undefined : range.end - range.start + 1;
        let response;
        try {
          response = await container.getBlobClient(key).download(range?.start ?? 0, count);
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode === 416) throw unsatisfiable();
          throw error;
        }
        if (!response.readableStreamBody) throw new StorageUserError("That blob is empty or gone.", 404);
        const served = range ? parseContentRange(response.contentRange) : undefined;
        return {
          stream: Readable.toWeb(response.readableStreamBody as Readable) as ReadableStream<Uint8Array>,
          contentType: response.contentType,
          size: response.contentLength,
          total: served?.total ?? response.contentLength,
          range: served ? { start: served.start, end: served.end } : undefined,
        };
      }),

    write: (key, body, contentType) =>
      run(async () => {
        await container.getBlockBlobClient(key).uploadData(body, {
          blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
        });
      }),

    // Staged 8 MB blocks, four in flight: no size limit and bounded memory.
    upload: (key, body, _size, contentType) =>
      run(async () => {
        await container.getBlockBlobClient(key).uploadStream(toNode(body), 8 * 1024 * 1024, 4, {
          blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
        });
      }),

    remove: (keys) =>
      run(async () => {
        const failed: string[] = [];
        await eachLimit(keys, 8, async (key) => {
          try {
            await container.getBlobClient(key).deleteIfExists();
          } catch {
            failed.push(key);
          }
        });
        return { failed };
      }),

    // Emulators rarely implement tiers or tags; Azure itself does both.
    metadataSupport: {
      contentType: true,
      cacheControl: true,
      contentDisposition: true,
      tags: !target.endpoint,
      storageClasses: target.endpoint ? [] : ["Hot", "Cool", "Cold", "Archive"],
    },

    // Azure replaces all of a blob's HTTP headers at once: read them, change some, write all.
    setMetadata: (key, change) =>
      run(async () => {
        const blob = container.getBlobClient(key);
        if (change.contentType !== undefined || change.cacheControl !== undefined || change.contentDisposition !== undefined) {
          const properties = await blob.getProperties();
          await blob.setHTTPHeaders({
            blobContentType: change.contentType || properties.contentType,
            blobCacheControl: change.cacheControl === undefined ? properties.cacheControl : change.cacheControl || undefined,
            blobContentDisposition:
              change.contentDisposition === undefined ? properties.contentDisposition : change.contentDisposition || undefined,
            blobContentEncoding: properties.contentEncoding,
            blobContentLanguage: properties.contentLanguage,
            blobContentMD5: properties.contentMD5,
          });
        }
        if (change.storageClass) await blob.setAccessTier(change.storageClass as "Hot" | "Cool" | "Cold" | "Archive");
        if (change.tags) await blob.setTags(change.tags);
      }),

    copy: (source, destination) =>
      run(async () => {
        const from = container.getBlobClient(source);
        const to = container.getBlockBlobClient(destination);
        if (target.endpoint) {
          // Emulators may not authorise a copy-from-URL; stream it through instead.
          const response = await from.download();
          if (!response.readableStreamBody) throw new StorageUserError("That blob is empty or gone.", 404);
          await to.uploadStream(response.readableStreamBody as Readable, 8 * 1024 * 1024, 4, {
            blobHTTPHeaders: response.contentType ? { blobContentType: response.contentType } : undefined,
          });
          return;
        }
        // Server-side copy; the source is authorised with a short-lived read SAS.
        const poller = await to.beginCopyFromURL(`${from.url}?${sas(source, 600, false)}`);
        await poller.pollUntilDone();
      }),
  };
}
