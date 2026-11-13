import "server-only";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import avro from "avsc";
import SnappyJS from "snappyjs";
import { StorageUserError } from "../drivers/types";

/**
 * Avro container files: a header (schema, codec, sync marker), then blocks of records.
 * The block framing is simple enough to walk here — which gives exact record counts without
 * decoding — and avsc decodes the records themselves.
 */

export type AvroScan = {
  schema: unknown;
  codec: string;
  /** Records in the complete blocks within the bytes given. */
  records: number;
  /** One past the last complete block: everything before it decodes cleanly. */
  end: number;
};

const MAGIC = [0x4f, 0x62, 0x6a, 0x01]; // "Obj" 1

class Cursor {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  get left() {
    return this.bytes.length - this.pos;
  }
  /** A zigzag varint long; null when the bytes run out first. */
  long(): number | null {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.bytes.length) return null;
      const b = this.bytes[this.pos++];
      result += (b & 0x7f) * scale;
      if (!(b & 0x80)) return result % 2 === 0 ? result / 2 : -(result + 1) / 2;
      scale *= 128;
    }
    throw new StorageUserError("This Avro file is damaged.", 422);
  }
  take(length: number): Uint8Array | null {
    if (length < 0) throw new StorageUserError("This Avro file is damaged.", 422);
    if (this.pos + length > this.bytes.length) return null;
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }
}

const truncatedHeader = () => new StorageUserError("This Avro file's header is larger than the part that was read.", 422);

/** Reads the header and walks the complete blocks in `bytes` (the start of a file). */
export function scanAvro(bytes: Uint8Array): AvroScan {
  if (bytes.length < 4 || MAGIC.some((b, i) => bytes[i] !== b)) throw new StorageUserError("This doesn't look like an Avro file.", 422);
  const cursor = new Cursor(bytes);
  cursor.pos = 4;
  const meta = new Map<string, Uint8Array>();
  for (;;) {
    let count = cursor.long();
    if (count === null) throw truncatedHeader();
    if (count === 0) break;
    if (count < 0) {
      count = -count;
      if (cursor.long() === null) throw truncatedHeader(); // block size in bytes, unneeded
    }
    for (let i = 0; i < count; i++) {
      const keyLength = cursor.long();
      const key = keyLength === null ? null : cursor.take(keyLength);
      const valueLength = cursor.long();
      const value = valueLength === null ? null : cursor.take(valueLength);
      if (!key || !value) throw truncatedHeader();
      meta.set(new TextDecoder().decode(key), value);
    }
  }
  const sync = cursor.take(16);
  if (!sync) throw truncatedHeader();
  const schemaBytes = meta.get("avro.schema");
  if (!schemaBytes) throw new StorageUserError("This Avro file has no schema.", 422);
  let schema: unknown;
  try {
    schema = JSON.parse(new TextDecoder().decode(schemaBytes));
  } catch {
    throw new StorageUserError("This Avro file's schema isn't valid JSON.", 422);
  }
  const codec = meta.has("avro.codec") ? new TextDecoder().decode(meta.get("avro.codec")) : "null";

  let records = 0;
  let end = cursor.pos;
  for (;;) {
    const start = cursor.pos;
    const count = cursor.long();
    const size = count === null ? null : cursor.long();
    if (count === null || size === null || cursor.left < size + 16) break;
    cursor.pos += size;
    const marker = cursor.take(16)!;
    if (marker.some((b, i) => b !== sync[i])) throw new StorageUserError("This Avro file is damaged: a block's sync marker doesn't match.", 422);
    records += count;
    end = cursor.pos;
    if (start === end) break;
  }
  return { schema, codec, records, end };
}

/* ---- Decoding ------------------------------------------------------------------------- */

type Callback = (error: Error | null, result?: Buffer) => void;

const codecs: Record<string, (buffer: Buffer, cb: Callback) => void> = {
  null: (buffer, cb) => cb(null, buffer),
  deflate: (buffer, cb) => zlib.inflateRaw(buffer, cb),
  // Avro's snappy blocks end in a CRC32 of the uncompressed data.
  snappy: (buffer, cb) => {
    try {
      cb(null, Buffer.from(SnappyJS.uncompress(buffer.subarray(0, buffer.length - 4))));
    } catch (error) {
      cb(error as Error);
    }
  },
};
const zstd = (zlib as unknown as { zstdDecompress?: (buffer: Buffer, cb: Callback) => void }).zstdDecompress;
if (zstd) codecs.zstandard = (buffer, cb) => zstd(buffer, cb);

/** Longs as BigInt: Avro longs routinely exceed JavaScript's safe integers (nanosecond times, ids). */
const BigLong = avro.types.LongType.__with({
  fromBuffer: (buffer: Buffer) => buffer.readBigInt64LE(),
  toBuffer: (value: bigint) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64LE(BigInt(value));
    return buffer;
  },
  fromJSON: (value: unknown) => BigInt(value as string),
  toJSON: (value: bigint) => Number(value),
  isValid: (value: unknown) => typeof value === "bigint",
  compare: (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0),
});

/** Every long, however it's written in the schema ("long", {type: "long", logicalType: …}), as BigInt. */
const longsAsBigInt = (schema: unknown) =>
  schema === "long" || (schema && typeof schema === "object" && (schema as { type?: unknown }).type === "long") ? BigLong : undefined;

/** The first `limit` records of the complete blocks in `bytes`. */
export async function decodeAvro(bytes: Uint8Array, limit: number): Promise<unknown[]> {
  const scan = scanAvro(bytes);
  if (!(scan.codec in codecs)) throw new StorageUserError(`This Avro file uses the “${scan.codec}” codec, which can't be previewed.`, 422);
  const decoder = new avro.streams.BlockDecoder({
    codecs,
    parseHook: (schema: avro.Schema) => avro.Type.forSchema(schema, { typeHook: longsAsBigInt as never }),
  });
  const records: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    const source = Readable.from([Buffer.from(bytes.buffer, bytes.byteOffset, scan.end)]);
    decoder.on("data", (record: unknown) => {
      if (records.length < limit) records.push(record);
      if (records.length >= limit) {
        source.destroy();
        decoder.destroy();
        resolve();
      }
    });
    decoder.on("end", resolve);
    decoder.on("close", resolve);
    decoder.on("error", (error: Error) => reject(new StorageUserError(`Couldn't decode this Avro file: ${error.message.slice(0, 160)}`, 422)));
    source.pipe(decoder);
  });
  return records;
}

/* ---- Presenting ----------------------------------------------------------------------- */

type AvroSchema = string | { type: unknown; [key: string]: unknown } | AvroSchema[];

/** A compact type label: "string?", "array<long>", "struct<a: int, b: string>", "long (timestamp-millis)". */
export function avroType(schema: unknown): string {
  const s = schema as AvroSchema;
  if (typeof s === "string") return s;
  if (Array.isArray(s)) {
    const rest = s.filter((member) => member !== "null");
    const label = rest.length === 1 ? avroType(rest[0]) : `union<${rest.map(avroType).join(", ")}>`;
    return rest.length < s.length ? `${label}?` : label;
  }
  if (s && typeof s === "object") {
    const logical = typeof s.logicalType === "string" ? s.logicalType : undefined;
    let base: string;
    switch (s.type) {
      case "record":
      case "error":
        base = `struct<${((s.fields as { name: string; type: unknown }[]) ?? []).map((f) => `${f.name}: ${avroType(f.type)}`).join(", ")}>`;
        break;
      case "array":
        base = `array<${avroType(s.items)}>`;
        break;
      case "map":
        base = `map<string, ${avroType(s.values)}>`;
        break;
      case "enum":
        base = `enum(${((s.symbols as string[]) ?? []).join(", ")})`;
        break;
      case "fixed":
        base = `fixed(${s.size})`;
        break;
      default:
        base = avroType(s.type);
    }
    if (logical === "decimal") return `${base} (decimal ${s.precision}, ${s.scale ?? 0})`;
    return logical ? `${base} (${logical})` : base;
  }
  return "unknown";
}

export type AvroColumn = { name: string; type: string; logical?: string; scale?: number };

/** Top-level columns: a record's fields, or one "value" column for anything else. */
export function avroColumns(schema: unknown): AvroColumn[] {
  const s = schema as { type?: unknown; fields?: { name: string; type: unknown }[] };
  if (s && typeof s === "object" && !Array.isArray(s) && (s.type === "record" || s.type === "error")) {
    return (s.fields ?? []).map((field) => ({ name: field.name, type: avroType(field.type), ...logicalOf(field.type) }));
  }
  return [{ name: "value", type: avroType(schema), ...logicalOf(schema) }];
}

function logicalOf(schema: unknown): { logical?: string; scale?: number } {
  if (Array.isArray(schema)) {
    const rest = schema.filter((member) => member !== "null");
    return rest.length === 1 ? logicalOf(rest[0]) : {};
  }
  const s = schema as { logicalType?: unknown; scale?: unknown };
  if (!s || typeof s !== "object" || typeof s.logicalType !== "string") return {};
  return { logical: s.logicalType, ...(s.logicalType === "decimal" ? { scale: Number(s.scale ?? 0) } : {}) };
}

/** A decimal's unscaled big-endian two's-complement bytes, with the point put back. */
function decimalText(bytes: Uint8Array, scale: number): string {
  let n = BigInt(0);
  for (const b of bytes) n = (n << BigInt(8)) | BigInt(b);
  if (bytes.length && bytes[0] & 0x80) n -= BigInt(1) << BigInt(bytes.length * 8);
  const negative = n < BigInt(0);
  let digits = (negative ? -n : n).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  return negative ? `-${digits}` : digits;
}

const DAY_MS = 86_400_000;

/** A value as text, the way a SQL console would print it. */
export function avroText(value: unknown, logical?: string, scale = 0): string | null {
  if (value === null || value === undefined) return null;
  if (logical === "decimal" && value instanceof Uint8Array) return decimalText(value, scale);
  if (typeof value === "bigint" || typeof value === "number") {
    const n = Number(value);
    switch (logical) {
      case "date":
        return new Date(n * DAY_MS).toISOString().slice(0, 10);
      case "timestamp-millis":
      case "local-timestamp-millis":
        return new Date(n).toISOString().replace("T", " ").replace("Z", "");
      case "timestamp-micros":
      case "local-timestamp-micros":
        return new Date(Number(BigInt(value) / BigInt(1000))).toISOString().replace("T", " ").replace("Z", "");
    }
    return String(value);
  }
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Uint8Array) return hex(value);
  return render(value);
}

/** Nested values as JSON — except that longs stay exact numbers and bytes show as hex. */
function render(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Uint8Array) return JSON.stringify(hex(value));
  if (Array.isArray(value)) return `[${value.map(render).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => `${JSON.stringify(key)}: ${render(inner)}`)
      .join(", ")}}`;
  return String(value);
}

function hex(bytes: Uint8Array): string {
  const shown = Array.from(bytes.subarray(0, 32), (b) => `\\x${b.toString(16).padStart(2, "0").toUpperCase()}`).join("");
  return bytes.length > 32 ? `${shown}…` : shown;
}
