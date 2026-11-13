import "server-only";
import * as client from "openid-client";
import type { OidcSettings } from "./auth";

const holder = globalThis as unknown as { __jvinuOidc?: { key: string; config: Promise<client.Configuration> } };

/** Discovery is fetched once per issuer + client and reused. */
export function oidcConfiguration(settings: OidcSettings): Promise<client.Configuration> {
  const key = `${settings.issuer}|${settings.clientId}`;
  if (holder.__jvinuOidc?.key !== key) {
    const issuer = new URL(settings.issuer);
    const local = issuer.protocol === "http:" && ["localhost", "127.0.0.1"].includes(issuer.hostname);
    holder.__jvinuOidc = {
      key,
      config: client
        // Plain http is only tolerated for an issuer on this machine (a local test IdP).
        .discovery(issuer, settings.clientId, settings.clientSecret, undefined, local ? { execute: [client.allowInsecureRequests] } : undefined)
        .catch((error) => {
          holder.__jvinuOidc = undefined;
          throw error;
        }),
    };
  }
  return holder.__jvinuOidc.config;
}

export const redirectUri = (settings: OidcSettings) => `${settings.publicUrl}/api/auth/oidc/callback`;
export { client };
