import "server-only";
import { forgetConnectionActivity } from "./activity";
import type { DiskStatus } from "./bundled-storage";
import {
  deleteConnection,
  insertConnection,
  managedRow,
  nameTaken,
  newConnectionId,
  retarget,
  type S3Credentials,
  type StoredConnection,
} from "./connections";
import { openWith, sealWith } from "./crypto";
import { db } from "./db";
import { driverFor } from "./drivers";
import { forgetConnectionNotes } from "./notes";
import { S3_COMPATIBLE } from "./s3-compatible";
import { sellerConfig } from "./store/seller";
import { forgetConnectionLinks } from "./shares";
import { forgetConnectionItems } from "./user-items";
import { DEFAULT_BLOCK_PRICE_CENTS, MAX_BLOCKS, type Billing, type PlanStatus, type PlanView } from "../storage-plan";

/**
 * Buying storage: this server orders it from a storage seller (another jvinu with selling
 * turned on), keeps the order's token, and once it's paid keeps one server-managed
 * "Cloud storage" connection pointing at the bucket. Uploads stop at the quota.
 *
 *   JVINU_STORAGE_STORE_URL=https://…   the seller
 *   JVINU_STORAGE_STORE=off             hide it even when a URL is set
 */
export const PLAN_NAME = "Cloud storage";
const ORDER_KEY = "storage-plan-order";
const SEAL = "storage-plan";

export function storeUrl(): string | null {
  if ((process.env.JVINU_STORAGE_STORE ?? "").toLowerCase() === "off") return null;
  // A server that sells storage can buy from itself without being told where it is.
  const raw = process.env.JVINU_STORAGE_STORE_URL?.trim() || (sellerConfig() ? selfUrl() : "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    // https only: the bucket's key travels in the response.
    return url.protocol === "https:" || local ? url.origin : null;
  } catch {
    return null;
  }
}

/** This server, as it can reach itself: the configured public URL, else the local port. */
function selfUrl(): string {
  const configured = (process.env.JVINU_PUBLIC_URL ?? "").replace(/\/+$/, "");
  return /^https?:\/\//.test(configured) ? configured : `http://localhost:${process.env.PORT || 3000}`;
}

export class PlanError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** What the seller says about our order (see store/seller.ts → orderView). */
type SellerOrder = {
  status: PlanStatus;
  billing?: Billing;
  blocks: number;
  quotaBytes: number;
  usedBytes: number;
  measuredAt: string | null;
  access: "read-write" | "read-only" | null;
  deleteAt: string | null;
  bucket: { presetId: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string } | null;
};

type Saved = { store: string; token: string };

async function savedOrder(): Promise<Saved | null> {
  const row = await (await db()).get<{ value: string }>(`select value from server_settings where key = ?`, [ORDER_KEY]);
  if (!row) return null;
  try {
    return openWith<Saved>(SEAL, row.value, ORDER_KEY);
  } catch {
    return null; // sealed under an earlier JVINU_SECRET
  }
}

async function saveOrder(saved: Saved | null) {
  const database = await db();
  if (!saved) {
    await database.run(`delete from server_settings where key = ?`, [ORDER_KEY]);
    return;
  }
  await database.run(
    `insert into server_settings (key, value, updated_at) values (?, ?, ?)
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [ORDER_KEY, sealWith(SEAL, saved, ORDER_KEY), new Date().toISOString()],
  );
}

async function seller<T>(store: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${store}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new PlanError("Couldn't reach the storage service. Try again in a moment.", 502);
  }
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new PlanError(data.error ?? `The storage service answered ${response.status}.`, response.status === 401 ? 410 : 502);
  return data;
}

/* ---- Cached state, per process ----------------------------------------------------- */

const state = globalThis as unknown as {
  __jvinuPlan?: { order: SellerOrder | null; at: number };
  __jvinuPlanPrice?: StoreInfo & { at: number };
};
const FRESH_MS = 60_000;

type StoreInfo = { cents: number; terms: string | null; minBlocks: number; yearlyCents: number | null };

const positiveInt = (value: unknown, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max ? value : null;

/** The seller's prices, smallest plan and terms of service, cached for an hour. */
async function storeInfo(store: string): Promise<StoreInfo> {
  const cached = state.__jvinuPlanPrice;
  if (cached && Date.now() - cached.at < 3_600_000) return cached;
  type Raw = { priceCents?: unknown; termsUrl?: unknown; minBlocks?: unknown; yearlyPriceCents?: unknown };
  const info = await seller<Raw>(store, "/api/store").catch(() => ({}) as Raw);
  state.__jvinuPlanPrice = {
    cents: positiveInt(info.priceCents) ?? DEFAULT_BLOCK_PRICE_CENTS,
    // Only an https page is shown as a link.
    terms: typeof info.termsUrl === "string" && /^https:\/\/[^\s]+$/.test(info.termsUrl) ? info.termsUrl : null,
    minBlocks: positiveInt(info.minBlocks, MAX_BLOCKS) ?? 1,
    yearlyCents: positiveInt(info.yearlyPriceCents),
    at: Date.now(),
  };
  return state.__jvinuPlanPrice;
}

/**
 * Asks the seller where the order stands and brings the "Cloud storage" connection in line:
 * made once paid, re-keyed when the seller changes its key, removed once the bucket is gone.
 */
export async function syncPlan({ force = false } = {}): Promise<SellerOrder | null> {
  const cached = state.__jvinuPlan;
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return cached.order;
  const saved = await savedOrder();
  if (!saved) {
    state.__jvinuPlan = { order: null, at: Date.now() };
    return null;
  }
  let order: SellerOrder;
  try {
    order = await seller<SellerOrder>(saved.store, "/api/store/order", { headers: { authorization: `Bearer ${saved.token}` } });
  } catch (error) {
    // The seller no longer knows the order (an unpaid checkout it cleared away).
    if (error instanceof PlanError && error.status === 410 && !(await managedRow("cloud-storage"))) {
      await saveOrder(null);
      state.__jvinuPlan = { order: null, at: Date.now() };
      return null;
    }
    throw error;
  }
  await applyOrder(order);
  // A deleted bucket ends the order here: the server can buy a new plan.
  const current = order.status === "deleted" ? null : order;
  state.__jvinuPlan = { order: current, at: Date.now() };
  return current;
}

async function applyOrder(order: SellerOrder) {
  const row = await managedRow("cloud-storage");
  if (order.status === "deleted" || (!order.bucket && order.status !== "pending")) {
    if (order.status === "deleted") {
      if (row) await removeConnection(row.id);
      await saveOrder(null);
    }
    return;
  }
  if (!order.bucket) return;

  const target = targetOf(order.bucket);
  if (row) {
    const current = row.connection;
    const same =
      current?.credentials.kind === "s3" &&
      current.bucket === target.bucket &&
      current.endpoint === target.endpoint &&
      current.credentials.accessKeyId === target.credentials.accessKeyId &&
      current.credentials.secretAccessKey === target.credentials.secretAccessKey;
    if (!same) await retarget(row.id, target);
    return;
  }

  // Nothing is saved until the bucket answers with the new key.
  await driverFor(target).verify();
  let name = PLAN_NAME;
  for (let n = 2; await nameTaken(name); n++) name = `${PLAN_NAME} (${n})`;
  await insertConnection({
    id: newConnectionId(),
    ...target,
    name,
    readOnly: false,
    managed: "cloud-storage",
    createdBy: "system",
    createdAt: new Date().toISOString(),
  });
  console.info(`[storage-plan] connected “${name}” (${target.presetId}, bucket ${target.bucket})`);
}

/** The connection is built here from checked parts: the seller can only point it at Wasabi or B2. */
function targetOf(
  bucket: NonNullable<SellerOrder["bucket"]>,
): Pick<StoredConnection, "presetId" | "bucket" | "region" | "endpoint"> & { credentials: S3Credentials } {
  if (bucket.presetId !== "b2" && bucket.presetId !== "wasabi") throw new PlanError("The storage service sent an unknown provider.", 502);
  const spec = S3_COMPATIBLE[bucket.presetId];
  const located = spec.locate({ region: bucket.region });
  if ("error" in located) throw new PlanError("The storage service sent an unknown region.", 502);
  if (!spec.bucket.test(bucket.bucket) || !spec.accessKey.test(bucket.accessKeyId) || !bucket.secretAccessKey) {
    throw new PlanError("The storage service sent a key that doesn't look right.", 502);
  }
  return {
    presetId: bucket.presetId,
    bucket: bucket.bucket,
    region: located.region,
    endpoint: located.endpoint,
    credentials: { kind: "s3", accessKeyId: bucket.accessKeyId, secretAccessKey: bucket.secretAccessKey },
  };
}

async function removeConnection(id: string) {
  await deleteConnection(id);
  await forgetConnectionItems(id);
  await forgetConnectionNotes(id);
  await forgetConnectionLinks(id);
  await forgetConnectionActivity(id);
  console.info("[storage-plan] the bucket was deleted by the storage service; removed “Cloud storage”");
}

/* ---- What the routes use ---------------------------------------------------------- */

export async function planView(): Promise<PlanView> {
  const store = storeUrl();
  const base: PlanView = {
    available: Boolean(store),
    priceCents: DEFAULT_BLOCK_PRICE_CENTS,
    currency: "EUR",
    termsUrl: null,
    minBlocks: 1,
    yearlyPriceCents: null,
    billing: "month",
    status: "none",
    blocks: 0,
    quotaBytes: 0,
    usedBytes: 0,
    deleteAt: null,
    connectionId: null,
  };
  if (!store) return base;
  const info = await storeInfo(store);
  base.priceCents = info.cents;
  base.termsUrl = info.terms;
  base.minBlocks = info.minBlocks;
  base.yearlyPriceCents = info.yearlyCents;
  const order = await syncPlan();
  const row = await managedRow("cloud-storage");
  if (!order) return { ...base, connectionId: row?.id ?? null };
  return {
    ...base,
    status: order.status,
    billing: order.billing === "year" ? "year" : "month",
    blocks: order.blocks,
    quotaBytes: order.quotaBytes,
    usedBytes: order.usedBytes,
    deleteAt: order.deleteAt,
    connectionId: row?.id ?? null,
  };
}

/** Starts a purchase and returns the payment page's address. */
export async function beginCheckout(blocks: number, returnUrl: string, email?: string, billing: Billing = "month"): Promise<string> {
  const store = storeUrl();
  if (!store) throw new PlanError("Buying storage isn't set up on this server.", 404);
  const current = await syncPlan({ force: true }).catch(() => null);
  if (current && current.status !== "pending" && current.status !== "deleted") {
    throw new PlanError("This server already has a storage plan. Use “Manage plan” to change its size.", 409);
  }
  const started = await seller<{ token: string; checkoutUrl: string }>(store, "/api/store/checkout", {
    method: "POST",
    body: JSON.stringify({ blocks, returnUrl, email, billing }),
  });
  await saveOrder({ store, token: started.token });
  state.__jvinuPlan = undefined;
  return started.checkoutUrl;
}

export async function billingPortal(returnUrl: string): Promise<string> {
  const saved = await savedOrder();
  if (!saved) throw new PlanError("There's no storage plan on this server yet.", 404);
  const portal = await seller<{ url: string }>(saved.store, "/api/store/portal", {
    method: "POST",
    headers: { authorization: `Bearer ${saved.token}` },
    body: JSON.stringify({ returnUrl }),
  });
  return portal.url;
}

/** Last known state without waiting on the network when it's recent; never throws. */
async function currentOrder(): Promise<SellerOrder | null> {
  try {
    return await syncPlan();
  } catch {
    return state.__jvinuPlan?.order ?? null;
  }
}

/**
 * Refuses a write that the plan doesn't allow. Returns the message to show, or null when
 * there's room. Usage comes from the seller, measured at most a few minutes ago.
 */
export async function planBlocks(incomingBytes = 0): Promise<string | null> {
  const order = await currentOrder();
  if (!order) return null;
  if (order.status === "suspended") return `${PLAN_NAME} is suspended by the storage service. Contact them to find out why.`;
  if (order.status === "past_due") return `${PLAN_NAME} is paused: the last payment didn't go through. Update it under “Manage plan” in the account menu.`;
  if (order.status === "canceled") return `${PLAN_NAME} was cancelled, so it's read-only. Download what you need before it's deleted.`;
  if (order.status !== "active") return null;
  if (order.usedBytes + incomingBytes <= order.quotaBytes) return null;
  const free = Math.max(0, order.quotaBytes - order.usedBytes) / 1024 ** 3;
  return `That would go past your ${Math.round(order.quotaBytes / 1024 ** 3)} GB plan (${free.toFixed(1)} GB free). Delete something, or add space under “Manage plan”.`;
}

/** The plan as a "disk", so the sidebar meter and the upload limits work as for bundled storage. */
export async function planDisk(): Promise<DiskStatus | null> {
  const order = await currentOrder();
  if (!order || !order.quotaBytes) return null;
  const used = Math.min(order.usedBytes, Number.MAX_SAFE_INTEGER);
  const ratio = used / order.quotaBytes;
  return {
    total: order.quotaBytes,
    used,
    available: Math.max(0, order.quotaBytes - used),
    ratio,
    level: ratio >= 1 || order.status !== "active" ? "full" : ratio >= 0.85 ? "warn" : "ok",
    blockAt: 1,
  };
}
