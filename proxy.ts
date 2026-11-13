import { NextResponse, type NextRequest } from "next/server";

/**
 * Every page gets a Content Security Policy whose scripts must carry a nonce made fresh for
 * that request: an injected inline script can't run, because it can't know the nonce.
 * Next adds the nonce to its own scripts; the layout adds it to the theme script.
 *
 * Also an optimistic gate for the app's pages: no session cookie → straight to /login. The
 * real check — is the session valid, is the request allowed — happens in every page and route.
 */
const APP_PAGES = new Set(["/", "/dashboard"]);

function policy(nonce: string, sharePage: boolean): string {
  const dev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    // 'strict-dynamic': scripts Next's own (nonced) scripts load are trusted too; nothing else is.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' blob: https: http:",
    "frame-src 'self'",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    // A share page's Download form may be answered with a redirect to the provider's link.
    sharePage ? "form-action 'self' https: http:" : "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (APP_PAGES.has(pathname) || pathname.startsWith("/dashboard/")) {
    if (!request.cookies.has("jvinu_session")) return NextResponse.redirect(new URL("/login", request.url));
  }

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64");
  const csp = policy(nonce, pathname.startsWith("/s/"));
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  // Pages only. API routes authenticate themselves, set their own headers, and a request that
  // passes through Proxy has its body capped (10 MB by default), which would truncate uploads.
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|robots.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
