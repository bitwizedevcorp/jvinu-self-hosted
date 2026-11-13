import { requireUser, throttleKey, throttled, recordFailure, clearFailures } from "@/app/lib/server/auth";
import { ADMIN_ID } from "@/app/lib/server/first-run";
import { fail, readJson, tooLarge } from "@/app/lib/server/http";
import {
  checkSecondFactor,
  confirmSetup,
  disableTwoFactor,
  recoveryCodesLeft,
  startSetup,
  twoFactorEnabled,
} from "@/app/lib/server/two-factor";

/** Two-step sign-in for the admin-password account: its state, setting it up, turning it off. */
async function adminOnly(request: Request, mutating: boolean) {
  const user = await requireUser(request, { mutating });
  if (user instanceof Response) return user;
  if (user.provider !== "password" || user.id !== ADMIN_ID) {
    return fail("Two-step sign-in here is for the admin password. Single sign-on accounts set it up with their provider.", 403);
  }
  return user;
}

export async function GET(request: Request) {
  const user = await adminOnly(request, false);
  if (user instanceof Response) return user;
  return Response.json({ enabled: await twoFactorEnabled(), recoveryCodesLeft: await recoveryCodesLeft() });
}

/**
 * { action: "start" } → a new secret and its otpauth:// address (for the QR code).
 * { action: "confirm", code } → turns it on; answers with the recovery codes, once.
 * { action: "disable", code } → turns it off; needs a current code or a recovery code.
 */
export async function POST(request: Request) {
  const user = await adminOnly(request, true);
  if (user instanceof Response) return user;
  let body: { action?: unknown; code?: unknown };
  try {
    body = await readJson(request, 4 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return fail("Expected a JSON body.", 400);
  }
  const code = typeof body.code === "string" ? body.code.slice(0, 32) : "";
  // Wrong codes count against the same limit as wrong passwords.
  const key = await throttleKey(request);
  if (throttled(key)) return fail("Too many attempts. Wait 15 minutes and try again.", 429);

  switch (body.action) {
    case "start":
      if (await twoFactorEnabled()) return fail("Two-step sign-in is already on. Turn it off first to move it to another app.", 409);
      return Response.json(await startSetup(user.name));
    case "confirm": {
      const recovery = await confirmSetup(code);
      if (!recovery) {
        recordFailure(key);
        return fail("That code doesn't match. Check the phone's clock, or start again if it's been over 15 minutes.", 400);
      }
      clearFailures(key);
      console.log("[auth] Two-step sign-in was turned on for the admin password.");
      return Response.json({ recoveryCodes: recovery });
    }
    case "disable":
      if (!(await twoFactorEnabled())) return Response.json({ ok: true });
      if (!(await checkSecondFactor(code))) {
        recordFailure(key);
        return fail("That code isn't right. Use a current code from the app, or a recovery code.", 400);
      }
      clearFailures(key);
      await disableTwoFactor();
      console.log("[auth] Two-step sign-in was turned off for the admin password.");
      return Response.json({ ok: true });
    default:
      return fail("The action is start, confirm or disable.", 400);
  }
}
