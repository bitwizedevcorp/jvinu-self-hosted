import { cookies } from "next/headers";
import { authConfig, isHttps } from "@/app/lib/server/auth";
import { client, oidcConfiguration, redirectUri } from "@/app/lib/server/oidc";
import { seal } from "@/app/lib/server/vault";

const OIDC_FLOW_COOKIE = "jvinu_oidc";

/** Starts authorization-code + PKCE. state, nonce and verifier ride in a sealed cookie. */
export async function GET(request: Request) {
  const { oidc } = authConfig();
  if (!oidc) return Response.redirect(new URL("/login?error=oidc-disabled", request.url), 303);
  try {
    const config = await oidcConfiguration(oidc);
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(oidc),
      scope: "openid email profile",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    (await cookies()).set(OIDC_FLOW_COOKIE, seal({ verifier, state, nonce, at: Date.now() }), {
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps(request),
      path: "/api/auth/oidc",
      maxAge: 600,
    });
    return Response.redirect(url.href, 303);
  } catch (error) {
    console.error("[oidc] discovery failed", error);
    return Response.redirect(new URL("/login?error=oidc-unreachable", request.url), 303);
  }
}
