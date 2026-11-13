import "server-only";

/**
 * A reader for Apache Thrift's compact protocol — just enough to parse Parquet's footer and
 * page headers, which is all jvinu needs to work out which bytes of a file to fetch.
 * Structs come back as maps of field id → value; nothing is interpreted here.
 */
export type ThriftStruct = Map<number, ThriftValue>;
export type ThriftValue = boolean | number | Uint8Array | ThriftStruct | ThriftValue[] | [ThriftValue, ThriftValue][];

export class ThriftError extends Error {}

/** Thrown when the buffer ends mid-value: the caller can fetch more bytes and try again. */
export class ThriftTruncated extends ThriftError {}

const MAX_DEPTH = 64;

export class CompactReader {
  pos: number;

  constructor(
    readonly buf: Uint8Array,
    start = 0,
  ) {
    this.pos = start;
  }

  private byte(): number {
    if (this.pos >= this.buf.length) throw new ThriftTruncated("Thrift data ends early.");
    return this.buf[this.pos++];
  }

  /** An unsigned varint. Exact up to 2^53, which covers every offset and count in a real file. */
  private varint(): number {
    let result = 0;
    let scale = 1;
    for (let shift = 0; shift < 70; shift += 7) {
      const b = this.byte();
      result += (b & 0x7f) * scale;
      if (!(b & 0x80)) return result;
      scale *= 128;
    }
    throw new ThriftError("Malformed varint.");
  }

  /** A zigzag-encoded signed varint (i16, i32, i64). */
  private zigzag(): number {
    const n = this.varint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }

  private bytes(length: number): Uint8Array {
    if (length < 0) throw new ThriftError("Negative length.");
    if (this.pos + length > this.buf.length) throw new ThriftTruncated("Thrift data ends early.");
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  readStruct(depth = 0): ThriftStruct {
    if (depth > MAX_DEPTH) throw new ThriftError("Thrift data nests too deeply.");
    const out: ThriftStruct = new Map();
    let lastId = 0;
    for (;;) {
      const header = this.byte();
      if (header === 0) return out;
      const type = header & 0x0f;
      const delta = header >> 4;
      const id = delta ? lastId + delta : this.zigzag();
      lastId = id;
      // In a struct, a boolean's value is its type code.
      if (type === 1 || type === 2) out.set(id, type === 1);
      else out.set(id, this.value(type, depth));
    }
  }

  private value(type: number, depth: number): ThriftValue {
    switch (type) {
      case 1:
      case 2:
        return this.byte() === 1; // a boolean inside a collection is one byte
      case 3: {
        const b = this.byte();
        return b > 127 ? b - 256 : b;
      }
      case 4:
      case 5:
      case 6:
        return this.zigzag();
      case 7: {
        const raw = this.bytes(8);
        return new DataView(raw.buffer, raw.byteOffset, 8).getFloat64(0, true);
      }
      case 8:
        return this.bytes(this.varint());
      case 9:
      case 10: {
        const header = this.byte();
        let size = header >> 4;
        const elementType = header & 0x0f;
        if (size === 15) size = this.varint();
        // Every element takes at least one byte: a cheap guard against garbage sizes.
        if (size > this.buf.length - this.pos && elementType !== 1 && elementType !== 2) {
          if (size > this.buf.length) throw new ThriftError("Implausible list size.");
          throw new ThriftTruncated("Thrift data ends early.");
        }
        const list: ThriftValue[] = [];
        for (let i = 0; i < size; i++) list.push(this.value(elementType, depth + 1));
        return list;
      }
      case 11: {
        const size = this.varint();
        if (size === 0) return [];
        const kinds = this.byte();
        const entries: [ThriftValue, ThriftValue][] = [];
        for (let i = 0; i < size; i++) entries.push([this.value(kinds >> 4, depth + 1), this.value(kinds & 0x0f, depth + 1)]);
        return entries;
      }
      case 12:
        return this.readStruct(depth + 1);
      default:
        throw new ThriftError(`Unknown Thrift type ${type}.`);
    }
  }
}

/* ---- Typed accessors over a decoded struct ---------------------------------------------- */

export const num = (s: ThriftStruct | undefined, id: number): number | undefined => {
  const v = s?.get(id);
  return typeof v === "number" ? v : undefined;
};

export const str = (s: ThriftStruct | undefined, id: number): string | undefined => {
  const v = s?.get(id);
  return v instanceof Uint8Array ? new TextDecoder().decode(v) : undefined;
};

export const struct = (s: ThriftStruct | undefined, id: number): ThriftStruct | undefined => {
  const v = s?.get(id);
  return v instanceof Map ? v : undefined;
};

export const list = (s: ThriftStruct | undefined, id: number): ThriftValue[] => {
  const v = s?.get(id);
  return Array.isArray(v) ? (v as ThriftValue[]) : [];
};
