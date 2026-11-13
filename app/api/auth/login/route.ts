import {
  authConfig,
  clearFailures,
  createSession,
  isHttps,
  recordFailure,
  sameOrigin,
  throttled,
  rememberDevice,
  throttleKey,
} from "@/app/lib/server/auth";
import { StorageUserError } from "@/app/lib/server/drivers/types";
import { ADMIN_ID, adminName, adminPasswordMatches, passwordMode } from "@/app/lib/server/first-run";
import { fail, readJson } from "@/app/lib/server/http";
import { checkSecondFactor, twoFactorEnabled } from "@/app/lib/server/two-factor";

/** Single-user sign-in: JVINU_ADMIN_PASSWORD, or the password chosen at the first sign-in. */
export async function POST(request: Request) {
  const config = authConfig();
  if (config.problems.length) return Response.json({ error: config.problems[0] }, { status: 503 });
  const mode = await passwordMode();
  if (mode === "setup") return Response.json({ error: "Choose a password first: reload the page." }, { status: 409 });
  if (mode === "off") return Response.json({ error: "Password sign-in isn't enabled on this server." }, { status: 400 });
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin request refused." }, { status: 403 });

  const address = await throttleKey(request);
  if (throttled(address)) {
    return Response.json({ error: "Too many attempts. Wait 15 minutes and try again." }, { status: 429 });
  }

  let password = "";
  let code = "";
  try {
    // Anyone can reach this: the body is read only up to a small limit.
    const body = await readJson<{ password?: unknown; code?: unknown }>(request);
    password = String(body.password ?? "");
    code = typeof body.code === "string" ? body.code.slice(0, 32) : "";
  } catch (error) {
    if (error instanceof StorageUserError) return fail(error.message, error.status);
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  // With two-step sign-in on, the password and the code are judged together, and a wrong
  // one of either gets the same answer: nothing says which was right. The code is only
  // checked (and spent) when the password matches.
  const twoStep = await twoFactorEnabled();
  const passwordOk = await adminPasswordMatches(password);
  if (!passwordOk || !(await checkSecondFactor(code))) {
    recordFailure(address);
    // A fixed delay so failures can't be told apart by timing, and guessing stays slow.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return Response.json({ error: twoStep ? "That password or code isn't right." : "That password isn't right." }, { status: 401 });
  }

  clearFailures(address);
  await createSession({ id: ADMIN_ID, name: await adminName(), provider: "password" }, isHttps(request));
  await rememberDevice(isHttps(request));
  return Response.json({ ok: true });
}
