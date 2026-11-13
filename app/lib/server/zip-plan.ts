import "server-only";
import { randomBytes } from "node:crypto";
import { restoreDelay } from "../pricing";
import type { StoredConnection } from "./connections";
import { StorageUserError, type Listing, type StorageDriver } from "./drivers/types";
import { methodFor, type ZipEntry } from "./zip";

/**
 * What goes into a zip download, worked out before a byte is sent: folders expanded, sizes
 * and classes known, limits checked. The plan is kept briefly behind a ticket, so the
 * browser can fetch the archive itself as an ordinary download (with its own progress and
 * cancel button) rather than through a script.
 */

export const ZIP_MAX_FILES = 10_000;

/** JVINU_ZIP_MAX_GB: the most one archive may hold. 50 GB unless set. */
export function zipMaxBytes(): number {
  const gb = Number(process.env.JVINU_ZIP_MAX_GB);
  return (Number.isFinite(gb) && gb > 0 ? gb : 50) * 1024 ** 3;
}

export type ZipItem = { key: string; kind: "file" | "folder" };

export type ZipPlan = {
  connectionId: string;
  userId: string;
  /** The archive's file name, ".zip" included. */
  name: string;
  files: { key: string; path: string; size: number; modified: string | null; storageClass: string | null }[];
  bytes: number;
  /** Bytes per storage class, for the cost estimate. */
  byClass: { storageClass: string | null; bytes: number }[];
  /** Files in a class that must be restored before it can be read; left out unless they have been. */
  archived: number;
  /** What was chosen, and in which folder: for the connection's history. */
  items: string[];
  base: string;
};

/** No "." or ".." in the archive, no backslashes or control characters: nothing that unzips outside its folder. */
const cleanSegment = (segment: string) => (segment === "." || segment === ".." ? "_" : segment.replace(/[\\\u0000-\u001f]/g, "_"));
const cleanPath = (relative: string) => relative.split("/").filter(Boolean).map(cleanSegment).join("/");
export const archiveName = (raw: string) => `${cleanSegment(raw.replaceAll("/", "_").trim()).slice(0, 120) || "download"}.zip`;

const PAGE = 1000;
const INVENTORY_PAGES = Math.ceil(ZIP_MAX_FILES / PAGE) + 1;
const tooMany = () =>
  new StorageUserError(`That's more than ${ZIP_MAX_FILES.toLocaleString("en-US")} files for one zip. Download it folder by folder.`, 413);

const parentOf = (key: string) => key.slice(0, key.lastIndexOf("/") + 1);

/** One folder level's files, found by name: selected files are looked up in their folder's listing. */
async function findIn(driver: StorageDriver, parent: string, keys: Set<string>): Promise<Map<string, Listing["files"][number]>> {
  const found = new Map<string, Listing["files"][number]>();
  let token: string | undefined;
  for (let page = 0; page < 50 && found.size < keys.size; page++) {
    const listing = await driver.list(parent, token);
    for (const file of listing.files) if (keys.has(file.key)) found.set(file.key, file);
    token = listing.nextToken;
    if (!token) break;
  }
  return found;
}

export async function planZip(input: {
  connection: StoredConnection;
  driver: StorageDriver;
  userId: string;
  items: ZipItem[];
  /** The folder the items were chosen in ("" for the top): paths in the archive start below it. */
  base: string;
  name: string;
}): Promise<ZipPlan> {
  const { connection, driver, items, base } = input;
  if (!items.length) throw new StorageUserError("Choose something to download.", 400);
  if (items.length > ZIP_MAX_FILES) throw tooMany();
  if (base && !base.endsWith("/")) throw new StorageUserError("Invalid folder.", 400);
  for (const item of items) {
    if (!item.key.startsWith(base) || item.key === base || item.key.startsWith("/")) throw new StorageUserError("Invalid selection.", 400);
  }

  const files = new Map<string, Listing["files"][number]>();
  for (const folder of items.filter((item) => item.kind === "folder")) {
    const { files: inside, truncated } = await driver.inventory(folder.key.endsWith("/") ? folder.key : `${folder.key}/`, INVENTORY_PAGES);
    if (truncated) throw tooMany();
    for (const file of inside) files.set(file.key, file);
    if (files.size > ZIP_MAX_FILES) throw tooMany();
  }
  const byParent = new Map<string, Set<string>>();
  for (const item of items.filter((entry) => entry.kind === "file" && !files.has(entry.key))) {
    const parent = parentOf(item.key);
    byParent.set(parent, (byParent.get(parent) ?? new Set()).add(item.key));
  }
  for (const [parent, keys] of byParent) {
    const found = await findIn(driver, parent, keys);
    for (const key of keys) {
      const file = found.get(key);
      if (!file) throw new StorageUserError(`“${key.split("/").pop()}” isn't there any more. Refresh, then try again.`, 404);
      files.set(key, file);
    }
  }
  if (files.size > ZIP_MAX_FILES) throw tooMany();

  const planned = [...files.values()]
    .map((file) => ({ key: file.key, path: cleanPath(file.key.slice(base.length)), size: file.size, modified: file.lastModified, storageClass: file.storageClass }))
    .filter((file) => file.path)
    .sort((a, b) => a.path.localeCompare(b.path));
  const bytes = planned.reduce((sum, file) => sum + file.size, 0);
  if (bytes > zipMaxBytes()) {
    const gb = (value: number) => `${(value / 1024 ** 3).toLocaleString("en-US", { maximumFractionDigits: 1 })} GB`;
    throw new StorageUserError(`That's ${gb(bytes)}, more than the ${gb(zipMaxBytes())} this server allows in one zip (JVINU_ZIP_MAX_GB).`, 413);
  }
  const classes = new Map<string | null, number>();
  for (const file of planned) classes.set(file.storageClass, (classes.get(file.storageClass) ?? 0) + file.size);

  return {
    connectionId: connection.id,
    userId: input.userId,
    name: archiveName(input.name),
    files: planned,
    bytes,
    byClass: [...classes].map(([storageClass, total]) => ({ storageClass, bytes: total })),
    archived: planned.filter((file) => restoreDelay(connection.presetId, connection.endpoint, file.storageClass) !== null).length,
    items: items.map((item) => item.key),
    base,
  };
}

/** The archive's entries, each read from the cloud only when its turn comes. */
export function zipEntries(plan: ZipPlan, driver: StorageDriver): ZipEntry[] {
  return plan.files.map((file) => ({
    name: file.path,
    size: file.size,
    modified: file.modified ? new Date(file.modified) : new Date(),
    method: methodFor(file.path),
    open: async () => (await driver.read(file.key)).stream,
  }));
}

/* ---- Tickets: a plan, kept for a little while, for the person who made it ----------- */

const TICKET_MS = 15 * 60_000;
const tickets = new Map<string, { plan: ZipPlan; expires: number }>();

export function issueTicket(plan: ZipPlan): string {
  const now = Date.now();
  for (const [id, ticket] of tickets) if (ticket.expires < now) tickets.delete(id);
  if (tickets.size >= 500) tickets.delete(tickets.keys().next().value!);
  const id = randomBytes(18).toString("base64url");
  tickets.set(id, { plan, expires: now + TICKET_MS });
  return id;
}

/** The plan behind a ticket, if it's this person's, for this connection, and still fresh. */
export function redeemTicket(id: string, userId: string, connectionId: string): ZipPlan | null {
  const ticket = tickets.get(id);
  if (!ticket || ticket.expires < Date.now()) return null;
  return ticket.plan.userId === userId && ticket.plan.connectionId === connectionId ? ticket.plan : null;
}
