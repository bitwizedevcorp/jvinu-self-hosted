import { readJson, tooLarge, fail } from "@/app/lib/server/http";
import { clearFailures, endOtherSessions, recordFailure, requireUser, throttled, throttleKey } from "@/app/lib/server/auth";
import { ADMIN_ID, changeAdminPassword, passwordProblem } from "@/app/lib/server/first-run";

/**
 * POST { current, password } — changes the admin password chosen in the browser. Every other
 * session is signed out; this one stays. A password set by JVINU_ADMIN_PASSWORD is changed
 * in the environment instead.
 */
export async function POST(request: Request) {
  const user = await requireUser(request, { mutating: true });
  if (user instanceof Response) return user;
  if (user.provider !== "password" || user.id !== ADMIN_ID) {
    return Response.json({ error: "Your password is kept by your sign-in provider, not by jvinu." }, { status: 403 });
  }

  // Wrong current passwords count against the same limit as wrong sign-ins.
  const address = await throttleKey(request);
  if (throttled(address)) {
    return Response.json({ error: "Too many attempts. Wait 15 minutes and try again." }, { status: 429 });
  }

  let body: { current?: unknown; password?: unknown };
  try {
    body = await readJson(request, 16 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const current = typeof body.current === "string" ? body.current : "";
  const password = typeof body.password === "string" ? body.password : "";
  const problem = passwordProblem(password);
  if (problem) return Response.json({ error: problem.message, field: "password" }, { status: 400 });
  if (password === current) return Response.json({ error: "That's the password you have now.", field: "password" }, { status: 400 });

  switch (await changeAdminPassword(current, password)) {
    case "env":
      return Response.json(
        { error: "This server's password is set by JVINU_ADMIN_PASSWORD: change it there, then restart jvinu." },
        { status: 409 },
      );
    case "none":
      return Response.json({ error: "This server has no password to change." }, { status: 409 });
    case "wrong":
      recordFailure(address);
      // The same pause as a wrong sign-in, so guessing stays slow.
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Not 401: that would read as "signed out" to the page.
      return Response.json({ error: "That isn't your current password.", field: "current" }, { status: 400 });
  }

  clearFailures(address);
  const signedOut = await endOtherSessions(user.id);
  console.log(`[auth] The admin password was changed; ${signedOut} other session(s) signed out.`);
  return Response.json({ ok: true, signedOut });
}
