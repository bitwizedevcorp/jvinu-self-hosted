"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { copyText } from "../lib/clipboard";
import { DEFAULT_LINK_EXPIRY, labelFor, LINK_EXPIRY_OPTIONS, readLinkExpiry, setLinkExpiry, subscribeLinkExpiry } from "../lib/link-expiry";
import { describeDownloadCost, downloadCost, formatUsd, type DownloadCost } from "../lib/pricing";
import { keys } from "../lib/queries";
import { api, keyOf, shareUrlOf, type RemoteConnection, type ShareLink } from "../lib/remote";
import { findPreset, formatBytes, type StorageNode } from "../lib/storage";
import { FileGlyph } from "./file-glyph";
import { CheckIcon, ChevronDown, CloseIcon, LinkIcon, ShareIcon } from "./icons";

const DAY = 86_400;
const EXPIRY: { seconds: number | null; label: string }[] = [
  { seconds: 3600, label: "1 hour" },
  { seconds: DAY, label: "1 day" },
  { seconds: 7 * DAY, label: "7 days" },
  { seconds: 30 * DAY, label: "30 days" },
  { seconds: null, label: "Never" },
];
const MAX_DOWNLOADS = 100_000;

/** Comparable dollars for one download; null when there's no estimate to compare. */
const usdOf = (cost: DownloadCost): number | null =>
  cost.kind === "estimate" ? cost.usd : cost.kind === "free" || cost.kind === "self-hosted" ? 0 : null;

const INPUT =
  "h-10 w-full rounded-xl border border-line bg-surface px-3 text-[14px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent focus:ring-[3px] focus:ring-accent-ring";

function Select<T extends string | number>({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={String(value)}
        onChange={(event) => onChange(options.find((option) => String(option.value) === event.target.value)!.value)}
        className={`${INPUT} cursor-pointer appearance-none pr-9`}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint" />
    </div>
  );
}

/**
 * Sharing one file. A jvinu link works on every connection: it can expire, stop after a
 * number of downloads, ask for a password, and be revoked from Shared links. With a share
 * bucket set up, the file can be served from a copy there, where downloads cost less.
 * Where the provider signs links, a direct link is offered too — useful when this server
 * isn't reachable from outside.
 */
export function ShareDialog({
  node,
  connection,
  connections,
  onClose,
  onNotify,
  onJob,
}: {
  node: StorageNode;
  connection: RemoteConnection;
  /** Every connection, to find the share bucket. */
  connections: RemoteConnection[];
  onClose: () => void;
  onNotify: (message: string) => void;
  /** A copy into the share bucket started: follow it in the tasks tray. */
  onJob: (jobId: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const queryClient = useQueryClient();
  const provider = findPreset(connection.presetId)?.name ?? "the provider";
  const [mode, setMode] = useState<"app" | "direct">("app");
  const [expiry, setExpiry] = useState<number | null>(7 * DAY);
  const [limit, setLimit] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [created, setCreated] = useState<ShareLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // The direct link's lifetime is remembered across files and reloads.
  const directExpiry = useSyncExternalStore(subscribeLinkExpiry, readLinkExpiry, () => DEFAULT_LINK_EXPIRY);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const key = keyOf(node);
  const cost = downloadCost(connection.presetId, connection.endpoint, node.storageClassId ?? null, node.size ?? 0, connection.settings?.egressPerGb);
  const cap = /^\d+$/.test(limit) ? Number(limit) : null;
  const url = created ? shareUrlOf(created) : null;

  // The share bucket, if one is set up (and this isn't it).
  const bucket = connections.find((item) => item.settings.shareTarget && item.id !== connection.id);
  const bucketCost = bucket ? downloadCost(bucket.presetId, bucket.endpoint, null, node.size ?? 0, bucket.settings?.egressPerGb) : null;
  // Encrypted files stay encrypted at rest: only an encrypted share bucket may hold them.
  const bucketAllowed = Boolean(bucket) && (!connection.encrypted || Boolean(bucket?.encrypted)) && !bucket?.readOnly;
  const here = usdOf(cost);
  const there = bucketCost ? usdOf(bucketCost) : null;
  const saving = here !== null && there !== null ? here - there : null;
  // On by default when it's cheaper there (or free there and unknown here).
  const [viaBucket, setViaBucket] = useState(() => bucketAllowed && (saving !== null ? saving > 0 : there === 0));
  const serving = viaBucket && bucketAllowed && bucket ? bucket : connection;
  const servingCost = viaBucket && bucketAllowed && bucketCost ? bucketCost : cost;

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (limit && (cap === null || cap < 1 || cap > MAX_DOWNLOADS)) {
      setError(`Allow from 1 to ${MAX_DOWNLOADS.toLocaleString("en-US")} downloads, or leave it empty for no limit.`);
      return;
    }
    if (usePassword && (password.length < 6 || password.length > 256)) {
      setError("A link password is 6 to 256 characters.");
      return;
    }
    setError(null);
    setBusy(true);
    const request = api.createShare(connection.id, {
      key,
      expiresIn: expiry,
      maxDownloads: cap,
      password: usePassword ? password : undefined,
      fromShareBucket: viaBucket && bucketAllowed,
    });
    // Copied as part of the click: Safari only allows that while the click is still current.
    const copying = copyText(request.then(({ link }) => shareUrlOf(link) ?? ""));
    try {
      const { link, jobId } = await request;
      setCreated(link);
      if (jobId) onJob(jobId);
      void queryClient.invalidateQueries({ queryKey: keys.shares });
      const didCopy = await copying;
      setCopied(didCopy);
      onNotify(didCopy ? "Link created and copied" : "Link created");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't create the link.");
    } finally {
      setBusy(false);
    }
  }

  async function copyAgain() {
    if (!url) return;
    const ok = await copyText(url);
    setCopied(ok);
    onNotify(ok ? "Link copied" : "Couldn't reach the clipboard");
  }

  async function copyDirect() {
    const request = api.url(connection.id, key, false, directExpiry);
    if (await copyText(request.then((result) => result.url))) {
      onNotify(`Direct link copied — works for anyone for ${labelFor(directExpiry)}`);
      ref.current?.close();
    } else onNotify("Couldn't create or copy the link");
  }

  const limitsSummary = created
    ? [
        created.expiresAt
          ? `Expires ${new Date(created.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
          : "Never expires",
        created.maxDownloads === null ? "no download limit" : `${created.maxDownloads} download${created.maxDownloads === 1 ? "" : "s"}`,
        created.hasPassword ? "password needed" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
      aria-labelledby={`${id}-title`}
      style={{ width: "min(460px, calc(100vw - 2rem))" }}
      className="m-auto max-h-[calc(100dvh-2rem)] rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
            <ShareIcon size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="text-[16px] font-semibold text-ink">
              Share
            </h2>
            <p className="truncate text-[12.5px] text-ink-muted" title={node.name}>
              {node.name} · {formatBytes(node.size)}
            </p>
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

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {connection.canShareLinks && !created ? (
            <div role="group" aria-label="Kind of link" className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-surface-sunken p-1">
              {(
                [
                  ["app", "jvinu link"],
                  ["direct", "Direct link"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                  className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition ${
                    mode === value ? "bg-surface-raised text-ink shadow-card" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}

          {created ? (
            <div className="pop-in space-y-3">
              <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
                <FileGlyph preview={node.preview} size={34} radius={10} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-ink">Link ready</p>
                  <p className="text-[12px] text-ink-muted">{limitsSummary}</p>
                </div>
              </div>
              {url ? (
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={url}
                    aria-label="Share link"
                    onFocus={(event) => event.target.select()}
                    className={`${INPUT} font-mono text-[12.5px]`}
                  />
                  <button
                    type="button"
                    onClick={copyAgain}
                    className="spring inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-accent-fill px-3.5 text-[13.5px] font-semibold text-white transition hover:bg-accent-hover active:scale-[0.98]"
                  >
                    {copied ? <CheckIcon size={15} /> : <LinkIcon size={15} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              ) : null}
              <p className="text-[12px] leading-relaxed text-ink-muted">
                Manage it under <span className="font-medium text-ink">Shared links</span>: see how often it&rsquo;s been downloaded, or
                revoke it.{created.hasPassword ? " Send the password separately from the link." : ""}
              </p>
            </div>
          ) : mode === "app" ? (
            <form id={`${id}-form`} onSubmit={create} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor={`${id}-expiry`} className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                    Expires after
                  </label>
                  <div className="mt-1.5">
                    <Select
                      id={`${id}-expiry`}
                      value={expiry ?? "never"}
                      options={EXPIRY.map((option) => ({ value: option.seconds ?? "never", label: option.label }))}
                      onChange={(value) => setExpiry(value === "never" ? null : Number(value))}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor={`${id}-limit`} className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                    Downloads
                  </label>
                  <input
                    id={`${id}-limit`}
                    inputMode="numeric"
                    value={limit}
                    onChange={(event) => setLimit(event.target.value.replace(/[^\d]/g, "").slice(0, 6))}
                    placeholder="No limit"
                    className={`${INPUT} mt-1.5 tnum`}
                  />
                </div>
              </div>

              <div>
                <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px] font-medium text-ink">
                  <input
                    type="checkbox"
                    checked={usePassword}
                    onChange={(event) => setUsePassword(event.target.checked)}
                    className="size-4 cursor-pointer accent-[var(--accent-fill)]"
                  />
                  Ask for a password
                </label>
                {usePassword ? (
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-label="Link password"
                    placeholder="At least 6 characters"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    className={`${INPUT} pop-in mt-2 font-mono text-[13.5px]`}
                  />
                ) : null}
              </div>

              {bucket ? (
                bucketAllowed ? (
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line px-3.5 py-3">
                    <input
                      type="checkbox"
                      checked={viaBucket}
                      onChange={(event) => setViaBucket(event.target.checked)}
                      className="mt-0.5 size-4 cursor-pointer accent-[var(--accent-fill)]"
                    />
                    <span className="text-[12.5px] leading-relaxed text-ink-muted">
                      <span className="block text-[13.5px] font-medium text-ink">Share from {bucket.name}</span>
                      <span className="tnum">
                        {saving !== null && saving > 0
                          ? `Saves about ${formatUsd(saving)} per download (${formatUsd(here!)} → ${there ? formatUsd(there) : "free"}). `
                          : there === 0
                            ? `Downloads from there are free. `
                            : saving !== null
                              ? `Downloads don't cost less there. `
                              : ""}
                      </span>
                      It&rsquo;s copied there once, in the background — the link serves the original until then — and the copy is
                      deleted when the link ends.
                    </span>
                  </label>
                ) : (
                  <p className="rounded-xl border border-line px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-muted">
                    {connection.encrypted
                      ? `Your share bucket (${bucket.name}) isn't encrypted, so files from this encrypted connection are shared from here.`
                      : `Your share bucket (${bucket.name}) is read-only, so this file is shared from here.`}
                  </p>
                )
              ) : null}

              <div className="space-y-1.5 rounded-xl bg-surface-sunken px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-muted">
                <p className="tnum">
                  <span className="font-medium text-ink">{describeDownloadCost(servingCost)}</span>
                  {servingCost.kind === "estimate" && cap !== null
                    ? ` · at most ${formatUsd(servingCost.usd * cap)} for ${cap.toLocaleString("en-US")} download${cap === 1 ? "" : "s"}`
                    : ""}
                </p>
                <p>
                  {serving.canShareLinks
                    ? `Each download comes straight from ${findPreset(serving.presetId)?.name ?? provider}, through a link that lasts a few minutes.`
                    : serving.encrypted
                      ? "Downloads pass through this server, which decrypts them on the way."
                      : "Downloads pass through this server."}{" "}
                  Recipients open the link on this server, so they need to be able to reach it.
                </p>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <div>
                <label htmlFor={`${id}-direct-expiry`} className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                  Works for
                </label>
                <div className="mt-1.5">
                  <Select
                    id={`${id}-direct-expiry`}
                    value={directExpiry}
                    options={LINK_EXPIRY_OPTIONS.map((option) => ({ value: option.seconds, label: option.label }))}
                    onChange={(value) => setLinkExpiry(value)}
                  />
                </div>
              </div>
              <p className="rounded-xl bg-surface-sunken px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-muted">
                Signed by {provider} and served by it alone, so it works even where this server can&rsquo;t be reached. It can&rsquo;t
                be limited or revoked, and isn&rsquo;t listed under Shared links.{" "}
                <span className="tnum">{describeDownloadCost(cost)}.</span>
              </p>
            </div>
          )}

          {error ? (
            <p role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="rounded-xl border border-line-strong bg-surface px-4 py-2 text-[14px] font-semibold text-ink transition hover:bg-surface-sunken active:scale-[0.99]"
          >
            {created ? "Done" : "Cancel"}
          </button>
          {created ? null : mode === "app" ? (
            <button
              type="submit"
              form={`${id}-form`}
              disabled={busy}
              className="spring inline-flex items-center gap-2 rounded-xl bg-accent-fill px-4 py-2 text-[14px] font-semibold text-white transition hover:bg-accent-hover active:scale-[0.98] disabled:cursor-wait disabled:opacity-70"
            >
              <LinkIcon size={15} />
              {busy ? "Creating…" : "Create link"}
            </button>
          ) : (
            <button
              type="button"
              onClick={copyDirect}
              className="spring inline-flex items-center gap-2 rounded-xl bg-accent-fill px-4 py-2 text-[14px] font-semibold text-white transition hover:bg-accent-hover active:scale-[0.98]"
            >
              <LinkIcon size={15} />
              Copy direct link
            </button>
          )}
        </footer>
      </div>
    </dialog>
  );
}
