/**
 * A connection's history: entries newest first, runs of the same thing folded into one
 * line, a folder's view that includes what was moved or copied into it, pages that never
 * split a run, the outcome of the jobs behind an entry, and the retention limit.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.JVINU_DATA_DIR = mkdtempSync(path.join(tmpdir(), "jvinu-activity-"));
  process.env.JVINU_SECRET = "activity-test-secret-0123456789abcdef012345678";
  delete process.env.JVINU_DATABASE_URL;
});

afterEach(() => {
  vi.useRealTimers();
});

const activity = () => import("../app/lib/server/activity");
const ana = { id: "ana", name: "Ana Pop" };
const ben = { id: "ben", name: "Ben Ionescu" };

/** At a given time: only Date is faked, so the database keeps working. */
function at(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

describe("folders", () => {
  it("name where a key is", async () => {
    const { folderOf, commonFolder } = await activity();
    expect(folderOf("a/b/c.txt")).toBe("a/b/");
    expect(folderOf("a/b/")).toBe("a/");
    expect(folderOf("c.txt")).toBe("");
    expect(commonFolder(["a/b/c.txt", "a/b/d/", "a/b/d/e.txt"])).toBe("a/b/");
    expect(commonFolder(["a/b/c.txt", "a/x/y.txt"])).toBe("a/");
    expect(commonFolder(["a/b.txt", "c.txt"])).toBe("");
    expect(commonFolder([])).toBe("");
  });
});

describe("history", () => {
  it("lists newest first and folds runs of the same thing into one line", async () => {
    const { actorOf, listActivity, recordActivity } = await activity();
    const connectionId = randomUUID();
    at("2026-10-12T09:00:00Z");
    await recordActivity({ connectionId, actor: actorOf(ana), action: "folder-created", target: "photos/" });
    for (const [minute, name] of [
      ["01", "a.jpg"],
      ["05", "b.jpg"],
      ["12", "c.jpg"],
    ]) {
      at(`2026-10-12T09:${minute}:00Z`);
      await recordActivity({ connectionId, actor: actorOf(ana), action: "uploaded", target: `photos/${name}`, size: 100 });
    }
    // Someone else, then a long pause: both start new lines.
    at("2026-10-12T09:13:00Z");
    await recordActivity({ connectionId, actor: actorOf(ben), action: "uploaded", target: "photos/d.jpg", size: 5 });
    at("2026-10-12T10:00:00Z");
    await recordActivity({ connectionId, actor: actorOf(ben), action: "uploaded", target: "photos/e.jpg", size: 7 });

    const page = await listActivity(connectionId, "ana");
    expect(page.next).toBeNull();
    expect(page.entries.map((entry) => [entry.action, entry.actor.name, entry.count])).toEqual([
      ["uploaded", "Ben Ionescu", 1],
      ["uploaded", "Ben Ionescu", 1],
      ["uploaded", "Ana Pop", 3],
      ["folder-created", "Ana Pop", 1],
    ]);
    const run = page.entries[2];
    expect(run.items).toEqual(["photos/c.jpg", "photos/b.jpg", "photos/a.jpg"]);
    expect(run.size).toBe(300);
    expect(run.folder).toBe("photos/");
    expect([run.since, run.at]).toEqual(["2026-10-12T09:01:00.000Z", "2026-10-12T09:12:00.000Z"]);
    expect(run.actor.you).toBe(true);
    expect(page.entries[0].actor.you).toBe(false);
  });

  it("keeps the first keys of a big operation and counts the rest", async () => {
    const { actorOf, listActivity, recordActivity } = await activity();
    const connectionId = randomUUID();
    const items = Array.from({ length: 30 }, (_, i) => `logs/${i}.txt`);
    await recordActivity({ connectionId, actor: actorOf(ana), action: "deleted", items });
    const [entry] = (await listActivity(connectionId, "ana")).entries;
    expect(entry.count).toBe(30);
    expect(entry.items).toHaveLength(20);
    expect(entry.folder).toBe("logs/");
    expect(entry.detail).toEqual({});
  });

  it("shows a folder what happened in it, below it, or was put there", async () => {
    const { actorOf, listActivity, recordActivity } = await activity();
    const connectionId = randomUUID();
    const actor = actorOf(ana);
    await recordActivity({ connectionId, actor, action: "uploaded", target: "docs/a.pdf" });
    await recordActivity({ connectionId, actor, action: "uploaded", target: "docs/2026/b.pdf" });
    await recordActivity({ connectionId, actor, action: "moved", items: ["inbox/c.pdf"], destination: "docs/" });
    await recordActivity({ connectionId, actor, action: "folder-created", target: "docs/" });
    await recordActivity({ connectionId, actor, action: "uploaded", target: "docsx/d.pdf" });
    await recordActivity({ connectionId, actor, action: "uploaded", target: "other/e.pdf" });
    // An emoji is one character to SQL but two to JavaScript: the match must still be exact.
    await recordActivity({ connectionId, actor, action: "uploaded", target: "📁/f.pdf" });

    const docs = await listActivity(connectionId, "ana", { prefix: "docs/" });
    expect(docs.entries.map((entry) => entry.target)).toEqual(["docs/", "inbox/c.pdf", "docs/2026/b.pdf", "docs/a.pdf"]);
    const emoji = await listActivity(connectionId, "ana", { prefix: "📁/" });
    expect(emoji.entries.map((entry) => entry.target)).toEqual(["📁/f.pdf"]);
    expect((await listActivity(connectionId, "ana")).entries).toHaveLength(7);
  });

  it("pages through older entries without splitting a run", async () => {
    const { actorOf, listActivity, parseCursor, recordActivity } = await activity();
    const connectionId = randomUUID();
    const actor = actorOf(ana);
    await recordActivity({ connectionId, actor, action: "shared", target: "a.txt" });
    for (const name of ["1", "2", "3", "4"]) await recordActivity({ connectionId, actor, action: "uploaded", target: `up/${name}` });
    await recordActivity({ connectionId, actor, action: "shared", target: "b.txt" });
    await recordActivity({ connectionId, actor, action: "shared", target: "c.txt" });

    const seen: string[] = [];
    let before: { at: string; id: string } | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await listActivity(connectionId, "ana", { before, limit: 2 });
      seen.push(...result.entries.map((entry) => `${entry.action}:${entry.count}`));
      if (!result.next) break;
      before = parseCursor(result.next);
      expect(before).not.toBeNull();
    }
    expect(seen).toEqual(["shared:1", "shared:1", "uploaded:4", "shared:1"]);
    expect(parseCursor("nonsense")).toBeNull();
    expect(parseCursor("2026-10-12T09:00:00.000Z|x' or 1=1")).toBeNull();
  });

  it("reports how the jobs behind an entry went", async () => {
    const { actorOf, listActivity, recordActivity } = await activity();
    const { db } = await import("../app/lib/server/db");
    const connectionId = randomUUID();
    const database = await db();
    const now = new Date().toISOString();
    const job = async (status: string, total: number, done: number) => {
      const id = randomUUID();
      await database.run(
        `insert into jobs (id, user_id, connection_id, op, label, status, total, done, failed, error, created_at, updated_at)
         values (?, 'ana', ?, 'delete', 'Deleting', ?, ?, ?, '[]', null, ?, ?)`,
        [id, connectionId, status, total, done, now, now],
      );
      return id;
    };
    await recordActivity({ connectionId, actor: actorOf(ana), action: "copied", items: ["a.txt"], destination: "b/", jobId: await job("done", 10, 8) });
    // Marked running, but no process is running it: a restart cut it off.
    await recordActivity({ connectionId, actor: actorOf(ben), action: "deleted", items: ["x/"], jobId: await job("running", 4, 1) });

    const [interrupted, partial] = (await listActivity(connectionId, "ana")).entries;
    expect(partial.job).toEqual({ status: "done", done: 8, total: 10, failed: 2, error: null });
    expect(interrupted.job?.status).toBe("interrupted");
    expect(interrupted.job?.failed).toBe(0);
  });

  it("puts settings changes into words", async () => {
    const { settingsChanges } = await activity();
    expect(
      settingsChanges(
        { pricePerGb: 0.02, settings: { egressPerGb: 0.01, publicBaseUrl: "https://cdn.example.com" } },
        { pricePerGb: null, settings: { providerEncryption: true, shareTarget: { prefix: "shared/" } } },
      ),
    ).toEqual([
      "went back to list prices for storage",
      "went back to list prices for downloads",
      "removed the public URL",
      "turned on encryption at rest",
      "made this the share bucket, under shared/",
    ]);
    expect(settingsChanges({ settings: {} }, { settings: {} })).toEqual([]);
    expect(settingsChanges({ pricePerGb: 0.02 }, { pricePerGb: 0.025 })).toEqual(["set the storage rate to $0.025 per GB-month"]);
  });

  it("forgets a disconnected connection, and drops entries past the retention limit", async () => {
    const { actorOf, forgetConnectionActivity, KEEP_DAYS, listActivity, recordActivity } = await activity();
    const kept = randomUUID();
    const gone = randomUUID();
    const since = (await listActivity(kept, "ana")).recordingSince;
    await recordActivity({ connectionId: gone, actor: actorOf(ana), action: "uploaded", target: "a.txt" });
    await forgetConnectionActivity(gone);
    expect((await listActivity(gone, "ana")).entries).toEqual([]);

    at(new Date(Date.now() - (KEEP_DAYS + 1) * 86_400_000).toISOString());
    await recordActivity({ connectionId: kept, actor: actorOf(ana), action: "uploaded", target: "old.txt" });
    vi.useRealTimers();
    // Pruning runs at most once an hour; an hour on, the next entry triggers it.
    at(new Date(Date.now() + 2 * 3600_000).toISOString());
    await recordActivity({ connectionId: kept, actor: actorOf(ana), action: "uploaded", target: "new.txt" });
    const page = await listActivity(kept, "ana");
    expect(page.entries.map((entry) => entry.target)).toEqual(["new.txt"]);
    // When recording started stays put: it isn't an entry, and isn't pruned.
    expect(page.recordingSince).toBe(since);
  });
});
