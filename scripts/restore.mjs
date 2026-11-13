#!/usr/bin/env node
/**
 * Brings back a backup made by scripts/backup.mjs, into an empty data folder.
 *
 *   JVINU_BACKUP_PASSPHRASE='…' JVINU_DATA_DIR=/data node scripts/restore.mjs backup.jvbak
 *   … --force    replace a database that's already there (stop jvinu first)
 *
 * The backup is checked whole (its authentication tag) before anything is unpacked, so a
 * wrong passphrase or a damaged file changes nothing. JVINU_SECRET, if the backup holds it,
 * is written to <data folder>/restored-secret.txt (readable only by you): put it in the
 * environment as JVINU_SECRET, then delete that file. Postgres dumps are restored with
 * pg_restore into the database JVINU_DATABASE_URL names.
 */
import { spawnSync } from "node:child_process";
import { createDecipheriv, scryptSync } from "node:crypto";
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("JVBAK1");
const HEADER = MAGIC.length + 16 + 12;
const TAG = 16;
const fail = (message) => {
  console.error(`restore: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const force = args.includes("--force");
if (!file || !existsSync(file)) fail("name the backup file: node scripts/restore.mjs <file.jvbak>");
const passphrase = process.env.JVINU_BACKUP_PASSPHRASE ?? "";
if (!passphrase) fail("set JVINU_BACKUP_PASSPHRASE to the passphrase the backup was made with.");

const size = statSync(file).size;
if (size < HEADER + TAG) fail("that file is too short to be a jvinu backup.");
const fd = openSync(file, "r");
const header = Buffer.alloc(HEADER);
const tag = Buffer.alloc(TAG);
readSync(fd, header, 0, HEADER, 0);
readSync(fd, tag, 0, TAG, size - TAG);
closeSync(fd);
if (!header.subarray(0, MAGIC.length).equals(MAGIC)) fail("that isn't a jvinu backup (or it's from a newer version).");
const salt = header.subarray(MAGIC.length, MAGIC.length + 16);
const iv = header.subarray(MAGIC.length + 16, HEADER);
const key = scryptSync(passphrase, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });

const work = mkdtempSync(path.join(tmpdir(), "jvinu-restore-"));
const tarball = path.join(work, "backup.tar.gz");
const decipher = createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(tag);
try {
  await pipeline(createReadStream(file, { start: HEADER, end: size - TAG - 1 }), decipher, createWriteStream(tarball, { mode: 0o600 }));
} catch {
  rmSync(work, { recursive: true, force: true });
  fail("the passphrase is wrong, or the file is damaged. Nothing was changed.");
}

if (spawnSync("tar", ["-xzf", tarball, "-C", work], { stdio: "inherit" }).status !== 0) fail("couldn't unpack the backup.");
const stage = path.join(work, "jvinu-backup");
const manifest = JSON.parse(readFileSync(path.join(stage, "manifest.json"), "utf8"));
const dataDir = process.env.JVINU_DATA_DIR || path.join(process.cwd(), ".data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

if (manifest.database === "sqlite") {
  const target = path.join(dataDir, "jvinu.db");
  if (existsSync(target) && !force) fail(`${target} already exists. Stop jvinu and add --force to replace it.`);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(target + suffix, { force: true });
  cpSync(path.join(stage, "jvinu.db"), target);
} else {
  const url = process.env.JVINU_DATABASE_URL ?? "";
  if (!/^postgres(ql)?:\/\//.test(url)) fail("this backup is of a Postgres database: set JVINU_DATABASE_URL to the one to restore into.");
  const restored = spawnSync("pg_restore", ["--no-owner", ...(force ? ["--clean", "--if-exists"] : []), "--dbname", url, path.join(stage, "jvinu.pgdump")], {
    stdio: "inherit",
  });
  if (restored.status !== 0) fail("pg_restore failed.");
}
if (existsSync(path.join(stage, "avatars"))) cpSync(path.join(stage, "avatars"), path.join(dataDir, "avatars"), { recursive: true });

if (manifest.secret) {
  const secretFile = path.join(dataDir, "restored-secret.txt");
  writeFileSync(secretFile, `${manifest.secret}\n`, { mode: 0o600 });
  console.log(`restore: JVINU_SECRET is in ${secretFile} — set it in the environment, then delete that file.`);
} else {
  console.log("restore: this backup doesn't hold JVINU_SECRET; use the one it was made with.");
}
rmSync(work, { recursive: true, force: true });
console.log(`restore: done (backup from ${manifest.createdAt}). Start jvinu.`);
