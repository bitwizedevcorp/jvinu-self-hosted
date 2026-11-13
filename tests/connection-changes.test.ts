import { describe, expect, it } from "vitest";
import { contentsChanged, onContentsChanged, trackWrites } from "@/app/lib/server/connection-changes";
import { memoryDriver } from "./memory-driver";

/** Every write through driverFor forgets what this server remembered about the connection. */
describe("connection changes", () => {
  const heard: string[] = [];
  onContentsChanged((id) => heard.push(id));

  it("reports every kind of write, and no read", async () => {
    const driver = trackWrites(memoryDriver({ "a.txt": "x" }), "c1");
    heard.length = 0;
    await driver.list("");
    await driver.inventory("");
    await driver.read("a.txt");
    expect(heard).toEqual([]);

    await driver.write("b.txt", new Uint8Array([1]));
    await driver.upload("c.txt", new Response("y").body!, 1);
    await driver.copy("a.txt", "d.txt");
    await driver.remove(["d.txt"]);
    expect(heard).toEqual(["c1", "c1", "c1", "c1"]);
  });

  it("reports a write that failed part-way too, and still fails it", async () => {
    const driver = trackWrites(memoryDriver(), "c2");
    heard.length = 0;
    await expect(driver.copy("missing.txt", "x.txt")).rejects.toMatchObject({ status: 404 });
    expect(heard).toEqual(["c2"]);
  });

  it("keeps going when one cache can't forget", () => {
    onContentsChanged(() => {
      throw new Error("broken cache");
    });
    heard.length = 0;
    expect(() => contentsChanged("c3")).not.toThrow();
    expect(heard).toEqual(["c3"]);
  });
});
