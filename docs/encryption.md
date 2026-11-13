# Encryption

jvinu offers two kinds of encryption. They protect against different things, and you can
use both on the same connection.

| | Provider encryption at rest | jvinu encryption |
| --- | --- | --- |
| Who holds the key | The provider | You (a passphrase); this server keeps a sealed copy |
| Protects against | Lost or stolen disks at the provider | The provider, or anyone with access to the bucket, reading your files |
| The provider can read your files | Yes | No: it only ever stores ciphertext |
| Direct and signed links | Work as usual | Not possible: files are served through jvinu |
| Can be turned on later | Yes, for new uploads | No: chosen when you connect |

## Provider encryption at rest

Most clouds encrypt everything they store, always: Azure, Google Cloud, Oracle, Cloudflare
R2 and Wasabi. On Amazon S3 and Backblaze B2 it is an option (SSE-S3 or SSE-B2, with keys
the provider manages). Switch it on under **Settings** (the gear icon on a connection) →
**Encryption at rest**. From then on, every upload and copy made through jvinu asks for
it. Files that are already stored keep whatever encryption they had. The inspector shows
each file's status.

This protects the provider's disks. It does not keep your files from the provider itself.

## jvinu encryption

Turn it on when you connect: tick **Encrypt files with a passphrase**. jvinu then encrypts
every file on this server before uploading it, and decrypts it on the way back. The bucket
only ever holds ciphertext. Everything else works as before: browsing, previews, video
seeking, search, thumbnails, copies, moves and analytics.

The format is [rclone crypt](https://rclone.org/crypt/), so the files are not locked into
jvinu. rclone can read what jvinu writes, and jvinu can read what rclone writes.

▶ **[Watch it in under a minute](../public/media/jvinu-encryption.mp4)**. The video
connects a bucket with a passphrase and uploads a few files. It then opens the same bucket
without the passphrase, where only ciphertext is visible, and decrypts the files with
rclone.

### Before you start

- **Lose the passphrase, lose the files.** Nobody can reset it: not jvinu, and not your
  provider. This server keeps a sealed copy of the key, so day to day you never type the
  passphrase again. But if the server's data or `JVINU_SECRET` is lost, the passphrase is
  the only way back in, through jvinu or rclone. Write it down somewhere safe.
- **Use an empty bucket** (or an empty folder, on Dropbox and OneDrive). An encrypted
  connection only shows the files it can decrypt, so jvinu refuses a bucket that already
  holds unencrypted files rather than hide them from you.
- **Choose a passphrase of at least 12 characters.** A few unrelated words work well.
- **It's set for good.** The passphrase can't be changed, and encryption can't be turned
  off on that connection. rclone has the same rule, because the key comes from the
  passphrase. To move to a new passphrase, connect a new empty bucket and copy the files
  across.

### What stays visible

Version 1 encrypts file **contents** only. The provider can still see:

- file and folder **names**, which are stored as they are, plus a `.bin` suffix;
- roughly how **large** each file is (encryption adds 32 bytes per file, plus 16 bytes per
  64 KiB);
- when files were **uploaded or changed**.

### What changes in the app

- **No direct links.** The provider can't serve files it can't read, so previews, downloads
  and share links all stream through jvinu. A public base URL (CDN) doesn't apply to an
  encrypted connection.
- **Sizes are shown decrypted.** Your bill is based on the stored size, which is about
  0.02% larger.
- **Thumbnails** are cached on this server's disk, as on any connection. For an encrypted
  connection, the cache is sealed with the connection's key, so a copy of the data
  directory shows nothing of your files.

### Where the key lives

When you connect, jvinu derives the key from your passphrase, as rclone does: scrypt with
N=16384, r=8, p=1. It keeps only the derived key, never the passphrase. The key is stored
in the database, sealed with AES-256-GCM under a key derived from `JVINU_SECRET`, and
bound to that one connection. Someone with a copy of the database but not the secret can't
open it.

While jvinu runs, the key is in its memory. Anyone who controls the jvinu server can read
your files. This feature protects you from the storage provider, not from your own server.

### Already using rclone crypt?

jvinu can connect a bucket that rclone already encrypts, provided rclone leaves names
readable:

```ini
filename_encryption = off
directory_name_encryption = false
```

When connecting, tick **rclone already encrypts this bucket**. Enter the same password and,
if you set one, the salt (rclone's `password2`). jvinu opens one of the existing files
first and refuses the connection if the passphrase doesn't decrypt it.

Buckets that rclone wrote with encrypted names (`standard` or `obfuscate`) can't be read by
this version.

### Reading your files without jvinu

You need [rclone](https://rclone.org/downloads/) and the passphrase. First set up a remote
for the storage itself (the provider's [rclone page](https://rclone.org/overview/)
explains the options). Then add a crypt remote on top of it:

```bash
rclone config create mycloud s3 provider=AWS access_key_id=… secret_access_key=… region=eu-west-1
rclone config create my-vault crypt \
  remote=mycloud:my-bucket \
  filename_encryption=off \
  directory_name_encryption=false \
  password='your passphrase' --obscure
```

Add `password2='your salt'` (before `--obscure`) only if you gave jvinu a salt.
`--obscure` makes rclone store the passphrase in its config the way it expects. Without the
flag, rclone has to guess whether the value is already obscured, and a long passphrase can
fool it.

The result in `rclone.conf`:

```ini
[my-vault]
type = crypt
remote = mycloud:my-bucket
filename_encryption = off
directory_name_encryption = false
password = <your passphrase, obscured>
```

Then:

```bash
rclone ls my-vault:                    # names and sizes, decrypted
rclone copy my-vault: ./restored       # every file, decrypted
rclone cat my-vault:photos/cat.jpg > cat.jpg
```

For Dropbox, the remote is the connection's folder: `remote = dropbox:Photos`.

### Under the hood

The file format follows rclone's:

- **Header:** each file begins with `RCLONE\0\0` and a random 24-byte nonce.
- **Blocks:** the contents follow in blocks of 64 KiB. Each block is sealed with NaCl
  secretbox (XSalsa20-Poly1305), and the nonce counts up by one per block.
- **Tampering:** a changed byte fails authentication, so a tampered file is refused rather
  than shown.
- **Byte ranges:** a range read, as when a video seeks, fetches only the blocks it needs.

The implementation is jvinu's own, written from rclone's format documentation. It is
tested against files made by rclone 1.75, and against rclone itself, in both directions.

To run those tests locally:

```bash
docker compose --profile floci up -d
JVINU_TEST_RCLONE=1 npm test     # needs Docker; pulls rclone/rclone:1.75
```
