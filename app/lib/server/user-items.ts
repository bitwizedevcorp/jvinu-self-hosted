import "server-only";
import { db } from "./db";

/**
 * What each user keeps track of: starred objects, links they've shared, and files they
 * opened recently. Stored per user, with enough about each object (name, size, date) to
 * show it without listing its folder first.
 */
export const ITEM_KINDS = ["star", "shared", "recent", "team"] as const;

/**
 * Team pins belong to everyone: they're stored once, under this owner, and every signed-in
 * person sees and edits the same list.
 */
export const TEAM = "__team__";
const ownerOf = (userId: string, kind: ItemKind) => (kind === "team" ? TEAM : userId);
export type ItemKind = (typeof ITEM_KINDS)[number];

export type ItemMeta = {
  kind: "file" | "folder";
  size?: number | null;
  lastModified?: string | null;
  storageClass?: string | null;
  etag?: string | null;
  /** Shared links: when the link stops working (absent for links served through the app). */
  expiresAt?: string | null;
  /** Team pins: who pinned it. */
  by?: string | null;
};

export type UserItem = { kind: ItemKind; connectionId: string; key: string; meta: ItemMeta; at: string };

const RECENT_LIMIT = 50;

type Row = { kind: ItemKind; connection_id: string; item_key: string; meta: string; at: string };

export async function listItems(userId: string): Promise<UserItem[]> {
  const database = await db();
  // Expired share links have nothing left to show.
  await database.run(`delete from user_items where user_id = ? and kind = 'shared' and meta like '%"expiresAt":"%' and at < ?`, [
    userId,
    new Date(Date.now() - 8 * 24 * 3600_000).toISOString(),
  ]);
  const rows = await database.all<Row>(
    `select kind, connection_id, item_key, meta, at from user_items
     where user_id = ? or (user_id = ? and kind = 'team') order by at desc`,
    [userId, TEAM],
  );
  const now = new Date().toISOString();
  return rows
    .map((row) => ({ kind: row.kind, connectionId: row.connection_id, key: row.item_key, meta: JSON.parse(row.meta) as ItemMeta, at: row.at }))
    .filter((item) => item.kind !== "shared" || !item.meta.expiresAt || item.meta.expiresAt > now);
}

export async function saveItem(userId: string, kind: ItemKind, connectionId: string, key: string, meta: ItemMeta): Promise<void> {
  const database = await db();
  await database.run(
    `insert into user_items (user_id, kind, connection_id, item_key, meta, at) values (?, ?, ?, ?, ?, ?)
     on conflict (user_id, kind, connection_id, item_key) do update set meta = excluded.meta, at = excluded.at`,
    [ownerOf(userId, kind), kind, connectionId, key, JSON.stringify(meta), new Date().toISOString()],
  );
  if (kind === "recent") {
    // Keep only the newest few.
    const stale = await database.all<{ connection_id: string; item_key: string }>(
      `select connection_id, item_key from user_items where user_id = ? and kind = 'recent' order by at desc limit 1000 offset ${RECENT_LIMIT}`,
      [userId],
    );
    for (const row of stale) {
      await database.run(`delete from user_items where user_id = ? and kind = 'recent' and connection_id = ? and item_key = ?`, [
        userId,
        row.connection_id,
        row.item_key,
      ]);
    }
  }
}

export async function removeItem(userId: string, kind: ItemKind, connectionId: string, key: string): Promise<void> {
  await (await db()).run(`delete from user_items where user_id = ? and kind = ? and connection_id = ? and item_key = ?`, [
    ownerOf(userId, kind),
    kind,
    connectionId,
    key,
  ]);
}

/** Folder keys end in "/": the folder itself and everything under it. */
const under = (key: string) => (key.endsWith("/") ? `${key.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : key);

/** Objects were deleted: forget them for every user. */
export async function forgetItems(connectionId: string, keys: string[]): Promise<void> {
  const database = await db();
  for (const key of keys) {
    await database.run(`delete from user_items where connection_id = ? and item_key like ? escape '\\'`, [connectionId, under(key)]);
  }
}

/** Objects moved or were renamed: follow them, for every user. */
export async function moveItems(connectionId: string, from: string, to: string): Promise<void> {
  const database = await db();
  const rows = await database.all<{ user_id: string; kind: string; item_key: string }>(
    `select user_id, kind, item_key from user_items where connection_id = ? and item_key like ? escape '\\'`,
    [connectionId, under(from)],
  );
  for (const row of rows) {
    const next = to + row.item_key.slice(from.length);
    // A row may already exist at the destination (starred twice): keep that one.
    await database.run(`delete from user_items where user_id = ? and kind = ? and connection_id = ? and item_key = ?`, [
      row.user_id,
      row.kind,
      connectionId,
      next,
    ]);
    await database.run(`update user_items set item_key = ? where user_id = ? and kind = ? and connection_id = ? and item_key = ?`, [
      next,
      row.user_id,
      row.kind,
      connectionId,
      row.item_key,
    ]);
  }
}

export async function forgetConnectionItems(connectionId: string): Promise<void> {
  await (await db()).run(`delete from user_items where connection_id = ?`, [connectionId]);
}
