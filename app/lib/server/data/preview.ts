import "server-only";
import { writeFile } from "node:fs/promises";
import { StorageUserError, type StorageDriver } from "../drivers/types";
import { avroColumns, avroText, decodeAvro, scanAvro } from "./avro";
import { readPrefix } from "./bytes";
import { duckProblem, ident, literal, withDuck, type Duck } from "./duck";
import { BudgetExceeded, CODECS, fetcherFor, planRows, readFooter, writeSparse } from "./parquet";

/**
 * A look inside a data file without downloading it: its columns, how many rows it holds,
 * and its first rows. Parquet is read by its footer and first pages; text formats by their
 * first couple of megabytes; Avro by its first blocks.
 */

export type DataFormat = "parquet" | "csv" | "tsv" | "json" | "ndjson" | "avro";

export type DataPreview = {
  format: DataFormat;
  /** gzip, for .csv.gz and the like. */
  compression?: string;
  size: number;
  /** Bytes fetched from storage to build this preview. */
  bytesRead: number;
  /** Rows in the whole file; estimated when `rowCountExact` is false; null when unknown. */
  rowCount: number | null;
  rowCountExact: boolean;
  columns: { name: string; type: string }[];
  /** The columns `rows` holds — the first ones, when the file has a great many. */
  shown: string[];
  rows: (string | null)[][];
  /** Why something is missing or estimated, in a sentence each. */
  notes: string[];
  details: { label: string; value: string }[];
};

export const PREVIEW_ROWS = 100;
const MAX_COLUMNS = 50;
const TEXT_PREFIX = 2 * 1024 * 1024;
const AVRO_PREFIX = 4 * 1024 * 1024;
const MAX_CELL = 300;

/** How much of a Parquet file a preview may fetch for its rows (JVINU_PREVIEW_MAX_MB, default 64). */
const parquetBudget = () => Math.max(1, Number(process.env.JVINU_PREVIEW_MAX_MB) || 64) * 1024 * 1024;

/** The format a key's name says it holds, or null for anything that isn't tabular data. */
export function dataFormatOf(key: string): { format: DataFormat; gzip: boolean } | null {
  let name = key.split("/").pop()?.toLowerCase() ?? "";
  const gzip = /\.gz(ip)?$/.test(name);
  if (gzip) name = name.replace(/\.gz(ip)?$/, "");
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "parquet":
    case "parq":
    case "pqt":
      return gzip ? null : { format: "parquet", gzip };
    case "avro":
      return gzip ? null : { format: "avro", gzip };
    case "csv":
      return { format: "csv", gzip };
    case "tsv":
    case "tab":
      return { format: "tsv", gzip };
    case "json":
      return { format: "json", gzip };
    case "jsonl":
    case "ndjson":
      return { format: "ndjson", gzip };
    default:
      return null;
  }
}

export async function previewData(driver: StorageDriver, key: string): Promise<DataPreview> {
  const kind = dataFormatOf(key);
  if (!kind) throw new StorageUserError("Previews cover Parquet, CSV, TSV, JSON, JSON Lines and Avro files.", 415);
  switch (kind.format) {
    case "parquet":
      return previewParquet(driver, key);
    case "avro":
      return previewAvro(driver, key);
    default:
      return previewText(driver, key, kind.format, kind.gzip);
  }
}

const cell = (value: string | null) => (value !== null && value.length > MAX_CELL ? `${value.slice(0, MAX_CELL)}…` : value);

/** "SELECT *", or the first columns by name when there are too many to show. */
function projection(columns: { name: string }[]): { select: string; shown: string[] } {
  if (columns.length <= MAX_COLUMNS) return { select: "*", shown: columns.map((c) => c.name) };
  const shown = columns.slice(0, MAX_COLUMNS).map((c) => c.name);
  return { select: shown.map(ident).join(", "), shown };
}

const manyColumnsNote = (total: number) => `Showing the first ${MAX_COLUMNS} of ${total} columns.`;
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/* ---- Parquet --------------------------------------------------------------------------- */

const PAR1 = { start: 0, bytes: new TextEncoder().encode("PAR1") };

/** DuckDB reading a hole in the sparse copy: the page walk stopped short of what it needed. */
const isHole = (error: unknown) => /TProtocolException|Invalid data|Corrupt|out of range|zero|truncated/i.test(String((error as Error)?.message ?? error));

/** Parquet files up to this size are fetched whole. */
const SMALL_PARQUET = 1024 * 1024;

async function previewParquet(driver: StorageDriver, key: string): Promise<DataPreview> {
  const { size, footer, tail, end, bytesRead: footerBytes } = await readFooter(driver, key);
  let bytesRead = footerBytes;
  const fetch = fetcherFor(driver, key);
  // A small file is cheaper read once, whole, than page by page: the rest of it, then slices.
  let whole: Uint8Array | null = null;
  if (size <= SMALL_PARQUET && end.start + end.bytes.length === size) {
    const head = end.start > 0 ? await fetch(0, end.start - 1) : new Uint8Array(0);
    bytesRead += head.length;
    whole = new Uint8Array(size);
    whole.set(head, 0);
    whole.set(end.bytes, end.start);
  }
  const counted = async (start: number, end: number) => {
    if (whole) return whole.slice(start, end + 1);
    const bytes = await fetch(start, end);
    bytesRead += bytes.length;
    return bytes;
  };

  return withDuck(async (db, scratch) => {
    const file = scratch.file("data.parquet");
    const source = `read_parquet(${literal(file)})`;
    // The schema needs only the footer.
    await writeSparse(file, size, [PAR1, tail]);
    let columns: { name: string; type: string }[];
    try {
      columns = await db.describe(`SELECT * FROM ${source}`);
    } catch (error) {
      throw duckProblem(error, "Parquet file");
    }
    const { select, shown } = projection(columns);
    const notes: string[] = [];
    if (columns.length > MAX_COLUMNS) notes.push(manyColumnsNote(columns.length));

    let rows: (string | null)[][] = [];
    if (footer.numRows > 0) {
      for (const wholeChunks of [false, true]) {
        try {
          const plan = await planRows(footer, counted, {
            rows: PREVIEW_ROWS,
            vectorRows: 2048,
            maxBytes: parquetBudget(),
            maxColumns: MAX_COLUMNS,
            wholeChunks,
          });
          await writeSparse(file, size, [PAR1, ...plan.pieces, tail]);
          rows = await db.preview(`SELECT ${select} FROM ${source}`, PREVIEW_ROWS, MAX_CELL);
          break;
        } catch (error) {
          if (error instanceof BudgetExceeded) {
            notes.push(`Rows aren't shown: the first rows of this file span more than ${mb(parquetBudget())}.`);
            break;
          }
          if (!wholeChunks && isHole(error)) continue; // fetch whole column chunks and try once more
          if (error instanceof StorageUserError) throw error;
          throw duckProblem(error, "Parquet file");
        }
      }
    }

    const codecs = [...new Set(footer.rowGroups.flatMap((group) => group.columns.map((chunk) => CODECS[chunk.codec] ?? `codec ${chunk.codec}`)))];
    const details = [
      { label: "Row groups", value: footer.rowGroups.length.toLocaleString("en-US") },
      { label: "Compression", value: codecs.join(", ") || "—" },
    ];
    if (footer.createdBy) details.push({ label: "Written by", value: footer.createdBy });
    for (const { key: name, value } of footer.keyValue.slice(0, 8)) {
      details.push({ label: name, value: value === undefined ? "—" : value.length > 80 ? `${value.length.toLocaleString("en-US")} characters` : value });
    }
    return {
      format: "parquet" as const,
      size,
      bytesRead,
      rowCount: footer.numRows,
      rowCountExact: true,
      columns,
      shown,
      rows,
      notes,
      details,
    };
  });
}

/* ---- CSV, TSV, JSON, JSON Lines ------------------------------------------------------------- */

/** Cuts a truncated JSON array after its last complete element and closes it. */
export function closeJsonArray(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true;
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) inString = true;
    else if (c === 91 || c === 123) depth++;
    else if (c === 93 || c === 125) depth--;
    else if (c === 44 && depth === 1) last = i;
  }
  return last > 0 ? `${text.slice(0, last)}]` : null;
}

const firstSignificant = (text: string) => text.replace(/^﻿/, "").trimStart()[0] ?? "";

async function previewText(driver: StorageDriver, key: string, format: DataFormat, gzip: boolean): Promise<DataPreview> {
  const prefix = await readPrefix(driver, key, TEXT_PREFIX, gzip);
  const notes: string[] = [];
  const details: DataPreview["details"] = [];
  if (gzip) details.push({ label: "Compression", value: "gzip" });

  let text = new TextDecoder().decode(prefix.bytes);
  let reader: (file: string) => string;

  if (format === "csv" || format === "tsv") {
    if (!prefix.complete) text = text.slice(0, text.lastIndexOf("\n") + 1);
    const delim = format === "tsv" ? `, delim=${literal("\t")}` : "";
    reader = (file) => `read_csv(${literal(file)}${delim}, sample_size=-1, ignore_errors=true, null_padding=true)`;
  } else {
    const lead = firstSignificant(text);
    if (format === "json" && lead === "[") {
      if (!prefix.complete) {
        const closed = closeJsonArray(text);
        if (closed === null) throw new StorageUserError("The first element of this JSON array is too large to preview.", 422);
        text = closed;
      }
      reader = (file) => `read_json(${literal(file)}, format='array', sample_size=-1)`;
    } else if (format === "json" && lead === "{" && prefix.complete) {
      reader = (file) => `read_json(${literal(file)}, format='auto', sample_size=-1)`;
    } else if (lead === "{" || lead === "" || format === "ndjson") {
      if (!prefix.complete) text = text.slice(0, text.lastIndexOf("\n") + 1);
      reader = (file) => `read_json(${literal(file)}, format='newline_delimited', sample_size=-1, ignore_errors=true)`;
    } else {
      throw new StorageUserError("This JSON file isn't a list of records, so it has no rows to show.", 422);
    }
  }
  if (!text.trim() && !prefix.complete) throw new StorageUserError("The first line of this file is too long to preview.", 422);
  const usedBytes = new TextEncoder().encode(text).length;

  return withDuck(async (db: Duck, scratch) => {
    const file = scratch.file(format === "csv" || format === "tsv" ? "data.csv" : "data.json");
    await writeFile(file, text, { mode: 0o600 });
    const source = reader(file);
    const name = format === "tsv" ? "TSV file" : format === "csv" ? "CSV file" : "JSON file";
    try {
      if (!text.trim()) {
        return result(format, gzip, prefix.size, prefix.consumed, 0, true, [], [], [], notes, details);
      }
      const columns = await db.describe(`SELECT * FROM ${source}`);
      const { select, shown } = projection(columns);
      if (columns.length > MAX_COLUMNS) notes.push(manyColumnsNote(columns.length));
      const rows = (await db.preview(`SELECT ${select} FROM ${source}`, PREVIEW_ROWS, MAX_CELL)).map((row) => row.map(cell));
      const counted = Number((await db.all(`SELECT count(*) FROM ${source}`)).rows[0]?.[0] ?? 0);

      let rowCount = counted;
      let exact = true;
      if (!prefix.complete) {
        // Scale up from the part that was read: rows per stored byte, times the stored size.
        const stored = gzip ? prefix.consumed * (usedBytes / Math.max(1, prefix.bytes.length)) : usedBytes;
        rowCount = stored > 0 ? Math.round((counted * prefix.size) / stored) : counted;
        exact = false;
        notes.push(`The row count is estimated from the first ${mb(TEXT_PREFIX)}${gzip ? " (uncompressed)" : ""}.`);
      }
      if (format === "csv" || format === "tsv") {
        const sniff = await db.all(`SELECT Delimiter, Quote, HasHeader FROM sniff_csv(${literal(file)}, sample_size=-1)`);
        const [delimiter, quote, header] = sniff.rows[0] ?? [];
        if (delimiter !== undefined) details.unshift({ label: "Delimiter", value: describeDelimiter(String(delimiter)) });
        if (header !== undefined) details.push({ label: "Header row", value: header ? "Yes" : "No" });
        if (quote && quote !== "(empty)") details.push({ label: "Quote", value: String(quote) });
      }
      return result(format, gzip, prefix.size, prefix.consumed, rowCount, exact, columns, shown, rows, notes, details);
    } catch (error) {
      throw duckProblem(error, name);
    }
  });
}

function describeDelimiter(delimiter: string): string {
  switch (delimiter) {
    case "\t":
      return "Tab";
    case ",":
      return "Comma";
    case ";":
      return "Semicolon";
    case "|":
      return "Pipe";
    case " ":
      return "Space";
    default:
      return delimiter;
  }
}

function result(
  format: DataFormat,
  gzip: boolean,
  size: number,
  bytesRead: number,
  rowCount: number | null,
  rowCountExact: boolean,
  columns: DataPreview["columns"],
  shown: string[],
  rows: DataPreview["rows"],
  notes: string[],
  details: DataPreview["details"],
): DataPreview {
  return { format, ...(gzip ? { compression: "gzip" } : {}), size, bytesRead, rowCount, rowCountExact, columns, shown, rows, notes, details };
}

/* ---- Avro ------------------------------------------------------------------------------- */

async function previewAvro(driver: StorageDriver, key: string): Promise<DataPreview> {
  const prefix = await readPrefix(driver, key, AVRO_PREFIX, false);
  const scan = scanAvro(prefix.bytes);
  const columns = avroColumns(scan.schema);
  const records = await decodeAvro(prefix.bytes, PREVIEW_ROWS);
  const single = columns.length === 1 && columns[0].name === "value" && !isRecordSchema(scan.schema);
  const { shown } = projection(columns);
  const shownColumns = columns.slice(0, shown.length);
  const rows = records.map((record) =>
    single
      ? [cell(avroText(record, columns[0].logical, columns[0].scale))]
      : shownColumns.map((column) => cell(avroText((record as Record<string, unknown>)?.[column.name], column.logical, column.scale))),
  );
  const notes: string[] = [];
  if (columns.length > MAX_COLUMNS) notes.push(manyColumnsNote(columns.length));
  let rowCount = scan.records;
  let exact = true;
  if (!prefix.complete) {
    exact = false;
    rowCount = scan.end > 0 ? Math.round((scan.records * prefix.size) / scan.end) : scan.records;
    notes.push(`The row count is estimated from the first ${mb(AVRO_PREFIX)}.`);
  }
  const named = scan.schema as { name?: string; namespace?: string };
  const details = [{ label: "Codec", value: scan.codec }];
  if (named && typeof named === "object" && named.name) details.push({ label: "Record", value: [named.namespace, named.name].filter(Boolean).join(".") });
  return {
    format: "avro",
    size: prefix.size,
    bytesRead: prefix.consumed,
    rowCount,
    rowCountExact: exact,
    columns: columns.map(({ name, type }) => ({ name, type })),
    shown,
    rows,
    notes,
    details,
  };
}

const isRecordSchema = (schema: unknown) =>
  Boolean(schema) && typeof schema === "object" && !Array.isArray(schema) && ["record", "error"].includes((schema as { type?: string }).type ?? "");
