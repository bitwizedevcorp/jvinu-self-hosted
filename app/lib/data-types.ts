/**
 * What the data routes send the page — mirrors app/lib/server/data/{preview,lake}.ts, which
 * the browser can't import.
 */

export type DataFormat = "parquet" | "csv" | "tsv" | "json" | "ndjson" | "avro";

export type DataPreview = {
  format: DataFormat;
  compression?: string;
  size: number;
  bytesRead: number;
  rowCount: number | null;
  rowCountExact: boolean;
  columns: { name: string; type: string }[];
  shown: string[];
  rows: (string | null)[][];
  notes: string[];
  details: { label: string; value: string }[];
};

export type LakeFormat = "delta" | "iceberg" | "hudi";

export type LakeRoot = { root: string; format: LakeFormat; alsoIceberg?: boolean };

export type LakeTableInfo = LakeRoot & {
  name?: string;
  description?: string;
  version?: string;
  formatVersion?: string;
  lastUpdated?: string | null;
  files: number | null;
  bytes: number | null;
  rows: number | null;
  partitionColumns: string[];
  columns: { name: string; type: string; nullable?: boolean }[];
  properties: { key: string; value: string }[];
  features: string[];
  history: { version: string; timestamp: string | null; operation: string; summary: string }[];
  location?: string;
  notes: string[];
};

/** A change jvinu paused because it touches a table: the server's 409 lists these. */
export type TableChange = {
  key: string;
  table: LakeRoot;
  relation: "inside" | "root" | "contains" | "into";
  message: string;
};

export const FORMAT_LABELS: Record<DataFormat, string> = {
  parquet: "Parquet",
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  ndjson: "JSON Lines",
  avro: "Avro",
};

export const LAKE_LABELS: Record<LakeFormat, string> = { delta: "Delta table", iceberg: "Iceberg table", hudi: "Hudi table" };

/** Same rules as the server's dataFormatOf: which files get a "Preview data" button. */
export function isDataFile(name: string): boolean {
  let lower = name.toLowerCase();
  const gzip = /\.gz(ip)?$/.test(lower);
  if (gzip) lower = lower.replace(/\.gz(ip)?$/, "");
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (["parquet", "parq", "pqt", "avro"].includes(ext)) return !gzip;
  return ["csv", "tsv", "tab", "json", "jsonl", "ndjson"].includes(ext);
}
