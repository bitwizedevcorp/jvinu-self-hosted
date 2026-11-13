"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, keyOf, type MetadataChange } from "../lib/remote";
import type { StorageNode } from "../lib/storage";
import { CloseIcon, PlusIcon } from "./icons";
import { Modal, PRIMARY, SECONDARY } from "./operation-dialogs";

const CONTENT_TYPES = [
  "text/html; charset=utf-8",
  "text/css; charset=utf-8",
  "text/javascript; charset=utf-8",
  "application/json",
  "text/plain; charset=utf-8",
  "text/csv",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "application/octet-stream",
  "application/vnd.apache.parquet",
];

const CACHE_PRESETS = [
  ["no-cache", "Always check (no-cache)"],
  ["public, max-age=300", "5 minutes"],
  ["public, max-age=3600", "1 hour"],
  ["public, max-age=86400", "1 day"],
  ["public, max-age=31536000, immutable", "1 year, immutable (hashed assets)"],
] as const;

const FIELD =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-ring disabled:opacity-50";

/**
 * Content-Type, Cache-Control, Content-Disposition, storage class and tags on many files
 * at once — the fix for a CDN serving files with the wrong headers. Only the ticked fields
 * change; it runs as a background job over every file in the selected folders.
 */
export function MetadataDialog({
  connectionId,
  nodes,
  onClose,
  onSubmit,
}: {
  connectionId: string;
  nodes: StorageNode[];
  onClose: () => void;
  onSubmit: (change: MetadataChange) => Promise<void>;
}) {
  const support = useQuery({ queryKey: ["metadata-support", connectionId], queryFn: () => api.metadataSupport(connectionId), staleTime: 5 * 60_000 });
  const single = nodes.length === 1 && nodes[0].kind === "file" ? nodes[0] : null;
  const head = useQuery({
    queryKey: ["head", connectionId, single ? keyOf(single) : ""],
    queryFn: () => api.head(connectionId, keyOf(single!)),
    enabled: Boolean(single),
  });

  const [on, setOn] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<{ contentType?: string; cacheControl?: string; contentDisposition?: string; storageClass?: string }>({});
  const [tags, setTags] = useState<[string, string][]>([["", ""]]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = head.data;
  const value = (field: "contentType" | "cacheControl" | "contentDisposition" | "storageClass") =>
    values[field] ?? (field === "storageClass" ? (current?.storageClass ?? "") : (current?.[field] ?? "")) ?? "";
  const set = (field: keyof typeof values, next: string) => setValues((old) => ({ ...old, [field]: next }));
  const toggle = (field: string) => setOn((old) => ({ ...old, [field]: !old[field] }));

  const files = nodes.filter((node) => node.kind === "file").length;
  const folders = nodes.length - files;
  const what =
    single?.name ??
    [files ? `${files} file${files === 1 ? "" : "s"}` : null, folders ? `${folders} folder${folders === 1 ? "" : "s"} (every file inside)` : null]
      .filter(Boolean)
      .join(" and ");

  async function apply() {
    const change: MetadataChange = {};
    if (on.contentType) change.contentType = value("contentType");
    if (on.cacheControl) change.cacheControl = value("cacheControl");
    if (on.contentDisposition) change.contentDisposition = value("contentDisposition");
    if (on.storageClass && value("storageClass")) change.storageClass = value("storageClass");
    if (on.tags) change.tags = Object.fromEntries(tags.filter(([key]) => key.trim()).map(([key, tag]) => [key.trim(), tag]));
    if (!Object.keys(change).length) {
      setError("Tick at least one thing to change.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(change);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }

  const caps = support.data;
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit metadata"
      width={560}
      footer={
        <>
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={PRIMARY} onClick={() => void apply()} disabled={busy || !caps}>
            {busy ? "Starting…" : "Apply"}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-ink-muted">
        Changes <span className="font-semibold text-ink">{what}</span>. Only the ticked fields change; the rest stay as they are.
      </p>
      {support.isPending ? (
        <p className="mt-4 text-[13px] text-ink-muted">Checking what this connection can change…</p>
      ) : !caps ? (
        <p className="mt-4 rounded-xl bg-surface-sunken px-3.5 py-3 text-[13px] text-ink-muted">
          This connection can&rsquo;t change object metadata — it&rsquo;s read-only, or the service has no way to.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {caps.contentType ? (
            <Field label="Content-Type" enabled={Boolean(on.contentType)} onToggle={() => toggle("contentType")}>
              <input list="jvinu-content-types" value={value("contentType")} onChange={(event) => set("contentType", event.target.value)} disabled={!on.contentType} className={FIELD} placeholder="text/html; charset=utf-8" />
              <datalist id="jvinu-content-types">
                {CONTENT_TYPES.map((type) => (
                  <option key={type} value={type} />
                ))}
              </datalist>
            </Field>
          ) : null}
          {caps.cacheControl ? (
            <Field label="Cache-Control" enabled={Boolean(on.cacheControl)} onToggle={() => toggle("cacheControl")}>
              <div className="flex gap-2">
                <input value={value("cacheControl")} onChange={(event) => set("cacheControl", event.target.value)} disabled={!on.cacheControl} className={FIELD} placeholder="public, max-age=3600 — empty removes it" />
                <select
                  value=""
                  disabled={!on.cacheControl}
                  onChange={(event) => event.target.value && set("cacheControl", event.target.value)}
                  aria-label="Cache-Control presets"
                  className="rounded-lg border border-line bg-surface px-2 text-[13px] text-ink disabled:opacity-50"
                >
                  <option value="">Presets…</option>
                  {CACHE_PRESETS.map(([preset, label]) => (
                    <option key={preset} value={preset}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          ) : null}
          {caps.contentDisposition ? (
            <Field label="Content-Disposition" enabled={Boolean(on.contentDisposition)} onToggle={() => toggle("contentDisposition")}>
              <select value={value("contentDisposition")} onChange={(event) => set("contentDisposition", event.target.value)} disabled={!on.contentDisposition} className={FIELD}>
                <option value="">None — browsers decide</option>
                <option value="inline">inline — show in the browser</option>
                <option value="attachment">attachment — always download</option>
              </select>
            </Field>
          ) : null}
          {caps.storageClasses.length ? (
            <Field label="Storage class" enabled={Boolean(on.storageClass)} onToggle={() => toggle("storageClass")}>
              <select value={value("storageClass")} onChange={(event) => set("storageClass", event.target.value)} disabled={!on.storageClass} className={FIELD}>
                <option value="">Choose…</option>
                {caps.storageClasses.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11.5px] text-ink-faint">Archive classes take hours to read back and charge to retrieve.</p>
            </Field>
          ) : null}
          {caps.tags ? (
            <Field label="Tags (replace all)" enabled={Boolean(on.tags)} onToggle={() => toggle("tags")}>
              <div className="space-y-1.5">
                {tags.map(([key, tag], index) => (
                  <div key={index} className="flex gap-2">
                    <input
                      value={key}
                      onChange={(event) => setTags((old) => old.map((pair, i) => (i === index ? [event.target.value, pair[1]] : pair)))}
                      disabled={!on.tags}
                      placeholder="key"
                      aria-label="Tag key"
                      className={FIELD}
                    />
                    <input
                      value={tag}
                      onChange={(event) => setTags((old) => old.map((pair, i) => (i === index ? [pair[0], event.target.value] : pair)))}
                      disabled={!on.tags}
                      placeholder="value"
                      aria-label="Tag value"
                      className={FIELD}
                    />
                    <button
                      type="button"
                      disabled={!on.tags || tags.length === 1}
                      onClick={() => setTags((old) => old.filter((_, i) => i !== index))}
                      aria-label="Remove tag"
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-faint hover:bg-surface-sunken disabled:opacity-30"
                    >
                      <CloseIcon size={14} />
                    </button>
                  </div>
                ))}
                {tags.length < 10 ? (
                  <button
                    type="button"
                    disabled={!on.tags}
                    onClick={() => setTags((old) => [...old, ["", ""]])}
                    className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-accent-strong disabled:opacity-50"
                  >
                    <PlusIcon size={13} /> Add tag
                  </button>
                ) : null}
                <p className="text-[11.5px] text-ink-faint">An empty list removes every tag.</p>
              </div>
            </Field>
          ) : null}
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

function Field({ label, enabled, onToggle, children }: { label: string; enabled: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${enabled ? "border-accent/40 bg-accent-soft/40" : "border-line"}`}>
      <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-ink">
        <input type="checkbox" checked={enabled} onChange={onToggle} className="size-4 accent-[var(--accent-fill)]" />
        Change {label}
      </label>
      <div className="mt-2">{children}</div>
    </div>
  );
}
