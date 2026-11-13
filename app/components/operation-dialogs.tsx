"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/remote";
import { ChevronRight, CloseIcon, PlusIcon } from "./icons";
import { FolderSymbol } from "./symbols";

/** A native <dialog> that opens and closes with `open`: focus trap and Esc for free. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 440,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
      aria-labelledby={titleId}
      style={{ width: `min(${width}px, calc(100vw - 2rem))` }}
      className="m-auto max-h-[calc(100dvh-2rem)] rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-[16px] font-semibold text-ink">
            {title}
          </h2>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="Close"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
          >
            <CloseIcon size={16} />
          </button>
        </header>
        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</footer>
      </div>
    </dialog>
  );
}

export const SECONDARY =
  "rounded-xl border border-line-strong bg-surface px-4 py-2 text-[13.5px] font-semibold text-ink transition hover:bg-surface-sunken active:scale-[0.98]";
export const PRIMARY =
  "spring rounded-xl bg-accent-fill px-4 py-2 text-[13.5px] font-semibold text-white transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-60";
export const DANGER =
  "spring rounded-xl bg-danger px-4 py-2 text-[13.5px] font-semibold text-white transition hover:brightness-95 active:scale-[0.98] disabled:opacity-60";

export function RenameDialog({
  open,
  currentName,
  isFolder,
  onClose,
  onRename,
}: {
  open: boolean;
  currentName: string;
  isFolder: boolean;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  // Pre-fill each time it opens, without an effect: the parent remounts it per item.
  const invalid = !value.trim() || value.includes("/");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRename(value.trim());
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't rename.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Rename ${isFolder ? "folder" : "file"}`}
      footer={
        <>
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={`${inputId}-form`} className={PRIMARY} disabled={invalid || busy || value.trim() === currentName}>
            {busy ? "Renaming…" : "Rename"}
          </button>
        </>
      }
    >
      <form id={`${inputId}-form`} onSubmit={submit}>
        <label htmlFor={inputId} className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          New name
        </label>
        <input
          id={inputId}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => {
            // Select the name, not the extension — as Finder does.
            const dot = isFolder ? -1 : event.target.value.lastIndexOf(".");
            event.target.setSelectionRange(0, dot > 0 ? dot : event.target.value.length);
          }}
          autoFocus
          spellCheck={false}
          className="mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3.5 font-mono text-[13.5px] text-ink outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
        />
        {value.includes("/") ? <p className="mt-1.5 text-[12.5px] text-danger">Names can&rsquo;t contain “/”.</p> : null}
        {isFolder ? (
          <p className="mt-2 text-[12.5px] text-ink-muted">
            Object stores have no real folders, so renaming one copies everything inside to the new name and deletes the old copies.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

/** Browse the bucket's folders and pick where to move or copy to — a copy may go to another connection. */
export function DestinationDialog({
  open,
  mode,
  count,
  connectionId,
  bucketName,
  startPath,
  targets,
  onClose,
  onConfirm,
}: {
  open: boolean;
  mode: "move" | "copy";
  count: number;
  connectionId: string;
  bucketName: string;
  startPath: string[];
  /** Copies only: other connections that take writes, offered as destinations. */
  targets?: { id: string; name: string; bucket: string }[];
  onClose: () => void;
  onConfirm: (destination: string, targetConnectionId: string) => Promise<void>;
}) {
  const [targetId, setTargetId] = useState(connectionId);
  const [path, setPath] = useState<string[]>(startPath);
  const [folders, setFolders] = useState<Record<string, string[] | { error: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState("");
  const prefix = path.length ? `${path.join("/")}/` : "";
  const cacheKey = `${targetId}|${prefix}`;
  const here = folders[cacheKey];
  const target = targets?.find((item) => item.id === targetId);
  const shownBucket = targetId === connectionId ? bucketName : (target?.bucket ?? bucketName);

  useEffect(() => {
    if (!open || cacheKey in folders) return;
    api
      .objects(targetId, prefix)
      .then((listing) =>
        setFolders((current) => ({ ...current, [cacheKey]: listing.folders.map((folder) => folder.slice(prefix.length, -1)) })),
      )
      .catch((failure: Error) => setFolders((current) => ({ ...current, [cacheKey]: { error: failure.message } })));
  }, [open, prefix, targetId, cacheKey, folders]);

  async function createFolder() {
    const name = creating.trim();
    if (!name || name.includes("/")) return;
    try {
      await api.folder(targetId, prefix, name);
      setCreating("");
      setFolders((current) => {
        const next = { ...current };
        delete next[cacheKey];
        return next;
      });
      setPath([...path, name]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't create the folder.");
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(prefix, targetId);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `Couldn't ${mode}.`);
    } finally {
      setBusy(false);
    }
  }

  const verb = mode === "move" ? "Move" : "Copy";
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={480}
      title={`${verb} ${count} item${count === 1 ? "" : "s"} to…`}
      footer={
        <>
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={PRIMARY} onClick={confirm} disabled={busy}>
            {busy ? `${verb === "Move" ? "Moving" : "Copying"}…` : `${verb} here`}
          </button>
        </>
      }
    >
      {mode === "copy" && targets?.length ? (
        <label className="mb-3 flex items-center gap-2 text-[13px] text-ink-muted">
          Connection
          <select
            value={targetId}
            onChange={(event) => {
              setTargetId(event.target.value);
              setPath([]);
            }}
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-accent"
          >
            {targets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.id === connectionId ? " (this one)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <nav aria-label="Destination folder" className="-ml-1.5 flex flex-wrap items-center text-[13px]">
        <button type="button" onClick={() => setPath([])} className="rounded-md px-1.5 py-1 font-medium text-accent-strong hover:bg-surface-sunken">
          {shownBucket}
        </button>
        {path.map((segment, index) => (
          <span key={`${segment}-${index}`} className="flex items-center">
            <ChevronRight size={12} className="text-ink-faint" />
            <button
              type="button"
              onClick={() => setPath(path.slice(0, index + 1))}
              className="rounded-md px-1.5 py-1 text-ink hover:bg-surface-sunken"
            >
              {segment}
            </button>
          </span>
        ))}
      </nav>

      <div className="mt-2 min-h-[180px] overflow-hidden rounded-xl border border-line">
        {!here ? (
          <p className="px-3.5 py-3 text-[13px] text-ink-muted" role="status">
            Listing…
          </p>
        ) : "error" in here ? (
          <p className="px-3.5 py-3 text-[13px] text-danger">{here.error}</p>
        ) : here.length === 0 ? (
          <p className="px-3.5 py-3 text-[13px] text-ink-muted">No folders here — this folder itself can be the destination.</p>
        ) : (
          <ul>
            {here.map((name) => (
              <li key={name} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  onClick={() => setPath([...path, name])}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-ink transition hover:bg-surface-sunken"
                >
                  <FolderSymbol size={18} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <ChevronRight size={13} className="text-ink-faint" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          value={creating}
          onChange={(event) => setCreating(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void createFolder();
            }
          }}
          placeholder="New folder here"
          aria-label="New folder name"
          className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
        />
        <button
          type="button"
          onClick={() => void createFolder()}
          disabled={!creating.trim() || creating.includes("/")}
          className="inline-flex items-center gap-1 rounded-lg border border-line-strong px-2.5 py-1.5 text-[12.5px] font-medium text-ink transition hover:bg-surface-sunken disabled:opacity-50"
        >
          <PlusIcon size={13} />
          Create
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

export function DeleteDialog({
  open,
  names,
  folderCount,
  onClose,
  onDelete,
}: {
  open: boolean;
  names: string[];
  folderCount: number;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = names.length;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't delete.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={count === 1 ? `Delete “${names[0]}”?` : `Delete ${count} items?`}
      footer={
        <>
          <button type="button" className={SECONDARY} onClick={onClose} autoFocus>
            Cancel
          </button>
          <button type="button" className={DANGER} onClick={confirm} disabled={busy}>
            {busy ? "Deleting…" : "Delete"}
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink">
        This permanently deletes {count === 1 ? "it" : "them"} from the bucket.
        {folderCount ? (
          <strong className="font-semibold">
            {" "}
            {folderCount === 1 ? "The folder" : `The ${folderCount} folders`} and everything inside will go too.
          </strong>
        ) : null}{" "}
        There is no undo unless the bucket has versioning turned on.
      </p>
      {count > 1 ? (
        <ul className="mt-3 max-h-40 overflow-y-auto rounded-xl border border-line px-3.5 py-2 font-mono text-[12px] text-ink-muted">
          {names.slice(0, 50).map((name) => (
            <li key={name} className="truncate py-0.5">
              {name}
            </li>
          ))}
          {count > 50 ? <li className="py-0.5">…and {count - 50} more</li> : null}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
