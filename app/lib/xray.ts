/**
 * Storage X-Ray: one scan of a bucket for what it costs by folder, what's being paid for
 * and not used, what strangers can read, and what looks like a leaked credential.
 * These are the report's shapes, shared by the server that builds it and the page that shows it.
 */
export type XrayFixId = "abort-uploads" | "expire-uploads" | "purge-versions" | "cool-down" | "remove-junk" | "block-public";

export type XrayFinding = {
  id: "incomplete-uploads" | "old-versions" | "duplicates" | "cold" | "junk";
  title: string;
  /** One or two sentences: what it is and why it costs money. */
  detail: string;
  objects: number;
  bytes: number;
  /** What it adds to the monthly bill; null where there's no per-GB price. */
  monthlyUsd: number | null;
  examples: { key: string; bytes: number; note?: string }[];
  /** The one-click fix that clears it (paid plans), if there is one. */
  fix: XrayFixId | null;
};

export type XraySecret = {
  key: string;
  /** "AWS access key", "Private key file"… — never the secret itself. */
  rule: string;
  severity: "high" | "medium";
  /** Found by the file's name, or inside the file. */
  source: "name" | "content";
  line?: number;
  /** Whether a request with no credentials could fetch this file; null when not checked. */
  public: boolean | null;
};

export type XrayExposure = {
  state: "public" | "private" | "unknown";
  /** In words, what makes it so. */
  reasons: string[];
  /** Files anyone can read; null when that can't be told. */
  publicFiles: number | null;
  /** Each check's answer, null where the service wouldn't say. */
  checks: { blocked: boolean | null; policyPublic: boolean | null; aclPublic: boolean | null; anonymousListing: boolean | null };
  /** Set when the connection publishes files through a public URL on purpose. */
  publicBaseUrl?: string;
};

export type XrayReport = {
  id: string;
  connectionId: string;
  connectionName: string;
  bucket: string;
  /** "Amazon S3", "Cloudflare R2"… */
  provider: string;
  scannedAt: string;
  elapsedMs: number;
  /** True when the listing stopped at the cap: totals are a lower bound. */
  truncated: boolean;
  objects: number;
  bytes: number;
  /** null where the provider has no per-GB price (self-hosted, flat plans, custom endpoints). */
  monthlyUsd: number | null;
  costKind: "estimate" | "self-hosted" | "plan" | "unknown";
  /** Top-level folders by cost, biggest first; "" is files at the top level. */
  folders: { folder: string; objects: number; bytes: number; monthlyUsd: number | null }[];
  waste: XrayFinding[];
  wasteBytes: number;
  wasteMonthlyUsd: number | null;
  exposure: XrayExposure;
  secrets: XraySecret[];
  /** Files whose contents were read looking for secrets, and candidates left unread. */
  contentScanned: number;
  contentSkipped: number;
  /** What this scan couldn't check, in words. */
  notes: string[];
};

/** "jvinu found $41.20/month of waste" — the line people share. */
export function xrayHeadline(report: Pick<XrayReport, "wasteMonthlyUsd" | "wasteBytes" | "secrets" | "exposure">, formatUsd: (usd: number) => string, formatBytes: (bytes: number) => string): string {
  if (report.wasteMonthlyUsd && report.wasteMonthlyUsd >= 0.01) return `jvinu found ${formatUsd(report.wasteMonthlyUsd)}/month of waste`;
  if (report.wasteBytes > 0) return `jvinu found ${formatBytes(report.wasteBytes)} of waste`;
  if (report.secrets.length) return `jvinu found ${report.secrets.length} possible leaked secret${report.secrets.length === 1 ? "" : "s"}`;
  if (report.exposure.state === "public") return "jvinu found a bucket anyone can read";
  return "jvinu found no waste";
}
