import "server-only";
import { randomUUID } from "node:crypto";
import { coolerClass, estimateCost, normaliseClass, storageRate } from "../../pricing";
import type { XrayExposure, XrayFinding, XrayReport, XraySecret } from "../../xray";
import { eachLimit, type BucketAudit, type Listing, type StorageDriver } from "../drivers/types";
import { nameRule, scanText, worthReading } from "./secrets";

/**
 * Storage X-Ray's scan. One flat listing (shared with analytics and search), a handful of
 * bucket-level calls, and a look inside the small text files most likely to hold a
 * credential — sized to finish within a minute on a bucket of 100,000 objects.
 */
export type XrayTarget = {
  id: string;
  name: string;
  bucket: string;
  presetId: string;
  /** "Amazon S3", "Cloudflare R2"… */
  provider: string;
  endpoint?: string;
  pricePerGb?: number;
  /** jvinu encryption: names and checksums in the bucket are ciphertext. */
  encrypted: boolean;
  publicBaseUrl?: string;
};

type File = Listing["files"][number];

const GB = 1024 ** 3;
const DAY = 86_400_000;
/** Files opened looking for secrets, how much of each is read, and for how long in all. */
export const CONTENT_FILES = 200;
const CONTENT_BYTES = 256 * 1024;
const CONTENT_BUDGET_MS = 35_000;
const EXAMPLES = 8;
const SECRETS_KEPT = 500;

export const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]+|~\$[^/]*)$|\.(tmp|temp|part|crdownload|swp)$/i;
export const STANDARD = new Set(["default", "STANDARD", "HOT", "REGIONAL", "MULTI_REGIONAL"]);

/** Files in the standard class that haven't changed in `days`, big enough for a cooler class to pay off. */
export function coldFiles(files: File[], now: number, days = 180): File[] {
  const cutoff = new Date(now - days * DAY).toISOString();
  return files.filter(
    (file) => file.size >= 128 * 1024 && file.lastModified !== null && file.lastModified < cutoff && STANDARD.has(normaliseClass(file.storageClass)),
  );
}

const biggest = <T extends { bytes: number }>(list: T[]) => [...list].sort((a, b) => b.bytes - a.bytes).slice(0, EXAMPLES);

async function textOf(driver: StorageDriver, key: string): Promise<string> {
  const body = await driver.read(key, { start: 0, end: CONTENT_BYTES - 1 });
  const reader = body.stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= CONTENT_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function exposureOf(checks: XrayExposure["checks"], sampledPublic: boolean, objects: number, publicBaseUrl?: string): XrayExposure {
  const reasons: string[] = [];
  const open = checks.blocked !== true;
  if (checks.anonymousListing) reasons.push("Anyone can list this bucket without credentials.");
  if (checks.policyPublic && open) reasons.push("The bucket policy grants public access.");
  if (checks.aclPublic && open) reasons.push("The bucket's ACL grants access to everyone.");
  const bucketPublic = reasons.length > 0;
  if (sampledPublic && !bucketPublic) reasons.push("Files in this bucket answer requests that carry no credentials.");
  if (publicBaseUrl) reasons.push(`Files are published on purpose through ${publicBaseUrl}.`);
  if (bucketPublic || sampledPublic) {
    return { state: "public", reasons, publicFiles: bucketPublic ? objects : null, checks, publicBaseUrl };
  }
  if (checks.blocked === true) {
    return { state: "private", reasons: ["“Block public access” is fully on."], publicFiles: 0, checks, publicBaseUrl };
  }
  if (checks.policyPublic === false && checks.aclPublic === false) {
    return { state: "private", reasons: ["Neither the bucket policy nor its ACL grants public access."], publicFiles: 0, checks, publicBaseUrl };
  }
  return {
    state: "unknown",
    reasons: [...reasons, "This service doesn't report its public-access settings; a sample of files refused anonymous requests."],
    publicFiles: null,
    checks,
    publicBaseUrl,
  };
}

export async function xrayScan(
  target: XrayTarget,
  driver: StorageDriver,
  audit: BucketAudit | undefined,
  inventory: { files: File[]; truncated: boolean },
  now = Date.now(),
): Promise<XrayReport> {
  const started = Date.now();
  const { files, truncated } = inventory;
  const notes: string[] = [];
  const rate = (file: { storageClass: string | null }) => storageRate(target.presetId, target.endpoint, file.storageClass, target.pricePerGb);
  const usd = (bytes: number, perGb: number | null) => (perGb === null ? null : (bytes / GB) * perGb);
  const standardRate = storageRate(target.presetId, target.endpoint, null, target.pricePerGb);
  const priced = standardRate !== null;

  /* ---- Cost by folder ---------------------------------------------------------- */
  const folders = new Map<string, { objects: number; bytes: number; usd: number }>();
  const byClass = new Map<string, number>();
  let bytes = 0;
  for (const file of files) {
    bytes += file.size;
    byClass.set(file.storageClass ?? "", (byClass.get(file.storageClass ?? "") ?? 0) + file.size);
    const slash = file.key.indexOf("/");
    const folder = slash < 0 ? "" : file.key.slice(0, slash + 1);
    const entry = folders.get(folder) ?? { objects: 0, bytes: 0, usd: 0 };
    entry.objects += 1;
    entry.bytes += file.size;
    entry.usd += usd(file.size, rate(file)) ?? 0;
    folders.set(folder, entry);
  }
  const cost = estimateCost(
    target.presetId,
    target.endpoint,
    [...byClass].map(([storageClass, size]) => ({ storageClass: storageClass || null, bytes: size })),
    target.pricePerGb,
  );

  /* ---- Waste -------------------------------------------------------------------- */
  const waste: XrayFinding[] = [];

  // Bucket-level checks run side by side; each one failing costs only its own finding.
  const [uploads, versioning, exposureChecks] = await Promise.all([
    audit ? audit.incompleteUploads().catch(() => null) : null,
    audit ? audit.versioning().catch(() => "unknown" as const) : ("unknown" as const),
    audit ? audit.exposure().catch(() => null) : null,
  ]);
  if (!audit) notes.push(`${target.provider} has no API for unfinished uploads, old versions or public-access settings, so those weren't checked.`);

  if (uploads === null && audit) notes.push("Unfinished uploads couldn't be listed (the service refused, or doesn't support it).");
  if (uploads?.uploads.length) {
    const sized = uploads.uploads.filter((upload) => upload.bytes !== null);
    const total = sized.reduce((sum, upload) => sum + (upload.bytes ?? 0), 0);
    waste.push({
      id: "incomplete-uploads",
      title: "Unfinished uploads",
      detail:
        "Parts of multipart uploads that were started and never completed. They're billed like any other storage until someone cancels them, and no file listing shows them." +
        (sized.length < uploads.uploads.length || uploads.truncated ? " Only some were sized, so the real total is higher." : ""),
      objects: uploads.uploads.length,
      bytes: total,
      monthlyUsd: usd(total, standardRate),
      examples: biggest(uploads.uploads.map((upload) => ({ key: upload.key, bytes: upload.bytes ?? 0, note: upload.initiated ? `started ${upload.initiated.slice(0, 10)}` : undefined }))),
      fix: "abort-uploads",
    });
  }

  if (audit && versioning !== "off" && versioning !== "unknown") {
    const listed = await audit.versions("", 20).catch(() => null);
    if (!listed) notes.push("Old versions couldn't be listed.");
    else {
      const old = listed.versions.filter((version) => !version.latest && !version.deleteMarker);
      const total = old.reduce((sum, version) => sum + version.size, 0);
      if (old.length) {
        const perKey = new Map<string, number>();
        for (const version of old) perKey.set(version.key, (perKey.get(version.key) ?? 0) + version.size);
        waste.push({
          id: "old-versions",
          title: "Old versions",
          detail:
            `Versioning is ${versioning}, so every overwrite and delete keeps the previous copy. These are the copies that are no longer current` +
            (listed.truncated ? " (a lower bound: the listing was cut short)." : "."),
          objects: old.length,
          bytes: total,
          monthlyUsd: old.reduce<number | null>((sum, version) => (sum === null ? null : sum + (usd(version.size, rate(version)) ?? Number.NaN)), priced ? 0 : null),
          examples: biggest([...perKey].map(([key, size]) => ({ key, bytes: size }))),
          fix: "purge-versions",
        });
      }
    }
  }

  if (!target.encrypted) {
    // Same size and same checksum: the same bytes stored more than once.
    const groups = new Map<string, File[]>();
    for (const file of files) {
      if (file.size < 1024 * 1024 || !file.etag) continue;
      const id = `${file.size}:${file.etag}`;
      const group = groups.get(id);
      if (group) group.push(file);
      else groups.set(id, [file]);
    }
    const copies = [...groups.values()].filter((group) => group.length > 1);
    if (copies.length) {
      const extra = copies.flatMap((group) => group.slice(1));
      const total = extra.reduce((sum, file) => sum + file.size, 0);
      waste.push({
        id: "duplicates",
        title: "Duplicate files",
        detail: "Files over 1 MB with the same size and checksum as another file in this bucket. One copy of each is counted as needed; the rest is listed here.",
        objects: extra.length,
        bytes: total,
        monthlyUsd: priced ? extra.reduce((sum, file) => sum + (usd(file.size, rate(file)) ?? 0), 0) : null,
        examples: biggest(copies.map((group) => ({ key: group[1].key, bytes: group[0].size * (group.length - 1), note: `${group.length} copies, e.g. ${group[0].key}` }))),
        fix: null,
      });
    }
  }

  const junk = files.filter((file) => JUNK.test(file.key));
  if (junk.length) {
    const total = junk.reduce((sum, file) => sum + file.size, 0);
    waste.push({
      id: "junk",
      title: "Temporary and system files",
      detail: "Leftovers that operating systems and interrupted downloads leave behind: .DS_Store, Thumbs.db, ~$ lock files, .tmp, .part and the like.",
      objects: junk.length,
      bytes: total,
      monthlyUsd: priced ? junk.reduce((sum, file) => sum + (usd(file.size, rate(file)) ?? 0), 0) : null,
      examples: biggest(junk.map((file) => ({ key: file.key, bytes: file.size }))),
      fix: "remove-junk",
    });
  }

  const cooler = target.pricePerGb === undefined ? coolerClass(target.presetId, target.endpoint) : null;
  if (cooler) {
    const cold = coldFiles(files, now);
    const total = cold.reduce((sum, file) => sum + file.size, 0);
    const saving = (total / GB) * (cooler.standard - cooler.rate);
    if (cold.length && saving >= 0.01) {
      waste.push({
        id: "cold",
        title: "Cold data on hot storage",
        detail: `Files not changed in six months that sit in the standard class. In ${cooler.storageClass.replaceAll("_", " ").toLowerCase()} they'd cost about ${Math.round((1 - cooler.rate / cooler.standard) * 100)}% less to keep; reading them back then costs a small fee, so this suits files that are rarely opened.`,
        objects: cold.length,
        bytes: total,
        monthlyUsd: saving,
        examples: biggest(cold.map((file) => ({ key: file.key, bytes: file.size, note: `last changed ${file.lastModified!.slice(0, 10)}` }))),
        fix: "cool-down",
      });
    }
  }

  /* ---- Secrets ------------------------------------------------------------------- */
  const secrets: XraySecret[] = [];
  const named = new Set<string>();
  for (const file of files) {
    const hit = nameRule(file.key);
    if (!hit) continue;
    named.add(file.key);
    if (secrets.length < SECRETS_KEPT) secrets.push({ key: file.key, ...hit, source: "name", public: null });
  }
  // Files whose name already raised a flag are read first, then the shallowest paths.
  const depth = (key: string) => key.split("/").length;
  const candidates = files
    .filter((file) => worthReading(file.key, file.size, CONTENT_BYTES))
    .sort((a, b) => Number(named.has(b.key)) - Number(named.has(a.key)) || depth(a.key) - depth(b.key));
  const toRead = candidates.slice(0, CONTENT_FILES);
  let contentScanned = 0;
  const deadline = Date.now() + CONTENT_BUDGET_MS;
  await eachLimit(toRead, 8, async (file) => {
    if (Date.now() > deadline) return;
    try {
      const hits = scanText(await textOf(driver, file.key));
      contentScanned += 1;
      for (const hit of hits) {
        if (secrets.length < SECRETS_KEPT) secrets.push({ key: file.key, rule: hit.rule, severity: hit.severity, source: "content", line: hit.line, public: null });
      }
    } catch {
      // Unreadable (archived, gone, refused): its name is all there is to go on.
    }
  });
  const contentSkipped = candidates.length - contentScanned;
  if (contentSkipped > 0) notes.push(`${contentSkipped.toLocaleString("en-US")} more small text files weren't opened: the scan reads at most ${CONTENT_FILES} per run.`);
  if (target.encrypted) notes.push("This connection uses jvinu encryption: the provider holds only ciphertext, so secrets found here aren't readable by anyone without your passphrase.");
  secrets.sort((a, b) => Number(b.severity === "high") - Number(a.severity === "high") || (a.key < b.key ? -1 : 1));

  /* ---- Public access ------------------------------------------------------------- */
  const checks = exposureChecks ?? { blocked: null, policyPublic: null, aclPublic: null, anonymousListing: null };
  let sampledPublic = false;
  if (audit && checks.blocked !== true) {
    // Flagged files first: a leaked key that's also public is the finding that matters most.
    const flagged = [...new Set(secrets.map((secret) => secret.key))].slice(0, 20);
    const sample = [...new Set([...flagged, ...files.slice(0, 5).map((file) => file.key)])];
    const answers = new Map<string, boolean | null>();
    await eachLimit(sample, 8, async (key) => {
      answers.set(key, await audit.publicObject(key).catch(() => null));
    });
    sampledPublic = [...answers.values()].some((value) => value === true);
    for (const secret of secrets) if (answers.has(secret.key)) secret.public = answers.get(secret.key) ?? null;
  }
  const exposure = exposureOf(checks, sampledPublic, files.length, target.publicBaseUrl);

  if (truncated) notes.push(`The listing stopped at ${files.length.toLocaleString("en-US")} objects, so totals are a lower bound.`);
  if (!priced) notes.push("There's no per-GB price for this connection, so waste is shown in bytes. Set a storage rate in Analytics to see it in money.");

  const removable = waste.filter((finding) => finding.id !== "cold");
  return {
    id: randomUUID(),
    connectionId: target.id,
    connectionName: target.name,
    bucket: target.bucket,
    provider: target.provider,
    scannedAt: new Date(now).toISOString(),
    elapsedMs: Date.now() - started,
    truncated,
    objects: files.length,
    bytes,
    monthlyUsd: cost.kind === "estimate" ? cost.monthly : null,
    costKind: cost.kind,
    folders: [...folders]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 25)
      .map(([folder, entry]) => ({ folder, objects: entry.objects, bytes: entry.bytes, monthlyUsd: priced ? entry.usd : null })),
    waste: waste.sort((a, b) => (b.monthlyUsd ?? 0) - (a.monthlyUsd ?? 0) || b.bytes - a.bytes),
    wasteBytes: removable.reduce((sum, finding) => sum + finding.bytes, 0),
    wasteMonthlyUsd: priced ? waste.reduce((sum, finding) => sum + (finding.monthlyUsd ?? 0), 0) : null,
    exposure,
    secrets,
    contentScanned,
    contentSkipped,
    notes,
  };
}
