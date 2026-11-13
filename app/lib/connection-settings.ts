import { profileOf, type AtRest } from "./providers";
/**
 * Per-connection options that aren't secret: stored as one JSON column, sent to the page as
 * they are. Each one is validated on the server (app/lib/server/settings.ts).
 */
export type ConnectionSettings = {
  /** USD per GB downloaded, instead of the provider's list price. */
  egressPerGb?: number;
  /** Ask the provider to encrypt new files at rest (S3-family: SSE-S3 / SSE-B2). */
  providerEncryption?: boolean;
  /** An https address in front of the bucket (a CDN or custom domain) for public URLs. */
  publicBaseUrl?: string;
  /** This connection is the share bucket: shared copies go under `prefix`. */
  shareTarget?: { prefix: string };
};

/** Encryption at rest, per provider: kept with the provider profiles (app/lib/providers.ts). */
export type { AtRest } from "./providers";
export function atRestEncryption(presetId: string): AtRest {
  return profileOf(presetId)?.atRest ?? "none";
}
