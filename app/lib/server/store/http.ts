import "server-only";
import { orderForToken, type Order } from "./seller";

/** Where a buyer may be sent back to: an https page, or http on localhost for development. */
export function cleanReturnUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** The order named by "Authorization: Bearer <token>", or null. */
export async function bearerOrder(request: Request): Promise<Order | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token ? orderForToken(token) : null;
}
