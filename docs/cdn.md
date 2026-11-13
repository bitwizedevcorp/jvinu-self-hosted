# A CDN or custom domain in front of a bucket

If a bucket holds public files (website images, downloads, media), you can put a CDN or
your own domain in front of it. Then tell jvinu its address. Each file's inspector will
show a **Public URL**: that address plus the file's path. Click it to copy.

Signed links and jvinu share links still work. They don't go through the CDN.

> **This only works for files the public can read.** The bucket, or the folders you
> link to, must be public, or the CDN must be allowed to read them. jvinu never changes
> who can read your files. Keep private files in a different bucket.

## In jvinu

Open the connection's **Settings** (the gear icon) and fill in **Public base URL**, for
example `https://files.example.com`. It must be `https://`, with no query string. The
address must point at the root of the bucket: the file `photos/cat.jpg` becomes
`https://files.example.com/photos/cat.jpg`.

Each path segment is percent-encoded the way the storage services expect. A space
becomes `%20`. A `+` becomes `%2B`, because S3 and services like it read a bare `+` as a
space. Accents, CJK and emoji are encoded as UTF-8. These URLs are tested against the S3,
Azure and Google Cloud Storage emulators.

The setting isn't available on [encrypted connections](encryption.md). Their files are
ciphertext to everyone but jvinu, so a CDN would have nothing it could serve.

## Cloudflare in front of R2

1. In the Cloudflare dashboard, open **R2** → your bucket → **Settings** → **Custom
   Domains** → **Connect Domain**, and enter a subdomain such as `files.example.com`. The
   domain must already be on Cloudflare. This makes the bucket public at that address.
2. In jvinu, set the connection's public base URL to `https://files.example.com`.

Use a custom domain, not the `r2.dev` address. `r2.dev` is meant for development: it's
rate-limited (you'll get `429 Too Many Requests`), and Cloudflare's cache, WAF and access
rules don't apply to it. Downloads from R2 are free either way: R2 charges nothing for
egress.

## Cloudflare in front of Backblaze B2

Backblaze and Cloudflare are both in the Bandwidth Alliance, so downloads from B2 to
Cloudflare are free.

1. Make the bucket **Public** in the Backblaze console. Open any file's details and note
   the host in its **Friendly URL**, such as `f004.backblazeb2.com`.
2. In Cloudflare DNS, add a `CNAME` record from `files` to that host, with the proxy
   **on** (orange cloud).
3. Add a **Transform Rule** → **Rewrite URL** for requests to `files.example.com`. Rewrite
   the path to the dynamic value `concat("/file/<your-bucket>", http.request.uri.path)`.
   A request for `/photos/cat.jpg` then fetches `/file/<your-bucket>/photos/cat.jpg` from
   B2. The rule also stops your domain being used to reach other people's public B2
   buckets.
4. In jvinu, set the connection's public base URL to `https://files.example.com`.

## Caching

- **Overwriting a file doesn't update the CDN.** Cloudflare keeps serving its cached copy
  until that copy expires. After you replace a file under the same name, purge its URL in
  Cloudflare. Better still, give new versions new names (`logo-v2.png`), and they can be
  cached for a long time.
- **Choose how long Cloudflare keeps files.** By default, Cloudflare caches common static
  file types and follows the `Cache-Control` header the files are served with. A **Cache
  Rule** for the domain can make every file eligible for caching and set an edge TTL,
  whatever the files say.
- **With R2, consider Smart Tiered Cache.** It routes cache misses through one data centre
  near the bucket, so fewer requests reach R2.
- **Deleting a file doesn't remove it from the cache either.** Purge its URL if it must
  stop being served straight away.
