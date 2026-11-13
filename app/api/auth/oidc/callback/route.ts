import { cookies } from "next/headers";
import { authConfig, createSession, emailAllowed, isHttps } from "@/app/lib/server/auth";
import { client, oidcConfiguration, redirectUri } from "@/app/lib/server/oidc";
import { unseal } from "@/app/lib/server/vault";

const OIDC_FLOW_COOKIE = "jvinu_oidc";

export async function GET(request: Request) {
  const { oidc } = authConfig();
  const fail = (code: string) => Response.redirect(new URL(`/login?error=${code}`, oidc?.publicUrl ?? request.url), 303);
  if (!oidc) return fail("oidc-disabled");

  const store = await cookies();
  const flow = unseal<{ verifier: string; state: string; nonce: string; at: number }>(store.get(OIDC_FLOW_COOKIE)?.value ?? "");
  store.delete(OIDC_FLOW_COOKIE);
  if (!flow || Date.now() - flow.at > 600_000) return fail("oidc-expired");

  try {
    const config = await oidcConfiguration(oidc);
    // Validate against the URL the IdP was told to call, not whatever host we're behind.
    const callback = new URL(redirectUri(oidc));
    callback.search = new URL(request.url).search;
    const tokens = await client.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) return fail("oidc-failed");
    const email = typeof claims.email === "string" ? claims.email : undefined;
    // An allowlisted email only counts if the IdP says it verified it: a missing claim counts
    // as unverified. Providers that never send it (Microsoft Entra) need
    // JVINU_OIDC_TRUST_UNVERIFIED_EMAIL=1. Checked on every sign-in, even though authConfig
    // already refuses an empty list without JVINU_OIDC_ALLOW_ANY.
    const verified = claims.email_verified === true || process.env.JVINU_OIDC_TRUST_UNVERIFIED_EMAIL === "1";
    if (!oidc.allowAny && (!verified || !emailAllowed(email, oidc.allowed))) {
      return fail("not-allowed");
    }
    const name = (typeof claims.name === "string" && claims.name) || email || String(claims.sub);
    await createSession({ id: `oidc:${claims.sub}`, name, email, provider: "oidc" }, isHttps(request));
    return Response.redirect(new URL("/dashboard", oidc.publicUrl), 303);
  } catch (error) {
    console.error("[oidc] callback failed", error);
    return fail("oidc-failed");
  }
}
