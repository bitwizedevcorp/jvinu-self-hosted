export type NodeKind = "folder" | "file";

export type PreviewKind =
  | "folder"
  | "image"
  | "vector"
  | "video"
  | "audio"
  | "document"
  | "archive"
  | "code"
  | "data";

export type StorageNode = {
  id: string;
  name: string;
  kind: NodeKind;
  /** Human label shown in the Type column, e.g. "MP4 Video" */
  type: string;
  /** Bytes. `null` for folders. */
  size: number | null;
  /** ISO day, or "" when S3 has none (prefixes have no timestamp). */
  modified: string;
  /** Parent segments, root is `[]`. */
  path: string[];
  preview: PreviewKind;
  storageClass?: string;
  /** The provider's own class id ("DEEP_ARCHIVE", "Cool"), for pricing; storageClass is its label. */
  storageClassId?: string;
  /** S3's entity tag. */
  etag?: string;
};

export type Bucket = {
  id: string;
  /** Bucket id as the provider knows it. */
  name: string;
  /** Display name in the header. */
  title: string;
  region: string;
  /** Objects fetched so far — S3 is listed one folder at a time. */
  nodes: StorageNode[];
  /** The saved connection whose credentials reach this bucket. */
  remote: { connectionId: string };
};

/** A saved connection id. */
export type ProviderId = string;

export type Provider = {
  id: ProviderId;
  name: string;
  locked: boolean;
  buckets: Bucket[];
  /** Which preset this connection was made from. */
  presetId?: string;
  /** Masked access key, for recognising the connection — never the key itself. */
  accessKeyHint?: string;
  /** Present for S3-compatible services; absent means AWS. */
  endpoint?: string;
  /** Writes are refused on the server. */
  readOnly?: boolean;
  /** Created and owned by the server (bundled storage): can't be disconnected. */
  managed?: boolean;
  /** jvinu encryption: files are encrypted with a passphrase before they're stored. */
  encrypted?: boolean;
};

const MB = 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Listing, search and formatting                                      */
/* ------------------------------------------------------------------ */

export function nodesAt(bucket: Bucket, path: string[]): StorageNode[] {
  return bucket.nodes.filter(
    (item) => item.path.length === path.length && item.path.every((seg, i) => seg === path[i]),
  );
}

export function searchBucket(bucket: Bucket, query: string): StorageNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return bucket.nodes.filter(
    (item) =>
      item.name.toLowerCase().includes(needle) ||
      item.path.join("/").toLowerCase().includes(needle) ||
      item.type.toLowerCase().includes(needle),
  );
}

export function isUnder(item: StorageNode, prefix: string[]): boolean {
  return item.path.length >= prefix.length && prefix.every((seg, i) => item.path[i] === seg);
}

/**
 * What a listing actually holds: its file rows, and the files under its folder
 * rows, each counted once — a search can return a folder and its own contents.
 */
export function summarize(nodes: StorageNode[], universe: Iterable<StorageNode>) {
  const seen = new Set<string>();
  let bytes = 0;
  const add = (item: StorageNode) => {
    if (item.kind !== "file" || seen.has(item.id)) return;
    seen.add(item.id);
    bytes += item.size ?? 0;
  };
  nodes.forEach(add);

  const folders = nodes.filter((item) => item.kind === "folder");
  if (folders.length) {
    for (const item of universe) {
      for (const folder of folders) {
        if (
          bucketIdOf(item.id) === bucketIdOf(folder.id) &&
          isUnder(item, [...folder.path, folder.name])
        ) {
          add(item);
        }
      }
    }
  }
  return { files: nodes.length - folders.length, folders: folders.length, bytes };
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes === 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const decimals = exponent === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${UNITS[exponent]}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDate(iso: string): string {
  if (!iso) return "—";
  return DATE_FORMAT.format(new Date(`${iso}T00:00:00Z`));
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/* ------------------------------------------------------------------ */
/* View model                                                          */
/* ------------------------------------------------------------------ */

export type ViewMode = "list" | "grid";
export type SortKey = "name" | "type" | "size" | "modified";
export type SortDir = "asc" | "desc";
export type SortState = { key: SortKey; dir: SortDir };
export type Scope = "bucket" | "starred" | "team" | "recent" | "shared";

export function bucketIdOf(nodeId: string): string {
  return nodeId.slice(0, nodeId.indexOf(":"));
}

export function sortNodes(nodes: StorageNode[], sort: SortState): StorageNode[] {
  const direction = sort.dir === "asc" ? 1 : -1;
  return [...nodes].sort((a, b) => {
    // Folders always lead, whichever column is active.
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    switch (sort.key) {
      case "size":
        return ((a.size ?? -1) - (b.size ?? -1)) * direction;
      case "modified":
        return a.modified.localeCompare(b.modified) * direction;
      case "type":
        return (a.type.localeCompare(b.type) || a.name.localeCompare(b.name)) * direction;
      default:
        return a.name.localeCompare(b.name, undefined, { numeric: true }) * direction;
    }
  });
}

export const SCOPE_LABELS: Record<Exclude<Scope, "bucket">, string> = {
  starred: "Starred",
  team: "Team pins",
  recent: "Recent",
  shared: "Shared links",
};

/* ------------------------------------------------------------------ */
/* File types                                                          */
/* ------------------------------------------------------------------ */

const EXTENSION_MAP: Record<string, { type: string; preview: PreviewKind }> = {
  png: { type: "PNG Image", preview: "image" },
  jpg: { type: "JPEG Image", preview: "image" },
  jpeg: { type: "JPEG Image", preview: "image" },
  gif: { type: "GIF Image", preview: "image" },
  webp: { type: "WebP Image", preview: "image" },
  tiff: { type: "TIFF Image", preview: "image" },
  heic: { type: "HEIC Image", preview: "image" },
  svg: { type: "SVG Image", preview: "vector" },
  ai: { type: "Illustrator", preview: "vector" },
  mp4: { type: "MP4 Video", preview: "video" },
  mov: { type: "QuickTime Video", preview: "video" },
  webm: { type: "WebM Video", preview: "video" },
  mkv: { type: "Matroska Video", preview: "video" },
  wav: { type: "WAV Audio", preview: "audio" },
  mp3: { type: "MP3 Audio", preview: "audio" },
  flac: { type: "FLAC Audio", preview: "audio" },
  pdf: { type: "PDF Document", preview: "document" },
  md: { type: "Markdown", preview: "document" },
  txt: { type: "Plain Text", preview: "document" },
  docx: { type: "Word Document", preview: "document" },
  key: { type: "Keynote", preview: "document" },
  zip: { type: "Archive", preview: "archive" },
  gz: { type: "Archive", preview: "archive" },
  tar: { type: "Archive", preview: "archive" },
  rar: { type: "Archive", preview: "archive" },
  json: { type: "JSON Data", preview: "data" },
  csv: { type: "CSV Data", preview: "data" },
  sql: { type: "SQL Data", preview: "data" },
  bin: { type: "Binary", preview: "data" },
  ts: { type: "TypeScript", preview: "code" },
  tsx: { type: "TypeScript", preview: "code" },
  js: { type: "JavaScript", preview: "code" },
  css: { type: "Stylesheet", preview: "code" },
  html: { type: "HTML", preview: "code" },
  yaml: { type: "YAML", preview: "code" },
  yml: { type: "YAML", preview: "code" },
};

export function describeFile(name: string): { type: string; preview: PreviewKind } {
  return EXTENSION_MAP[fileExtension(name)] ?? { type: "File", preview: "data" };
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

export type ProviderPreset = {
  id: string;
  name: string;
  /** Region pre-filled on buckets created under this provider. */
  region: string;
  accessKeyPlaceholder: string;
  mark: { label: string; from: string; to: string };
  /** Created by the server, never picked in Connect Provider (bundled storage). */
  system?: boolean;
};

/** The providers people actually reach for. Any other S3 service connects as Amazon S3 with its own endpoint. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "s3",
    name: "Amazon S3",
    region: "us-east-1",
    accessKeyPlaceholder: "AKIAIOSFODNN7EXAMPLE",
    mark: { label: "S3", from: "#e07d2a", to: "#b03f12" },
  },
  {
    id: "r2",
    name: "Cloudflare R2",
    region: "auto",
    accessKeyPlaceholder: "a1b2c3d4e5f6a7b8c9d0e1f2",
    mark: { label: "R2", from: "#e89325", to: "#c85608" },
  },
  {
    id: "gcs",
    name: "Google Cloud Storage",
    region: "us-central1",
    accessKeyPlaceholder: "GOOG1EXAMPLEACCESSKEY",
    mark: { label: "GC", from: "#5a93e4", to: "#2a68cc" },
  },
  {
    id: "azure",
    name: "Azure Blob Storage",
    region: "eastus",
    accessKeyPlaceholder: "storageaccountname",
    mark: { label: "AZ", from: "#4aa3e8", to: "#1f6fc4" },
  },
  {
    id: "oci",
    name: "Oracle Cloud Object Storage",
    region: "us-ashburn-1",
    accessKeyPlaceholder: "",
    mark: { label: "OC", from: "#d75a48", to: "#b03a2a" },
  },
  {
    id: "b2",
    name: "Backblaze B2",
    region: "us-west-004",
    accessKeyPlaceholder: "005a1b2c3d4e5f60000000001",
    mark: { label: "B2", from: "#e8513f", to: "#c0271b" },
  },
  {
    id: "wasabi",
    name: "Wasabi",
    region: "us-east-1",
    accessKeyPlaceholder: "WASABIEXAMPLEKEY0001",
    mark: { label: "WS", from: "#35a05b", to: "#177036" },
  },
  {
    id: "spaces",
    name: "DigitalOcean Spaces",
    region: "nyc3",
    accessKeyPlaceholder: "DO00EXAMPLEACCESSKEY",
    mark: { label: "DO", from: "#4a90f0", to: "#0a63e0" },
  },
  {
    id: "garage",
    name: "My storage",
    region: "garage",
    accessKeyPlaceholder: "",
    mark: { label: "MY", from: "#7d7aff", to: "#4b48d6" },
    system: true,
  },
  {
    id: "dropbox",
    name: "Dropbox",
    region: "",
    accessKeyPlaceholder: "App key",
    mark: { label: "DB", from: "#3d8bff", to: "#0050d8" },
  },
  {
    id: "onedrive",
    name: "OneDrive",
    region: "",
    accessKeyPlaceholder: "Application (client) ID",
    mark: { label: "OD", from: "#28a8ea", to: "#0364b8" },
  },
  {
    id: "scaleway",
    name: "Scaleway Object Storage",
    region: "fr-par",
    accessKeyPlaceholder: "SCWEXAMPLEACCESSKEY1",
    mark: { label: "SC", from: "#9067ef", to: "#6333c4" },
  },
  {
    id: "storj",
    name: "Storj",
    region: "global",
    accessKeyPlaceholder: "jwexampleaccesskey00",
    mark: { label: "ST", from: "#4a7ef0", to: "#2a53c0" },
  },
  {
    id: "minio",
    name: "MinIO",
    region: "on-prem",
    accessKeyPlaceholder: "minioadmin",
    mark: { label: "M", from: "#e05560", to: "#bf2334" },
  },
];

/** Providers with a working connector; the rest are listed as coming soon. */
export const CONNECTABLE = ["s3", "azure", "gcs", "oci", "r2", "wasabi", "b2", "spaces", "scaleway", "storj", "minio", "dropbox", "onedrive"] as const;
export type ConnectableKind = (typeof CONNECTABLE)[number];
export const isConnectable = (id: string): id is ConnectableKind => (CONNECTABLE as readonly string[]).includes(id);

export function findPreset(presetId: string | undefined): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === presetId);
}

/** S3 bucket naming, which every S3-compatible provider follows closely enough. */
export function validateBucketName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Bucket name is required.";
  if (trimmed.length < 3 || trimmed.length > 63) return "Use between 3 and 63 characters.";
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(trimmed))
    return "Use lowercase letters, numbers, dots, and hyphens.";
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Quick filters                                                       */
/* ------------------------------------------------------------------ */

export type QuickFilter = "all" | "media" | "data" | "starred" | "large";

export const QUICK_FILTERS: { id: QuickFilter; label: string }[] = [
  { id: "all", label: "All Files" },
  { id: "media", label: "Images & Video" },
  { id: "data", label: "Data & SQL" },
  { id: "starred", label: "Starred" },
  { id: "large", label: "> 10 MB" },
];

/** Kind filters hide folders, as Finder does; "All Files" keeps them for navigation. */
export function matchesFilter(item: StorageNode, filter: QuickFilter, starred: Set<string>): boolean {
  switch (filter) {
    case "media":
      return item.preview === "image" || item.preview === "vector" || item.preview === "video";
    case "data":
      return item.preview === "data";
    case "starred":
      return starred.has(item.id);
    case "large":
      return item.kind === "file" && (item.size ?? 0) > 10 * MB;
    default:
      return true;
  }
}

/* ------------------------------------------------------------------ */
/* Inspector labels                                                    */
/* ------------------------------------------------------------------ */

const LONG_TYPES: Record<string, string> = {
  svg: "Scalable Vector Graphics",
  png: "Portable Network Graphics",
  jpg: "JPEG Image",
  webp: "WebP Image",
  pdf: "Portable Document Format",
  csv: "Comma-Separated Values",
  sql: "SQL Dump",
  mp4: "MPEG-4 Video",
  webm: "WebM Video",
};

export function longTypeOf(item: StorageNode): string {
  return LONG_TYPES[fileExtension(item.name)] ?? item.type;
}
