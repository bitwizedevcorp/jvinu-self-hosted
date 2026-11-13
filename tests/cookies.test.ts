/**
 * The /cookies page lists what jvinu keeps in the browser. This keeps that list honest:
 * every cookie and local-storage key the code defines is on it, and nothing on it is gone.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_STORAGE, COOKIES, NOTICE_KEY } from "../app/lib/cookies";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) ? [readFileSync(full, "utf8")] : [];
  });
}

describe("the cookie page", () => {
  const code = [...sources("app"), readFileSync("proxy.ts", "utf8")];
  const cookies = new Set(code.flatMap((source) => [...source.matchAll(/const \w*COOKIE\w* = "([^"]+)"/g)].map((match) => match[1])));
  const stored = new Set(
    code
      .filter((source) => source.includes("localStorage"))
      .flatMap((source) => [...source.matchAll(/const \w*KEY\w* = "(jvinu[^"]*)"/g)].map((match) => match[1])),
  );
  stored.add(NOTICE_KEY);

  it("lists every cookie the code sets, and no others", () => {
    expect(cookies.size).toBeGreaterThan(0);
    expect(new Set(COOKIES.map((cookie) => cookie.name))).toEqual(cookies);
  });

  it("lists every setting kept in local storage, and no others", () => {
    expect(new Set(BROWSER_STORAGE.map((item) => item.name))).toEqual(stored);
  });
});
