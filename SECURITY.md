# Security

jvinu holds the keys to your storage, so it's built to keep them — and your files — on your
server. This page says what it stores, what it sends, and how to report a problem.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's **private vulnerability reporting** on this
repository (Security → Report a vulnerability). Expect a reply within a few days; fixes are
released as soon as they're ready and credited unless you'd rather not be named.

## No telemetry

jvinu sends nothing about you, your server or your files anywhere. There's no analytics, no
crash reporting, no update check and no licence server. The only outbound connections are the
ones you configure:

- the storage services you connect (S3, Azure, Google Cloud, OCI, Dropbox, OneDrive…);
- your OIDC provider, if you set up single sign-on;
- the waitlist URL, only if you set `JVINU_WAITLIST_URL`, and only with what someone types
  into that form.

## What's stored, and how

| What | Where | Protection |
| --- | --- | --- |
| Cloud credentials | The database (`/data` or Postgres) | AES-256-GCM under a key derived (HKDF-SHA-256) from `JVINU_SECRET`, bound to the connection id. Never sent to the browser. |
| jvinu encryption keys | The database | Derived from your passphrase (rclone's scrypt parameters), sealed like credentials. The passphrase itself isn't kept. |
| Sessions | The database and an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS) | Only a SHA-256 of the session token is stored. Every change also needs a per-session CSRF token and a same-origin request. A new password signs the other sessions out, whether it's changed in the browser or in `JVINU_ADMIN_PASSWORD` (checked at startup). |
| Admin password chosen in the browser | The database | A scrypt hash only. Choosing it needs a one-time setup code from the server's log. `JVINU_ADMIN_PASSWORD`, when set, takes over. |
| Share links | The database | Only a hash of each token; passwords as scrypt hashes; wrong guesses back off. |
| Thumbnails | `/data/thumbs` | Size-capped; sealed with the connection's key when the connection uses jvinu encryption. |
| Folder notes, stars, pins | The database | Plain text: don't put secrets in notes. |
| Connection history | The database | Who did what, and when; no IP addresses. Kept 180 days. |

What the browser keeps (cookies and local settings) is listed at `/cookies`.

Back up `/data` (or the database) **together with** `JVINU_SECRET`; one is useless without the other.

## Safe defaults

- **Two-step sign-in** for the admin password: an authenticator-app code (each usable once)
  plus ten single-use recovery codes, kept as hashes. Turned on under Sign-in & security.
- **Signed-in devices** are listed there too, each with a sign-out.
- **Backups are encrypted.** `scripts/backup.mjs` writes one AES-256-GCM file under a
  passphrase (scrypt), holding the database, photos and `JVINU_SECRET`; see docs/backups.md.
- **Roles.** Only admins add or disconnect storage, change a connection's settings or
  read-only, or manage the storage plan; members use what's connected. With single sign-on,
  `JVINU_ADMINS` says who's an admin.
- **Scripts need a per-request nonce.** Every page's Content Security Policy allows only
  scripts carrying a nonce made fresh for that request, so an injected script can't run.
- **Paths stay where they belong.** File keys with "." or ".." folders are refused before any
  provider sees them, so nothing can step out of a connection's folder, container or bucket.
- **Sign-in can't be locked from outside.** A browser that has signed in before keeps its own
  count of wrong passwords, so a flood of guesses elsewhere can't lock its owner out.
- **Certificates are always checked in production.** `NODE_TLS_REJECT_UNAUTHORIZED=0` is
  ignored unless `JVINU_ALLOW_INSECURE_TLS=1`.
- **Every request body has a size limit**, signed in or not.

- **New connections are read-only.** The server refuses every upload, rename, move, copy into
  and delete until you turn writes on for that connection.
- **Data-lake tables are guarded.** Deleting, moving or uploading inside a Delta, Iceberg or
  Hudi table stops to explain what breaks; it goes ahead only when confirmed.
- **Files never run as the app.** Objects served through jvinu carry a sandboxing Content
  Security Policy; HTML, SVG and XML are always downloaded, never rendered inline. The app sets
  a strict CSP, `X-Frame-Options: DENY`, `nosniff`, HSTS and a narrow `Permissions-Policy`;
  API answers carry `Cross-Origin-Resource-Policy: same-origin`.
- **Nothing connects to a cloud metadata service.** Custom endpoints may point at localhost or
  your LAN, but never at a link-local address (169.254.0.0/16, fe80::/10) or another metadata
  address, however it's written (decimal, IPv4-mapped IPv6, NAT64). Every address a hostname
  resolves to is checked again when a connection is made, so DNS can't point a harmless-looking
  name there later. Only plain http(s) origins are accepted.
- **Sign-in is throttled**: wrong passwords, current passwords and setup codes share one limit.
  OIDC refuses to start without an allowlist unless you opt out explicitly.
- **Requests anyone can send are small.** Sign-in, first-run setup and share-link downloads
  read at most 16 KB of a request body, and stop reading as soon as it's passed.

## SQL on files

Queries run in a separate, in-memory DuckDB per query. Before your SQL reaches it:

- the files the query names are copied into a private scratch folder, and DuckDB is limited to
  that folder (`allowed_directories`, `enable_external_access = false`) — it can't read other
  files on the server, reach the network, or load extensions;
- its settings are locked (`lock_configuration`), with a memory cap (`JVINU_SQL_MEMORY`), a
  time limit (`JVINU_SQL_TIMEOUT_S`) and a cap on how much may be fetched (`JVINU_SQL_MAX_MB`);
- DuckDB's own parser checks there's exactly one statement and that it only reads
  (SELECT or EXPLAIN).

The scratch folder is deleted when the query ends. Read-only connections can be queried;
saving results needs a connection that takes writes.

## Known limits

- One sign-in role: everyone who can sign in can use every connection.
- Without `JVINU_TRUST_PROXY=1` behind a proxy, sign-in attempts share one counter, so a flood
  of wrong passwords can hold sign-in back for 15 minutes.
- The app's Content Security Policy allows inline scripts, which Next.js needs to hydrate pages
  that are built ahead of time. No page renders HTML from users or their files.
- A SQL query can see its own scratch folder's path (`duckdb_settings()`), but nothing in it
  beyond the files it asked for.
- Background jobs run inside the server process; a restart marks them interrupted.
