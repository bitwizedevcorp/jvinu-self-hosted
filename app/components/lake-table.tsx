"use client";

import { useEffect, useId, useRef, useState } from "react";
import { LAKE_LABELS, type LakeRoot, type LakeTableInfo, type TableChange } from "../lib/data-types";
import { api } from "../lib/remote";
import { formatBytes } from "../lib/storage";
import { CloseIcon, TableIcon, WarningIcon } from "./icons";

/**
 * Delta, Iceberg and Hudi tables in the browser: a banner while you're inside one, a summary
 * read from the table's own metadata, and the confirmation shown before a change that would
 * break one.
 */

const count = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));
const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—";
const folderName = (root: string) => root.replace(/\/$/, "").split("/").pop() || "/";

export const ENGINE_HINT = "Change it through Databricks, Spark, Snowflake or another engine — deleting or moving its files here breaks it.";

/** Shown above a listing while the current folder is, or is inside, a table. */
export function LakeBanner({ table, prefix, onDetails }: { table: LakeRoot; prefix: string; onDetails: () => void }) {
  const atRoot = table.root === prefix;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-[13px]" role="note">
      <TableIcon size={16} className="shrink-0 text-warning" />
      <p className="min-w-0 flex-1 text-ink">
        <span className="font-semibold">
          {atRoot ? `This folder is a ${LAKE_LABELS[table.format]}.` : `Inside the ${LAKE_LABELS[table.format]} “${folderName(table.root)}”.`}
        </span>{" "}
        <span className="text-ink-muted">{ENGINE_HINT}</span>
      </p>
      <button
        type="button"
        onClick={onDetails}
        className="spring shrink-0 rounded-full border border-line-strong bg-surface px-3 py-1 text-[12.5px] font-semibold text-accent-strong transition hover:bg-accent-soft active:scale-[0.97]"
      >
        Table details
      </button>
    </div>
  );
}

/** What a table holds, from its own metadata. Renders nothing for a folder that isn't in one. */
export function LakeTableSummary({ connectionId, prefix }: { connectionId: string; prefix: string }) {
  const [result, setResult] = useState<{ prefix: string; table?: LakeTableInfo | null; error?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.table(connectionId, prefix, true).then(
      ({ table }) => !cancelled && setResult({ prefix, table: table as LakeTableInfo | null }),
      (error: unknown) => !cancelled && setResult({ prefix, error: error instanceof Error ? error.message : "Couldn't read the table." }),
    );
    return () => {
      cancelled = true;
    };
  }, [connectionId, prefix]);

  const current = result?.prefix === prefix ? result : null;
  // Most folders aren't tables: say nothing until there's something to say.
  if (!current) return null;
  if (current.error) {
    return (
      <p className="rounded-xl border border-line px-3.5 py-3 text-[12.5px] text-ink-muted" role="alert">
        {current.error}
      </p>
    );
  }
  if (!current.table) return null;
  return <TableFacts table={current.table} />;
}

function TableFacts({ table }: { table: LakeTableInfo }) {
  const [allColumns, setAllColumns] = useState(false);
  const [allProperties, setAllProperties] = useState(false);
  const columns = allColumns ? table.columns : table.columns.slice(0, 12);
  const properties = allProperties ? table.properties : table.properties.slice(0, 6);
  const facts: [string, string][] = [
    ["Rows", count(table.rows)],
    ["Files", count(table.files)],
    ["Size", table.bytes === null ? "—" : formatBytes(table.bytes)],
    [table.format === "iceberg" ? "Snapshot" : "Version", table.version ?? "—"],
    ["Updated", when(table.lastUpdated)],
    ["Format", table.formatVersion ?? "—"],
  ];

  return (
    <section className="space-y-3" aria-label={LAKE_LABELS[table.format]}>
      <div className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-3 text-[12.5px]">
        <WarningIcon size={15} className="mt-0.5 shrink-0 text-warning" />
        <p className="text-ink">
          <span className="font-semibold">
            {table.root === "" ? "This bucket" : `“${folderName(table.root)}”`} is a {LAKE_LABELS[table.format]}
            {table.alsoIceberg ? " with Iceberg metadata too (UniForm)" : ""}.
          </span>{" "}
          <span className="text-ink-muted">{ENGINE_HINT}</span>
        </p>
      </div>

      {table.name || table.description ? (
        <div className="px-1">
          {table.name ? <p className="text-[14px] font-semibold text-ink">{table.name}</p> : null}
          {table.description ? <p className="text-[12.5px] text-ink-muted">{table.description}</p> : null}
        </div>
      ) : null}

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
        {facts.map(([label, value]) => (
          <div key={label} className="bg-surface-raised px-3 py-2">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">{label}</dt>
            <dd className="tnum truncate text-[13px] font-medium text-ink" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {table.partitionColumns.length ? (
        <div className="px-1">
          <h4 className="pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">Partitioned by</h4>
          <div className="flex flex-wrap gap-1.5">
            {table.partitionColumns.map((column) => (
              <span key={column} className="rounded-full bg-surface-sunken px-2.5 py-0.5 font-mono text-[12px] text-ink">
                {column}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {table.columns.length ? (
        <div>
          <h4 className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
            Columns · {table.columns.length.toLocaleString("en-US")}
          </h4>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {columns.map((column) => (
              <li key={column.name} className="flex items-baseline gap-3 px-3 py-1.5 text-[12.5px]">
                <span className="min-w-0 flex-1 truncate font-medium text-ink" title={column.name}>
                  {column.name}
                </span>
                <span className="max-w-[55%] truncate font-mono text-[11.5px] text-ink-muted" title={column.type}>
                  {column.type}
                  {column.nullable === false ? " not null" : ""}
                </span>
              </li>
            ))}
            {table.columns.length > 12 ? (
              <li>
                <button
                  type="button"
                  onClick={() => setAllColumns((v) => !v)}
                  className="w-full px-3 py-1.5 text-left text-[12.5px] font-medium text-accent-strong hover:bg-surface-sunken"
                >
                  {allColumns ? "Show fewer" : `Show all ${table.columns.length}`}
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {table.history.length ? (
        <div>
          <h4 className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">Recent changes</h4>
          <ol className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {table.history.slice(0, 8).map((entry) => (
              <li key={entry.version} className="px-3 py-2 text-[12.5px]">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-ink">{entry.operation}</span>
                  <span className="ml-auto shrink-0 text-[11.5px] text-ink-faint">{when(entry.timestamp)}</span>
                </div>
                <p className="tnum truncate text-[12px] text-ink-muted" title={entry.summary}>
                  {table.format === "delta" ? `v${entry.version}` : `#${entry.version.slice(-6)}`}
                  {entry.summary ? ` · ${entry.summary}` : ""}
                </p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {properties.length ? (
        <div>
          <h4 className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">Properties</h4>
          <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {properties.map(({ key, value }) => (
              <div key={key} className="flex items-baseline gap-3 px-3 py-1.5 text-[12px]">
                <dt className="min-w-0 flex-1 truncate font-mono text-ink-muted" title={key}>
                  {key}
                </dt>
                <dd className="max-w-[45%] truncate font-mono text-ink" title={value}>
                  {value}
                </dd>
              </div>
            ))}
            {table.properties.length > 6 ? (
              <button
                type="button"
                onClick={() => setAllProperties((v) => !v)}
                className="w-full px-3 py-1.5 text-left text-[12.5px] font-medium text-accent-strong hover:bg-surface-sunken"
              >
                {allProperties ? "Show fewer" : `Show all ${table.properties.length}`}
              </button>
            ) : null}
          </dl>
        </div>
      ) : null}

      {table.features.length ? (
        <p className="px-1 text-[12px] text-ink-muted">
          <span className="font-semibold text-ink-faint">Features: </span>
          {table.features.join(", ")}
        </p>
      ) : null}
      {table.location ? (
        <p className="truncate px-1 font-mono text-[11.5px] text-ink-faint" title={table.location}>
          {table.location}
        </p>
      ) : null}
      {table.notes.map((note) => (
        <p key={note} className="px-1 text-[12px] text-ink-muted">
          {note}
        </p>
      ))}
    </section>
  );
}

/** The table summary in its own dialog — from the banner's "Table details". */
export function LakeTableDialog({ connectionId, table, onClose }: { connectionId: string; table: LakeRoot | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (table && !dialog.open) dialog.showModal();
    if (!table && dialog.open) dialog.close();
  }, [table]);
  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
      aria-labelledby={titleId}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      {table ? (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <header className="flex items-start gap-3 border-b border-line px-6 py-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <TableIcon size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="truncate text-[17px] font-semibold tracking-[-0.01em] text-ink">
                {folderName(table.root)}
              </h2>
              <p className="mt-0.5 text-[13px] text-ink-muted">{LAKE_LABELS[table.format]}</p>
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
          <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <LakeTableSummary key={table.root} connectionId={connectionId} prefix={table.root} />
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * Before a change that would break a table: what it touches and why, and a deliberate
 * second click to go ahead anyway.
 */
export function TableChangeDialog({
  changes,
  verb,
  onConfirm,
  onCancel,
}: {
  /** Null when closed. */
  changes: TableChange[] | null;
  /** "Delete", "Move", "Rename", "Upload"… — the button reads "<verb> anyway". */
  verb: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const confirmed = useRef(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (changes && !dialog.open) {
      confirmed.current = false;
      dialog.showModal();
    }
    if (!changes && dialog.open) dialog.close();
  }, [changes]);
  return (
    <dialog
      ref={dialogRef}
      onClose={() => (confirmed.current ? onConfirm() : onCancel())}
      aria-labelledby={titleId}
      className="m-auto w-[min(480px,calc(100vw-2rem))] rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      {changes ? (
        <div>
          <header className="flex items-start gap-3 px-6 pb-2 pt-5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning">
              <WarningIcon size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-[17px] font-semibold tracking-[-0.01em] text-ink">
                {changes.length === 1 ? `This touches a ${LAKE_LABELS[changes[0].table.format]}` : `This touches ${changes.length} data-lake tables`}
              </h2>
              <p className="mt-0.5 text-[13px] text-ink-muted">Tables like these are managed by an engine, not by their files.</p>
            </div>
          </header>
          <ul className="scroll-quiet max-h-[40dvh] space-y-2 overflow-y-auto px-6 py-3">
            {changes.slice(0, 8).map((change) => (
              <li key={`${change.relation}|${change.table.root}`} className="rounded-xl bg-surface-sunken px-3.5 py-2.5 text-[13px] leading-relaxed text-ink">
                {change.message}
              </li>
            ))}
            {changes.length > 8 ? <li className="px-1 text-[12.5px] text-ink-muted">…and {changes.length - 8} more.</li> : null}
          </ul>
          <footer className="flex justify-end gap-2 border-t border-line px-6 py-4">
            <button
              type="button"
              autoFocus
              onClick={() => dialogRef.current?.close()}
              className="rounded-xl border border-line-strong bg-surface px-4 py-2.5 text-[14px] font-semibold text-ink transition hover:bg-surface-sunken active:scale-[0.99]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                confirmed.current = true;
                dialogRef.current?.close();
              }}
              className="spring rounded-xl bg-danger px-4 py-2.5 text-[14px] font-semibold text-white transition hover:opacity-90 active:scale-[0.98]"
            >
              {verb} anyway
            </button>
          </footer>
        </div>
      ) : null}
    </dialog>
  );
}
