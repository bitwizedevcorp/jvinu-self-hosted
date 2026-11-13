import { guardConnection } from "@/app/lib/server/guard";
import { handle } from "@/app/lib/server/http";
import { xrayFor } from "@/app/lib/server/xray";
import { renderXrayPdf } from "@/app/lib/server/xray/pdf";

/** The X-Ray report as a PDF to share: the same scan the page shows, file names only. */
export async function GET(request: Request, ctx: RouteContext<"/api/connections/[id]/xray/report">) {
  const guarded = await guardConnection(request, ctx.params);
  if (guarded instanceof Response) return guarded;
  try {
    const report = await xrayFor(guarded.connection);
    const pdf = renderXrayPdf(report);
    const name = `jvinu-xray-${guarded.connection.bucket.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "bucket"}-${report.scannedAt.slice(0, 10)}.pdf`;
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return handle(error);
  }
}
