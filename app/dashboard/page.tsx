import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { QueryProvider } from "../components/query-provider";
import { StorageExplorer } from "../components/storage-explorer";
import { authConfig, currentUser } from "../lib/server/auth";
import { ADMIN_ID, passwordMode } from "../lib/server/first-run";
import { storeUrl } from "../lib/server/storage-plan";
import { waitlistUrl } from "../lib/server/waitlist";

// The app behind sign-in: nothing here for search engines.
export const metadata: Metadata = { title: "Dashboard", robots: { index: false, follow: false } };

/** The authoritative check: no valid session, no app. */
export default async function DashboardPage() {
  // Per request, never at build: sign-in config and the session are both runtime facts.
  // Without this the build-time "not configured" redirect gets baked in as static.
  await connection();
  if (authConfig().problems.length) redirect("/login");
  const user = await currentUser();
  if (!user) redirect("/login");
  // Who can change the password here: only the admin-password account, and only when jvinu keeps it.
  const mode = user.provider === "password" && user.id === ADMIN_ID ? await passwordMode() : null;
  const password = mode === "stored" ? "app" : mode === "env" ? "env" : undefined;
  return (
    <QueryProvider>
      <StorageExplorer
        user={{ name: user.name, email: user.email, avatar: user.avatar, role: user.role, provider: user.provider, waitlist: waitlistUrl() !== null, storagePlan: storeUrl() !== null, password }}
      />
    </QueryProvider>
  );
}
