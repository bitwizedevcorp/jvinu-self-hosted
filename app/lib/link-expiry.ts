/** How long a copied share link stays valid. 7 days is the providers' ceiling. */
export const LINK_EXPIRY_OPTIONS: { seconds: number; label: string }[] = [
  { seconds: 15 * 60, label: "15 minutes" },
  { seconds: 60 * 60, label: "1 hour" },
  { seconds: 24 * 60 * 60, label: "1 day" },
  { seconds: 3 * 24 * 60 * 60, label: "3 days" },
  { seconds: 7 * 24 * 60 * 60, label: "7 days" },
];

const KEY = "jvinu-link-expiry";
const EVENT = "jvinu-link-expiry-change";
export const DEFAULT_LINK_EXPIRY = 60 * 60;

export function readLinkExpiry(): number {
  try {
    const value = Number(localStorage.getItem(KEY));
    return LINK_EXPIRY_OPTIONS.some((option) => option.seconds === value) ? value : DEFAULT_LINK_EXPIRY;
  } catch {
    return DEFAULT_LINK_EXPIRY;
  }
}

export function setLinkExpiry(seconds: number) {
  try {
    localStorage.setItem(KEY, String(seconds));
  } catch {
    // Storage blocked: the choice still applies until the page reloads.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeLinkExpiry(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function labelFor(seconds: number): string {
  return LINK_EXPIRY_OPTIONS.find((option) => option.seconds === seconds)?.label ?? `${Math.round(seconds / 60)} minutes`;
}
