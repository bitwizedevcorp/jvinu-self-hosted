import "server-only";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  heic: "image/heic", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/ogg", flac: "audio/flac",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
};

/** A content type from the file name, for stores that keep none (or a useless one). */
export const mimeOf = (key: string): string | undefined => MIME[key.split(".").pop()?.toLowerCase() ?? ""];

/** The stored type unless it's missing or the generic octet-stream; then the name decides. */
export function effectiveType(key: string, stored?: string): string {
  if (stored && !/^(application\/octet-stream|binary\/octet-stream)\b/i.test(stored)) return stored;
  return mimeOf(key) ?? stored ?? "application/octet-stream";
}
