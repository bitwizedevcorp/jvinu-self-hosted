import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { authConfig, currentUser } from "../lib/server/auth";
import { announceSetup, passwordMode, setupCodeMatches } from "../lib/server/first-run";
import { CookieNotice } from "../components/cookie-notice";
import { Wordmark } from "../components/wordmark";
import { twoFactorEnabled } from "../lib/server/two-factor";
import { LoginForm } from "./login-form";
import { SetupDialog } from "./setup-dialog";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: true } };

const ERRORS: Record<string, string> = {
  "oidc-disabled": "Single sign-on isn't configured on this server.",
  "oidc-unreachable": "Couldn't reach the sign-in provider. Try again shortly.",
  "oidc-expired": "That sign-in took too long or was already used. Start again.",
  "oidc-failed": "The sign-in provider didn't confirm who you are. Try again.",
  "not-allowed": "That account isn't allowed on this server.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  await connection(); // read the environment and session per request, not at build
  const config = authConfig();
  if (!config.problems.length && (await currentUser())) redirect("/dashboard");
  const params = await searchParams;
  const message = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const mode = config.problems.length ? null : await passwordMode();
  // A server waiting for its first password: its log shows the setup code (again, if it's been a minute).
  if (mode === "setup") announceSetup();
  const linkCode = typeof params.setup === "string" ? params.setup.slice(0, 64) : "";

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="material w-full max-w-[400px] rounded-2xl border border-line p-8 shadow-panel">
        <div className="text-center">
          <Wordmark withTagline className="text-[30px] text-ink" />
          <h1 className="mt-6 text-[17px] font-semibold text-ink">{mode === "setup" ? "Welcome" : "Sign in"}</h1>
        </div>

        {config.problems.length ? (
          <div role="alert" className="mt-6 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-ink">
            <p className="font-semibold">This server isn&rsquo;t set up yet.</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-ink-muted">
              {config.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : mode === "setup" ? (
          <SetupDialog code={linkCode} codeValid={Boolean(linkCode) && setupCodeMatches(linkCode)} />
        ) : (
          <>
            {message ? (
              <p role="alert" className="mt-6 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-ink">
                {message}
              </p>
            ) : null}
            <LoginForm
              password={mode === "env" || mode === "stored"}
              twoStep={(mode === "env" || mode === "stored") && (await twoFactorEnabled())}
              sso={Boolean(config.oidc)}
              demo={config.demo}
            />
          </>
        )}
      </div>
      <CookieNotice />
    </main>
  );
}
