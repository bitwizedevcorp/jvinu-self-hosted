import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { openWith, sealWith } from "./crypto";
import { db } from "./db";
import { hashPassword } from "./passwords";

/**
 * Share links this app issues and serves: /s/<token>. A link can expire, stop after a
 * number of downloads, ask for a password, and be revoked. Tokens are random; the
 * database looks them up by hash.
 */

/** What the owner and the recipient's page show, captured when the link is made. */
export type ShareMeta = { name: string; size: number | null; etag?: string | null };

export type ShareState = "active" | "expired" | "used-up" | "revoked";

export type ShareLink = {
  id: string;
  connectionId: string;
  key: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloads: number;
  hasPassword: boolean;
  revokedAt: string | null;
  lastDownloadAt: string | null;
  /** Served from a copy in the share bucket rather than the original. */
  copyId: string | null;
  meta: ShareMeta;
};

type Row = {
  id: string;
  token_hash: string;
  token_sealed: string;
  connection_id: string;
  item_key: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  max_downloads: number | string | null;
  download_count: number | string;
  password_hash: string | null;
  revoked_at: string | null;
  last_download_at: string | null;
  copy_id: string | null;
  meta: string;
};

const TOKEN_PURPOSE = "share-link-token";
/** Tokens are 24 random bytes, base64url: 32 characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function fromRow(row: Row): ShareLink {
  let meta: ShareMeta;
  try {
    meta = JSON.parse(row.meta) as ShareMeta;
  } catch {
    meta = { name: row.item_key.split("/").pop() ?? row.item_key, size: null };
  }
  return {
    id: row.id,
    connectionId: row.connection_id,
    key: row.item_key,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxDownloads: row.max_downloads === null ? null : Number(row.max_downloads),
    downloads: Number(row.download_count),
    hasPassword: Boolean(row.password_hash),
    revokedAt: row.revoked_at,
    lastDownloadAt: row.last_download_at,
    copyId: row.copy_id,
    meta,
  };
}

/** The token again, for its owner to copy; null if it can't be opened (JVINU_SECRET changed). */
function tokenOf(row: Row): string | null {
  try {
    return openWith<string>(TOKEN_PURPOSE, row.token_sealed, row.id);
  } catch {
    return null;
  }
}

export function stateOf(link: Pick<ShareLink, "revokedAt" | "expiresAt" | "maxDownloads" | "downloads">, now = Date.now()): ShareState {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && Date.parse(link.expiresAt) <= now) return "expired";
  if (link.maxDownloads !== null && link.downloads >= link.maxDownloads) return "used-up";
  return "active";
}

/** When a link stopped working, or null while it still works. */
export function endedAt(link: ShareLink, now = Date.now()): string | null {
  switch (stateOf(link, now)) {
    case "active":
      return null;
    case "revoked":
      return link.revokedAt;
    case "expired":
      return link.expiresAt;
    case "used-up":
      return link.lastDownloadAt ?? link.createdAt;
  }
}

/* ---- Passwords: scrypt with a random salt, in passwords.ts ------------------------- */

export { hashPassword, passwordMatches } from "./passwords";

/* ---- Links ---------------------------------------------------------------------- */

export async function createShareLink(input: {
  connectionId: string;
  key: string;
  createdBy: string;
  expiresAt: string | null;
  maxDownloads: number | null;
  password?: string;
  copyId?: string | null;
  meta: ShareMeta;
}): Promise<{ link: ShareLink; token: string }> {
  const id = randomBytes(9).toString("base64url");
  const token = randomBytes(24).toString("base64url");
  const row: Row = {
    id,
    token_hash: hashToken(token),
    token_sealed: sealWith(TOKEN_PURPOSE, token, id),
    connection_id: input.connectionId,
    item_key: input.key,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
    expires_at: input.expiresAt,
    max_downloads: input.maxDownloads,
    download_count: 0,
    password_hash: input.password ? await hashPassword(input.password) : null,
    revoked_at: null,
    last_download_at: null,
    copy_id: input.copyId ?? null,
    meta: JSON.stringify(input.meta),
  };
  await (await db()).run(
    `insert into share_links (id, token_hash, token_sealed, connection_id, item_key, created_by, created_at, expires_at,
       max_downloads, download_count, password_hash, revoked_at, last_download_at, copy_id, meta)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.token_hash,
      row.token_sealed,
      row.connection_id,
      row.item_key,
      row.created_by,
      row.created_at,
      row.expires_at,
      row.max_downloads,
      row.download_count,
      row.password_hash,
      row.revoked_at,
      row.last_download_at,
      row.copy_id,
      row.meta,
    ],
  );
  return { link: fromRow(row), token };
}

export async function findShareByToken(token: string): Promise<{ link: ShareLink; passwordHash: string | null } | undefined> {
  if (!TOKEN_PATTERN.test(token)) return undefined;
  const row = await (await db()).get<Row>(`select * from share_links where token_hash = ?`, [hashToken(token)]);
  return row ? { link: fromRow(row), passwordHash: row.password_hash } : undefined;
}

export async function getShareLink(id: string): Promise<{ link: ShareLink; token: string | null } | undefined> {
  const row = await (await db()).get<Row>(`select * from share_links where id = ?`, [id]);
  return row ? { link: fromRow(row), token: tokenOf(row) } : undefined;
}

/** One person's links, newest first. */
export async function listShareLinks(createdBy: string): Promise<{ link: ShareLink; token: string | null }[]> {
  const rows = await (await db()).all<Row>(`select * from share_links where created_by = ? order by created_at desc`, [createdBy]);
  return rows.map((row) => ({ link: fromRow(row), token: tokenOf(row) }));
}

/** Every link to `copyId`, for deciding whether a share-bucket copy is still needed. */
export async function linksForCopy(copyId: string): Promise<ShareLink[]> {
  return (await (await db()).all<Row>(`select * from share_links where copy_id = ?`, [copyId])).map(fromRow);
}

/** Turns a link off for good. Only its creator may; already-ended links stay as they ended. */
export async function revokeShareLink(id: string, createdBy: string): Promise<ShareLink | undefined> {
  const database = await db();
  await database.run(`update share_links set revoked_at = ? where id = ? and created_by = ? and revoked_at is null`, [
    new Date().toISOString(),
    id,
    createdBy,
  ]);
  const row = await database.get<Row>(`select * from share_links where id = ? and created_by = ?`, [id, createdBy]);
  return row ? fromRow(row) : undefined;
}

/**
 * Counts one download, but only if the link still works at `now` — checked and counted
 * in one statement, so two downloads racing for the last slot can't both get it.
 */
export async function claimDownload(id: string, now = new Date()): Promise<boolean> {
  const at = now.toISOString();
  const changed = await (await db()).run(
    `update share_links set download_count = download_count + 1, last_download_at = ?
      where id = ? and revoked_at is null
        and (expires_at is null or expires_at > ?)
        and (max_downloads is null or download_count < max_downloads)`,
    [at, id, at],
  );
  return changed === 1;
}

/** Links that ended more than `keepDays` ago are deleted; returns them (their copies may go too). */
export async function purgeEndedLinks(keepDays = 30, now = Date.now()): Promise<ShareLink[]> {
  const database = await db();
  const cutoff = now - keepDays * 24 * 3600_000;
  const candidates = (
    await database.all<Row>(
      `select * from share_links where revoked_at is not null or expires_at is not null or max_downloads is not null`,
    )
  ).map(fromRow);
  const old = candidates.filter((link) => {
    const ended = endedAt(link, now);
    return ended !== null && Date.parse(ended) < cutoff;
  });
  for (const link of old) await database.run(`delete from share_links where id = ?`, [link.id]);
  return old;
}

/** The connection is gone: so are its links. */
export async function forgetConnectionLinks(connectionId: string): Promise<void> {
  await (await db()).run(`delete from share_links where connection_id = ?`, [connectionId]);
}

/* ---- What the owner's browser sees ------------------------------------------------ */

export type ShareLinkView = {
  id: string;
  connectionId: string;
  key: string;
  name: string;
  size: number | null;
  createdAt: string;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloads: number;
  hasPassword: boolean;
  revokedAt: string | null;
  lastDownloadAt: string | null;
  state: ShareState;
  /** "/s/<token>"; null if the token can't be opened any more. */
  path: string | null;
  /** The full link when JVINU_PUBLIC_URL says where this server is reached; else the page adds its origin. */
  url: string | null;
  /** Served from a copy in the share bucket: which connection, and whether the copy is there yet. */
  copy: { connectionId: string; status: "copying" | "ready" | "failed" } | null;
};

/** Where the server is reached from outside, if configured. */
function publicBase(): string | null {
  const raw = (process.env.JVINU_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/?#]+/i.test(raw) ? raw : null;
}

export function shareView(
  link: ShareLink,
  token: string | null,
  copy: ShareLinkView["copy"] = null,
): ShareLinkView {
  const path = token ? `/s/${token}` : null;
  const base = publicBase();
  return {
    id: link.id,
    connectionId: link.connectionId,
    key: link.key,
    name: link.meta.name,
    size: link.meta.size,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    maxDownloads: link.maxDownloads,
    downloads: link.downloads,
    hasPassword: link.hasPassword,
    revokedAt: link.revokedAt,
    lastDownloadAt: link.lastDownloadAt,
    state: stateOf(link),
    path,
    url: path && base ? `${base}${path}` : null,
    copy,
  };
}
