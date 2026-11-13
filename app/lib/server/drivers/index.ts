import "server-only";
import { saveCredentials, type StoredConnection } from "../connections";
import { storagePublicUrl } from "./links";
import { azureDriver } from "./azure";
import { dropboxDriver } from "./dropbox";
import { gcsDriver } from "./gcs";
import { googleDriveDriver } from "./gdrive";
import { ociDriver } from "./oci";
import { oneDriveDriver } from "./onedrive";
import { cryptDriver } from "./crypt";
import { AWS_STORAGE_CLASSES, s3Driver } from "./s3";
import { isS3Compatible, S3_COMPATIBLE } from "../s3-compatible";
import { StorageUserError, type StorageDriver } from "./types";
import { atRestEncryption } from "../../connection-settings";
import { dataKeyOf } from "../crypt";
import { forbiddenHost } from "../egress";
import { macWith } from "../crypto";
import { trackWrites } from "../connection-changes";
import { timingSafeEqual } from "node:crypto";

export { StorageUserError } from "./types";
export type { FolderStats, Listing, StorageDriver } from "./types";

type DriverTarget = Pick<StoredConnection, "bucket" | "region" | "endpoint" | "credentials"> & {
  presetId?: StoredConnection["presetId"];
  /** Present once the connection is saved: lets a driver store credentials that changed in use. */
  id?: string;
  settings?: StoredConnection["settings"];
  crypt?: StoredConnection["crypt"];
};

/**
 * The one place that knows which cloud a connection talks to. An encrypted connection's
 * driver encrypts and decrypts on the way through, so callers never see ciphertext.
 */
export function driverFor(connection: DriverTarget): StorageDriver {
  // Saved before endpoints were checked this closely: refused now, rather than used.
  if (connection.endpoint && forbiddenHost(new URL(connection.endpoint).hostname)) {
    throw new StorageUserError("This connection's endpoint is a cloud metadata address, which jvinu doesn't connect to.", 400);
  }
  const driver = cloudDriver(connection);
  const scope = connection.id ?? `${connection.credentials.kind}\n${connection.bucket}\n${connection.endpoint ?? ""}`;
  return atSeam(connection.crypt ? cryptDriver(driver, dataKeyOf(connection.crypt.key)) : driver, { scope, connectionId: connection.id });
}

/**
 * What every caller's driver goes through, whatever the provider: keys without "." or ".."
 * segments, folders always named with their "/", page tokens bound to their listing, and —
 * for a saved connection — writes reported as connection changes. `scope` names the
 * connection for page tokens.
 */
export function atSeam(driver: StorageDriver, { scope, connectionId }: { scope: string; connectionId?: string }): StorageDriver {
  const bound = bindPageTokens(driver, scope);
  return guardKeys(connectionId ? trackWrites(bound, connectionId) : bound);
}

const TOKEN_PURPOSE = "page-token";
const invalidToken = () => new StorageUserError("That page of the listing is no longer valid. Refresh.", 400);

/**
 * Page tokens go to the browser and come back. Some drivers' tokens are addresses the driver
 * then follows (OneDrive's are Graph URLs): one edited by hand could list a folder outside the
 * connection's own. So each token leaves signed to its connection and prefix, and comes back
 * only to the `list` call it was made for.
 */
export function bindPageTokens(driver: StorageDriver, scope: string): StorageDriver {
  const sign = (prefix: string, token: string) => macWith(TOKEN_PURPOSE, `${scope}\n${prefix}\n${token}`).slice(0, 22);
  return new Proxy(driver, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "list" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (prefix: string, token?: string) => {
        let inner: string | undefined;
        if (token !== undefined) {
          const dot = token.indexOf(".");
          if (dot !== 22) throw invalidToken();
          inner = token.slice(dot + 1);
          const given = Buffer.from(token.slice(0, dot));
          const expected = Buffer.from(sign(prefix, inner));
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalidToken();
        }
        const page = await (value as StorageDriver["list"]).call(target, prefix, inner);
        return page.nextToken === undefined ? page : { ...page, nextToken: `${sign(prefix, page.nextToken)}.${page.nextToken}` };
      };
    },
  });
}

/**
 * A key or prefix with a "." or ".." segment ("Photos/../Private/x") is refused before any
 * provider sees it. Several APIs put keys in URL paths, where those segments are resolved:
 * on OneDrive and Dropbox they'd step out of the connection's folder, on Azure out of its
 * container, and on S3 behind a normalising proxy out of its bucket.
 */
export function hasDotSegment(key: string): boolean {
  return key.split("/").some((part) => part === "." || part === "..");
}

function checkKey(key: unknown) {
  if (typeof key === "string" && hasDotSegment(key)) {
    throw new StorageUserError("Paths can't contain “.” or “..” as a folder name.", 400);
  }
}

/** Which arguments of each method are keys or prefixes (a key list for `remove`). */
const KEY_ARGUMENTS: Partial<Record<keyof StorageDriver, number[]>> = {
  findFile: [0],
  list: [0],
  listKeys: [0],
  stats: [0],
  inventory: [0],
  signedUrl: [0],
  read: [0],
  write: [0],
  upload: [0],
  remove: [0],
  copy: [0, 1],
  head: [0],
  setMetadata: [0],
  rename: [0, 1],
};

/** Methods that take a folder: "a" means the folder "a/" (see the contract in types.ts). */
const FOLDER_ARGUMENT = new Set<keyof StorageDriver>(["list", "listKeys", "stats", "inventory"]);
const asFolder = (prefix: unknown) => (typeof prefix === "string" && prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix);

function guardKeys(driver: StorageDriver): StorageDriver {
  return new Proxy(driver, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const positions = KEY_ARGUMENTS[property as keyof StorageDriver];
      if (!positions) return value.bind(target);
      // Every guarded method returns a promise: a refusal is a rejected one, like any other
      // failure, so callers' .catch() sees it.
      return (...args: unknown[]) => {
        try {
          for (const position of positions) {
            const arg = args[position];
            if (Array.isArray(arg)) arg.forEach(checkKey);
            else checkKey(arg);
          }
        } catch (error) {
          return Promise.reject(error);
        }
        if (FOLDER_ARGUMENT.has(property as keyof StorageDriver)) args[0] = asFolder(args[0]);
        return value.apply(target, args);
      };
    },
  });
}

/** What each S3-speaking service lets jvinu change on an object besides its headers. */
function s3Metadata(presetId: StoredConnection["presetId"] | undefined, endpoint: string | undefined) {
  switch (presetId) {
    case "r2":
      return { storageClasses: ["STANDARD", "STANDARD_IA"] };
    case "wasabi":
    case "minio":
      return { tags: true };
    case "scaleway":
      return { tags: true, storageClasses: ["STANDARD", "ONEZONE_IA", "GLACIER"] };
    case "storj":
    case "b2":
    case "spaces":
    case "garage":
      return {};
    default:
      // Amazon itself; an S3 endpoint of your own (MinIO, LocalStack, Floci) takes tags too.
      return endpoint ? { tags: true } : { tags: true, storageClasses: AWS_STORAGE_CLASSES };
  }
}


/** The cloud's own driver, without jvinu encryption: what's stored, as it's stored. */
export function cloudDriver(connection: DriverTarget): StorageDriver {
  const { bucket, region, endpoint, credentials: c } = connection;
  switch (c.kind) {
    case "s3":
      return s3Driver({
        bucket,
        region,
        endpoint,
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
        service:
          connection.presetId === "garage"
            ? "My storage"
            : isS3Compatible(connection.presetId)
              ? S3_COMPATIBLE[connection.presetId].label
              : undefined,
        // Bundled storage sits on the private compose network: links only via a public URL.
        linkEndpoint: connection.presetId === "garage" ? storagePublicUrl() : undefined,
        atRest: atRestEncryption(connection.presetId ?? "s3"),
        serverSideEncryption: Boolean(connection.settings?.providerEncryption) && atRestEncryption(connection.presetId ?? "s3") === "optional",
        metadata: s3Metadata(connection.presetId, endpoint),
      });
    case "azure":
      return azureDriver({ container: bucket, accountName: c.accountName, accountKey: c.accountKey, endpoint });
    case "gcs":
      return gcsDriver({ bucket, endpoint, projectId: c.projectId, clientEmail: c.clientEmail, privateKey: c.privateKey });
    case "oci":
      return ociDriver({
        bucket,
        region,
        endpoint,
        namespace: c.namespace,
        tenancy: c.tenancy,
        user: c.user,
        fingerprint: c.fingerprint,
        privateKey: c.privateKey,
        passphrase: c.passphrase,
      });
    case "dropbox":
      return dropboxDriver({ root: bucket, appKey: c.appKey, refreshToken: c.refreshToken });
    case "gdrive":
      return googleDriveDriver({
        root: bucket,
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        refreshToken: c.refreshToken,
        readOnlyAccess: c.readOnlyAccess,
      });
    case "onedrive": {
      const id = connection.id;
      return oneDriveDriver({
        root: bucket,
        clientId: c.clientId,
        tenant: c.tenant,
        refreshToken: c.refreshToken,
        // Microsoft rotates the refresh token; keep the newest, or the connection lapses in ~90 days.
        onRotate: id ? (refreshToken) => saveCredentials(id, { ...c, refreshToken }) : undefined,
      });
    }
  }
}
