"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChangePasswordDialog } from "./change-password-dialog";
import { ProfileDialog } from "./profile-dialog";
import { SecurityDialog } from "./security-dialog";
import {
  CheckIcon,
  CloudIcon,
  KeyIcon,
  LockIcon,
  UserIcon,
  MoreIcon,
  SignOutIcon,
} from "./icons";
import { StoragePlanDialog, type PlanReturn } from "./storage-plan-dialog";
import { AppearanceControl } from "./theme";
import { readJoined, WaitlistDialog } from "./waitlist-dialog";

export type SignedInUser = {
  name: string;
  email?: string;
  provider: "password" | "oidc";
  /** The server offers the cloud-backup waitlist (JVINU_WAITLIST_URL is set). */
  waitlist?: boolean;
  /** The server can buy storage (JVINU_STORAGE_STORE_URL is set). */
  storagePlan?: boolean;
  /** Admins manage connections and the storage plan; members use what's connected. */
  role: "admin" | "member";
  /** Version tag of the person's photo, when they've uploaded one. */
  avatar?: string;
  /** Signed in with the admin password: kept by jvinu ("app"), or set by JVINU_ADMIN_PASSWORD ("env"). */
  password?: "app" | "env";
};

const noSubscribe = () => () => {};

const RETURNS: PlanReturn[] = ["paid", "canceled", "managed"];

/** Back from Stripe: the dashboard address carries ?storage=paid|canceled|managed once. */
function readPlanReturn(): PlanReturn {
  const value = new URLSearchParams(window.location.search).get("storage") as PlanReturn;
  return RETURNS.includes(value) ? value : null;
}

function initialsOf(name: string): string {
  const letters = name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("");
  return (letters || "?").toUpperCase();
}

/** Where the signed-in person's photo is served; the version makes each upload a new URL. */
export const avatarUrl = (version: string) => `/api/me/avatar?v=${encodeURIComponent(version)}`;

export function Avatar({ name, size = 32, src }: { name: string; size?: number; src?: string | null }) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a small private image behind sign-in, not for next/image
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        backgroundImage: "linear-gradient(160deg, #8e8e93, #48484a)",
      }}
    >
      {initialsOf(name)}
    </span>
  );
}

export function AccountMenu({
  user,
  onSignOut,
}: {
  user: SignedInUser;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const photo = user.avatar ? avatarUrl(user.avatar) : null;
  // Opened from the menu (null), or straight away when coming back from a payment page.
  const [plan, setPlan] = useState<{ returning: PlanReturn } | null>(null);
  // Read from this browser after hydration; the server never knows.
  const storedJoined = useSyncExternalStore(
    noSubscribe,
    readJoined,
    () => false,
  );
  const [joinedNow, setJoinedNow] = useState(false);
  const joined = storedJoined || joinedNow;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const detail =
    user.email ??
    (user.provider === "password"
      ? "Signed in with the admin password"
      : "Signed in with SSO");

  useEffect(() => {
    if (!user.storagePlan || user.role !== "admin") return;
    const returning = readPlanReturn();
    if (!returning) return;
    // Drop the marker so a reload doesn't reopen the dialog.
    const url = new URL(window.location.href);
    url.searchParams.delete("storage");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to the address once, after hydration
    setPlan({ returning });
  }, [user.storagePlan, user.role]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div
      ref={wrapperRef}
      className="relative mt-2"
      // Keep Esc from also clearing the file selection behind the menu.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-surface/70"
      >
        <Avatar name={user.name} src={photo} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-ink">
            {user.name}
          </span>
          <span className="block truncate text-[11.5px] text-ink-faint">
            {detail}
          </span>
        </span>
        <MoreIcon size={16} className="shrink-0 text-ink-faint" />
      </button>

      {open ? (
        <div className="material-thick pop-in absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-30 origin-bottom overflow-hidden rounded-2xl border border-line p-1.5 shadow-pop">
          <div className="flex items-center gap-2.5 px-2 pb-2 pt-1.5">
            <Avatar name={user.name} size={36} src={photo} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-semibold text-ink">
                {user.name}
              </p>
              <p className="truncate text-[11.5px] text-ink-faint">{detail}</p>
            </div>
          </div>

          <div className="my-1 h-px bg-line" />

          <div className="px-2 pb-2 pt-1">
            <p className="pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
              Appearance
            </p>
            <AppearanceControl />
          </div>

          <div className="my-1 h-px bg-line" />


          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setProfileOpen(true);
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] font-medium text-ink transition-colors hover:bg-surface-sunken"
          >
            <UserIcon size={16} className="text-ink-faint" />
            <span className="flex-1">Edit profile</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setSecurityOpen(true);
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] font-medium text-ink transition-colors hover:bg-surface-sunken"
          >
            <LockIcon size={16} className="text-ink-faint" />
            <span className="flex-1">Sign-in &amp; security</span>
          </button>

          {user.password ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setPasswordOpen(true);
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] font-medium text-ink transition-colors hover:bg-surface-sunken"
            >
              <KeyIcon size={16} className="text-ink-faint" />
              <span className="flex-1">Change password</span>
            </button>
          ) : null}

          {user.storagePlan && user.role === "admin" ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setPlan({ returning: null });
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] font-medium text-ink transition-colors hover:bg-surface-sunken"
            >
              <CloudIcon size={16} className="text-ink-faint" />
              <span className="flex-1">Storage plan</span>
              <span className="text-[11.5px] text-ink-faint">Buy space</span>
            </button>
          ) : null}

          {/* Optional and quiet: only here, only when the server offers it. */}
          {user.waitlist ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setWaitlistOpen(true);
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] font-medium text-ink transition-colors hover:bg-surface-sunken"
            >
              <CloudIcon size={16} className="text-ink-faint" />
              <span className="flex-1">Cloud backup</span>
              {joined ? (
                <span className="flex items-center gap-1 text-[11.5px] font-medium text-success-ink">
                  <CheckIcon size={12} /> On the list
                </span>
              ) : (
                <span className="text-[11.5px] text-ink-faint">Waitlist</span>
              )}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] font-medium text-danger transition-colors hover:bg-danger/10"
          >
            <SignOutIcon size={16} />
            Sign out
          </button>
        </div>
      ) : null}

      {passwordOpen && user.password ? (
        <ChangePasswordDialog
          source={user.password}
          onClose={() => setPasswordOpen(false)}
        />
      ) : null}
      {securityOpen ? <SecurityDialog adminPassword={Boolean(user.password)} onClose={() => setSecurityOpen(false)} /> : null}
      {profileOpen ? <ProfileDialog user={user} onClose={() => setProfileOpen(false)} /> : null}
      {plan ? <StoragePlanDialog returning={plan.returning} onClose={() => setPlan(null)} /> : null}
      {waitlistOpen ? (
        <WaitlistDialog
          email={user.email}
          onClose={() => setWaitlistOpen(false)}
          onJoined={() => setJoinedNow(true)}
        />
      ) : null}
    </div>
  );
}
