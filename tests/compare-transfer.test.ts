import { describe, expect, it } from "vitest";
import { compareFolders } from "../app/lib/server/compare";
import { pairsFor, planTransfer, runTransfer } from "../app/lib/server/transfer";
import { memoryDriver } from "./memory-driver";

const noop = () => {};

describe("comparing folders", () => {
  it("finds what's missing on each side and what differs", async () => {
    const live = memoryDriver({
      "site/index.html": "<p>v2</p>",
      "site/app.css": "a{}",
      "site/new.js": "1",
      "site/img/": "",
    });
    const backup = memoryDriver({
      "backups/site/index.html": "<p>v1!</p>",
      "backups/site/app.css": "a{}",
      "backups/site/old.js": "0",
    });
    const result = await compareFolders({ driver: live, prefix: "site/" }, { driver: backup, prefix: "backups/site/" });
    expect(result.onlyLeft.map((entry) => entry.path)).toEqual(["new.js"]);
    expect(result.onlyRight.map((entry) => entry.path)).toEqual(["old.js"]);
    expect(result.different.map((diff) => [diff.path, diff.reason])).toEqual([["index.html", "size"]]);
    expect(result.counts).toEqual({ onlyLeft: 1, onlyRight: 1, different: 1, same: 1 });
  });

  it("uses checksums only where both sides have a comparable one", async () => {
    const a = memoryDriver({ "x.txt": "aaaa" });
    const b = memoryDriver({ "x.txt": "bbbb" });
    // Same size: without checksums, they count as the same.
    expect((await compareFolders({ driver: a, prefix: "" }, { driver: b, prefix: "" })).counts.same).toBe(1);
    const withEtag = (driver: ReturnType<typeof memoryDriver>, etag: string) => {
      const inventory = driver.inventory.bind(driver);
      driver.inventory = async (prefix, pages) => {
        const out = await inventory(prefix, pages);
        return { ...out, files: out.files.map((file) => ({ ...file, etag })) };
      };
    };
    withEtag(a, '"74b87337454200d4d33f80c4663dc5e5"');
    withEtag(b, '"0e7e6d1f0dd8b8b0d3a8f3d0b0b7f5c1"');
    const checked = await compareFolders({ driver: a, prefix: "" }, { driver: b, prefix: "" });
    expect(checked.different.map((diff) => diff.reason)).toEqual(["checksum"]);
    const encrypted = await compareFolders({ driver: a, prefix: "", encrypted: true }, { driver: b, prefix: "" });
    expect(encrypted.counts.same).toBe(1);
  });
});

describe("copying between connections", () => {
  it("copies files and folders across, keeping structure and types", async () => {
    const source = memoryDriver({ "photos/2024/a.jpg": "A", "photos/2024/b.jpg": "BB", "photos/": "", "notes.txt": "n" });
    const target = memoryDriver({ "archive/": "" });
    const pairs = await planTransfer(
      source,
      target,
      [
        { key: "photos/", kind: "folder" },
        { key: "notes.txt", kind: "file" },
      ],
      "archive/",
    );
    const reports: number[] = [];
    const { failed } = await runTransfer(source, target, pairs, (done) => reports.push(done), () => false);
    expect(failed).toEqual([]);
    expect([...target.files.keys()].sort()).toEqual(["archive/", "archive/notes.txt", "archive/photos/", "archive/photos/2024/a.jpg", "archive/photos/2024/b.jpg"]);
    expect(new TextDecoder().decode(target.files.get("archive/photos/2024/b.jpg"))).toBe("BB");
    expect(reports.at(-1)).toBe(pairs.length);
  });

  it("never overwrites when copying a selection", async () => {
    const source = memoryDriver({ "a.txt": "new" });
    const target = memoryDriver({ "dest/a.txt": "old" });
    await expect(planTransfer(source, target, [{ key: "a.txt", kind: "file" }], "dest/")).rejects.toThrow(/already there/);
  });

  it("syncs a comparison's paths from one folder to the other, replacing what differs", async () => {
    const source = memoryDriver({ "live/a.txt": "new", "live/sub/b.txt": "b" });
    const target = memoryDriver({ "backup/a.txt": "old" });
    await runTransfer(source, target, pairsFor(["a.txt", "sub/b.txt"], "live/", "backup/"), noop, () => false);
    expect(new TextDecoder().decode(target.files.get("backup/a.txt"))).toBe("new");
    expect(target.files.has("backup/sub/b.txt")).toBe(true);
  });

  it("reports files it couldn't copy, and stops when cancelled", async () => {
    const source = memoryDriver({ "a.txt": "1", "b.txt": "2" });
    const target = memoryDriver();
    source.files.delete("b.txt");
    const { failed } = await runTransfer(source, target, pairsFor(["a.txt", "b.txt"], "", "x/"), noop, () => false);
    expect(failed).toEqual(["b.txt"]);
    const none = memoryDriver();
    await runTransfer(source, none, pairsFor(["a.txt"], "", ""), noop, () => true);
    expect(none.files.size).toBe(0);
  });
});
