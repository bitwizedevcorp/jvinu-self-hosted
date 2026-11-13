/**
 * Selling and buying storage, end to end without the network: Stripe and the seller are
 * answered by stubs, the cloud by an in-memory provider, the bucket's driver by a fake.
 * Covers webhook signatures, provisioning once, access following payment and quota,
 * deletion after cancellation, and the buyer's managed "Cloud storage" connection.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Access, ProvisionedBucket, StorageProvider } from "../app/lib/server/store/providers";

const GiB = 1024 ** 3;

// The bucket's usage, as the fake driver reports it; and whether verify() succeeds.
const usage = { bytes: 0 };
vi.mock("../app/lib/server/drivers", () => ({
  driverFor: () => ({
    verify: async () => ({}),
    stats: async () => ({ objects: 1, bytes: usage.bytes, lastModified: null, truncated: false }),
  }),
}));

class MemoryProvider implements StorageProvider {
  readonly presetId = "b2" as const;
  created = 0;
  destroyed: string[] = [];
  access = new Map<string, Access>();
  async create(orderId: string): Promise<ProvisionedBucket> {
    this.created++;
    const bucket = `jvinu-${orderId.slice(0, 12)}`;
    this.access.set(bucket, "read-write");
    return {
      presetId: "b2",
      bucket,
      region: "eu-central-003",
      endpoint: "https://s3.eu-central-003.backblazeb2.com",
      credentials: { kind: "s3", accessKeyId: `003${"a".repeat(21)}`, secretAccessKey: "secret-1" },
      handle: { bucketId: "b1" },
    };
  }
  async setAccess(bucket: ProvisionedBucket, access: Access) {
    this.access.set(bucket.bucket, access);
    // Like B2: a new key for every change, and none at all while suspended.
    if (access === "none") return { ...bucket, credentials: { kind: "s3" as const, accessKeyId: "", secretAccessKey: "" } };
    return { ...bucket, credentials: { kind: "s3" as const, accessKeyId: `003${(access === "read-only" ? "b" : "c").repeat(21)}`, secretAccessKey: "secret-1" } };
  }
  async destroy(bucket: ProvisionedBucket) {
    this.destroyed.push(bucket.bucket);
  }
}

const provider = new MemoryProvider();
const WEBHOOK_SECRET = "whsec_test_0123456789";
const STORE = "https://store.example.com";

// Stripe's side: one checkout session and one subscription whose state the tests set.
const subscription = { id: "sub_1", customer: "cus_1", status: "active", metadata: {} as Record<string, string>, items: { data: [{ quantity: 2 }] } };
const stripeCalls: { path: string; body: string }[] = [];
// Every email the seller sends: to whom, and its subject.
const mails: { to: string; subject: string }[] = [];

beforeAll(() => {
  process.env.JVINU_DATA_DIR = mkdtempSync(path.join(tmpdir(), "jvinu-plan-"));
  process.env.JVINU_SECRET = "storage-plan-test-secret-0123456789abcdef";
  delete process.env.JVINU_DATABASE_URL;
  process.env.JVINU_SELLER_STRIPE_SECRET_KEY = "sk_test_x";
  process.env.JVINU_SELLER_STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.JVINU_STORAGE_STORE_URL = STORE;
  process.env.JVINU_SELLER_ALERT_EMAIL = "ops@example.com";

  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "api.stripe.com") {
      stripeCalls.push({ path: url.pathname, body: String(init.body ?? "") });
      if (url.pathname === "/v1/checkout/sessions") return Response.json({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
      if (url.pathname === "/v1/subscriptions/sub_1") return Response.json(subscription);
      if (url.pathname === "/v1/billing_portal/sessions") return Response.json({ url: "https://billing.stripe.com/p/1" });
      return Response.json({ error: { message: "unexpected" } }, { status: 404 });
    }
    if (url.origin === STORE) {
      // The seller is this same codebase: hand the request to its route handlers.
      const request = new Request(url, init);
      const route =
        url.pathname === "/api/store"
          ? await import("../app/api/store/route")
          : url.pathname === "/api/store/checkout"
            ? await import("../app/api/store/checkout/route")
            : url.pathname === "/api/store/order"
              ? await import("../app/api/store/order/route")
              : await import("../app/api/store/portal/route");
      const handler = (route as Record<string, (request: Request) => Promise<Response>>)[init.method ?? "GET"];
      return handler(request);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const recordMail = async () => {
  const { setMailerForTests } = await import("../app/lib/server/mail");
  setMailerForTests(async (mail) => {
    mails.push({ to: mail.to, subject: mail.subject });
  });
};

const seller = async () => {
  await recordMail();
  const sellerModule = await import("../app/lib/server/store/seller");
  sellerModule.setProviderForTests(provider);
  return sellerModule;
};
const buyer = () => import("../app/lib/server/storage-plan");
const stripe = () => import("../app/lib/server/store/stripe");

async function deliver(event: unknown) {
  const { signWebhook } = await stripe();
  const { POST } = await import("../app/api/store/webhook/route");
  const body = JSON.stringify(event);
  return POST(new Request(`${STORE}/api/store/webhook`, { method: "POST", body, headers: { "stripe-signature": signWebhook(body, WEBHOOK_SECRET) } }));
}

const completed = (orderId: string) => ({
  id: "evt_1",
  type: "checkout.session.completed",
  data: { object: { id: "cs_1", client_reference_id: orderId, subscription: "sub_1", customer: "cus_1", customer_details: { email: "a@example.com" } } },
});
const updated = () => ({ id: "evt_2", type: "customer.subscription.updated", data: { object: subscription } });

describe("webhook signatures", () => {
  it("accepts Stripe's signature and refuses anything else", async () => {
    const { signWebhook, verifyWebhook } = await stripe();
    const body = '{"id":"evt"}';
    const now = Date.now();
    expect(verifyWebhook(body, signWebhook(body, "secret", now), "secret", now)).toBe(true);
    expect(verifyWebhook(body, signWebhook(body, "other", now), "secret", now)).toBe(false);
    expect(verifyWebhook(`${body} `, signWebhook(body, "secret", now), "secret", now)).toBe(false);
    expect(verifyWebhook(body, signWebhook(body, "secret", now - 10 * 60_000), "secret", now)).toBe(false);
    expect(verifyWebhook(body, null, "secret", now)).toBe(false);
  });

  it("refuses an unsigned delivery", async () => {
    await seller();
    const { POST } = await import("../app/api/store/webhook/route");
    const response = await POST(new Request(`${STORE}/api/store/webhook`, { method: "POST", body: "{}", headers: { "stripe-signature": "t=1,v1=00" } }));
    expect(response.status).toBe(400);
  });
});

describe("quota and payment rules", () => {
  it("maps Stripe's states and keeps writes within the quota", async () => {
    const { accessFor, statusOf } = await seller();
    expect(statusOf({ status: "trialing" })).toBe("active");
    expect(statusOf({ status: "unpaid" })).toBe("past_due");
    expect(statusOf({ status: "incomplete_expired" })).toBe("canceled");
    expect(accessFor({ status: "active", blocks: 1, usedBytes: 100 * GiB })).toBe("read-write");
    expect(accessFor({ status: "active", blocks: 1, usedBytes: 106 * GiB })).toBe("read-only");
    expect(accessFor({ status: "past_due", blocks: 1, usedBytes: 0 })).toBe("read-only");
  });
});

describe("buying storage", () => {
  let orderId = "";

  it("starts a checkout at €3 a block, VAT included", async () => {
    const { beginCheckout, planView } = await buyer();
    expect((await planView()).priceCents).toBe(300);
    const url = await beginCheckout(2, "https://jvinu.example.org/dashboard", "a@example.com");
    expect(url).toBe("https://checkout.stripe.com/c/cs_1");
    const body = new URLSearchParams(stripeCalls.find((call) => call.path === "/v1/checkout/sessions")!.body);
    expect(body.get("mode")).toBe("subscription");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("300");
    expect(body.get("line_items[0][price_data][currency]")).toBe("eur");
    expect(body.get("line_items[0][price_data][tax_behavior]")).toBe("inclusive");
    expect(body.get("line_items[0][quantity]")).toBe("2");
    expect(body.get("success_url")).toBe("https://jvinu.example.org/dashboard?storage=paid");
    orderId = body.get("client_reference_id")!;
    subscription.metadata = { order_id: orderId };
    expect((await planView()).status).toBe("pending");
  });

  it("makes one bucket however often Stripe delivers, and connects it", async () => {
    expect((await deliver(completed(orderId))).status).toBe(200);
    expect((await deliver(completed(orderId))).status).toBe(200);
    expect((await deliver(updated())).status).toBe(200);
    expect(provider.created).toBe(1);

    const { syncPlan, planView } = await buyer();
    await syncPlan({ force: true });
    const view = await planView();
    expect(view).toMatchObject({ status: "active", blocks: 2, quotaBytes: 200 * GiB });
    const { findManaged } = await import("../app/lib/server/connections");
    const connection = await findManaged("cloud-storage");
    expect(connection).toMatchObject({
      name: "Cloud storage",
      presetId: "b2",
      region: "eu-central-003",
      // Built here from the region, not taken from the seller.
      endpoint: "https://s3.eu-central-003.backblazeb2.com",
    });
    expect(view.connectionId).toBe(connection!.id);
  });

  it("stops uploads at the quota", async () => {
    const { planBlocks, planDisk, syncPlan } = await buyer();
    usage.bytes = 150 * GiB;
    // The seller measures again when its last count is stale.
    const db = await (await import("../app/lib/server/db")).db();
    await db.run(`update storage_orders set measured_at = null`);
    await syncPlan({ force: true });
    expect(await planBlocks(10 * GiB)).toBeNull();
    expect(await planBlocks(60 * GiB)).toMatch(/200 GB plan/);
    expect(await planDisk()).toMatchObject({ total: 200 * GiB, used: 150 * GiB, level: "ok", blockAt: 1 });
  });

  it("goes read-only when a payment fails, with a new key, and back when it's paid", async () => {
    subscription.status = "past_due";
    expect((await deliver(updated())).status).toBe(200);
    const { planBlocks, syncPlan } = await buyer();
    await syncPlan({ force: true });
    expect(await planBlocks(0)).toMatch(/paused/);
    const { findManaged } = await import("../app/lib/server/connections");
    const key = (await findManaged("cloud-storage"))!.credentials;
    expect(key).toMatchObject({ accessKeyId: `003${"b".repeat(21)}` });

    subscription.status = "active";
    expect((await deliver(updated())).status).toBe(200);
    await syncPlan({ force: true });
    expect(await planBlocks(0)).toBeNull();
    expect((await findManaged("cloud-storage"))!.credentials).toMatchObject({ accessKeyId: `003${"c".repeat(21)}` });
  });

  it("cuts off all access while suspended for abuse, and restores it on resume", async () => {
    const { sellerConfig, setSuspended, orderView } = await seller();
    const { planBlocks, planView, syncPlan } = await buyer();
    const bucket = [...provider.access.keys()][0];

    const suspended = await setSuspended(sellerConfig()!, orderId, "malware reported");
    expect(provider.access.get(bucket)).toBe("none");
    // No key is handed out while suspended.
    expect(orderView(suspended!)).toMatchObject({ status: "suspended", bucket: null });
    await syncPlan({ force: true });
    expect((await planView()).status).toBe("suspended");
    expect(await planBlocks(0)).toMatch(/suspended/);
    const { findManaged } = await import("../app/lib/server/connections");
    expect(await findManaged("cloud-storage")).toBeDefined(); // kept, so it comes back on resume

    await setSuspended(sellerConfig()!, orderId, null);
    expect(provider.access.get(bucket)).toBe("read-write");
    await syncPlan({ force: true });
    expect((await planView()).status).toBe("active");
  });

  it("lets only the seller's admin token suspend, and needs a reason", async () => {
    process.env.JVINU_SELLER_ADMIN_TOKEN = "admin-token-0123456789abcdef0123456789";
    const { POST, GET } = await import("../app/api/store/admin/route");
    const call = (token: string, body?: unknown) =>
      body === undefined
        ? GET(new Request(`${STORE}/api/store/admin?q=${orderId}`, { headers: { authorization: `Bearer ${token}` } }))
        : POST(new Request(`${STORE}/api/store/admin`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
    expect((await call("wrong-token")).status).toBe(401);
    const listed = await (await call(process.env.JVINU_SELLER_ADMIN_TOKEN)).json();
    expect(listed.orders[0]).toMatchObject({ id: orderId });
    expect(JSON.stringify(listed)).not.toContain("secret-1"); // no keys in the listing
    expect((await call(process.env.JVINU_SELLER_ADMIN_TOKEN, { orderId, action: "suspend" })).status).toBe(400);
    delete process.env.JVINU_SELLER_ADMIN_TOKEN;
    expect((await call("anything")).status).toBe(404);
  });

  it("keeps a cancelled plan read-only, then deletes it and the connection", async () => {
    subscription.status = "canceled";
    expect((await deliver({ id: "evt_3", type: "customer.subscription.deleted", data: { object: subscription } })).status).toBe(200);
    const { planBlocks, planView, syncPlan } = await buyer();
    await syncPlan({ force: true });
    expect(await planBlocks(0)).toMatch(/cancelled/);
    const view = await planView();
    expect(view.status).toBe("canceled");
    expect(Date.parse(view.deleteAt!)).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const { sellerConfig, sweep } = await seller();
    // A week before deletion: a warning, once however often the sweep runs.
    await sweep(sellerConfig()!, new Date(Date.now() + 24 * 86_400_000));
    await sweep(sellerConfig()!, new Date(Date.now() + 25 * 86_400_000));
    await sweep(sellerConfig()!, new Date(Date.now() + 31 * 86_400_000));
    expect(provider.destroyed).toHaveLength(1);
    await syncPlan({ force: true });
    const { findManaged } = await import("../app/lib/server/connections");
    expect(await findManaged("cloud-storage")).toBeUndefined();
    expect((await planView()).status).toBe("none");
  });

  it("emailed the customer about each change exactly once", () => {
    const to = (needle: string) => mails.filter((mail) => mail.to === "a@example.com" && mail.subject.includes(needle));
    expect(to("payment didn't go through")).toHaveLength(1);
    expect(to("was suspended")).toHaveLength(1);
    expect(to("was cancelled")).toHaveLength(1);
    expect(to("will be deleted")).toHaveLength(1);
    expect(to("files were deleted")).toHaveLength(1);
  });
});

describe("selling: price floor, yearly billing, alerts", () => {
  const checkout = async (body: unknown) => {
    const { POST } = await import("../app/api/store/checkout/route");
    return POST(new Request(`${STORE}/api/store/checkout`, { method: "POST", body: JSON.stringify(body) }));
  };

  it("refuses plans under the minimum, and bills yearly at the yearly price", async () => {
    await seller();
    process.env.JVINU_SELLER_MIN_BLOCKS = "2";
    process.env.JVINU_SELLER_YEARLY_PRICE_CENTS = "3000";
    const returnUrl = "https://jvinu.example.org/dashboard";
    expect((await checkout({ blocks: 1, returnUrl })).status).toBe(400);
    expect((await checkout({ blocks: 2, returnUrl, billing: "week" })).status).toBe(400);
    stripeCalls.length = 0;
    expect((await checkout({ blocks: 2, returnUrl, billing: "year" })).status).toBe(201);
    const body = new URLSearchParams(stripeCalls.find((call) => call.path === "/v1/checkout/sessions")!.body);
    expect(body.get("line_items[0][price_data][recurring][interval]")).toBe("year");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("3000");
    expect(body.get("line_items[0][quantity]")).toBe("2");
    const { GET } = await import("../app/api/store/route");
    expect(await (await GET()).json()).toMatchObject({ minBlocks: 2, yearlyPriceCents: 3000 });
    delete process.env.JVINU_SELLER_YEARLY_PRICE_CENTS;
    expect((await checkout({ blocks: 2, returnUrl, billing: "year" })).status).toBe(400);
    delete process.env.JVINU_SELLER_MIN_BLOCKS;
  });

  it("alerts the operator when a webhook fails, at most once an hour", async () => {
    await seller();
    const { resetAlerts } = await import("../app/lib/server/store/notify");
    resetAlerts();
    const db = await (await import("../app/lib/server/db")).db();
    const order = await db.get<{ id: string }>(`select id from storage_orders limit 1`);
    // A subscription Stripe doesn't know: processing fails, Stripe would retry.
    const broken = { id: "evt_x", type: "customer.subscription.updated", data: { object: { id: "sub_missing", metadata: { order_id: order!.id } } } };
    expect((await deliver(broken)).status).toBe(500);
    expect((await deliver(broken)).status).toBe(500);
    expect(mails.filter((mail) => mail.to === "ops@example.com" && mail.subject.includes("webhook"))).toHaveLength(1);
  });
});
