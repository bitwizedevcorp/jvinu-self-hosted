/**
 * The streaming zip writer, checked with the tools people unzip with (Python's zipfile,
 * Info-ZIP's unzip): names and folders survive, CRCs match, ZIP64 works past 4 GiB with
 * flat memory, cancelling stops the reads, and unreadable files are left out with a note.
 */
import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StorageUserError } from "../app/lib/server/drivers/types";
import { methodFor, SKIPPED_NOTE, zipLength, zipStream, type ZipEntry } from "../app/lib/server/zip";

const dir = mkdtempSync(path.join(tmpdir(), "jvinu-zip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const when = new Date("2026-03-04T05:06:08Z");

const streamOf = (bytes: Uint8Array, piece = 7_000) => {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + piece));
      offset += piece;
    },
  });
};
const entry = (name: string, bytes: Uint8Array): ZipEntry => ({
  name,
  size: bytes.length,
  modified: when,
  method: methodFor(name),
  open: async () => streamOf(bytes),
});
const pattern = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 31) % 251);
const collect = async (stream: ReadableStream<Uint8Array>) => Buffer.from(await new Response(stream).arrayBuffer());

/** What Python's zipfile finds in an archive: names, sizes, and whether every CRC checks out. */
function inspect(file: string, read: string[] = []) {
  const script = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
out = {"bad": z.testzip(), "entries": [[i.filename, i.file_size, i.compress_type, i.date_time] for i in z.infolist()], "read": {}}
for name in sys.argv[2:]:
    out["read"][name] = z.read(name).decode("utf-8", "replace")
print(json.dumps(out))`;
  return JSON.parse(execFileSync("python3", ["-c", script, file, ...read], { maxBuffer: 64 * 1024 * 1024 }).toString()) as {
    bad: string | null;
    entries: [string, number, number, number[]][];
    read: Record<string, string>;
  };
}

describe("zip archives", () => {
  it("open in standard tools, with folders and non-ASCII names intact", async () => {
    const photo = pattern(150_000);
    const entries: ZipEntry[] = [
      { name: "trip/", size: 0, modified: when, method: "store" },
      entry("trip/notes.txt", new TextEncoder().encode("hello from jvinu\n".repeat(400))),
      entry("trip/café 😀.jpg", photo),
      entry("日本語/ノート.md", new TextEncoder().encode("# 見出し\n")),
      entry("empty.txt", new Uint8Array(0)),
    ];
    const file = path.join(dir, "small.zip");
    writeFileSync(file, await collect(zipStream(entries)));

    const found = inspect(file, ["trip/notes.txt", "日本語/ノート.md"]);
    expect(found.bad).toBeNull();
    expect(found.entries.map(([name]) => name)).toEqual(["trip/", "trip/notes.txt", "trip/café 😀.jpg", "日本語/ノート.md", "empty.txt"]);
    // Text is deflated (8); a JPEG is stored as it is (0).
    expect(Object.fromEntries(found.entries.map(([name, , method]) => [name, method]))).toMatchObject({ "trip/notes.txt": 8, "trip/café 😀.jpg": 0 });
    expect(found.read["trip/notes.txt"]).toBe("hello from jvinu\n".repeat(400));
    expect(found.read["日本語/ノート.md"]).toBe("# 見出し\n");
    // Info-ZIP agrees, and the dates came through (stored as local time, like any zip tool).
    expect(execFileSync("unzip", ["-tq", file]).toString()).toMatch(/No errors detected/);
    expect(found.entries[1][3]).toEqual([when.getFullYear(), when.getMonth() + 1, when.getDate(), when.getHours(), when.getMinutes(), 8]);
  });

  it("know their exact length up front when nothing is compressed", async () => {
    const entries: ZipEntry[] = [
      { name: "media/", size: 0, modified: when, method: "store" },
      entry("media/a.jpg", pattern(70_000)),
      entry("media/b.mp4", pattern(123_456)),
    ];
    const bytes = await collect(zipStream(entries, { exactSizes: true }));
    expect(zipLength(entries)).toBe(bytes.length);
    expect(zipLength([...entries, entry("notes.txt", pattern(10))])).toBeNull();
  });

  it("switch to ZIP64 past 4 GiB, with flat memory", async () => {
    // 4.5 GiB of zeros, streamed in 1 MiB pieces and written as a sparse file.
    const zeros = new Uint8Array(1024 * 1024);
    const bigSize = 4.5 * 1024 ** 3;
    const big: ZipEntry = {
      name: "big/disk.img",
      size: bigSize,
      modified: when,
      method: "store",
      open: async () => {
        let sent = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= bigSize) return controller.close();
            sent += zeros.length;
            controller.enqueue(zeros);
          },
        });
      },
    };
    // Stored too, so the exact length is known: the entry's offset needs ZIP64 as well.
    const entries = [big, { ...entry("after.txt", new TextEncoder().encode("written past the 4 GiB mark")), method: "store" as const }];
    const file = path.join(dir, "big.zip");
    const fd = openSync(file, "w");
    let position = 0;
    const before = process.memoryUsage().rss;
    let peak = before;
    const reader = zipStream(entries, { exactSizes: true }).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== zeros) writeSync(fd, value, 0, value.length, position);
      position += value.length;
      if (position % (256 * 1024 * 1024) < value.length) peak = Math.max(peak, process.memoryUsage().rss);
    }
    ftruncateSync(fd, position);
    closeSync(fd);

    expect(position).toBe(zipLength(entries));
    expect(peak - before).toBeLessThan(150 * 1024 * 1024);
    const found = inspect(file, ["after.txt"]);
    expect(found.bad).toBeNull();
    expect(found.entries.map(([name, size]) => [name, size])).toEqual([
      ["big/disk.img", bigSize],
      ["after.txt", 27],
    ]);
    expect(found.read["after.txt"]).toBe("written past the 4 GiB mark");
    rmSync(file);
  }, 300_000);

  it("stop reading the moment the download is cancelled", async () => {
    let pulls = 0;
    let cancelledWith: unknown = "not cancelled";
    let laterOpened = false;
    const endless: ZipEntry = {
      name: "endless.bin",
      size: 10 * 1024 ** 3,
      modified: when,
      method: "store",
      open: async () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(64 * 1024));
          },
          cancel(reason) {
            cancelledWith = reason;
          },
        }),
    };
    const later: ZipEntry = { ...entry("later.txt", pattern(10)), open: async () => ((laterOpened = true), streamOf(pattern(10))) };
    const reader = zipStream([endless, later]).getReader();
    for (let i = 0; i < 5; i++) await reader.read();
    await reader.cancel("closed the tab");
    const pullsAtCancel = pulls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cancelledWith).toBe("closed the tab");
    expect(pulls).toBeLessThanOrEqual(pullsAtCancel + 1);
    expect(laterOpened).toBe(false);
  });

  it("leave out files that can't be read, and say which", async () => {
    const archived: ZipEntry = {
      ...entry("cold/old.tar", pattern(10)),
      open: async () => {
        throw new StorageUserError("That object is archived (Glacier): restore it first.", 409);
      },
    };
    const entries = [entry("fine.txt", new TextEncoder().encode("fine")), archived];
    const file = path.join(dir, "skipped.zip");
    const skippable = (error: unknown) => (error instanceof StorageUserError ? error.message : null);
    writeFileSync(file, await collect(zipStream(entries, { skippable })));
    const found = inspect(file, [SKIPPED_NOTE]);
    expect(found.bad).toBeNull();
    expect(found.entries.map(([name]) => name)).toEqual(["fine.txt", SKIPPED_NOTE]);
    expect(found.read[SKIPPED_NOTE]).toContain("cold/old.tar — That object is archived (Glacier): restore it first.");
    // Anything else still fails the archive rather than quietly dropping a file.
    const broken = { ...archived, open: async () => Promise.reject(new Error("socket hang up")) };
    await expect(collect(zipStream([broken], { skippable }))).rejects.toThrow("socket hang up");
  });

  it("promise no length when a size is only known once the file is read", async () => {
    // A Google document: listed with size 0, read as a whole PDF export.
    const pdf = pattern(5_000);
    const exported: ZipEntry = { ...entry("Plan.pdf", pdf), size: 0, sizeUnknown: true };
    expect(exported.method).toBe("store");
    expect(zipLength([entry("photo.jpg", pattern(300)), exported])).toBeNull();
    // Without a promised length nothing is held to the listed size, and the PDF arrives whole.
    const out = path.join(dir, "unknown-size.zip");
    writeFileSync(out, await collect(zipStream([exported], { exactSizes: false })));
    const found = inspect(out);
    expect(found.bad).toBeNull();
    expect(found.entries.map(([name, size]) => [name, size])).toEqual([["Plan.pdf", pdf.length]]);
  });

  it("fail rather than mislead when a file changes size under a promised length", async () => {
    const shrunk: ZipEntry = { ...entry("shrunk.jpg", pattern(100)), size: 200 };
    await expect(collect(zipStream([shrunk], { exactSizes: true }))).rejects.toThrow(/changed while it was being zipped/);
  });
});
