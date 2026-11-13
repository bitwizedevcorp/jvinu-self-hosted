"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ApiError, api } from "../lib/remote";
import { CheckIcon, CloseIcon, KeyIcon } from "./icons";
import { FIELD, MIN_PASSWORD, NewPasswordFields, newPasswordReady, type FieldError } from "./new-password-fields";

type Field = "current" | "password" | "confirm";

/**
 * Changes the admin password from the account menu. It's only kept here when it was chosen
 * in the browser; one from JVINU_ADMIN_PASSWORD is changed in the environment, and the
 * dialog says how.
 */
export function ChangePasswordDialog({ source, onClose }: { source: "app" | "env"; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FieldError<Field>>(null);
  const [done, setDone] = useState<{ signedOut: number } | null>(null);

  useEffect(() => {
    ref.current?.showModal();
    // Opened from script, the dialog would focus its close button first.
    currentRef.current?.focus();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const { long, same } = newPasswordReady(password, confirm);
    if (!current) return setError({ field: "current", message: "Enter the password you sign in with now." });
    if (!long) return setError({ field: "password", message: `Use at least ${MIN_PASSWORD} characters. A few unrelated words work well.` });
    if (!same) return setError({ field: "confirm", message: "The two passwords don't match." });
    setBusy(true);
    setError(null);
    try {
      const { signedOut } = await api.changePassword(current, password);
      setDone({ signedOut });
    } catch (failure) {
      const field = failure instanceof ApiError ? (failure.body.field as Field | undefined) : undefined;
      setError({ field, message: failure instanceof Error ? failure.message : "Couldn't change the password." });
      if (field === "current") currentRef.current?.select();
    } finally {
      setBusy(false);
    }
  }

  const close = () => ref.current?.close();
  const closeButton = (
    <button
      type="button"
      onClick={close}
      aria-label="Close"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
    >
      <CloseIcon size={16} />
    </button>
  );

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) close();
      }}
      aria-labelledby={`${id}-title`}
      style={{ width: "min(440px, calc(100vw - 2rem))" }}
      className="m-auto max-h-[calc(100dvh-2rem)] rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
            <KeyIcon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="text-[16px] font-semibold text-ink">
              Change password
            </h2>
            <p className="text-[12.5px] text-ink-muted">The admin password for this server</p>
          </div>
          {closeButton}
        </header>

        {source === "env" ? (
          <div className="space-y-3 px-5 py-5 text-[13.5px] leading-relaxed text-ink-muted">
            <p>
              This server&rsquo;s password is set by <code className="font-mono text-ink">JVINU_ADMIN_PASSWORD</code> in its
              environment, so it&rsquo;s changed there: put the new one (12+ characters) in <code className="font-mono text-ink">.env</code>{" "}
              (<code className="font-mono text-ink">.env.local</code> in development), then restart jvinu.
            </p>
            <p>
              To change it from this menu instead, remove <code className="font-mono text-ink">JVINU_ADMIN_PASSWORD</code> and
              restart jvinu. If no password was chosen here before, the next sign-in asks you to choose one.
            </p>
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={close}
                className="rounded-xl border border-line-strong bg-surface px-4 py-2 text-[13.5px] font-semibold text-ink transition hover:bg-surface-sunken"
              >
                Close
              </button>
            </div>
          </div>
        ) : done ? (
          <div className="px-5 py-8 text-center" role="status">
            <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-success-soft text-success-ink">
              <CheckIcon size={20} />
            </span>
            <p className="mt-3 text-[15px] font-semibold text-ink">Password changed</p>
            <p className="mx-auto mt-1 max-w-[320px] text-[13px] text-ink-muted">
              You&rsquo;re still signed in here.{" "}
              {done.signedOut
                ? `${done.signedOut === 1 ? "One other browser was" : `${done.signedOut} other browsers were`} signed out.`
                : "No other browser was signed in."}
            </p>
            <button
              type="button"
              onClick={close}
              autoFocus
              className="mt-5 rounded-xl border border-line-strong px-4 py-2 text-[13.5px] font-semibold text-ink transition hover:bg-surface-sunken"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
            <div className="scroll-quiet min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div>
                <label htmlFor={`${id}-current`} className="block text-[12.5px] font-medium text-ink">
                  Current password
                </label>
                <input
                  ref={currentRef}
                  id={`${id}-current`}
                  type="password"
                  value={current}
                  onChange={(event) => setCurrent(event.target.value)}
                  autoComplete="current-password"
                  aria-invalid={error?.field === "current"}
                  aria-describedby={error?.field === "current" ? `${id}-current-error` : undefined}
                  className={`${FIELD} mt-1.5`}
                />
                {error?.field === "current" ? (
                  <p id={`${id}-current-error`} role="alert" className="mt-1.5 text-[12.5px] font-medium text-danger">
                    {error.message}
                  </p>
                ) : null}
              </div>

              <NewPasswordFields
                id={id}
                label="New password"
                password={password}
                confirm={confirm}
                onPassword={setPassword}
                onConfirm={setConfirm}
                error={error}
              />

              <p className="rounded-xl bg-surface-sunken px-3.5 py-3 text-[12px] leading-relaxed text-ink-muted">
                Other browsers signed in with this password are signed out when it changes. You stay signed in here.
              </p>

              {error && !error.field ? (
                <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
                  {error.message}
                </p>
              ) : null}
            </div>
            <footer className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
              <button
                type="button"
                onClick={close}
                className="rounded-xl border border-line-strong bg-surface px-4 py-2 text-[13.5px] font-semibold text-ink transition hover:bg-surface-sunken"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="spring rounded-xl bg-accent-fill px-4 py-2 text-[13.5px] font-semibold text-white transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-60"
              >
                {busy ? "Changing…" : "Change password"}
              </button>
            </footer>
          </form>
        )}
      </div>
    </dialog>
  );
}
