import "server-only";
import { StorageUserError } from "./drivers/types";
import { forbiddenHost } from "./egress";
import { VaultConfigError } from "./vault";

export function fail(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

/**
 * A request's body, refused once it passes `limit` bytes, as it arrives: a huge body is
 * never held in memory. For the routes anyone can reach before signing in.
 */
export async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const tooLarge = () => new StorageUserError("That request is too large.", 413);
  if (Number(request.headers.get("content-length") ?? Number.NaN) > limit) throw tooLarge();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A JSON body of at most `limit` bytes. A body that isn't JSON throws a SyntaxError. */
export async function readJson<T>(request: Request, limit = 16 * 1024): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await readBody(request, limit))) as T;
}

/** readBody/readJson refused a body for being over its limit. */
export const tooLarge = (error: unknown) => error instanceof StorageUserError && error.status === 413;

/** A form (URL-encoded or multipart) of at most `limit` bytes. */
export async function readForm(request: Request, limit = 16 * 1024): Promise<FormData> {
  const body = new Uint8Array(await readBody(request, limit));
  return new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
}

/**
 * Defence in depth on top of the SameSite=Strict cookie: refuse state-changing
 * requests whose Origin isn't this host.
 */
export function crossOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get("host");
  } catch {
    return true;
  }
}

export function handle(error: unknown) {
  if (error instanceof StorageUserError) return fail(error.message, error.status);
  if (error instanceof VaultConfigError) return fail(error.message, 500);
  console.error("[api] unexpected error", error);
  return fail("Something went wrong on the server.", 500);
}

/** S3 keys: ≤1024 bytes, no leading slash, no "." / ".." segments. */
export function cleanPrefix(raw: string | null): string | null {
  const prefix = raw ?? "";
  if (prefix === "") return "";
  if (prefix.startsWith("/") || !prefix.endsWith("/") || Buffer.byteLength(prefix) > 1024) return null;
  if (prefix.split("/").slice(0, -1).some((part) => part === "" || part === "." || part === "..")) return null;
  return prefix;
}

/**
 * A custom S3 endpoint makes this server send requests wherever the user points it,
 * so take only plain http(s) origins, and never a cloud metadata address (egress.ts, which
 * also checks what each name resolves to when a connection is made).
 */
export function cleanEndpoint(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (forbiddenHost(url.hostname)) return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Each cloud names buckets slightly differently; these are the rules the services enforce. */
export function validBucketName(name: string, kind: "s3" | "azure" | "gcs" | "oci" = "s3"): boolean {
  switch (kind) {
    case "azure":
      return /^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/.test(name);
    case "gcs":
      return /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(name) && !name.includes("..");
    case "oci":
      return /^[A-Za-z0-9._-]{1,256}$/.test(name);
    default:
      return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) && !name.includes("..");
  }
}
