import "server-only";
import { db } from "../db";
import { sendMail } from "../mail";
import { BLOCK_GB } from "../../storage-plan";
import type { Order } from "./seller";

/**
 * What the storage seller tells people. Customers get an email when their plan fills up,
 * a payment fails, it's cancelled, its deletion is a week away, it's deleted, or it's
 * suspended — each once (recorded on the order). The operator gets alerts when something
 * that runs unattended fails: the Stripe webhook, the hourly sweep, provisioning, checkout.
 */
const sellerName = () => process.env.JVINU_SELLER_NAME?.trim() || "Cloud storage";
const GB = 1024 ** 3;
const gb = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const MANAGE = "Manage it in jvinu: account menu → Storage plan → Manage plan.";

export type NoticeKind = "quota-85" | "quota-full" | "payment-failed" | "canceled" | "delete-soon" | "deleted" | "suspended";

function compose(kind: NoticeKind, order: Order): { subject: string; text: string } {
  const quota = order.blocks * BLOCK_GB * GB;
  const name = sellerName();
  switch (kind) {
    case "quota-85":
      return {
        subject: `${name}: your plan is 85% full`,
        text: `Your ${order.blocks * BLOCK_GB} GB plan holds ${gb(order.usedBytes)}. Uploads stop when it's full.\n\nAdd space, or delete what you don't need. ${MANAGE}`,
      };
    case "quota-full":
      return {
        subject: `${name}: your plan is full`,
        text: `Your ${order.blocks * BLOCK_GB} GB plan holds ${gb(order.usedBytes)} of ${gb(quota)}, so uploads have stopped. Your files are safe and can still be opened and deleted.\n\nAdd space to keep uploading. ${MANAGE}`,
      };
    case "payment-failed":
      return {
        subject: `${name}: a payment didn't go through`,
        text: `The last payment for your storage plan failed, so it's read-only for now: your files are safe, but nothing new can be added.\n\nUpdate the card to carry on. ${MANAGE}`,
      };
    case "canceled":
      return {
        subject: `${name}: your plan was cancelled`,
        text: `Your storage plan has ended and is read-only.${order.deleteAt ? ` Its files will be deleted on ${day(order.deleteAt)}.` : ""}\n\nDownload what you want to keep before then, or resubscribe to keep everything. ${MANAGE}`,
      };
    case "delete-soon":
      return {
        subject: `${name}: your files will be deleted on ${order.deleteAt ? day(order.deleteAt) : "soon"}`,
        text: `Your cancelled plan's files (${gb(order.usedBytes)}) will be deleted for good on ${order.deleteAt ? day(order.deleteAt) : "the date shown in jvinu"}. This can't be undone.\n\nDownload what you want to keep, or resubscribe to keep everything. ${MANAGE}`,
      };
    case "deleted":
      return {
        subject: `${name}: your files were deleted`,
        text: `As announced, the files of your cancelled storage plan have been deleted. Thank you for using ${name}.`,
      };
    case "suspended":
      return {
        subject: `${name}: your plan was suspended`,
        text: `Your storage plan has been suspended${order.suspended ? `: ${order.suspended}` : ""}. Its files can't be opened, added or shared until this is resolved; they haven't been deleted.\n\nReply to this email to sort it out.`,
      };
  }
}

/**
 * Sends a notice once per `scope` (a plan size, a month…), and records it. Nothing is
 * recorded when it couldn't be sent, so the next pass tries again.
 */
export async function notify(order: Order, kind: NoticeKind, scope = ""): Promise<void> {
  if (!order.email) return;
  const key = scope ? `${kind}:${scope}` : kind;
  const database = await db();
  const row = await database.get<{ notices: string }>(`select notices from storage_orders where id = ?`, [order.id]);
  let sent: string[] = [];
  try {
    sent = JSON.parse(row?.notices ?? "[]");
  } catch {
    sent = [];
  }
  if (sent.includes(key)) return;
  if (!(await sendMail({ to: order.email, ...compose(kind, order) }))) return;
  await database.run(`update storage_orders set notices = ? where id = ?`, [JSON.stringify([...sent, key].slice(-100)), order.id]);
}

/** Checks the plan against its quota and warns at 85% and 100%, once per plan size. */
export async function notifyUsage(order: Order): Promise<void> {
  if (order.status !== "active" || order.suspended) return;
  const quota = order.blocks * BLOCK_GB * GB;
  if (order.usedBytes >= quota) await notify(order, "quota-full", String(order.blocks));
  else if (order.usedBytes >= quota * 0.85) await notify(order, "quota-85", String(order.blocks));
}

/* ---- Operator alerts -------------------------------------------------------------------- */

const lastAlert = new Map<string, number>();
const ALERT_EVERY_MS = 60 * 60_000;

/**
 * Tells the operator something unattended failed: by email (JVINU_SELLER_ALERT_EMAIL) and/or
 * a chat webhook (JVINU_SELLER_ALERT_WEBHOOK — Slack, Discord, or anything taking JSON).
 * At most one alert of each kind an hour; the server's log has every one.
 */
export async function alert(kind: string, message: string): Promise<void> {
  console.error(`[store] ALERT ${kind}: ${message}`);
  const now = Date.now();
  if (now - (lastAlert.get(kind) ?? 0) < ALERT_EVERY_MS) return;
  lastAlert.set(kind, now);
  const text = `${sellerName()} — ${kind}: ${message}`;
  const email = process.env.JVINU_SELLER_ALERT_EMAIL?.trim();
  if (email) await sendMail({ to: email, subject: `[alert] ${sellerName()}: ${kind}`, text: `${message}\n\nMore in the server's log.` });
  const hook = process.env.JVINU_SELLER_ALERT_WEBHOOK?.trim();
  if (hook && /^https:\/\//.test(hook)) {
    // "text" for Slack and most others, "content" for Discord.
    await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text.slice(0, 1900) }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    }).catch((error: unknown) => console.error("[store] alert webhook failed:", (error as Error).message));
  }
}

/** For tests: forget when alerts were last sent. */
export function resetAlerts() {
  lastAlert.clear();
}
