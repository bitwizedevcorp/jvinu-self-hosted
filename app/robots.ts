import type { MetadataRoute } from "next";

/** This is an app, not a website: search engines are asked to stay away from all of it. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
