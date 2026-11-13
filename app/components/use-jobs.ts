"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { api, tableChangesOf, type Job } from "../lib/remote";
import type { TableChange } from "../lib/data-types";

/** What the explorer needs to know when a job it started ends: which bucket to re-list, and the verb for the message. */
export type JobMeta = { bucketId: string; verb: string };

/** A pause before work that touches a data-lake table: what would break, and how to go on anyway. */
export type TablePrompt = { changes: TableChange[]; verb: string; proceed: () => void };

const running = (job: Job) => job.status === "running";

/**
 * The background jobs of this page — operations, transfers, share copies — from start to end:
 * follow one, carry on with those still running from before a reload, poll them, and hand
 * each one that ends to `onFinish` with what was noted when it started.
 */
export function useJobs(onFinish: (job: Job, meta: JobMeta | undefined) => void) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const notes = useRef(new Map<string, JobMeta>());

  const finish = useEffectEvent((job: Job) => {
    const meta = notes.current.get(job.id);
    notes.current.delete(job.id);
    onFinish(job, meta);
  });

  // Tasks still running from before a reload carry on in the tray.
  useEffect(() => {
    api
      .jobs()
      .then((list) => setJobs(list.filter(running)))
      .catch(() => {});
  }, []);

  // Running jobs are polled until they end.
  const runningIds = jobs.filter(running).map((job) => job.id).join(",");
  useEffect(() => {
    if (!runningIds) return;
    const timer = window.setInterval(() => {
      for (const id of runningIds.split(",")) {
        api
          .job(id)
          .then((next) => {
            setJobs((current) => current.map((job) => (job.id === id ? next : job)));
            if (!running(next)) finish(next);
          })
          .catch(() => {});
      }
    }, 600);
    return () => window.clearInterval(timer);
  }, [runningIds]);

  function follow(job: Job, meta?: JobMeta) {
    if (meta) notes.current.set(job.id, meta);
    setJobs((current) => (current.some((item) => item.id === job.id) ? current : [job, ...current]));
  }

  return {
    jobs,
    /** Shows a job that just started, noting what to do when it ends. */
    follow,
    /** Shows a job started elsewhere on the page (the share dialog), by its id. */
    followById(jobId: string) {
      api
        .job(jobId)
        .then((job) => follow(job))
        .catch(() => {});
    },
    /** Clears finished jobs from the tray. */
    dismissFinished() {
      setJobs((current) => current.filter(running));
    },
  };
}

/** How a finished job went, in one line for a toast. Share copies have their own words, in the explorer. */
export function jobOutcome(job: Job, verb = "Processed"): string {
  const count = `${job.done.toLocaleString("en-US")} object${job.done === 1 ? "" : "s"}`;
  if (job.status === "done")
    return job.failed.length ? `${verb} ${count} — ${job.failed.length} couldn't be ${verb.toLowerCase()}` : `${verb} ${count}`;
  if (job.status === "cancelled") return `Cancelled after ${count}`;
  return job.error ?? "That task didn't finish";
}

/**
 * Starts work that may touch a data-lake table. When the server answers that it would
 * (409, "lake-table"), nothing has happened yet: `ask` shows what would break, and going on
 * starts it again, acknowledged. Any other failure is thrown, for the dialog to show.
 */
export async function withTableCheck(
  start: (acknowledgeTables: boolean) => Promise<void>,
  verb: string,
  ask: (prompt: TablePrompt) => void,
  report: (message: string) => void,
): Promise<void> {
  try {
    await start(false);
  } catch (error) {
    const changes = tableChangesOf(error);
    if (!changes) throw error;
    ask({ changes, verb, proceed: () => void start(true).catch((failure: Error) => report(failure.message)) });
  }
}
