import { authConfig, clearFailures, createSession, isHttps, recordFailure, sameOrigin, throttled, rememberDevice, throttleKey } from "@/app/lib/server/auth";
import { StorageUserError } from "@/app/lib/server/drivers/types";
import { ADMIN_ID, passwordMode, passwordProblem, setAdminPassword, setupCodeMatches } from "@/app/lib/server/first-run";
import { fail, readJson } from "@/app/lib/server/http";

/**
 * The first sign-in on a server with no password: { code, password, name? } keeps the
 * password (its hash) and signs in. `code` is the one-time setup code from the server's log.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin request refused." }, { status: 403 });
  const config = authConfig();
  if (config.problems.length) return Response.json({ error: config.problems[0] }, { status: 503 });
  if ((await passwordMode()) !== "setup") {
    return Response.json({ error: "This server already has a password. Reload the page to sign in." }, { status: 409 });
  }

  // Wrong setup codes count against the same limit as wrong passwords.
  const address = await throttleKey(request);
  if (throttled(address)) {
    return Response.json({ error: "Too many attempts. Wait 15 minutes and try again." }, { status: 429 });
  }

  let body: { code?: unknown; password?: unknown; name?: unknown };
  try {
    // Anyone can reach this: the body is read only up to a small limit.
    body = (await readJson<typeof body | null>(request)) ?? {};
  } catch (error) {
    if (error instanceof StorageUserError) return fail(error.message, error.status);
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const code = typeof body.code === "string" ? body.code : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!setupCodeMatches(code)) {
    recordFailure(address);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return Response.json(
      { error: "That setup code isn't right. Check the server's log: each start prints a new one.", field: "code" },
      { status: 401 },
    );
  }
  const problem = passwordProblem(password, name);
  if (problem) return Response.json({ error: problem.message, field: problem.field }, { status: 400 });

  if (!(await setAdminPassword(password, name))) {
    return Response.json({ error: "A password was set a moment ago. Reload the page to sign in." }, { status: 409 });
  }
  clearFailures(address);
  console.log("[auth] The admin password was chosen in the browser; sign-in now asks for it.");
  await createSession({ id: ADMIN_ID, name: name || "Admin", provider: "password" }, isHttps(request));
  await rememberDevice(isHttps(request));
  return Response.json({ ok: true }, { status: 201 });
}
