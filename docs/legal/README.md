# Legal paperwork for selling storage

> **These are templates, not legal advice.** They're written for a small EU business selling
> storage to consumers and companies, and they need checking by a lawyer in your country
> before you publish them. Replace every `[BRACKETED]` placeholder.

| File | What it is | Where it goes |
| --- | --- | --- |
| [terms-of-service.md](terms-of-service.md) | The contract with each customer | Your website; its URL in `JVINU_SELLER_TERMS_URL` and in Stripe → Settings → Public details |
| [privacy-policy.md](privacy-policy.md) | What personal data you hold and why (GDPR art. 13) | Your website; linked from the terms and Stripe |
| [data-processing-agreement.md](data-processing-agreement.md) | GDPR art. 28 contract for business customers whose files hold personal data | Offered to business customers; referenced from the terms |

## Before the first sale

1. **A business to sell through.** In Romania, for example, a PFA or an SRL, registered with
   ONRC. Selling without one isn't allowed.
2. **VAT.** Register for VAT if your turnover requires it or you choose to. For storage sold
   to consumers in other EU countries, VAT is due at *their* country's rate once you pass
   €10,000 a year of such sales; declare it through the **OSS (One-Stop Shop)** scheme. Turn
   on `JVINU_SELLER_STRIPE_TAX=1` so Stripe Tax works out the rate per customer and puts it on
   each invoice. The €3 price stays VAT-inclusive, so your net per block varies by country.
3. **Invoices.** Stripe issues them; check they carry what your country requires (in Romania,
   e-Factura applies to B2B invoices).
4. **The right of withdrawal (consumers).** EU consumers may cancel a distance contract within
   14 days. For a service that starts at once, they lose that right only if they **asked for
   it to start straight away and acknowledged** it. The terms below say so; also add that
   sentence next to the checkout button or in Stripe's custom checkout text.
5. **Consumer-protection links.** Romanian online shops must show links to ANPC's SAL
   (alternative dispute resolution) and to the EU's ODR platform. Put them in your website's
   footer.
6. **Where the data lives.** Pick an EU region for the buckets (B2 `eu-central-003`, Wasabi
   `eu-central-1`/`-2`), so customers' files never leave the EU. Sign the providers' own data
   processing agreements (Backblaze and Wasabi both offer one) and Stripe's.
7. **An abuse contact.** An email address on your website for reports, read daily, and the
   suspension steps in [../sell-storage.md](../sell-storage.md#terms-and-abuse).
8. **Records of processing.** GDPR art. 30: a short internal list of what you process, why,
   for how long, and with whom. The privacy policy's tables are most of it.
