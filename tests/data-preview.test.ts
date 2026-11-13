/**
 * Data previews: Parquet read from its footer and first pages (checked against DuckDB reading
 * the whole file), text formats from their first megabytes, Avro from its first blocks.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import avro from "avsc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { literal, withDuck } from "../app/lib/server/data/duck";
import { closeJsonArray, dataFormatOf, previewData } from "../app/lib/server/data/preview";
import { StorageUserError } from "../app/lib/server/drivers/types";
import { memoryDriver } from "./memory-driver";

const FIXTURES = path.join(__dirname, "fixtures", "data");
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

let work: string;
beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "jvinu-preview-test-"));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

/** What DuckDB itself shows for the whole file: the truth a preview must match. */
async function truth(file: string) {
  return withDuck(async (db) => ({
    columns: await db.describe(`SELECT * FROM read_parquet(${literal(file)})`),
    rows: await db.preview(`SELECT * FROM read_parquet(${literal(file)})`, 100),
  }));
}

/** A Parquet file written by DuckDB from `select`, returned as bytes. */
async function duckParquet(name: string, select: string, options = "COMPRESSION zstd"): Promise<{ file: string; bytes: Uint8Array }> {
  const file = path.join(work, name);
  await withDuck(async (db) => db.run(`COPY (${select}) TO ${literal(file)} (FORMAT parquet, ${options})`));
  return { file, bytes: new Uint8Array(readFileSync(file)) };
}

describe("data formats", () => {
  it("knows formats by name, compressed text included", () => {
    expect(dataFormatOf("a/b/part-0001.snappy.parquet")).toEqual({ format: "parquet", gzip: false });
    expect(dataFormatOf("x.CSV.gz")).toEqual({ format: "csv", gzip: true });
    expect(dataFormatOf("x.tsv")).toEqual({ format: "tsv", gzip: false });
    expect(dataFormatOf("events.jsonl.gz")).toEqual({ format: "ndjson", gzip: true });
    expect(dataFormatOf("events.avro")).toEqual({ format: "avro", gzip: false });
    expect(dataFormatOf("x.parquet.gz")).toBeNull();
    expect(dataFormatOf("photo.jpg")).toBeNull();
    expect(dataFormatOf("README")).toBeNull();
  });
});

describe("parquet previews", () => {
  it.each(["pages-v1.parquet", "pages-v2.parquet", "long-values.parquet", "tiny-groups.parquet"])(
    "%s: the first rows match DuckDB reading the whole file",
    async (name) => {
      const driver = memoryDriver({ [name]: fixture(name) });
      const preview = await previewData(driver, name);
      const expected = await truth(path.join(FIXTURES, name));
      expect(preview.format).toBe("parquet");
      expect(preview.columns).toEqual(expected.columns);
      expect(preview.rows).toEqual(expected.rows);
      expect(preview.rows).toHaveLength(100);
      expect(preview.rowCountExact).toBe(true);
      expect(preview.notes).toEqual([]);
    },
  );

  it("counts rows from the footer", async () => {
    const preview = await previewData(memoryDriver({ "t.parquet": fixture("tiny-groups.parquet") }), "t.parquet");
    expect(preview.rowCount).toBe(500);
    expect(preview.details).toContainEqual({ label: "Row groups", value: "17" });
  });

  it("reads a small part of a large file", async () => {
    const { file, bytes } = await duckParquet(
      "big.parquet",
      `SELECT i AS id, 'customer-' || (i % 9973) AS name, i * 1.5 AS amount, DATE '2024-01-01' + (i % 365)::INT AS day, [i, i + 1] AS pair
       FROM range(1500000) t(i)`,
      "COMPRESSION zstd, ROW_GROUP_SIZE 500000",
    );
    const driver = memoryDriver({ "big.parquet": bytes });
    const preview = await previewData(driver, "big.parquet");
    expect(preview.rows).toEqual((await truth(file)).rows);
    expect(preview.rowCount).toBe(1_500_000);
    // The footer and the first pages of each column, in the first of three row groups.
    expect(preview.bytesRead).toBeLessThan(bytes.length / 2);
    expect(driver.counters.bytesServed).toBe(preview.bytesRead);
  });

  it("reads a small file once, never more than its size", async () => {
    const bytes = fixture("pages-v2.parquet");
    const driver = memoryDriver({ "small.parquet": bytes });
    const preview = await previewData(driver, "small.parquet");
    expect(preview.rows.length).toBe(100);
    expect(driver.counters.bytesServed).toBe(preview.bytesRead);
    // The 4-byte magic check at the start is the only byte read twice.
    expect(preview.bytesRead).toBeLessThanOrEqual(bytes.length + 4);
  });

  it("shows the first 50 columns of a wide file, fetching only those", async () => {
    const columns = Array.from({ length: 120 }, (_, i) => `i * ${i + 1} AS c${String(i).padStart(3, "0")}`).join(", ");
    const { bytes } = await duckParquet("wide.parquet", `SELECT ${columns} FROM range(20000) t(i)`, "COMPRESSION uncompressed");
    const preview = await previewData(memoryDriver({ "wide.parquet": bytes }), "wide.parquet");
    expect(preview.columns).toHaveLength(120);
    expect(preview.shown).toHaveLength(50);
    expect(preview.shown[49]).toBe("c049");
    expect(preview.rows[0]).toHaveLength(50);
    expect(preview.notes).toContain("Showing the first 50 of 120 columns.");
    expect(preview.bytesRead).toBeLessThan(bytes.length * 0.6);
  });

  it("keeps the schema and count when the first rows are over the byte budget", async () => {
    // Uncompressed long values in DuckDB's large pages: the first page alone is megabytes.
    const { bytes } = await duckParquet("heavy.parquet", `SELECT i AS id, repeat('x', 3000) || i AS blob FROM range(4000) t(i)`, "COMPRESSION uncompressed");
    const before = process.env.JVINU_PREVIEW_MAX_MB;
    process.env.JVINU_PREVIEW_MAX_MB = "1";
    try {
      const preview = await previewData(memoryDriver({ "heavy.parquet": bytes }), "heavy.parquet");
      expect(preview.rows).toEqual([]);
      expect(preview.rowCount).toBe(4000);
      expect(preview.columns.map((c) => c.name)).toEqual(["id", "blob"]);
      expect(preview.notes).toEqual(["Rows aren't shown: the first rows of this file span more than 1 MB."]);
    } finally {
      if (before === undefined) delete process.env.JVINU_PREVIEW_MAX_MB;
      else process.env.JVINU_PREVIEW_MAX_MB = before;
    }
  });

  it("handles a file with no rows", async () => {
    const { bytes } = await duckParquet("none.parquet", `SELECT 1 AS a, 'x' AS b WHERE false`);
    const preview = await previewData(memoryDriver({ "none.parquet": bytes }), "none.parquet");
    expect(preview.rowCount).toBe(0);
    expect(preview.rows).toEqual([]);
    expect(preview.columns).toEqual([
      { name: "a", type: "INTEGER" },
      { name: "b", type: "VARCHAR" },
    ]);
  });

  it("works with a provider that ignores byte ranges", async () => {
    const driver = memoryDriver({ "p.parquet": fixture("pages-v1.parquet") }, { ignoreRanges: true });
    const preview = await previewData(driver, "p.parquet");
    expect(preview.rows).toEqual((await truth(path.join(FIXTURES, "pages-v1.parquet"))).rows);
  });

  it("refuses a file that isn't Parquet", async () => {
    const error = await previewData(memoryDriver({ "fake.parquet": "id,name\n1,a\n" }), "fake.parquet").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageUserError);
    expect((error as StorageUserError).status).toBe(422);
  });

  it("explains a file whose footer is cut off", async () => {
    const bytes = fixture("pages-v1.parquet").slice(0, 100_000);
    await expect(previewData(memoryDriver({ "cut.parquet": bytes }), "cut.parquet")).rejects.toThrow(/incomplete or damaged/);
  });
});

describe("text previews", () => {
  const lines = ["id,name,amount,day"];
  for (let i = 0; i < 200_000; i++) lines.push(`${i},"name ${i}, with a comma",${(i * 1.5).toFixed(2)},2024-01-${String((i % 28) + 1).padStart(2, "0")}`);
  const csv = `${lines.join("\n")}\n`;

  it("reads a CSV's first rows and estimates the rest", async () => {
    const driver = memoryDriver({ "big.csv": csv });
    const preview = await previewData(driver, "big.csv");
    expect(preview.columns).toEqual([
      { name: "id", type: "BIGINT" },
      { name: "name", type: "VARCHAR" },
      { name: "amount", type: "DOUBLE" },
      { name: "day", type: "DATE" },
    ]);
    expect(preview.rows[0]).toEqual(["0", "name 0, with a comma", "0.0", "2024-01-01"]);
    expect(preview.rows).toHaveLength(100);
    expect(preview.rowCountExact).toBe(false);
    expect(Math.abs(preview.rowCount! - 200_000) / 200_000).toBeLessThan(0.1);
    expect(preview.details).toContainEqual({ label: "Delimiter", value: "Comma" });
    expect(preview.details).toContainEqual({ label: "Header row", value: "Yes" });
    expect(preview.bytesRead).toBe(2 * 1024 * 1024);
  });

  it("counts a small CSV exactly", async () => {
    const preview = await previewData(memoryDriver({ "s.csv": "a;b\n1;x\n2;y\n" }), "s.csv");
    expect(preview.rowCount).toBe(2);
    expect(preview.rowCountExact).toBe(true);
    expect(preview.details).toContainEqual({ label: "Delimiter", value: "Semicolon" });
  });

  it("reads TSV, and gzipped CSV through decompression", async () => {
    const tsv = await previewData(memoryDriver({ "t.tsv": "a\tb\n1\tx y\n" }), "t.tsv");
    expect(tsv.rows).toEqual([["1", "x y"]]);
    const gz = await previewData(memoryDriver({ "big.csv.gz": gzipSync(csv) }), "big.csv.gz");
    expect(gz.compression).toBe("gzip");
    expect(gz.rows[5]).toEqual(["5", "name 5, with a comma", "7.5", "2024-01-06"]);
    expect(gz.rowCountExact).toBe(false);
    expect(Math.abs(gz.rowCount! - 200_000) / 200_000).toBeLessThan(0.25);
    expect(gz.notes[0]).toMatch(/uncompressed/);
  });

  it("reads JSON Lines, large JSON arrays and single objects", async () => {
    const ndjson = Array.from({ length: 60_000 }, (_, i) => JSON.stringify({ id: i, tags: [i % 3], nested: { a: i } })).join("\n");
    const array = JSON.stringify(Array.from({ length: 60_000 }, (_, i) => ({ id: i, s: `a "quoted" [text], ${i}` })));
    const driver = memoryDriver({ "e.ndjson": ndjson, "a.json": array, "one.json": '{"a": 1, "b": [1, 2]}' });

    const lines = await previewData(driver, "e.ndjson");
    expect(lines.columns.map((c) => c.name)).toEqual(["id", "tags", "nested"]);
    expect(lines.rows[2]).toEqual(["2", "[2]", "{'a': 2}"]);
    expect(lines.rowCountExact).toBe(false);

    const big = await previewData(driver, "a.json");
    expect(big.rows[1]).toEqual(["1", 'a "quoted" [text], 1']);
    expect(Math.abs(big.rowCount! - 60_000) / 60_000).toBeLessThan(0.1);

    const one = await previewData(driver, "one.json");
    expect(one.rows).toEqual([["1", "[1, 2]"]]);
    expect(one.rowCount).toBe(1);
  });

  it("explains JSON that isn't records, and handles empty files", async () => {
    await expect(previewData(memoryDriver({ "s.json": '"just text"' }), "s.json")).rejects.toThrow(/isn't a list of records/);
    const empty = await previewData(memoryDriver({ "e.csv": "" }), "e.csv");
    expect(empty.rows).toEqual([]);
    expect(empty.rowCount).toBe(0);
  });

  it("closes a cut-off JSON array after its last whole element", () => {
    expect(closeJsonArray('[{"a": "x, ]"}, {"a": 2}, {"a": ')).toBe('[{"a": "x, ]"}, {"a": 2}]');
    expect(closeJsonArray('[{"a": "\\"},"}, {"b')).toBe('[{"a": "\\"},"}]');
    expect(closeJsonArray('[{"a": 1')).toBeNull();
  });
});

describe("avro previews", () => {
  it.each(["null", "deflate", "snappy", "zstandard"])("decodes %s blocks written by fastavro", async (codec) => {
    const name = `events-${codec}.avro`;
    const preview = await previewData(memoryDriver({ [name]: fixture(name) }), name);
    expect(preview.columns).toEqual([
      { name: "id", type: "long" },
      { name: "user", type: "string?" },
      { name: "at", type: "long (timestamp-millis)" },
      { name: "day", type: "int (date)" },
      { name: "price", type: "bytes (decimal 10, 2)" },
      { name: "tags", type: "array<string>" },
      { name: "attrs", type: "map<string, long>" },
      { name: "kind", type: "enum(A, B)" },
      { name: "big", type: "long" },
    ]);
    // Longs past 2^53 stay exact; logical types print as values, not raw numbers.
    expect(preview.rows[1]).toEqual([
      "1",
      "u1",
      "2024-01-01 00:00:01.000",
      "2024-01-02",
      "-4.99",
      '["t1"]',
      '{"k": 1}',
      "A",
      "1700000000000000001",
    ]);
    expect(preview.rows[0][1]).toBeNull();
    expect(preview.rowCount).toBe(1000);
    expect(preview.rowCountExact).toBe(true);
    expect(preview.details).toContainEqual({ label: "Codec", value: codec });
    expect(preview.details).toContainEqual({ label: "Record", value: "com.example.Event" });
  });

  it("estimates the count of a file larger than it reads", async () => {
    const type = avro.Type.forSchema({ type: "record", name: "Row", fields: [{ name: "n", type: "int" }, { name: "s", type: "string" }] });
    const encoder = new avro.streams.BlockEncoder(type, { codec: "null", blockSize: 16 * 1024 });
    const chunks: Buffer[] = [];
    encoder.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise((resolve) => encoder.on("end", resolve));
    for (let i = 0; i < 150_000; i++) encoder.write({ n: i, s: `row ${i} ${"z".repeat(20)}` });
    encoder.end();
    await done;
    const bytes = new Uint8Array(Buffer.concat(chunks));
    expect(bytes.length).toBeGreaterThan(4 * 1024 * 1024);
    const preview = await previewData(memoryDriver({ "big.avro": bytes }), "big.avro");
    expect(preview.rows[3]).toEqual(["3", `row 3 ${"z".repeat(20)}`]);
    expect(preview.rowCountExact).toBe(false);
    expect(Math.abs(preview.rowCount! - 150_000) / 150_000).toBeLessThan(0.05);
  });

  it("refuses a file that isn't Avro", async () => {
    await expect(previewData(memoryDriver({ "x.avro": "hello" }), "x.avro")).rejects.toThrow(/doesn't look like an Avro file/);
  });
});
