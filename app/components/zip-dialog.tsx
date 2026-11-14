"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef } from "react";
import { downloadCost, formatUsd, PRICE_SHEETS } from "../lib/pricing";
import { api, type OperationItem, type RemoteConnection } from "../lib/remote";
import { formatBytes } from "../lib/storage";
import { ArchiveIcon, CloseIcon, DownloadIcon } from "./icons";

export type ZipRequest = { items: OperationItem[]; base: string; name: string };

/** What downloading `bytes` per storage class costs here, summed; null when there's no estimate. */
function costOf(connection: RemoteConnection, byClass: { storageClass: string | null; bytes: number }[]): string {
  let usd = 0;
  for (const { storageClass, bytes } of byClass) {
    const cost = downloadCost(connection.presetId, connection.endpoint, storageClass, bytes, connection.settings?.egressPerGb);
    if (cost.kind === "estimate") usd += cost.usd;
    else if (cost.kind === "plan") return "No per-download fee: this service bills by plan";
    else if (cost.kind === "unknown") return "No download estimate for this connection";
  }
  return usd > 0 ? `About ${formatUsd(usd)} to download` : PRICE_SHEETS[connection.presetId] === "self-hosted" ? "Free to download — it's on your own server" : "Free to download";
}

/**
 * One download for many files: works out what's in the zip (and what it costs) first,
 * then hands the archive to the browser to save like any download.
 */
export function ZipDialog({
  connection,
  request,
  onClose,
  onNotify,
}: {
  connection: RemoteConnection;
  request: ZipRequest;
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const plan = useQuery({
    queryKey: ["zip", connection.id, request],
    queryFn: () => api.zip(connection.id, request),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const data = plan.data;
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
      aria-labelledby={`${id}-title`}
      style={{ width: "min(420px, calc(100vw - 2rem))" }}
      className="m-auto rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <header className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
          <ArchiveIcon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="text-[16px] font-semibold text-ink">
            Download as zip
          </h2>
          <p className="truncate text-[12.5px] text-ink-muted">{data?.name ?? `${request.name}.zip`}</p>
        </div>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          aria-label="Close"
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
        >
          <CloseIcon size={16} />
        </button>
      </header>

      <div className="space-y-3 px-5 py-5 text-[13px] leading-relaxed text-ink-muted">
        {plan.isPending ? (
          <p role="status">Counting what&rsquo;s in it…</p>
        ) : plan.isError ? (
          <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-ink">
            {plan.error.message}
          </p>
        ) : data ? (
          <>
            <p className="tnum text-[15px] font-semibold text-ink">
              {data.files.toLocaleString("en-US")} file{data.files === 1 ? "" : "s"} · {formatBytes(data.bytes)}
            </p>
            <p className="tnum">{costOf(connection, data.byClass)}.</p>
            {data.archived ? (
              <p className="rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-ink">
                {data.archived.toLocaleString("en-US")} file{data.archived === 1 ? " is" : "s are"} in an archive storage class.
                Unless restored first, they&rsquo;ll be left out — the zip then lists them in jvinu-skipped.txt.
              </p>
            ) : null}
            <p className="text-[12px] text-ink-faint">
              Photos, video, music and archives go in as they are; everything else is compressed. Folders keep their structure.
            </p>
          </>
        ) : null}
      </div>

      <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="rounded-xl border border-line-strong bg-surface px-4 py-2 text-[14px] font-semibold text-ink transition hover:bg-surface-sunken"
        >
          Cancel
        </button>
        {data ? (
          <a
            href={data.url}
            download={data.name}
            onClick={() => {
              onNotify(`Downloading ${data.name} — your browser shows how it's going`);
              // Closing after the click lets the browser start the download first.
              window.setTimeout(() => ref.current?.close(), 0);
            }}
            className="spring inline-flex items-center gap-2 rounded-xl bg-accent-fill px-4 py-2 text-[14px] font-semibold text-white transition hover:bg-accent-hover active:scale-[0.98]"
          >
            <DownloadIcon size={15} />
            Download
          </a>
        ) : null}
      </footer>
    </dialog>
  );
}
