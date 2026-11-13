import "server-only";
import { open } from "node:fs/promises";
import { StorageUserError, type StorageDriver } from "../drivers/types";
import { objectSize, readBytes } from "./bytes";
import { CompactReader, list, num, str, struct, ThriftError, ThriftTruncated, type ThriftStruct } from "./thrift";

/**
 * Parquet without downloading Parquet. A file's footer says where every column chunk sits;
 * each chunk is a run of pages, each with a small header saying how long it is. So to show
 * the first rows, jvinu reads the footer, then walks just the first pages of each column —
 * usually a few hundred kilobytes, even for a multi-gigabyte file — and writes those bytes
 * into a sparse local file at their real offsets, where DuckDB decodes them.
 */

export type SchemaElement = {
  name: string;
  /** 0 required, 1 optional, 2 repeated. */
  repetition?: number;
  numChildren: number;
  /** Physical type, for leaves. */
  type?: number;
};

export type ColumnChunk = {
  path: string[];
  codec: number;
  numValues: number;
  /** First byte of the chunk (its dictionary page, when it has one) and one past its last. */
  start: number;
  end: number;
  /** Inside a repeated field: page value counts aren't row counts. */
  repeated: boolean;
  /** Stored in another file — Parquet allows it, almost nothing writes it. */
  external: boolean;
};

export type RowGroup = { numRows: number; columns: ColumnChunk[] };

export type ParquetFooter = {
  numRows: number;
  createdBy?: string;
  version?: number;
  keyValue: { key: string; value?: string }[];
  rowGroups: RowGroup[];
  schema: SchemaElement[];
  /** Top-level column names, in order. */
  topLevel: string[];
};

export const CODECS = ["uncompressed", "snappy", "gzip", "lzo", "brotli", "lz4", "zstd", "lz4_raw"];

const TAIL_READ = 64 * 1024;
const MAX_FOOTER = 32 * 1024 * 1024;
/** The first read of a column chunk: small chunks come whole, big ones start with their first page. */
const FIRST_READ = 64 * 1024;
/** Read past the end of a page, so the next page's header usually comes with it. */
const LOOKAHEAD = 16 * 1024;

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/** Decodes a FileMetaData struct. */
export function parseFooter(bytes: Uint8Array): ParquetFooter {
  let meta: ThriftStruct;
  try {
    meta = new CompactReader(bytes).readStruct();
  } catch (error) {
    if (error instanceof ThriftError) throw new StorageUserError("This Parquet file's footer is damaged.", 422);
    throw error;
  }

  const schema: SchemaElement[] = list(meta, 2).map((value) => {
    const element = value as ThriftStruct;
    return {
      name: str(element, 4) ?? "",
      repetition: num(element, 3),
      numChildren: num(element, 5) ?? 0,
      type: num(element, 1),
    };
  });

  // Which leaves sit under a repeated field: walk the flattened, depth-first schema tree.
  const repeatedLeaves = new Set<string>();
  let index = 1;
  const walk = (count: number, path: string[], repeated: boolean) => {
    for (let i = 0; i < count && index < schema.length; i++) {
      const element = schema[index++];
      const here = [...path, element.name];
      const isRepeated = repeated || element.repetition === 2;
      if (element.numChildren > 0) walk(element.numChildren, here, isRepeated);
      else if (isRepeated) repeatedLeaves.add(here.join("\u0000"));
    }
  };
  const topLevel: string[] = [];
  if (schema.length) {
    const rootChildren = schema[0].numChildren;
    for (let i = 0; i < rootChildren && index < schema.length; i++) {
      const element = schema[index];
      topLevel.push(element.name);
      walk(1, [], false);
    }
  }

  const rowGroups: RowGroup[] = list(meta, 4).map((value) => {
    const group = value as ThriftStruct;
    return {
      numRows: num(group, 3) ?? 0,
      columns: list(group, 1).map((chunkValue) => {
        const chunk = chunkValue as ThriftStruct;
        const md = struct(chunk, 3);
        const path = list(md, 3).map((part) => (part instanceof Uint8Array ? new TextDecoder().decode(part) : ""));
        const dataPage = num(md, 9) ?? 0;
        const dictionaryPage = num(md, 11);
        // Some writers record 0 for "no dictionary"; a page can never start at 0 (the magic is there).
        const start = dictionaryPage && dictionaryPage > 0 && dictionaryPage < dataPage ? dictionaryPage : dataPage;
        return {
          path,
          codec: num(md, 4) ?? 0,
          numValues: num(md, 5) ?? 0,
          start,
          end: start + (num(md, 7) ?? 0),
          repeated: repeatedLeaves.has(path.join("\u0000")),
          external: Boolean(str(chunk, 1)),
        };
      }),
    };
  });

  return {
    numRows: num(meta, 3) ?? 0,
    version: num(meta, 1),
    createdBy: str(meta, 6),
    keyValue: list(meta, 5).map((value) => {
      const kv = value as ThriftStruct;
      return { key: str(kv, 1) ?? "", value: str(kv, 2) };
    }),
    rowGroups,
    schema,
    topLevel,
  };
}

export type FooterRead = {
  size: number;
  footer: ParquetFooter;
  /** The file's last bytes — footer, its length and the magic — to place in a sparse copy. */
  tail: { start: number; bytes: Uint8Array };
  /** The end of the file as first read (at least the footer), for callers that want more of it. */
  end: { start: number; bytes: Uint8Array };
  bytesRead: number;
};

/** Reads and decodes a Parquet file's footer with one or two range requests. */
export async function readFooter(driver: StorageDriver, key: string): Promise<FooterRead> {
  const { size, head } = await objectSize(driver, key);
  if (size < 12 || ascii(head) !== "PAR1") throw new StorageUserError("This doesn't look like a Parquet file.", 422);

  const tailLength = Math.min(size, TAIL_READ);
  const { bytes: tail } = await readBytes(driver, key, size - tailLength, size - 1);
  if (tail.length !== tailLength) throw new StorageUserError("The storage service returned less of the file than asked.", 502);
  const magic = ascii(tail.subarray(tailLength - 4));
  if (magic === "PARE") throw new StorageUserError("This Parquet file is encrypted, so it can't be previewed.", 422);
  if (magic !== "PAR1") throw new StorageUserError("This Parquet file is incomplete or damaged — its footer is missing.", 422);

  const footerLength = new DataView(tail.buffer, tail.byteOffset + tailLength - 8, 4).getUint32(0, true);
  if (footerLength + 12 > size) throw new StorageUserError("This Parquet file's footer is damaged.", 422);
  if (footerLength > MAX_FOOTER) throw new StorageUserError("This Parquet file's footer is too large to preview.", 422);

  const footerStart = size - 8 - footerLength;
  let block: Uint8Array;
  let bytesRead = head.length + tail.length;
  if (footerLength + 8 <= tailLength) block = tail.subarray(tailLength - 8 - footerLength);
  else {
    const { bytes: rest } = await readBytes(driver, key, footerStart, size - tailLength - 1);
    bytesRead += rest.length;
    block = new Uint8Array(footerLength + 8);
    block.set(rest, 0);
    block.set(tail, rest.length);
  }
  return {
    size,
    footer: parseFooter(block.subarray(0, footerLength)),
    tail: { start: footerStart, bytes: block },
    end: footerLength + 8 <= tailLength ? { start: size - tailLength, bytes: tail } : { start: footerStart, bytes: block },
    bytesRead,
  };
}

export type RowPlan = {
  /** Byte runs to place in the sparse copy. */
  pieces: { start: number; bytes: Uint8Array }[];
  /** Top-level columns the plan covers. */
  columns: string[];
  bytesRead: number;
};

export type PlanOptions = {
  /** Rows to show. */
  rows: number;
  /** Rows DuckDB decodes at once (its vector size): every column must have at least this many. */
  vectorRows: number;
  /** Stop and give up past this many bytes. */
  maxBytes: number;
  maxColumns: number;
  /** Fetch whole column chunks instead of walking pages — the fallback when walking fell short. */
  wholeChunks?: boolean;
};

export class BudgetExceeded extends Error {}

/** Runs `work` over items with at most `limit` in flight. */
async function eachLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

/**
 * Works out, and fetches, the bytes DuckDB needs for the first rows of the first columns:
 * for each column chunk in the first row group(s), whole pages until they hold a vector's
 * worth of rows. `fetch` reads an inclusive byte range of the file.
 */
export async function planRows(
  footer: ParquetFooter,
  fetch: (start: number, end: number) => Promise<Uint8Array>,
  options: PlanOptions,
): Promise<RowPlan> {
  const columns = footer.topLevel.slice(0, options.maxColumns);
  const wanted = new Set(columns);

  const groups: RowGroup[] = [];
  let rows = 0;
  for (const group of footer.rowGroups) {
    if (group.numRows === 0) continue;
    groups.push(group);
    rows += group.numRows;
    if (rows >= options.rows) break;
  }

  const jobs: { chunk: ColumnChunk; need: number }[] = [];
  for (const group of groups) {
    for (const chunk of group.columns) {
      if (!wanted.has(chunk.path[0])) continue;
      if (chunk.external) throw new StorageUserError("This Parquet file keeps its columns in other files, so it can't be previewed.", 422);
      jobs.push({ chunk, need: Math.min(group.numRows, options.vectorRows) });
    }
  }

  let bytesRead = 0;
  const spend = (bytes: number) => {
    bytesRead += bytes;
    if (bytesRead > options.maxBytes) throw new BudgetExceeded();
  };
  const pieces: RowPlan["pieces"] = [];

  await eachLimit(jobs, 8, async ({ chunk, need }) => {
    if (chunk.end <= chunk.start) return;
    if (options.wholeChunks) {
      spend(chunk.end - chunk.start);
      pieces.push({ start: chunk.start, bytes: await fetch(chunk.start, chunk.end - 1) });
      return;
    }

    // `buffer` holds bytes [chunk.start, chunk.start + buffer.length) of the file.
    let buffer: Uint8Array = new Uint8Array(0);
    const ensure = async (to: number) => {
      const have = chunk.start + buffer.length;
      if (have >= to) return;
      const upTo = Math.min(chunk.end, Math.max(to + LOOKAHEAD, chunk.start + FIRST_READ));
      spend(upTo - have);
      const more = await fetch(have, upTo - 1);
      if (more.length !== upTo - have) throw new StorageUserError("The storage service returned less of the file than asked.", 502);
      const joined = new Uint8Array(buffer.length + more.length);
      joined.set(buffer, 0);
      joined.set(more, buffer.length);
      buffer = joined;
    };

    // A repeated column's pages count values, not rows: ask for many more to be safe.
    const target = chunk.repeated ? need * 32 : need;
    let position = chunk.start;
    let covered = 0;
    while (position < chunk.end && covered < target) {
      let header: ThriftStruct | undefined;
      let headerLength = 0;
      for (let window = 1024; !header; window *= 4) {
        await ensure(Math.min(chunk.end, position + window));
        const reader = new CompactReader(buffer, position - chunk.start);
        try {
          header = reader.readStruct();
          headerLength = reader.pos - (position - chunk.start);
        } catch (error) {
          if (!(error instanceof ThriftTruncated) || position + window >= chunk.end) {
            throw new StorageUserError("This Parquet file has a damaged page header.", 422);
          }
        }
      }
      const compressed = num(header, 3);
      if (compressed === undefined || compressed < 0) throw new StorageUserError("This Parquet file has a damaged page header.", 422);
      const pageEnd = position + headerLength + compressed;
      if (pageEnd > chunk.end) throw new StorageUserError("This Parquet file has a damaged page header.", 422);
      await ensure(pageEnd);
      switch (num(header, 1)) {
        case 0: // DATA_PAGE: values, which are rows unless the column is repeated
          covered += num(struct(header, 5), 1) ?? 0;
          break;
        case 3: {
          // DATA_PAGE_V2 counts rows itself
          const v2 = struct(header, 8);
          covered += chunk.repeated ? (num(v2, 3) ?? 0) * 32 : (num(v2, 3) ?? num(v2, 1) ?? 0);
          break;
        }
        // DICTIONARY_PAGE and INDEX_PAGE hold no rows.
      }
      position = pageEnd;
    }
    // Only whole pages: anything after them stays a hole, which DuckDB reports as an error
    // rather than misreading.
    pieces.push({ start: chunk.start, bytes: buffer.subarray(0, position - chunk.start) });
  });

  return { pieces, columns, bytesRead };
}

/** Writes a file of `size` bytes holding only `pieces`; the rest are holes that take no disk. */
export async function writeSparse(path: string, size: number, pieces: { start: number; bytes: Uint8Array }[]): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.truncate(size);
    for (const piece of pieces) {
      if (piece.bytes.length) await handle.write(piece.bytes, 0, piece.bytes.length, piece.start);
    }
  } finally {
    await handle.close();
  }
}

/** Reads ranges of `key` for planRows, through the driver. */
export const fetcherFor = (driver: StorageDriver, key: string) => async (start: number, end: number) =>
  (await readBytes(driver, key, start, end)).bytes;
