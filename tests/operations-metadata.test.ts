import { describe, expect, it } from "vitest";
import type { MetadataChange } from "../app/lib/server/drivers/types";
import { runOperation } from "../app/lib/server/operations";
import { memoryDriver } from "./memory-driver";

describe("bulk metadata", () => {
  it("changes every file under the selected folders, and skips folder markers", async () => {
    const changed: [string, MetadataChange][] = [];
    const driver = memoryDriver({ "site/": "", "site/index.html": "<p>", "site/css/app.css": "a{}", "site/css/": "", "other.txt": "x" });
    driver.setMetadata = async (key, change) => {
      changed.push([key, change]);
    };
    const result = await runOperation(driver, {
      op: "metadata",
      items: [{ key: "site/", kind: "folder" }],
      change: { cacheControl: "public, max-age=60" },
    });
    expect(result).toEqual({ done: 2, failed: [] });
    expect(changed.map(([key]) => key).sort()).toEqual(["site/css/app.css", "site/index.html"]);
    expect(changed[0][1]).toEqual({ cacheControl: "public, max-age=60" });
  });

  it("reports the files it couldn't change", async () => {
    const driver = memoryDriver({ "a.txt": "1", "b.txt": "2" });
    driver.setMetadata = async (key) => {
      if (key === "b.txt") throw new Error("denied");
    };
    const result = await runOperation(driver, {
      op: "metadata",
      items: [
        { key: "a.txt", kind: "file" },
        { key: "b.txt", kind: "file" },
      ],
      change: { contentType: "text/plain" },
    });
    expect(result).toEqual({ done: 1, failed: ["b.txt"] });
  });

  it("refuses a connection that can't change metadata", async () => {
    await expect(runOperation(memoryDriver({ "a.txt": "1" }), { op: "metadata", items: [{ key: "a.txt", kind: "file" }], change: {} })).rejects.toThrow(
      /can't change object metadata/,
    );
  });
});
