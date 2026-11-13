import "server-only";
import { db } from "./db";

/**
 * A note on a folder — "don't delete: the nightly export writes here" — kept by this
 * server, not in the bucket, and seen by everyone who opens the folder. Notes follow
 * folders that are moved or renamed here, and go with folders deleted here.
 */
export type FolderNote = { prefix: string; body: string; updatedBy: string; updatedAt: string };

export const NOTE_LIMIT = 4000;

type Row = { prefix: string; body: string; updated_by: string; updated_at: string };
const fromRow = (row: Row): FolderNote => ({ prefix: row.prefix, body: row.body, updatedBy: row.updated_by, updatedAt: row.updated_at });

export async function getNote(connectionId: string, prefix: string): Promise<FolderNote | null> {
  const row = await (await db()).get<Row>(`select prefix, body, updated_by, updated_at from folder_notes where connection_id = ? and prefix = ?`, [
    connectionId,
    prefix,
  ]);
  return row ? fromRow(row) : null;
}

/** Every note under a prefix (the folder itself included), for showing which subfolders carry one. */
export async function notesUnder(connectionId: string, prefix: string): Promise<FolderNote[]> {
  const rows = await (await db()).all<Row>(
    `select prefix, body, updated_by, updated_at from folder_notes where connection_id = ? and prefix like ? escape '\\' order by prefix limit 500`,
    [connectionId, `${escapeLike(prefix)}%`],
  );
  return rows.map(fromRow);
}

/** An empty body removes the note. */
export async function setNote(connectionId: string, prefix: string, body: string, by: string): Promise<FolderNote | null> {
  const database = await db();
  if (!body.trim()) {
    await database.run(`delete from folder_notes where connection_id = ? and prefix = ?`, [connectionId, prefix]);
    return null;
  }
  const now = new Date().toISOString();
  await database.run(
    `insert into folder_notes (connection_id, prefix, body, updated_by, updated_at) values (?, ?, ?, ?, ?)
     on conflict (connection_id, prefix) do update set body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [connectionId, prefix, body, by, now],
  );
  return { prefix, body, updatedBy: by, updatedAt: now };
}

const escapeLike = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

/** A folder was deleted: its notes, and those of folders inside it, go too. */
export async function forgetNotes(connectionId: string, folder: string): Promise<void> {
  await (await db()).run(`delete from folder_notes where connection_id = ? and prefix like ? escape '\\'`, [connectionId, `${escapeLike(folder)}%`]);
}

/** A folder moved or was renamed: its notes follow. */
export async function moveNotes(connectionId: string, from: string, to: string): Promise<void> {
  const database = await db();
  const rows = await database.all<{ prefix: string }>(`select prefix from folder_notes where connection_id = ? and prefix like ? escape '\\'`, [
    connectionId,
    `${escapeLike(from)}%`,
  ]);
  for (const { prefix } of rows) {
    const next = to + prefix.slice(from.length);
    await database.run(`delete from folder_notes where connection_id = ? and prefix = ?`, [connectionId, next]);
    await database.run(`update folder_notes set prefix = ? where connection_id = ? and prefix = ?`, [next, connectionId, prefix]);
  }
}

export async function forgetConnectionNotes(connectionId: string): Promise<void> {
  await (await db()).run(`delete from folder_notes where connection_id = ?`, [connectionId]);
}
