# Selling storage

jvinu can sell cloud storage to other jvinu servers, in blocks of **100 GB a month**
(€3 per block by default, VAT included). You buy capacity wholesale from Backblaze B2 or
Wasabi. Stripe takes the payments. Each customer gets their own private bucket and a key
that reaches only that bucket.

There are two roles, and one server can play both:

- **The seller** is a jvinu you run on the public internet, with Stripe and a B2 or Wasabi
  account configured. It never stores customers' files itself.
- **A buyer** is any jvinu with `JVINU_STORAGE_STORE_URL` pointing at the seller. Its
  account menu gets **Storage plan**, and once paid a **Cloud storage** connection appears.

## How a purchase works

1. Someone picks a size under **Storage plan → Buy space** and clicks *Continue to payment*.
2. Their jvinu asks the seller to start a checkout. The seller records a pending order and
   creates a Stripe Checkout session (a monthly subscription, one unit per 100 GB). The
   buyer's server keeps a secret token for the order; the person is sent to Stripe.
3. After paying, Stripe sends them back to `/dashboard?storage=paid` and calls the seller's
   webhook. The seller creates the bucket and its key.
4. The buyer's jvinu polls the seller, gets the bucket's key, checks it works, and adds the
   managed **Cloud storage** connection. Nobody can disconnect it from the UI.

Changing size, updating the card, invoices and cancelling all happen on Stripe's billing
portal, opened from **Storage plan → Manage plan**.

## What the seller enforces

| Situation | What happens |
| --- | --- |
| Paid, under quota | Read and write. Buyers refuse uploads that would pass the quota. |
| Over quota by more than 5% | The key becomes read-only until files are deleted. Deleting stays allowed. |
| Payment failed (`past_due`, `unpaid`) | Read-only. Files are kept. Back to read-write once paid. |
| Cancelled | Read-only for `JVINU_SELLER_KEEP_DAYS` (default 30), then the bucket is deleted and the buyer's connection removed. Resubscribing before then keeps everything. |
| Checkout never finished | The pending order is forgotten after two days. |

The seller measures every bucket hourly by listing it, and again when a buyer asks if the
last count is more than five minutes old.

## Setting up the seller

### 1. Stripe

1. In the Stripe dashboard, add a webhook endpoint at `<your public URL>/api/store/webhook`
   with these events: `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
   `invoice.payment_failed`. Copy its signing secret.
2. Recommended: create a Product "Cloud storage — 100 GB" with a **recurring monthly Price
   of €3.00, tax behaviour "inclusive"**, and set `JVINU_SELLER_STRIPE_PRICE` to its id.
   Without it, each checkout builds the same price inline, but then the billing portal
   can't offer size changes.
3. In **Settings → Billing → Customer portal**, allow updating subscription quantities for
   that product, cancelling, and updating payment methods.

### 2. The storage provider

**Backblaze B2** (recommended: no minimum, no minimum storage duration). Create an
application key with access to all buckets and at least these capabilities: `listBuckets`,
`writeBuckets`, `deleteBuckets`, `listKeys`, `writeKeys`, `deleteKeys`, `listFiles`,
`deleteFiles`. Buckets are created with a lifecycle rule that removes deleted files after a
day, so deleting frees space.

**Wasabi.** Create a root-account access key (it needs IAM rights to create users and
policies). Each customer becomes an IAM user with a policy limited to their bucket. Wasabi
bills at least 1 TB per account and charges deleted data for 90 days, so small or
short-lived customers cost more there.

### 3. Settings

```sh
JVINU_PUBLIC_URL=https://store.example.com
JVINU_SELLER_STRIPE_SECRET_KEY=sk_live_…
JVINU_SELLER_STRIPE_WEBHOOK_SECRET=whsec_…
JVINU_SELLER_STRIPE_PRICE=price_…        # recommended, see above
JVINU_SELLER_STRIPE_TAX=1                # optional: Stripe Tax works out each country's VAT
JVINU_SELLER_PRICE_CENTS=300             # what buyers are shown; match your Stripe price

JVINU_SELLER_PROVIDER=b2                 # or wasabi
JVINU_SELLER_B2_KEY_ID=…
JVINU_SELLER_B2_KEY=…
# JVINU_SELLER_WASABI_ACCESS_KEY=…
# JVINU_SELLER_WASABI_SECRET_KEY=…
# JVINU_SELLER_WASABI_REGION=eu-central-2

# JVINU_SELLER_KEEP_DAYS=30
```

Selling turns on only when the Stripe keys and one provider's keys are all set. Bucket keys
are stored encrypted under `JVINU_SECRET`, like every other credential.

## Emails and alerts

With `JVINU_SMTP_URL` and `JVINU_MAIL_FROM` set, customers are emailed — once each — when
their plan is 85% full and when it's full, when a payment fails, when the plan is cancelled
(with the deletion date), a week before the files are deleted, after they're deleted, and
when a plan is suspended. Without email, nobody is warned before deletion: set it up before
selling.

`JVINU_SELLER_ALERT_EMAIL` and/or `JVINU_SELLER_ALERT_WEBHOOK` (Slack, Discord) tell you when
something unattended fails: a Stripe webhook, the hourly check, making a bucket, or a
checkout. At most one alert of each kind an hour; the log has every one. The admin API's
listing also reports when the hourly check last ran and how many orders it couldn't check.

## Price floor and yearly billing

On one €3 block, Stripe's per-invoice fee is roughly a tenth of the price.
`JVINU_SELLER_MIN_BLOCKS=2` makes 200 GB the smallest plan. `JVINU_SELLER_YEARLY_PRICE_CENTS`
(for example `3000`: €30 a year, two months free) adds a Monthly/Yearly choice to the buy
dialog — one fee a year instead of twelve. Create a yearly tax-inclusive Stripe Price for it
and set `JVINU_SELLER_STRIPE_PRICE_YEARLY`, so the billing portal can change its size too.

## Terms and abuse

Templates for the terms of service, privacy policy and data processing agreement, and a
checklist of what to sort out before the first sale (company, VAT/OSS, the 14-day withdrawal
right), are in [legal/](legal/README.md).


Anyone who buys storage can put anything in it, on your Wasabi or B2 account. Before
selling:

- **Publish terms of service** and set `JVINU_SELLER_TERMS_URL` (and the same URL in Stripe →
  Settings → Public details). Buyers then have to tick "I agree" on Stripe's checkout page,
  and the link shows in the buy dialog.
- **Turn on the admin API** with `JVINU_SELLER_ADMIN_TOKEN` (32+ random characters), and keep
  an abuse contact address on your website.

When a bucket is reported (your provider will usually name the bucket), find its order and
suspend it:

```sh
curl -H "Authorization: Bearer $JVINU_SELLER_ADMIN_TOKEN" "https://store.example.com/api/store/admin?q=jvinu-3f2a…"

curl -X POST -H "Authorization: Bearer $JVINU_SELLER_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"orderId":"…","action":"suspend","reason":"malware reported by Backblaze"}' \
  https://store.example.com/api/store/admin
```

A suspended bucket's key stops working at once (on B2 it's deleted; on Wasabi its policy
denies everything), so nothing in it can be read, written or shared. The files stay, for
investigation. The buyer's jvinu shows "suspended". `"action":"resume"` restores access.
Cancel or refund the subscription in Stripe; a cancelled bucket is deleted after
`JVINU_SELLER_KEEP_DAYS` as usual.

## VAT

The price is **VAT-inclusive**: €3.00 is what the customer pays. Selling to consumers in
the EU, VAT is due at the customer's country's rate (17%–27%), usually declared through the
OSS scheme, so what you keep per block varies by country. With `JVINU_SELLER_STRIPE_TAX=1`
Stripe Tax calculates and records it on each invoice, collects billing addresses, and takes
VAT numbers from businesses. Without it, Stripe charges the flat €3.00 and the VAT
accounting is yours. Check the rules that apply to your business with an accountant.

## Setting up a buyer

```sh
JVINU_STORAGE_STORE_URL=https://store.example.com
```

That is all. `JVINU_STORAGE_STORE=off` hides it again. Set `JVINU_PUBLIC_URL` too if the
server sits behind a proxy, so Stripe sends people back to the right address.

## API

The seller's routes need no session. They're meant for buyers' servers, not browsers.

| Route | |
| --- | --- |
| `GET /api/store` | Price per block and limits. |
| `POST /api/store/checkout` | `{ blocks, returnUrl, email? }` → `{ orderId, token, checkoutUrl }`. Rate-limited per address. |
| `GET /api/store/order` | With `Authorization: Bearer <token>`: status, quota, usage, and the bucket's key once paid. |
| `POST /api/store/portal` | With the token and `{ returnUrl }`: a Stripe billing-portal address. |
| `POST /api/store/webhook` | Stripe only; the signature is checked. |
