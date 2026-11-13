import { actorOf, recordActivity } from "@/app/lib/server/activity";
import { requireUser } from "@/app/lib/server/auth";
import { atRestEncryption } from "@/app/lib/connection-settings";
import { ensureBundledStorageWithin } from "@/app/lib/server/bundled-storage";
import { storeUrl, syncPlan } from "@/app/lib/server/storage-plan";
import {
  countConnections,
  importLegacy,
  insertConnection,
  listConnections,
  MAX_CONNECTIONS,
  nameTaken,
  newConnectionId,
  toPublic,
  type Credentials,
  type ProviderKind,
  type StoredConnection,
} from "@/app/lib/server/connections";
import { driverFor } from "@/app/lib/server/drivers";
import { checkEncryptedBucket, MIN_PASSPHRASE } from "@/app/lib/server/drivers/crypt";
import { dataKeyOf, deriveKey } from "@/app/lib/server/crypt";
import { dropboxAccount, dropboxFolder, exchangeDropboxCode } from "@/app/lib/server/drivers/dropbox";
import { oneDriveAccount, oneDriveFolder, oneDriveTenant, redeemOneDriveSignIn } from "@/app/lib/server/drivers/onedrive";
import { cleanEndpoint, fail, handle, validBucketName, readJson, tooLarge } from "@/app/lib/server/http";
import { openSignIn } from "@/app/lib/server/onedrive-sign-in";
import { isS3Compatible, S3_COMPATIBLE, type S3CompatibleId } from "@/app/lib/server/s3-compatible";

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  try {
    // Connections saved in this browser by earlier versions move into the database once.
    await importLegacy(user.id);
    // Bundled storage connects itself; on a first sign-in, give the bootstrap a moment.
    await ensureBundledStorageWithin(8_000);
    // A paid storage plan connects itself too; the seller being slow mustn't hold up the list.
    if (storeUrl()) await Promise.race([syncPlan().catch(() => null), new Promise((resolve) => setTimeout(resolve, 4_000))]);
    return Response.json({ connections: (await listConnections()).map(toPublic) });
  } catch (error) {
    return handle(error);
  }
}

const KINDS: ProviderKind[] = ["s3", "azure", "gcs", "oci", "dropbox", "onedrive"];
const isKind = (value: unknown): value is ProviderKind => KINDS.includes(value as ProviderKind);

const str = (value: unknown, max = 512) => (typeof value === "string" ? value.trim().slice(0, max) : "");

type Built =
  | {
      credentials: Credentials;
      region: string;
      endpoint?: string;
      /** Dropbox: the one-time code to trade for a refresh token once the cheap checks pass. */
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

export async function POST(request: Request) {
  const user = await requireUser(request, { mutating: true, admin: true });
  if (user instanceof Response) return user;

  let body: Record<string, unknown>;
  try {
    body = await readJson(request, 64 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return fail("Expected a JSON body.", 400);
  }

  const kind = body.presetId;
  if (!isKind(kind) && !isS3Compatible(kind)) return fail("That provider can't be connected yet.", 400);
  const name = str(body.name, 61);
  // On Dropbox and OneDrive the "bucket" is a folder path, normalised to "/" or "/Folder/Sub".
  const isFolderRoot = kind === "dropbox" || kind === "onedrive";
  const bucket =
    kind === "dropbox"
      ? (dropboxFolder(str(body.bucket, 1024)) ?? "")
      : kind === "onedrive"
        ? (oneDriveFolder(str(body.bucket, 1024)) ?? "")
        : str(body.bucket, 256);
  const endpoint = isFolderRoot ? undefined : cleanEndpoint(body.endpoint);

  if (!name || name.length > 60) return fail("Give the connection a name (up to 60 characters).", 400);
  if (isFolderRoot) {
    if (!bucket)
      return fail(`Enter a folder path such as /Photos, or / for the whole ${kind === "dropbox" ? "Dropbox" : "OneDrive"}.`, 400);
  } else if (isS3Compatible(kind) ? !S3_COMPATIBLE[kind].bucket.test(bucket) : !validBucketName(bucket, kind))
    return fail(kind === "azure" ? "That isn't a valid container name." : "That isn't a valid bucket name.", 400);
  if (endpoint === null)
    return fail("The endpoint must be an http(s) URL such as http://localhost:4566, and not a cloud metadata address.", 400);

  // jvinu encryption. Passphrases are taken exactly as typed: rclone doesn't trim them either.
  const encrypt = body.encrypt === true;
  const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
  const salt = typeof body.passphraseSalt === "string" ? body.passphraseSalt : "";
  if (encrypt && !passphrase) return fail("Enter the passphrase to encrypt with.", 400);
  if (passphrase.length > 1024 || salt.length > 1024) return fail("That passphrase is too long.", 400);

  // S3-compatible clouds ignore any endpoint the client sends; theirs is derived (MinIO's is
  // the one typed, checked the same way as a custom S3 endpoint).
  const built = isS3Compatible(kind) ? buildS3Compatible(kind, body) : buildCredentials(kind, body, endpoint);
  if ("error" in built) return fail(built.error, 400);
  const target = isS3Compatible(kind) ? built.endpoint : endpoint;

  try {
    if ((await countConnections()) >= MAX_CONNECTIONS)
      return fail(`This server holds up to ${MAX_CONNECTIONS} connections. Disconnect one first.`, 400);
    if (await nameTaken(name)) return fail("A connection with that name already exists.", 409);

    let credentials = built.credentials;
    if (built.link && credentials.kind === "dropbox") {
      const refreshToken = await exchangeDropboxCode(credentials.appKey, built.link.code, built.link.verifier);
      const account = await dropboxAccount({ appKey: credentials.appKey, refreshToken });
      credentials = { ...credentials, refreshToken, account: account ?? undefined };
    }
    if (built.signIn && credentials.kind === "onedrive") {
      const pending = openSignIn(built.signIn, user.id);
      if (!pending || pending.clientId !== credentials.clientId || pending.tenant !== credentials.tenant)
        return fail("That Microsoft sign-in has expired, or the client ID or tenant changed since — click “Sign in with Microsoft” again.", 400);
      const refreshToken = await redeemOneDriveSignIn(credentials, pending.deviceCode);
      const account = await oneDriveAccount({ ...credentials, refreshToken });
      credentials = { ...credentials, refreshToken, account: account ?? undefined };
    }

    // Nothing is saved until the service confirms the credentials can list this bucket.
    const cloud = driverFor({ presetId: kind, bucket, region: built.region, endpoint: target, credentials });
    const verified = await cloud.verify();

    // The key is derived once, here; only it is kept (sealed), never the passphrase.
    let crypt: StoredConnection["crypt"];
    if (encrypt) {
      const key = await deriveKey(passphrase, salt || undefined);
      const place = isFolderRoot ? "folder" : kind === "azure" ? "container" : "bucket";
      const { encryptedFiles } = await checkEncryptedBucket(cloud, dataKeyOf(key), place);
      if (!encryptedFiles && passphrase.length < MIN_PASSPHRASE)
        return fail(`Use a passphrase of at least ${MIN_PASSPHRASE} characters — a few unrelated words work well.`, 400);
      crypt = { key };
    }
    const connection: StoredConnection = {
      id: newConnectionId(),
      presetId: kind,
      name,
      bucket,
      // R2 reports no region; "auto" is what it signs with.
      region: verified.region ?? built.region,
      endpoint: target,
      credentials,
      readOnly: body.readOnly === true,
      // Encryption at rest, where the provider takes it as an option (S3, Backblaze).
      settings: body.providerEncryption === true && atRestEncryption(kind) === "optional" ? { providerEncryption: true } : {},
      crypt,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
    };
    await insertConnection(connection);
    await recordActivity({
      connectionId: connection.id,
      actor: actorOf(user),
      action: "connected",
      detail: { presetId: kind, bucket, encrypted: Boolean(crypt), readOnly: connection.readOnly },
    });
    return Response.json({ connection: toPublic(connection) }, { status: 201 });
  } catch (error) {
    return handle(error);
  }
}
