"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { NOTICE_KEY } from "../lib/cookies";
import { CookieIcon } from "./icons";

function subscribe(listener: () => void) {
  // Closed in another tab: close here too.
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

function read(): boolean {
  try {
    return localStorage.getItem(NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Says what jvinu's cookies are for, until it's closed. Every cookie is needed to sign in,
 * so there's nothing to accept or refuse: it informs, and links to the full list.
 */
export function CookieNotice() {
  // The server can't know, so nothing renders until the browser has said.
  const seen = useSyncExternalStore(subscribe, read, () => true);
  const [closed, setClosed] = useState(false);
  if (seen || closed) return null;

  function close() {
    try {
      localStorage.setItem(NOTICE_KEY, "1");
    } catch {
      // Storage blocked: closed for this visit only.
    }
    setClosed(true);
  }

  return (
    <section
      aria-label="Cookies"
      className="material-thick tray-in fixed inset-x-3 bottom-3 z-50 rounded-2xl border border-line p-4 shadow-pop sm:inset-x-auto sm:bottom-5 sm:left-5 sm:w-[360px]"
    >
      <div className="flex gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
          <CookieIcon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-ink">Only the cookies sign-in needs</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
            jvinu uses a cookie to keep you signed in, and nothing else: no tracking, analytics or ads.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={close}
              className="spring rounded-xl bg-accent-fill px-3.5 py-1.5 text-[13px] font-semibold text-white shadow-card transition hover:bg-accent-hover active:scale-[0.97]"
            >
              Got it
            </button>
            <Link href="/cookies" className="text-[12.5px] font-medium text-accent-strong hover:underline">
              What&rsquo;s stored, and why
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
