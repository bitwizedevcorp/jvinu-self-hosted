import { profileOf, type PresetId } from "./providers";
/**
 * Storage list prices, for a monthly estimate. Storage only: requests, egress, retrieval
 * fees and minimum-duration charges aren't included, and regions differ — so the result is
 * an estimate, and every connection can set its own rate instead.
 *
 * Prices are USD per GB-month, where a GB is 2^30 bytes (as the clouds bill it).
 * Checked October 2026 against each provider's pricing page.
 */
export const PRICES_AS_OF = "October 2026";

export type PriceSheet = {
  /** Where the numbers come from, for the "about this estimate" note. */
  source: string;
  /** Rate per normalised storage class; `default` covers anything unlisted. */
  classes: Record<string, number> & { default: number };
  /** Region the prices are for, when they vary by region. */
  region?: string;
  /** GB-months free each month. */
  freeGB?: number;
  /** A flat monthly fee that includes this many GB. */
  base?: { usd: number; includedGB: number };
  /** Billed for at least this much storage. */
  minimumGB?: number;
  note?: string;
  /** Downloads to the internet. */
  egress: {
    /** USD per GB once any allowance is used up; 0 means downloading is free. */
    perGB: number;
    /** What's free first each month, in words ("the first 100 GB a month"). */
    allowance?: string;
    note?: string;
  };
  /** USD per GB read, for classes that charge to read (cold and archive tiers). */
  retrieval?: Record<string, number>;
  /** Classes that must be restored before a file can be read, and how long that takes. */
  restore?: Record<string, string>;
};

const TB = 1000; // the per-TB prices below are quoted per 1,000 GB

export const PRICE_SHEETS: Record<PresetId, PriceSheet | "self-hosted" | "plan"> = {
  s3: {
    source: "aws.amazon.com/s3/pricing",
    region: "US East (N. Virginia)",
    classes: {
      default: 0.023,
      STANDARD: 0.023,
      INTELLIGENT_TIERING: 0.023,
      STANDARD_IA: 0.0125,
      ONEZONE_IA: 0.01,
      GLACIER_IR: 0.004,
      GLACIER: 0.0036,
      DEEP_ARCHIVE: 0.00099,
      EXPRESS_ONEZONE: 0.11,
      REDUCED_REDUNDANCY: 0.024,
    },
    note: "Intelligent-Tiering is priced at its frequent-access tier.",
    egress: { perGB: 0.09, allowance: "the first 100 GB a month (across AWS) are free" },
    retrieval: { STANDARD_IA: 0.01, ONEZONE_IA: 0.01, GLACIER_IR: 0.03, GLACIER: 0.01, DEEP_ARCHIVE: 0.02 },
    restore: { GLACIER: "minutes to 12 hours", DEEP_ARCHIVE: "12 to 48 hours" },
  },
  azure: {
    source: "azure.microsoft.com/pricing/details/storage/blobs",
    region: "East US, LRS",
    classes: { default: 0.0208, HOT: 0.0208, COOL: 0.0152, COLD: 0.0036, ARCHIVE: 0.00099 },
    egress: { perGB: 0.087, allowance: "the first 100 GB a month are free" },
    retrieval: { COOL: 0.01, COLD: 0.03, ARCHIVE: 0.02 },
    restore: { ARCHIVE: "up to 15 hours (it has to be rehydrated)" },
  },
  gcs: {
    source: "cloud.google.com/storage/pricing",
    region: "us-central1",
    classes: {
      default: 0.02,
      STANDARD: 0.02,
      REGIONAL: 0.02,
      MULTI_REGIONAL: 0.026,
      NEARLINE: 0.01,
      COLDLINE: 0.004,
      ARCHIVE: 0.0012,
    },
    egress: { perGB: 0.12, note: "Premium network tier, first TB; $0.085 on the Standard tier." },
    retrieval: { NEARLINE: 0.01, COLDLINE: 0.02, ARCHIVE: 0.05 },
  },
  oci: {
    source: "oracle.com/cloud/storage/pricing",
    classes: { default: 0.0255, STANDARD: 0.0255, INFREQUENTACCESS: 0.0085, ARCHIVE: 0.0026 },
    egress: { perGB: 0.0085, allowance: "the first 10 TB a month are free" },
    retrieval: { INFREQUENTACCESS: 0.01, ARCHIVE: 0.01 },
    restore: { ARCHIVE: "about an hour" },
  },
  r2: {
    source: "developers.cloudflare.com/r2/pricing",
    classes: { default: 0.015, STANDARD: 0.015, STANDARD_IA: 0.01 },
    freeGB: 10,
    note: "The 10 GB free tier applies to Standard storage, across the whole account.",
    egress: { perGB: 0 },
    retrieval: { STANDARD_IA: 0.01 },
  },
  wasabi: {
    source: "wasabi.com/pricing",
    classes: { default: 7.99 / TB },
    minimumGB: 1 * TB,
    note: "Pay-as-you-go rate from July 2026; Wasabi bills at least 1 TB a month.",
    egress: { perGB: 0, note: "Free while monthly downloads stay at or below what you store." },
  },
  b2: {
    source: "backblaze.com/cloud-storage/pricing",
    classes: { default: 6.95 / TB },
    freeGB: 10,
    egress: { perGB: 0.01, allowance: "downloads up to 3× what you store each month are free" },
  },
  spaces: {
    source: "digitalocean.com/pricing/spaces-object-storage",
    classes: { default: 0.02 },
    base: { usd: 5, includedGB: 250 },
    note: "The $5 subscription covers all Spaces on the account.",
    egress: { perGB: 0.01, allowance: "1 TiB a month is included in the $5 plan" },
  },
  scaleway: {
    source: "scaleway.com/en/pricing/storage",
    region: "Paris, Amsterdam, Warsaw",
    // Billed in euro: €0.01606 Multi-AZ, €0.00803 One Zone, €0.00254 Glacier, at ~1.15 USD/EUR.
    classes: { default: 0.0185, STANDARD: 0.0185, ONEZONE_IA: 0.0092, GLACIER: 0.0029 },
    note: "Scaleway bills in euro; converted at about 1.15 USD per euro.",
    egress: { perGB: 0.0115, allowance: "the first 75 GB a month are free" },
    retrieval: { GLACIER: 0.0104 },
    restore: { GLACIER: "minutes to hours (it has to be restored first)" },
  },
  storj: {
    source: "storj.io/pricing",
    classes: { default: 7 / TB },
    note: "Standard tier (global). Storj bills at least $5 a month.",
    egress: { perGB: 7 / TB },
  },
  minio: "self-hosted",
  garage: "self-hosted",
  dropbox: "plan",
  onedrive: "plan",
  gdrive: "plan",
};

/** "Standard_IA", "Hot", "InfrequentAccess" → the keys used above. */
export const normaliseClass = (storageClass: string | null | undefined) =>
  (storageClass ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_") || "default";

export type ClassUsage = { storageClass: string | null; bytes: number };

export type CostEstimate =
  | { kind: "estimate"; monthly: number; lines: { label: string; gb: number; rate: number; usd: number }[]; sheet: PriceSheet | null; custom: boolean }
  | { kind: "self-hosted" | "plan" | "unknown" };

const GB = 1024 ** 3;

/**
 * This connection's share of the monthly storage bill. Account-wide allowances (free
 * tiers, Spaces' included 250 GB, Wasabi's 1 TB minimum) are applied as if this bucket
 * were the only one, so with several buckets the real bill is lower or higher.
 */
export function estimateCost(
  presetId: string,
  endpoint: string | undefined,
  usage: ClassUsage[],
  customRate?: number | null,
): CostEstimate {
  const totalGB = usage.reduce((sum, item) => sum + item.bytes, 0) / GB;
  if (customRate !== undefined && customRate !== null) {
    const usd = totalGB * customRate;
    return { kind: "estimate", monthly: usd, lines: [{ label: "All storage", gb: totalGB, rate: customRate, usd }], sheet: null, custom: true };
  }

  const sheet = sheetFor(presetId, endpoint);
  if (typeof sheet === "string") return { kind: sheet };

  const byClass = new Map<string, number>();
  for (const item of usage) {
    const key = normaliseClass(item.storageClass);
    const known = key in sheet.classes ? key : "default";
    byClass.set(known, (byClass.get(known) ?? 0) + item.bytes / GB);
  }

  const lines: { label: string; gb: number; rate: number; usd: number }[] = [];
  let free = sheet.freeGB ?? 0;
  for (const [key, gb] of [...byClass].sort((a, b) => b[1] - a[1])) {
    const rate = sheet.classes[key];
    // Free tiers and the included allowance come off the default (standard) class first.
    const waived = key === "default" || key === "STANDARD" ? Math.min(gb, free) : 0;
    free -= waived;
    lines.push({ label: key === "default" ? "Standard" : key.replaceAll("_", " ").toLowerCase(), gb, rate, usd: (gb - waived) * rate });
  }

  let monthly = lines.reduce((sum, line) => sum + line.usd, 0);
  if (sheet.base) monthly = sheet.base.usd + Math.max(0, totalGB - sheet.base.includedGB) * sheet.classes.default;
  if (sheet.minimumGB && totalGB < sheet.minimumGB) monthly = sheet.minimumGB * sheet.classes.default;
  return { kind: "estimate", monthly, lines, sheet, custom: false };
}

/* ---- Downloads ------------------------------------------------------------------ */

export type DownloadCost =
  | { kind: "free"; note?: string }
  | {
      kind: "estimate";
      /** Egress + retrieval for one download of the whole file. */
      usd: number;
      egressUsd: number;
      retrievalUsd: number;
      /** A monthly free allowance that may cover it, in words. */
      allowance?: string;
      custom: boolean;
    }
  | { kind: "self-hosted" | "plan" | "unknown" };

/**
 * The sheet for a connection, or why there isn't one: the one place that knows a custom S3
 * endpoint (MinIO, an emulator, another service) has no list price.
 */
export function sheetFor(presetId: string, endpoint: string | undefined): PriceSheet | "self-hosted" | "plan" | "unknown" {
  const sheet = profileOf(presetId) ? PRICE_SHEETS[presetId as PresetId] : undefined;
  if (sheet === "self-hosted" || sheet === "plan") return sheet;
  if (!sheet || (presetId === "s3" && endpoint)) return "unknown";
  return sheet;
}

/** USD per GB to read a file of this class (0 for classes that don't charge to read). */
export function retrievalRate(presetId: string, endpoint: string | undefined, storageClass: string | null | undefined): number {
  const sheet = sheetFor(presetId, endpoint);
  return typeof sheet === "string" ? 0 : (sheet.retrieval?.[normaliseClass(storageClass)] ?? 0);
}

/* ---- Per-file rates, for Storage X-Ray --------------------------------------------- */

/**
 * USD per GB-month for one file of this class, or null where there's no per-GB price
 * (self-hosted, flat plans, custom endpoints without a rate of their own).
 */
export function storageRate(
  presetId: string,
  endpoint: string | undefined,
  storageClass: string | null | undefined,
  customRate?: number | null,
): number | null {
  if (customRate !== undefined && customRate !== null) return customRate;
  const sheet = sheetFor(presetId, endpoint);
  if (typeof sheet === "string") return null;
  const key = normaliseClass(storageClass);
  return sheet.classes[key in sheet.classes ? key : "default"];
}

/** Infrequent-access classes, in the order to suggest them: instant to read, cheaper to keep. */
const COOLER = ["STANDARD_IA", "COOL", "NEARLINE", "INFREQUENTACCESS"];

/** The cheaper class a rarely-read file could move to here, and what it costs. */
export function coolerClass(presetId: string, endpoint: string | undefined): { storageClass: string; rate: number; standard: number } | null {
  const sheet = sheetFor(presetId, endpoint);
  if (typeof sheet === "string") return null;
  const storageClass = COOLER.find((name) => name in sheet.classes);
  return storageClass ? { storageClass, rate: sheet.classes[storageClass], standard: sheet.classes.default } : null;
}

/**
 * How long a file of this class takes to restore before it can be read, if it must be.
 * A class means the same on any S3-compatible service that reports it, so this holds for
 * custom endpoints too, even though their prices are unknown.
 */
export function restoreDelay(presetId: string, _endpoint: string | undefined, storageClass: string | null | undefined): string | null {
  const sheet = profileOf(presetId) ? PRICE_SHEETS[presetId as PresetId] : undefined;
  return typeof sheet === "object" ? (sheet.restore?.[normaliseClass(storageClass)] ?? null) : null;
}

/**
 * What one download of `bytes` costs the owner: internet egress at the provider's rate
 * (or the connection's own), plus any retrieval fee for cold classes. Free allowances are
 * mentioned rather than subtracted — they're monthly and account-wide.
 */
export function downloadCost(
  presetId: string,
  endpoint: string | undefined,
  storageClass: string | null | undefined,
  bytes: number,
  customEgress?: number | null,
): DownloadCost {
  const gb = bytes / GB;
  const sheet = sheetFor(presetId, endpoint);
  const retrievalUsd = gb * retrievalRate(presetId, endpoint, storageClass);
  if (customEgress !== undefined && customEgress !== null) {
    const egressUsd = gb * customEgress;
    return egressUsd + retrievalUsd === 0
      ? { kind: "free" }
      : { kind: "estimate", usd: egressUsd + retrievalUsd, egressUsd, retrievalUsd, custom: true };
  }
  if (typeof sheet === "string") return { kind: sheet };
  const egressUsd = gb * sheet.egress.perGB;
  if (egressUsd + retrievalUsd === 0) return { kind: "free", note: sheet.egress.note };
  return { kind: "estimate", usd: egressUsd + retrievalUsd, egressUsd, retrievalUsd, allowance: sheet.egress.allowance, custom: false };
}

/** "about $0.45 per download", "free to download" — for a line under a button. */
export function describeDownloadCost(cost: DownloadCost): string {
  switch (cost.kind) {
    case "free":
      return "Free to download";
    case "estimate":
      return `About ${formatUsd(cost.usd)} per download${cost.allowance ? ` — ${cost.allowance}` : ""}`;
    case "self-hosted":
      return "Free to download — it's on your own server";
    case "plan":
      return "No per-download fee: this service bills by plan";
    case "unknown":
      return "No download estimate for this connection";
  }
}

export const formatUsd = (usd: number) =>
  usd === 0 ? "$0" : usd < 0.01 ? "< $0.01" : usd.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: usd < 100 ? 2 : 0 });
