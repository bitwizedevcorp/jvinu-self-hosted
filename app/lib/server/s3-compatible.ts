import "server-only";
import { cleanEndpoint } from "./http";

/**
 * S3-compatible clouds that run on the S3 driver. The endpoint is always built
 * here from validated parts — never taken from the user — so a saved connection
 * can only ever talk to that provider.
 */
export type S3CompatibleId = "r2" | "wasabi" | "b2" | "spaces" | "scaleway" | "storj" | "minio";

type Spec = {
  label: string;
  /** Returns the endpoint and the signing region, or a message saying what's wrong. */
  locate: (body: Record<string, string>) => { endpoint: string; region: string } | { error: string };
  accessKey: RegExp;
  accessKeyMessage: string;
  bucket: RegExp;
  /** Shortest secret the service issues (default 20). */
  secretMin?: number;
};

export const WASABI_REGIONS = [
  "us-east-1", "us-east-2", "us-central-1", "us-west-1", "us-west-2", "ca-central-1",
  "eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-south-1",
  "ap-northeast-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2",
];

export const SCALEWAY_REGIONS = ["fr-par", "nl-ams", "pl-waw"];

export const SPACES_REGIONS = ["nyc3", "sfo2", "sfo3", "ams3", "sgp1", "fra1", "syd1", "blr1", "tor1", "lon1", "atl1"];

const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export const S3_COMPATIBLE: Record<S3CompatibleId, Spec> = {
  r2: {
    label: "Cloudflare R2",
    locate: ({ accountId, jurisdiction }) => {
      if (!/^[a-f0-9]{32}$/.test(accountId ?? "")) return { error: "Enter the 32-character Cloudflare account ID." };
      // EU and FedRAMP buckets live behind their own jurisdiction subdomain.
      const zone = jurisdiction === "eu" || jurisdiction === "fedramp" ? `${jurisdiction}.` : "";
      return { endpoint: `https://${accountId}.${zone}r2.cloudflarestorage.com`, region: "auto" };
    },
    accessKey: /^[a-f0-9]{32}$/,
    accessKeyMessage: "R2 access key IDs are 32 hex characters — create one under R2 → Manage API tokens.",
    bucket: /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
  },
  wasabi: {
    label: "Wasabi",
    locate: ({ region }) =>
      WASABI_REGIONS.includes(region ?? "")
        ? { endpoint: `https://s3.${region}.wasabisys.com`, region: region! }
        : { error: "Pick the region the bucket was created in." },
    accessKey: /^[A-Z0-9]{20}$/,
    accessKeyMessage: "Wasabi access keys are 20 capital letters and digits.",
    bucket: S3_BUCKET,
  },
  b2: {
    label: "Backblaze B2",
    locate: ({ region }) =>
      /^[a-z]{2}-[a-z]+-\d{3}$/.test(region ?? "")
        ? { endpoint: `https://s3.${region}.backblazeb2.com`, region: region! }
        : { error: "Enter the region from the bucket's S3 endpoint, like us-west-004." },
    accessKey: /^[0-9a-f]{12,40}$/,
    accessKeyMessage: "Backblaze key IDs are 12–40 lowercase hex characters, like 005a1b2c….",
    bucket: /^[A-Za-z0-9-]{6,63}$/,
  },
  spaces: {
    label: "DigitalOcean Spaces",
    locate: ({ region }) =>
      SPACES_REGIONS.includes(region ?? "")
        ? { endpoint: `https://${region}.digitaloceanspaces.com`, region: region! }
        : { error: "Pick the datacenter the Space is in." },
    accessKey: /^[A-Z0-9]{20}$/,
    accessKeyMessage: "Spaces access keys are 20 capital letters and digits, like DO00….",
    bucket: /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
  },
  scaleway: {
    label: "Scaleway",
    locate: ({ region }) =>
      SCALEWAY_REGIONS.includes(region ?? "")
        ? { endpoint: `https://s3.${region}.scw.cloud`, region: region! }
        : { error: "Pick the region the bucket was created in." },
    accessKey: /^SCW[A-Z0-9]{17}$/,
    accessKeyMessage: "Scaleway access keys are SCW followed by 17 capital letters and digits.",
    bucket: S3_BUCKET,
  },
  storj: {
    label: "Storj",
    // Storj's hosted S3 gateway serves every bucket; the region is a placeholder it ignores.
    locate: () => ({ endpoint: "https://gateway.storjshare.io", region: "us1" }),
    accessKey: /^[a-z0-9]{20,40}$/,
    accessKeyMessage: "Storj S3 access keys are 20–40 lowercase letters and digits — create S3 credentials under Access Keys.",
    bucket: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  },
  minio: {
    label: "MinIO",
    // Self-hosted: the endpoint is the user's, checked like any custom S3 endpoint (no
    // credentials in the URL, never a cloud metadata address).
    locate: ({ endpoint, region }) => {
      const cleaned = cleanEndpoint(endpoint);
      if (!cleaned) return { error: "Enter the MinIO server's address, such as https://minio.example.com:9000." };
      const signing = region || "us-east-1";
      if (!/^[a-z0-9-]{2,32}$/.test(signing)) return { error: "That isn't a valid region name." };
      return { endpoint: cleaned, region: signing };
    },
    accessKey: /^[A-Za-z0-9+/=._@-]{3,128}$/,
    accessKeyMessage: "Enter the MinIO access key (at least 3 characters, no spaces).",
    bucket: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    secretMin: 8,
  },
};

export const isS3Compatible = (id: unknown): id is S3CompatibleId =>
  typeof id === "string" && id in S3_COMPATIBLE;
