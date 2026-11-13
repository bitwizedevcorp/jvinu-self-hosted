import { authConfig, currentUser } from "@/app/lib/server/auth";

/** Who is signed in, and the CSRF token the page must send with every write. */
export async function GET() {
  const config = authConfig();
  if (config.problems.length) return Response.json({ error: config.problems[0] }, { status: 503 });
  const user = await currentUser();
  if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
  return Response.json(
    { user: { name: user.name, email: user.email, provider: user.provider }, csrf: user.csrf },
    { headers: { "cache-control": "no-store" } },
  );
}
