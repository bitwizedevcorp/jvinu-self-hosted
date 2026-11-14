import "server-only";
import type { TableChange } from "../data-types";
import { managedBlocks } from "./bundled-storage";
import type { StoredConnection } from "./connections";
import { tablesTouched } from "./data/lake";
import type { StorageDriver } from "./drivers/types";

/**
 * May this write happen here? One answer for every way something is written to a
 * connection — uploads, operations, transfers in, SQL exports, new folders, share copies —
 * so none of them can skip a rule:
 *
 * 1. a read-only connection takes nothing;
 * 2. a write that adds data stops at the managed connection's limit (the disk for bundled
 *    storage, the quota for a paid storage plan);
 * 3. a write into, or out of, a data-lake table waits until the person has seen what breaks
 *    (unless they already have): every table it touches, in one refusal.
 *
 * Name clashes are each caller's own (drivers/types.ts `isTaken`): what counts as taken
 * depends on what's being written.
 */
export type WriteKind = "upload" | "copy" | "move" | "rename" | "delete" | "metadata" | "folder";

export type WriteRefusal = { status: number; error: string; code?: "lake-table"; tables?: TableChange[] };

/** Writes that add data, and so count against a managed connection's limit. */
const ADDS_DATA = new Set<WriteKind>(["upload", "copy", "folder"]);

/** What tablesTouched calls each kind of write. */
const TABLE_OP: Partial<Record<WriteKind, "delete" | "move" | "copy" | "upload">> = {
  upload: "upload",
  copy: "copy",
  move: "move",
  rename: "move",
  delete: "delete",
};

export async function admitWrite(input: {
  /** Where the write lands. */
  connection: Pick<StoredConnection, "id" | "name" | "readOnly" | "managed">;
  kind: WriteKind;
  /** Bytes it adds, when known. */
  bytes?: number;
  /** Checks data-lake tables: the driver for `connection`, the chosen items, and where they land. */
  tables?: {
    driver: StorageDriver;
    items: { key: string; kind: "file" | "folder" }[];
    destination?: string;
    acknowledged: boolean;
  };
}): Promise<WriteRefusal | null> {
  const { connection, kind } = input;
  if (connection.readOnly)
    return { status: 403, error: `“${connection.name}” is read-only. Turn that off in its settings to make changes there.` };

  if (connection.managed && ADDS_DATA.has(kind)) {
    const blocked = await managedBlocks(connection, input.bytes ?? 0);
    if (blocked) return { status: 507, error: blocked };
  }

  const op = TABLE_OP[kind];
  if (input.tables && op && !input.tables.acknowledged) {
    const { driver, items, destination } = input.tables;
    const tables = await tablesTouched(driver, connection.id, op, items, destination);
    if (tables.length) return { status: 409, error: tables.map((change) => change.message).join(" "), code: "lake-table", tables };
  }
  return null;
}

/** A refusal as the response every route sends. */
export function refusalResponse(refusal: WriteRefusal): Response {
  const { status, ...body } = refusal;
  return Response.json(body, { status });
}
