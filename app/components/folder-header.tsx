"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, keyOf, type FolderNote } from "../lib/remote";
import type { StorageNode } from "../lib/storage";
import { ChevronDown, NoteIcon } from "./icons";
import { MarkdownView } from "./viewers/markdown-view";

/** What sits above a folder's listing: its note, then its README — as on GitHub. */

const README = /^readme(\.(md|markdown|txt))?$/i;
const README_LIMIT = 256 * 1024;

export const noteKey = (connectionId: string, prefix: string) => ["note", connectionId, prefix] as const;

/** The folder's note, kept by this server; everyone who opens the folder sees it. */
export function FolderNoteCard({
  connectionId,
  prefix,
  editing,
  onEditingChange,
  onNotify,
}: {
  connectionId: string;
  prefix: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onNotify: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: noteKey(connectionId, prefix), queryFn: () => api.note(connectionId, prefix), staleTime: 60_000 });
  const note = query.data?.note ?? null;

  if (editing) {
    return (
      <NoteEditor
        key={`${connectionId}|${prefix}`}
        note={note}
        onCancel={() => onEditingChange(false)}
        onSave={async (body) => {
          const saved = await api.setNote(connectionId, prefix, body);
          queryClient.setQueryData(noteKey(connectionId, prefix), (old: { note: FolderNote | null; children: string[] } | undefined) => ({
            note: saved,
            children: old?.children ?? [],
          }));
          onEditingChange(false);
          onNotify(saved ? "Note saved — everyone who opens this folder sees it" : "Note removed");
        }}
      />
    );
  }
  if (!note) return null;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-[13px]" role="note">
      <NoteIcon size={16} className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words text-ink">{note.body}</p>
        <p className="mt-1 text-[11.5px] text-ink-faint">
          {note.updatedBy} · {new Date(note.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onEditingChange(true)}
        className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold text-accent-strong transition hover:bg-accent-soft"
      >
        Edit
      </button>
    </div>
  );
}

function NoteEditor({ note, onCancel, onSave }: { note: FolderNote | null; onCancel: () => void; onSave: (body: string) => Promise<void> }) {
  const [body, setBody] = useState(note?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(text: string) {
    setSaving(true);
    setError(null);
    try {
      await onSave(text);
    } catch (failure) {
      setError((failure as Error).message);
      setSaving(false);
    }
  }
  return (
    <div className="rounded-xl border border-line bg-surface-raised px-3.5 py-3 shadow-card">
      <label className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-muted">
        <NoteIcon size={14} />
        Note on this folder
      </label>
      <textarea
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save(body);
          if (event.key === "Escape") onCancel();
        }}
        rows={3}
        maxLength={4000}
        placeholder="For example: Don't delete — the nightly export pipeline writes here."
        className="mt-2 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
      />
      {error ? (
        <p role="alert" className="mt-1 text-[12.5px] text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <p className="flex-1 text-[11.5px] text-ink-faint">Everyone who opens this folder sees it. Stored on this server, not in the bucket.</p>
        {note ? (
          <button type="button" disabled={saving} onClick={() => void save("")} className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-danger hover:bg-danger/10">
            Remove
          </button>
        ) : null}
        <button type="button" disabled={saving} onClick={onCancel} className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-muted hover:bg-surface-sunken">
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save(body)}
          className="rounded-lg bg-accent-fill px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
        >
          Save
        </button>
      </div>
    </div>
  );
}

/** The listing's README file, if it has one. */
export function readmeOf(nodes: StorageNode[]): StorageNode | null {
  return nodes.find((node) => node.kind === "file" && README.test(node.name)) ?? null;
}

/** The folder's README, rendered: links to files and folders inside the bucket open them here. */
export function FolderReadme({
  connectionId,
  node,
  onOpenKey,
}: {
  connectionId: string;
  node: StorageNode;
  onOpenKey: (key: string) => void;
}) {
  const key = keyOf(node);
  const folder = key.slice(0, key.lastIndexOf("/") + 1);
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["readme", connectionId, key, node.etag ?? node.modified],
    queryFn: async () => {
      const response = await fetch(`/api/connections/${connectionId}/object?key=${encodeURIComponent(key)}`, {
        headers: { range: `bytes=0-${README_LIMIT - 1}` },
      });
      if (!response.ok) throw new Error("Couldn't load the README.");
      return new TextDecoder().decode(await response.arrayBuffer());
    },
    staleTime: 5 * 60_000,
  });
  if (!query.data) return null;
  const markdown = !/\.txt$/i.test(node.name);
  return (
    <section className="material relative overflow-hidden rounded-xl border border-line shadow-card" aria-label={node.name}>
      <header className="flex items-center gap-2 border-b border-line px-4 py-2 text-[12.5px] font-semibold text-ink-muted">
        <span className="flex-1 truncate">{node.name}</span>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold text-accent-strong hover:bg-accent-soft"
        >
          {open ? "Show less" : "Show all"}
          <ChevronDown size={13} className={open ? "rotate-180 transition" : "transition"} />
        </button>
      </header>
      <div className={`scroll-quiet overflow-y-auto px-5 py-4 ${open ? "max-h-[60vh]" : "max-h-[180px]"}`}>
        {markdown ? (
          <MarkdownView source={query.data} connectionId={connectionId} folder={folder} onOpenKey={onOpenKey} />
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-[12.5px] text-ink">{query.data}</pre>
        )}
      </div>
    </section>
  );
}
