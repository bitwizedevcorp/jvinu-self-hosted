/**
 * The rclone crypt format: files rclone wrote decrypt here (fixtures made by rclone 1.75),
 * sizes and ranges come out right, tampering is caught — and, with JVINU_TEST_RCLONE=1
 * and Docker, files encrypted here decrypt with rclone itself.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOCK_DATA,
  BLOCK_SIZE,
  decryptBlocks,
  decryptedSize,
  deriveDataKey,
  encryptBuffer,
  encryptedSize,
  encryptStream,
  HEADER_SIZE,
  parseHeader,
  splitHeader,
} from "../app/lib/server/crypt";
import { StorageUserError } from "../app/lib/server/drivers/types";

const PASSPHRASE = "correct horse battery staple";
const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", "rclone", name));
const pattern = (length: number) => Buffer.from(Uint8Array.from({ length }, (_, i) => (i * 31) % 251));

/** A stream that hands out `data` in uneven pieces, like a network read. */
function streamOf(data: Uint8Array, piece = 7000): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.length) return controller.close();
      const size = piece + (offset % 13);
      controller.enqueue(data.slice(offset, offset + size));
      offset += size;
    },
  });
}

const collect = async (stream: ReadableStream<Uint8Array>) => Buffer.from(await new Response(stream).arrayBuffer());

async function decryptAll(key: Uint8Array, ciphertext: Uint8Array) {
  const { nonce, rest } = await splitHeader(streamOf(ciphertext));
  return collect(decryptBlocks(key, nonce, rest, 0));
}

/** What the crypt driver does for a range: header nonce, then only the blocks it needs. */
async function decryptRange(key: Uint8Array, ciphertext: Uint8Array, start: number, end: number) {
  const nonce = parseHeader(ciphertext.subarray(0, HEADER_SIZE));
  const first = Math.floor(start / BLOCK_DATA);
  const last = Math.floor(end / BLOCK_DATA);
  const slice = ciphertext.subarray(HEADER_SIZE + first * BLOCK_SIZE, Math.min(ciphertext.length, HEADER_SIZE + (last + 1) * BLOCK_SIZE));
  return collect(decryptBlocks(key, nonce, streamOf(slice), first, start - first * BLOCK_DATA, end - start + 1));
}

describe("rclone crypt", () => {
  it("decrypts what rclone wrote", async () => {
    const key = await deriveDataKey(PASSPHRASE);
    expect((await decryptAll(key, fixture("hello.txt.bin"))).toString()).toBe("hello from rclone\n");
    expect(await decryptAll(key, fixture("empty.txt.bin"))).toHaveLength(0);
    expect((await decryptAll(key, fixture("pattern.bin.bin"))).equals(pattern(70_000))).toBe(true);
  });

  it("computes sizes both ways, as rclone does", () => {
    expect(encryptedSize(0)).toBe(32);
    expect(encryptedSize(18)).toBe(fixture("hello.txt.bin").length);
    expect(encryptedSize(70_000)).toBe(fixture("pattern.bin.bin").length);
    for (const size of [0, 1, 1000, BLOCK_DATA - 1, BLOCK_DATA, BLOCK_DATA + 1, 3 * BLOCK_DATA, 5_000_000]) {
      expect(decryptedSize(encryptedSize(size))).toBe(size);
    }
    expect(decryptedSize(10)).toBeNull(); // shorter than a header
    expect(decryptedSize(HEADER_SIZE + 16)).toBeNull(); // a block with no data
  });

  it("round-trips any size, streamed or whole", async () => {
    const key = await deriveDataKey("another passphrase");
    for (const size of [0, 1, BLOCK_DATA - 1, BLOCK_DATA, BLOCK_DATA + 1, 200_000]) {
      const plain = pattern(size);
      const streamed = await collect(encryptStream(key, streamOf(plain)));
      expect(streamed.length).toBe(encryptedSize(size));
      expect((await decryptAll(key, streamed)).equals(plain)).toBe(true);
      const whole = encryptBuffer(key, plain);
      expect((await decryptAll(key, whole)).equals(plain)).toBe(true);
      // A fresh random nonce every time: the same plaintext never encrypts the same way.
      if (size) expect(Buffer.from(whole).equals(streamed)).toBe(false);
    }
  });

  it("serves byte ranges from just the blocks they need", async () => {
    const key = await deriveDataKey(PASSPHRASE);
    const plain = pattern(70_000);
    const ciphertext = fixture("pattern.bin.bin");
    for (const [start, end] of [
      [0, 0],
      [0, 99],
      [65_530, 65_545], // straddles the block boundary
      [65_536, 69_999],
      [69_999, 69_999],
      [100, 69_000],
    ]) {
      expect((await decryptRange(key, ciphertext, start, end)).equals(plain.subarray(start, end + 1)), `${start}-${end}`).toBe(true);
    }
  });

  it("refuses tampered files and wrong passphrases", async () => {
    const key = await deriveDataKey(PASSPHRASE);
    const tampered = Buffer.from(fixture("hello.txt.bin"));
    tampered[50] ^= 0x01;
    await expect(decryptAll(key, tampered)).rejects.toBeInstanceOf(StorageUserError);
    const wrong = await deriveDataKey("not the passphrase");
    await expect(decryptAll(wrong, fixture("hello.txt.bin"))).rejects.toMatchObject({ status: 422 });
    expect(() => parseHeader(Buffer.from("not an rclone file at all, really"))).toThrow(StorageUserError);
  });

  it.runIf(process.env.JVINU_TEST_RCLONE === "1")(
    "writes files rclone can decrypt",
    async () => {
      const key = await deriveDataKey(PASSPHRASE);
      const dir = mkdtempSync(path.join(tmpdir(), "jvinu-rclone-"));
      const files = { "small.txt": Buffer.from("written by jvinu\n"), "big.bin": pattern(300_000), "empty.txt": Buffer.alloc(0) };
      for (const [name, plain] of Object.entries(files)) {
        writeFileSync(path.join(dir, `${name}.bin`), await collect(encryptStream(key, streamOf(plain))));
      }
      const obscured = execFileSync("docker", ["run", "--rm", "rclone/rclone:1.75", "obscure", PASSPHRASE]).toString().trim();
      for (const [name, plain] of Object.entries(files)) {
        const out = execFileSync("docker", [
          "run", "--rm", "-v", `${dir}:/data`,
          "-e", "RCLONE_CONFIG_SECRET_TYPE=crypt",
          "-e", "RCLONE_CONFIG_SECRET_REMOTE=/data",
          "-e", `RCLONE_CONFIG_SECRET_PASSWORD=${obscured}`,
          "-e", "RCLONE_CONFIG_SECRET_FILENAME_ENCRYPTION=off",
          "-e", "RCLONE_CONFIG_SECRET_DIRECTORY_NAME_ENCRYPTION=false",
          "rclone/rclone:1.75", "cat", `secret:${name}`,
        ], { maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
        expect(out.equals(plain), name).toBe(true);
      }
    },
    120_000,
  );
});
