import "server-only";
import type { ConnectionSettings } from "../connection-settings";

type Result = { settings: ConnectionSettings } | { error: string };

/**
 * Applies a client's settings patch to the current settings. Every field is checked;
 * `null` removes a setting. Unknown fields are refused rather than stored.
 */
export function applySettingsPatch(current: ConnectionSettings, raw: unknown): Result {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Settings must be an object." };
  const next: ConnectionSettings = { ...current };
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    switch (field) {
      case "egressPerGb":
        if (value === null) delete next.egressPerGb;
        else if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10) next.egressPerGb = value;
        else return { error: "The download rate is USD per GB, between 0 and 10 — or empty for list prices." };
        break;
      case "providerEncryption":
        if (value === null || value === false) delete next.providerEncryption;
        else if (value === true) next.providerEncryption = true;
        else return { error: "Encryption at rest is on or off." };
        break;
      case "publicBaseUrl": {
        if (value === null || value === "") {
          delete next.publicBaseUrl;
          break;
        }
        const cleaned = typeof value === "string" ? cleanPublicBase(value) : null;
        if (!cleaned) return { error: "The public base URL must be an https address, like https://cdn.example.com/files." };
        next.publicBaseUrl = cleaned;
        break;
      }
      case "shareTarget": {
        if (value === null) {
          delete next.shareTarget;
          break;
        }
        const prefix = typeof value === "object" && value ? (value as { prefix?: unknown }).prefix : undefined;
        const cleaned = typeof prefix === "string" ? cleanSharePrefix(prefix) : null;
        if (cleaned === null) return { error: "The share folder must be a folder path such as jvinu-shares/." };
        next.shareTarget = { prefix: cleaned };
        break;
      }
      default:
        return { error: `Unknown setting “${field}”.` };
    }
  }
  return { settings: next };
}

/** https only, no credentials, query or fragment; no trailing slash. */
export function cleanPublicBase(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** "jvinu-shares/" style: segments without dots-only parts; always ends in "/". */
export function cleanSharePrefix(raw: string): string | null {
  const parts = raw.trim().split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || /[\\\u0000-\u001f]/.test(part))) return null;
  const prefix = `${parts.join("/")}/`;
  return prefix.length <= 200 ? prefix : null;
}
