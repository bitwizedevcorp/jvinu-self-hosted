import { destroySession, sameOrigin } from "@/app/lib/server/auth";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin request refused." }, { status: 403 });
  await destroySession();
  return new Response(null, { status: 204 });
}
