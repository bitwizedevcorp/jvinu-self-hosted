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

/**
 * Encryption at rest, per provider: "optional" where the API lets a client ask for it per
 * file (SSE-S3 on S3, SSE-B2 on Backblaze); "always" where the provider encrypts
 * everything anyway; "none" where the API neither offers nor reports it.
 */
export type AtRest = "optional" | "always" | "none";
export function atRestEncryption(presetId: string): AtRest {
  switch (presetId) {
    case "s3":
    case "b2":
      return "optional";
    case "azure":
    case "gcs":
    case "oci":
    case "r2":
    case "wasabi":
    case "storj": // end-to-end encrypted by the network
      return "always";
    default:
      return "none";
  }
}
