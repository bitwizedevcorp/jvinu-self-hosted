"use client";

import { useState } from "react";
import { CheckIcon } from "./icons";

/** The same rule the server applies (first-run.ts). */
export const MIN_PASSWORD = 12;

export const FIELD =
  "w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[14px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent focus:ring-[3px] focus:ring-accent-ring aria-invalid:border-danger";

export type FieldError<Field extends string = string> = { field?: Field; message: string } | null;

/** A requirement that ticks itself off as it's met. */
function Check({ met, children }: { met: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 transition ${met ? "text-success-ink" : "text-ink-faint"}`}>
      <CheckIcon size={12} className={met ? "" : "opacity-40"} />
      {children}
    </span>
  );
}

/** Whether a new password and its confirmation are ready to send. */
export const newPasswordReady = (password: string, confirm: string) => ({
  long: password.length >= MIN_PASSWORD,
  same: confirm.length > 0 && confirm === password,
});

/**
 * A new password and its confirmation: one show/hide toggle for both, and checks that tick
 * off as they're met. Errors for "password" or "confirm" show under their field.
 */
export function NewPasswordFields({
  id,
  password,
  confirm,
  onPassword,
  onConfirm,
  error,
  label = "Password",
}: {
  id: string;
  password: string;
  confirm: string;
  onPassword: (value: string) => void;
  onConfirm: (value: string) => void;
  error: FieldError;
  label?: string;
}) {
  const [visible, setVisible] = useState(false);
  const { long, same } = newPasswordReady(password, confirm);
  const described = (field: "password" | "confirm") => ({
    "aria-invalid": error?.field === field,
    "aria-describedby": `${id}-${field}-${error?.field === field ? "error" : "hint"}`,
  });
  const message = (field: "password" | "confirm") =>
    error?.field === field ? (
      <p id={`${id}-${field}-error`} role="alert" className="mt-1.5 text-[12.5px] font-medium text-danger">
        {error.message}
      </p>
    ) : null;

  return (
    <>
      <div>
        <label htmlFor={`${id}-password`} className="block text-[12.5px] font-medium text-ink">
          {label}
        </label>
        <div className="relative mt-1.5">
          <input
            id={`${id}-password`}
            type={visible ? "text" : "password"}
            value={password}
            onChange={(event) => onPassword(event.target.value)}
            autoComplete="new-password"
            {...described("password")}
            className={`${FIELD} pr-16`}
          />
          <button
            type="button"
            onClick={() => setVisible((value) => !value)}
            aria-pressed={visible}
            aria-controls={`${id}-password ${id}-confirm`}
            className="absolute inset-y-1 right-1 rounded-lg px-2.5 text-[12px] font-medium text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
          >
            {visible ? "Hide" : "Show"}
          </button>
        </div>
        {message("password") ?? (
          <p id={`${id}-password-hint`} className="mt-1.5 text-[12px]">
            <Check met={long}>At least {MIN_PASSWORD} characters</Check>
          </p>
        )}
      </div>

      <div>
        <label htmlFor={`${id}-confirm`} className="block text-[12.5px] font-medium text-ink">
          Confirm {label.toLowerCase()}
        </label>
        <input
          id={`${id}-confirm`}
          type={visible ? "text" : "password"}
          value={confirm}
          onChange={(event) => onConfirm(event.target.value)}
          autoComplete="new-password"
          {...described("confirm")}
          className={`${FIELD} mt-1.5`}
        />
        {message("confirm") ?? (
          <p id={`${id}-confirm-hint`} className="mt-1.5 text-[12px]">
            <Check met={same}>Passwords match</Check>
          </p>
        )}
      </div>
    </>
  );
}
