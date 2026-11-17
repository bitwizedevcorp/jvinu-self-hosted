import "server-only";
import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetBucketAclCommand,
  GetBucketPolicyStatusCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  ListPartsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  UploadPartCopyCommand,
  type StorageClass,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  eachLimit,
  egressRefused, networkCode,
  parseContentRange,
  rangeHeader,
  StorageUserError,
  unreachable,
  unsatisfiable,
  type FolderStats,
  type IncompleteUpload,
  type VersionEntry,
  type Listing,
  type MetadataSupport,
  type ObjectHead,
  type StorageDriver,
  fileFromHead,
} from "./types";
import { forbiddenHost } from "../egress";

type Target = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Who to name in messages: "AWS", "Wasabi", "Cloudflare R2"… */
  service?: string;
  /**
   * Where share links should point. Absent: the endpoint itself. A URL: sign against that
   * instead (bundled storage behind a tunnel). null: no links — the endpoint is private.
   */
  linkEndpoint?: string | null;
  /** Ask the service to encrypt everything written (SSE-S3: AES256). */
  serverSideEncryption?: boolean;
  /** Whether the service encrypts at rest anyway ("always"), on request, or not at all. */
  atRest?: "optional" | "always" | "none";
  /** Copies above this size go part by part (S3's CopyObject stops at 5 GB). Tests lower it. */
  multipartCopyAbove?: number;
  /** Smallest part for a multipart copy; grows so no copy needs more than 10,000 parts. */
  copyPartSize?: number;
  /** What this service lets jvinu change on an object; absent: headers only. */
  metadata?: Partial<MetadataSupport>;
};

/** Amazon S3's own storage classes, cheapest-to-read first. */
export const AWS_STORAGE_CLASSES = ["STANDARD", "INTELLIGENT_TIERING", "STANDARD_IA", "ONEZONE_IA", "GLACIER_IR", "GLACIER", "DEEP_ARCHIVE"];

const GB = 1024 ** 3;

function client(target: Target) {
  const credentials = { accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey };
  if (target.endpoint) {
    // Emulators and S3-compatible stores serve buckets as paths, not subdomains.
    // Checksums only where an operation needs one. S3-compatible services don't all follow
    // AWS's newer checksum rules: Garage reports a multipart object's composite CRC32 as if it
    // covered the whole object, so the SDK's default check fails every full read of a large
    // file uploaded in parts. (Cloudflare recommends the same settings for R2.)
    return new S3Client({
      region: target.region,
      credentials,
      endpoint: target.endpoint,
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  // followRegionRedirects: a bucket in another region answers 301; the SDK retries there.
  return new S3Client({ region: target.region, credentials, followRegionRedirects: true });
}

/** Turn AWS's error zoo into something a person can act on. */
function explain(error: unknown, target: Target): StorageUserError {
  if (error instanceof StorageUserError) return error;
  const refused = egressRefused(error);
  if (refused) return refused;
  if (networkCode(error)) return unreachable(target.service ? undefined : target.endpoint, target.service ?? "AWS");
  // TLS refused outright: on R2 that's what an unknown account ID looks like.
  const raw = error as { code?: string; cause?: { code?: string }; message?: string };
  if (raw?.code === "EPROTO" || raw?.cause?.code === "EPROTO" || /handshake failure|certificate/i.test(raw?.message ?? "")) {
    return new StorageUserError(
      target.service === "Cloudflare R2"
        ? "Cloudflare refused the connection — check the account ID (and jurisdiction)."
        : `Couldn't open a secure connection to ${target.service ?? target.endpoint ?? "the service"}.`,
      502,
    );
  }
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const code = e?.Code ?? e?.name ?? "";
  const bucket = target.bucket;
  switch (code) {
    case "InvalidAccessKeyId":
      return new StorageUserError("The service doesn't recognise this access key.", 400);
    case "SignatureDoesNotMatch":
      return new StorageUserError("The secret key doesn't match this access key.", 400);
    case "NoSuchBucket":
      return new StorageUserError(`No bucket named “${bucket}” exists.`, 404);
    case "NoSuchKey":
    case "NotFound":
      return new StorageUserError("That object no longer exists.", 404);
    case "AccessDenied":
    case "Forbidden":
    case "AllAccessDisabled":
      return new StorageUserError(
        target.service
          ? `These keys aren't allowed to do that on “${bucket}”.`
          : `These credentials aren't allowed to do that on “${bucket}” — check the IAM policy.`,
        403,
      );
    case "PermanentRedirect":
    case "AuthorizationHeaderMalformed":
    case "IncorrectEndpoint":
    case "IllegalLocationConstraintException":
      return new StorageUserError(`“${bucket}” is in a different region — pick the region it was created in.`, 400);
    case "EntityTooLarge":
      return new StorageUserError("That object is larger than this service allows.", 400);
    case "ExpiredToken":
    case "TokenRefreshRequired":
      return new StorageUserError("These credentials have expired.", 400);
    case "InvalidRange":
      return unsatisfiable();
    case "InvalidObjectState":
      return new StorageUserError("This file is archived (Glacier): restore it in the AWS console before downloading it.", 409);
    case "InvalidBucketName":
      return new StorageUserError(`“${bucket}” isn't a valid bucket name.`, 400);
  }
  if (e?.$metadata?.httpStatusCode === 403) return new StorageUserError(`Access to “${bucket}” was denied.`, 403);
  console.error("[s3] unexpected error", code, e?.$metadata?.httpStatusCode);
  return new StorageUserError("The storage service returned an unexpected error. Try again.", 502);
}

/**
 * The same request with no credentials at all, as a stranger would send it: true when it's
 * answered, false when it's refused, null when that couldn't be told.
 */
async function anonymous(target: Target, pathAndQuery: string, method: "GET" | "HEAD"): Promise<boolean | null> {
  const base = target.endpoint
    ? `${target.endpoint.replace(/\/+$/, "")}/${target.bucket}`
    : `https://${target.bucket}.s3.${target.region}.amazonaws.com`;
  try {
    const url = new URL(`${base}/${pathAndQuery}`);
    if (forbiddenHost(url.hostname)) return null;
    const response = await fetch(url, { method, redirect: "manual", signal: AbortSignal.timeout(5000), cache: "no-store" });
    await response.body?.cancel().catch(() => {});
    if (response.status === 200) return true;
    if (response.status === 401 || response.status === 403) return false;
    return null;
  } catch {
    return null;
  }
}

/** CopySource is "bucket/key" with each key segment URL-encoded. */
const copySource = (bucket: string, key: string) => `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

export function s3Driver(target: Target): StorageDriver {
  // Sent on every write when the connection asks for encryption at rest.
  const sse = target.serverSideEncryption ? { ServerSideEncryption: "AES256" as const } : {};

  async function run<T>(work: (s3: S3Client) => Promise<T>): Promise<T> {
    const s3 = client(target);
    try {
      return await work(s3);
    } catch (error) {
      throw explain(error, target);
    } finally {
      s3.destroy();
    }
  }

  return {
    verify: () =>
      run(async (s3) => {
        await s3.send(new ListObjectsV2Command({ Bucket: target.bucket, MaxKeys: 1 }));
        const head = await s3.send(new HeadBucketCommand({ Bucket: target.bucket }));
        return { region: head.BucketRegion };
      }),

    list: (prefix, token) =>
      run(async (s3) => {
        const out = await s3.send(
          new ListObjectsV2Command({ Bucket: target.bucket, Prefix: prefix, Delimiter: "/", MaxKeys: 1000, ContinuationToken: token }),
        );
        const listing: Listing = {
          folders: (out.CommonPrefixes ?? []).map((common) => common.Prefix).filter((value): value is string => Boolean(value)),
          files: [],
          nextToken: out.IsTruncated ? out.NextContinuationToken : undefined,
        };
        for (const item of out.Contents ?? []) {
          // The zero-byte "folder marker" for the prefix itself is not a file.
          if (!item.Key || item.Key === prefix || item.Key.endsWith("/")) continue;
          listing.files.push({
            key: item.Key,
            size: item.Size ?? 0,
            lastModified: item.LastModified ? item.LastModified.toISOString() : null,
            etag: item.ETag ? item.ETag.replaceAll('"', "") : null,
            storageClass: item.StorageClass ?? null,
          });
        }
        return listing;
      }),

    listKeys: (prefix, max) =>
      run(async (s3) => {
        const keys: string[] = [];
        let token: string | undefined;
        do {
          const out = await s3.send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: prefix, ContinuationToken: token }));
          for (const item of out.Contents ?? []) if (item.Key) keys.push(item.Key);
          token = out.IsTruncated ? out.NextContinuationToken : undefined;
        } while (token && keys.length <= max);
        return { keys: keys.slice(0, max), truncated: keys.length > max || Boolean(token) };
      }),

    stats: (prefix, maxPages = 20) =>
      run(async (s3) => {
        const stats: FolderStats = { objects: 0, bytes: 0, lastModified: null, truncated: false };
        let token: string | undefined;
        for (let page = 0; page < maxPages; page++) {
          const out = await s3.send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: prefix, ContinuationToken: token }));
          for (const item of out.Contents ?? []) {
            if (!item.Key || item.Key.endsWith("/")) continue; // folder markers aren't objects
            stats.objects += 1;
            stats.bytes += item.Size ?? 0;
            const modified = item.LastModified?.toISOString() ?? null;
            if (modified && (!stats.lastModified || modified > stats.lastModified)) stats.lastModified = modified;
          }
          token = out.IsTruncated ? out.NextContinuationToken : undefined;
          if (!token) break;
        }
        stats.truncated = Boolean(token);
        return stats;
      }),

    inventory: (prefix, maxPages = 100) =>
      run(async (s3) => {
        const files: Listing["files"] = [];
        let token: string | undefined;
        let page = 0;
        do {
          const out = await s3.send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: prefix, ContinuationToken: token }));
          for (const item of out.Contents ?? []) {
            if (!item.Key || item.Key.endsWith("/")) continue;
            files.push({
              key: item.Key,
              size: item.Size ?? 0,
              lastModified: item.LastModified ? item.LastModified.toISOString() : null,
              etag: item.ETag ? item.ETag.replaceAll('"', "") : null,
              storageClass: item.StorageClass ?? null,
            });
          }
          token = out.IsTruncated ? out.NextContinuationToken : undefined;
        } while (token && ++page < maxPages);
        return { files, truncated: Boolean(token) };
      }),

    signedUrl: (key, download, expiresIn) => {
      if (target.linkEndpoint === null) return Promise.resolve(null);
      // Signing is local; the client only needs to know the host the link will name.
      const signer = target.linkEndpoint ? s3Driver({ ...target, endpoint: target.linkEndpoint, linkEndpoint: undefined }) : null;
      if (signer) return signer.signedUrl(key, download, expiresIn);
      return run((s3) => {
        const filename = key.split("/").pop() ?? "download";
        return getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: target.bucket,
            Key: key,
            ResponseContentDisposition: download ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` : undefined,
          }),
          { expiresIn },
        );
      });
    },

    // Not via run(): the client must outlive this call, until the body has been read —
    // destroying it earlier cuts the socket mid-stream.
    read: async (key, range) => {
      const s3 = client(target);
      try {
        const out = await s3.send(
          new GetObjectCommand({ Bucket: target.bucket, Key: key, Range: range ? rangeHeader(range) : undefined }),
        );
        if (!out.Body) throw new StorageUserError("That object is empty or gone.", 404);
        const reader = out.Body.transformToWebStream().getReader();
        const done = () => s3.destroy();
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { value, done: finished } = await reader.read();
              if (finished) {
                controller.close();
                done();
              } else controller.enqueue(value);
            } catch (error) {
              controller.error(error);
              done();
            }
          },
          async cancel(reason) {
            await reader.cancel(reason).catch(() => {});
            done();
          },
        });
        const served = parseContentRange(out.ContentRange);
        return {
          stream,
          contentType: out.ContentType,
          size: out.ContentLength,
          total: served?.total ?? out.ContentLength,
          range: served ? { start: served.start, end: served.end } : undefined,
        };
      } catch (error) {
        s3.destroy();
        throw explain(error, target);
      }
    },

    write: (key, body, contentType) =>
      run(async (s3) => {
        await s3.send(new PutObjectCommand({ Bucket: target.bucket, Key: key, Body: body, ContentType: contentType || undefined, ...sse }));
      }),

    // Multipart above 16 MB, a single PUT below — lib-storage decides per stream.
    upload: (key, body, size, contentType) =>
      run(async (s3) => {
        await new Upload({
          client: s3,
          params: {
            Bucket: target.bucket,
            Key: key,
            Body: Readable.fromWeb(body as import("node:stream/web").ReadableStream),
            ContentType: contentType || undefined,
            ContentLength: size,
            ...sse,
          },
          partSize: 16 * 1024 * 1024,
          queueSize: 4,
          leavePartsOnError: false,
        }).done();
      }),

    remove: (keys) =>
      run(async (s3) => {
        const failed: string[] = [];
        for (let i = 0; i < keys.length; i += 1000) {
          const batch = keys.slice(i, i + 1000);
          const out = await s3.send(
            new DeleteObjectsCommand({ Bucket: target.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }),
          );
          for (const error of out.Errors ?? []) if (error.Key) failed.push(error.Key);
        }
        return { failed };
      }),

    // The file at exactly this key: what its head says, or nothing on a 404.
    findFile(key) {
      return fileFromHead(key, () => this.head!(key));
    },

    head: (key) =>
      run(async (s3) => {
        const out = await s3.send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
        const algorithm = out.ServerSideEncryption;
        const encryption: ObjectHead["encryption"] = out.SSECustomerAlgorithm
          ? { state: "encrypted", keys: "customer", detail: `${out.SSECustomerAlgorithm} (customer-provided key)` }
          : algorithm === "AES256"
            ? { state: "encrypted", keys: "provider", detail: "AES-256 (SSE-S3)" }
            : algorithm
              ? { state: "encrypted", keys: "kms", detail: `${algorithm.toUpperCase()}${out.SSEKMSKeyId ? ` · ${out.SSEKMSKeyId.split("/").pop()}` : ""}` }
              : target.atRest === "always"
                ? { state: "encrypted", keys: "provider", detail: `Always on at ${target.service ?? "the provider"}` }
                : target.atRest === "optional"
                  ? { state: "unencrypted" }
                  : { state: "unknown" };
        return {
          size: out.ContentLength,
          contentType: out.ContentType,
          cacheControl: out.CacheControl ?? null,
          contentDisposition: out.ContentDisposition ?? null,
          etag: out.ETag ? out.ETag.replaceAll('"', "") : null,
          storageClass: out.StorageClass ?? null,
          lastModified: out.LastModified ? out.LastModified.toISOString() : null,
          encryption,
        };
      }),

    metadataSupport: {
      contentType: true,
      cacheControl: true,
      contentDisposition: true,
      tags: false,
      storageClasses: [],
      ...target.metadata,
    },

    // S3 objects are immutable: headers and class change by copying the object onto itself
    // with REPLACE, carrying across everything not being changed. Tags have their own call.
    setMetadata: (key, change) =>
      run(async (s3) => {
        const headersChange =
          change.contentType !== undefined ||
          change.cacheControl !== undefined ||
          change.contentDisposition !== undefined ||
          change.storageClass !== undefined;
        if (headersChange) {
          const head = await s3.send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
          if ((head.ContentLength ?? 0) > 5 * GB) {
            throw new StorageUserError(`“${key.split("/").pop()}” is over 5 GB: S3 can't change its metadata in place.`, 400);
          }
          const pick = (next: string | undefined, current: string | undefined) => (next === undefined ? current : next || undefined);
          // Keep the object's own encryption: an in-place copy would otherwise drop a KMS key.
          const encryption =
            head.ServerSideEncryption === "aws:kms" || head.ServerSideEncryption === "aws:kms:dsse"
              ? { ServerSideEncryption: head.ServerSideEncryption, SSEKMSKeyId: head.SSEKMSKeyId }
              : head.ServerSideEncryption === "AES256"
                ? { ServerSideEncryption: "AES256" as const }
                : sse;
          await s3.send(
            new CopyObjectCommand({
              Bucket: target.bucket,
              Key: key,
              CopySource: copySource(target.bucket, key),
              MetadataDirective: "REPLACE",
              TaggingDirective: "COPY",
              ContentType: change.contentType || head.ContentType,
              CacheControl: pick(change.cacheControl, head.CacheControl),
              ContentDisposition: pick(change.contentDisposition, head.ContentDisposition),
              ContentEncoding: head.ContentEncoding,
              ContentLanguage: head.ContentLanguage,
              Expires: head.Expires,
              Metadata: head.Metadata,
              StorageClass: (change.storageClass || head.StorageClass) as StorageClass | undefined,
              ...encryption,
            }),
          );
        }
        if (change.tags) {
          await s3.send(
            new PutObjectTaggingCommand({
              Bucket: target.bucket,
              Key: key,
              Tagging: { TagSet: Object.entries(change.tags).map(([Key, Value]) => ({ Key, Value })) },
            }),
          );
        }
      }),

    // Server-side either way: one CopyObject up to 5 GB, part-by-part copies above it.
    copy: (source, destination) =>
      run(async (s3) => {
        const threshold = target.multipartCopyAbove ?? 5 * GB;
        const head = await s3.send(new HeadObjectCommand({ Bucket: target.bucket, Key: source }));
        const size = head.ContentLength ?? 0;
        if (size <= threshold) {
          await s3.send(
            new CopyObjectCommand({ Bucket: target.bucket, Key: destination, CopySource: copySource(target.bucket, source), ...sse }),
          );
          return;
        }

        const partSize = Math.max(target.copyPartSize ?? 512 * 1024 * 1024, Math.ceil(size / 10_000));
        const { UploadId } = await s3.send(
          new CreateMultipartUploadCommand({
            Bucket: target.bucket,
            Key: destination,
            // A part copy carries no headers of its own: bring them across here.
            ContentType: head.ContentType,
            ContentEncoding: head.ContentEncoding,
            ContentDisposition: head.ContentDisposition,
            ContentLanguage: head.ContentLanguage,
            CacheControl: head.CacheControl,
            Metadata: head.Metadata,
            StorageClass: head.StorageClass as StorageClass | undefined,
            ...sse,
          }),
        );
        try {
          const count = Math.ceil(size / partSize);
          const parts: { ETag?: string; PartNumber: number }[] = new Array(count);
          await eachLimit(
            Array.from({ length: count }, (_, index) => index),
            4,
            async (index) => {
              const start = index * partSize;
              const end = Math.min(size, start + partSize) - 1;
              const out = await s3.send(
                new UploadPartCopyCommand({
                  Bucket: target.bucket,
                  Key: destination,
                  UploadId,
                  PartNumber: index + 1,
                  CopySource: copySource(target.bucket, source),
                  CopySourceRange: `bytes=${start}-${end}`,
                }),
              );
              parts[index] = { ETag: out.CopyPartResult?.ETag, PartNumber: index + 1 };
            },
          );
          await s3.send(
            new CompleteMultipartUploadCommand({ Bucket: target.bucket, Key: destination, UploadId, MultipartUpload: { Parts: parts } }),
          );
        } catch (error) {
          // Don't leave paid-for parts behind.
          await s3.send(new AbortMultipartUploadCommand({ Bucket: target.bucket, Key: destination, UploadId })).catch(() => {});
          throw error;
        }
      }),

    // What no file listing shows: abandoned upload parts, old versions, who can read the bucket.
    audit: {
      incompleteUploads: (maxPages = 10) =>
        run(async (s3) => {
          const uploads: IncompleteUpload[] = [];
          let keyMarker: string | undefined;
          let idMarker: string | undefined;
          let page = 0;
          let more = false;
          do {
            const out = await s3.send(
              new ListMultipartUploadsCommand({ Bucket: target.bucket, KeyMarker: keyMarker, UploadIdMarker: idMarker }),
            );
            for (const upload of out.Uploads ?? []) {
              if (!upload.Key || !upload.UploadId) continue;
              uploads.push({ key: upload.Key, uploadId: upload.UploadId, initiated: upload.Initiated?.toISOString() ?? null, bytes: null });
            }
            more = Boolean(out.IsTruncated);
            keyMarker = out.NextKeyMarker;
            idMarker = out.NextUploadIdMarker;
          } while (more && ++page < maxPages);
          // Parts are what's billed; sizing every upload would be a request each, so the first 200.
          await eachLimit(uploads.slice(0, 200), 8, async (upload) => {
            try {
              let bytes = 0;
              let marker: string | undefined;
              for (let i = 0; i < 10; i++) {
                const parts = await s3.send(
                  new ListPartsCommand({ Bucket: target.bucket, Key: upload.key, UploadId: upload.uploadId, PartNumberMarker: marker }),
                );
                for (const part of parts.Parts ?? []) bytes += part.Size ?? 0;
                if (!parts.IsTruncated) break;
                marker = parts.NextPartNumberMarker;
              }
              upload.bytes = bytes;
            } catch {
              // Gone meanwhile, or the service doesn't list parts: size unknown.
            }
          });
          return { uploads, truncated: more };
        }),

      versioning: async () => {
        const s3 = client(target);
        try {
          const out = await s3.send(new GetBucketVersioningCommand({ Bucket: target.bucket }));
          return out.Status === "Enabled" ? "enabled" : out.Status === "Suspended" ? "suspended" : "off";
        } catch {
          return "unknown";
        } finally {
          s3.destroy();
        }
      },

      versions: (prefix, maxPages = 50) =>
        run(async (s3) => {
          const versions: VersionEntry[] = [];
          let keyMarker: string | undefined;
          let versionMarker: string | undefined;
          let page = 0;
          let more = false;
          do {
            const out = await s3.send(
              new ListObjectVersionsCommand({ Bucket: target.bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionMarker }),
            );
            for (const item of out.Versions ?? []) {
              if (!item.Key || item.Key.endsWith("/")) continue;
              versions.push({
                key: item.Key,
                versionId: item.VersionId ?? "null",
                size: item.Size ?? 0,
                lastModified: item.LastModified?.toISOString() ?? null,
                latest: Boolean(item.IsLatest),
                deleteMarker: false,
                storageClass: item.StorageClass ?? null,
              });
            }
            for (const item of out.DeleteMarkers ?? []) {
              if (!item.Key || item.Key.endsWith("/")) continue;
              versions.push({
                key: item.Key,
                versionId: item.VersionId ?? "null",
                size: 0,
                lastModified: item.LastModified?.toISOString() ?? null,
                latest: Boolean(item.IsLatest),
                deleteMarker: true,
                storageClass: null,
              });
            }
            more = Boolean(out.IsTruncated);
            keyMarker = out.NextKeyMarker;
            versionMarker = out.NextVersionIdMarker;
          } while (more && ++page < maxPages);
          return { versions, truncated: more };
        }),

      // Each check stands alone: S3-compatible services implement some and refuse others.
      exposure: async () => {
        const s3 = client(target);
        const attempt = async <T,>(work: () => Promise<T>): Promise<T | null> => {
          try {
            return await work();
          } catch (error) {
            // No block configured at all reads as "not blocked", not as "unknown".
            if ((error as { name?: string })?.name === "NoSuchPublicAccessBlockConfiguration") return false as T;
            if ((error as { name?: string })?.name === "NoSuchBucketPolicy") return false as T;
            return null;
          }
        };
        try {
          const [blocked, policyPublic, aclPublic, anonymousListing] = await Promise.all([
            attempt(async () => {
              const c = (await s3.send(new GetPublicAccessBlockCommand({ Bucket: target.bucket }))).PublicAccessBlockConfiguration;
              return Boolean(c?.BlockPublicAcls && c.IgnorePublicAcls && c.BlockPublicPolicy && c.RestrictPublicBuckets);
            }),
            attempt(async () => Boolean((await s3.send(new GetBucketPolicyStatusCommand({ Bucket: target.bucket }))).PolicyStatus?.IsPublic)),
            attempt(async () =>
              ((await s3.send(new GetBucketAclCommand({ Bucket: target.bucket }))).Grants ?? []).some((grant) =>
                /\/global\/(AllUsers|AuthenticatedUsers)$/.test(grant.Grantee?.URI ?? ""),
              ),
            ),
            anonymous(target, "?list-type=2&max-keys=1", "GET"),
          ]);
          return { blocked, policyPublic, aclPublic, anonymousListing };
        } finally {
          s3.destroy();
        }
      },

      publicObject: (key) => anonymous(target, key.split("/").map(encodeURIComponent).join("/"), "HEAD"),
    },
  };
}
