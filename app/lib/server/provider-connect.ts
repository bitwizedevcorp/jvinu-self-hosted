import "server-only";
import { PROVIDER_KINDS, PROVIDERS, type ProviderKind } from "../providers";
import type { Credentials } from "./connections";
import { dropboxAccount, dropboxFolder, exchangeDropboxCode } from "./drivers/dropbox";
import { driveFolder, exchangeDriveCode, googleDriveAccount } from "./drivers/gdrive";
import { oneDriveAccount, oneDriveFolder, oneDriveTenant, redeemOneDriveSignIn } from "./drivers/onedrive";
import { StorageUserError } from "./drivers/types";
import { driveRedirectUri } from "./gdrive-sign-in";
import { cleanEndpoint, validBucketName } from "./http";
import { openSignIn } from "./onedrive-sign-in";
import { isS3Compatible, S3_COMPATIBLE, type S3CompatibleId } from "./s3-compatible";

/**
 * The server's half of a provider: from the connect form to credentials that are ready to
 * verify. `prepareConnection` does every cheap check (provider, place, endpoint, the shape of
 * each credential); `completeSignIn` then trades a one-time sign-in for a lasting token, for
 * the providers that sign in (Dropbox, Google Drive, OneDrive). The facts the page shares
 * with the server are in app/lib/providers.ts; building a driver is in drivers/index.ts.
 */
const isKind = (value: unknown): value is ProviderKind => (PROVIDER_KINDS as readonly unknown[]).includes(value);

const str = (value: unknown, max = 512) => (typeof value === "string" ? value.trim().slice(0, max) : "");

type Built =
  | {
      credentials: Credentials;
      region: string;
      endpoint?: string;
      /** Dropbox, Google Drive: the one-time code to trade for a refresh token once the cheap checks pass. */
      link?: { code: string; verifier: string };
      /** OneDrive: the sealed device sign-in to redeem once the cheap checks pass. */
      signIn?: string;
    }
  | { error: string };

/** Wasabi, R2, B2, Spaces, Scaleway, Storj, MinIO: S3 credentials, an endpoint built from validated parts. */
function buildS3Compatible(id: S3CompatibleId, body: Record<string, unknown>): Built {
  const spec = S3_COMPATIBLE[id];
  const parts = {
    accountId: str(body.accountId, 64),
    jurisdiction: str(body.jurisdiction, 16),
    region: str(body.region, 32),
    endpoint: str(body.endpoint, 512),
  };
  const located = spec.locate(parts);
  if ("error" in located) return located;
  const accessKeyId = str(body.accessKeyId, 128);
  const secretAccessKey = str(body.secretAccessKey, 256);
  if (!spec.accessKey.test(accessKeyId)) return { error: spec.accessKeyMessage };
  if (secretAccessKey.length < (spec.secretMin ?? 20) || /\s/.test(secretAccessKey)) return { error: "That doesn't look like a secret key." };
  return { credentials: { kind: "s3", accessKeyId, secretAccessKey }, region: located.region, endpoint: located.endpoint };
}

/** Turn the form for one cloud into credentials, or say exactly what's wrong. */
function buildCredentials(kind: ProviderKind, body: Record<string, unknown>, endpoint: string | undefined): Built {
  switch (kind) {
    case "s3": {
      const accessKeyId = str(body.accessKeyId, 128);
      const secretAccessKey = str(body.secretAccessKey, 256);
      const region = str(body.region, 32) || "us-east-1";
      if (!/^[a-z0-9-]{2,32}$/.test(region)) return { error: "That isn't a valid region name." };
      if (endpoint) {
        // Emulators accept any keys (Floci and LocalStack use "test"/"test").
        if (!accessKeyId || /\s/.test(accessKeyId)) return { error: "Enter the access key the service expects." };
        if (!secretAccessKey) return { error: "Enter the secret key." };
      } else {
        if (!/^[A-Z0-9]{16,128}$/.test(accessKeyId)) return { error: "That doesn't look like an AWS access key ID." };
        if (secretAccessKey.length < 16) return { error: "That doesn't look like an AWS secret access key." };
      }
      return { credentials: { kind: "s3", accessKeyId, secretAccessKey }, region };
    }

    case "azure": {
      const accountName = str(body.accountName, 64);
      const accountKey = str(body.accountKey, 256);
      if (!/^[a-z0-9]{3,24}$/.test(accountName))
        return { error: "Storage account names are 3–24 lowercase letters and digits." };
      if (!/^[A-Za-z0-9+/=]{20,}$/.test(accountKey)) return { error: "That doesn't look like an Azure account key." };
      return { credentials: { kind: "azure", accountName, accountKey }, region: "" };
    }

    case "gcs": {
      const projectId = str(body.projectId, 128) || undefined;
      const raw = str(body.serviceAccountKey, 8192);
      if (!raw) {
        if (!endpoint) return { error: "Paste a service-account key (JSON) to reach Google Cloud Storage." };
        return { credentials: { kind: "gcs", projectId }, region: "" };
      }
      let key: { client_email?: string; private_key?: string; project_id?: string };
      try {
        key = JSON.parse(raw);
      } catch {
        return { error: "The service-account key isn't valid JSON." };
      }
      if (!key.client_email || !key.private_key?.includes("PRIVATE KEY"))
        return { error: "That JSON isn't a service-account key — it needs client_email and private_key." };
      // Keep only what signing needs; drop the rest of the key file.
      return {
        credentials: {
          kind: "gcs",
          projectId: projectId ?? key.project_id,
          clientEmail: key.client_email,
          privateKey: key.private_key,
        },
        region: "",
      };
    }

    case "oci": {
      const namespace = str(body.namespace, 64);
      const region = str(body.region, 64);
      const tenancy = str(body.tenancy, 256);
      const user = str(body.user, 256);
      const fingerprint = str(body.fingerprint, 128);
      const privateKey = typeof body.privateKey === "string" ? body.privateKey.trim().slice(0, 8192) : "";
      const passphrase = str(body.passphrase, 256) || undefined;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) return { error: "Enter the Object Storage namespace." };
      if (!/^[a-z0-9-]{2,64}$/.test(region)) return { error: "Enter a region such as us-ashburn-1." };
      if (!tenancy) return { error: "Enter the tenancy OCID." };
      if (!user) return { error: "Enter the user OCID." };
      if (!fingerprint) return { error: "Enter the API key fingerprint." };
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey))
        return { error: "Paste the API private key as PEM, including the BEGIN/END lines." };
      return { credentials: { kind: "oci", namespace, tenancy, user, fingerprint, privateKey, passphrase }, region };
    }

    case "dropbox": {
      const appKey = str(body.appKey, 64);
      const code = str(body.code, 512);
      const verifier = str(body.codeVerifier, 128);
      if (!/^[a-z0-9]{8,32}$/i.test(appKey)) return { error: "That doesn't look like a Dropbox app key." };
      if (!/^[A-Za-z0-9_.~-]{43,128}$/.test(verifier)) return { error: "Click “Allow access on Dropbox” first, then paste the code it shows." };
      if (!/^[A-Za-z0-9_.~-]{8,512}$/.test(code)) return { error: "Paste the access code Dropbox showed you." };
      return { credentials: { kind: "dropbox", appKey, refreshToken: "" }, region: "", link: { code, verifier } };
    }

    case "gdrive": {
      const clientId = str(body.clientId, 256);
      const clientSecret = str(body.clientSecret, 256);
      const code = str(body.code, 1024);
      const verifier = str(body.codeVerifier, 128);
      if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId))
        return { error: "The client ID ends in .apps.googleusercontent.com — copy it from the OAuth client in Google Cloud." };
      if (!/^[\x21-\x7e]{8,256}$/.test(clientSecret)) return { error: "Paste the client secret of that OAuth client." };
      if (!/^[A-Za-z0-9_.~-]{43,128}$/.test(verifier)) return { error: "Click “Sign in with Google” first, then paste the code it shows." };
      if (!/^[A-Za-z0-9_/.~-]{8,1024}$/.test(code)) return { error: "Paste the code jvinu showed after you signed in with Google." };
      return { credentials: { kind: "gdrive", clientId, clientSecret, refreshToken: "" }, region: "", link: { code, verifier } };
    }

    case "onedrive": {
      const clientId = str(body.clientId, 64);
      const tenant = oneDriveTenant(str(body.tenant, 128));
      const signIn = str(body.signIn, 8192);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))
        return { error: "The application (client) ID is a GUID, like 11111111-2222-3333-4444-555555555555." };
      if (!tenant) return { error: "The tenant is “common”, “consumers”, “organizations”, or a tenant ID or domain." };
      if (!signIn) return { error: "Click “Sign in with Microsoft” first, then enter the code it shows at Microsoft." };
      return { credentials: { kind: "onedrive", clientId, tenant, refreshToken: "" }, region: "", signIn };
    }
  }
}

/** How each folder-root provider writes its root path: "/" or "/Folder/Sub", or null if it can't be one. */
const FOLDER_ROOTS: Record<"dropbox" | "onedrive" | "gdrive", (raw: string) => string | null> = {
  dropbox: dropboxFolder,
  onedrive: oneDriveFolder,
  gdrive: driveFolder,
};

export type PreparedConnection = {
  presetId: ProviderKind | S3CompatibleId;
  /** Bucket; container on Azure; root folder ("/", "/Photos") on folder-root providers. */
  bucket: string;
  region: string;
  endpoint?: string;
  /** Without their lasting token until completeSignIn runs, for providers that sign in. */
  credentials: Credentials;
  link?: { code: string; verifier: string };
  signIn?: string;
};

/** The connect form, checked: what to connect to and with what — or what's wrong, in words. */
export function prepareConnection(body: Record<string, unknown>): PreparedConnection | { error: string } {
  const kind = body.presetId;
  if (!isKind(kind) && !isS3Compatible(kind)) return { error: "That provider can't be connected yet." };
  const profile = PROVIDERS[kind];
  const folderRoot = profile.place === "folder";
  const bucket = folderRoot
    ? (FOLDER_ROOTS[kind as keyof typeof FOLDER_ROOTS](str(body.bucket, 1024)) ?? "")
    : str(body.bucket, 256);
  const endpoint = folderRoot ? undefined : cleanEndpoint(body.endpoint);

  if (folderRoot) {
    if (!bucket) return { error: `Enter a folder path such as /Photos, or / for the whole ${profile.service}.` };
  } else if (isS3Compatible(kind) ? !S3_COMPATIBLE[kind].bucket.test(bucket) : !validBucketName(bucket, kind as "s3" | "azure" | "gcs" | "oci"))
    return { error: `That isn't a valid ${profile.place} name.` };
  if (endpoint === null) return { error: "The endpoint must be an http(s) URL such as http://localhost:4566, and not a cloud metadata address." };

  // S3-compatible clouds ignore any endpoint the client sends; theirs is derived (MinIO's is
  // the one typed, checked the same way as a custom S3 endpoint).
  const built = isS3Compatible(kind) ? buildS3Compatible(kind, body) : buildCredentials(kind, body, endpoint);
  if ("error" in built) return built;
  return {
    presetId: kind,
    bucket,
    region: built.region,
    endpoint: isS3Compatible(kind) ? built.endpoint : endpoint,
    credentials: built.credentials,
    link: built.link,
    signIn: built.signIn,
  };
}

/**
 * Trades a one-time sign-in for the lasting token, and names the account. Does nothing for
 * providers that don't sign in. Throws a StorageUserError (400) when the sign-in can't be used.
 */
export async function completeSignIn(
  prepared: PreparedConnection,
  context: { userId: string; request: Request; readOnly: boolean },
): Promise<Credentials> {
  const credentials = prepared.credentials;
  if (prepared.link && credentials.kind === "dropbox") {
    const refreshToken = await exchangeDropboxCode(credentials.appKey, prepared.link.code, prepared.link.verifier);
    const account = await dropboxAccount({ appKey: credentials.appKey, refreshToken });
    return { ...credentials, refreshToken, account: account ?? undefined };
  }
  if (prepared.link && credentials.kind === "gdrive") {
    const { refreshToken, readOnlyAccess } = await exchangeDriveCode({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      code: prepared.link.code,
      verifier: prepared.link.verifier,
      redirectUri: driveRedirectUri(context.request),
    });
    // Granted read-only, it can only be a read-only connection: Google would refuse every change.
    if (readOnlyAccess && !context.readOnly)
      throw new StorageUserError("Google granted read-only access, but Read-only is off. Tick Read-only, or click “Sign in with Google” again with it off.", 400);
    const account = await googleDriveAccount({ ...credentials, refreshToken });
    return { ...credentials, refreshToken, ...(readOnlyAccess ? { readOnlyAccess: true } : {}), account: account ?? undefined };
  }
  if (prepared.signIn && credentials.kind === "onedrive") {
    const pending = openSignIn(prepared.signIn, context.userId);
    if (!pending || pending.clientId !== credentials.clientId || pending.tenant !== credentials.tenant)
      throw new StorageUserError("That Microsoft sign-in has expired, or the client ID or tenant changed since — click “Sign in with Microsoft” again.", 400);
    const refreshToken = await redeemOneDriveSignIn(credentials, pending.deviceCode);
    const account = await oneDriveAccount({ ...credentials, refreshToken });
    return { ...credentials, refreshToken, account: account ?? undefined };
  }
  return credentials;
}
