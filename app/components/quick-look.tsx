"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef } from "react";
import { isDataFile } from "../lib/data-types";
import { keys } from "../lib/queries";
import { api, keyOf, thumbUrlFor } from "../lib/remote";
import { formatBytes, formatDate, longTypeOf, type StorageNode } from "../lib/storage";
import { DataPreviewContent, previewSummary, useDataPreview } from "./data-preview-dialog";
import { FileGlyph, TINTS } from "./file-glyph";
import { ArrowLeftIcon, ArrowRightIcon, CloseIcon, DownloadIcon } from "./icons";
import { CodeView, languageOf } from "./viewers/code-view";
import { MarkdownView } from "./viewers/markdown-view";

type Kind = "image" | "video" | "audio" | "pdf" | "markdown" | "text" | "data" | "none";

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
/** Images browsers can't draw themselves: the server's thumbnail stands in. */
const THUMB_ONLY = /\.(heic|heif|tiff?)$/i;
const VIDEO = /\.(mp4|m4v|webm|mov|ogv)$/i;
const AUDIO = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
const TEXT =
  /\.(txt|log|rst|csv|tsv|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|m?js|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|graphql|proto|tf|gitignore|editorconfig|lock|svg)$/i;

/** Largest original image Quick Look loads; past it, the thumbnail. */
const IMAGE_LIMIT = 50 * 1024 * 1024;
/** How much of a text file Quick Look shows. */
const TEXT_LIMIT = 1024 * 1024;

export function quickLookKind(name: string): Kind {
  if (isDataFile(name) && !/\.(json)$/i.test(name)) return "data";
  if (/\.(md|markdown)$/i.test(name)) return "markdown";
  if (IMAGE.test(name) || THUMB_ONLY.test(name)) return "image";
  if (VIDEO.test(name)) return "video";
  if (AUDIO.test(name)) return "audio";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (TEXT.test(name) || languageOf(name) || name.toLowerCase() === "dockerfile") return "text";
  if (isDataFile(name)) return "data";
  return "none";
}

const objectUrl = (connectionId: string, key: string) => `/api/connections/${connectionId}/object?key=${encodeURIComponent(key)}`;

type Text = { text: string; truncated: boolean } | { binary: true };

async function fetchText(url: string): Promise<Text> {
  const response = await fetch(url, { headers: { range: `bytes=0-${TEXT_LIMIT - 1}` } });
  if (!response.ok) throw new Error("Couldn't load this file.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.subarray(0, 8000).includes(0)) return { binary: true };
  const total = Number(response.headers.get("content-range")?.split("/")[1]);
  return { text: new TextDecoder("utf-8").decode(bytes), truncated: response.status === 206 && Number.isFinite(total) && total > bytes.length };
}

/**
 * Finder's Quick Look: space bar on a file shows it full size — images, video, audio,
 * PDFs, code with highlighting, Markdown, and data files as a table. Arrow keys move
 * through the folder's files; space or Esc closes.
 */
export function QuickLook({
  node,
  connectionId,
  files,
  onNavigate,
  onClose,
  onOpenKey,
}: {
  node: StorageNode;
  connectionId: string;
  /** The files around it, in the order shown, for ← and →. */
  files: StorageNode[];
  onNavigate: (node: StorageNode) => void;
  onClose: () => void;
  /** A link inside a Markdown file points at another file or folder in the bucket. */
  onOpenKey?: (key: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const index = files.findIndex((file) => file.id === node.id);
  const key = keyOf(node);
  const folder = key.slice(0, key.lastIndexOf("/") + 1);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // Space closes, as in Finder; arrows step through the folder. Typing in a field is left alone.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "VIDEO" || target.tagName === "AUDIO")) return;
      if (event.key === " ") {
        event.preventDefault();
        dialogRef.current?.close();
      } else if ((event.key === "ArrowRight" || event.key === "ArrowDown") && index < files.length - 1) {
        event.preventDefault();
        onNavigate(files[index + 1]);
      } else if ((event.key === "ArrowLeft" || event.key === "ArrowUp") && index > 0) {
        event.preventDefault();
        onNavigate(files[index - 1]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [files, index, onNavigate]);

  function download() {
    void api.url(connectionId, key, true).then(({ url }) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    });
  }

  const step = "flex size-9 items-center justify-center rounded-full text-ink-muted transition hover:bg-surface-sunken hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
      aria-labelledby={titleId}
      className="m-auto h-[calc(100dvh-2.5rem)] w-[calc(100vw-2.5rem)] max-w-[1400px] overflow-hidden rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/45 backdrop:backdrop-blur-[4px]"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <button type="button" className={step} onClick={() => index > 0 && onNavigate(files[index - 1])} disabled={index <= 0} aria-label="Previous file">
            <ArrowLeftIcon size={17} />
          </button>
          <button
            type="button"
            className={step}
            onClick={() => index < files.length - 1 && onNavigate(files[index + 1])}
            disabled={index === -1 || index >= files.length - 1}
            aria-label="Next file"
          >
            <ArrowRightIcon size={17} />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <h2 id={titleId} className="truncate text-[15px] font-semibold text-ink" title={key}>
              {node.name}
            </h2>
            <p className="tnum truncate text-[12px] text-ink-muted">
              {[longTypeOf(node), formatBytes(node.size), node.modified ? formatDate(node.modified) : null, index >= 0 ? `${index + 1} of ${files.length}` : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <button type="button" className={step} onClick={download} aria-label="Download">
            <DownloadIcon size={17} />
          </button>
          <button type="button" className={step} onClick={() => dialogRef.current?.close()} aria-label="Close Quick Look">
            <CloseIcon size={17} />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          <Stage key={node.id} node={node} connectionId={connectionId} folder={folder} onOpenKey={onOpenKey} />
        </div>
        <footer className="border-t border-line px-4 py-1.5 text-center text-[11.5px] text-ink-faint">
          Space or Esc to close · ← → for the next file
        </footer>
      </div>
    </dialog>
  );
}

function Stage({
  node,
  connectionId,
  folder,
  onOpenKey,
}: {
  node: StorageNode;
  connectionId: string;
  folder: string;
  onOpenKey?: (key: string) => void;
}) {
  const key = keyOf(node);
  const kind = quickLookKind(node.name);
  const media = kind === "video" || kind === "audio";
  const urlQuery = useQuery({
    queryKey: keys.url(connectionId, key),
    queryFn: () => api.url(connectionId, key).then(({ url }) => url),
    enabled: media,
    staleTime: 5 * 60_000,
  });
  const textQuery = useQuery({
    queryKey: ["quick-look-text", connectionId, key],
    queryFn: () => fetchText(objectUrl(connectionId, key)),
    enabled: kind === "text" || kind === "markdown",
  });

  if (kind === "data") return <DataStage connectionId={connectionId} objectKey={key} />;

  if (kind === "image") {
    const thumb = thumbUrlFor(node);
    const original = !THUMB_ONLY.test(node.name) && (node.size ?? 0) <= IMAGE_LIMIT ? objectUrl(connectionId, key) : null;
    const src = original ?? thumb;
    if (!src) return <Nothing node={node} note="This image is too large to preview." />;
    return (
      <div className="checkerboard flex min-h-0 flex-1 items-center justify-center p-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- the original, through this app */}
        <img src={src} alt={node.name} className="fade-in max-h-full max-w-full object-contain" />
      </div>
    );
  }

  if (media) {
    if (urlQuery.isError) return <Nothing node={node} note="Couldn't get a link to play this file." />;
    if (!urlQuery.data) return <Loading />;
    return kind === "video" ? (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
        <video src={urlQuery.data} controls autoPlay playsInline className="max-h-full max-w-full" aria-label={node.name} />
      </div>
    ) : (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        <FileGlyph preview={node.preview} size={96} radius={28} />
        <audio src={urlQuery.data} controls autoPlay className="w-full max-w-[560px]" aria-label={node.name} />
      </div>
    );
  }

  if (kind === "pdf") {
    return <iframe src={objectUrl(connectionId, key)} title={`Preview of ${node.name}`} className="min-h-0 w-full flex-1 bg-white" />;
  }

  if (kind === "text" || kind === "markdown") {
    if (textQuery.isError) return <Nothing node={node} note={(textQuery.error as Error).message} />;
    const text = textQuery.data;
    if (!text) return <Loading />;
    if ("binary" in text) return <Nothing node={node} note="Binary file — no text preview." />;
    return (
      <div className="scroll-quiet min-h-0 flex-1 overflow-auto">
        {kind === "markdown" ? (
          <div className="mx-auto max-w-[860px] px-8 py-8">
            <MarkdownView source={text.text} connectionId={connectionId} folder={folder} onOpenKey={onOpenKey} />
          </div>
        ) : (
          <CodeView text={text.text || "(empty file)"} name={node.name} />
        )}
        {text.truncated ? <p className="border-t border-line px-4 py-2 text-[12px] text-ink-faint">Showing the first 1 MB.</p> : null}
      </div>
    );
  }

  return <Nothing node={node} note="No preview for this kind of file." />;
}

function DataStage({ connectionId, objectKey }: { connectionId: string; objectKey: string }) {
  const { preview, error, retry } = useDataPreview(connectionId, objectKey);
  return (
    <>
      {preview ? <p className="tnum border-b border-line px-6 py-2 text-[12.5px] text-ink-muted">{previewSummary(preview)}</p> : null}
      <DataPreviewContent preview={preview} error={error} retry={retry} />
    </>
  );
}

function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center" role="status">
      <span className="size-6 animate-spin rounded-full border-2 border-line-strong border-t-accent" aria-label="Loading" />
    </div>
  );
}

function Nothing({ node, note }: { node: StorageNode; note: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3" style={{ backgroundColor: TINTS[node.preview].bg }}>
      <FileGlyph preview={node.preview} size={96} radius={28} onTint />
      <p className="text-[13px] text-ink-muted">{note}</p>
    </div>
  );
}
