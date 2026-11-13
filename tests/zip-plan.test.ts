/**
 * Planning a zip download: folders expanded, the 10,000-file and size limits refused with
 * a clear message, archive paths that can't escape their folder, and archived files counted.
 */
import { describe, expect, it } from "vitest";
import type { StoredConnection } from "../app/lib/server/connections";
import { StorageUserError, type Listing, type StorageDriver } from "../app/lib/server/drivers/types";
import { archiveName, planZip, zipDownload, ZIP_MAX_FILES } from "../app/lib/server/zip-plan";
import { SKIPPED_NOTE } from "../app/lib/server/zip";
import { memoryDriver } from "./memory-driver";

type File = Listing["files"][number];
const file = (key: string, size = 10, storageClass: string | null = "STANDARD"): File => ({ key, size, lastModified: "2026-10-01T00:00:00.000Z", etag: null, storageClass });

/** Just enough of a driver: a flat list of files, listed by folder level or inventoried by prefix. */
function bucketOf(files: File[]): StorageDriver {
  return {
    inventory: async (prefix: string, maxPages = 100) => {
      const inside = files.filter((entry) => entry.key.startsWith(prefix));
      return { files: inside.slice(0, maxPages * 1000), truncated: inside.length > maxPages * 1000 };
    },
    list: async (prefix: string) => ({
      folders: [],
      files: files.filter((entry) => entry.key.startsWith(prefix) && !entry.key.slice(prefix.length).includes("/")),
    }),
  } as unknown as StorageDriver;
}

const connection = { id: "c", presetId: "s3" } as StoredConnection;
const plan = (files: File[], items: { key: string; kind: "file" | "folder" }[], base = "", name = "photos") =>
  planZip({ connection, driver: bucketOf(files), userId: "u", items, base, name });

describe("zip plans", () => {
  it("expand folders and keep paths below the folder they were chosen in", async () => {
    const result = await plan(
      [file("photos/2024/a.jpg"), file("photos/2024/deep/b.jpg"), file("photos/c.txt"), file("other/x.txt")],
      [
        { key: "photos/2024/", kind: "folder" },
        { key: "photos/c.txt", kind: "file" },
      ],
      "photos/",
    );
    expect(result.files.map((entry) => entry.path)).toEqual(["2024/a.jpg", "2024/deep/b.jpg", "c.txt"]);
    expect(result.bytes).toBe(30);
    expect(result.name).toBe("photos.zip");
  });

  it("keep a size the listing couldn't give apart from a real empty file", async () => {
    const result = await plan(
      [{ ...file("docs/Plan.pdf"), size: 0, sizeUnknown: true }, { ...file("docs/empty.txt"), size: 0 }],
      [{ key: "docs/", kind: "folder" }],
    );
    expect(result.files.find((entry) => entry.path === "docs/Plan.pdf")?.sizeUnknown).toBe(true);
    expect(result.files.find((entry) => entry.path === "docs/empty.txt")?.sizeUnknown).toBeUndefined();
  });

  it("refuse more than 10,000 files", async () => {
    const many = Array.from({ length: ZIP_MAX_FILES + 1 }, (_, i) => file(`big/${i}.txt`, 1));
    await expect(plan(many, [{ key: "big/", kind: "folder" }])).rejects.toMatchObject({ status: 413, message: expect.stringContaining("10,000") });
  });

  it("refuse more than the configured size", async () => {
    process.env.JVINU_ZIP_MAX_GB = "1";
    try {
      await expect(plan([file("huge.mov", 2 * 1024 ** 3)], [{ key: "huge.mov", kind: "file" }])).rejects.toMatchObject({
        status: 413,
        message: expect.stringContaining("JVINU_ZIP_MAX_GB"),
      });
    } finally {
      delete process.env.JVINU_ZIP_MAX_GB;
    }
  });

  it("never write paths that unzip outside their folder", async () => {
    const result = await plan([file("x/../../etc/passwd"), file("x/a\\b.txt"), file("x/./ok.txt")], [{ key: "x/", kind: "folder" }]);
    expect(result.files.map((entry) => entry.path).sort()).toEqual(["x/_/_/etc/passwd", "x/_/ok.txt", "x/a_b.txt"]);
    expect(archiveName("../../evil\u0000name")).toBe(".._.._evil_name.zip");
  });

  it("count files that need restoring first, and refuse ones that are gone", async () => {
    const result = await plan([file("a.jpg"), file("cold.tar", 10, "DEEP_ARCHIVE")], [
      { key: "a.jpg", kind: "file" },
      { key: "cold.tar", kind: "file" },
    ]);
    expect(result.archived).toBe(1);
    expect(result.byClass).toEqual(expect.arrayContaining([{ storageClass: "DEEP_ARCHIVE", bytes: 10 }]));
    await expect(plan([file("a.jpg")], [{ key: "gone.jpg", kind: "file" }])).rejects.toBeInstanceOf(StorageUserError);
  });

  it("refuse selections from outside the folder they claim", async () => {
    await expect(plan([file("a/b.txt")], [{ key: "a/b.txt", kind: "file" }], "elsewhere/")).rejects.toMatchObject({ status: 400 });
  });
});

/** From plan to bytes, as the route serves it. */
describe("zip downloads", () => {
  const collect = async (stream: ReadableStream<Uint8Array>) => Buffer.from(await new Response(stream).arrayBuffer());
  const jpeg = new Uint8Array(4_000).fill(7);

  it("promise their exact length when every size is known and nothing is compressed", async () => {
    const driver = memoryDriver({ "pics/a.jpg": jpeg, "pics/b.jpg": jpeg.slice(0, 1_000) });
    const plan = await planZip({ connection, driver, userId: "u", items: [{ key: "pics/", kind: "folder" }], base: "", name: "pics" });
    const { stream, length } = zipDownload(plan, driver);
    expect(length).not.toBeNull();
    expect((await collect(stream)).length).toBe(length);
  });

  it("promise no length when a size is only known once read, and still send it whole", async () => {
    const pdf = new Uint8Array(3_000).fill(9);
    const driver = memoryDriver({ "docs/Plan.pdf": pdf });
    // A Google document: listed with no size, exported on reading.
    const listed = { ...driver, inventory: async () => ({ files: [{ key: "docs/Plan.pdf", size: 0, sizeUnknown: true, lastModified: null, etag: null, storageClass: null }], truncated: false }) };
    const plan = await planZip({ connection, driver: listed, userId: "u", items: [{ key: "docs/", kind: "folder" }], base: "", name: "docs" });
    const { stream, length } = zipDownload(plan, driver);
    expect(length).toBeNull();
    const bytes = await collect(stream);
    expect(bytes.includes(Buffer.from(pdf))).toBe(true);
  });

  it("leave out a file deleted since the plan, and say so — unless a length was promised", async () => {
    // Text is compressed, so no length is promised: the gone file is named in a note.
    const notes = memoryDriver({ "notes/a.txt": "hello", "notes/gone.txt": "bye" });
    const notesPlan = await planZip({ connection, driver: notes, userId: "u", items: [{ key: "notes/", kind: "folder" }], base: "", name: "notes" });
    notes.files.delete("notes/gone.txt");
    const loose = zipDownload(notesPlan, notes);
    expect(loose.length).toBeNull();
    expect((await collect(loose.stream)).includes(Buffer.from(SKIPPED_NOTE))).toBe(true);

    // Photos are stored as they are, so a length was promised: the download fails instead.
    const pics = memoryDriver({ "pics/a.jpg": jpeg, "pics/gone.jpg": jpeg });
    const picsPlan = await planZip({ connection, driver: pics, userId: "u", items: [{ key: "pics/", kind: "folder" }], base: "", name: "pics" });
    pics.files.delete("pics/gone.jpg");
    const exact = zipDownload(picsPlan, pics);
    expect(exact.length).not.toBeNull();
    await expect(collect(exact.stream)).rejects.toThrow();
  });
});
