"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { keys } from "../lib/queries";
import { api } from "../lib/remote";
import { formatBytes } from "../lib/storage";
import { BLOCK_GB, formatEur, MAX_BLOCKS, type PlanView } from "../lib/storage-plan";
import { CheckIcon, CloseIcon, CloudIcon, ExternalIcon } from "./icons";

/** Why the dialog opened: from the menu, or back from the payment or billing page. */
export type PlanReturn = "paid" | "canceled" | "managed" | null;

const QUICK = [1, 5, 10, 20];
const sizeLabel = (blocks: number) => {
  const gb = blocks * BLOCK_GB;
  return gb >= 1000 && gb % 1000 === 0 ? `${gb / 1000} TB` : `${gb.toLocaleString("en-US")} GB`;
};

/** How long to wait for the seller to confirm a payment before saying so. */
const WAIT_MS = 120_000;

const BUTTON_PRIMARY =
  "spring rounded-xl bg-accent-fill px-4 py-2 text-[13.5px] font-semibold text-white transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-60";
const BUTTON_SECONDARY =
  "rounded-xl border border-line-strong bg-surface px-4 py-2 text-[13.5px] font-semibold text-ink transition hover:bg-surface-sunken disabled:opacity-60";

/**
 * Buying storage for this server: pick a size, pay on Stripe, and a "Cloud storage"
 * connection appears once the payment is confirmed. With a plan, it shows usage and
 * opens the billing page to change size, update the card, or cancel.
 */
export function StoragePlanDialog({ returning, onClose }: { returning: PlanReturn; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const queryClient = useQueryClient();
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [blocks, setBlocks] = useState(1);
  const [billing, setBilling] = useState<"month" | "year">("month");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(returning === "paid");
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  // Load the plan; after paying or changing it, ask the seller straight away.
  useEffect(() => {
    let stopped = false;
    const load = returning === "paid" || returning === "managed" ? api.syncStoragePlan : api.storagePlan;
    load()
      .then((view) => {
        if (stopped) return;
        setPlan(view);
        setBlocks((current) => Math.max(current, view.minBlocks));
        if (returning === "managed") void queryClient.invalidateQueries({ queryKey: ["disk"] });
      })
      .catch((failure: Error) => !stopped && setError(failure.message));
    return () => {
      stopped = true;
    };
  }, [returning, queryClient]);

  // Back from paying: the webhook can land a few seconds after the redirect. Poll until the
  // bucket is connected, then show the new connection in the sidebar.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const view = await api.syncStoragePlan();
        if (stopped) return;
        setPlan(view);
        if (view.status === "active" && view.connectionId) {
          setWaiting(false);
          await queryClient.invalidateQueries({ queryKey: keys.connections });
          return;
        }
      } catch {
        // The seller may still be making the bucket; keep trying until the deadline.
      }
      if (stopped) return;
      if (Date.now() - started > WAIT_MS) {
        setWaiting(false);
        setTimedOut(true);
        return;
      }
      timer = window.setTimeout(() => void tick(), 3000);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [waiting, queryClient]);

  async function buy() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { checkoutUrl } = await api.buyStorage(blocks, billing);
      window.location.assign(checkoutUrl);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't start the payment.");
      setBusy(false);
    }
  }

  async function manage() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.storagePortal();
      window.location.assign(url);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't open billing.");
      setBusy(false);
    }
  }

  const hasPlan =
    plan && (plan.status === "active" || plan.status === "past_due" || plan.status === "canceled" || plan.status === "suspended");
  const close = () => ref.current?.close();

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) close();
      }}
      aria-labelledby={`${id}-title`}
      style={{ width: "min(460px, calc(100vw - 2rem))" }}
      className="m-auto max-h-[calc(100dvh-2rem)] rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
            <CloudIcon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="text-[16px] font-semibold text-ink">
              {hasPlan ? "Storage plan" : "Buy storage"}
            </h2>
            <p className="text-[12.5px] text-ink-muted">
              {plan ? `${formatEur(plan.priceCents)} per ${BLOCK_GB} GB a month, VAT included` : "Loading…"}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <div className="scroll-quiet min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {returning === "canceled" && !hasPlan ? (
            <p role="status" className="rounded-xl bg-surface-sunken px-3.5 py-2.5 text-[13px] text-ink-muted">
              The payment was cancelled. Nothing was charged.
            </p>
          ) : null}

          {waiting ? (
            <div className="py-6 text-center" role="status" aria-live="polite">
              <span className="mx-auto block size-6 animate-spin rounded-full border-2 border-line border-t-accent" />
              <p className="mt-3 text-[15px] font-semibold text-ink">Setting up your storage…</p>
              <p className="mx-auto mt-1 max-w-[320px] text-[13px] text-ink-muted">
                Payment received. Your private bucket is being created; this takes a few seconds.
              </p>
            </div>
          ) : plan?.status === "active" && plan.connectionId && returning === "paid" ? (
            <div className="py-6 text-center" role="status">
              <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-success-soft text-success-ink">
                <CheckIcon size={20} />
              </span>
              <p className="mt-3 text-[15px] font-semibold text-ink">{formatBytes(plan.quotaBytes)} is ready</p>
              <p className="mx-auto mt-1 max-w-[320px] text-[13px] text-ink-muted">
                Find it as “Cloud storage” in the sidebar. Upload to it like any other connection.
              </p>
            </div>
          ) : hasPlan && plan ? (
            <PlanSummary plan={plan} />
          ) : plan && !plan.available ? (
            <p className="text-[13.5px] text-ink-muted">Buying storage isn&rsquo;t set up on this server.</p>
          ) : plan ? (
            <>
              <p className="text-[13.5px] leading-relaxed text-ink-muted">
                A private bucket for this jvinu. Add or remove space, or cancel, at any time from this menu.
              </p>
              {plan.yearlyPriceCents ? (
                <div role="group" aria-label="Billing" className="flex gap-0.5 rounded-xl bg-surface-sunken p-0.5">
                  {(["month", "year"] as const).map((period) => (
                    <button
                      key={period}
                      type="button"
                      aria-pressed={billing === period}
                      onClick={() => setBilling(period)}
                      className={`flex-1 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition ${
                        billing === period ? "bg-surface-raised text-ink shadow-card" : "text-ink-muted hover:text-ink"
                      }`}
                    >
                      {period === "month" ? "Monthly" : "Yearly"}
                      {period === "year" && (plan.yearlyPriceCents ?? Infinity) < plan.priceCents * 12 ? (
                        <span className="ml-1.5 text-[11.5px] font-semibold text-success-ink">
                          save {Math.round((1 - (plan.yearlyPriceCents ?? 0) / (plan.priceCents * 12)) * 100)}%
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <fieldset>
                <legend className="text-[12.5px] font-medium text-ink">How much space?</legend>
                <div className="mt-2 grid grid-cols-4 gap-1.5">
                  {[...new Set([plan.minBlocks, ...QUICK.filter((option) => option > plan.minBlocks)])].slice(0, 4).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={blocks === option}
                      onClick={() => setBlocks(option)}
                      className={`rounded-xl border px-2 py-2 text-[13px] font-semibold transition ${
                        blocks === option
                          ? "border-accent bg-accent-soft text-accent-strong"
                          : "border-line bg-surface text-ink hover:bg-surface-sunken"
                      }`}
                    >
                      {sizeLabel(option)}
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={`${BLOCK_GB} GB less`}
                    disabled={blocks <= plan.minBlocks}
                    onClick={() => setBlocks((value) => Math.max(plan.minBlocks, value - 1))}
                    className="flex size-9 items-center justify-center rounded-xl border border-line text-[16px] font-semibold text-ink transition hover:bg-surface-sunken disabled:opacity-40"
                  >
                    −
                  </button>
                  <output
                    htmlFor={`${id}-total`}
                    aria-live="polite"
                    className="tnum flex-1 text-center text-[15px] font-semibold text-ink"
                  >
                    {sizeLabel(blocks)}
                  </output>
                  <button
                    type="button"
                    aria-label={`${BLOCK_GB} GB more`}
                    disabled={blocks >= MAX_BLOCKS}
                    onClick={() => setBlocks((value) => Math.min(MAX_BLOCKS, value + 1))}
                    className="flex size-9 items-center justify-center rounded-xl border border-line text-[16px] font-semibold text-ink transition hover:bg-surface-sunken disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
              </fieldset>
              <div id={`${id}-total`} className="flex items-baseline justify-between rounded-xl bg-surface-sunken px-3.5 py-3">
                <span className="text-[13px] text-ink-muted">{billing === "year" ? "Per year" : "Per month"}, VAT included</span>
                <span className="tnum text-[18px] font-semibold text-ink">
                  {formatEur((billing === "year" && plan.yearlyPriceCents ? plan.yearlyPriceCents : plan.priceCents) * blocks)}
                </span>
              </div>
              <p className="text-[12px] leading-relaxed text-ink-faint">
                Payment is handled by Stripe. Uploads stop when the plan is full; downloads are included.
                {plan.termsUrl ? (
                  <>
                    {" "}
                    By continuing you agree to the{" "}
                    <a href={plan.termsUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-accent-strong hover:underline">
                      storage terms
                    </a>
                    .
                  </>
                ) : null}
              </p>
            </>
          ) : null}

          {timedOut ? (
            <p role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-[13px] text-ink">
              The payment hasn&rsquo;t been confirmed yet. It usually takes seconds; “Cloud storage” will appear in the sidebar as
              soon as it is. You can close this.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
          <button type="button" onClick={close} className={BUTTON_SECONDARY}>
            {hasPlan || waiting ? "Close" : "Not now"}
          </button>
          {hasPlan && !waiting ? (
            <button type="button" onClick={() => void manage()} disabled={busy} className={`${BUTTON_PRIMARY} flex items-center gap-1.5`}>
              {busy ? "Opening…" : "Manage plan"}
              <ExternalIcon size={14} />
            </button>
          ) : !hasPlan && !waiting && plan?.available ? (
            <button type="button" onClick={() => void buy()} disabled={busy} className={BUTTON_PRIMARY}>
              {busy ? "Opening payment…" : `Continue to payment`}
            </button>
          ) : null}
        </footer>
      </div>
    </dialog>
  );
}

function PlanSummary({ plan }: { plan: PlanView }) {
  const ratio = plan.quotaBytes ? Math.min(1, plan.usedBytes / plan.quotaBytes) : 0;
  const percent = Math.round(ratio * 100);
  const fill = plan.status !== "active" || ratio >= 1 ? "bg-danger" : ratio >= 0.85 ? "bg-warning" : "bg-accent";
  return (
    <div className="space-y-3">
      {plan.status === "suspended" ? (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
          The storage service suspended this plan, so its files can&rsquo;t be opened, added or shared. Contact them to find out why.
        </p>
      ) : plan.status === "past_due" ? (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
          The last payment didn&rsquo;t go through, so uploads are paused. Your files are safe. Update the card under “Manage plan”.
        </p>
      ) : plan.status === "canceled" ? (
        <p role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-[13px] text-ink">
          This plan was cancelled and is read-only.
          {plan.deleteAt ? ` Its files will be deleted on ${new Date(plan.deleteAt).toLocaleDateString()}.` : ""} Resubscribe under
          “Manage plan” to keep them.
        </p>
      ) : null}
      <div className="rounded-xl bg-surface-sunken px-3.5 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] text-ink-muted">{sizeLabel(plan.blocks)} plan</span>
          <span className="tnum text-[13px] font-semibold text-ink">
            {plan.billing === "year" && plan.yearlyPriceCents
              ? `${formatEur(plan.yearlyPriceCents * plan.blocks)} / year`
              : `${formatEur(plan.priceCents * plan.blocks)} / month`}
          </span>
        </div>
        <div
          className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-line"
          role="meter"
          aria-label="Plan used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className={`h-full rounded-full ${fill}`} style={{ width: `${percent}%` }} />
        </div>
        <p className="tnum mt-1.5 text-[12px] text-ink-faint">
          {formatBytes(plan.usedBytes)} used of {formatBytes(plan.quotaBytes)} · {percent}%
        </p>
      </div>
      <p className="text-[12px] leading-relaxed text-ink-faint">
        Change the size, update the card, see invoices or cancel on the billing page. Usage is measured every few minutes.
      </p>
    </div>
  );
}
