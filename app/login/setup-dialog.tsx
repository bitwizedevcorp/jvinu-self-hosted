"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { CheckIcon, KeyIcon } from "../components/icons";
import { FIELD, MIN_PASSWORD, NewPasswordFields, newPasswordReady, type FieldError } from "../components/new-password-fields";

type Field = "code" | "name" | "password" | "confirm";

/**
 * The first sign-in on a server with no password: choose one, with the setup code from the
 * server's log (filled in when the page was opened from the log's link). It can't be put
 * away by accident; if it is closed, the card behind it opens it again.
 */
export function SetupDialog({ code: linkCode, codeValid }: { code: string; codeValid: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const router = useRouter();
  const [code, setCode] = useState(linkCode);
  const [codeFromLink, setCodeFromLink] = useState(codeValid);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FieldError<Field>>(
    linkCode && !codeValid
      ? { field: "code", message: "The code in that link has expired: the server prints a new one each time it starts. Enter the latest from its log." }
      : null,
  );

  useEffect(() => {
    ref.current?.showModal();
    // The code has done its job in the address bar; keep it out of history and screenshots.
    if (new URLSearchParams(window.location.search).has("setup")) window.history.replaceState(null, "", "/login");
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const { long, same } = newPasswordReady(password, confirm);
    if (!code.trim()) return setError({ field: "code", message: "Enter the setup code from the server's log." });
    if (!long) return setError({ field: "password", message: `Use at least ${MIN_PASSWORD} characters. A few unrelated words work well.` });
    if (!same) return setError({ field: "confirm", message: "The two passwords don't match." });
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, password, name: name.trim() }),
      });
      if (response.ok) {
        router.replace("/dashboard");
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: string; field?: Field };
      if (body.field === "code") setCodeFromLink(false);
      setError({ field: body.field, message: body.error ?? "Couldn't set the password." });
    } catch {
      setError({ message: "Couldn't reach the server." });
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (field: Field) =>
    error?.field === field ? (
      <p id={`${id}-${field}-error`} role="alert" className="mt-1.5 text-[12.5px] font-medium text-danger">
        {error.message}
      </p>
    ) : null;
  const described = (field: Field) => ({
    "aria-invalid": error?.field === field,
    "aria-describedby": `${id}-${field}-${error?.field === field ? "error" : "hint"}`,
  });

  return (
    <>
      <div className="mt-6 space-y-3 text-center">
        <p className="text-[13.5px] leading-relaxed text-ink-muted">This server is new. Choose the password you&rsquo;ll sign in with.</p>
        <button
          type="button"
          onClick={() => ref.current?.showModal()}
          className="spring w-full rounded-xl bg-accent-fill px-4 py-2.5 text-[14px] font-semibold text-white shadow-card transition hover:bg-accent-hover active:scale-[0.98]"
        >
          Set your password
        </button>
      </div>

      <dialog
        ref={ref}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-intro`}
        style={{ width: "min(440px, calc(100vw - 2rem))" }}
        className="m-auto max-h-[calc(100dvh-2rem)] rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
      >
        <form onSubmit={submit} noValidate className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <header className="flex items-start gap-3 border-b border-line px-5 py-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
              <KeyIcon size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={`${id}-title`} className="text-[16px] font-semibold text-ink">
                Set your password
              </h2>
              <p id={`${id}-intro`} className="text-[12.5px] text-ink-muted">
                The first sign-in on this server chooses it
              </p>
            </div>
          </header>

          <div className="scroll-quiet min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {codeFromLink ? (
              <div className="flex items-center gap-2.5 rounded-xl bg-success-soft px-3.5 py-2.5 text-[13px] text-ink">
                <CheckIcon size={15} className="shrink-0 text-success-ink" />
                <span className="min-w-0 flex-1">Setup code from the server&rsquo;s link</span>
                <button
                  type="button"
                  onClick={() => setCodeFromLink(false)}
                  className="shrink-0 text-[12.5px] font-medium text-accent-strong hover:underline"
                >
                  Change
                </button>
              </div>
            ) : (
              <div>
                <label htmlFor={`${id}-code`} className="block text-[12.5px] font-medium text-ink">
                  Setup code
                </label>
                <input
                  id={`${id}-code`}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoFocus
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="XXXX-XXXX-XXXX"
                  {...described("code")}
                  className={`${FIELD} mt-1.5 font-mono tracking-[0.08em] uppercase`}
                />
                {fieldError("code") ?? (
                  <p id={`${id}-code-hint`} className="mt-1.5 text-[12px] leading-relaxed text-ink-faint">
                    The server printed it in its log when it started, with a link that fills it in. With Docker:{" "}
                    <code className="font-mono text-ink-muted">docker compose logs jvinu</code>
                  </p>
                )}
              </div>
            )}

            <div>
              <label htmlFor={`${id}-name`} className="block text-[12.5px] font-medium text-ink">
                Your name <span className="font-normal text-ink-faint">Optional</span>
              </label>
              <input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus={codeFromLink}
                autoComplete="name"
                maxLength={60}
                placeholder="Admin"
                {...described("name")}
                className={`${FIELD} mt-1.5`}
              />
              {fieldError("name") ?? (
                <p id={`${id}-name-hint`} className="mt-1.5 text-[12px] text-ink-faint">
                  Shown in each bucket&rsquo;s history next to what you change.
                </p>
              )}
            </div>

            <NewPasswordFields id={id} password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} error={error} />

            {error && !error.field ? (
              <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
                {error.message}
              </p>
            ) : null}
          </div>

          <footer className="space-y-2.5 border-t border-line px-5 py-4">
            <button
              type="submit"
              disabled={busy}
              className="spring w-full rounded-xl bg-accent-fill px-4 py-2.5 text-[14px] font-semibold text-white shadow-card transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? "Setting it…" : "Set password and continue"}
            </button>
            <p className="text-center text-[11.5px] leading-relaxed text-ink-faint">
              Only a hash of it is kept. You can change it later from the account menu.
            </p>
          </footer>
        </form>
      </dialog>
    </>
  );
}
