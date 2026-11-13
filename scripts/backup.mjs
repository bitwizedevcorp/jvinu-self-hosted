#!/usr/bin/env node
/**
 * One encrypted file holding everything needed to bring jvinu back: the database (a
 * consistent snapshot, taken while jvinu runs), profile photos, and JVINU_SECRET — without
 * which the saved connections can't be read. Thumbnails are left out; they're rebuilt.
 *
 *   JVINU_BACKUP_PASSPHRASE='a long passphrase' node scripts/backup.mjs /backups/jvinu-$(date +%F).jvbak
 *   … --without-secret      leave JVINU_SECRET out (then keep it safe some other way)
 *
 * In Docker:  docker compose exec -e JVINU_BACKUP_PASSPHRASE jvinu node scripts/backup.mjs /data/backup.jvbak
 * and copy the file somewhere else: a backup on the same disk isn't one.
 *
 * Format: "JVBAK1" | salt (16) | iv (12) | AES-256-GCM(tar.gz) | tag (16), with the key
 * derived from the passphrase by scrypt (N=2^17). Restore with scripts/restore.mjs.
 */
import { spawnSync } from "node:child_process";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("JVBAK1");
const fail = (message) => {
  console.error(`backup: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const out = args.find((arg) => !arg.startsWith("--"));
const withSecret = !args.includes("--without-secret");
if (!out) fail("say where to write it: node scripts/backup.mjs <file.jvbak>");
const passphrase = process.env.JVINU_BACKUP_PASSPHRASE ?? "";
if (passphrase.length < 16) fail("set JVINU_BACKUP_PASSPHRASE to at least 16 characters (it encrypts the backup).");
if (withSecret && !process.env.JVINU_SECRET) fail("JVINU_SECRET isn't set here; run this where jvinu runs, or pass --without-secret.");

const dataDir = process.env.JVINU_DATA_DIR || path.join(process.cwd(), ".data");
const work = mkdtempSync(path.join(tmpdir(), "jvinu-backup-"));
const stage = path.join(work, "jvinu-backup");
mkdirSync(stage, { recursive: true, mode: 0o700 });
if (existsSync(path.join(dataDir, "avatars"))) cpSync(path.join(dataDir, "avatars"), path.join(stage, "avatars"), { recursive: true });

const databaseUrl = process.env.JVINU_DATABASE_URL ?? "";
let database;
if (/^postgres(ql)?:\/\//.test(databaseUrl)) {
  const dump = spawnSync("pg_dump", ["--format=custom", "--no-owner", "--file", path.join(stage, "jvinu.pgdump"), databaseUrl], { stdio: "inherit" });
  if (dump.status !== 0) fail("pg_dump failed (is it installed, and can it reach the database?).");
  database = "postgres";
} else {
  const file = path.join(dataDir, "jvinu.db");
  if (!existsSync(file)) fail(`no database at ${file}; set JVINU_DATA_DIR.`);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  // A consistent copy even while jvinu is writing (WAL mode).
  const target = path.join(stage, "jvinu.db");
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  db.close();
  database = "sqlite";
}

writeFileSync(
  path.join(stage, "manifest.json"),
  JSON.stringify({ format: 1, createdAt: new Date().toISOString(), database, secret: withSecret ? process.env.JVINU_SECRET : null }, null, 2),
  { mode: 0o600 },
);

const tarball = path.join(work, "backup.tar.gz");
const tar = spawnSync("tar", ["-czf", tarball, "-C", work, "jvinu-backup"], { stdio: "inherit" });
if (tar.status !== 0) fail("tar failed.");

const salt = randomBytes(16);
const iv = randomBytes(12);
const key = scryptSync(passphrase, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const cipher = createCipheriv("aes-256-gcm", key, iv);
// Header, then the ciphertext, then the tag (known only once the cipher has finished).
await pipeline(
  createReadStream(tarball),
  cipher,
  async function* (ciphertext) {
    yield Buffer.concat([MAGIC, salt, iv]);
    for await (const chunk of ciphertext) yield chunk;
    yield cipher.getAuthTag();
  },
  createWriteStream(out, { mode: 0o600 }),
);
rmSync(work, { recursive: true, force: true });

console.log(`backup: wrote ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB, ${database}${withSecret ? ", with JVINU_SECRET" : ""}).`);
console.log("backup: copy it off this machine, and keep the passphrase somewhere other than the backup.");
