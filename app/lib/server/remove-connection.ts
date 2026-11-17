import "server-only";
import { forgetConnectionActivity } from "./activity";
import { connectionChanged } from "./connection-changes";
import { deleteConnection } from "./connections";
import { forgetConnectionNotes } from "./notes";
import { forgetConnectionLinks } from "./shares";
import { forgetConnectionItems } from "./user-items";

/**
 * Disconnects: deletes the connection and everything this server keeps about it — starred
 * and recent items, notes, share links, its history, and remembered scans. False if it
 * wasn't there.
 */
export async function removeConnection(id: string): Promise<boolean> {
  const removed = await deleteConnection(id);
  await forgetConnectionItems(id);
  await forgetConnectionNotes(id);
  await forgetConnectionLinks(id);
  await forgetConnectionActivity(id);
  connectionChanged(id);
  return removed;
}
