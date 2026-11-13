import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { FileGlyph } from "../../components/file-glyph";
import { DownloadIcon, LockIcon } from "../../components/icons";
import { Wordmark } from "../../components/wordmark";
import { openLink, overLimit, REFUSALS, type RefusalCode } from "../../lib/server/share-access";
import { describeFile, formatBytes } from "../../lib/storage";

export const metadata: Metadata = {
  title: "A shared file",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const isCode = (value: unknown): value is RefusalCode => typeof value === "string" && value in REFUSALS;

function availability(expiresAt: string | null): string {
  if (!expiresAt) return "No expiry date";
  const left = Date.parse(expiresAt) - Date.now();
  const hours = Math.round(left / 3600_000);
  const relative =
    left < 3600_000 ? "less than an hour" : hours < 48 ? `${hours} more hour${hours === 1 ? "" : "s"}` : `${Math.round(hours / 24)} more days`;
  const exact = new Date(expiresAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  return `Available for ${relative} (until ${exact} UTC)`;
}

/**
 * What someone opening a share link sees: the file and a Download button — or why the
 * link no longer works. Opening the page never counts as a download (link previews in
 * chat apps open it too); only the button does. A protected link shows nothing about
 * the file until the password is given.
 */
export default async function SharedFilePage({ params, searchParams }: PageProps<"/s/[token]">) {
  await connection(); // per request: the link's state changes as it's used
  const { token } = await params;
  const query = await searchParams;
  const busy = overLimit("page", token, await headers());
  const opened = busy ?? (await openLink(token));
  const problem = isCode(query.e) ? REFUSALS[query.e] : null;
  const wait = typeof query.wait === "string" && /^\d{1,5}$/.test(query.wait) ? Number(query.wait) : 0;

  let body: React.ReactNode;
  if ("code" in opened) {
    body = (
      <div className="mt-7 text-center">
        <h1 className="text-[17px] font-semibold text-ink">{opened.code === "busy" ? "One moment" : "This link doesn't work"}</h1>
        <p role="alert" className="mt-2 text-[14px] leading-relaxed text-ink-muted">
          {opened.message}
        </p>
      </div>
    );
  } else {
    const { link, passwordHash } = opened;
    const protectedLink = Boolean(passwordHash);
    const left = link.maxDownloads === null ? null : link.maxDownloads - link.downloads;
    body = (
      <>
        {protectedLink ? (
          <div className="mt-7 text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-strong">
              <LockIcon size={22} />
            </span>
            <h1 className="mt-4 text-[17px] font-semibold text-ink">A file was shared with you</h1>
            <p className="mt-1.5 text-[13.5px] text-ink-muted">Enter the password you were given to download it.</p>
          </div>
        ) : (
          <div className="mt-7 flex items-center gap-3.5 rounded-2xl border border-line bg-surface px-4 py-3.5">
            <FileGlyph preview={describeFile(link.meta.name).preview} size={44} />
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold text-ink" title={link.meta.name}>
                {link.meta.name}
              </h1>
              <p className="tnum text-[12.5px] text-ink-muted">
                {describeFile(link.meta.name).type}
                {link.meta.size !== null ? ` · ${formatBytes(link.meta.size)}` : ""}
              </p>
            </div>
          </div>
        )}

        {problem ? (
          <p role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
            {problem.message}
            {wait ? ` Try again in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.` : ""}
          </p>
        ) : null}

        <form method="post" action={`/s/${encodeURIComponent(token)}/download`} className="mt-5 space-y-3">
          {protectedLink ? (
            <div>
              <label htmlFor="share-password" className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Password
              </label>
              <input
                id="share-password"
                name="password"
                type="password"
                required
                autoFocus
                autoComplete="off"
                className="mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-[14.5px] text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
              />
            </div>
          ) : null}
          <button
            type="submit"
            className="spring inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent-fill text-[14.5px] font-semibold text-white shadow-card transition hover:bg-accent-hover active:scale-[0.99]"
          >
            <DownloadIcon size={17} />
            Download
          </button>
        </form>

        <p className="tnum mt-4 text-center text-[12px] leading-relaxed text-ink-faint">
          {availability(link.expiresAt)}
          {left !== null ? ` · ${left} download${left === 1 ? "" : "s"} left` : ""}
        </p>
      </>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="material w-full max-w-[420px] rounded-2xl border border-line p-7 shadow-panel">
        <div className="text-center">
          <Wordmark className="text-[24px] text-ink" />
        </div>
        {body}
      </div>
    </main>
  );
}
