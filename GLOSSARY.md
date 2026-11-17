# jvinu

A self-hosted manager for files kept across many clouds: browse, preview, query, share and move them from one place.

## Connections and providers

**Provider**:
A storage service jvinu can connect to, such as Amazon S3, Wasabi, Dropbox or Google Drive.
_Avoid_: cloud (for the service itself), backend, vendor

**Provider profile**:
The facts about one provider that the app relies on: its name, what a connection to it opens, and how it encrypts at rest.
_Avoid_: preset (that's the choice a person makes when connecting), provider config

**Connection**:
One saved link from this server to one place at a provider, with the credentials to reach it. Every member of the server can use every connection.
_Avoid_: provider (for a saved instance), account, mount

**Place**:
What a connection opens: a bucket, an Azure container, or a folder of an account (Dropbox, OneDrive, Google Drive).
_Avoid_: root, bucket (when the provider has folders)

**Folder-root provider**:
A provider whose connections open a folder of a whole account rather than a bucket.
_Avoid_: drive provider, consumer cloud

## Files

**Key**:
The path of a file within a connection's place, such as `reports/2026/sales.csv`.
_Avoid_: path (on its own), object name, filename

**Folder key**:
A key ending in `/`, naming a folder rather than a file; the empty key is the connection's top.
_Avoid_: prefix (when a folder is meant), directory

**Folder marker**:
The empty entry that keeps an empty folder in existence on a provider without real folders.
_Avoid_: placeholder, dummy object

**Storage driver contract**:
The behaviour every provider's driver promises the rest of jvinu, whatever the provider: what a folder key and an exact key return, how folder markers appear, and what a size means.
_Avoid_: driver API, adapter spec

**Page token**:
The marker that continues a listing of one folder where the last page ended; it works only for the connection and folder that produced it.
_Avoid_: cursor, next link, continuation

## Sharing

**Share link**:
A link anyone can open to download one file, with an optional password, expiry and download limit.
_Avoid_: public link, signed URL (that's the provider's own short-lived link)

**Redemption**:
One use of a share link that ends in a download, or in a refusal saying why not.
_Avoid_: share access, link hit

**Share bucket**:
The connection chosen to hold copies of shared files, so a link keeps working after the original moves.
_Avoid_: share target, copy bucket

## Work in the background

**Job**:
A file operation, transfer or share copy that runs on the server after the request that started it, followed in the tasks tray.
_Avoid_: task (in code and docs), operation (for the running work)

**Connection change**:
Anything that alters what a connection holds, after which whatever this server remembered about its files is forgotten.
_Avoid_: invalidation, cache bust
