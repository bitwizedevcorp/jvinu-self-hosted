import { StorageUserError } from "@/app/lib/server/drivers/types";
import { handle, readForm } from "@/app/lib/server/http";
import type { Refusal } from "@/app/lib/server/share-access";
import { redeemLink } from "@/app/lib/server/share-redeem";
import { attachmentResponse } from "@/app/lib/server/share-serve";

/**
 * A shared file's bytes. The recipient's page posts here (with the password, if the link
 * has one); scripts can GET it: curl -L https://…/s/<token>/download. Each answer counts
 * as one download — a short redirect to the provider's own signed link, or the bytes
 * streamed through this app.
 */

export async function GET(request: Request, ctx: RouteContext<"/s/[token]/download">) {
  return download(request, (await ctx.params).token, null);
}

export async function POST(request: Request, ctx: RouteContext<"/s/[token]/download">) {
  // Anyone can post here: the form is read only up to a small limit.
  let form: FormData | null = null;
  try {
    form = await readForm(request);
  } catch (error) {
    if (error instanceof StorageUserError && error.status === 413) return Response.json({ error: error.message }, { status: 413 });
  }
  const password = form?.get("password");
  return download(request, (await ctx.params).token, typeof password === "string" ? password : "");
}

/** Link checkers and previews ask with HEAD: answering it must not use up a download. */
export function HEAD() {
  return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
}

async function download(request: Request, token: string, password: string | null): Promise<Response> {
  // The page's form wants to land back on the page with a message; scripts want a status.
  const fromPage = request.method === "POST" && (request.headers.get("accept") ?? "").includes("text/html");
  const refuse = (why: Refusal) => {
    const headers = new Headers({ "cache-control": "no-store" });
    if (why.retryAfter) headers.set("retry-after", String(why.retryAfter));
    if (!fromPage) return Response.json({ error: why.message }, { status: why.status, headers });
    headers.set("location", `/s/${encodeURIComponent(token)}?e=${why.code}${why.retryAfter ? `&wait=${why.retryAfter}` : ""}`);
    return new Response(null, { status: 303, headers });
  };

  try {
    const redeemed = await redeemLink(token, password, request.headers);
    if ("refused" in redeemed) return refuse(redeemed.refused);
    const { link, delivery } = redeemed;
    if (delivery.kind === "redirect") {
      return new Response(null, {
        status: request.method === "POST" ? 303 : 302,
        headers: { location: delivery.url, "cache-control": "no-store", "referrer-policy": "no-referrer" },
      });
    }
    return attachmentResponse(delivery.object, link.meta.name);
  } catch (error) {
    return handle(error);
  }
}
