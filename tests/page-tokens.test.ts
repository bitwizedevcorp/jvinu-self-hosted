import { describe, expect, it } from "vitest";
import { bindPageTokens } from "@/app/lib/server/drivers";
import { memoryDriver } from "./memory-driver";

process.env.JVINU_SECRET ??= "page-token-test-secret-0123456789abcdef";

/**
 * Page tokens travel through the browser. Some drivers follow them as addresses (OneDrive's
 * are Graph URLs), so driverFor binds each one to its connection and prefix.
 */
describe("page tokens", () => {
  const files = Object.fromEntries(
    [...Array.from({ length: 1_200 }, (_, i) => `a/${String(i).padStart(4, "0")}.txt`), "b/secret.txt"].map((key) => [key, "x"]),
  );
  const bound = bindPageTokens(memoryDriver(files), "connection-1");

  it("come back to the listing that made them", async () => {
    const first = await bound.list("a/");
    expect(first.files).toHaveLength(1_000);
    const second = await bound.list("a/", first.nextToken);
    expect(second.files).toHaveLength(200);
    expect(second.nextToken).toBeUndefined();
  });

  it("are refused for another prefix, another connection, or after an edit", async () => {
    const { nextToken } = await bound.list("a/");
    await expect(bound.list("b/", nextToken)).rejects.toMatchObject({ status: 400 });
    await expect(bindPageTokens(memoryDriver(files), "connection-2").list("a/", nextToken)).rejects.toMatchObject({ status: 400 });
    const [mac, inner] = [nextToken!.slice(0, 22), nextToken!.slice(23)];
    await expect(bound.list("a/", `${mac}.${inner}0`)).rejects.toMatchObject({ status: 400 });
    await expect(bound.list("a/", "https://graph.microsoft.com/v1.0/me/drive/root/children")).rejects.toMatchObject({ status: 400 });
  });
});
