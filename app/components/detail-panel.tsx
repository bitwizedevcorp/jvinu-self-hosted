"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { copyText } from "../lib/clipboard";
import { isDataFile } from "../lib/data-types";
import { describeDownloadCost, downloadCost, formatUsd, restoreDelay } from "../lib/pricing";
import { publicUrlFor } from "../lib/public-url";
import { keys } from "../lib/queries";
import { api, keyOf, thumbUrlFor, type RemoteConnection } from "../lib/remote";
import { formatBytes, formatDate, longTypeOf, type Bucket, type StorageNode } from "../lib/storage";
import { FileGlyph, TINTS } from "./file-glyph";
import {
  ChevronRight,
  CloseIcon,
  DownloadIcon,
  ExternalIcon,
  FolderIcon,
  LinkIcon,
  LockIcon,
  ShareIcon,
  PinIcon,
  StarIcon,
  TableIcon,
} from "./icons";
import { LakeTableSummary } from "./lake-table";
import { isFolderRoot, placeLabel, profileOf } from "../lib/providers";

type PreviewType = "image" | "video" | "audio" | "pdf" | "text";

const PREVIEWS: [PreviewType, RegExp][] = [
  ["image", /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i],
  ["video", /\.(mp4|m4v|webm|mov|ogv)$/i],
  ["audio", /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i],
  ["pdf", /\.pdf$/i],
  [
    "text",
    /\.(txt|md|markdown|rst|log|csv|tsv|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|m?js|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|graphql|proto|tf|dockerfile|gitignore|editorconfig|lock)$/i,
  ],
];
const previewTypeOf = (name: string): PreviewType | null =>
  PREVIEWS.find(([, pattern]) => pattern.test(name) || pattern.test(`.${name}`))?.[0] ?? null;

/** How much of a text file the inspector shows; fetched as a byte range. */
const TEXT_LIMIT = 256 * 1024;

type TextPreview = { text: string; truncated: boolean } | { binary: true } | { error: string };

/** The first chunk of a text file, through this app (so no CORS), as a byte range. */
async function fetchText(url: string): Promise<TextPreview> {
  const response = await fetch(url, { headers: { range: `bytes=0-${TEXT_LIMIT - 1}` } });
  if (!response.ok) return { error: "Couldn't load a preview." };
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A NUL byte early on means it isn't text, whatever the name says.
  if (bytes.subarray(0, 8000).includes(0)) return { binary: true };
  const total = Number(response.headers.get("content-range")?.split("/")[1]);
  return {
    text: new TextDecoder("utf-8").decode(bytes),
    truncated: response.status === 206 && Number.isFinite(total) && total > bytes.length,
  };
}

const proxyUrl = (connectionId: string, key: string) =>
  `/api/connections/${connectionId}/object?key=${encodeURIComponent(key)}`;

const STAGE = "w-full overflow-hidden rounded-xl border border-line bg-surface-sunken";

function Placeholder({ node, note }: { node: StorageNode; note?: string }) {
  return (
    <div className={`${STAGE} aspect-4/3`}>
      <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ backgroundColor: TINTS[node.preview].bg }}>
        <FileGlyph preview={node.preview} size={72} radius={22} onTint />
        {note ? <p className="text-[11.5px] text-ink-muted">{note}</p> : null}
      </div>
    </div>
  );
}

/**
 * The file itself where the browser can show it — image, video, audio, PDF or text —
 * otherwise its type, not invented artwork.
 */
function PreviewStage({
  node,
  type,
  url,
  thumb,
  onOpenOriginal,
  pdfUrl,
  text,
}: {
  node: StorageNode;
  type: PreviewType | null;
  url?: string | null;
  /** A cached 512 px thumbnail, for images the server can make one of. */
  thumb: string | null;
  onOpenOriginal: () => void;
  pdfUrl: string;
  text?: TextPreview;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  if (type === "image" && thumb && !thumbFailed) {
    return (
      <div className="space-y-1.5">
        <div className={`${STAGE} aspect-4/3`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- resized and cached by our server */}
          <img src={thumb} alt={node.name} onError={() => setThumbFailed(true)} className="fade-in h-full w-full object-contain" />
        </div>
        <button
          type="button"
          onClick={onOpenOriginal}
          className="inline-flex items-center gap-1 px-1 text-[12px] font-medium text-accent-strong hover:underline"
        >
          Open original <ExternalIcon size={12} />
        </button>
      </div>
    );
  }
  if (type === "image" && thumb && thumbFailed) {
    return (
      <div className="space-y-1.5">
        <Placeholder node={node} note="No preview for this image" />
        <button type="button" onClick={onOpenOriginal} className="inline-flex items-center gap-1 px-1 text-[12px] font-medium text-accent-strong hover:underline">
          Open original <ExternalIcon size={12} />
        </button>
      </div>
    );
  }
  if (type === "image" && url) {
    return (
      <div className={`${STAGE} aspect-4/3`}>
        {/* A presigned URL: next/image would proxy it through the server for no benefit. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={node.name} className="fade-in h-full w-full object-contain" />
      </div>
    );
  }
  if (type === "video" && url) {
    return (
      <div className={`${STAGE} aspect-video bg-black`}>
        <video key={url} src={url} controls preload="metadata" playsInline className="h-full w-full" aria-label={node.name} />
      </div>
    );
  }
  if (type === "audio" && url) {
    return (
      <div className="space-y-2">
        <Placeholder node={node} />
        <audio key={url} src={url} controls preload="metadata" className="w-full" aria-label={node.name} />
      </div>
    );
  }
  if (type === "pdf") {
    return (
      <div className="space-y-1.5">
        <div className={`${STAGE} h-[440px] bg-white`}>
          <iframe key={pdfUrl} src={pdfUrl} title={`Preview of ${node.name}`} className="h-full w-full" />
        </div>
        <a href={pdfUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-1 text-[12px] font-medium text-accent-strong hover:underline">
          Open full size <ExternalIcon size={12} />
        </a>
      </div>
    );
  }
  if (type === "text" && text) {
    if ("binary" in text) return <Placeholder node={node} note="Binary file — no text preview" />;
    if ("error" in text) return <Placeholder node={node} note={text.error} />;
    return (
      <div className={STAGE}>
        <pre className="scroll-quiet fade-in max-h-[380px] overflow-auto whitespace-pre p-3 font-mono text-[11.5px] leading-[1.55] text-ink">
          {text.text || "(empty file)"}
        </pre>
        {text.truncated ? (
          <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-faint">Showing the first 256 KB.</p>
        ) : null}
      </div>
    );
  }
  return <Placeholder node={node} note={type && url === undefined ? "Loading preview…" : undefined} />;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
        {title}
      </h3>
      <div className="overflow-hidden rounded-xl border border-line bg-surface-raised/70">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  children,
  mono = false,
  onCopy,
  title,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  onCopy?: () => void;
  title?: string;
}) {
  const value = (
    <span
      className={`min-w-0 truncate text-right text-[12.5px] ${
        mono ? "font-mono text-ink" : "font-medium text-ink"
      }`}
    >
      {children}
    </span>
  );
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line px-3.5 py-2.5 last:border-b-0">
      <span className="shrink-0 text-[12.5px] text-ink-muted">{label}</span>
      {onCopy ? (
        <button
          type="button"
          onClick={onCopy}
          title={title ? `${title} — click to copy` : "Click to copy"}
          className="spring -mr-1.5 flex min-w-0 items-center rounded-md px-1.5 py-0.5 transition-colors hover:bg-surface-sunken"
        >
          {value}
        </button>
      ) : (
        value
      )}
    </div>
  );
}

export function DetailPanel({
  node,
  onClose,
  starred,
  onToggleStar,
  onShare,
  onZip,
  bucket,
  connection,
  onNotify,
  folderContents,
  onOpenNode,
  onSelectNode,
  onAction,
  onPreviewData,
  onQuickLook,
  teamPinned = false,
  onToggleTeamPin,
}: {
  node: StorageNode;
  onClose: () => void;
  starred: boolean;
  onToggleStar: () => void;
  /** Opens the share dialog for this file. */
  onShare: () => void;
  /** Downloads this folder as one zip. */
  onZip: () => void;
  /** The bucket this object lives in. */
  bucket: Bucket;
  /** The connection this object came through. */
  connection?: RemoteConnection;
  onNotify: (message: string) => void;
  /** For a folder: its direct children, `undefined` while that level is still loading. */
  folderContents?: StorageNode[];
  onOpenNode: (node: StorageNode) => void;
  onSelectNode: (node: StorageNode) => void;
  /** Write actions; not offered when the connection is read-only. */
  onAction: (action: "rename" | "move" | "copy" | "delete" | "metadata", node: StorageNode) => void;
  /** Opens the data preview for a Parquet, CSV, JSON or Avro file. */
  onPreviewData?: () => void;
  /** Shows the file full size (the space bar does the same). */
  onQuickLook?: () => void;
  /** Pinned for everyone on this server. */
  teamPinned?: boolean;
  onToggleTeamPin?: () => void;
}) {
  const connectionId = bucket.remote.connectionId;
  const isFolder = node.kind === "folder";
  const key = keyOf(node);
  const uri =
    connection && isFolderRoot(connection.presetId)
      ? `${connection.bucket === "/" ? "" : connection.bucket}/${key}`
      : `s3://${bucket.name}/${key}`;
  const previewType = isFolder ? null : previewTypeOf(node.name);
  // Images and media come from a signed link where the provider gives one (else this app).
  // Images show a cached thumbnail (the original opens on request); the rest need a URL.
  const thumb = isFolder ? null : thumbUrlFor(node);
  const tooBigToPreview = previewType === "image" && !thumb && (node.size ?? 0) > 50 * 1024 * 1024;
  const wantsUrl = (previewType === "image" && !thumb && !tooBigToPreview) || previewType === "video" || previewType === "audio";
  const endpoint = connection?.endpoint;
  // Behind a CDN or custom domain: the base the user set, plus this key (never for ciphertext).
  const publicBase = connection && !connection.encrypted ? connection.settings.publicBaseUrl : undefined;
  const publicUrl = !isFolder && publicBase ? publicUrlFor(publicBase, key) : null;
  const bucketLabel = placeLabel(connection?.presetId ?? "s3");

  // Images and media play straight from the provider through a short-lived signed URL
  // (cached a few minutes — well inside the shortest link lifetime).
  const urlQuery = useQuery({
    queryKey: keys.url(connectionId, key),
    queryFn: () => api.url(connectionId, key).then(({ url }) => url),
    enabled: wantsUrl,
    staleTime: 5 * 60_000,
  });
  const previewUrl = !wantsUrl ? undefined : urlQuery.isError ? null : urlQuery.data;

  // Text: the first 256 KB, as a range request to this app.
  const textQuery = useQuery({
    queryKey: keys.text(connectionId, key),
    queryFn: () => fetchText(proxyUrl(connectionId, key)).catch((): TextPreview => ({ error: "Couldn't load a preview." })),
    enabled: previewType === "text",
  });

  // How the provider says this file is encrypted at rest.
  const headQuery = useQuery({
    queryKey: keys.head(connectionId, key),
    queryFn: () => api.head(connectionId, key),
    enabled: !isFolder,
    staleTime: 60_000,
  });
  const encryption = headQuery.data?.encryption;

  // A folder's totals need every object under it — fetched once per folder.
  const statsQuery = useQuery({
    queryKey: keys.stats(connectionId, key),
    queryFn: () => api.stats(connectionId, key),
    enabled: isFolder,
  });
  const folderStats = statsQuery.data ?? (statsQuery.error ? { error: statsQuery.error.message } : undefined);
  const children = folderContents
    ? [...folderContents].sort(
        (a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === "folder" ? -1 : 1),
      )
    : undefined;

  async function copy(text: string, what: string) {
    onNotify((await copyText(text)) ? `${what} copied` : `Couldn't reach the clipboard — ${what.toLowerCase()} not copied`);
  }

  // What a download costs, and whether this class must be restored or charges to read.
  const classId = node.storageClassId ?? null;
  const cost = connection
    ? downloadCost(connection.presetId, connection.endpoint, classId, node.size ?? 0, connection.settings?.egressPerGb)
    : null;
  const restore = connection ? restoreDelay(connection.presetId, connection.endpoint, classId) : null;
  const retrievalUsd = cost?.kind === "estimate" ? cost.retrievalUsd : 0;
  const needsConfirm = Boolean(restore) || retrievalUsd > 0;
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const confirming = confirmFor === node.id;

  function requestDownload() {
    if (needsConfirm && !confirming) {
      setConfirmFor(node.id);
      return;
    }
    setConfirmFor(null);
    handleDownload();
  }

  function handleDownload() {
    api
      .url(connectionId, key, true)
      .then(({ url }) => {
        // The signed URL carries Content-Disposition: attachment, so this saves
        // the file instead of navigating away.
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      })
      .catch((error: Error) => onNotify(`Download failed — ${error.message}`));
  }

  return (
    <aside
      aria-label={`Quick Look: ${node.name}`}
      className="material inspector-in flex h-full flex-col overflow-hidden rounded-2xl border border-line shadow-panel"
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
          Quick Look
        </span>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-strong">
          Inspector
        </span>
        <span className="flex-1" />
        {!isFolder && onQuickLook ? (
          <button
            type="button"
            onClick={onQuickLook}
            title="Quick Look (space)"
            className="spring rounded-full px-2.5 py-1 text-[12px] font-semibold text-accent-strong transition hover:bg-accent-soft active:scale-[0.96]"
          >
            Full size
          </button>
        ) : null}
        {onToggleTeamPin ? (
          <button
            type="button"
            onClick={onToggleTeamPin}
            aria-label={teamPinned ? "Unpin for the team" : "Pin for the team"}
            title={teamPinned ? "Unpin for the team" : "Pin for the team — everyone here sees it"}
            aria-pressed={teamPinned}
            className={`spring flex size-8 items-center justify-center rounded-full transition hover:bg-surface-sunken active:scale-[0.94] ${
              teamPinned ? "text-accent-strong" : "text-ink-faint hover:text-ink"
            }`}
          >
            <PinIcon size={16} fill={teamPinned ? "currentColor" : "none"} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onToggleStar}
          aria-label={starred ? "Remove from starred" : "Add to starred"}
          aria-pressed={starred}
          className={`spring flex size-8 items-center justify-center rounded-full transition hover:bg-surface-sunken active:scale-[0.94] ${
            starred ? "text-warning" : "text-ink-faint hover:text-ink"
          }`}
        >
          <StarIcon size={16} fill={starred ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="spring flex size-8 items-center justify-center rounded-full text-ink-faint transition hover:bg-surface-sunken hover:text-ink active:scale-[0.94]"
        >
          <CloseIcon size={16} />
        </button>
      </header>

      <div className="scroll-quiet flex-1 overflow-y-auto px-4 pb-5 pt-4">
        <PreviewStage
          key={node.id}
          node={node}
          type={previewType}
          url={previewUrl}
          thumb={thumb}
          onOpenOriginal={() => {
            // Opened inside the click so pop-up blockers allow it; the address follows.
            const tab = window.open("", "_blank");
            if (!tab) return;
            tab.opener = null;
            api
              .url(connectionId, key)
              .then(({ url }) => {
                tab.location.href = url;
              })
              .catch(() => tab.close());
          }}
          pdfUrl={proxyUrl(connectionId, key)}
          text={textQuery.data}
        />

        <div className="mt-3 text-center">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">
            {isFolder ? `${node.name}/` : node.name}
          </h2>
          <p className="tnum mt-0.5 truncate text-[12.5px] text-ink-muted">
            {isFolder
              ? children
                ? `Folder · ${children.length} item${children.length === 1 ? "" : "s"} inside`
                : "Folder"
              : `${longTypeOf(node)} · ${formatBytes(node.size)}`}
          </p>
        </div>

        {isFolder ? (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onOpenNode(node)}
              className="spring inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent-fill px-3 py-2.5 text-[13.5px] font-semibold text-white shadow-card transition hover:bg-accent-hover active:scale-[0.98]"
            >
              <FolderIcon size={15} />
              Open Folder
            </button>
            <button
              type="button"
              onClick={() => copy(uri, "Folder path")}
              className="spring inline-flex items-center justify-center gap-1.5 rounded-xl border border-line bg-surface-sunken px-3 py-2.5 text-[13.5px] font-semibold text-ink transition hover:bg-surface-raised active:scale-[0.98]"
            >
              <LinkIcon size={15} />
              Copy Path
            </button>
            <button
              type="button"
              onClick={onZip}
              aria-haspopup="dialog"
              className="spring col-span-2 inline-flex items-center justify-center gap-1.5 rounded-xl border border-line bg-surface-sunken px-3 py-2 text-[13px] font-semibold text-ink transition hover:bg-surface-raised active:scale-[0.98]"
            >
              <DownloadIcon size={15} />
              Download as zip
            </button>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onShare}
              aria-haspopup="dialog"
              className="spring inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent-fill px-3 py-2.5 text-[13.5px] font-semibold text-white shadow-card transition hover:bg-accent-hover active:scale-[0.98]"
            >
              <ShareIcon size={15} />
              Share…
            </button>
            <button
              type="button"
              onClick={requestDownload}
              className="spring inline-flex items-center justify-center gap-1.5 rounded-xl border border-line bg-surface-sunken px-3 py-2.5 text-[13.5px] font-semibold text-ink transition hover:bg-surface-raised active:scale-[0.98]"
            >
              <DownloadIcon size={15} />
              Download
            </button>
            {onPreviewData && isDataFile(node.name) ? (
              <button
                type="button"
                onClick={onPreviewData}
                aria-haspopup="dialog"
                className="spring col-span-2 inline-flex items-center justify-center gap-1.5 rounded-xl border border-line bg-surface-sunken px-3 py-2 text-[13px] font-semibold text-ink transition hover:bg-surface-raised active:scale-[0.98]"
              >
                <TableIcon size={15} />
                Preview data
              </button>
            ) : null}
          </div>
        )}

        {!isFolder && cost ? (
          <p className="tnum mt-2 text-center text-[11.5px] text-ink-faint">{describeDownloadCost(cost)}</p>
        ) : null}

        {!isFolder && confirming ? (
          <div role="alert" className="pop-in mt-3 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink">
            <p>
              {restore ? (
                <>
                  <span className="font-semibold">{node.storageClass ?? "This class"} files must be restored before they can be read</span>{" "}
                  — that takes {restore}
                  {retrievalUsd > 0 ? `, and retrieving this one costs about ${formatUsd(retrievalUsd)}` : ""}. Start the restore in your
                  provider&rsquo;s console; downloading before it finishes will fail.
                </>
              ) : (
                <>
                  <span className="font-semibold">Reading from {node.storageClass ?? "this class"} isn&rsquo;t free:</span> about{" "}
                  {formatUsd(retrievalUsd)} in retrieval fees, on top of the download itself.
                </>
              )}
            </p>
            <div className="mt-2.5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmFor(null)} className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-muted hover:bg-surface hover:text-ink">
                Cancel
              </button>
              <button type="button" onClick={requestDownload} className="rounded-lg bg-warning px-2.5 py-1.5 text-[12.5px] font-semibold text-black hover:brightness-95">
                {restore ? "Try anyway" : "Download anyway"}
              </button>
            </div>
          </div>
        ) : null}

        {isFolder ? (
          <>
            <div className="mt-4 empty:hidden">
              <LakeTableSummary connectionId={connectionId} prefix={key} />
            </div>
            <Group title="Contents">
              {!folderStats ? (
                <div className="px-3.5 py-3 text-[12.5px] text-ink-muted" role="status">
                  Counting everything inside…
                </div>
              ) : "error" in folderStats ? (
                <div className="px-3.5 py-3 text-[12.5px] text-ink-muted" role="alert">
                  Couldn&rsquo;t total this folder — {folderStats.error}
                </div>
              ) : (
                <>
                  <Row label="Objects (all levels)">
                    <span className="tnum">
                      {folderStats.truncated ? "≥ " : ""}
                      {folderStats.objects.toLocaleString("en-US")}
                    </span>
                  </Row>
                  <Row label="Total size">
                    <span className="tnum">
                      {folderStats.truncated ? "≥ " : ""}
                      {formatBytes(folderStats.bytes)}
                    </span>
                  </Row>
                  {folderStats.lastModified ? (
                    <Row label="Last changed">
                      <span className="tnum">{formatDate(folderStats.lastModified.slice(0, 10))}</span>
                    </Row>
                  ) : null}
                </>
              )}
            </Group>

            <Group title="Inside">
              {!children ? (
                <div className="px-3.5 py-3 text-[12.5px] text-ink-muted" role="status">
                  Listing…
                </div>
              ) : children.length === 0 ? (
                <div className="px-3.5 py-3 text-[12.5px] text-ink-muted">This folder is empty.</div>
              ) : (
                <ul>
                  {children.slice(0, 8).map((child) => (
                    <li key={child.id} className="border-b border-line last:border-b-0">
                      <button
                        type="button"
                        onClick={() => (child.kind === "folder" ? onOpenNode(child) : onSelectNode(child))}
                        className="spring flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-sunken"
                      >
                        <FileGlyph preview={child.preview} size={26} radius={8} />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
                          {child.kind === "folder" ? `${child.name}/` : child.name}
                        </span>
                        <span className="tnum shrink-0 text-[11.5px] text-ink-faint">
                          {child.kind === "folder" ? "" : formatBytes(child.size)}
                        </span>
                        {child.kind === "folder" ? <ChevronRight size={13} className="shrink-0 text-ink-faint" /> : null}
                      </button>
                    </li>
                  ))}
                  {children.length > 8 ? (
                    <li>
                      <button
                        type="button"
                        onClick={() => onOpenNode(node)}
                        className="w-full px-3.5 py-2 text-left text-[12.5px] font-medium text-accent-strong hover:bg-surface-sunken"
                      >
                        {children.length - 8} more — open the folder
                      </button>
                    </li>
                  ) : null}
                </ul>
              )}
            </Group>
          </>
        ) : null}

        {connection?.readOnly ? (
          <p className="mt-3 rounded-lg bg-surface-sunken px-3 py-2 text-center text-[12px] text-ink-muted">
            Read-only connection — changes are turned off.
          </p>
        ) : (
          <div className="mt-2 grid grid-cols-4 gap-1.5" role="group" aria-label="Change this item">
            {(
              [
                ["rename", "Rename"],
                ["move", "Move…"],
                ["copy", "Copy…"],
                ["delete", "Delete"],
              ] as const
            ).map(([action, label]) => (
              <button
                key={action}
                type="button"
                onClick={() => onAction(action, node)}
                className={`spring rounded-lg border border-line px-1 py-1.5 text-[12px] font-medium transition hover:bg-surface-sunken active:scale-[0.97] ${
                  action === "delete" ? "text-danger" : "text-ink"
                }`}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => onAction("metadata", node)}
              className="spring col-span-4 rounded-lg border border-line px-1 py-1.5 text-[12px] font-medium text-ink transition hover:bg-surface-sunken active:scale-[0.97]"
            >
              Edit metadata…
            </button>
          </div>
        )}

        <Group title="Information">
          <Row label="Key" mono onCopy={() => copy(uri, profileOf(connection?.presetId ?? "s3")?.pathLabel ?? "S3 URI")} title={uri}>
            {key}
          </Row>
          {publicUrl ? (
            <Row label="Public URL" mono onCopy={() => copy(publicUrl, "Public URL")} title={publicUrl}>
              {publicUrl.replace(/^https:\/\//, "")}
            </Row>
          ) : null}
          {node.etag ? (
            <Row label="ETag" mono onCopy={() => copy(node.etag ?? "", "ETag")} title={node.etag}>
              {node.etag.slice(0, 12)}…
            </Row>
          ) : null}
          {node.storageClass ? <Row label="Storage class">{node.storageClass}</Row> : null}
          {encryption && encryption.state !== "unknown" ? (
            <Row label="Encryption">
              <span className={encryption.state === "encrypted" ? "inline-flex items-center gap-1" : "text-ink-muted"}>
                {encryption.state === "encrypted" ? <LockIcon size={11} className="text-success" /> : null}
                {encryption.state === "encrypted" ? (encryption.detail ?? "Encrypted") : "Not encrypted at rest"}
              </span>
            </Row>
          ) : null}
          {node.modified ? (
            <Row label="Modified">
              <span className="tnum">{formatDate(node.modified)}</span>
            </Row>
          ) : null}
          <Row label={bucketLabel}>{bucket.name}</Row>
          {endpoint ? (
            <Row label="Endpoint">{new URL(endpoint).host}</Row>
          ) : bucket.region ? (
            <Row label="Region">{bucket.region}</Row>
          ) : null}
        </Group>
      </div>
    </aside>
  );
}
