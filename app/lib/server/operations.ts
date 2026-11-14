import "server-only";
import { eachLimit, isTaken, type MetadataChange } from "./drivers/types";
import { StorageUserError, type StorageDriver } from "./drivers";

export type OperationItem = { key: string; kind: "file" | "folder" };
export type Operation =
  | { op: "delete"; items: OperationItem[] }
  | { op: "copy" | "move"; items: OperationItem[]; destination: string }
  | { op: "rename"; items: [OperationItem]; name: string }
  | { op: "metadata"; items: OperationItem[]; change: MetadataChange };

/** Objects one operation may touch. They run as background jobs, so this is generous. */
export const LIMITS = { delete: 100_000, transfer: 100_000 } as const;
/** Objects in flight at once within one operation. */
export const CONCURRENCY = 8;

const parentOf = (item: OperationItem) => {
  const trimmed = item.kind === "folder" ? item.key.replace(/\/$/, "") : item.key;
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? "" : trimmed.slice(0, cut + 1);
};
const nameOf = (item: OperationItem) => item.key.replace(/\/$/, "").split("/").pop() ?? "";

/** Each selected item and where it goes; `to` is absent for deletes. */
export type Prepared = {
  op: Operation["op"];
  pairs: { item: OperationItem; to?: string }[];
  /** Metadata edits: what changes on every file. */
  change?: MetadataChange;
};

/**
 * The quick checks, done before anything changes or any job starts: valid names, nothing
 * moved into itself, and nothing already at a destination — so the person asking sees
 * those problems straight away, in the dialog.
 */
export async function prepareOperation(driver: StorageDriver, operation: Operation): Promise<Prepared> {
  if (operation.op === "delete") return { op: "delete", pairs: operation.items.map((item) => ({ item })) };
  if (operation.op === "metadata") {
    if (!driver.setMetadata) throw new StorageUserError("This connection can't change object metadata.", 400);
    return { op: "metadata", pairs: operation.items.map((item) => ({ item })), change: operation.change };
  }

  const pairs: { item: OperationItem; to: string }[] = [];
  if (operation.op === "rename") {
    const [item] = operation.items;
    const name = operation.name;
    if (!name || name.includes("/") || name === "." || name === "..") throw new StorageUserError("Names can't be empty or contain “/”.", 400);
    const to = parentOf(item) + name + (item.kind === "folder" ? "/" : "");
    if (to !== item.key) pairs.push({ item, to });
  } else {
    const destination = operation.destination;
    for (const item of operation.items) {
      if (item.kind === "folder" && destination.startsWith(item.key)) {
        throw new StorageUserError(`Can't put “${nameOf(item)}” inside itself.`, 400);
      }
      if (parentOf(item) === destination && operation.op === "move") continue; // already there
      const to = destination + nameOf(item) + (item.kind === "folder" ? "/" : "");
      if (to === item.key) throw new StorageUserError(`“${nameOf(item)}” is already in that folder.`, 400);
      pairs.push({ item, to });
    }
  }

  // Never overwrite silently: refuse if anything is already at a destination.
  for (const { to } of pairs) {
    if (await isTaken(driver, to)) throw new StorageUserError(`Something named “${to.replace(/\/$/, "").split("/").pop()}” is already there.`, 409);
  }
  return { op: operation.op, pairs };
}

/** One unit of work: a key and, for copies and moves, where it goes. */
export type Step = { from: string; to?: string };

/**
 * Every key the operation touches: a file is itself; a folder is everything listed under
 * it (including its zero-byte marker) — or just itself on a driver with native folders.
 */
export async function planSteps(driver: StorageDriver, prepared: Prepared): Promise<Step[]> {
  const limit = prepared.op === "delete" ? LIMITS.delete : LIMITS.transfer;
  const steps: Step[] = [];
  for (const { item, to } of prepared.pairs) {
    let keys = item.kind === "file" || driver.nativeFolders ? [item.key] : (await driver.listKeys(item.key, limit + 1)).keys;
    // Metadata belongs to files: a folder's zero-byte marker has none worth changing.
    if (prepared.op === "metadata") keys = keys.filter((key) => !key.endsWith("/"));
    for (const key of keys) steps.push({ from: key, to: to === undefined ? undefined : to + key.slice(item.key.length) });
    if (steps.length > limit) {
      throw new StorageUserError(
        `That's more than ${limit.toLocaleString("en-US")} objects at once. Select less, or work folder by folder.`,
        413,
      );
    }
  }
  return steps;
}

export type Progress = { done: number; failed: string[]; total: number };

/**
 * Carries out planned steps, `CONCURRENCY` at a time. Deletes go out in batches of 1,000.
 * `onProgress` is called as work completes; `cancelled` is checked between steps.
 */
export async function executeSteps(
  driver: StorageDriver,
  op: Prepared["op"],
  steps: Step[],
  {
    onProgress,
    cancelled,
    change,
  }: { onProgress?: (progress: Progress) => void; cancelled?: () => boolean; change?: MetadataChange } = {},
): Promise<Progress> {
  const progress: Progress = { done: 0, failed: [], total: steps.length };
  if (op === "metadata") {
    await eachLimit(steps, CONCURRENCY, async (step) => {
      if (cancelled?.()) return;
      try {
        await driver.setMetadata!(step.from, change ?? {});
        progress.done += 1;
      } catch {
        progress.failed.push(step.from);
      }
      onProgress?.(progress);
    });
    return progress;
  }
  if (op === "delete") {
    for (let i = 0; i < steps.length; i += 1000) {
      if (cancelled?.()) break;
      const batch = steps.slice(i, i + 1000).map((step) => step.from);
      const { failed } = await driver.remove(batch);
      progress.done += batch.length - failed.length;
      progress.failed.push(...failed);
      onProgress?.(progress);
    }
    return progress;
  }

  const removeAfter = op !== "copy";
  await eachLimit(steps, CONCURRENCY, async (step) => {
    if (cancelled?.()) return;
    try {
      if (removeAfter && driver.rename) {
        await driver.rename(step.from, step.to!);
      } else {
        await driver.copy(step.from, step.to!);
        if (removeAfter) {
          const result = await driver.remove([step.from]);
          if (result.failed.length) throw new Error("delete failed");
        }
      }
      progress.done += 1;
    } catch {
      progress.failed.push(step.from);
    }
    onProgress?.(progress);
  });
  return progress;
}

/** All three steps at once: for tests and small callers that can wait. */
export async function runOperation(driver: StorageDriver, operation: Operation): Promise<{ done: number; failed: string[] }> {
  const prepared = await prepareOperation(driver, operation);
  const { done, failed } = await executeSteps(driver, prepared.op, await planSteps(driver, prepared), { change: prepared.change });
  return { done, failed };
}
