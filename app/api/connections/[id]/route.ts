import { actorOf, recordActivity, settingsChanges } from "@/app/lib/server/activity";
import { removeConnection } from "@/app/lib/server/connection-changes";
import {
  clearOtherShareTargets,
  getConnection,
  nameTaken,
  toPublic,
  updateConnection,
} from "@/app/lib/server/connections";
import { guardConnection } from "@/app/lib/server/guard";
import { handle, readJson } from "@/app/lib/server/http";
import { applySettingsPatch } from "@/app/lib/server/settings";
import { atRestEncryption, type ConnectionSettings } from "@/app/lib/connection-settings";

/** Rename a connection, flip its read-only flag, or set its own storage rate. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/connections/[id]">) {
  const guarded = await guardConnection(request, ctx.params, { mutating: true, admin: true });
  if (guarded instanceof Response) return guarded;
  try {
    const body = (await readJson(request, 64 * 1024)) as { name?: unknown; readOnly?: unknown; pricePerGb?: unknown; settings?: unknown };
    const patch: { name?: string; readOnly?: boolean; pricePerGb?: number | null; settings?: ConnectionSettings } = {};
    if (body.settings !== undefined) {
      const applied = applySettingsPatch(guarded.connection.settings ?? {}, body.settings);
      if ("error" in applied) return Response.json({ error: applied.error }, { status: 400 });
      if (applied.settings.providerEncryption && atRestEncryption(guarded.connection.presetId) !== "optional") {
        return Response.json({ error: "This provider doesn't offer encryption at rest as an option." }, { status: 400 });
      }
      // A CDN can only pass on what's stored, and here that's ciphertext.
      if (applied.settings.publicBaseUrl && guarded.connection.crypt) {
        return Response.json({ error: "Files on an encrypted connection can't be served from a public URL." }, { status: 400 });
      }
      patch.settings = applied.settings;
    }
    if (body.pricePerGb !== undefined) {
      const rate = body.pricePerGb;
      if (rate !== null && (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100))
        return Response.json({ error: "The rate is USD per GB-month, between 0 and 100 — or empty for list prices." }, { status: 400 });
      patch.pricePerGb = rate;
    }
    if (body.readOnly !== undefined) {
      if (typeof body.readOnly !== "boolean") return Response.json({ error: "readOnly must be true or false." }, { status: 400 });
      // Google granted only read access: switching it to read-write would just fail every write.
      const credentials = guarded.connection.credentials;
      if (body.readOnly === false && credentials.kind === "gdrive" && credentials.readOnlyAccess) {
        return Response.json(
          { error: "This Google Drive was connected with read-only access. Connect it again without Read-only to make changes." },
          { status: 400 },
        );
      }
      patch.readOnly = body.readOnly;
    }
    // The share bucket is written to (copies arrive there), so it can't be read-only.
    const sharesFromHere = Boolean((patch.settings ?? guarded.connection.settings)?.shareTarget);
    if (sharesFromHere && (patch.readOnly ?? guarded.connection.readOnly)) {
      return Response.json(
        {
          error: patch.settings?.shareTarget
            ? "A share bucket must accept writes: turn off read-only first."
            : "This is the share bucket. Stop sharing from here before making it read-only.",
        },
        { status: 400 },
      );
    }
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 60) return Response.json({ error: "Names are 1–60 characters." }, { status: 400 });
      if (await nameTaken(name, guarded.connection.id))
        return Response.json({ error: "A connection with that name already exists." }, { status: 409 });
      patch.name = name;
    }
    await updateConnection(guarded.connection.id, patch);
    if (patch.settings?.shareTarget) await clearOtherShareTargets(guarded.connection.id);
    const before = guarded.connection;
    const record = (action: "connection-renamed" | "read-only" | "settings", detail: Record<string, unknown>) =>
      recordActivity({ connectionId: before.id, actor: actorOf(guarded.user), action, detail });
    if (patch.name !== undefined && patch.name !== before.name) await record("connection-renamed", { from: before.name, to: patch.name });
    if (patch.readOnly !== undefined && patch.readOnly !== before.readOnly) await record("read-only", { on: patch.readOnly });
    const changes = settingsChanges(before, patch);
    if (changes.length) await record("settings", { changes });
    const updated = await getConnection(guarded.connection.id);
    return Response.json({ connection: updated ? toPublic(updated) : null });
  } catch (error) {
    return handle(error);
  }
}

/** Forget a connection. Nothing in the bucket changes. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/connections/[id]">) {
  const guarded = await guardConnection(request, ctx.params, { mutating: true, admin: true });
  if (guarded instanceof Response) return guarded;
  if (guarded.connection.managed) {
    return Response.json(
      {
        error:
          guarded.connection.managed === "cloud-storage"
            ? `“${guarded.connection.name}” is your storage plan. Cancel it under “Manage plan” in the account menu to remove it.`
            : `“${guarded.connection.name}” is managed by this server and can't be disconnected. Stop the storage profile to remove it.`,
      },
      { status: 403 },
    );
  }
  try {
    await removeConnection(guarded.connection.id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return handle(error);
  }
}
