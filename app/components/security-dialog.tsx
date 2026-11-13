"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, type DeviceSession } from "../lib/remote";
import { CheckIcon, CloseIcon, LockIcon } from "./icons";

const INPUT =
  "w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 font-mono text-[14px] tracking-[0.12em] text-ink outline-none transition placeholder:font-sans placeholder:tracking-normal placeholder:text-ink-faint focus:border-accent focus:ring-[3px] focus:ring-accent-ring";
const PRIMARY =
  "spring rounded-xl bg-accent-fill px-3.5 py-2 text-[13px] font-semibold text-white transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-60";
const SECONDARY =
  "rounded-xl border border-line-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink transition hover:bg-surface-sunken disabled:opacity-60";

/**
 * Sign-in & security: two-step sign-in for the admin password (an authenticator app plus
 * recovery codes), and every device this person is signed in on, each with a sign-out.
 */
export function SecurityDialog({ adminPassword, onClose }: { adminPassword: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
      aria-labelledby={`${id}-title`}
      style={{ width: "min(480px, calc(100vw - 2rem))" }}
      className="m-auto max-h-[calc(100dvh-2rem)] rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
            <LockIcon size={18} />
          </span>
          <h2 id={`${id}-title`} className="flex-1 text-[16px] font-semibold text-ink">
            Sign-in &amp; security
          </h2>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="Close"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
          >
            <CloseIcon size={16} />
          </button>
        </header>
        <div className="scroll-quiet min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {adminPassword ? <TwoStep /> : null}
          <Devices />
        </div>
      </div>
    </dialog>
  );
}

type TwoStepState =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "setup"; secret: string; qr: string }
  | { kind: "codes"; codes: string[] }
  | { kind: "on"; left: number | null };

function TwoStep() {
  const [state, setState] = useState<TwoStepState>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(
    () =>
      api
        .twoFactor()
        .then((status) => setState(status.enabled ? { kind: "on", left: status.recoveryCodesLeft } : { kind: "off" }))
        .catch((failure: Error) => setError(failure.message)),
    [],
  );

  useEffect(() => {
    let stopped = false;
    api
      .twoFactor()
      .then((status) => {
        if (!stopped) setState(status.enabled ? { kind: "on", left: status.recoveryCodesLeft } : { kind: "off" });
      })
      .catch((failure: Error) => !stopped && setError(failure.message));
    return () => {
      stopped = true;
    };
  }, []);

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const start = () =>
    run(async () => {
      const { secret, uri } = await api.startTwoFactor();
      const qr = await QRCode.toDataURL(uri, { margin: 1, width: 200, errorCorrectionLevel: "M" });
      setCode("");
      setState({ kind: "setup", secret, qr });
    });
  const confirm = () =>
    run(async () => {
      const { recoveryCodes } = await api.confirmTwoFactor(code);
      setCode("");
      setState({ kind: "codes", codes: recoveryCodes });
    });
  const disable = () =>
    run(async () => {
      await api.disableTwoFactor(code);
      setCode("");
      setState({ kind: "off" });
    });

  const codeInput = (onEnter: () => void, placeholder: string) => (
    <input
      inputMode="numeric"
      autoComplete="one-time-code"
      aria-label="Code"
      placeholder={placeholder}
      maxLength={20}
      value={code}
      onChange={(event) => setCode(event.target.value.trim())}
      onKeyDown={(event) => {
        if (event.key === "Enter" && code) onEnter();
      }}
      className={INPUT}
    />
  );

  return (
    <section aria-labelledby="two-step-title">
      <div className="flex items-center gap-2">
        <h3 id="two-step-title" className="flex-1 text-[14px] font-semibold text-ink">
          Two-step sign-in
        </h3>
        {state.kind === "on" ? (
          <span className="flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-semibold text-success-ink">
            <CheckIcon size={11} /> On
          </span>
        ) : state.kind === "off" ? (
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-semibold text-ink-muted">Off</span>
        ) : null}
      </div>

      {state.kind === "off" ? (
        <div className="mt-2 space-y-3">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            Ask for a code from an authenticator app (Google Authenticator, 1Password, Authy…) as well as the admin password. Someone
            who learns the password still can&rsquo;t sign in.
          </p>
          <button type="button" onClick={() => void start()} disabled={busy} className={PRIMARY}>
            {busy ? "Starting…" : "Turn on"}
          </button>
        </div>
      ) : state.kind === "setup" ? (
        <div className="mt-2 space-y-3">
          <p className="text-[13px] leading-relaxed text-ink-muted">Scan this with your authenticator app, then type the code it shows.</p>
          <div className="flex items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- a QR code drawn here, as a data URL */}
            <img src={state.qr} alt="QR code for your authenticator app" width={140} height={140} className="rounded-lg bg-white p-1" />
            <div className="min-w-0 text-[12px] text-ink-muted">
              <p>Can&rsquo;t scan? Enter this key by hand:</p>
              <p className="mt-1 break-all font-mono text-[12.5px] text-ink select-all">{state.secret.match(/.{1,4}/g)?.join(" ")}</p>
            </div>
          </div>
          {codeInput(() => void confirm(), "6-digit code")}
          <div className="flex gap-2">
            <button type="button" onClick={() => void confirm()} disabled={busy || code.length < 6} className={PRIMARY}>
              {busy ? "Checking…" : "Confirm and turn on"}
            </button>
            <button type="button" onClick={() => setState({ kind: "off" })} disabled={busy} className={SECONDARY}>
              Cancel
            </button>
          </div>
        </div>
      ) : state.kind === "codes" ? (
        <div className="mt-2 space-y-3" role="status">
          <p className="text-[13px] leading-relaxed text-ink">
            <span className="font-semibold">It&rsquo;s on.</span> Save these recovery codes somewhere safe, away from your phone. Each
            one signs you in once if the phone is lost. They won&rsquo;t be shown again.
          </p>
          <ol className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-surface-sunken px-4 py-3 font-mono text-[13px] text-ink">
            {state.codes.map((recovery) => (
              <li key={recovery}>{recovery}</li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={SECONDARY}
              onClick={() => {
                void navigator.clipboard.writeText(state.codes.join("\n")).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <a
              className={SECONDARY}
              download="jvinu-recovery-codes.txt"
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(`jvinu recovery codes — each works once\n\n${state.codes.join("\n")}\n`)}`}
            >
              Download
            </a>
            <button type="button" className={PRIMARY} onClick={() => void refresh()}>
              I&rsquo;ve saved them
            </button>
          </div>
        </div>
      ) : state.kind === "on" ? (
        <div className="mt-2 space-y-3">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            Signing in with the admin password also asks for a code.
            {state.left !== null ? ` ${state.left} recovery code${state.left === 1 ? "" : "s"} left.` : ""} To turn it off, enter a
            current code or a recovery code.
          </p>
          {codeInput(() => void disable(), "Code or recovery code")}
          <button type="button" onClick={() => void disable()} disabled={busy || !code} className={SECONDARY}>
            {busy ? "Turning off…" : "Turn off"}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-[13px] text-ink-faint">Loading…</p>
      )}

      {error ? (
        <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Devices() {
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .sessions()
      .then((result) => setSessions(result.sessions))
      .catch((failure: Error) => setError(failure.message));
  }, []);
  useEffect(load, [load]);

  async function signOut(target: string) {
    setBusy(target);
    setError(null);
    try {
      await api.endSession(target);
      load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't sign that device out.");
    } finally {
      setBusy(null);
    }
  }

  const others = sessions?.filter((session) => !session.current).length ?? 0;
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <section aria-labelledby="devices-title">
      <div className="flex items-center gap-2">
        <h3 id="devices-title" className="flex-1 text-[14px] font-semibold text-ink">
          Signed-in devices
        </h3>
        {others > 0 ? (
          <button
            type="button"
            onClick={() => void signOut("others")}
            disabled={busy !== null}
            className="rounded-lg px-2 py-1 text-[12px] font-semibold text-danger transition hover:bg-danger/10 disabled:opacity-60"
          >
            Sign out all others
          </button>
        ) : null}
      </div>
      {sessions === null && !error ? <p className="mt-2 text-[13px] text-ink-faint">Loading…</p> : null}
      <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
        {(sessions ?? []).map((session) => (
          <li key={session.id} className="flex items-center gap-3 px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-ink">
                {session.device}
                {session.current ? <span className="ml-1.5 text-[11.5px] font-semibold text-success-ink">This device</span> : null}
              </p>
              <p className="text-[11.5px] text-ink-faint">Signed in {when(session.createdAt)}</p>
            </div>
            {session.current ? null : (
              <button
                type="button"
                onClick={() => void signOut(session.id)}
                disabled={busy !== null}
                className="shrink-0 rounded-lg px-2 py-1 text-[12px] font-semibold text-danger transition hover:bg-danger/10 disabled:opacity-60"
              >
                {busy === session.id ? "Signing out…" : "Sign out"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-ink">
          {error}
        </p>
      ) : null}
    </section>
  );
}
