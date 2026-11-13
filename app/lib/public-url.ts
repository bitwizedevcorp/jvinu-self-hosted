/**
 * Public URLs for objects behind a CDN or custom domain: the connection's public base URL
 * plus the object's key. Each path segment is percent-encoded the way the storage services
 * read it (RFC 3986: everything but letters, digits and - . _ ~), with "/" kept between
 * segments. That matters for two characters: a space must be %20, and "+" must be %2B —
 * S3 and S3-compatible services read a bare "+" in a path as a space.
 */

const strict = (segment: string) => encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** `base` has no trailing slash (the settings route strips it); `key` is the object's full key. */
export function publicUrlFor(base: string, key: string): string {
  return `${base.replace(/\/+$/, "")}/${key.split("/").map(strict).join("/")}`;
}
