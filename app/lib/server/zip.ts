import "server-only";
import { crc32 } from "node:zlib";

/**
 * A streaming ZIP writer, written from PKWARE's APPNOTE. Entries go out one after
 * another, each read from its source only when its turn comes, so memory stays flat however
 * big the archive is. Each entry's CRC and sizes follow its data in a data descriptor.
 * ZIP64 takes over past 4 GiB or 65,535 entries. Names are UTF-8, and an extended
 * timestamp keeps dates right across time zones. Cancelling the stream cancels the read
 * in progress, and nothing after it is opened.
 */

export type ZipEntry = {
  /** Path inside the archive, "/"-separated; a trailing "/" makes it a folder. */
  name: string;
  /** Bytes the source will produce, from the listing. */
  size: number;
  modified: Date;
  method: "store" | "deflate";
  /** Called only when the entry's turn comes. Not called for folders. */
  open?: () => Promise<ReadableStream<Uint8Array>>;
};

const SIG = { local: 0x04034b50, descriptor: 0x08074b50, central: 0x02014b50, end: 0x06054b50, end64: 0x06064b50, locator64: 0x07064b50 };
/** Bit 3: sizes and CRC follow the data. Bit 11: the name is UTF-8. */
const FLAGS = 0x0008 | 0x0800;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** Made by UNIX (3), spec version 4.5 (ZIP64). */
const MADE_BY = (3 << 8) | 45;
/**
 * Entries this big get ZIP64 sizes from the start. Deflate can come out a little larger
 * than its input, and the choice is made before the data is written; this leaves slack.
 */
const ZIP64_FROM = 0xf0000000;

const isFolder = (entry: ZipEntry) => entry.name.endsWith("/");
const needs64 = (entry: ZipEntry) => entry.size >= ZIP64_FROM;

/** MS-DOS date and time, in the server's local time as zip tools expect (1980–2107). */
function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Extended timestamp (0x5455): the modification time in UTC seconds. */
function timestampExtra(date: Date): Buffer {
  const extra = Buffer.alloc(9);
  extra.writeUInt16LE(0x5455, 0);
  extra.writeUInt16LE(5, 2);
  extra.writeUInt8(1, 4); // modification time present
  extra.writeUInt32LE(Math.min(Math.max(Math.floor(date.getTime() / 1000), 0), MAX32), 5);
  return extra;
}

/** ZIP64 extended information (0x0001), with the 8-byte values given, in spec order. */
function zip64Extra(values: number[]): Buffer {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  return extra;
}

function localHeader(entry: ZipEntry, name: Buffer): Buffer {
  const zip64 = needs64(entry);
  // With a data descriptor, the local header's CRC and sizes are zero, or 0xFFFFFFFF with a
  // zeroed ZIP64 field (APPNOTE 4.5.3).
  const extra = Buffer.concat([...(zip64 ? [zip64Extra([0, 0])] : []), timestampExtra(entry.modified)]);
  const { time, day } = dosDateTime(entry.modified);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(SIG.local, 0);
  header.writeUInt16LE(zip64 ? 45 : 20, 4);
  header.writeUInt16LE(FLAGS, 6);
  header.writeUInt16LE(entry.method === "deflate" ? 8 : 0, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(day, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(zip64 ? MAX32 : 0, 18);
  header.writeUInt32LE(zip64 ? MAX32 : 0, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, name, extra]);
}

function descriptor(entry: ZipEntry, crc: number, compressed: number, size: number): Buffer {
  if (needs64(entry)) {
    const out = Buffer.alloc(24);
    out.writeUInt32LE(SIG.descriptor, 0);
    out.writeUInt32LE(crc, 4);
    out.writeBigUInt64LE(BigInt(compressed), 8);
    out.writeBigUInt64LE(BigInt(size), 16);
    return out;
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(SIG.descriptor, 0);
  out.writeUInt32LE(crc, 4);
  out.writeUInt32LE(compressed, 8);
  out.writeUInt32LE(size, 12);
  return out;
}

const descriptorLength = (entry: ZipEntry) => (needs64(entry) ? 24 : 16);

function centralHeader(entry: ZipEntry, name: Buffer, at: { offset: number; crc: number; compressed: number; size: number }): Buffer {
  const sizes64 = needs64(entry);
  const offset64 = at.offset >= MAX32;
  const values = [...(sizes64 ? [at.size, at.compressed] : []), ...(offset64 ? [at.offset] : [])];
  const extra = Buffer.concat([...(values.length ? [zip64Extra(values)] : []), timestampExtra(entry.modified)]);
  const { time, day } = dosDateTime(entry.modified);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(SIG.central, 0);
  header.writeUInt16LE(MADE_BY, 4);
  header.writeUInt16LE(values.length ? 45 : 20, 6);
  header.writeUInt16LE(FLAGS, 8);
  header.writeUInt16LE(entry.method === "deflate" ? 8 : 0, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(day, 14);
  header.writeUInt32LE(at.crc, 16);
  header.writeUInt32LE(sizes64 ? MAX32 : at.compressed, 20);
  header.writeUInt32LE(sizes64 ? MAX32 : at.size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // internal attributes
  // rw-r--r-- files and rwxr-xr-x folders (plus the MS-DOS folder bit).
  header.writeUInt32LE(isFolder(entry) ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(offset64 ? MAX32 : at.offset, 42);
  return Buffer.concat([header, name, extra]);
}

function endRecords(count: number, centralOffset: number, centralSize: number): Buffer {
  const zip64 = count > MAX16 || centralOffset >= MAX32 || centralSize >= MAX32;
  const parts: Buffer[] = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(SIG.end64, 0);
    record.writeBigUInt64LE(BigInt(44), 4); // size of the rest of this record
    record.writeUInt16LE(MADE_BY, 12);
    record.writeUInt16LE(45, 14);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(0, 20);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(centralSize), 40);
    record.writeBigUInt64LE(BigInt(centralOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(SIG.locator64, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG.end, 0);
  end.writeUInt16LE(Math.min(count, MAX16), 8);
  end.writeUInt16LE(Math.min(count, MAX16), 10);
  end.writeUInt32LE(Math.min(centralSize, MAX32), 12);
  end.writeUInt32LE(Math.min(centralOffset, MAX32), 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/**
 * The archive's exact length when every entry is stored (no compression) — so a browser
 * can show progress — or null when something is deflated.
 */
export function zipLength(entries: ZipEntry[]): number | null {
  if (entries.some((entry) => entry.method !== "store" && !isFolder(entry))) return null;
  let offset = 0;
  let central = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const size = isFolder(entry) ? 0 : entry.size;
    central += centralHeader(entry, name, { offset, crc: 0, compressed: size, size }).length;
    offset += localHeader(entry, name).length + size + descriptorLength(entry);
  }
  return offset + central + endRecords(entries.length, offset, central).length;
}

const truncated = (entry: ZipEntry, got: number) =>
  new Error(`“${entry.name}” changed while it was being zipped (expected ${entry.size} bytes, got ${got}).`);

/** The note added to an archive listing files that couldn't be read. */
export const SKIPPED_NOTE = "jvinu-skipped.txt";

/**
 * The archive, as a stream.
 * - `exactSizes`: an entry that reads a different size than planned errors the stream (the
 *   length was promised up front).
 * - `skippable`: a file whose source can't be opened for this reason is left out, and named
 *   in a note at the end of the archive. Not with `exactSizes`.
 */
export function zipStream(
  entries: ZipEntry[],
  { exactSizes = false, skippable }: { exactSizes?: boolean; skippable?: (error: unknown) => string | null } = {},
): ReadableStream<Uint8Array> {
  let cancelled = false;
  let reading: ReadableStreamDefaultReader<Uint8Array> | null = null;

  let offset = 0;
  const central: Buffer[] = [];

  /** One entry: local header, data, descriptor; its central record is kept for the end. */
  async function* write(entry: ZipEntry, source: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
    const name = Buffer.from(entry.name, "utf8");
    const local = localHeader(entry, name);
    yield local;
    const start = offset;
    offset += local.length;

    let crc = 0;
    let size = 0;
    let compressed = 0;
    if (source) {
      // Count and checksum what goes in; count again what comes out of the compressor.
      const counted = source.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            crc = crc32(chunk, crc);
            size += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      );
      // CompressionStream's types accept any BufferSource; Uint8Array chunks are what it gets.
      const body =
        entry.method === "deflate" ? counted.pipeThrough(new CompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>) : counted;
      reading = body.getReader();
      try {
        for (;;) {
          const { value, done } = await reading.read();
          if (done || cancelled) break;
          compressed += value.byteLength;
          yield value;
        }
      } finally {
        reading.releaseLock();
        reading = null;
      }
      if (cancelled) return;
      if (exactSizes && size !== entry.size) throw truncated(entry, size);
    }
    const after = descriptor(entry, crc >>> 0, compressed, size);
    yield after;
    offset += compressed + after.length;
    central.push(centralHeader(entry, name, { offset: start, crc: crc >>> 0, compressed, size }));
  }

  async function* produce(): AsyncGenerator<Uint8Array> {
    const skipped: string[] = [];
    for (const entry of entries) {
      if (cancelled) return;
      // Open first: a file that can't be read is left out before anything of it is written.
      let source: ReadableStream<Uint8Array> | null = null;
      if (!isFolder(entry)) {
        try {
          source = await entry.open!();
        } catch (error) {
          const reason = !exactSizes && skippable ? skippable(error) : null;
          if (reason === null) throw error;
          skipped.push(`${entry.name} — ${reason}`);
          continue;
        }
      }
      if (cancelled) {
        await source?.cancel().catch(() => {});
        return;
      }
      yield* write(entry, source);
    }
    if (cancelled) return;
    if (skipped.length) {
      const note = Buffer.from(`These files couldn't be read, so they aren't in this archive:\n\n${skipped.join("\n")}\n`, "utf8");
      yield* write({ name: SKIPPED_NOTE, size: note.length, modified: new Date(), method: "deflate" }, new Response(note).body!);
    }
    if (cancelled) return;
    const centralDirectory = Buffer.concat(central);
    yield centralDirectory;
    yield endRecords(central.length, offset, centralDirectory.length);
  }

  const chunks = produce();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      // Stop the read in progress at once (it may be a long download from the cloud);
      // the loop sees the flag and opens nothing more.
      cancelled = true;
      await reading?.cancel(reason).catch(() => {});
    },
  });
}

/** Already-compressed formats gain nothing from deflate: they're stored as they are. */
const STORED = new Set(
  (
    "jpg jpeg png gif webp avif heic heif tif tiff bmp ico " +
    "mp4 m4v mov mkv webm avi wmv mpg mpeg ogv 3gp " +
    "mp3 m4a aac ogg oga opus flac wma " +
    "zip gz tgz bz2 xz zst 7z rar lz4 br jar apk ipa dmg " +
    "docx xlsx pptx odt ods odp epub pdf woff woff2"
  ).split(" "),
);

export const methodFor = (name: string): ZipEntry["method"] =>
  STORED.has(name.split(".").pop()?.toLowerCase() ?? "") ? "store" : "deflate";
