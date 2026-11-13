import "server-only";

const HOUR = 3_600_000;
const holder = globalThis as unknown as { __jvinuStoreTimers?: boolean };

/**
 * Background passes, once per process: a seller measures every bucket and enforces quotas
 * and deletions; a buyer refreshes its plan, so a cancellation or a new key lands even
 * when nobody opens the app.
 */
export function scheduleStorageTasks() {
  if (holder.__jvinuStoreTimers) return;
  holder.__jvinuStoreTimers = true;

  const run = async () => {
    const { sellerConfig, sweep } = await import("./seller");
    const config = sellerConfig();
    if (config) {
      await sweep(config).catch(async (error: unknown) => {
        const { alert } = await import("./notify");
        await alert("sweep", `The hourly check didn't run: ${(error as Error).message}`);
      });
    }

    const { storeUrl, syncPlan } = await import("../storage-plan");
    if (storeUrl()) await syncPlan({ force: true }).catch((error: unknown) => console.warn("[storage-plan] refresh failed:", (error as Error).message));
  };
  // A minute after start (the database and network settle first), then hourly.
  setTimeout(() => void run(), 60_000).unref();
  setInterval(() => void run(), HOUR).unref();
}
