"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FORMAT_LABELS, type DataPreview } from "../lib/data-types";
import { api } from "../lib/remote";
import { formatBytes } from "../lib/storage";
import { CloseIcon, TableIcon } from "./icons";

type Tab = "rows" | "columns" | "details";

const count = (n: number) => n.toLocaleString("en-US");

function rowsLabel(preview: DataPreview): string {
  if (preview.rowCount === null) return "rows unknown";
  const n = preview.rowCount;
  const word = n === 1 ? "row" : "rows";
  return preview.rowCountExact ? `${count(n)} ${word}` : `about ${count(n)} ${word}`;
}

/**
 * A data file's columns and first rows, read on the server from a small part of the file —
 * Parquet from its footer and first pages, text from its first megabytes.
 */
export function DataPreviewDialog({
  connectionId,
  objectKey,
  onClose,
}: {
  connectionId: string;
  /** Null when closed. */
  objectKey: string | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (objectKey && !dialog.open) dialog.showModal();
    if (!objectKey && dialog.open) dialog.close();
  }, [objectKey]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
      aria-labelledby={titleId}
      className="m-auto h-[min(760px,calc(100dvh-2rem))] w-[min(1100px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      {objectKey ? (
        <PreviewBody
          key={`${connectionId}|${objectKey}`}
          connectionId={connectionId}
          objectKey={objectKey}
          titleId={titleId}
          onClose={() => dialogRef.current?.close()}
        />
      ) : null}
    </dialog>
  );
}

/** Fetches a data file's preview; `retry` asks again, skipping the server's cache. */
export function useDataPreview(connectionId: string, objectKey: string) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ id: string; preview?: DataPreview; error?: string } | null>(null);
  const id = `${connectionId}|${objectKey}|${attempt}`;

  useEffect(() => {
    let cancelled = false;
    api.dataPreview(connectionId, objectKey, attempt > 0).then(
      (preview) => !cancelled && setResult({ id, preview }),
      (error: unknown) => !cancelled && setResult({ id, error: error instanceof Error ? error.message : "Couldn't read this file." }),
    );
    return () => {
      cancelled = true;
    };
  }, [connectionId, objectKey, attempt, id]);

  const current = result?.id === id ? result : null;
  return { preview: current?.preview, error: current?.error, retry: () => setAttempt((n) => n + 1) };
}

/** One line about the file: format, rows, columns, how much was read. */
export function previewSummary(preview: DataPreview): string {
  return [
    FORMAT_LABELS[preview.format] + (preview.compression ? ` · ${preview.compression}` : ""),
    rowsLabel(preview),
    `${count(preview.columns.length)} ${preview.columns.length === 1 ? "column" : "columns"}`,
    `read ${formatBytes(preview.bytesRead)} of ${formatBytes(preview.size)}`,
  ].join(" · ");
}

/** Rows, Columns and Details tabs — or the loading and error states while there's no preview. */
export function DataPreviewContent({ preview, error, retry }: { preview?: DataPreview; error?: string; retry: () => void }) {
  const [tab, setTab] = useState<Tab>("rows");
  if (!preview) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" role={error ? "alert" : "status"}>
        {error ? (
          <>
            <p className="max-w-md text-[14px] text-ink">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="rounded-xl border border-line-strong bg-surface px-4 py-2 text-[13.5px] font-semibold text-ink transition hover:bg-surface-sunken"
            >
              Try again
            </button>
          </>
        ) : (
          <>
            <span className="size-6 animate-spin rounded-full border-2 border-line-strong border-t-accent" aria-hidden />
            <p className="text-[13px] text-ink-muted">Fetching the parts of the file a preview needs…</p>
          </>
        )}
      </div>
    );
  }
  return (
    <>
      <div className="flex items-center gap-1 border-b border-line px-6 py-2" role="tablist" aria-label="Preview">
        {(
          [
            ["rows", "Rows"],
            ["columns", "Columns"],
            ["details", "Details"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition ${
              tab === id ? "bg-accent-soft text-accent-strong" : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto truncate pl-3 text-[12px] text-ink-faint">
          {tab === "rows" && preview.rows.length ? `First ${count(preview.rows.length)} rows` : null}
        </span>
      </div>

      {preview.notes.length ? (
        <div className="space-y-0.5 border-b border-line bg-surface-sunken px-6 py-2 text-[12.5px] text-ink-muted">
          {preview.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      ) : null}

      <div className="scroll-quiet min-h-0 flex-1 overflow-auto">
        {tab === "rows" ? <RowsTable preview={preview} /> : null}
        {tab === "columns" ? <ColumnList preview={preview} /> : null}
        {tab === "details" ? <Details preview={preview} /> : null}
      </div>
    </>
  );
}

function PreviewBody({
  connectionId,
  objectKey,
  titleId,
  onClose,
}: {
  connectionId: string;
  objectKey: string;
  titleId: string;
  onClose: () => void;
}) {
  const { preview, error, retry } = useDataPreview(connectionId, objectKey);
  const name = objectKey.split("/").pop() ?? objectKey;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3 border-b border-line px-6 py-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <TableIcon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-[17px] font-semibold tracking-[-0.01em] text-ink" title={objectKey}>
            {name}
          </h2>
          <p className="tnum mt-0.5 truncate text-[13px] text-ink-muted">
            {preview ? previewSummary(preview) : error ? "Couldn't preview this file" : "Reading the start of the file…"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
        >
          <CloseIcon size={17} />
        </button>
      </header>
      <DataPreviewContent preview={preview} error={error} retry={retry} />
    </div>
  );
}

function RowsTable({ preview }: { preview: DataPreview }) {
  if (!preview.rows.length) {
    return (
      <p className="px-6 py-10 text-center text-[13px] text-ink-muted">
        {preview.rowCount === 0 ? "This file has no rows." : "No rows to show."}
      </p>
    );
  }
  const types = new Map(preview.columns.map((column) => [column.name, column.type]));
  return (
    <table className="w-max min-w-full border-separate border-spacing-0 text-left text-[12.5px]">
      <thead>
        <tr>
          <th className="sticky left-0 top-0 z-20 border-b border-r border-line bg-surface-raised px-3 py-2 text-right text-[11px] font-semibold text-ink-faint">
            #
          </th>
          {preview.shown.map((name) => (
            <th key={name} scope="col" className="sticky top-0 z-10 border-b border-line bg-surface-raised px-3 py-2 align-bottom">
              <span className="block max-w-[280px] truncate font-semibold text-ink" title={name}>
                {name}
              </span>
              <span className="block max-w-[280px] truncate font-mono text-[11px] font-normal text-ink-faint" title={types.get(name)}>
                {types.get(name)}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {preview.rows.map((row, index) => (
          <tr key={index} className="hover:bg-surface-sunken">
            <td className="tnum sticky left-0 border-b border-r border-line bg-surface-raised px-3 py-1.5 text-right text-[11.5px] text-ink-faint">
              {index + 1}
            </td>
            {row.map((value, column) => (
              <td key={column} className="border-b border-line px-3 py-1.5 align-top">
                {value === null ? (
                  <span className="font-mono text-[11.5px] italic text-ink-faint">NULL</span>
                ) : (
                  <span className="block max-w-[280px] truncate font-mono text-ink" title={value}>
                    {value}
                  </span>
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ColumnList({ preview }: { preview: DataPreview }) {
  return (
    <ol className="divide-y divide-line px-6 py-2">
      {preview.columns.map((column, index) => (
        <li key={`${column.name}-${index}`} className="flex items-baseline gap-3 py-2 text-[13px]">
          <span className="tnum w-8 shrink-0 text-right text-[11.5px] text-ink-faint">{index + 1}</span>
          <span className="min-w-0 flex-1 truncate font-medium text-ink" title={column.name}>
            {column.name}
          </span>
          <span className="max-w-[60%] truncate font-mono text-[12px] text-ink-muted" title={column.type}>
            {column.type}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Details({ preview }: { preview: DataPreview }) {
  const rows = [
    { label: "Format", value: FORMAT_LABELS[preview.format] },
    { label: "Size", value: formatBytes(preview.size) },
    { label: "Rows", value: preview.rowCount === null ? "Unknown" : `${preview.rowCountExact ? "" : "about "}${count(preview.rowCount)}` },
    { label: "Read for this preview", value: formatBytes(preview.bytesRead) },
    ...preview.details,
  ];
  return (
    <dl className="divide-y divide-line px-6 py-2">
      {rows.map(({ label, value }) => (
        <div key={label} className="flex items-baseline justify-between gap-6 py-2 text-[13px]">
          <dt className="shrink-0 text-ink-muted">{label}</dt>
          <dd className="min-w-0 truncate text-right font-medium text-ink" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
