import "server-only";
import { randomBytes } from "node:crypto";
import { CreateBucketCommand, DeleteBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { S3Credentials } from "../connections";
import { driverFor } from "../drivers";
import { S3_COMPATIBLE } from "../s3-compatible";
import { signedFormPost } from "./sigv4";

/**
 * Where sold storage lives. Each customer gets their own private bucket and a key that
 * can reach only that bucket. Access can be narrowed to read-only (unpaid, over quota,
 * cancelled) and widened again; `destroy` empties and removes everything.
 */
export type ProvisionedBucket = {
  presetId: "b2" | "wasabi";
  bucket: string;
  region: string;
  endpoint: string;
  credentials: S3Credentials;
  /** Provider ids needed later to change access or clean up (bucket id, key id, user name). */
  handle: Record<string, string>;
};

/** "none": suspended for abuse — the key is withdrawn (B2) or denied everything (Wasabi). */
export type Access = "read-write" | "read-only" | "none";

export interface StorageProvider {
  readonly presetId: "b2" | "wasabi";
  create(orderId: string): Promise<ProvisionedBucket>;
  /** Returns new credentials when the provider had to replace the key to change access. */
  setAccess(bucket: ProvisionedBucket, access: Access): Promise<ProvisionedBucket>;
  destroy(bucket: ProvisionedBucket): Promise<void>;
}

/** Bucket names are global on both clouds: a fixed prefix plus 20 random hex characters. */
export const newBucketName = () => `jvinu-${randomBytes(10).toString("hex")}`;

const endpointFor = (presetId: "b2" | "wasabi", region: string) => {
  const located = S3_COMPATIBLE[presetId].locate({ region });
  if ("error" in located) throw new Error(`${presetId}: ${located.error}`);
  return located.endpoint;
};

/* ---- Backblaze B2: native API v2 -------------------------------------------------- */

type B2Auth = { accountId: string; authorizationToken: string; apiUrl: string; s3ApiUrl: string };

const B2_READ_WRITE = ["listBuckets", "listFiles", "readFiles", "shareFiles", "writeFiles", "deleteFiles"];
const B2_READ_ONLY = ["listBuckets", "listFiles", "readFiles", "shareFiles", "deleteFiles"];

export class B2Provider implements StorageProvider {
  readonly presetId = "b2" as const;
  private auth: { value: B2Auth; at: number } | null = null;

  constructor(private readonly master: { keyId: string; key: string }) {}

  private async authorize(): Promise<B2Auth> {
    // Tokens last 24 hours; renew well before.
    if (this.auth && Date.now() - this.auth.at < 12 * 3_600_000) return this.auth.value;
    const response = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
      headers: { authorization: `Basic ${Buffer.from(`${this.master.keyId}:${this.master.key}`).toString("base64")}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`B2 authorize: ${response.status} ${(await response.text()).slice(0, 200)}`);
    this.auth = { value: (await response.json()) as B2Auth, at: Date.now() };
    return this.auth.value;
  }

  private async call<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const auth = await this.authorize();
    const response = await fetch(`${auth.apiUrl}/b2api/v2/${name}`, {
      method: "POST",
      headers: { authorization: auth.authorizationToken, "content-type": "application/json" },
      body: JSON.stringify({ accountId: auth.accountId, ...body }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401) this.auth = null;
    if (!response.ok) throw new Error(`B2 ${name}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    return (await response.json()) as T;
  }

  private async key(bucketId: string, name: string, access: Access): Promise<S3Credentials> {
    const created = await this.call<{ applicationKeyId: string; applicationKey: string }>("b2_create_key", {
      keyName: name,
      bucketId,
      capabilities: access === "read-write" ? B2_READ_WRITE : B2_READ_ONLY,
    });
    return { kind: "s3", accessKeyId: created.applicationKeyId, secretAccessKey: created.applicationKey };
  }

  async create(orderId: string): Promise<ProvisionedBucket> {
    const auth = await this.authorize();
    const name = newBucketName();
    // B2 keeps every version unless told otherwise; drop hidden (deleted) files after a
    // day, so deleting frees space and the quota matches what the customer sees.
    const bucket = await this.call<{ bucketId: string }>("b2_create_bucket", {
      bucketName: name,
      bucketType: "allPrivate",
      lifecycleRules: [{ fileNamePrefix: "", daysFromHidingToDeleting: 1, daysFromUploadingToHiding: null }],
      bucketInfo: { jvinuOrder: orderId },
    });
    const region = new URL(auth.s3ApiUrl).hostname.replace(/^s3\./, "").replace(/\.backblazeb2\.com$/, "");
    const credentials = await this.key(bucket.bucketId, `jvinu-${orderId}`, "read-write");
    return {
      presetId: "b2",
      bucket: name,
      region,
      endpoint: endpointFor("b2", region),
      credentials,
      handle: { bucketId: bucket.bucketId },
    };
  }

  /** B2 keys can't be edited: make one with the new capabilities, then delete the old. */
  async setAccess(bucket: ProvisionedBucket, access: Access): Promise<ProvisionedBucket> {
    if (access === "none") {
      if (bucket.credentials.accessKeyId) await this.call("b2_delete_key", { applicationKeyId: bucket.credentials.accessKeyId }).catch(() => {});
      return { ...bucket, credentials: { kind: "s3", accessKeyId: "", secretAccessKey: "" } };
    }
    const credentials = await this.key(bucket.handle.bucketId, `jvinu-${access}-${randomBytes(4).toString("hex")}`, access);
    if (bucket.credentials.accessKeyId) await this.call("b2_delete_key", { applicationKeyId: bucket.credentials.accessKeyId }).catch(() => {});
    return { ...bucket, credentials };
  }

  async destroy(bucket: ProvisionedBucket): Promise<void> {
    // Every version of every file has to go before the bucket can.
    for (;;) {
      const page = await this.call<{ files: { fileId: string; fileName: string }[] }>("b2_list_file_versions", {
        bucketId: bucket.handle.bucketId,
        maxFileCount: 1000,
      });
      if (!page.files.length) break;
      for (const file of page.files) await this.call("b2_delete_file_version", { fileId: file.fileId, fileName: file.fileName });
    }
    await this.call("b2_delete_key", { applicationKeyId: bucket.credentials.accessKeyId }).catch(() => {});
    await this.call("b2_delete_bucket", { bucketId: bucket.handle.bucketId });
  }
}

/* ---- Wasabi: S3 for the bucket, IAM for a user scoped to it ----------------------- */

const IAM = "https://iam.wasabisys.com";

/** Reading, listing and deleting stay allowed even when read-only, so space can be freed. */
const WASABI_READ = [
  "s3:GetObject",
  "s3:GetObjectVersion",
  "s3:GetObjectTagging",
  "s3:ListBucket",
  "s3:ListBucketVersions",
  "s3:GetBucketLocation",
  "s3:DeleteObject",
  "s3:DeleteObjectVersion",
];
const WASABI_WRITE = [
  "s3:PutObject",
  "s3:PutObjectTagging",
  "s3:AbortMultipartUpload",
  "s3:ListMultipartUploadParts",
  "s3:ListBucketMultipartUploads",
];

const policyFor = (bucket: string, access: Access) =>
  access === "none"
    ? JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Deny", Action: ["s3:*"], Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`] }],
      })
    : JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        // Object-level actions only: a customer can never change the bucket itself (its
        // policy, ACL, versioning or lifecycle), so they can't make it public, for instance.
        Action: access === "read-write" ? [...WASABI_READ, ...WASABI_WRITE] : WASABI_READ,
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
      },
    ],
  });

const xmlValue = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];

export class WasabiProvider implements StorageProvider {
  readonly presetId = "wasabi" as const;

  constructor(private readonly master: { accessKeyId: string; secretAccessKey: string; region: string }) {}

  private async iam(action: string, params: Record<string, string>): Promise<string> {
    const body = new URLSearchParams({ Action: action, Version: "2010-05-08", ...params }).toString();
    const response = await fetch(`${IAM}/`, {
      method: "POST",
      headers: signedFormPost(`${IAM}/`, body, this.master, "us-east-1", "iam"),
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Wasabi IAM ${action}: ${response.status} ${text.slice(0, 200)}`);
    return text;
  }

  private s3() {
    return new S3Client({
      region: this.master.region,
      endpoint: endpointFor("wasabi", this.master.region),
      credentials: { accessKeyId: this.master.accessKeyId, secretAccessKey: this.master.secretAccessKey },
    });
  }

  async create(orderId: string): Promise<ProvisionedBucket> {
    const name = newBucketName();
    const user = `jvinu-${orderId}`;
    const region = this.master.region;
    await this.s3().send(
      new CreateBucketCommand({
        Bucket: name,
        ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
      }),
    );
    await this.iam("CreateUser", { UserName: user });
    await this.iam("PutUserPolicy", { UserName: user, PolicyName: "jvinu-bucket", PolicyDocument: policyFor(name, "read-write") });
    const xml = await this.iam("CreateAccessKey", { UserName: user });
    const accessKeyId = xmlValue(xml, "AccessKeyId");
    const secretAccessKey = xmlValue(xml, "SecretAccessKey");
    if (!accessKeyId || !secretAccessKey) throw new Error("Wasabi didn't return the new access key.");
    return {
      presetId: "wasabi",
      bucket: name,
      region,
      endpoint: endpointFor("wasabi", region),
      credentials: { kind: "s3", accessKeyId, secretAccessKey },
      handle: { userName: user },
    };
  }

  /** The policy changes in place; the key stays the same. */
  async setAccess(bucket: ProvisionedBucket, access: Access): Promise<ProvisionedBucket> {
    await this.iam("PutUserPolicy", {
      UserName: bucket.handle.userName,
      PolicyName: "jvinu-bucket",
      PolicyDocument: policyFor(bucket.bucket, access),
    });
    return bucket;
  }

  async destroy(bucket: ProvisionedBucket): Promise<void> {
    const driver = driverFor({
      presetId: "wasabi",
      bucket: bucket.bucket,
      region: bucket.region,
      endpoint: bucket.endpoint,
      credentials: { kind: "s3", accessKeyId: this.master.accessKeyId, secretAccessKey: this.master.secretAccessKey },
    });
    for (;;) {
      const { keys } = await driver.listKeys("", 1000);
      if (!keys.length) break;
      await driver.remove(keys);
    }
    await this.s3().send(new DeleteBucketCommand({ Bucket: bucket.bucket }));
    const user = bucket.handle.userName;
    await this.iam("DeleteAccessKey", { UserName: user, AccessKeyId: bucket.credentials.accessKeyId }).catch(() => "");
    await this.iam("DeleteUserPolicy", { UserName: user, PolicyName: "jvinu-bucket" }).catch(() => "");
    await this.iam("DeleteUser", { UserName: user }).catch(() => "");
  }
}
