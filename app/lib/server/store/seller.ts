import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { openWith, sealWith } from "../crypto";
import { db } from "../db";
import { driverFor } from "../drivers";
import { BLOCK_GB, DEFAULT_BLOCK_PRICE_CENTS, MAX_BLOCKS, quotaOf, type Billing, type PlanStatus } from "../../storage-plan";
import { B2Provider, WasabiProvider, type Access, type ProvisionedBucket, type StorageProvider } from "./providers";
import { alert, notify, notifyUsage } from "./notify";
import { stripe, type StripeCheckoutSession, type StripeSubscription } from "./stripe";

/**
 * Selling storage: this server takes payment through Stripe, makes each customer a private
 * bucket on Wasabi or Backblaze B2, and hands the bucket's key to the customer's jvinu.
 * Off unless the JVINU_SELLER_* settings are complete. See docs/sell-storage.md.
 *
 * Price: one block of 100 GB a month, VAT included (€3 by default). Stripe holds the
 * subscription; this table mirrors it and follows every change through the webhook.
 */
export type SellerConfig = {
  stripeKey: string;
  webhookSecret: string;
  /** A Stripe Price (recurring, per unit, tax-inclusive). Without it, Checkout builds one. */
  stripePrice?: string;
  /** Let Stripe Tax work out each country's VAT inside the inclusive price. */
  stripeTax: boolean;
  priceCents: number;
  /** Smallest plan, in blocks: per-invoice card fees make a single €3 block thin. */
  minBlocks: number;
  /** One block for a year, VAT included; null when only monthly billing is offered. */
  yearlyPriceCents: number | null;
  /** A yearly Stripe Price (recurring yearly, per unit, tax-inclusive). */
  stripePriceYearly?: string;
  keepDays: number;
  /** Terms of service buyers accept at checkout (an https page). */
  termsUrl: string | null;
  /** Bearer token for the seller's own admin API (abuse handling); null turns it off. */
  adminToken: string | null;
  provider: () => StorageProvider;
};

let providerOverride: StorageProvider | null = null;
let cachedProvider: { key: string; provider: StorageProvider } | null = null;

/** Tests swap the cloud for an in-memory one. */
export function setProviderForTests(provider: StorageProvider | null) {
  providerOverride = provider;
}

export function sellerConfig(): SellerConfig | null {
  const env = process.env;
  const stripeKey = env.JVINU_SELLER_STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.JVINU_SELLER_STRIPE_WEBHOOK_SECRET?.trim();
  if (!stripeKey || !webhookSecret) return null;

  let provider: (() => StorageProvider) | null = null;
  const which = (env.JVINU_SELLER_PROVIDER ?? "b2").toLowerCase();
  if (providerOverride) {
    const fixed = providerOverride;
    provider = () => fixed;
  } else if (which === "b2" && env.JVINU_SELLER_B2_KEY_ID && env.JVINU_SELLER_B2_KEY) {
    const master = { keyId: env.JVINU_SELLER_B2_KEY_ID, key: env.JVINU_SELLER_B2_KEY };
    provider = () => cached(`b2:${master.keyId}`, () => new B2Provider(master));
  } else if (which === "wasabi" && env.JVINU_SELLER_WASABI_ACCESS_KEY && env.JVINU_SELLER_WASABI_SECRET_KEY) {
    const master = {
      accessKeyId: env.JVINU_SELLER_WASABI_ACCESS_KEY,
      secretAccessKey: env.JVINU_SELLER_WASABI_SECRET_KEY,
      region: env.JVINU_SELLER_WASABI_REGION || "eu-central-2",
    };
    provider = () => cached(`wasabi:${master.accessKeyId}:${master.region}`, () => new WasabiProvider(master));
  }
  if (!provider) return null;

  const cents = Number(env.JVINU_SELLER_PRICE_CENTS || DEFAULT_BLOCK_PRICE_CENTS);
  const terms = env.JVINU_SELLER_TERMS_URL?.trim();
  const minBlocks = Number(env.JVINU_SELLER_MIN_BLOCKS || 1);
  const yearly = Number(env.JVINU_SELLER_YEARLY_PRICE_CENTS || 0);
  const adminToken = env.JVINU_SELLER_ADMIN_TOKEN?.trim();
  const days = Number(env.JVINU_SELLER_KEEP_DAYS || 30);
  return {
    stripeKey,
    webhookSecret,
    stripePrice: env.JVINU_SELLER_STRIPE_PRICE?.trim() || undefined,
    stripeTax: env.JVINU_SELLER_STRIPE_TAX === "1",
    priceCents: Number.isInteger(cents) && cents > 0 ? cents : DEFAULT_BLOCK_PRICE_CENTS,
    minBlocks: Number.isInteger(minBlocks) && minBlocks >= 1 && minBlocks <= MAX_BLOCKS ? minBlocks : 1,
    yearlyPriceCents: Number.isInteger(yearly) && yearly > 0 ? yearly : null,
    stripePriceYearly: env.JVINU_SELLER_STRIPE_PRICE_YEARLY?.trim() || undefined,
    keepDays: Number.isFinite(days) && days >= 0 ? days : 30,
    termsUrl: terms && /^https:\/\/[^\s]+$/.test(terms) ? terms : null,
    // Long enough that it can't be guessed.
    adminToken: adminToken && adminToken.length >= 32 ? adminToken : null,
    provider,
  };
}

function cached(key: string, make: () => StorageProvider): StorageProvider {
  if (cachedProvider?.key !== key) cachedProvider = { key, provider: make() };
  return cachedProvider.provider;
}

/* ---- Orders ----------------------------------------------------------------------- */

type Row = {
  id: string;
  token_hash: string;
  status: PlanStatus;
  blocks: number | string;
  email: string | null;
  stripe_session: string | null;
  stripe_customer: string | null;
  stripe_subscription: string | null;
  target: string | null;
  access: Access | null;
  used_bytes: number | string;
  measured_at: string | null;
  provisioning_at: string | null;
  canceled_at: string | null;
  delete_at: string | null;
  suspended: string | null;
  billing: Billing | null;
  created_at: string;
};

export type Order = {
  id: string;
  status: PlanStatus;
  blocks: number;
  email: string | null;
  stripeCustomer: string | null;
  stripeSubscription: string | null;
  target: ProvisionedBucket | null;
  access: Access | null;
  usedBytes: number;
  measuredAt: string | null;
  deleteAt: string | null;
  /** Why the seller suspended it; null when it isn't. */
  suspended: string | null;
  billing: Billing;
  createdAt: string;
};

const SEAL = "storage-order";
const hashSecret = (secret: string) => createHash("sha256").update(secret).digest();

function fromRow(row: Row): Order {
  return {
    id: row.id,
    status: row.status,
    blocks: Number(row.blocks),
    email: row.email,
    stripeCustomer: row.stripe_customer,
    stripeSubscription: row.stripe_subscription,
    target: row.target ? openWith<ProvisionedBucket>(SEAL, row.target, row.id) : null,
    access: row.access,
    usedBytes: Number(row.used_bytes),
    measuredAt: row.measured_at,
    deleteAt: row.delete_at,
    suspended: row.suspended ?? null,
    billing: row.billing === "year" ? "year" : "month",
    createdAt: row.created_at,
  };
}

async function load(id: string): Promise<Order | null> {
  const row = await (await db()).get<Row>(`select * from storage_orders where id = ?`, [id]);
  return row ? fromRow(row) : null;
}

/** The order a buyer's token names, or null. The token is "<order id>.<secret>". */
export async function orderForToken(token: string): Promise<Order | null> {
  const [id, secret] = token.split(".", 2);
  if (!id || !secret || id.length > 64 || secret.length > 128) return null;
  const row = await (await db()).get<Row>(`select * from storage_orders where id = ?`, [id]);
  if (!row) return null;
  const expected = Buffer.from(row.token_hash, "hex");
  const given = hashSecret(secret);
  return expected.length === given.length && timingSafeEqual(expected, given) ? fromRow(row) : null;
}

async function save(id: string, fields: Partial<Record<keyof Row, unknown>>) {
  const entries = Object.entries({ ...fields, updated_at: new Date().toISOString() });
  await (await db()).run(`update storage_orders set ${entries.map(([key]) => `${key} = ?`).join(", ")} where id = ?`, [
    ...entries.map(([, value]) => value),
    id,
  ]);
}

const sealTarget = (target: ProvisionedBucket, id: string) => sealWith(SEAL, target, id);

/* ---- Checkout --------------------------------------------------------------------- */

/**
 * Starts a purchase. The buyer's server gets back a token to fetch the bucket with once
 * it's paid; the person is sent to `checkoutUrl`, and back to `returnUrl` afterwards.
 */
export async function startCheckout(
  config: SellerConfig,
  { blocks, returnUrl, email, billing = "month" }: { blocks: number; returnUrl: string; email?: string; billing?: Billing },
): Promise<{ orderId: string; token: string; checkoutUrl: string }> {
  if (blocks < config.minBlocks) throw new Error(`The smallest plan is ${config.minBlocks * BLOCK_GB} GB.`);
  if (billing === "year" && !config.yearlyPriceCents) throw new Error("Yearly billing isn't offered.");
  const id = randomBytes(12).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  await (await db()).run(
    `insert into storage_orders (id, token_hash, status, blocks, email, billing, created_at, updated_at) values (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [id, hashSecret(secret).toString("hex"), blocks, email ?? null, billing, now, now],
  );

  const back = (outcome: string) => {
    const url = new URL(returnUrl);
    url.searchParams.set("storage", outcome);
    return url.href;
  };
  const yearly = billing === "year";
  const fixedPrice = yearly ? config.stripePriceYearly : config.stripePrice;
  const line = fixedPrice
    ? { "line_items[0][price]": fixedPrice }
    : {
        "line_items[0][price_data][currency]": "eur",
        "line_items[0][price_data][unit_amount]": yearly ? config.yearlyPriceCents! : config.priceCents,
        "line_items[0][price_data][recurring][interval]": billing,
        "line_items[0][price_data][tax_behavior]": "inclusive",
        "line_items[0][price_data][product_data][name]": `Cloud storage — ${BLOCK_GB} GB`,
      };
  const session = await stripe<StripeCheckoutSession>(config.stripeKey, "POST", "checkout/sessions", {
    mode: "subscription",
    ...line,
    "line_items[0][quantity]": blocks,
    client_reference_id: id,
    "metadata[order_id]": id,
    "subscription_data[metadata][order_id]": id,
    customer_email: email,
    success_url: back("paid"),
    cancel_url: back("canceled"),
    ...(config.stripeTax
      ? { "automatic_tax[enabled]": true, billing_address_collection: "required", "tax_id_collection[enabled]": true }
      : {}),
    // The buyer ticks "I agree to the terms" on Stripe's page (the URL is set in Stripe's
    // dashboard too: Settings → Public details).
    ...(config.termsUrl ? { "consent_collection[terms_of_service]": "required" } : {}),
  });
  if (!session.url) throw new Error("Stripe didn't return a checkout address.");
  await save(id, { stripe_session: session.id });
  return { orderId: id, token: `${id}.${secret}`, checkoutUrl: session.url };
}

/** A Stripe billing-portal page where the customer changes size, pays, or cancels. */
export async function portalUrl(config: SellerConfig, order: Order, returnUrl: string): Promise<string> {
  if (!order.stripeCustomer) throw new Error("This order hasn't been paid yet.");
  const portal = await stripe<{ url: string }>(config.stripeKey, "POST", "billing_portal/sessions", {
    customer: order.stripeCustomer,
    return_url: returnUrl,
  });
  return portal.url;
}

/* ---- Following Stripe ------------------------------------------------------------- */

export function statusOf(subscription: Pick<StripeSubscription, "status">): PlanStatus {
  switch (subscription.status) {
    case "active":
    case "trialing":
      return "active";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      // incomplete, past_due, unpaid, paused: keep the files, stop new ones.
      return "past_due";
  }
}

type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

/**
 * One webhook delivery. Whatever the event, the subscription is fetched fresh and the order
 * brought in line with it, so deliveries arriving late, twice, or out of order all end the
 * same way. Throws on failure: Stripe then retries.
 */
export async function handleEvent(config: SellerConfig, event: StripeEvent): Promise<void> {
  const object = event.data.object;
  let orderId: string | undefined;
  let subscriptionId: string | undefined;
  let email: string | undefined;
  if (event.type === "checkout.session.completed") {
    const session = object as StripeCheckoutSession;
    orderId = session.client_reference_id ?? undefined;
    subscriptionId = session.subscription ?? undefined;
    email = session.customer_details?.email ?? undefined;
  } else if (event.type.startsWith("customer.subscription.")) {
    const subscription = object as unknown as StripeSubscription;
    orderId = subscription.metadata?.order_id;
    subscriptionId = subscription.id;
  } else if (event.type.startsWith("invoice.")) {
    const sub = (object as { subscription?: string | null; parent?: { subscription_details?: { subscription?: string } } });
    subscriptionId = sub.subscription ?? sub.parent?.subscription_details?.subscription ?? undefined;
  } else {
    return; // not one we follow
  }
  if (!subscriptionId) return;

  let order = orderId ? await load(orderId) : null;
  if (!order) {
    const row = await (await db()).get<Row>(`select * from storage_orders where stripe_subscription = ?`, [subscriptionId]);
    order = row ? fromRow(row) : null;
  }
  if (!order) return; // a subscription that isn't for storage

  const subscription = await stripe<StripeSubscription>(config.stripeKey, "GET", `subscriptions/${subscriptionId}`);
  await followSubscription(config, order, subscription, email);
}

export async function followSubscription(
  config: SellerConfig,
  order: Order,
  subscription: StripeSubscription,
  email?: string,
): Promise<Order> {
  if (order.status === "deleted") return order;
  const status = statusOf(subscription);
  const quantity = subscription.items.data[0]?.quantity;
  const blocks = Number.isInteger(quantity) && quantity! > 0 ? quantity! : order.blocks;
  const canceling = status === "canceled" && order.status !== "canceled";
  const now = new Date();
  await save(order.id, {
    status,
    blocks,
    stripe_customer: subscription.customer,
    stripe_subscription: subscription.id,
    ...(email && !order.email ? { email } : {}),
    ...(canceling
      ? { canceled_at: now.toISOString(), delete_at: new Date(now.getTime() + config.keepDays * 86_400_000).toISOString() }
      : {}),
    // Resubscribed before deletion: keep everything.
    ...(status !== "canceled" && order.status === "canceled" ? { canceled_at: null, delete_at: null } : {}),
  });
  let current = (await load(order.id))!;
  if (status === "active" && !current.target) current = await provision(config, current);
  // Tell the customer what changed: once per month for a failed payment, once per cancellation.
  if (status === "past_due" && order.status !== "past_due") await notify(current, "payment-failed", now.toISOString().slice(0, 7));
  if (canceling) await notify(current, "canceled", current.deleteAt ?? "");
  return enforce(config, current);
}

/** Makes the bucket, once. A second delivery racing this one skips it. */
async function provision(config: SellerConfig, order: Order): Promise<Order> {
  const now = new Date();
  const stale = new Date(now.getTime() - 5 * 60_000).toISOString();
  const claimed = await (await db()).run(
    `update storage_orders set provisioning_at = ? where id = ? and target is null and (provisioning_at is null or provisioning_at < ?)`,
    [now.toISOString(), order.id, stale],
  );
  if (!claimed) return order;
  try {
    const target = await config.provider().create(order.id);
    await save(order.id, { target: sealTarget(target, order.id), access: "read-write", provisioning_at: null });
    console.info(`[store] order ${order.id}: made bucket ${target.bucket} on ${target.presetId}`);
    return (await load(order.id))!;
  } catch (error) {
    await save(order.id, { provisioning_at: null });
    await alert("provisioning", `Couldn't make the bucket for paid order ${order.id}: ${(error as Error).message}. Stripe will retry the webhook.`);
    throw error;
  }
}

/** Over the quota by more than this, writes stop until something is deleted. */
const QUOTA_SLACK = 1.05;

/** What the key should allow right now. */
export function accessFor(order: Pick<Order, "status" | "blocks" | "usedBytes"> & { suspended?: string | null }): Access {
  if (order.suspended) return "none";
  if (order.status !== "active") return "read-only";
  return order.usedBytes > quotaOf(order.blocks) * QUOTA_SLACK ? "read-only" : "read-write";
}

async function enforce(config: SellerConfig, order: Order): Promise<Order> {
  if (!order.target) return order;
  const wanted = accessFor(order);
  if (order.access === wanted) return order;
  const target = await config.provider().setAccess(order.target, wanted);
  await save(order.id, { target: sealTarget(target, order.id), access: wanted });
  console.info(`[store] order ${order.id}: ${wanted}`);
  return (await load(order.id))!;
}

/* ---- Usage and clean-up ----------------------------------------------------------- */

/** Totals the bucket by listing it (up to 10 million objects). */
export async function measure(config: SellerConfig, order: Order): Promise<Order> {
  // A suspended bucket has no working key to count it with.
  if (!order.target || order.access === "none") return enforce(config, order);
  const stats = await driverFor(order.target).stats("", 10_000);
  await save(order.id, { used_bytes: stats.bytes, measured_at: new Date().toISOString() });
  const measured = (await load(order.id))!;
  await notifyUsage(measured);
  return enforce(config, measured);
}

/** Usage no older than this when a buyer asks. */
const FRESH_MS = 5 * 60_000;

export async function freshOrder(config: SellerConfig, order: Order): Promise<Order> {
  if (!order.target || order.status === "deleted") return order;
  if (order.measuredAt && Date.now() - Date.parse(order.measuredAt) < FRESH_MS) return order;
  return measure(config, order).catch((error: unknown) => {
    console.warn(`[store] couldn't measure order ${order.id}:`, (error as Error).message);
    return order;
  });
}

/**
 * The periodic pass: measure every bucket, enforce quotas, delete what was cancelled long
 * enough ago, and forget checkouts nobody finished.
 */
/** When the last sweep finished, and how many orders it couldn't check — for the admin API. */
export const sweepHealth: { lastAt: string | null; failed: number } = { lastAt: null, failed: 0 };

export async function sweep(config: SellerConfig, now = new Date()): Promise<void> {
  const database = await db();
  const rows = await database.all<Row>(`select * from storage_orders where status <> 'deleted' and status <> 'pending'`);
  const failures: string[] = [];
  for (const row of rows) {
    const order = fromRow(row);
    try {
      if (order.status === "canceled" && order.deleteAt && order.deleteAt <= now.toISOString()) {
        if (order.target) await config.provider().destroy(order.target);
        await save(order.id, { status: "deleted", target: null, access: null, used_bytes: 0 });
        console.info(`[store] order ${order.id}: deleted after cancellation`);
        await notify(order, "deleted");
        continue;
      }
      // A week's warning before a cancelled plan's files go.
      if (order.status === "canceled" && order.deleteAt && Date.parse(order.deleteAt) - now.getTime() <= 7 * 86_400_000) {
        await notify(order, "delete-soon", order.deleteAt);
      }
      await measure(config, order);
    } catch (error) {
      console.warn(`[store] sweep of order ${order.id} failed:`, (error as Error).message);
      failures.push(`${order.id}: ${(error as Error).message}`);
    }
  }
  sweepHealth.lastAt = new Date().toISOString();
  sweepHealth.failed = failures.length;
  if (failures.length) {
    await alert("sweep", `${failures.length} of ${rows.length} orders couldn't be checked (usage, quotas, deletions). First: ${failures[0]}`);
  }
  const abandoned = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  await database.run(`delete from storage_orders where status = 'pending' and target is null and created_at < ?`, [abandoned]);
}

/** What a buyer's server is told about its order. Keys only while the bucket exists. */
export function orderView(order: Order) {
  const suspended = Boolean(order.suspended) && order.status !== "deleted";
  return {
    status: suspended ? ("suspended" as const) : order.status,
    billing: order.billing,
    blocks: order.blocks,
    quotaBytes: quotaOf(order.blocks),
    usedBytes: order.usedBytes,
    measuredAt: order.measuredAt,
    access: order.access,
    deleteAt: order.deleteAt,
    bucket:
      order.target && order.status !== "deleted" && !suspended && order.access !== "none"
        ? {
            presetId: order.target.presetId,
            bucket: order.target.bucket,
            region: order.target.region,
            accessKeyId: order.target.credentials.accessKeyId,
            secretAccessKey: order.target.credentials.secretAccessKey,
          }
        : null,
  };
}

export type OrderView = ReturnType<typeof orderView>;

/* ---- Abuse handling --------------------------------------------------------------- */

/** Orders without their keys, for finding the one behind a bucket or an email. */
export async function listOrders(filter: { query?: string } = {}) {
  const rows = await (await db()).all<Row>(`select * from storage_orders order by created_at desc limit 500`);
  const query = filter.query?.trim().toLowerCase();
  return rows
    .map(fromRow)
    .filter((order) =>
      !query
        ? true
        : [order.id, order.email ?? "", order.target?.bucket ?? "", order.stripeCustomer ?? ""].some((value) => value.toLowerCase().includes(query)),
    )
    .map((order) => ({
      id: order.id,
      status: order.status,
      suspended: order.suspended,
      email: order.email,
      blocks: order.blocks,
      usedBytes: order.usedBytes,
      bucket: order.target ? { presetId: order.target.presetId, name: order.target.bucket, region: order.target.region } : null,
      stripeCustomer: order.stripeCustomer,
      createdAt: order.createdAt,
      deleteAt: order.deleteAt,
    }));
}

/**
 * Suspends an order for breaking the terms: its key stops working at once (nothing can be
 * read, written or shared), the files stay for investigation, and the buyer's jvinu shows
 * why. Billing is left to Stripe; cancel or refund there. `resume` restores access.
 */
export async function setSuspended(config: SellerConfig, id: string, reason: string | null): Promise<Order | null> {
  const order = await load(id);
  if (!order || order.status === "deleted") return null;
  await save(id, { suspended: reason });
  console.warn(`[store] order ${id}: ${reason ? `suspended — ${reason}` : "resumed"}`);
  const changed = await enforce(config, (await load(id))!);
  if (reason) await notify(changed, "suspended", new Date().toISOString().slice(0, 10));
  return changed;
}
