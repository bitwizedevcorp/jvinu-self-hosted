"use client";

import type { Job } from "../lib/remote";
import { formatBytes } from "../lib/storage";
import { CheckIcon, CloseIcon } from "./icons";

const STATUS: Record<Job["status"], string> = {
  running: "",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

/**
 * Background copies, moves, renames and deletes — and copies into the share bucket:
 * progress while they run, a summary when they end. Sits above the upload tray when both
 * are open.
 */
export function JobsTray({
  jobs,
  raised,
  onCancel,
  onDismiss,
}: {
  jobs: Job[];
  /** The upload tray is open below. */
  raised: boolean;
  onCancel: (id: string) => void;
  onDismiss: () => void;
}) {
  const running = jobs.filter((job) => job.status === "running").length;
  return (
    <section
      aria-label="Background tasks"
      className={`material-thick tray-in fixed right-5 z-40 w-[min(360px,calc(100vw-2.5rem))] overflow-hidden rounded-2xl border border-line shadow-pop ${
        raised ? "bottom-[calc(1.25rem+min(15rem,40vh)+4.5rem)]" : "bottom-5"
      }`}
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="flex-1 text-[13px] font-semibold text-ink" aria-live="polite">
          {running ? `${running} task${running === 1 ? "" : "s"} running…` : "Tasks finished"}
        </h2>
        {running ? null : (
          <button type="button" onClick={onDismiss} aria-label="Dismiss tasks" className="rounded-full p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink">
            <CloseIcon size={14} />
          </button>
        )}
      </header>
      <ul className="scroll-quiet max-h-60 overflow-y-auto">
        {jobs.map((job) => {
          const percent = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : job.status === "done" ? 100 : 0;
          const failed = job.failed.length;
          return (
            <li key={job.id} className="border-b border-line px-4 py-2.5 last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink" title={job.label}>
                  {job.label}
                </span>
                {job.status === "running" ? (
                  <button
                    type="button"
                    onClick={() => onCancel(job.id)}
                    className="shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-medium text-ink-faint transition hover:bg-danger/10 hover:text-danger"
                  >
                    Cancel
                  </button>
                ) : job.status === "done" && !failed ? (
                  <CheckIcon size={14} className="shrink-0 text-success" />
                ) : (
                  <span className={`shrink-0 text-[11.5px] font-medium ${job.status === "cancelled" ? "text-ink-faint" : "text-danger"}`}>
                    {STATUS[job.status]}
                  </span>
                )}
              </div>
              <div
                className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-sunken"
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={job.label}
              >
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ${
                    job.status === "running" ? "bg-accent" : job.status === "done" && !failed ? "bg-success" : "bg-warning"
                  }`}
                  style={{ width: `${job.status === "running" && !job.total ? 8 : percent}%` }}
                />
              </div>
              <p className="tnum mt-1 text-[11px] text-ink-faint">
                {job.status === "running" && !job.total
                  ? "Working out what to do…"
                  : job.op === "share-copy"
                    ? `${formatBytes(job.done)} of ${formatBytes(job.total)}`
                    : `${job.done.toLocaleString("en-US")} of ${job.total.toLocaleString("en-US")} object${job.total === 1 ? "" : "s"}`}
                {failed ? ` · ${failed.toLocaleString("en-US")} couldn't be done` : ""}
                {job.error ? ` · ${job.error}` : ""}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
