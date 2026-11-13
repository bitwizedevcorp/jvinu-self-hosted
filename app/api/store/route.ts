import { fail } from "@/app/lib/server/http";
import { sellerConfig } from "@/app/lib/server/store/seller";
import { BLOCK_GB, MAX_BLOCKS } from "@/app/lib/storage-plan";

/** The storage this server sells, and its price (VAT included). Public. */
export async function GET() {
  const config = sellerConfig();
  if (!config) return fail("This server doesn't sell storage.", 404);
  return Response.json({ priceCents: config.priceCents, currency: "EUR", blockGb: BLOCK_GB, maxBlocks: MAX_BLOCKS, termsUrl: config.termsUrl,
    minBlocks: config.minBlocks,
    yearlyPriceCents: config.yearlyPriceCents,
  });
}
