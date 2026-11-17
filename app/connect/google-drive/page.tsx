import type { Metadata } from "next";
import { Wordmark } from "../../components/wordmark";

export const metadata: Metadata = {
  title: "Google Drive sign-in",
  // The code is in this page's address: never send it on as a referrer, never index it.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

/**
 * Where Google sends the browser after "Sign in with Google". It only shows the code: the
 * code is worthless without the PKCE verifier, which never left the form that started this.
 */
export default async function GoogleDriveSignIn({ searchParams }: Props) {
  const params = await searchParams;
  const code = one(params.code);
  const error = one(params.error);
  const valid = /^[A-Za-z0-9_/.~-]{8,1024}$/.test(code);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface px-4 py-12">
      <div className="w-full max-w-[460px] rounded-2xl border border-line bg-surface-raised p-6 shadow-card">
        <Wordmark />
        {valid ? (
          <>
            <h1 className="mt-6 text-[19px] font-semibold tracking-[-0.01em] text-ink">Google Drive is ready to connect</h1>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">
              Copy this code, go back to the jvinu tab and paste it into <strong>Sign-in code</strong>, then click Connect. It works
              once, for a few minutes.
            </p>
            <textarea
              readOnly
              rows={3}
              value={code}
              aria-label="Sign-in code"
              className="mt-4 w-full resize-none rounded-xl border border-line bg-surface px-3 py-2.5 font-mono text-[12.5px] text-ink outline-none focus:border-accent"
            />
            <p className="mt-3 text-[12.5px] text-ink-faint">You can close this tab afterwards.</p>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-[19px] font-semibold tracking-[-0.01em] text-ink">Google Drive wasn&rsquo;t connected</h1>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">
              {error === "access_denied"
                ? "Access wasn't allowed. Close this tab and click “Sign in with Google” again to try once more."
                : "Google didn't send a sign-in code. Close this tab and click “Sign in with Google” again."}
            </p>
          </>
        )}
      </div>
    </main>
  );
}
