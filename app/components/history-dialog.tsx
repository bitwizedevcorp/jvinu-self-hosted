"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useNow } from "../lib/clock";
import { keys } from "../lib/queries";
import { api, type ActivityEntry, type RemoteConnection } from "../lib/remote";
import { formatBytes } from "../lib/storage";
import { Avatar } from "./account-menu";
import { CloseIcon, HistoryIcon, LinkIcon, RefreshIcon, RobotIcon, WarningIcon } from "./icons";

const DAY = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });
const DAY_IN_YEAR = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const nameOf = (key: string) => key.replace(/\/$/, "").split("/").pop() || key;
const counted = (count: number, word: string, plural = `${word}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? word : plural}`;
const words = (list: string[]) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

function dayLabel(iso: string, now: number): string {
  const date = new Date(iso);
  const today = new Date(now);
  const midnight = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((midnight(today) - midnight(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return (date.getFullYear() === today.getFullYear() ? DAY : DAY_IN_YEAR).format(date);
}

/** Whether what an entry names is still where it says: deleted and moved-away things aren't. */
const STILL_THERE: Partial<Record<ActivityEntry["action"], boolean>> = { deleted: false, moved: false, renamed: false };

/** Opens a file, or a folder (a key ending in "/", or "" for the top). */
type Open = (key: string) => void;

function Name({ path, live, onOpen }: { path: string; live: boolean; onOpen: Open }) {
  const label = nameOf(path) + (path.endsWith("/") ? "/" : "");
  if (!live) {
    return (
      <span className="font-medium text-ink" title={path}>
        {label}
      </span>
    );
  }
  return (
    <button type="button" onClick={() => onOpen(path)} title={path} className="font-medium text-accent-strong hover:underline">
      {label}
    </button>
  );
}

/** A folder, as a chip that opens it. */
function Place({ prefix, onOpen }: { prefix: string; onOpen: Open }) {
  const parts = prefix.replace(/\/$/, "").split("/").filter(Boolean);
  return (
    <button
      type="button"
      onClick={() => onOpen(prefix)}
      title={prefix ? `Open ${prefix}` : "Open the top level"}
      className="inline-flex max-w-[18rem] items-baseline rounded-md bg-surface-sunken px-1.5 align-baseline font-medium text-ink transition hover:bg-accent-soft hover:text-accent-strong"
    >
      <span className="truncate">{parts.length ? parts.join(" / ") : "the top level"}</span>
    </button>
  );
}

function Who({ actor }: { actor: ActivityEntry["actor"] }) {
  if (actor.via) {
    return (
      <>
        <span className="font-semibold text-ink">{actor.you ? "Your" : `${actor.name}'s`} AI agent</span>
        <span className="text-ink-muted"> (token “{actor.via}”)</span>
      </>
    );
  }
  return <span className="font-semibold text-ink">{actor.you ? "You" : actor.name}</span>;
}

const VERBS: Partial<Record<ActivityEntry["action"], string>> = {
  deleted: "deleted",
  copied: "copied",
  moved: "moved",
  renamed: "renamed",
  metadata: "changed",
  "copied-out": "copied",
  "copied-in": "copied",
};

/** How the work behind an entry went, while it runs and after. */
function JobState({ entry }: { entry: ActivityEntry }) {
  const job = entry.job;
  if (!job) return null;
  const progress = job.total ? `${job.done.toLocaleString("en-US")} of ${job.total.toLocaleString("en-US")}` : "";
  switch (job.status) {
    case "running":
      return (
        <span className="inline-flex items-center gap-1 text-accent-strong">
          <RefreshIcon size={12} className="animate-spin" />
          In progress{progress ? ` · ${progress}` : ""}
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 text-danger">
          <WarningIcon size={12} />
          Failed{job.error ? `: ${job.error}` : ""}
        </span>
      );
    case "cancelled":
      return <span className="text-ink-muted">Cancelled{progress ? ` after ${progress}` : ""}</span>;
    case "interrupted":
      return (
        <span className="inline-flex items-center gap-1 text-ink-muted">
          <WarningIcon size={12} className="text-warning" />
          Stopped by a server restart{progress ? ` after ${progress}` : ""}
        </span>
      );
    case "done":
      return job.failed ? (
        <span className="inline-flex items-center gap-1 text-ink-muted">
          <WarningIcon size={12} className="text-warning" />
          {counted(job.failed, "object")} couldn&apos;t be {VERBS[entry.action] ?? "processed"}
        </span>
      ) : null;
  }
}

/** A metadata edit, as it reads: "Cache-Control: max-age=60 · Tags: team=web". */
function changeSummary(change: unknown): string {
  if (!change || typeof change !== "object") return "";
  const { contentType, cacheControl, contentDisposition, storageClass, tags } = change as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof contentType === "string") parts.push(`Content-Type: ${contentType || "(none)"}`);
  if (typeof cacheControl === "string") parts.push(`Cache-Control: ${cacheControl || "(none)"}`);
  if (typeof contentDisposition === "string") parts.push(`Content-Disposition: ${contentDisposition || "(none)"}`);
  if (typeof storageClass === "string") parts.push(`Storage class: ${storageClass.replaceAll("_", " ").toLowerCase()}`);
  if (tags && typeof tags === "object") {
    const pairs = Object.entries(tags as Record<string, string>).map(([key, value]) => `${key}=${value}`);
    parts.push(pairs.length ? `Tags: ${pairs.join(", ")}` : "Tags removed");
  }
  return parts.join(" · ");
}

/** The sentence for one entry, and the details under it. */
function describe(entry: ActivityEntry, open: Open, here: string, bucketName: string): { line: ReactNode; notes: string[] } {
  const who = <Who actor={entry.actor} />;
  const detail = entry.detail;
  const live = STILL_THERE[entry.action] ?? true;
  const one = entry.count === 1 && entry.items.length === 1;
  const first = entry.items[0] ?? entry.target ?? "";
  const what = (noun = "item") => (one ? <Name path={first} live={live} onOpen={open} /> : <strong className="font-semibold">{counted(entry.count, noun)}</strong>);
  // Where it happened, unless that's the folder being looked at.
  const where = (word: string) =>
    entry.folder !== here ? (
      <>
        {" "}
        {word} <Place prefix={entry.folder} onOpen={open} />
      </>
    ) : null;
  const size = entry.size !== null && entry.size > 0 ? formatBytes(entry.size) : null;
  const notes: string[] = [];

  let line: ReactNode;
  switch (entry.action) {
    case "connected": {
      line = (
        <>
          {who} connected <strong className="font-semibold">{String(detail.bucket ?? bucketName)}</strong>
        </>
      );
      if (detail.encrypted) notes.push("Encrypted with a passphrase");
      if (detail.readOnly) notes.push("Read-only");
      break;
    }
    case "connection-renamed":
      line = (
        <>
          {who} renamed the connection from “{String(detail.from)}” to “{String(detail.to)}”
        </>
      );
      break;
    case "read-only":
      line = detail.on ? <>{who} made the connection read-only</> : <>{who} turned off read-only: changes are allowed again</>;
      break;
    case "settings": {
      const changes = Array.isArray(detail.changes) ? (detail.changes as string[]) : [];
      line = (
        <>
          {who} {changes.length ? words(changes) : "changed the settings"}
        </>
      );
      break;
    }
    case "uploaded":
      line = one ? (
        <>
          {who} uploaded {what()}
          {where("to")}
        </>
      ) : (
        <>
          {who} uploaded {what("file")} to <Place prefix={entry.folder} onOpen={open} />
        </>
      );
      if (size) notes.push(size);
      break;
    case "folder-created":
      line = one ? (
        <>
          {who} created the folder {what()}
          {where("in")}
        </>
      ) : (
        <>
          {who} created {what("folder")} in <Place prefix={entry.folder} onOpen={open} />
        </>
      );
      break;
    case "deleted":
      line = (
        <>
          {who} deleted {what()}
          {one ? where("from") : <> from <Place prefix={entry.folder} onOpen={open} /></>}
        </>
      );
      break;
    case "copied":
    case "moved":
      line = (
        <>
          {who} {entry.action} {what()}
          {where("from")} to <Place prefix={entry.destination ?? ""} onOpen={open} />
        </>
      );
      break;
    case "renamed":
      line = (
        <>
          {who} renamed <span className="font-medium text-ink">{nameOf(first) + (first.endsWith("/") ? "/" : "")}</span> to{" "}
          <Name path={entry.destination ?? first} live onOpen={open} />
          {where("in")}
        </>
      );
      break;
    case "metadata": {
      line = one ? (
        <>
          {who} changed the metadata of {what()}
          {where("in")}
        </>
      ) : (
        <>
          {who} changed the metadata of {what()} in <Place prefix={entry.folder} onOpen={open} />
        </>
      );
      const summary = changeSummary(detail.change);
      if (summary) notes.push(summary);
      break;
    }
    case "copied-out":
      line = (
        <>
          {who} copied {what()} to <strong className="font-semibold">{String(detail.connection ?? "another connection")}</strong>
          {entry.destination ? <span className="text-ink-muted"> / {entry.destination.replace(/\/$/, "").split("/").join(" / ")}</span> : null}
        </>
      );
      break;
    case "copied-in":
      line = (
        <>
          {who} copied {what()} here from <strong className="font-semibold">{String(detail.connection ?? "another connection")}</strong>
          {where("into")}
        </>
      );
      break;
    case "exported":
      line = (
        <>
          {who} saved query results as {what()}
          {where("in")}
        </>
      );
      if (typeof detail.rows === "number") notes.push(counted(detail.rows, "row"));
      if (typeof detail.format === "string") notes.push(detail.format === "json" ? "JSON Lines" : detail.format.toUpperCase());
      if (size) notes.push(size);
      if (typeof detail.connection === "string") notes.push(`Queried on ${detail.connection}`);
      break;
    case "note":
      line = (
        <>
          {who} {detail.removed ? "removed the note on" : "wrote a note on"} <Place prefix={entry.target ?? ""} onOpen={open} />
        </>
      );
      break;
    case "shared": {
      line = (
        <>
          {who} shared {what()}
          {where("in")}
        </>
      );
      const expires = typeof detail.expiresAt === "string" ? `Expires ${DATE.format(new Date(detail.expiresAt))}` : "No expiry";
      notes.push(expires);
      if (typeof detail.maxDownloads === "number") notes.push(`Up to ${counted(detail.maxDownloads, "download")}`);
      if (detail.password) notes.push("Password");
      if (detail.viaShareBucket) notes.push("Served from the share bucket");
      break;
    }
    case "unshared":
      line = (
        <>
          {who} revoked the share link to {what()}
        </>
      );
      break;
    case "link-downloaded":
      line = (
        <>
          {who} downloaded <Name path={first} live onOpen={open} />
          {entry.count > 1 ? ` ${counted(entry.count, "time")}` : ""}
        </>
      );
      break;
    case "zipped":
      line = (
        <>
          {who} downloaded {what()}
          {one ? null : where("from")} as <strong className="font-semibold">{String(detail.name ?? "a zip")}</strong>
        </>
      );
      if (typeof detail.files === "number") notes.push(counted(detail.files, "file"));
      if (size) notes.push(size);
      break;
    default:
      line = (
        <>
          {who} {String(entry.action).replaceAll("-", " ")}
        </>
      );
  }
  return { line, notes };
}

function Entry({ entry, open, here, bucketName }: { entry: ActivityEntry; open: Open; here: string; bucketName: string }) {
  const { line, notes } = describe(entry, open, here, bucketName);
  const live = STILL_THERE[entry.action] ?? true;
  // The names behind "12 files": a few, then how many more.
  const shown = entry.action !== "link-downloaded" && (entry.count > 1 || entry.items.length > 1) ? entry.items.slice(0, 8) : [];
  const more = Math.max(entry.count, entry.items.length) - shown.length;
  const at = new Date(entry.at);
  const run = entry.since !== entry.at && TIME.format(new Date(entry.since)) !== TIME.format(at);

  return (
    <li className="flex gap-3 py-3">
      {entry.actor.via ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-strong" aria-hidden="true">
          <RobotIcon size={16} />
        </span>
      ) : entry.action === "link-downloaded" ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-ink-muted" aria-hidden="true">
          <LinkIcon size={15} />
        </span>
      ) : (
        <span aria-hidden="true">
          <Avatar name={entry.actor.name} size={32} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 text-[13.5px] leading-[1.45] text-ink-muted [overflow-wrap:anywhere]">{line}</p>
          <time
            dateTime={entry.at}
            title={run ? `${FULL.format(new Date(entry.since))} – ${TIME.format(at)}` : FULL.format(at)}
            className="tnum shrink-0 pt-px text-[12px] text-ink-faint"
          >
            {run ? `${TIME.format(new Date(entry.since))}–${TIME.format(at)}` : TIME.format(at)}
          </time>
        </div>
        {shown.length ? (
          <ul className="mt-1.5 flex flex-wrap gap-1.5 text-[12px]">
            {shown.map((key) => (
              <li key={key} className="max-w-full rounded-md border border-line bg-surface px-1.5 py-0.5 [overflow-wrap:anywhere]">
                <Name path={key} live={live} onOpen={open} />
              </li>
            ))}
            {more > 0 ? <li className="px-1 py-0.5 text-ink-faint">and {more.toLocaleString("en-US")} more</li> : null}
          </ul>
        ) : null}
        {notes.length || entry.job ? (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-faint">
            {notes.map((note, index) => (
              <span key={note}>
                {note}
                {index < notes.length - 1 ? <span aria-hidden="true"> ·</span> : null}
              </span>
            ))}
            <JobState entry={entry} />
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * A connection's history: who uploaded, moved, renamed or deleted what and when, share
 * links made, revoked and downloaded, zip downloads, and changes to the connection itself.
 * Opened inside a folder, it starts with that folder's history.
 */
export function HistoryDialog({
  open,
  onClose,
  connection,
  bucketName,
  path,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  connection: RemoteConnection;
  bucketName: string;
  path: string[];
  /** Opens a file, or a folder: a key ending in "/", or "" for the top. */
  onOpen: (key: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const now = useNow();
  const [scope, setScope] = useState<"folder" | "bucket">(path.length ? "folder" : "bucket");
  const prefix = scope === "folder" && path.length ? `${path.join("/")}/` : "";

  const history = useInfiniteQuery({
    queryKey: keys.activity(connection.id, prefix),
    queryFn: ({ pageParam }) => api.activity(connection.id, prefix, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
    enabled: open,
    staleTime: 0,
    // While something listed is still running, keep its progress current.
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.entries.some((entry) => entry.job?.status === "running")) ? 2000 : false,
  });
  const pages = history.data?.pages ?? [];
  const entries = pages.flatMap((page) => page.entries);
  const first = pages[0];

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function go(key: string) {
    ref.current?.close();
    onOpen(key);
  }

  const days: { label: string; entries: ActivityEntry[] }[] = [];
  for (const entry of entries) {
    const label = dayLabel(entry.at, now);
    const last = days.at(-1);
    if (last?.label === label) last.entries.push(entry);
    else days.push({ label, entries: [entry] });
  }

  // Changes from before this server kept history weren't recorded; say so where the list
  // ends. (A connection made just as recording began has its whole history.)
  const unrecorded =
    first && Date.parse(connection.createdAt) < Date.parse(first.recordingSince) - 60_000 ? DATE.format(new Date(first.recordingSince)) : null;
  const where = [bucketName, ...(scope === "folder" ? path : [])].join(" / ");

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
      aria-labelledby={titleId}
      style={{ width: "min(760px, calc(100vw - 2rem))" }}
      className="m-auto max-h-[calc(100dvh-2rem)] rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
          <span className="flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
            <HistoryIcon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[16px] font-semibold text-ink">
              History · {connection.name}
            </h2>
            <p className="truncate text-[12.5px] text-ink-muted">{where}</p>
          </div>
          {path.length ? (
            <div role="radiogroup" aria-label="Whose history" className="flex rounded-lg bg-surface-sunken p-0.5 text-[12px] font-medium">
              {(["folder", "bucket"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={scope === option}
                  onClick={() => setScope(option)}
                  className={`rounded-md px-2.5 py-1 transition ${scope === option ? "bg-surface-raised text-ink shadow-card" : "text-ink-muted hover:text-ink"}`}
                >
                  {option === "folder" ? "This folder" : "Whole bucket"}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => void history.refetch()}
            disabled={history.isFetching}
            aria-label="Refresh"
            title="Refresh"
            className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink disabled:opacity-50"
          >
            <RefreshIcon size={15} className={history.isFetching ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto bg-canvas px-5 py-4">
          {history.error && !entries.length ? (
            <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-ink">
              {history.error.message}
            </p>
          ) : !first ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center" role="status">
              <RefreshIcon size={22} className="animate-spin text-ink-faint" />
              <p className="text-[13.5px] text-ink-muted">Loading the history of {where}…</p>
            </div>
          ) : !entries.length ? (
            <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
              <span className="mb-1 flex size-11 items-center justify-center rounded-2xl bg-surface-sunken text-ink-faint">
                <HistoryIcon size={22} />
              </span>
              <p className="text-[14px] font-semibold text-ink">{scope === "folder" ? "Nothing has happened in this folder yet" : "Nothing has happened here yet"}</p>
              <p className="max-w-md text-[12.5px] leading-relaxed text-ink-muted">
                Uploads, new folders, copies, moves, renames and deletes show up here with who made them, along with share links
                and zip downloads. They&apos;re kept for {first.keepDays} days.
                {unrecorded ? ` This server started keeping history on ${unrecorded}; earlier changes weren't recorded.` : ""}
              </p>
            </div>
          ) : (
            <>
              {days.map((day) => (
                <section key={day.label} aria-label={day.label} className="mb-3">
                  <h3 className="sticky top-[-16px] z-10 -mx-5 bg-canvas/95 px-5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint backdrop-blur">
                    {day.label}
                  </h3>
                  <ol className="divide-y divide-line rounded-2xl border border-line bg-surface px-4">
                    {day.entries.map((entry) => (
                      <Entry key={entry.id} entry={entry} open={go} here={prefix} bucketName={bucketName} />
                    ))}
                  </ol>
                </section>
              ))}
              {history.hasNextPage ? (
                <div className="flex justify-center pb-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void history.fetchNextPage()}
                    disabled={history.isFetchingNextPage}
                    className="material spring inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-2 text-[13px] font-semibold text-ink shadow-card transition hover:bg-surface-raised active:scale-[0.97] disabled:opacity-60"
                  >
                    {history.isFetchingNextPage ? <RefreshIcon size={14} className="animate-spin" /> : null}
                    {history.isFetchingNextPage ? "Loading…" : "Show older"}
                  </button>
                </div>
              ) : (
                <p className="pb-2 pt-1 text-center text-[12px] leading-relaxed text-ink-faint">
                  {unrecorded ? `This server started keeping history on ${unrecorded}; earlier changes weren't recorded. ` : ""}
                  History is kept for {first.keepDays} days.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
