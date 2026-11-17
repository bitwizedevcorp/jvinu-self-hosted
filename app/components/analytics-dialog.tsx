"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { estimateCost, formatUsd, PRICES_AS_OF, sheetFor, type CostEstimate } from "../lib/pricing";
import { keys } from "../lib/queries";
import { api, type Analytics, type DiskStatus, type RemoteConnection } from "../lib/remote";
import { describeFile, formatBytes, type PreviewKind } from "../lib/storage";
import { FileGlyph, TINTS } from "./file-glyph";
import { ChartIcon, CloseIcon, RefreshIcon } from "./icons";
import { FolderSymbol } from "./symbols";
import { WEBSITE_URL } from "../lib/site";

const KIND_LABELS: Record<PreviewKind, string> = {
  image: "Images",
  video: "Video",
  audio: "Audio",
  document: "Documents",
  archive: "Archives",
  code: "Code",
  data: "Data & other",
  vector: "Vector",
  folder: "Folders",
};

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthLabel = (month: string) => MONTH.format(new Date(`${month}-01T00:00:00Z`));
const files = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "file" : "files"}`;

function Card({ label, value, detail, tone }: { label: string; value: string; detail?: React.ReactNode; tone?: "accent" }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{label}</p>
      <p className={`tnum mt-1.5 text-[24px] font-semibold tracking-[-0.02em] ${tone === "accent" ? "text-accent-strong" : "text-ink"}`}>
        {value}
      </p>
      {detail ? <div className="mt-0.5 text-[12px] text-ink-muted">{detail}</div> : null}
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
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

/** A labelled horizontal bar: share of the largest value. */
function BarRow({ label, icon, bytes, max, detail, color }: { label: React.ReactNode; icon?: React.ReactNode; bytes: number; max: number; detail?: string; color: string }) {
  const width = max ? Math.max(1.5, (bytes / max) * 100) : 0;
  return (
    <li className="py-1.5">
      <div className="flex items-center gap-2 text-[12.5px]">
        {icon}
        <span className="min-w-0 flex-1 truncate text-ink">{label}</span>
        <span className="tnum shrink-0 text-ink-muted">{formatBytes(bytes)}</span>
        {detail ? <span className="tnum w-20 shrink-0 text-right text-ink-faint">{detail}</span> : null}
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <div className="bar-grow h-full rounded-full" style={{ width: `${width}%`, backgroundColor: color }} />
      </div>
    </li>
  );
}

/** The cost card's body: an estimate, or why there isn't one. */
function costSummary(cost: CostEstimate, truncated: boolean, disk?: DiskStatus) {
  switch (cost.kind) {
    case "self-hosted":
      return {
        value: "$0",
        detail: disk ? `Self-hosted · ${formatBytes(disk.available)} free on the disk` : "Self-hosted · no storage fees",
      };
    case "plan":
      return { value: "Plan", detail: "Billed as a flat subscription, not per GB" };
    case "unknown":
      return { value: "—", detail: "No list price for a custom endpoint — set a rate below" };
    case "estimate":
      return {
        value: `${truncated ? "≥ " : ""}${formatUsd(cost.monthly)}`,
        detail: `${formatUsd(cost.monthly * 12)} a year${cost.custom ? " · your rate" : " · list price"}`,
      };
  }
}

/** The list download price a rate would override, as the input's placeholder. */
function egressPlaceholder(connection: RemoteConnection): string {
  const sheet = sheetFor(connection.presetId, connection.endpoint);
  if (typeof sheet === "string") return "0.09";
  return String(sheet.egress.perGB);
}

/** One rate override: a number, saved; or cleared back to list prices. */
function RateForm({
  label,
  unit,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  unit: string;
  value: number | undefined;
  placeholder: string;
  onSave: (value: number | null) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(next: number | null) {
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setDraft(next === null ? "" : String(next));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the rate.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const next = Number(draft);
        if (!draft.trim() || !Number.isFinite(next) || next < 0) {
          setError(`Enter a rate such as ${placeholder}.`);
          return;
        }
        void save(next);
      }}
    >
      <label htmlFor={id} className="w-28 text-[12.5px] font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12.5px] text-ink-faint">$</span>
        <input
          id={id}
          inputMode="decimal"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          className="tnum h-8 w-28 rounded-lg border border-line bg-surface-raised pl-6 pr-2 text-[12.5px] text-ink outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
        />
      </div>
      <span className="text-[12px] text-ink-faint">{unit}</span>
      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-accent-fill px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-accent-hover disabled:opacity-60"
      >
        Save
      </button>
      {value !== undefined ? (
        <button
          type="button"
          disabled={saving}
          onClick={() => void save(null)}
          className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-accent-strong transition hover:bg-accent-soft"
        >
          Use list prices
        </button>
      ) : null}
      {error ? <span className="text-[12px] text-danger">{error}</span> : null}
    </form>
  );
}

export function AnalyticsDialog({
  open,
  onClose,
  connection,
  bucketName,
  path,
  disk,
  onConnectionChange,
  onOpenFile,
}: {
  open: boolean;
  onClose: () => void;
  connection: RemoteConnection;
  bucketName: string;
  /** The folder on screen; the dialog can switch between it and the whole bucket. */
  path: string[];
  disk?: DiskStatus;
  onConnectionChange: (connection: RemoteConnection) => void;
  onOpenFile: (key: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [scope, setScope] = useState<"bucket" | "folder">(path.length ? "folder" : "bucket");
  const prefix = scope === "folder" && path.length ? `${path.join("/")}/` : "";
  // One scan per bucket or folder, cached; "Scan again" skips the server's cache too.
  const queryClient = useQueryClient();
  const analytics = useQuery({
    queryKey: keys.analytics(connection.id, prefix),
    queryFn: () => api.analytics(connection.id, prefix),
    enabled: open,
    staleTime: 60_000,
  });
  const data: Analytics | null = analytics.data ?? null;
  const error = analytics.error?.message ?? null;
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  /** "Scan again": skips the server's one-minute cache. */
  function rescan() {
    setLoading(true);
    api
      .analytics(connection.id, prefix, true)
      .then((result) => queryClient.setQueryData(keys.analytics(connection.id, prefix), result))
      .catch(() => void analytics.refetch())
      .finally(() => setLoading(false));
  }

  /** Saves a rate override; throws with the server's message for the form to show. */
  async function saveSettings(patch: Parameters<typeof api.update>[1]) {
    onConnectionChange(await api.update(connection.id, patch));
  }

  const cost = data
    ? estimateCost(
        connection.presetId,
        connection.endpoint,
        data.byClass.map((item) => ({ storageClass: item.storageClass, bytes: item.bytes })),
        connection.pricePerGb,
      )
    : null;
  const summary = cost && data ? costSummary(cost, data.truncated, disk) : null;
  const where = [bucketName, ...(scope === "folder" ? path : [])].join(" / ");

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
            <ChartIcon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[16px] font-semibold text-ink">
              Analytics · {connection.name}
            </h2>
            <p className="truncate text-[12.5px] text-ink-muted">
              {where}
              {data ? ` · scanned ${new Date(data.scannedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
            </p>
          </div>
          {path.length ? (
            <div role="radiogroup" aria-label="What to analyse" className="flex rounded-lg bg-surface-sunken p-0.5 text-[12px] font-medium">
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
            onClick={rescan}
            disabled={loading}
            aria-label="Scan again"
            title="Scan again"
            className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink disabled:opacity-50"
          >
            <RefreshIcon size={15} className={loading ? "animate-spin" : ""} />
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
          {error ? (
            <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-ink">
              {error}
            </p>
          ) : !data || data.prefix !== prefix ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center" role="status">
              <RefreshIcon size={22} className="animate-spin text-ink-faint" />
              <p className="text-[13.5px] text-ink-muted">Scanning {where}…</p>
            </div>
          ) : (
            <>
              {data.truncated ? (
                <p className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-[12.5px] text-ink">
                  This scan stopped at the first {data.objects.toLocaleString("en-US")} objects. Totals and costs are a lower
                  bound; analyse a folder for exact figures.
                </p>
              ) : null}

              <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Card label="Total size" value={formatBytes(data.bytes)} detail={`${(data.bytes / 1024 ** 3).toFixed(2)} GB billed`} />
                <Card
                  label="Objects"
                  value={data.objects.toLocaleString("en-US")}
                  detail={data.oldest && data.newest ? `${DAY.format(new Date(data.oldest))} – ${DAY.format(new Date(data.newest))}` : "—"}
                />
                <Card label="Cost per month" value={summary?.value ?? "—"} detail={summary?.detail} tone="accent" />
                <Card
                  label="Average file"
                  value={data.objects ? formatBytes(Math.round(data.bytes / data.objects)) : "—"}
                  detail={data.largest[0] ? `Largest ${formatBytes(data.largest[0].size)}` : undefined}
                />
              </div>

              <Section
                title="Added per month"
                aside={<span className="text-[11.5px] text-ink-faint">by last-modified date · last 12 months</span>}
              >
                {(() => {
                  const max = Math.max(...data.byMonth.map((month) => month.bytes), 1);
                  return (
                    <ol className="flex h-36 items-end gap-1.5" aria-label="Bytes added per month">
                      {data.byMonth.map((month) => (
                        <li
                          key={month.month}
                          className="group flex h-full flex-1 flex-col items-center justify-end gap-1"
                          title={`${monthLabel(month.month)} ${month.month.slice(0, 4)}: ${formatBytes(month.bytes)} in ${month.objects.toLocaleString("en-US")} objects`}
                        >
                          <span className="tnum text-[10px] text-ink-faint opacity-0 transition group-hover:opacity-100">
                            {month.bytes ? formatBytes(month.bytes) : ""}
                          </span>
                          <div
                            className="col-grow w-full rounded-t-md bg-accent/80 transition group-hover:bg-accent"
                            style={{ height: `${month.bytes ? Math.max(3, (month.bytes / max) * 100) : 0}%` }}
                          />
                          <span className="text-[10.5px] text-ink-faint">{monthLabel(month.month)}</span>
                        </li>
                      ))}
                    </ol>
                  );
                })()}
              </Section>

              <div className="grid gap-4 lg:grid-cols-2">
                <Section title="By file type">
                  <ul>
                    {data.byKind.map((item) => (
                      <BarRow
                        key={item.kind}
                        icon={<FileGlyph preview={item.kind} size={18} radius={5} />}
                        label={KIND_LABELS[item.kind] ?? item.kind}
                        bytes={item.bytes}
                        max={data.byKind[0]?.bytes ?? 0}
                        detail={files(item.objects)}
                        color={TINTS[item.kind]?.fg ?? "var(--accent)"}
                      />
                    ))}
                  </ul>
                </Section>

                <Section title="By storage class">
                  <ul>
                    {data.byClass.map((item) => {
                      const line =
                        cost?.kind === "estimate" && !cost.custom
                          ? cost.lines.find((entry) => entry.label.toUpperCase().replaceAll(" ", "_") === (item.storageClass ?? "STANDARD").toUpperCase())
                          : undefined;
                      return (
                        <BarRow
                          key={item.storageClass ?? "none"}
                          label={item.storageClass ? item.storageClass.replaceAll("_", " ").toLowerCase() : "Standard / not reported"}
                          bytes={item.bytes}
                          max={data.byClass[0]?.bytes ?? 0}
                          detail={line ? `${formatUsd(line.usd)}/mo` : files(item.objects)}
                          color="var(--teal)"
                        />
                      );
                    })}
                  </ul>
                </Section>

                <Section title="Biggest folders">
                  {data.byFolder.length ? (
                    <ul>
                      {data.byFolder.map((item) => (
                        <BarRow
                          key={item.folder || "(here)"}
                          icon={item.folder ? <FolderSymbol size={17} /> : <FileGlyph preview="document" size={17} radius={5} />}
                          label={item.folder || "Files at this level"}
                          bytes={item.bytes}
                          max={data.byFolder[0]?.bytes ?? 0}
                          detail={`${Math.round((item.bytes / Math.max(data.bytes, 1)) * 100)}%`}
                          color="var(--purple)"
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[12.5px] text-ink-faint">Nothing here yet.</p>
                  )}
                </Section>

                <Section title="Largest files">
                  {data.largest.length ? (
                    <ul className="-mx-1.5">
                      {data.largest.map((file) => (
                        <li key={file.key}>
                          <button
                            type="button"
                            onClick={() => {
                              ref.current?.close();
                              onOpenFile(file.key);
                            }}
                            title={file.key}
                            className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[12.5px] transition hover:bg-surface-sunken"
                          >
                            <FileGlyph preview={describeFile(file.key.split("/").pop() ?? "").preview} size={18} radius={5} />
                            <span className="min-w-0 flex-1 truncate text-ink">{file.key.slice(data.prefix.length)}</span>
                            <span className="tnum shrink-0 text-ink-muted">{formatBytes(file.size)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[12.5px] text-ink-faint">No files.</p>
                  )}
                </Section>
              </div>

              <section className="rounded-2xl border border-line bg-surface p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-[13px] font-semibold text-ink">About the cost</h3>
                  <a href={`${WEBSITE_URL}/guide#compare`} target="_blank" rel="noreferrer" className="text-[12px] font-medium text-accent-strong hover:underline">
                    Compare providers and classes
                  </a>
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
                  {cost?.kind === "estimate" && cost.sheet
                    ? `Storage only, at list price${cost.sheet.region ? ` for ${cost.sheet.region}` : ""} (${cost.sheet.source}, ${PRICES_AS_OF}). Requests, downloads, retrieval and minimum-duration fees aren't included, and free tiers are applied as if this were your only bucket. ${cost.sheet.note ?? ""}`
                    : cost?.kind === "estimate"
                      ? `Using your rate of $${connection.pricePerGb}/GB-month for all storage.`
                      : cost?.kind === "self-hosted"
                        ? "My storage runs on this server: there's no storage bill, only your disk and electricity."
                        : cost?.kind === "plan"
                          ? "This provider charges per plan rather than per GB. Set a rate below to see what this folder costs as a share of yours."
                          : "This connection uses a custom endpoint, so there's no list price. Set the rate you pay below."}
                </p>
                <RateForm
                  label="Storage rate"
                  unit="per GB-month"
                  value={connection.pricePerGb}
                  placeholder={cost?.kind === "estimate" && cost.sheet ? String(cost.sheet.classes.default) : "0.02"}
                  onSave={(value) => saveSettings({ pricePerGb: value })}
                />
                <RateForm
                  label="Download rate"
                  unit="per GB downloaded"
                  value={connection.settings?.egressPerGb}
                  placeholder={egressPlaceholder(connection)}
                  onSave={(value) => saveSettings({ settings: { egressPerGb: value } })}
                />
              </section>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
