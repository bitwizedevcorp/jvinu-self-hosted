import "server-only";
import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 for a form-encoded POST: enough for the IAM query API (Wasabi's
 * user and policy calls), without pulling in another SDK client.
 */
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();

export function signedFormPost(
  url: string,
  body: string,
  credentials: { accessKeyId: string; secretAccessKey: string },
  region: string,
  service: string,
  now = new Date(),
): Record<string, string> {
  const host = new URL(url).host;
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const contentType = "application/x-www-form-urlencoded; charset=utf-8";
  const payloadHash = sha256(body);
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const path = new URL(url).pathname || "/";
  const canonicalRequest = ["POST", path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  key = hmac(key, region);
  key = hmac(key, service);
  key = hmac(key, "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return {
    "content-type": contentType,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
