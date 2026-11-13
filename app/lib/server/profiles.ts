import "server-only";
import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { db, dataDir } from "./db";
import { ADMIN_ID, MAX_NAME } from "./first-run";

/**
 * Each person's profile: the name and email they want shown, and an optional photo. Kept on
 * this server only. Photos are re-encoded to a 256 px WebP square under
 * JVINU_DATA_DIR/avatars, so nothing of the original file (EXIF, location) is kept.
 */
export const MAX_EMAIL = 254;
/** The largest photo accepted for upload. */
export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const SIZE = 256;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The file for a user's photo. The name is a hash, so any user id is a safe file name. */
export function avatarPath(userId: string): string {
  return path.join(dataDir(), "avatars", `${createHash("sha256").update(userId).digest("hex").slice(0, 32)}.webp`);
}

async function upsert(userId: string, fields: { name?: string | null; email?: string | null; avatar?: string | null }) {
  const database = await db();
  const now = new Date().toISOString();
  await database.run(`insert into user_profiles (user_id, updated_at) values (?, ?) on conflict (user_id) do nothing`, [userId, now]);
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  await database.run(`update user_profiles set ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? where user_id = ?`, [
    ...entries.map(([, value]) => value),
    now,
    userId,
  ]);
}

/** Names the history shows for things that aren't a person, which nobody may take. */
const RESERVED = ["system", "admin", "someone with the link", "demo visitor", "jvinu"];

/**
 * Whether a display name would pass for someone else in the history: another person's
 * profile name, the name another person signed in with, or a reserved one. Case, spaces
 * and look-alike width don't matter.
 */
async function nameUsedByOthers(userId: string, name: string): Promise<boolean> {
  const wanted = name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  // The admin-password account is "Admin" by default and may keep it.
  if (RESERVED.includes(wanted) && !(wanted === "admin" && userId === ADMIN_ID)) return true;
  const database = await db();
  const taken = await database.all<{ name: string }>(
    `select name from user_profiles where user_id <> ? and name is not null
     union select user_name as name from sessions where user_id <> ?`,
    [userId, userId],
  );
  return taken.some((row) => row.name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim() === wanted);
}

/** Checks and saves a name and email. An empty email clears it (sign-in's own is used again). */
export async function updateProfile(userId: string, raw: { name?: unknown; email?: unknown }): Promise<void> {
  const fields: { name?: string; email?: string | null } = {};
  if (raw.name !== undefined) {
    const name = typeof raw.name === "string" ? raw.name.trim().replace(/\s+/g, " ") : "";
    if (!name) throw new ProfileError("Enter a name.");
    if (name.length > MAX_NAME) throw new ProfileError(`Keep the name to ${MAX_NAME} characters.`);
    if (/[\u0000-\u001f\u007f]/.test(name)) throw new ProfileError("The name can't contain control characters.");
    if (await nameUsedByOthers(userId, name)) {
      throw new ProfileError("Someone else here already goes by that name, or it's one jvinu uses. Choose another.", 409);
    }
    fields.name = name;
  }
  if (raw.email !== undefined) {
    const email = typeof raw.email === "string" ? raw.email.trim() : "";
    if (email && (email.length > MAX_EMAIL || !EMAIL.test(email))) throw new ProfileError("Enter a valid email address, or leave it empty.");
    fields.email = email || null;
  }
  await upsert(userId, fields);
}

/** Re-encodes an uploaded image to the stored square and returns its version tag. */
export async function saveAvatar(userId: string, image: Uint8Array): Promise<string> {
  const sharp = (await import("sharp")).default;
  let webp: Buffer;
  try {
    webp = await sharp(image, { failOn: "error", limitInputPixels: 60_000_000, animated: false })
      .rotate() // honour the camera's orientation before the metadata is dropped
      .resize(SIZE, SIZE, { fit: "cover", position: "attention" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new ProfileError("That file isn't an image jvinu can read. Try a JPEG, PNG or WebP.", 415);
  }
  const file = avatarPath(userId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Written beside it, then renamed: a reader never sees half a file.
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, webp, { mode: 0o600 });
  await rename(temporary, file);
  const version = createHash("sha256").update(webp).digest("hex").slice(0, 12);
  await upsert(userId, { avatar: version });
  return version;
}

export async function removeAvatar(userId: string): Promise<void> {
  await unlink(avatarPath(userId)).catch(() => {});
  await upsert(userId, { avatar: null });
}
