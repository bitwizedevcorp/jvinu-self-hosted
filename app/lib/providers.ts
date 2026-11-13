/**
 * Every provider jvinu connects to, and the facts about each that the app and the server
 * both use — in one place, so a new provider is one entry here (plus its driver and its
 * form), not a hunt for every `presetId === …` check.
 *
 * Client-safe: nothing secret, nothing server-only. The server's half (checking credentials,
 * signing in) is app/lib/server/provider-connect.ts; building a driver is drivers/index.ts.
 */

/** The kinds of driver: what a connection's credentials are for. */
export const PROVIDER_KINDS = ["s3", "azure", "gcs", "oci", "dropbox", "onedrive", "gdrive"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Clouds that speak S3 with an endpoint of their own; their specs are in server/s3-compatible.ts. */
export const S3_COMPATIBLE_IDS = ["r2", "wasabi", "b2", "spaces", "scaleway", "storj", "minio"] as const;
export type S3CompatibleId = (typeof S3_COMPATIBLE_IDS)[number];

/** What a connection was made from: a kind, an S3-compatible cloud, or the server's own storage. */
export type PresetId = ProviderKind | S3CompatibleId | "garage";

/**
 * Encryption at rest: "optional" where the API lets a client ask for it per file (SSE-S3 on
 * S3, SSE-B2 on Backblaze); "always" where the provider encrypts everything anyway; "none"
 * where the API neither offers nor reports it.
 */
export type AtRest = "optional" | "always" | "none";

export type ProviderProfile = {
  /** The service, by name: "Google Drive". Also what a whole-account connection is called. */
  service: string;
  /**
   * What a connection opens: a bucket; an Azure container; or a folder of an account
   * (Dropbox, OneDrive, Google Drive), where the "bucket" is a path such as "/" or "/Photos".
   */
  place: "bucket" | "container" | "folder";
  /** Where the place is, for sentences such as "Photos connected — /Photos on Dropbox". Empty for S3-style buckets. */
  where: string;
  /** What a file's full location is called when it's copied. */
  pathLabel: string;
  atRest: AtRest;
};

const bucket = (service: string, atRest: AtRest, where = ""): ProviderProfile => ({ service, place: "bucket", where, pathLabel: "S3 URI", atRest });
const folder = (service: string): ProviderProfile => ({ service, place: "folder", where: `on ${service}`, pathLabel: `${service} path`, atRest: "none" });

export const PROVIDERS: Record<PresetId, ProviderProfile> = {
  s3: bucket("Amazon S3", "optional"),
  azure: { service: "Azure", place: "container", where: "on Azure", pathLabel: "S3 URI", atRest: "always" },
  gcs: bucket("Google Cloud", "always", "on Google Cloud"),
  oci: bucket("Oracle Cloud", "always"),
  r2: bucket("Cloudflare R2", "always"),
  wasabi: bucket("Wasabi", "always"),
  b2: bucket("Backblaze B2", "optional"),
  spaces: bucket("DigitalOcean Spaces", "none"),
  scaleway: bucket("Scaleway", "none"),
  storj: bucket("Storj", "always"), // end-to-end encrypted by the network
  minio: bucket("MinIO", "none"),
  garage: bucket("My storage", "none"),
  dropbox: folder("Dropbox"),
  onedrive: folder("OneDrive"),
  gdrive: folder("Google Drive"),
};

/** The profile for a preset id; undefined for an id this version doesn't know. */
export const profileOf = (presetId: string): ProviderProfile | undefined =>
  Object.hasOwn(PROVIDERS, presetId) ? PROVIDERS[presetId as PresetId] : undefined;

/** True for providers whose connections open a folder path of an account rather than a bucket. */
export const isFolderRoot = (presetId: string) => profileOf(presetId)?.place === "folder";

/** The place's name, capitalised for a label: "Bucket", "Container", "Folder". */
export const placeLabel = (presetId: string) => {
  const place = profileOf(presetId)?.place ?? "bucket";
  return place[0].toUpperCase() + place.slice(1);
};

/** Providers with a working connector, in the order the connect dialog offers them; the server's own storage isn't one. */
export const CONNECTABLE = ["s3", "azure", "gcs", "oci", "r2", "wasabi", "b2", "spaces", "scaleway", "storj", "minio", "dropbox", "onedrive", "gdrive"] as const satisfies readonly PresetId[];
export type ConnectableKind = (typeof CONNECTABLE)[number];
export const isConnectable = (id: string): id is ConnectableKind => (CONNECTABLE as readonly string[]).includes(id);
