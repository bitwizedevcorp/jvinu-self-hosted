import { requireUser } from "@/app/lib/server/auth";
import { oneDriveTenant, startOneDriveSignIn } from "@/app/lib/server/drivers/onedrive";
import { fail, handle, readJson, tooLarge } from "@/app/lib/server/http";
import { sealSignIn } from "@/app/lib/server/onedrive-sign-in";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Starts a OneDrive connection: asks Microsoft for a device code, and returns the short
 * code the user types at microsoft.com plus a sealed handle to send back with Connect.
 */
export async function POST(request: Request) {
  const user = await requireUser(request, { mutating: true, admin: true });
  if (user instanceof Response) return user;

  let body: { clientId?: unknown; tenant?: unknown };
  try {
    body = await readJson(request, 16 * 1024);
  } catch (error) {
    if (tooLarge(error)) return fail("That request is too large.", 413);
    return fail("Expected a JSON body.", 400);
  }
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const tenant = oneDriveTenant(typeof body.tenant === "string" ? body.tenant : "");
  if (!GUID.test(clientId)) return fail("The application (client) ID is a GUID, like 11111111-2222-3333-4444-555555555555.", 400);
  if (!tenant) return fail("The tenant is “common”, “consumers”, “organizations”, or a tenant ID or domain.", 400);

  try {
    const signIn = await startOneDriveSignIn({ clientId, tenant });
    return Response.json(
      {
        userCode: signIn.userCode,
        // Opened in the user's browser: only ever an https page.
        verificationUri: /^https:\/\//.test(signIn.verificationUri) ? signIn.verificationUri : "https://microsoft.com/devicelogin",
        expiresIn: signIn.expiresIn,
        handle: sealSignIn({ deviceCode: signIn.deviceCode, clientId, tenant, expires: Date.now() + signIn.expiresIn * 1000 }, user.id),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return handle(error);
  }
}
