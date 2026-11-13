import type { NextConfig } from "next";
const dev = process.env.NODE_ENV !== "production";

/**
 * The policy for API answers. Pages get theirs from proxy.ts instead, with a fresh script
 * nonce per request. Previews load straight from storage providers (https) and local
 * emulators (http), so images may come from anywhere; scripts and requests stay same-origin.
 */
const csp = [
  "default-src 'self'",
  // Next's hydration needs inline scripts; dev's hot reload also needs eval.
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  // Video and audio previews play from signed URLs (https) or local emulators (http).
  "media-src 'self' blob: https: http:",
  // PDF previews: this app's own object route, framed by its own pages only.
  "frame-src 'self'",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // A self-contained server bundle for the Docker image.
  output: "standalone",
  poweredByHeader: false,
  // DuckDB (data previews, lake tables) is a native addon: load it from node_modules as is,
  // and copy its shared library — which nothing requires by name — into the standalone build.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  outputFileTracingIncludes: {
    "/api/connections/**": ["./node_modules/@duckdb/node-bindings-*/*"],
  },
  // The viewer used to live at /; links saved from it (/?bucket=…, /?view=…) still land there.
  async redirects() {
    return ["bucket", "view"].map((key) => ({
      source: "/",
      has: [{ type: "query" as const, key }],
      destination: "/dashboard",
      permanent: false,
    }));
  },
  async headers() {
    return [
      {
        // Everything but the object route, which sets its own CSP and allows same-origin framing
        // (the PDF preview); the rest of the app may never be framed.
        source: "/((?!api/connections/[^/]+/object).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // An app, not a website: keep every page out of search engines.
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=()",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // Only meaningful over HTTPS; browsers ignore it on plain http.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      {
        // Share links: the Download button posts a form whose answer may redirect to the
        // provider's signed link, and browsers check form-action on that redirect too.
        // Nothing on these pages comes from the shared file. They also never send the
        // link onwards as a referrer, and stay out of search engines.
        source: "/s/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        // API answers are for this site's own pages: no other site may embed them.
        source: "/api/:path*",
        headers: [{ key: "Cross-Origin-Resource-Policy", value: "same-origin" }],
      },
      {
        // API answers (but the object route, which sets its own) carry the strict policy.
        source: "/api/((?!connections/[^/]+/object).*)",
        headers: [{ key: "Content-Security-Policy", value: csp.replace("'unsafe-inline'", "").replace("  ", " ") }],
      },
      {
        // The object route still gets the transport and referrer protections.
        source: "/api/connections/:id/object",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
