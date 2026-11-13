# Run your own storage

jvinu can bring its own storage: a [Garage](https://garagehq.deuxfleurs.fr) server, an
S3-compatible store built for modest hardware, set up and connected for you. Any spare PC
that runs Docker will do.

> **One disk means no redundancy.** Bundled storage keeps exactly one copy of every file,
> on one disk. If that disk dies, the files are gone. Back up the volumes (below), or keep
> copies of anything important elsewhere.

## Start it

```bash
cp .env.example .env      # set JVINU_SECRET
docker compose --profile storage up -d
```

Open <http://localhost:3000/dashboard> and sign in. The first time, you choose the
password, with the setup code from `docker compose logs jvinu`. **My storage** is already
in the sidebar, with a bucket called `my-files`. There's nothing else to configure.

On first start:

1. `garage-init` generates Garage's secrets (an RPC secret and an admin token) into the
   `garage-secrets` volume. It only ever creates missing ones.
2. `garage` starts as a single node.
3. jvinu, through Garage's admin API: assigns the node its storage role, creates an
   access key named `jvinu` and the `my-files` bucket, and saves the **My storage**
   connection, encrypted like any other.

Every step checks before it creates. Restarting, upgrading or running the command again
makes no new keys, buckets or connections, and touches no files. If the storage volume is
reset, jvinu makes a new key and points the same connection at it.

**My storage** belongs to the server: it can't be disconnected and its keys can't be
changed in the app. You can still rename it or make it read-only. Without
`--profile storage`, jvinu runs exactly as before.

## Where your files live

| What | Where (default) | Set with |
| --- | --- | --- |
| Files | Docker volume `jvinu_garage-data` | `JVINU_STORAGE_PATH=/mnt/bigdisk/jvinu-data` |
| Garage metadata | Docker volume `jvinu_garage-meta` | `JVINU_STORAGE_META_PATH=/srv/jvinu-meta` |
| Garage secrets | Docker volume `jvinu_garage-secrets` | — |
| jvinu's database | Docker volume `jvinu_jvinu-data` | — |

(Volume names start with the compose project name, the folder you run compose from.)

To store files on a particular disk, set `JVINU_STORAGE_PATH` in `.env` before the first
start. Metadata is small but busy; an SSD is ideal for `JVINU_STORAGE_META_PATH`.

## Disk space

The sidebar shows how full the disk under the storage is.

- **85% full:** a warning banner appears on My storage.
- **95% full:** uploads and copies to My storage are refused with a clear message, so the
  disk never fills completely. Deleting and moving still work.

These are percentages of the whole disk the files sit on, so other things on that disk count
too.

## Back it up

Stop Garage for a consistent copy, archive the four volumes, and start it again:

```bash
docker compose stop garage jvinu
for v in garage-data garage-meta garage-secrets jvinu-data; do
  docker run --rm -v jvinu_$v:/v -v "$PWD/backup:/backup" busybox \
    tar czf /backup/$v.tgz -C /v .
done
docker compose --profile storage up -d
```

Keep `JVINU_SECRET` with the backup. Without it the saved connections can't be read.
Garage also snapshots its metadata every 6 hours inside the metadata volume.

To restore, create empty volumes, then reverse the `tar` (`tar xzf … -C /v`) before
starting.

## Use it from other tools

Inside the compose network, the S3 API is at `http://garage:3900`, region `garage`. By
default it isn't published to your network at all.

To let other apps use it (rclone, backup tools, a NAS), publish it in `.env`:

```bash
COMPOSE_PROFILES=storage,storage-s3   # port 3900 on all interfaces
# JVINU_STORAGE_S3_PORT=3900
# JVINU_STORAGE_S3_BIND=192.168.1.20 # one interface only
```

Give each tool its own key rather than reusing jvinu's:

```bash
docker compose exec garage /garage key create my-tool
docker compose exec garage /garage bucket allow --read --write my-files --key my-tool
```

Use path-style addressing, endpoint `http://<this-pc>:3900`, region `garage`.

## Reach it from outside your home

Don't forward ports on your router. Use one of these instead:

- **[Tailscale](https://tailscale.com):** install it on this PC and on your devices. jvinu
  is then at `http://<this-pc>:3000` from anywhere on your tailnet. `tailscale serve` can
  put it behind HTTPS.
- **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):**
  run `cloudflared` on this PC and route a hostname to `http://localhost:3000`. Set
  `JVINU_TRUST_PROXY=1`, and `JVINU_PUBLIC_URL` if you use single sign-on.

### Share links

A share link has to point somewhere the recipient can reach, and Garage is private by
default. So My storage serves shared files **through jvinu**, to signed-in users, as it
does for Oracle Cloud.

For real links anyone can open, publish the S3 port (above), route a public hostname to
it (for example a second Cloudflare Tunnel route to `http://localhost:3900`), and set:

```bash
JVINU_STORAGE_PUBLIC_URL=https://s3.example.com
```

Links are then signed for that address, with the expiry you pick in the app.

## Remove it

`docker compose --profile storage down` stops it and keeps everything. My storage stays in
the sidebar and shows as unreachable until storage runs again. Adding `-v` deletes the
volumes, **including every stored file**.
