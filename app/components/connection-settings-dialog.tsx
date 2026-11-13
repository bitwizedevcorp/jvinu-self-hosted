"use client";

import { useEffect, useId, useRef, useState } from "react";
import { atRestEncryption } from "../lib/connection-settings";
import { api, type RemoteConnection } from "../lib/remote";
import { findPreset } from "../lib/storage";
import { CloseIcon, KeyIcon, LinkIcon, LockIcon, SettingsIcon, ShareIcon } from "./icons";

/**
 * A connection's options that aren't credentials: encryption at rest, the share bucket and
 * a public base URL. Changes save as they're made.
 */
export function ConnectionSettingsDialog({
  connection,
  connections,
  onClose,
  onChange,
}: {
  connection: RemoteConnection;
  /** Every connection: there's one share bucket among them. */
  connections: RemoteConnection[];
  onClose: () => void;
  onChange: (updated: RemoteConnection) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const providerName = findPreset(connection.presetId)?.name ?? "This provider";
  const atRest = atRestEncryption(connection.presetId);
  const shareTarget = connection.settings.shareTarget;
  const otherBucket = connections.find((item) => item.id !== connection.id && item.settings.shareTarget);
  const [sharePrefix, setSharePrefix] = useState(shareTarget?.prefix ?? "jvinu-shares/");
  const [publicBase, setPublicBase] = useState(connection.settings.publicBaseUrl ?? "");
  const place = connection.presetId === "azure" ? "container" : connection.presetId === "dropbox" || connection.presetId === "onedrive" ? "folder" : "bucket";

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function save(patch: Parameters<typeof api.update>[1]) {
    setSaving(true);
    setError(null);
    try {
      onChange(await api.update(connection.id, patch));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
      aria-labelledby={titleId}
      style={{ width: "min(520px, calc(100vw - 2rem))" }}
      className="m-auto max-h-[calc(100dvh-2rem)] rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
            <SettingsIcon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[16px] font-semibold text-ink">
              {connection.name}
            </h2>
            <p className="truncate text-[12.5px] text-ink-muted">Connection settings</p>
          </div>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <div className="scroll-quiet min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <section className="rounded-2xl border border-line bg-surface p-4">
            <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
              <LockIcon size={14} className="text-ink-faint" />
              Encryption at rest
            </h3>
            {atRest === "optional" ? (
              <label className="mt-2.5 flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={Boolean(connection.settings.providerEncryption)}
                  disabled={saving}
                  onChange={(event) => void save({ settings: { providerEncryption: event.target.checked } })}
                  className="mt-0.5 size-4 cursor-pointer accent-[var(--accent-fill)]"
                />
                <span className="text-[12.5px] leading-relaxed text-ink-muted">
                  <span className="block text-[13.5px] font-medium text-ink">Ask {providerName} to encrypt new files</span>
                  Uploads and copies made here carry {connection.presetId === "b2" ? "SSE-B2" : "SSE-S3"} (AES-256, keys managed by
                  the provider). Files already stored keep whatever they have; the inspector shows each file&rsquo;s status.
                </span>
              </label>
            ) : (
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
                {atRest === "always"
                  ? `${providerName} encrypts everything at rest, always — there's nothing to switch on.`
                  : `${providerName} doesn't offer encryption at rest as an option through its API.`}
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-line bg-surface p-4">
            <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
              <KeyIcon size={14} className={connection.encrypted ? "text-success" : "text-ink-faint"} />
              jvinu encryption
            </h3>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
              {connection.encrypted
                ? `On. Files are encrypted here with your passphrase (rclone crypt) before ${providerName} stores them; names stay readable. It was set when this connection was made and can't be changed.`
                : "Off. It can only be chosen when connecting: to encrypt with a passphrase, connect an empty bucket with “Encrypt files with a passphrase” ticked."}
            </p>
          </section>

          <section className="rounded-2xl border border-line bg-surface p-4">
            <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
              <ShareIcon size={14} className={shareTarget ? "text-accent-strong" : "text-ink-faint"} />
              Share bucket
            </h3>
            {shareTarget ? (
              <>
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
                  Share links to files in your other connections can be served from copies kept here, under{" "}
                  <code className="font-mono text-[12px] text-ink">{shareTarget.prefix}</code>. Each copy is made once, in the background,
                  and deleted when its links end.
                </p>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void save({ settings: { shareTarget: null } })}
                  className="mt-3 rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold text-ink transition hover:bg-surface-sunken disabled:opacity-60"
                >
                  Stop sharing from here
                </button>
              </>
            ) : (
              <>
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
                  Serve share links for files in your other connections from copies kept here — worth it when downloads cost less
                  here.{otherBucket ? ` ${otherBucket.name} is the share bucket now; choosing this one replaces it.` : ""}
                </p>
                {connection.readOnly ? (
                  <p className="mt-2 text-[12.5px] text-ink-muted">Copies are written here, so turn off read-only first.</p>
                ) : (
                  <form
                    className="mt-3 flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save({ settings: { shareTarget: { prefix: sharePrefix } } });
                    }}
                  >
                    <input
                      value={sharePrefix}
                      onChange={(event) => setSharePrefix(event.target.value)}
                      aria-label="Folder for shared copies"
                      spellCheck={false}
                      className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface-raised px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
                    />
                    <button
                      type="submit"
                      disabled={saving}
                      className="shrink-0 rounded-lg bg-accent-fill px-3 text-[12.5px] font-semibold text-white transition hover:bg-accent-hover disabled:opacity-60"
                    >
                      Share from here
                    </button>
                  </form>
                )}
              </>
            )}
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
              {connection.encrypted
                ? "Files from encrypted connections can be shared from here, since this connection is encrypted too."
                : "Files from encrypted connections only go to an encrypted share bucket, so they're shared from where they are."}
            </p>
          </section>

          <section className="rounded-2xl border border-line bg-surface p-4">
            <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
              <LinkIcon size={14} className={connection.settings.publicBaseUrl ? "text-accent-strong" : "text-ink-faint"} />
              Public base URL
            </h3>
            {connection.encrypted ? (
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
                Not available here: the files on an encrypted connection are ciphertext to everyone but jvinu, so a CDN has nothing it
                could serve.
              </p>
            ) : (
              <>
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
                  The address of a CDN or custom domain in front of this {place}. Each file&rsquo;s inspector then has a{" "}
                  <span className="font-medium text-ink">Public URL</span> to copy: this address plus the file&rsquo;s path. Signed links and
                  jvinu links work as before.
                </p>
                <form
                  className="mt-3 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save({ settings: { publicBaseUrl: publicBase.trim() || null } });
                  }}
                >
                  <input
                    type="url"
                    value={publicBase}
                    onChange={(event) => setPublicBase(event.target.value)}
                    placeholder="https://files.example.com"
                    aria-label="Public base URL"
                    spellCheck={false}
                    className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface-raised px-3 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
                  />
                  <button
                    type="submit"
                    disabled={saving || publicBase.trim() === (connection.settings.publicBaseUrl ?? "")}
                    className="shrink-0 rounded-lg bg-accent-fill px-3 text-[12.5px] font-semibold text-white transition hover:bg-accent-hover disabled:opacity-50"
                  >
                    {publicBase.trim() || !connection.settings.publicBaseUrl ? "Save" : "Remove"}
                  </button>
                </form>
                <p className="mt-2.5 rounded-lg bg-warning/10 px-3 py-2 text-[12px] leading-relaxed text-ink">
                  This only works for files the public can read: the {place} (or the folders you link to) must be public, or your CDN
                  must be allowed to read them. jvinu never changes who can read your files. See docs/cdn.md for Cloudflare in front of
                  R2 and Backblaze B2.
                </p>
              </>
            )}
          </section>

          {error ? (
            <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}
