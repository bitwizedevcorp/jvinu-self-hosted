# Backups

`scripts/backup.mjs` writes **one encrypted file** with everything needed to bring jvinu back:
the database (a consistent snapshot, taken while jvinu runs), profile photos, and
`JVINU_SECRET` — without which saved connections can't be read. Thumbnails are left out; they
rebuild themselves. Your files in the clouds aren't in it: they're already in the clouds.

```sh
# Docker
docker compose exec -e JVINU_BACKUP_PASSPHRASE='a long passphrase' jvinu \
  node scripts/backup.mjs /data/jvinu-backup.jvbak
docker compose cp jvinu:/data/jvinu-backup.jvbak ./backups/jvinu-$(date +%F).jvbak

# Without Docker (from the jvinu folder, with its environment loaded)
JVINU_BACKUP_PASSPHRASE='a long passphrase' node scripts/backup.mjs ~/backups/jvinu-$(date +%F).jvbak
```

- The passphrase must be at least 16 characters. Keep it **somewhere other than the backups**
  (a password manager): with both, anyone can read the backup, including `JVINU_SECRET`.
  `--without-secret` leaves the secret out, if you'd rather keep it separately.
- Copy each backup **off the machine** (another disk, another provider). A backup on the same
  disk doesn't survive that disk.
- With Postgres (`JVINU_DATABASE_URL`), the script runs `pg_dump`; it must be installed.

A daily backup with cron, keeping 14 days:

```cron
15 3 * * * cd /srv/jvinu && docker compose exec -T -e JVINU_BACKUP_PASSPHRASE="$(cat /root/.jvinu-backup-pass)" jvinu node scripts/backup.mjs /data/nightly.jvbak && docker compose cp jvinu:/data/nightly.jvbak /backups/jvinu-$(date +\%F).jvbak && find /backups -name 'jvinu-*.jvbak' -mtime +14 -delete
```

## Restoring

Into an empty data folder, with jvinu stopped:

```sh
JVINU_BACKUP_PASSPHRASE='…' JVINU_DATA_DIR=/data node scripts/restore.mjs jvinu-backup.jvbak
```

The whole file is checked before anything is unpacked: a wrong passphrase or a damaged file
changes nothing. An existing database is only replaced with `--force`. The secret is written
to `<data folder>/restored-secret.txt`; set it as `JVINU_SECRET`, delete that file, and start
jvinu. **Test a restore now and then** — on another machine or folder — so you know it works.
