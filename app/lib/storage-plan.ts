/**
 * Paid cloud storage, sold in blocks of 100 GB a month. Shared by the seller service,
 * the server that buys, and the browser. See docs/sell-storage.md.
 */

/** One block, as the meter shows it (binary GB, like the rest of the app). */
export const BLOCK_GB = 100;
export const BLOCK_BYTES = BLOCK_GB * 1024 ** 3;
export const MAX_BLOCKS = 100;

/** The list price of one block per month, VAT included, in euro cents. */
export const DEFAULT_BLOCK_PRICE_CENTS = 300;

/**
 * Where an order stands, as the seller reports it.
 * - pending: checkout started, not paid yet
 * - active: paid; files can be added up to the quota
 * - past_due: a payment failed; files can be read and deleted, not added
 * - canceled: the subscription ended; read-only until it's deleted
 * - deleted: the bucket is gone
 * - suspended: the seller cut off access for breaking its terms; files are kept meanwhile
 */
export type PlanStatus = "pending" | "active" | "past_due" | "canceled" | "deleted" | "suspended";

/** What the browser sees about this server's plan. */
export type PlanView = {
  /** This server can buy storage (a store URL is configured). */
  available: boolean;
  priceCents: number;
  currency: "EUR";
  /** The seller's terms of service, accepted at checkout. */
  termsUrl: string | null;
  /** The smallest plan sold, in blocks. */
  minBlocks: number;
  /** Price of one block for a year, VAT included, when the seller offers yearly billing. */
  yearlyPriceCents: number | null;
  /** How the current plan is billed. */
  billing: Billing;
  status: PlanStatus | "none";
  blocks: number;
  quotaBytes: number;
  usedBytes: number;
  /** When the bucket is deleted after a cancellation, if one is scheduled. */
  deleteAt: string | null;
  connectionId: string | null;
};

/** "€3.00" — prices are shown VAT included. */
export const formatEur = (cents: number) =>
  (cents / 100).toLocaleString("en-IE", { style: "currency", currency: "EUR", minimumFractionDigits: 2 });

export const quotaOf = (blocks: number) => blocks * BLOCK_BYTES;

export type Billing = "month" | "year";
export const isBilling = (value: unknown): value is Billing => value === "month" || value === "year";

export const validBlocks = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_BLOCKS;
