import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { CookieIcon, ExternalIcon, LockIcon } from "../components/icons";
import { BROWSER_STORAGE, COOKIES, type Kept } from "../lib/cookies";
import { Wordmark } from "../components/wordmark";

const UPDATED = "October 12, 2026";

export const metadata: Metadata = {
  title: "Cookies",
  description:
    "jvinu sets cookies only to sign you in: no tracking, analytics or advertising. Every cookie and browser setting it keeps, what it's for and how long it lasts.",
};

function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children?: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-ink sm:text-[24px]">{title}</h2>
      {intro ? <div className="mt-2 max-w-[720px] space-y-3 text-[15px] leading-relaxed text-ink-muted">{intro}</div> : null}
      {children ? <div className="mt-5">{children}</div> : null}
    </section>
  );
}

/** One cookie or stored setting: its name, what it's for, and how long it stays. */
function Entries({ items, label }: { items: Kept[]; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-card">
      {items.map((item) => (
        <li key={item.name} className="px-5 py-4">
          <code className="font-mono text-[13px] font-semibold text-ink">{item.name}</code>
          <p className="mt-1 text-[14px] leading-relaxed text-ink-muted">{item.purpose}</p>
          <p className="mt-1.5 text-[12.5px] text-ink-faint">
            {item.lifetime} · {item.when}
          </p>
        </li>
      ))}
    </ul>
  );
}

const SUMMARY = [
  { icon: <CookieIcon size={18} />, title: "Only what sign-in needs", body: "Every cookie is there to sign you in or keep you signed in." },
  { icon: <LockIcon size={18} />, title: "No tracking", body: "No analytics, advertising or fingerprinting. Nothing about you is sent anywhere." },
  { icon: <ExternalIcon size={18} />, title: "No third parties", body: "Fonts and videos come from this server. No other site sets cookies here." },
];

export default function CookiesPage() {
  return (
    <>
      <header className="material sticky top-0 z-40 border-b border-line">
        <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center justify-between px-5 sm:px-8">
          <Link href="/dashboard" aria-label="Open jvinu">
            <Wordmark className="text-[21px] text-ink" />
          </Link>
          <Link href="/dashboard" className="text-[13px] font-medium text-accent-strong hover:underline">
            Back to the app
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1200px] px-5 pb-24 pt-14 sm:px-8">
        <div className="hero-in max-w-[760px]">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[12px] font-medium text-accent-strong">
            Cookies
          </span>
          <h1 className="mt-4 text-balance text-[38px] font-semibold leading-[1.06] tracking-[-0.035em] text-ink sm:text-[48px]">
            Only the cookies sign-in needs
          </h1>
          <p className="mt-4 text-pretty text-[17px] leading-relaxed text-ink-muted">
            jvinu sets cookies to sign you in, and for nothing else: no tracking, analytics or advertising. Every one of them is
            needed for the app to work, so there&rsquo;s nothing to accept or refuse. Here is everything it keeps in your
            browser, and why.
          </p>
          <p className="mt-3 text-[13px] text-ink-faint">Last updated {UPDATED}.</p>
        </div>

        <ul className="mt-10 grid gap-4 md:grid-cols-3">
          {SUMMARY.map((item) => (
            <li key={item.title} className="rounded-3xl border border-line bg-surface-raised p-6 shadow-card">
              <span className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">{item.icon}</span>
              <h2 className="mt-4 text-[16px] font-semibold text-ink">{item.title}</h2>
              <p className="mt-1.5 text-[14px] leading-relaxed text-ink-muted">{item.body}</p>
            </li>
          ))}
        </ul>

        <div className="mt-16 max-w-[820px] space-y-14">
          <Section
            id="cookies"
            title="Cookies"
            intro={
              <p>
                All of them are jvinu&rsquo;s own. They&rsquo;re <strong className="font-semibold text-ink">HttpOnly</strong>, so no
                script on a page can read them; <code className="font-mono text-[13.5px]">SameSite=Lax</code>, so other sites
                can&rsquo;t send them along in the background; and, when the site is served over HTTPS, they only travel encrypted.
              </p>
            }
          >
            <Entries items={COOKIES} label="Cookies" />
          </Section>

          <Section
            id="browser-storage"
            title="Settings kept in your browser"
            intro={
              <p>
                These aren&rsquo;t cookies. They stay in your browser&rsquo;s local storage and are never sent to the server. Each is
                there to remember a choice you made.
              </p>
            }
          >
            <Entries items={BROWSER_STORAGE} label="Settings kept in your browser" />
          </Section>

          <Section
            id="providers"
            title="Your files and your storage provider"
            intro={
              <p>
                When you preview or download a file, your browser may fetch it straight from your storage provider (Amazon S3,
                Azure, Google Cloud and so on) through a short-lived signed link. That request goes to the provider, under its own
                terms. On an encrypted connection, files always come through this server instead.
              </p>
            }
          />

          <Section
            id="choices"
            title="Your choices"
            intro={
              <>
                <p>
                  Signing out deletes the session cookie at once. Your browser can remove everything listed here: clear this
                  site&rsquo;s data in its settings. You can also block cookies for this site, but then you can&rsquo;t sign in.
                </p>
                <p>This page and share links set no cookies at all.</p>
              </>
            }
          />

          <Section
            id="self-hosting"
            title="Running your own jvinu?"
            intro={
              <p>
                This page describes what the jvinu software itself stores. If you add analytics, a chat widget or any other
                third-party service to your server, update this page, and ask visitors for consent where the law requires it.
              </p>
            }
          />
        </div>
      </main>
    </>
  );
}
