"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api, tableChangesOf, type RemoteConnection, type SqlResult } from "../lib/remote";
import { formatBytes, type StorageNode } from "../lib/storage";
import { CloseIcon, SqlIcon } from "./icons";

/**
 * SQL over the files in a bucket — DuckDB on the server, in a sandbox that sees only the
 * files the query names. Results can be saved back to any writable connection.
 */

const HISTORY_KEY = "jvinu.sql.history";
const HISTORY_SIZE = 20;

function loadHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, HISTORY_SIZE) : [];
  } catch {
    return [];
  }
}

function saveHistory(history: string[]) {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_SIZE)));
  } catch {}
}

const EXTENSIONS = ["parquet", "csv", "tsv", "jsonl", "ndjson", "json"];

/** A first query for the open folder: its most common data file type, or a template. */
export function starterQuery(prefix: string, nodes: StorageNode[]): string {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind !== "file") continue;
    const ext = node.name.toLowerCase().split(".").pop() ?? "";
    if (EXTENSIONS.includes(ext)) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const folders = nodes.some((node) => node.kind === "folder");
  const glob = best ? `${prefix}*.${best}` : `${prefix}${folders ? "**/" : ""}*.parquet`;
  const hint = best ? "" : "-- No data files right here: point FROM at the files to query.\n";
  return `${hint}SELECT *\nFROM '${glob.replace(/'/g, "''")}'\nLIMIT 100`;
}

export function SqlConsole({
  connection,
  connections,
  initialSql,
  onClose,
  onSaved,
}: {
  connection: RemoteConnection;
  /** Where results can be saved: every connection that takes writes. */
  connections: RemoteConnection[];
  initialSql: string;
  onClose: () => void;
  /** A result was saved: the listing there should refresh. */
  onSaved: (connectionId: string, key: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [sql, setSql] = useState(initialSql);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function run() {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const answer = await api.sql(connection.id, sql);
      setResult(answer);
      const next = [sql.trim(), ...history.filter((item) => item !== sql.trim())];
      setHistory(next);
      saveHistory(next);
    } catch (failure) {
      setResult(null);
      setError((failure as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby={titleId}
      className="m-auto h-[calc(100dvh-2.5rem)] w-[calc(100vw-2.5rem)] max-w-[1400px] overflow-hidden rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start gap-3 border-b border-line px-6 py-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <SqlIcon size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[17px] font-semibold tracking-[-0.01em] text-ink">
              SQL on {connection.name}
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-muted">
              Name files in quotes — <code className="font-mono text-[12px]">FROM &apos;sales/**/*.parquet&apos;</code> — with paths from the top of the
              bucket. Parquet, CSV, TSV and JSON; DuckDB&apos;s SQL. Read-only, and nothing outside those files is reachable.
            </p>
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

        <div className="border-b border-line px-6 py-3">
          <textarea
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void run();
              }
            }}
            spellCheck={false}
            aria-label="Query"
            rows={6}
            className="w-full resize-y rounded-xl border border-line bg-surface px-3.5 py-3 font-mono text-[13px] leading-[1.55] text-ink outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void run()}
              disabled={running || !sql.trim()}
              className="spring inline-flex items-center gap-1.5 rounded-full bg-accent-fill px-4 py-2 text-[13.5px] font-semibold text-white shadow-card transition hover:bg-accent-hover active:scale-[0.97] disabled:opacity-60"
            >
              {running ? "Running…" : "Run"}
              <kbd className="font-sans text-[11px] font-medium opacity-75">⌘↵</kbd>
            </button>
            {history.length ? (
              <select
                value=""
                onChange={(event) => event.target.value && setSql(event.target.value)}
                aria-label="Recent queries"
                className="h-9 max-w-[320px] cursor-pointer truncate rounded-full border border-line bg-surface px-3 text-[13px] text-ink outline-none"
              >
                <option value="">Recent queries…</option>
                {history.map((item) => (
                  <option key={item} value={item}>
                    {item.replace(/\s+/g, " ").slice(0, 90)}
                  </option>
                ))}
              </select>
            ) : null}
            <span className="tnum ml-auto text-[12.5px] text-ink-muted" role="status">
              {result
                ? [
                    `${result.rows.length.toLocaleString("en-US")}${result.truncated ? "+" : ""} rows`,
                    `${result.files.length} ${result.files.length === 1 ? "file" : "files"} · ${formatBytes(result.bytesRead)}`,
                    `${(result.elapsedMs / 1000).toFixed(1)} s`,
                  ].join(" · ")
                : null}
            </span>
          </div>
        </div>

        <div className="scroll-quiet min-h-0 flex-1 overflow-auto">
          {error ? (
            <p role="alert" className="m-6 whitespace-pre-wrap rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 font-mono text-[12.5px] text-ink">
              {error}
            </p>
          ) : result ? (
            <ResultTable result={result} />
          ) : (
            <p className="px-6 py-10 text-center text-[13px] text-ink-muted">
              {running ? "Fetching the files the query names, then running it…" : "Run a query to see its results here."}
            </p>
          )}
        </div>

        {result && !error ? (
          <SaveBar
            key={sql}
            connection={connection}
            connections={connections}
            sql={sql}
            saving={saving}
            setSaving={setSaving}
            onSaved={onSaved}
            truncated={result.truncated}
          />
        ) : null}
      </div>
    </dialog>
  );
}

function ResultTable({ result }: { result: SqlResult }) {
  if (!result.rows.length) return <p className="px-6 py-10 text-center text-[13px] text-ink-muted">No rows.</p>;
  return (
    <table className="w-max min-w-full border-separate border-spacing-0 text-left text-[12.5px]">
      <thead>
        <tr>
          <th className="sticky left-0 top-0 z-20 border-b border-r border-line bg-surface-raised px-3 py-2 text-right text-[11px] font-semibold text-ink-faint">
            #
          </th>
          {result.columns.map((column, index) => (
            <th key={`${column.name}-${index}`} scope="col" className="sticky top-0 z-10 border-b border-line bg-surface-raised px-3 py-2 align-bottom">
              <span className="block max-w-[320px] truncate font-semibold text-ink" title={column.name}>
                {column.name}
              </span>
              <span className="block max-w-[320px] truncate font-mono text-[11px] font-normal text-ink-faint">{column.type}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, index) => (
          <tr key={index} className="hover:bg-surface-sunken">
            <td className="tnum sticky left-0 border-b border-r border-line bg-surface-raised px-3 py-1.5 text-right text-[11.5px] text-ink-faint">
              {index + 1}
            </td>
            {row.map((value, column) => (
              <td key={column} className="border-b border-line px-3 py-1.5 align-top">
                {value === null ? (
                  <span className="font-mono text-[11.5px] italic text-ink-faint">NULL</span>
                ) : (
                  <span className="block max-w-[420px] truncate whitespace-pre font-mono text-ink" title={value}>
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

function SaveBar({
  connection,
  connections,
  sql,
  saving,
  setSaving,
  onSaved,
  truncated,
}: {
  connection: RemoteConnection;
  connections: RemoteConnection[];
  sql: string;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  onSaved: (connectionId: string, key: string) => void;
  truncated: boolean;
}) {
  const writable = connections.filter((item) => !item.readOnly);
  const [format, setFormat] = useState<"csv" | "parquet" | "json">("parquet");
  const [targetId, setTargetId] = useState(writable.find((item) => item.id === connection.id)?.id ?? writable[0]?.id ?? "");
  const [key, setKey] = useState("results/query-result");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  if (!writable.length) return null;

  const fullKey = key.replace(/\.(csv|parquet|jsonl|json)$/i, "") + (format === "json" ? ".jsonl" : `.${format}`);

  async function save(acknowledgeTables = false) {
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api.sqlExport(connection.id, { sql, format, targetConnectionId: targetId, key: fullKey, acknowledgeTables });
      setWarning(null);
      setMessage({ ok: true, text: `Saved ${saved.rows.toLocaleString("en-US")} rows (${formatBytes(saved.bytes)}) to ${saved.key}` });
      onSaved(saved.connectionId, saved.key);
    } catch (failure) {
      const tables = tableChangesOf(failure);
      if (tables) setWarning(tables[0].message);
      else setMessage({ ok: false, text: (failure as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const field = "h-9 rounded-full border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-ring";
  return (
    <footer className="border-t border-line px-6 py-3">
      {warning ? (
        <div role="alert" className="mb-2 flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-2 text-[12.5px] text-ink">
          <span className="flex-1">{warning}</span>
          <button type="button" onClick={() => setWarning(null)} className="rounded-lg px-2.5 py-1 font-medium text-ink-muted hover:bg-surface-sunken">
            Cancel
          </button>
          <button type="button" onClick={() => void save(true)} className="rounded-lg bg-danger px-2.5 py-1 font-semibold text-white">
            Save anyway
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-semibold text-ink">Save {truncated ? "all rows" : "results"} as</span>
        <select value={format} onChange={(event) => setFormat(event.target.value as typeof format)} className={field} aria-label="Format">
          <option value="parquet">Parquet</option>
          <option value="csv">CSV</option>
          <option value="json">JSON Lines</option>
        </select>
        <span className="text-ink-muted">to</span>
        <select value={targetId} onChange={(event) => setTargetId(event.target.value)} className={field} aria-label="Connection">
          {writable.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <input value={key} onChange={(event) => setKey(event.target.value)} aria-label="File path" className={`${field} min-w-[220px] flex-1 font-mono`} />
        <span className="font-mono text-[12px] text-ink-faint">{fullKey.slice(key.replace(/\.(csv|parquet|jsonl|json)$/i, "").length)}</span>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !key.trim() || !targetId}
          className="spring rounded-full border border-line-strong bg-surface px-4 py-2 font-semibold text-ink transition hover:bg-surface-sunken disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {message ? (
        <p role="status" className={`mt-2 text-[12.5px] ${message.ok ? "text-success-ink" : "text-danger"}`}>
          {message.text}
        </p>
      ) : null}
    </footer>
  );
}
