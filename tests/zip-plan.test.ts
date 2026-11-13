/**
 * Planning a zip download: folders expanded, the 10,000-file and size limits refused with
 * a clear message, archive paths that can't escape their folder, and archived files counted.
 */
import { describe, expect, it } from "vitest";
import type { StoredConnection } from "../app/lib/server/connections";
import { StorageUserError, type Listing, type StorageDriver } from "../app/lib/server/drivers/types";
import { archiveName, planZip, ZIP_MAX_FILES } from "../app/lib/server/zip-plan";

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
