import { clientAddress, createSession, DEMO_USER, demoMode, isHttps, sameOrigin } from "@/app/lib/server/auth";
import { take } from "@/app/lib/server/rate-limit";

/** JVINU_DEMO=1 only: enter the public demo as its one shared, read-only visitor. */
export async function POST(request: Request) {
  if (!demoMode()) return Response.json({ error: "This server has no demo." }, { status: 404 });
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin request refused." }, { status: 403 });
  const limited = take(`demo:${clientAddress(request)}`, 20, 60_000);
  if (!limited.ok) return Response.json({ error: `Too many tries — wait ${limited.retryAfter} s.` }, { status: 429 });
  await createSession(DEMO_USER, isHttps(request));
  return Response.json({ ok: true });
}
