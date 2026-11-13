import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportSql, globToRegExp, looksLikeFiles, runSql, staticPrefix, stringLiterals } from "../app/lib/server/data/sql";
import { loadFolder, memoryDriver } from "./memory-driver";

const DATA = path.join(__dirname, "fixtures", "data");
const LAKE = path.join(__dirname, "fixtures", "lake");

function bucket() {
  const driver = memoryDriver({
    "sales/2024/jan.csv": "country,amount\nRO,10\nDE,5\nRO,7\n",
    "sales/2024/feb.csv": "country,amount\nRO,1\nFR,2\n",
    "sales/2025/jan.csv": "country,amount\nDE,100\n",
    "sales/readme.txt": "not data",
    "logs/app.jsonl": '{"level":"info","ms":3}\n{"level":"error","ms":9}\n',
    "weird/it's here.csv": "a\n1\n",
  });
  driver.files.set("data/pages.parquet", new Uint8Array(readFileSync(path.join(DATA, "pages-v2.parquet"))));
  loadFolder(driver, path.join(LAKE, "delta-sales"), "lake/sales/");
  return driver;
}

describe("finding file names in SQL", () => {
  it("reads string literals, skipping comments and quoted identifiers", () => {
    const sql = `-- 'not this'\nSELECT "it's" FROM 'a/*.csv' /* 'nor this' */ WHERE x = 'O''Brien'`;
    expect(stringLiterals(sql).map((literal) => literal.value)).toEqual(["a/*.csv", "O'Brien"]);
  });

  it("tells file names from ordinary strings", () => {
    expect(looksLikeFiles("sales/**/*.parquet")).toBe(true);
    expect(looksLikeFiles("data.csv.gz")).toBe(true);
    expect(looksLikeFiles("RO")).toBe(false);
    expect(looksLikeFiles("%2024%")).toBe(false);
    expect(looksLikeFiles("/etc/passwd")).toBe(false);
    expect(looksLikeFiles("https://example.com/a.csv")).toBe(false);
  });

  it("matches globs the way DuckDB does", () => {
    const re = globToRegExp("sales/**/*.csv");
    expect(re.test("sales/2024/jan.csv")).toBe(true);
    expect(re.test("sales/jan.csv")).toBe(true);
    expect(re.test("other/2024/jan.csv")).toBe(false);
    expect(globToRegExp("sales/*/jan.csv").test("sales/2024/x/jan.csv")).toBe(false);
    expect(globToRegExp("sales/202[45]/{jan,feb}.csv").test("sales/2025/feb.csv")).toBe(true);
    expect(staticPrefix("sales/2024/*.csv")).toBe("sales/2024/");
    expect(staticPrefix("*.csv")).toBe("");
  });
});

describe("running SQL over a bucket", () => {
  it("queries CSV files across folders with a glob", async () => {
    const result = await runSql(bucket(), "SELECT country, sum(amount) AS total FROM 'sales/**/*.csv' GROUP BY 1 ORDER BY 1");
    expect(result.columns.map((column) => column.name)).toEqual(["country", "total"]);
    expect(result.rows).toEqual([
      ["DE", "105"],
      ["FR", "2"],
      ["RO", "18"],
    ]);
    expect(result.files.sort()).toEqual(["sales/2024/feb.csv", "sales/2024/jan.csv", "sales/2025/jan.csv"]);
  });

  it("keeps folder structure, so hive partitions and filenames work", async () => {
    const result = await runSql(
      bucket(),
      "SELECT count(*) AS n FROM read_parquet('lake/sales/country=*/*.parquet', hive_partitioning = true) WHERE country = 'RO'",
    );
    expect(Number(result.rows[0][0])).toBeGreaterThan(0);
    const named = await runSql(bucket(), "SELECT DISTINCT parse_filename(filename) AS f FROM read_csv('sales/2024/*.csv', filename = true) ORDER BY 1");
    expect(named.rows).toEqual([["feb.csv"], ["jan.csv"]]);
  });

  it("reads Parquet and JSON Lines, and the bucket's own s3:// paths", async () => {
    const parquet = await runSql(bucket(), "SELECT count(*) FROM 's3://lake-bucket/data/pages.parquet'", "lake-bucket");
    expect(Number(parquet.rows[0][0])).toBeGreaterThan(0);
    const json = await runSql(bucket(), "SELECT level FROM 'logs/*.jsonl' WHERE ms > 5");
    expect(json.rows).toEqual([["error"]]);
  });

  it("handles names with quotes in them", async () => {
    const result = await runSql(bucket(), "SELECT a FROM 'weird/it''s here.csv'");
    expect(result.rows).toEqual([["1"]]);
  });

  it("says when nothing matches, in bucket terms", async () => {
    await expect(runSql(bucket(), "SELECT * FROM 'nope/*.csv'")).rejects.toThrow(/No files match “nope\/\*.csv”/);
  });

  it("refuses anything but one read-only statement", async () => {
    await expect(runSql(bucket(), "SELECT 1 FROM 'sales/2024/jan.csv'; SELECT 2")).rejects.toThrow(/one statement/);
    await expect(runSql(bucket(), "COPY (SELECT 1) TO 'sales/2024/out.csv'")).rejects.toThrow();
    await expect(runSql(bucket(), "CREATE TABLE t AS SELECT * FROM 'sales/2024/jan.csv'")).rejects.toThrow(/Only queries that read/);
  });

  it("can't reach the server's own files, the network or settings", async () => {
    const driver = bucket();
    await expect(runSql(driver, "SELECT * FROM 'sales/2024/jan.csv', read_text('/etc/hostname')")).rejects.toThrow(/disabled|Permission/i);
    await expect(runSql(driver, "SELECT * FROM 'sales/2024/jan.csv', read_csv('https://example.com/x.csv')")).rejects.toThrow();
    await expect(runSql(driver, "SELECT * FROM 'sales/2024/jan.csv', read_text('../../../etc/hostname')")).rejects.toThrow(/disabled|Permission/i);
    await expect(runSql(driver, "SELECT current_setting('memory_limit') FROM 'sales/2024/jan.csv' LIMIT 1")).resolves.toBeTruthy();
  });

  it("shows bucket paths, not scratch paths, in errors", async () => {
    const error = await runSql(bucket(), "SELECT nope FROM 'sales/2024/jan.csv'").catch((failure: Error) => failure);
    expect((error as Error).message).not.toMatch(/sql-[0-9a-f]{4}|jvinu-data/);
    expect((error as Error).message).toMatch(/nope/);
    // DuckDB quotes the query back with long paths cut short: those go too.
    const quoted = await runSql(bucket(), "SELECT * FROM read_text('/etc/hostname'), 'sales/2024/jan.csv' LIMIT 1").catch((failure: Error) => failure);
    expect((quoted as Error).message).not.toMatch(/sql-[0-9a-f]{4}|jvinu-data/);
  });

  it("caps how much a query may fetch", async () => {
    process.env.JVINU_SQL_MAX_MB = "0.00001";
    try {
      await expect(runSql(bucket(), "SELECT * FROM 'sales/**/*.csv'")).rejects.toThrow(/at most/);
    } finally {
      delete process.env.JVINU_SQL_MAX_MB;
    }
  });

  it("saves the whole result to a bucket as Parquet or CSV", async () => {
    const source = bucket();
    const target = memoryDriver();
    const saved = await exportSql(source, "SELECT country, amount FROM 'sales/**/*.csv'", undefined, "parquet", target, "out/all.parquet");
    expect(saved.rows).toBe(6);
    expect(new TextDecoder().decode(target.files.get("out/all.parquet")!.slice(0, 4))).toBe("PAR1");
    const back = await runSql(target, "SELECT count(*) FROM 'out/all.parquet'");
    expect(back.rows).toEqual([["6"]]);

    await exportSql(source, "SELECT country FROM 'sales/2025/*.csv'", undefined, "csv", target, "out/de.csv");
    expect(new TextDecoder().decode(target.files.get("out/de.csv")!)).toBe("country\nDE\n");
    expect(target.types.get("out/de.csv")).toBe("text/csv");
  });
});
