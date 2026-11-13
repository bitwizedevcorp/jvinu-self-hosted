/** Bodies on routes anyone can reach are read only up to a limit, and never whole first. */
import { describe, expect, it } from "vitest";
import { readBody, readForm, readJson } from "../app/lib/server/http";

const post = (body: BodyInit | ReadableStream, headers: Record<string, string> = {}) =>
  new Request("http://localhost/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);

/** A body sent in chunks, with no Content-Length; counts how much of it was read. */
function chunked(chunks: number, size: number) {
  const pulled = { count: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.count === chunks) return controller.close();
      pulled.count += 1;
      controller.enqueue(new Uint8Array(size));
    },
  });
  return { stream, pulled };
}

describe("request bodies", () => {
  it("reads what fits", async () => {
    expect(await readJson(post(JSON.stringify({ password: "x" }), { "content-type": "application/json" }))).toEqual({ password: "x" });
    expect((await readForm(post("password=open+sesame", { "content-type": "application/x-www-form-urlencoded" }))).get("password")).toBe("open sesame");
    const form = new FormData();
    form.set("password", "from curl -F");
    expect((await readForm(new Request("http://localhost/x", { method: "POST", body: form }))).get("password")).toBe("from curl -F");
  });

  it("refuses a body that says it's too large, before reading it", async () => {
    const { stream, pulled } = chunked(1000, 1024);
    await expect(readBody(post(stream, { "content-length": String(1024 * 1024) }), 16 * 1024)).rejects.toMatchObject({ status: 413 });
    expect(pulled.count).toBeLessThanOrEqual(1);
  });

  it("stops reading a chunked body as soon as it passes the limit", async () => {
    const { stream, pulled } = chunked(10_000, 1024);
    await expect(readBody(post(stream), 16 * 1024)).rejects.toMatchObject({ status: 413 });
    expect(pulled.count).toBeLessThan(40);
  });

  it("says when a body isn't JSON", async () => {
    await expect(readJson(post("not json"))).rejects.toBeInstanceOf(SyntaxError);
  });
});
