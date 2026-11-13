"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { copyText } from "../lib/clipboard";
import { relativeTime, useNow } from "../lib/clock";
import { keys } from "../lib/queries";
import { api, shareUrlOf, type RemoteConnection, type ShareLink } from "../lib/remote";
import { describeFile, formatBytes } from "../lib/storage";
import { FileGlyph } from "./file-glyph";
import { LinkIcon, LockIcon } from "./icons";

const STATE_LABELS: Record<ShareLink["state"], string> = {
  active: "Active",
  expired: "Expired",
  "used-up": "Used up",
  revoked: "Revoked",
};

type Show = "active" | "ended" | "all";

/** Every link this person shared through jvinu: who's downloaded what, and a way to stop it. */
export function SharedLinksView({
  connections,
  query = "",
  onReveal,
  onNotify,
}: {
  connections: RemoteConnection[];
  /** The search box: narrows the list by file name or path. */
  query?: string;
  /** Shows the shared file in its folder. */
  onReveal: (link: ShareLink) => void;
  onNotify: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const now = useNow();
  const [show, setShow] = useState<Show>("active");
  const [confirming, setConfirming] = useState<string | null>(null);
  // Counts move as people download: keep them fresh while the view is open.
  const linksQuery = useQuery({ queryKey: keys.shares, queryFn: api.shares, refetchInterval: 30_000 });
  const revoke = useMutation({
    mutationFn: api.revokeShare,
    onSuccess: (link) => {
      queryClient.setQueryData<ShareLink[]>(keys.shares, (links) => links?.map((item) => (item.id === link.id ? link : item)));
      onNotify(`Link to ${link.name} revoked — it stops working now`);
    },
    onError: (error) => onNotify(`Couldn't revoke the link — ${error.message}`),
    onSettled: () => setConfirming(null),
  });

  const names = new Map(connections.map((connection) => [connection.id, connection.name]));
  const links = linksQuery.data ?? [];
  const counts = { active: links.filter((link) => link.state === "active").length, all: links.length };
  const needle = query.trim().toLowerCase();
  const shown = links.filter(
    (link) => (show === "all" || (show === "active") === (link.state === "active")) && (!needle || link.key.toLowerCase().includes(needle)),
  );

  async function copy(link: ShareLink) {
    const url = shareUrlOf(link);
    onNotify(url && (await copyText(url)) ? "Link copied" : "Couldn't copy the link");
  }

  if (linksQuery.isPending) {
    return (
      <p role="status" className="px-6 py-10 text-center text-[13.5px] text-ink-muted">
        Loading your links…
      </p>
    );
  }
  if (linksQuery.isError) {
    return (
      <p role="alert" className="px-6 py-10 text-center text-[13.5px] text-ink-muted">
        Couldn&rsquo;t load your links — {linksQuery.error.message}
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      <div role="group" aria-label="Which links" className="flex flex-wrap items-center gap-1.5 px-1 pb-3">
        {(
          [
            ["active", `Active · ${counts.active}`],
            ["ended", `Ended · ${counts.all - counts.active}`],
            ["all", `All · ${counts.all}`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={show === value}
            onClick={() => setShow(value)}
            className={`tnum rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition ${
              show === value ? "bg-accent-fill text-white" : "bg-surface-sunken text-ink-muted hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-14 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-surface-sunken text-ink-faint">
            <LinkIcon size={22} />
          </span>
          <p className="text-[15px] font-semibold text-ink">{needle ? `No links match “${query.trim()}”` : links.length ? "Nothing here" : "No share links yet"}</p>
          <p className="max-w-[36ch] text-[13.5px] text-ink-muted">
            {needle
              ? "Try another part of the file's name or folder."
              : links.length
              ? show === "active"
                ? "None of your links work right now. Ended links stay listed for a month."
                : "No links have ended yet."
              : "Open a file and choose Share… — its link, and how often it's been downloaded, appear here."}
          </p>
        </div>
      ) : (
        <ul className="space-y-1.5" aria-label="Share links">
          {shown.map((link) => {
            const active = link.state === "active";
            const folder = link.key.includes("/") ? link.key.slice(0, link.key.lastIndexOf("/")) : "";
            return (
              <li
                key={link.id}
                className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface px-3.5 py-3 sm:flex-nowrap ${
                  active ? "" : "opacity-75"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onReveal(link)}
                  title="Show in its folder"
                  className="flex min-w-0 flex-1 basis-[240px] items-center gap-3 text-left"
                >
                  <FileGlyph preview={describeFile(link.name).preview} size={34} radius={10} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-semibold text-ink">{link.name}</span>
                      {link.hasPassword ? (
                        <span title="Needs a password" className="shrink-0 text-ink-faint">
                          <LockIcon size={12} />
                          <span className="sr-only">, needs a password</span>
                        </span>
                      ) : null}
                    </span>
                    <span className="block truncate text-[12px] text-ink-muted">
                      {names.get(link.connectionId) ?? "Removed connection"}
                      {folder ? ` · ${folder}` : ""}
                      {link.size !== null ? ` · ${formatBytes(link.size)}` : ""}
                    </span>
                    {link.copy && active ? (
                      <span className="block truncate text-[11.5px] text-ink-faint">
                        {link.copy.status === "ready"
                          ? `Served from ${names.get(link.copy.connectionId) ?? "the share bucket"}`
                          : link.copy.status === "copying"
                            ? `Copying to ${names.get(link.copy.connectionId) ?? "the share bucket"}… served from the original meanwhile`
                            : "The share-bucket copy failed: served from the original"}
                      </span>
                    ) : null}
                  </span>
                </button>

                <dl className="tnum flex shrink-0 gap-5 text-[12px]">
                  <div>
                    <dt className="text-ink-faint">Downloads</dt>
                    <dd className="font-semibold text-ink">
                      {link.downloads}
                      {link.maxDownloads !== null ? <span className="font-normal text-ink-muted"> / {link.maxDownloads}</span> : null}
                    </dd>
                  </div>
                  <div className="w-[104px]">
                    <dt className="text-ink-faint">{active ? "Expires" : STATE_LABELS[link.state]}</dt>
                    <dd className="truncate text-ink">
                      {link.state === "revoked" && link.revokedAt
                        ? relativeTime(link.revokedAt, now)
                        : link.state === "used-up"
                          ? link.lastDownloadAt
                            ? relativeTime(link.lastDownloadAt, now)
                            : "—"
                          : link.expiresAt
                            ? relativeTime(link.expiresAt, now)
                            : "Never"}
                    </dd>
                  </div>
                </dl>

                <div className="flex shrink-0 items-center gap-1.5">
                  {active ? (
                    <>
                      <button
                        type="button"
                        onClick={() => copy(link)}
                        disabled={!link.path}
                        className="rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] font-semibold text-ink transition hover:bg-surface-sunken disabled:opacity-50"
                      >
                        Copy
                      </button>
                      {confirming === link.id ? (
                        <button
                          type="button"
                          onClick={() => revoke.mutate(link.id)}
                          onBlur={() => setConfirming((current) => (current === link.id && !revoke.isPending ? null : current))}
                          autoFocus
                          disabled={revoke.isPending}
                          className="rounded-lg bg-danger px-2.5 py-1.5 text-[12.5px] font-semibold text-white transition hover:brightness-95 disabled:opacity-70"
                        >
                          {revoke.isPending ? "Revoking…" : "Revoke now"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirming(link.id)}
                          className="rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] font-semibold text-danger transition hover:bg-danger/10"
                        >
                          Revoke
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="rounded-full bg-surface-sunken px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted">
                      {STATE_LABELS[link.state]}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
