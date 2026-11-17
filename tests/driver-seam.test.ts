import { describe, expect, it } from "vitest";
import { atSeam } from "@/app/lib/server/drivers";
import { isTaken } from "@/app/lib/server/drivers/types";
import { memoryDriver } from "./memory-driver";

process.env.JVINU_SECRET ??= "driver-seam-test-secret-0123456789abcdef";

/** What every caller's driver goes through, whatever the provider (driverFor's seam). */
describe("the driver seam", () => {
  const files = { "a/one.txt": "1", "a/two.txt": "22", "ab.txt": "3", "a/sub/three.txt": "333" };

  it("names a folder with its '/', however a caller wrote it", async () => {
    const driver = atSeam(memoryDriver(files), { scope: "c1" });
    const keys = (inventory: { files: { key: string }[] }) => inventory.files.map((file) => file.key).sort();
    // Without the seam, an S3-style store would also match "ab.txt" for "a".
    expect(keys(await driver.inventory("a"))).toEqual(["a/one.txt", "a/sub/three.txt", "a/two.txt"]);
    expect(keys(await driver.inventory("a"))).toEqual(keys(await driver.inventory("a/")));
    expect((await driver.listKeys("a/sub", 10)).keys).toEqual(["a/sub/three.txt"]);
    expect((await driver.stats("a")).objects).toBe(3);
    const listing = await driver.list("a");
    expect(listing.files.map((file) => file.key)).toEqual(["a/one.txt", "a/two.txt"]);
    expect(listing.folders).toEqual(["a/sub/"]);
  });

  it("refuses '.' and '..' in a looked-up key too", async () => {
    const driver = atSeam(memoryDriver(files), { scope: "c1" });
    await expect(driver.findFile("a/../ab.txt")).rejects.toMatchObject({ status: 400 });
    expect(await driver.findFile("a/one.txt")).toMatchObject({ key: "a/one.txt", size: 1 });
  });

  it("says whether a name is taken, for files and folders", async () => {
    const driver = atSeam(memoryDriver(files), { scope: "c1" });
    expect(await isTaken(driver, "a/one.txt")).toBe(true);
    expect(await isTaken(driver, "a/one")).toBe(false);
    expect(await isTaken(driver, "a/sub/")).toBe(true);
    expect(await isTaken(driver, "a/empty/")).toBe(false);
  });
});
