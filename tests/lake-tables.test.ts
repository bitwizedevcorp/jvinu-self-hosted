/**
 * Delta, Iceberg and Hudi tables: found from their marker folders, summarised from their own
 * metadata (checked against what delta-rs and PyIceberg report), and protected from changes
 * that would break them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { literal, withDuck } from "../app/lib/server/data/duck";
import { enclosingTable, forgetTables, parseJson, tableAt, tableInfo, tablesTouched } from "../app/lib/server/data/lake";
import { loadFolder, memoryDriver, type MemoryDriver } from "./memory-driver";

const LAKE = path.join(__dirname, "fixtures", "lake");
const enc = (text: string) => new TextEncoder().encode(text);
const lines = (...actions: unknown[]) => enc(actions.map((a) => JSON.stringify(a)).join("\n"));

let work: string;
beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "jvinu-lake-test-"));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

let scopes = 0;
/** A fresh cache scope per driver: detections are cached per connection. */
const scope = () => `test-${++scopes}`;

function warehouse(): MemoryDriver {
  const driver = memoryDriver({ "warehouse/readme.txt": "not a table" });
  loadFolder(driver, path.join(LAKE, "delta-sales"), "warehouse/sales/");
  loadFolder(driver, path.join(LAKE, "iceberg-orders"), "warehouse/orders/");
  driver.files.set("warehouse/events/.hoodie/hoodie.properties", enc("hoodie.table.name=events\nhoodie.table.type=MERGE_ON_READ\nhoodie.table.version=6\nhoodie.table.partition.fields=day\n"));
  driver.files.set("warehouse/events/day=2024-01-01/a.parquet", enc("data"));
  return driver;
}

const META = {
  id: "t1",
  name: "built",
  schemaString: JSON.stringify({ type: "struct", fields: [{ name: "id", type: "long", nullable: false, metadata: {} }] }),
  partitionColumns: [],
  configuration: { "delta.columnMapping.mode": "name" },
  createdTime: 1_700_000_000_000,
  format: { provider: "parquet", options: {} },
};
const PROTOCOL = { minReaderVersion: 3, minWriterVersion: 7, readerFeatures: ["v2Checkpoint"], writerFeatures: ["v2Checkpoint"] };
const add = (file: string, size: number, records: number) => ({
  add: { path: file, partitionValues: {}, size, modificationTime: 0, dataChange: true, stats: JSON.stringify({ numRecords: records }) },
});

/** Delta actions written as a checkpoint Parquet file, the way engines write them. */
async function checkpointParquet(name: string, actions: unknown[]): Promise<Uint8Array> {
  const json = path.join(work, `${name}.ndjson`);
  const out = path.join(work, `${name}.parquet`);
  writeFileSync(json, actions.map((a) => JSON.stringify(a)).join("\n"));
  await withDuck((db) => db.run(`COPY (SELECT * FROM read_json(${literal(json)}, format='newline_delimited')) TO ${literal(out)} (FORMAT parquet)`));
  return new Uint8Array(readFileSync(out));
}

describe("finding tables", () => {
  it("knows a table's folder by its marker, and the table a folder sits in", async () => {
    const driver = warehouse();
    const s = scope();
    expect(await tableAt(driver, s, "warehouse/")).toBeNull();
    expect(await tableAt(driver, s, "warehouse/sales/")).toEqual({ root: "warehouse/sales/", format: "delta" });
    expect(await tableAt(driver, s, "warehouse/orders/")).toEqual({ root: "warehouse/orders/", format: "iceberg" });
    expect(await tableAt(driver, s, "warehouse/events/")).toEqual({ root: "warehouse/events/", format: "hudi" });
    expect(await enclosingTable(driver, s, "warehouse/sales/country=RO/")).toEqual({ root: "warehouse/sales/", format: "delta" });
    expect(await enclosingTable(driver, s, "warehouse/sales/_delta_log/")).toEqual({ root: "warehouse/sales/", format: "delta" });
    expect(await enclosingTable(driver, s, "warehouse/")).toBeNull();
  });

  it("caches what it found per connection, until told to forget", async () => {
    const driver = warehouse();
    const s = scope();
    await enclosingTable(driver, s, "warehouse/sales/country=RO/");
    const lists = driver.counters.lists;
    await enclosingTable(driver, s, "warehouse/sales/country=RO/");
    expect(driver.counters.lists).toBe(lists);
    forgetTables(s);
    await enclosingTable(driver, s, "warehouse/sales/country=RO/");
    expect(driver.counters.lists).toBeGreaterThan(lists);
  });

  it("notices Iceberg metadata beside a Delta log (UniForm)", async () => {
    const driver = warehouse();
    driver.files.set("warehouse/sales/metadata/00001-abc.metadata.json", enc("{}"));
    expect(await tableAt(driver, scope(), "warehouse/sales/")).toEqual({ root: "warehouse/sales/", format: "delta", alsoIceberg: true });
  });

  it("doesn't take any folder named metadata for an Iceberg table", async () => {
    const driver = memoryDriver({ "docs/metadata/notes.txt": "x" });
    expect(await tableAt(driver, scope(), "docs/")).toBeNull();
  });
});

describe("guarding changes", () => {
  it("flags deleting inside a table, the table itself, and a folder holding tables", async () => {
    const driver = warehouse();
    const changes = await tablesTouched(driver, scope(), "delete", [
      { key: "warehouse/sales/country=RO/", kind: "folder" },
      { key: "warehouse/orders/", kind: "folder" },
      { key: "warehouse/readme.txt", kind: "file" },
    ]);
    expect(changes.map((c) => [c.relation, c.table.root])).toEqual([
      ["inside", "warehouse/sales/"],
      ["root", "warehouse/orders/"],
    ]);
    expect(changes[0].message).toMatch(/inside the Delta table “warehouse\/sales”.*breaks the table/);

    const whole = await tablesTouched(driver, scope(), "delete", [{ key: "warehouse/", kind: "folder" }]);
    expect(whole.map((c) => [c.relation, c.table.root]).sort()).toEqual([
      ["contains", "warehouse/events/"],
      ["contains", "warehouse/orders/"],
      ["contains", "warehouse/sales/"],
    ]);
  });

  it("says why moving an Iceberg table breaks it", async () => {
    const [change] = await tablesTouched(warehouse(), scope(), "move", [{ key: "warehouse/orders/", kind: "folder" }], "archive/");
    expect(change.relation).toBe("root");
    expect(change.message).toMatch(/records full paths/);
  });

  it("flags copying or moving into a table, but not copying out of one", async () => {
    const driver = warehouse();
    const into = await tablesTouched(driver, scope(), "copy", [{ key: "warehouse/readme.txt", kind: "file" }], "warehouse/sales/country=DE/");
    expect(into.map((c) => c.relation)).toEqual(["into"]);
    expect(into[0].message).toMatch(/VACUUM may delete them/);
    const out = await tablesTouched(driver, scope(), "copy", [{ key: "warehouse/sales/country=RO/", kind: "folder" }], "backup/");
    expect(out).toEqual([]);
  });

  it("lets ordinary files through without a warning", async () => {
    const driver = memoryDriver({ "photos/a.jpg": "x", "photos/b.jpg": "y" });
    expect(await tablesTouched(driver, scope(), "delete", [{ key: "photos/", kind: "folder" }])).toEqual([]);
  });
});

describe("delta tables", () => {
  it("summarises a table from its checkpoint and the commits after it", async () => {
    const info = await tableInfo(warehouse(), { root: "warehouse/sales/", format: "delta" });
    // What delta-rs reports for the same log.
    expect(info).toMatchObject({ version: "14", files: 2, bytes: 30202, rows: 6700, name: "sales", description: "Daily sales" });
    expect(info.partitionColumns).toEqual(["country"]);
    expect(info.columns.map((c) => `${c.name}: ${c.type}`)).toEqual(["id: long", "country: string", "amount: double"]);
    expect(info.formatVersion).toBe("reader 1, writer 2");
    expect(info.history).toHaveLength(15);
    expect(info.history.slice(0, 3).map((h) => [h.version, h.operation])).toEqual([
      ["14", "OPTIMIZE"],
      ["13", "WRITE"],
      ["12", "DELETE"],
    ]);
    expect(info.history[2].summary).toBe("100 rows deleted · 2 files added · 2 files removed");
  });

  it("finds the checkpoint by listing when there's no _last_checkpoint", async () => {
    const driver = warehouse();
    driver.files.delete("warehouse/sales/_delta_log/_last_checkpoint");
    expect(await tableInfo(driver, { root: "warehouse/sales/", format: "delta" })).toMatchObject({ version: "14", files: 2, rows: 6700 });
  });

  it("replays a log without any checkpoint", async () => {
    const driver = memoryDriver({
      "t/_delta_log/00000000000000000000.json": lines({ protocol: { minReaderVersion: 1, minWriterVersion: 2 } }, { metaData: META }, add("a.parquet", 100, 10), add("b.parquet", 200, 20)),
      "t/_delta_log/00000000000000000001.json": lines({ commitInfo: { timestamp: 1, operation: "DELETE" } }, { remove: { path: "a.parquet" } }, add("c.parquet", 50, 5)),
    });
    const info = await tableInfo(driver, { root: "t/", format: "delta" });
    expect(info).toMatchObject({ version: "1", files: 2, bytes: 250, rows: 25 });
    expect(info.notes[0]).toMatch(/column mapping/);
  });

  it("reads a v2 checkpoint whose files are in sidecars", async () => {
    const sidecar = await checkpointParquet("sidecar", [add("a.parquet", 100, 10), add("b.parquet", 200, 20), add("c.parquet", 300, 30)]);
    const driver = memoryDriver({
      "t/_delta_log/_last_checkpoint": JSON.stringify({ version: 3, size: 6, v2Checkpoint: { path: "00000000000000000003.checkpoint.6a4f0e5c-1b2d-4c3e-9f80-123456789abc.json", sizeInBytes: 1, modificationTime: 0 } }),
      "t/_delta_log/00000000000000000003.checkpoint.6a4f0e5c-1b2d-4c3e-9f80-123456789abc.json": lines(
        { checkpointMetadata: { version: 3 } },
        { protocol: PROTOCOL },
        { metaData: META },
        { sidecar: { path: "0001-side.parquet", sizeInBytes: sidecar.length, modificationTime: 0 } },
      ),
      "t/_delta_log/_sidecars/0001-side.parquet": sidecar,
      "t/_delta_log/00000000000000000004.json": lines({ commitInfo: { timestamp: 2, operation: "DELETE" } }, { remove: { path: "b.parquet" } }),
    });
    const info = await tableInfo(driver, { root: "t/", format: "delta" });
    expect(info).toMatchObject({ version: "4", files: 2, bytes: 400, rows: 40 });
    expect(info.features).toEqual(["v2Checkpoint"]);
  });

  it("reads a checkpoint split into parts", async () => {
    const part1 = await checkpointParquet("part1", [{ protocol: PROTOCOL }, { metaData: META }, add("a.parquet", 100, 10)]);
    const part2 = await checkpointParquet("part2", [add("b.parquet", 200, 20)]);
    const driver = memoryDriver({
      "t/_delta_log/_last_checkpoint": JSON.stringify({ version: 7, size: 4, parts: 2 }),
      "t/_delta_log/00000000000000000007.checkpoint.0000000001.0000000002.parquet": part1,
      "t/_delta_log/00000000000000000007.checkpoint.0000000002.0000000002.parquet": part2,
    });
    expect(await tableInfo(driver, { root: "t/", format: "delta" })).toMatchObject({ version: "7", files: 2, bytes: 300, rows: 30, name: "built" });
  });
});

describe("iceberg tables", () => {
  it("summarises the current snapshot, keeping 64-bit ids exact", async () => {
    const info = await tableInfo(warehouse(), { root: "warehouse/orders/", format: "iceberg" });
    // What PyIceberg wrote in the current snapshot's summary.
    expect(info).toMatchObject({ version: "738212774583489755", files: 2, bytes: 23941, rows: 2490, formatVersion: "v2", location: "s3://lake/shop/orders" });
    expect(info.columns.map((c) => `${c.name}: ${c.type}`)).toEqual(["id: long", "name: string", "ts: timestamptz"]);
    expect(info.history.map((h) => h.operation)).toEqual(["overwrite", "append", "append"]);
    expect(info.history[0].summary).toBe("1,990 rows added · 2,000 rows deleted · 1 file added · 1 file removed");
    expect(info.notes[0]).toMatch(/catalog decides/);
  });

  it("follows version-hint.text when a table has one", async () => {
    const meta = (snapshot: string) =>
      JSON.stringify({
        "format-version": 1,
        location: "s3://x/t",
        schema: { fields: [{ id: 1, name: "a", required: true, type: "int" }] },
        "partition-spec": [{ name: "a", transform: "bucket[4]", "source-id": 1 }],
        "current-snapshot-id": snapshot,
        snapshots: [{ "snapshot-id": snapshot, "timestamp-ms": 1, summary: { operation: "append", "total-records": "3" } }],
      }).replace(`"${snapshot}"`, snapshot);
    const driver = memoryDriver({
      "t/metadata/v1.metadata.json": meta("11"),
      "t/metadata/v2.metadata.json": meta("22"),
      "t/metadata/version-hint.text": "1",
    });
    const info = await tableInfo(driver, { root: "t/", format: "iceberg" });
    expect(info.version).toBe("11");
    expect(info.partitionColumns).toEqual(["bucket[4](a)"]);
    expect(info.notes).toEqual([]);
  });

  it("parses large integers as text", () => {
    expect(parseJson('{"id": 738212774583489755, "small": 5}')).toEqual({ id: "738212774583489755", small: 5 });
  });
});

describe("hudi tables", () => {
  it("reads the table's properties", async () => {
    const info = await tableInfo(warehouse(), { root: "warehouse/events/", format: "hudi" });
    expect(info).toMatchObject({ name: "events", formatVersion: "v6", partitionColumns: ["day"] });
    expect(info.properties).toContainEqual({ key: "hoodie.table.type", value: "MERGE_ON_READ" });
  });
});
