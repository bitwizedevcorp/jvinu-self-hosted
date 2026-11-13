/**
 * At startup: outgoing connections are kept away from cloud metadata addresses (egress.ts),
 * and a server with no way to sign in yet says in its log how to choose a password
 * (first-run.ts). Sold or bought storage is checked hourly (store/schedule.ts). The checks
 * never hold up or break the start.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  requireCertificateChecks();
  try {
    const { guardLookups } = await import("./app/lib/server/egress");
    guardLookups();
  } catch (error) {
    console.error("[egress] couldn't guard outgoing connections", error);
  }
  try {
    const { atStartup } = await import("./app/lib/server/first-run");
    void atStartup().catch((error: unknown) => console.error("[first-run] couldn't check the sign-in setup", error));
  } catch (error) {
    console.error("[first-run] couldn't check the sign-in setup", error);
  }
  try {
    const { scheduleStorageTasks } = await import("./app/lib/server/store/schedule");
    scheduleStorageTasks();
  } catch (error) {
    console.error("[store] couldn't schedule storage checks", error);
  }
}

/**
 * NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks for every outgoing connection:
 * storage keys, Stripe and single sign-on could then be read by anyone in the middle. Node
 * reads it at each connection, so in production it's removed here, unless
 * JVINU_ALLOW_INSECURE_TLS=1 says it's wanted. In development it's only reported.
 */
function requireCertificateChecks() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") return;
  if (process.env.NODE_ENV === "production" && process.env.JVINU_ALLOW_INSECURE_TLS !== "1") {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    console.error(
      "[tls] NODE_TLS_REJECT_UNAUTHORIZED=0 was set; it's been ignored so certificates are still checked. Remove it from the environment (or set JVINU_ALLOW_INSECURE_TLS=1 if you really mean it).",
    );
  } else {
    console.warn("[tls] NODE_TLS_REJECT_UNAUTHORIZED=0: certificates aren't being checked. Never run production like this.");
  }
}
