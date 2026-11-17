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
  type StoredConnection,
} from "@/app/lib/server/connections";
import { driverFor } from "@/app/lib/server/drivers";
import { checkEncryptedBucket, MIN_PASSPHRASE } from "@/app/lib/server/drivers/crypt";
import { dataKeyOf, deriveKey } from "@/app/lib/server/crypt";
import { fail, handle, readJson, tooLarge } from "@/app/lib/server/http";
import { completeSignIn, prepareConnection } from "@/app/lib/server/provider-connect";
import { PROVIDERS } from "@/app/lib/providers";

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

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 61) : "";
  if (!name || name.length > 60) return fail("Give the connection a name (up to 60 characters).", 400);
  const prepared = prepareConnection(body);
  if ("error" in prepared) return fail(prepared.error, 400);
  const { presetId: kind, bucket, endpoint: target } = prepared;
  // jvinu encryption. Passphrases are taken exactly as typed: rclone doesn't trim them either.
  const encrypt = body.encrypt === true;
  const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
  const salt = typeof body.passphraseSalt === "string" ? body.passphraseSalt : "";
  if (encrypt && !passphrase) return fail("Enter the passphrase to encrypt with.", 400);
  if (passphrase.length > 1024 || salt.length > 1024) return fail("That passphrase is too long.", 400);

  try {
    if ((await countConnections()) >= MAX_CONNECTIONS)
      return fail(`This server holds up to ${MAX_CONNECTIONS} connections. Disconnect one first.`, 400);
    if (await nameTaken(name)) return fail("A connection with that name already exists.", 409);

    const credentials = await completeSignIn(prepared, { userId: user.id, request, readOnly: body.readOnly === true });

    // Nothing is saved until the service confirms the credentials can list this bucket.
    const cloud = driverFor({ presetId: kind, bucket, region: prepared.region, endpoint: target, credentials });
    const verified = await cloud.verify();

    // The key is derived once, here; only it is kept (sealed), never the passphrase.
    let crypt: StoredConnection["crypt"];
    if (encrypt) {
      const key = await deriveKey(passphrase, salt || undefined);
      const place = PROVIDERS[kind].place;
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
      region: verified.region ?? prepared.region,
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
