"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LoginForm({
  password,
  twoStep = false,
  sso,
  demo = false,
}: {
  password: boolean;
  /** Two-step sign-in is on: the form also asks for the code from the authenticator app. */
  twoStep?: boolean;
  sso: boolean;
  demo?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!value || (twoStep && !code) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(twoStep ? { password: value, code } : { password: value }),
      });
      if (response.ok) {
        router.replace("/dashboard");
        router.refresh();
        return;
      }
      setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't sign in.");
      setValue("");
      setCode("");
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function enterDemo() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/demo", { method: "POST" });
      if (response.ok) {
        router.replace("/dashboard");
        router.refresh();
        return;
      }
      setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't open the demo.");
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 space-y-4">
      {demo ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => void enterDemo()}
            disabled={busy}
            className="spring flex w-full items-center justify-center rounded-xl bg-accent-fill px-4 py-2.5 text-[14px] font-semibold text-white shadow-card transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-60"
          >
            Explore the demo
          </button>
          <p className="text-center text-[12px] text-ink-faint">Read-only sample buckets with Delta and Iceberg tables. No sign-up.</p>
          {error && !password ? (
            <p role="alert" className="text-center text-[12.5px] font-medium text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {sso ? (
        <a
          href="/api/auth/oidc/start"
          className="spring flex w-full items-center justify-center rounded-xl bg-accent-fill px-4 py-2.5 text-[14px] font-semibold text-white shadow-card transition hover:bg-accent-hover active:scale-[0.98]"
        >
          Continue with single sign-on
        </a>
      ) : null}

      {sso && password ? (
        <div className="flex items-center gap-3 text-[12px] text-ink-faint" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>
      ) : null}

      {password ? (
        <form onSubmit={submit} className="space-y-3">
          <label htmlFor="password" className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Admin password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "password-error" : undefined}
            className="h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-[14.5px] text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
          />
          {twoStep ? (
            <>
              <label htmlFor="code" className="block pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Code from your authenticator app
              </label>
              <input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456, or a recovery code"
                maxLength={20}
                value={code}
                onChange={(event) => setCode(event.target.value.trim())}
                className="h-11 w-full rounded-xl border border-line bg-surface px-3.5 font-mono text-[14.5px] tracking-[0.12em] text-ink outline-none transition placeholder:font-sans placeholder:tracking-normal placeholder:text-ink-faint focus:border-accent focus:ring-[3px] focus:ring-accent-ring"
              />
            </>
          ) : null}
          {error ? (
            <p id="password-error" role="alert" className="text-[12.5px] font-medium text-danger">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy || !value || (twoStep && !code)}
            className={`spring w-full rounded-xl px-4 py-2.5 text-[14px] font-semibold transition active:scale-[0.98] disabled:opacity-60 ${
              sso ? "border border-line-strong bg-surface text-ink hover:bg-surface-sunken" : "bg-accent-fill text-white hover:bg-accent-hover"
            }`}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <details className="group text-center text-[12px] text-ink-faint">
            <summary className="cursor-pointer list-none rounded-md py-1 transition hover:text-ink-muted">Forgot your password?</summary>
            <p className="mt-1.5 rounded-xl bg-surface-sunken px-3.5 py-2.5 text-left leading-relaxed text-ink-muted">
              Whoever runs this server can set <code className="font-mono text-ink">JVINU_ADMIN_PASSWORD</code> in its
              environment and restart jvinu. That password always works, and you can choose a new one after signing in.
            </p>
          </details>
        </form>
      ) : null}
    </div>
  );
}
