import "server-only";
import { handle, fail } from "./http";
import { PlanError } from "./storage-plan";

/** Where the person comes back to after paying or managing billing. */
export function dashboardUrl(request: Request): string {
  const configured = (process.env.JVINU_PUBLIC_URL ?? "").replace(/\/+$/, "");
  if (/^https?:\/\//.test(configured)) return `${configured}/dashboard`;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  const proto = (request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "")).split(",")[0].trim();
  return `${proto}://${host}/dashboard`;
}

export function planFailure(error: unknown) {
  if (error instanceof PlanError) return fail(error.message, error.status === 410 ? 502 : error.status);
  return handle(error);
}
