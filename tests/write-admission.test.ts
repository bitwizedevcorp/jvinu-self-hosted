import { describe, expect, it, vi } from "vitest";
import { memoryDriver } from "./memory-driver";

/** A stand-in managed limit: 100 bytes free. The real disk and plan limits are tested in their own files. */
const asked: { managed?: string; bytes: number }[] = [];
vi.mock("@/app/lib/server/bundled-storage", () => ({
  managedBlocks: async (connection: { managed?: string }, bytes = 0) => {
    asked.push({ managed: connection.managed, bytes });
    return bytes > 100 ? "That would fill My storage past 95%." : null;
  },
}));

const { admitWrite } = await import("@/app/lib/server/write-admission");

const plain = { id: "c1", name: "Photos", readOnly: false };
const managed = { id: "c2", name: "My storage", readOnly: false, managed: "bundled-storage" as const };

describe("write admission", () => {
  it("refuses any write to a read-only connection", async () => {
    for (const kind of ["upload", "delete", "metadata", "folder"] as const)
      expect(await admitWrite({ connection: { ...plain, readOnly: true }, kind })).toMatchObject({ status: 403 });
  });

  it("stops writes that add data at a managed connection's limit — new folders and share copies too", async () => {
    asked.length = 0;
    expect(await admitWrite({ connection: managed, kind: "upload", bytes: 500 })).toMatchObject({ status: 507 });
    expect(await admitWrite({ connection: managed, kind: "copy", bytes: 50 })).toBeNull();
    expect(await admitWrite({ connection: managed, kind: "folder" })).toBeNull();
    // Deleting, moving and renaming add nothing; an unmanaged connection has no limit to ask.
    expect(await admitWrite({ connection: managed, kind: "delete", bytes: 500 })).toBeNull();
    expect(await admitWrite({ connection: plain, kind: "upload", bytes: 500 })).toBeNull();
    expect(asked).toEqual([
      { managed: "bundled-storage", bytes: 500 },
      { managed: "bundled-storage", bytes: 50 },
      { managed: "bundled-storage", bytes: 0 },
    ]);
  });

  it("names every data-lake table a write touches, in one refusal, until acknowledged", async () => {
    const driver = memoryDriver({
      "sales/_delta_log/00000000000000000000.json": '{"commitInfo":{}}\n',
      "sales/part-0.parquet": "x",
      "notes/readme.md": "hi",
    });
    const into = await admitWrite({ connection: plain, kind: "upload", tables: { driver, items: [], destination: "sales/", acknowledged: false } });
    expect(into).toMatchObject({ status: 409, code: "lake-table" });
    expect(into?.tables?.length).toBeGreaterThan(0);
    const away = await admitWrite({
      connection: plain,
      kind: "delete",
      tables: { driver, items: [{ key: "sales/part-0.parquet", kind: "file" }], acknowledged: false },
    });
    expect(away).toMatchObject({ status: 409, code: "lake-table" });
    expect(await admitWrite({ connection: plain, kind: "upload", tables: { driver, items: [], destination: "sales/", acknowledged: true } })).toBeNull();
    expect(await admitWrite({ connection: plain, kind: "upload", tables: { driver, items: [], destination: "notes/", acknowledged: false } })).toBeNull();
  });
});
