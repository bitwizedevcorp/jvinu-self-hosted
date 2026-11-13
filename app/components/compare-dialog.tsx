"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api, tableChangesOf, type Comparison, type Job, type RemoteConnection } from "../lib/remote";
import { formatBytes } from "../lib/storage";
import { CloseIcon, CompareIcon } from "./icons";

type Side = { connectionId: string; prefix: string };
type Tab = "onlyLeft" | "onlyRight" | "different";

const FIELD =
  "h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-ring";

const normalise = (prefix: string) => {
  const trimmed = prefix.trim().replace(/^\/+/, "");
  return trimmed && !trimmed.endsWith("/") ? `${trimmed}/` : trimmed;
};

/**
 * "What's missing from the backup?" — two folders, on one connection or two, compared by
 * path, size and checksum; then what's missing or different is copied across in one go.
 */
export function CompareDialog({
  connections,
  left,
  onClose,
  onJob,
}: {
  connections: RemoteConnection[];
  /** The folder open now. */
  left: Side;
  onClose: () => void;
  /** A copy started: follow it, and refresh `targetConnectionId` when it ends. */
  onJob: (job: Job, targetConnectionId: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const others = connections.filter((connection) => connection.id !== left.connectionId);
  const [right, setRight] = useState<Side>({ connectionId: others[0]?.id ?? left.connectionId, prefix: others.length ? left.prefix : "" });
  const [result, setResult] = useState<{ comparison: Comparison; left: Side; right: Side } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("onlyLeft");
  const [pending, setPending] = useState<{ message: string; run: () => Promise<void> } | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const nameOf = (side: Side) => {
    const connection = connections.find((item) => item.id === side.connectionId);
    return `${connection?.name ?? "?"}${side.prefix ? ` / ${side.prefix.replace(/\/$/, "")}` : ""}`;
  };
  const connectionOf = (side: Side) => connections.find((item) => item.id === side.connectionId);

  async function compare() {
    setBusy(true);
    setError(null);
    setResult(null);
    const target = { ...right, prefix: normalise(right.prefix) };
    try {
      const comparison = await api.compare(left, target);
      setResult({ comparison, left, right: target });
      setTab(comparison.counts.onlyLeft ? "onlyLeft" : comparison.counts.different ? "different" : "onlyRight");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(from: Side, to: Side, paths: string[], acknowledgeTables = false) {
    setError(null);
    try {
      const { job, targetConnectionId } = await api.transfer(from.connectionId, {
        targetConnectionId: to.connectionId,
        paths,
        sourcePrefix: from.prefix,
        targetPrefix: to.prefix,
        acknowledgeTables,
      });
      onJob(job, targetConnectionId);
      dialogRef.current?.close();
    } catch (failure) {
      const tables = tableChangesOf(failure);
      if (tables) setPending({ message: tables[0].message, run: () => copy(from, to, paths, true) });
      else setError((failure as Error).message);
    }
  }

  const comparison = result?.comparison;
  const rows =
    comparison && tab === "different"
      ? comparison.different.map((diff) => ({
          path: diff.path,
          detail: diff.reason === "size" ? `${formatBytes(diff.left.size)} here · ${formatBytes(diff.right.size)} there` : "same size, different contents",
        }))
      : comparison
        ? (tab === "onlyLeft" ? comparison.onlyLeft : comparison.onlyRight).map((entry) => ({ path: entry.path, detail: formatBytes(entry.size) }))
        : [];

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby={titleId}
      className="m-auto h-[min(820px,calc(100dvh-2rem))] w-[min(980px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start gap-3 border-b border-line px-6 py-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <CompareIcon size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[17px] font-semibold tracking-[-0.01em] text-ink">
              Compare folders
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-muted">By path inside each folder, size, and checksum where both sides have a comparable one.</p>
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
          >
            <CloseIcon size={17} />
          </button>
        </header>

        <div className="grid gap-3 border-b border-line px-6 py-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
          <div>
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">This folder</p>
            <p className="mt-1 truncate text-[14px] font-semibold text-ink">{nameOf(left)}</p>
          </div>
          <span className="hidden pb-2 text-ink-faint sm:block">⇄</span>
          <div>
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">Compare with</p>
            <div className="mt-1 flex gap-2">
              <select
                value={right.connectionId}
                onChange={(event) => setRight((side) => ({ ...side, connectionId: event.target.value }))}
                aria-label="Connection to compare with"
                className={`${FIELD} max-w-[45%]`}
              >
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </select>
              <input
                value={right.prefix}
                onChange={(event) => setRight((side) => ({ ...side, prefix: event.target.value }))}
                onKeyDown={(event) => event.key === "Enter" && void compare()}
                placeholder="folder/ (empty: the top level)"
                aria-label="Folder to compare with"
                className={`${FIELD} min-w-0 flex-1 font-mono`}
              />
              <button
                type="button"
                onClick={() => void compare()}
                disabled={busy}
                className="spring shrink-0 rounded-full bg-accent-fill px-4 text-[13.5px] font-semibold text-white shadow-card transition hover:bg-accent-hover disabled:opacity-60"
              >
                {busy ? "Comparing…" : "Compare"}
              </button>
            </div>
          </div>
        </div>

        {pending ? (
          <div role="alert" className="mx-6 mt-3 flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-2 text-[12.5px] text-ink">
            <span className="flex-1">{pending.message}</span>
            <button type="button" onClick={() => setPending(null)} className="rounded-lg px-2.5 py-1 font-medium text-ink-muted hover:bg-surface-sunken">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const run = pending.run;
                setPending(null);
                void run();
              }}
              className="rounded-lg bg-danger px-2.5 py-1 font-semibold text-white"
            >
              Copy anyway
            </button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mx-6 mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
            {error}
          </p>
        ) : null}

        {comparison && result ? (
          <>
            <div className="grid grid-cols-2 gap-2 px-6 pt-4 sm:grid-cols-4">
              {(
                [
                  ["onlyLeft", "Only here", comparison.counts.onlyLeft, comparison.bytes.onlyLeft],
                  ["onlyRight", "Only there", comparison.counts.onlyRight, comparison.bytes.onlyRight],
                  ["different", "Different", comparison.counts.different, comparison.bytes.different],
                ] as const
              ).map(([id, label, count, bytes]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  aria-pressed={tab === id}
                  className={`rounded-xl border px-3.5 py-2.5 text-left transition ${tab === id ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-sunken"}`}
                >
                  <p className="text-[12px] font-semibold text-ink-muted">{label}</p>
                  <p className="tnum text-[20px] font-semibold text-ink">{count.toLocaleString("en-US")}</p>
                  <p className="tnum text-[11.5px] text-ink-faint">{formatBytes(bytes)}</p>
                </button>
              ))}
              <div className="rounded-xl border border-line px-3.5 py-2.5">
                <p className="text-[12px] font-semibold text-ink-muted">The same</p>
                <p className="tnum text-[20px] font-semibold text-success-ink">{comparison.counts.same.toLocaleString("en-US")}</p>
                <p className="text-[11.5px] text-ink-faint">{comparison.checksums ? "size and checksum" : "by size"}</p>
              </div>
            </div>
            {comparison.left.truncated || comparison.right.truncated ? (
              <p className="px-6 pt-2 text-[12px] text-warning">One side has more than 200,000 objects; only the first 200,000 were compared.</p>
            ) : null}

            <div className="scroll-quiet mx-6 mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-line">
              {rows.length ? (
                <ul>
                  {rows.map((row) => (
                    <li key={row.path} className="flex items-baseline gap-3 border-b border-line px-3.5 py-1.5 text-[12.5px] last:border-b-0">
                      <span className="min-w-0 flex-1 truncate font-mono text-ink" title={row.path}>
                        {row.path}
                      </span>
                      <span className="tnum shrink-0 text-ink-faint">{row.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-8 text-center text-[13px] text-ink-muted">Nothing in this list.</p>
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-3 mt-3">
              <CopyButton
                label={`Copy ${comparison.counts.onlyLeft.toLocaleString("en-US")} missing → there`}
                disabled={!comparison.onlyLeft.length || connectionOf(result.right)?.readOnly}
                onClick={() => copy(result.left, result.right, comparison.onlyLeft.map((entry) => entry.path))}
              />
              <CopyButton
                label={`Replace ${comparison.counts.different.toLocaleString("en-US")} different → there`}
                disabled={!comparison.different.length || connectionOf(result.right)?.readOnly}
                onClick={() => copy(result.left, result.right, comparison.different.map((diff) => diff.path))}
              />
              <CopyButton
                label={`Copy ${comparison.counts.onlyRight.toLocaleString("en-US")} missing ← here`}
                disabled={!comparison.onlyRight.length || connectionOf(result.left)?.readOnly}
                onClick={() => copy(result.right, result.left, comparison.onlyRight.map((entry) => entry.path))}
              />
            </footer>
          </>
        ) : (
          <p className="flex-1 px-6 py-10 text-center text-[13px] text-ink-muted">
            {busy ? "Listing both folders…" : "Pick the other folder — on this connection or another — and compare."}
          </p>
        )}
      </div>
    </dialog>
  );
}

function CopyButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="spring rounded-full border border-line-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink transition hover:bg-surface-sunken disabled:opacity-40"
    >
      {label}
    </button>
  );
}
