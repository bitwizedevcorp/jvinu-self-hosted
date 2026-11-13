"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/remote";
import { CheckIcon, CloseIcon, CloudIcon } from "./icons";

const JOINED_KEY = "jvinu-waitlist-joined";

/** Remembered in this browser only, so the menu can say you're already on the list. */
export function readJoined(): boolean {
  try {
    return localStorage.getItem(JOINED_KEY) === "1";
  } catch {
    return false;
  }
}

const SIZES: [string, string][] = [
  ["", "Prefer not to say"],
  ["under-100gb", "Under 100 GB"],
  ["100gb-1tb", "100 GB – 1 TB"],
  ["1-10tb", "1 – 10 TB"],
  ["over-10tb", "Over 10 TB"],
  ["not-sure", "Not sure"],
];

const INPUT =
  "w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[14px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent focus:ring-[3px] focus:ring-accent-ring";

/**
 * An opt-in form, opened only from the account menu. Nothing is sent until it's submitted,
 * and then only what's listed under "What's sent".
 */
export function WaitlistDialog({ email, onClose, onJoined }: { email?: string; onClose: () => void; onJoined: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [address, setAddress] = useState(email ?? "");
  const [size, setSize] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.joinWaitlist({ email: address.trim(), size: size || undefined, note: note.trim() || undefined });
      try {
        localStorage.setItem(JOINED_KEY, "1");
      } catch {
        // Storage blocked: only the menu's "on the list" note is lost.
      }
      setDone(true);
      onJoined();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't join the waitlist.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
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
              Cloud backup
            </h2>
            <p className="text-[12.5px] text-ink-muted">An idea we&rsquo;re weighing — not built yet</p>
          </div>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="Close"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
          >
            <CloseIcon size={16} />
          </button>
        </header>

        {done ? (
          <div className="px-5 py-8 text-center" role="status">
            <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-success-soft text-success-ink">
              <CheckIcon size={20} />
            </span>
            <p className="mt-3 text-[15px] font-semibold text-ink">You&rsquo;re on the list</p>
            <p className="mx-auto mt-1 max-w-[320px] text-[13px] text-ink-muted">
              Thanks — that tells us whether to build it. jvinu stays free and self-hosted either way.
            </p>
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className="mt-5 rounded-xl border border-line-strong px-4 py-2 text-[13.5px] font-semibold text-ink transition hover:bg-surface-sunken"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <div className="scroll-quiet min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <p className="text-[13.5px] leading-relaxed text-ink-muted">
                We might offer an optional, paid service that keeps an encrypted, off-site copy of your storage. Before
                building it, we&rsquo;d like to know if anyone wants it. jvinu itself stays free and self-hosted, with or
                without it.
              </p>

              <div>
                <label htmlFor={`${id}-email`} className="block text-[12.5px] font-medium text-ink">
                  Email
                </label>
                <input
                  id={`${id}-email`}
                  type="email"
                  required
                  autoComplete="email"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="you@example.com"
                  className={`${INPUT} mt-1.5`}
                />
              </div>

              <div>
                <label htmlFor={`${id}-size`} className="block text-[12.5px] font-medium text-ink">
                  Roughly how much would you back up? <span className="font-normal text-ink-faint">Optional</span>
                </label>
                <select id={`${id}-size`} value={size} onChange={(event) => setSize(event.target.value)} className={`${INPUT} mt-1.5`}>
                  {SIZES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor={`${id}-note`} className="block text-[12.5px] font-medium text-ink">
                  Anything it must do? <span className="font-normal text-ink-faint">Optional</span>
                </label>
                <textarea
                  id={`${id}-note`}
                  rows={2}
                  maxLength={500}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="e.g. EU data residency, versioning, a price you'd pay"
                  className={`${INPUT} mt-1.5 resize-y`}
                />
              </div>

              <p className="rounded-xl bg-surface-sunken px-3.5 py-3 text-[12px] leading-relaxed text-ink-muted">
                <span className="font-semibold text-ink">What&rsquo;s sent:</span> your email, the two answers above, and this
                jvinu&rsquo;s version number — nothing about your files, buckets or connections. It&rsquo;s used only to tell
                you if this launches.
              </p>

              {error ? (
                <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
                  {error}
                </p>
              ) : null}
            </div>
            <footer className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
              <button
                type="button"
                onClick={() => ref.current?.close()}
                className="rounded-xl border border-line-strong bg-surface px-4 py-2 text-[13.5px] font-semibold text-ink transition hover:bg-surface-sunken"
              >
                Not now
              </button>
              <button
                type="submit"
                disabled={busy}
                className="spring rounded-xl bg-accent-fill px-4 py-2 text-[13.5px] font-semibold text-white transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-60"
              >
                {busy ? "Sending…" : "Join the waitlist"}
              </button>
            </footer>
          </form>
        )}
      </div>
    </dialog>
  );
}
