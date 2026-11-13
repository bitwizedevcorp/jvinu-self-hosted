"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { formatUsd } from "../lib/pricing";
import { keys } from "../lib/queries";
import { api, type RemoteConnection } from "../lib/remote";
import { WEBSITE_URL } from "../lib/site";
import { formatBytes } from "../lib/storage";
import { xrayHeadline, type XrayFinding, type XrayFixId, type XrayReport } from "../lib/xray";
import { CloseIcon, DownloadIcon, LockIcon, RefreshIcon, WarningIcon, XrayIcon } from "./icons";
import { FolderSymbol } from "./symbols";

const FIX_LABELS: Record<XrayFixId, string> = {
  "abort-uploads": "Cancel these uploads",
  "expire-uploads": "Cancel them automatically from now on",
  "purge-versions": "Delete old versions",
  "cool-down": "Move to the cheaper class",
  "remove-junk": "Delete these files",
  "block-public": "Block public access",
};

const money = (usd: number | null) => (usd === null ? null : `${formatUsd(usd)}/mo`);
const count = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

function Card({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "warning" | "danger" | "ok" }) {
  const color = tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : tone === "ok" ? "text-accent-strong" : "text-ink";
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{label}</p>
      <p className={`tnum mt-1.5 text-[24px] font-semibold tracking-[-0.02em] ${color}`}>{value}</p>
      {detail ? <p className="mt-0.5 text-[12px] text-ink-muted">{detail}</p> : null}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Finding({
  finding,
  onFix,
}: {
  finding: XrayFinding;
  /** Runs the fix and resolves with what it did, in words. Absent: fixes aren't offered here. */
  onFix?: (fix: XrayFixId) => Promise<string>;
}) {
  const [state, setState] = useState<{ busy?: boolean; done?: string; error?: string; confirm?: boolean }>({});
  const fix = finding.fix;
  return (
    <li className="border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-[13px] font-semibold text-ink">{finding.title}</h4>
        <span className="tnum text-[12px] text-ink-muted">
          {count(finding.objects, "item")} · {formatBytes(finding.bytes)}
        </span>
        <span className="tnum ml-auto text-[13px] font-semibold text-warning">{money(finding.monthlyUsd) ?? formatBytes(finding.bytes)}</span>
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">{finding.detail}</p>
      <ul className="mt-2 space-y-0.5">
        {finding.examples.slice(0, 4).map((example) => (
          <li key={example.key} className="flex items-baseline gap-2 text-[12px]" title={example.note ? `${example.key} — ${example.note}` : example.key}>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">{example.key}</span>
            <span className="tnum shrink-0 text-ink-faint">{formatBytes(example.bytes)}</span>
          </li>
        ))}
      </ul>
      {fix ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {state.done ? (
            <span className="text-[12.5px] font-medium text-accent-strong">{state.done}</span>
          ) : onFix ? (
            state.confirm ? (
              <>
                <span className="text-[12.5px] text-ink">This can&apos;t be undone. Go ahead?</span>
                <button
                  type="button"
                  disabled={state.busy}
                  onClick={() => {
                    setState({ busy: true, confirm: true });
                    onFix(fix).then(
                      (done) => setState({ done }),
                      (failure) => setState({ error: failure instanceof Error ? failure.message : "That didn't work." }),
                    );
                  }}
                  className="rounded-lg bg-accent-fill px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-accent-hover disabled:opacity-60"
                >
                  {state.busy ? "Working…" : FIX_LABELS[fix]}
                </button>
                <button type="button" disabled={state.busy} onClick={() => setState({})} className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-muted hover:bg-surface-sunken">
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setState({ confirm: true })}
                className="rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] font-semibold text-ink transition hover:bg-surface-raised"
              >
                {FIX_LABELS[fix]}
              </button>
            )
          ) : (
            <a
              href={`${WEBSITE_URL}/pricing`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-medium text-accent-strong transition hover:bg-accent-soft"
            >
              <LockIcon size={13} />
              One-click fix on jvinu cloud
            </a>
          )}
          {state.error ? <span className="text-[12px] text-danger">{state.error}</span> : null}
        </div>
      ) : null}
    </li>
  );
}

export function XrayDialog({
  open,
  onClose,
  connection,
  onOpenFile,
  onFix,
}: {
  open: boolean;
  onClose: () => void;
  connection: RemoteConnection;
  onOpenFile: (key: string) => void;
  /** One-click fixes, where the plan includes them. */
  onFix?: (fix: XrayFixId) => Promise<string>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const queryClient = useQueryClient();
  const scan = useQuery({ queryKey: keys.xray(connection.id), queryFn: () => api.xray(connection.id), enabled: open, staleTime: 10 * 60_000 });
  const [rescanning, setRescanning] = useState(false);
  const report: XrayReport | null = scan.data ?? null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function rescan() {
    setRescanning(true);
    api
      .xray(connection.id, true)
      .then((result) => queryClient.setQueryData(keys.xray(connection.id), result))
      .catch(() => void scan.refetch())
      .finally(() => setRescanning(false));
  }

  const fix = onFix
    ? async (id: XrayFixId) => {
        const done = await onFix(id);
        // What was found has changed: the next look scans again.
        void queryClient.invalidateQueries({ queryKey: keys.analytics(connection.id, "") });
        return done;
      }
    : undefined;

  const exposure = report?.exposure;
  const maxFolder = Math.max(...(report?.folders.map((folder) => folder.bytes) ?? [1]), 1);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
      aria-labelledby={titleId}
      style={{ width: "min(920px, calc(100vw - 2rem))" }}
      className="m-auto max-h-[calc(100dvh-2rem)] rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
          <span className="flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
            <XrayIcon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[16px] font-semibold text-ink">
              Storage X-Ray · {connection.name}
            </h2>
            <p className="truncate text-[12.5px] text-ink-muted">
              {report
                ? `${report.bucket} · scanned ${new Date(report.scannedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} in ${Math.max(1, Math.round(report.elapsedMs / 1000))} s`
                : "Cost by folder, hidden waste, public files and leaked secrets"}
            </p>
          </div>
          {report ? (
            <a
              href={`/api/connections/${connection.id}/xray/report`}
              download
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-fill px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-accent-hover"
            >
              <DownloadIcon size={14} />
              PDF report
            </a>
          ) : null}
          <button
            type="button"
            onClick={rescan}
            disabled={rescanning || scan.isFetching}
            aria-label="Scan again"
            title="Scan again"
            className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink disabled:opacity-50"
          >
            <RefreshIcon size={15} className={rescanning ? "animate-spin" : ""} />
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

        <div className="scroll-quiet min-h-0 flex-1 space-y-4 overflow-y-auto bg-canvas px-5 py-5">
          {scan.error ? (
            <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-ink">
              {scan.error.message}
            </p>
          ) : !report || !exposure ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center" role="status">
              <RefreshIcon size={22} className="animate-spin text-ink-faint" />
              <p className="text-[13.5px] text-ink-muted">Scanning {connection.bucket}… this usually takes under a minute.</p>
            </div>
          ) : (
            <>
              <p className="text-[20px] font-semibold tracking-[-0.02em] text-ink">{xrayHeadline(report, formatUsd, formatBytes)}</p>

              <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Card
                  label="Cost per month"
                  value={report.monthlyUsd === null ? "—" : `${report.truncated ? "≥ " : ""}${formatUsd(report.monthlyUsd)}`}
                  detail={`${formatBytes(report.bytes)} in ${count(report.objects, "object")}`}
                />
                <Card
                  label="Waste"
                  value={money(report.wasteMonthlyUsd) ?? formatBytes(report.wasteBytes)}
                  detail={report.waste.length ? `${formatBytes(report.wasteBytes)} that can go` : "Nothing to clean up"}
                  tone={report.waste.length ? "warning" : "ok"}
                />
                <Card
                  label="Public access"
                  value={exposure.state === "public" ? "Public" : exposure.state === "private" ? "Private" : "Unconfirmed"}
                  detail={exposure.publicFiles ? `${count(exposure.publicFiles, "file")} anyone can read` : exposure.state === "unknown" ? "The service doesn't say" : undefined}
                  tone={exposure.state === "public" ? "danger" : exposure.state === "private" ? "ok" : "warning"}
                />
                <Card
                  label="Possible secrets"
                  value={report.secrets.length.toLocaleString("en-US")}
                  detail={`${count(report.contentScanned, "file")} opened, every name checked`}
                  tone={report.secrets.length ? "danger" : "ok"}
                />
              </div>

              <Section title="Hidden waste" aside={<span className="text-[11.5px] text-ink-faint">storage at list price</span>}>
                {report.waste.length ? (
                  <ul>
                    {report.waste.map((finding) => (
                      <Finding key={finding.id} finding={finding} onFix={fix} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12.5px] text-ink-muted">No unfinished uploads, old versions, duplicates or leftovers.</p>
                )}
              </Section>

              <div className="grid gap-4 lg:grid-cols-2">
                <Section title="Cost by folder">
                  {report.folders.length ? (
                    <ul>
                      {report.folders.slice(0, 10).map((folder) => (
                        <li key={folder.folder || "(top)"} className="py-1.5">
                          <div className="flex items-center gap-2 text-[12.5px]">
                            <FolderSymbol size={17} />
                            <span className="min-w-0 flex-1 truncate text-ink">{folder.folder || "Files at the top level"}</span>
                            <span className="tnum shrink-0 text-ink-muted">{formatBytes(folder.bytes)}</span>
                            <span className="tnum w-20 shrink-0 text-right font-medium text-ink">{money(folder.monthlyUsd) ?? "—"}</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                            <div className="bar-grow h-full rounded-full bg-accent" style={{ width: `${Math.max(1.5, (folder.bytes / maxFolder) * 100)}%` }} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[12.5px] text-ink-faint">Nothing here yet.</p>
                  )}
                </Section>

                <Section title="Public access">
                  <p className={`text-[13px] font-semibold ${exposure.state === "public" ? "text-danger" : exposure.state === "private" ? "text-accent-strong" : "text-warning"}`}>
                    {exposure.state === "public" ? "Readable by anyone" : exposure.state === "private" ? "Private" : "Couldn't be confirmed"}
                  </p>
                  <ul className="mt-1.5 space-y-1 text-[12.5px] leading-relaxed text-ink-muted">
                    {exposure.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                  {exposure.state === "public" && exposure.checks.blocked !== null ? (
                    <ul className="mt-2">
                      <Finding
                        finding={{ id: "junk", title: "Close it", detail: "Turns on all four “block public access” switches for this bucket. Links that rely on public access stop working.", objects: exposure.publicFiles ?? 0, bytes: 0, monthlyUsd: null, examples: [], fix: "block-public" }}
                        onFix={fix}
                      />
                    </ul>
                  ) : null}
                </Section>
              </div>

              <Section
                title="Possible leaked secrets"
                aside={<span className="text-[11.5px] text-ink-faint">names and line numbers only — never the secret</span>}
              >
                {report.secrets.length ? (
                  <ul className="-mx-1.5">
                    {report.secrets.slice(0, 100).map((secret, index) => (
                      <li key={`${secret.key}:${secret.rule}:${index}`}>
                        <button
                          type="button"
                          onClick={() => {
                            ref.current?.close();
                            onOpenFile(secret.key);
                          }}
                          title={secret.key}
                          className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[12.5px] transition hover:bg-surface-sunken"
                        >
                          <WarningIcon size={15} className={secret.severity === "high" ? "shrink-0 text-danger" : "shrink-0 text-warning"} />
                          <span className="w-56 shrink-0 truncate font-medium text-ink">{secret.rule}</span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-muted">
                            {secret.key}
                            {secret.line ? `:${secret.line}` : ""}
                          </span>
                          {secret.public ? <span className="shrink-0 rounded-md bg-danger/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-danger">PUBLIC</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12.5px] text-ink-muted">None found.</p>
                )}
                {report.secrets.length ? (
                  <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
                    Treat each as leaked until you&apos;ve checked: rotate the credential first, then remove the file.
                  </p>
                ) : null}
              </Section>

              {report.notes.length ? (
                <Section title="About this scan">
                  <ul className="space-y-1 text-[12.5px] leading-relaxed text-ink-muted">
                    {report.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
