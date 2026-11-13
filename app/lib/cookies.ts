/**
 * Everything jvinu keeps in the browser, for the cookie notice and the /cookies page.
 * Keep it in step with the code: a new cookie or storage key belongs here too.
 */
export type Kept = { name: string; purpose: string; lifetime: string; when: string };

/** First-party, HttpOnly cookies — all of them needed to sign in. */
export const COOKIES: Kept[] = [
  {
    name: "jvinu_session",
    purpose: "Keeps you signed in. It holds a random token; the server keeps only a hash of it.",
    lifetime: "7 days, or until you sign out",
    when: "When you sign in",
  },
  {
    name: "jvinu_device",
    purpose:
      "Marks this browser as one that has signed in before, so wrong passwords typed elsewhere can't lock you out of it. It holds a random id, signed by the server, and nothing about you.",
    lifetime: "1 year",
    when: "After you sign in with the admin password",
  },
  {
    name: "jvinu_oidc",
    purpose: "Carries the single sign-on handshake, sealed, between this server and your identity provider.",
    lifetime: "10 minutes",
    when: "Only while signing in with single sign-on",
  },
  {
    name: "jvinu_vault",
    purpose: "Very old versions of jvinu kept connections in it. It's read once, to move them into the database, and deleted.",
    lifetime: "Deleted when read",
    when: "Never set by this version",
  },
];

/** Settings in the browser's local storage: never sent to the server, cleared with the site's data. */
export const BROWSER_STORAGE: Kept[] = [
  { name: "jvinu-theme", purpose: "Light, dark or the system's appearance.", lifetime: "Until you change it", when: "When you choose one" },
  { name: "jvinu-cookie-notice", purpose: "That you've read the cookie notice, so it doesn't come back.", lifetime: "Until you clear it", when: "When you close the notice" },
  { name: "jvinu-link-expiry", purpose: "The expiry you last chose for a share link, as the next default.", lifetime: "Until you clear it", when: "When you share a file" },
  { name: "jvinu.sql.history", purpose: "Your recent SQL queries, to run again.", lifetime: "The last 20", when: "When you run a query" },
  { name: "jvinu-waitlist-joined", purpose: "That you joined the cloud-backup waitlist.", lifetime: "Until you clear it", when: "Only if you join it" },
];

export const NOTICE_KEY = "jvinu-cookie-notice";
