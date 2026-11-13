import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { driveFolder, driveListedName, driveQuote, googleDriveDriver } from "@/app/lib/server/drivers/gdrive";

/**
 * The Google Drive driver against an in-memory stand-in for the parts of Google's APIs it
 * uses (token refresh, files.list with its query language, media, export, resumable upload,
 * update, copy). It follows Google's documented behaviour; it can't prove Google still does.
 */
type File = { id: string; name: string; mimeType: string; parents: string[]; bytes?: Buffer; trashed?: boolean; created: number };

const FOLDER = "application/vnd.google-apps.folder";
const DOC = "application/vnd.google-apps.document";
let files: Map<string, File>;
let seq = 0;
const realFetch = globalThis.fetch;
const seen: string[] = [];

function add(name: string, parent: string, mimeType: string, bytes?: string): File {
  const file = { id: `id${++seq}`, name, mimeType, parents: [parent], bytes: bytes === undefined ? undefined : Buffer.from(bytes), created: seq };
  files.set(file.id, file);
  return file;
}

/** Just enough of the Drive query language: `'x' in parents`, `name = 'y'`, `trashed = false`. */
function query(q: string): File[] {
  const unquote = (s: string) => s.replace(/\\(.)/g, "$1");
  const parent = /^'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
  const name = / and name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
  return [...files.values()]
    .filter((f) => !f.trashed && (parent === undefined || f.parents.includes(unquote(parent))) && (name === undefined || f.name === unquote(name)))
    .sort((a, b) => a.created - b.created);
}

const meta = (f: File) => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  ...(f.bytes ? { size: String(f.bytes.length), md5Checksum: `md5-${f.id}` } : {}),
  modifiedTime: "2026-01-02T03:04:05.000Z",
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const uploads = new Map<string, { file: File; chunks: Buffer[] }>();

async function fakeGoogle(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  seen.push(`${method} ${url.pathname}`);
  const body = async () => {
    const raw = init.body ?? (input instanceof Request ? await input.text() : undefined);
    if (raw === undefined || raw === null) return Buffer.alloc(0);
    if (typeof raw === "string") return Buffer.from(raw);
    if (raw instanceof URLSearchParams) return Buffer.from(raw.toString());
    return Buffer.from(raw as Uint8Array);
  };

  if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
    const form = new URLSearchParams((await body()).toString());
    if (form.get("refresh_token") !== "refresh-1") return json({ error: "invalid_grant" }, 400);
    return json({ access_token: "access-1", expires_in: 3600, token_type: "Bearer" });
  }
  const auth = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization");
  if (url.pathname.startsWith("/upload/drive/v3/session/")) {
    const upload = uploads.get(url.pathname.split("/").pop()!)!;
    const chunk = await body();
    upload.chunks.push(chunk);
    const range = new Headers(init.headers).get("content-range") ?? "";
    if (/\/\*$/.test(range)) return new Response(null, { status: 308 });
    upload.file.bytes = Buffer.concat(upload.chunks);
    files.set(upload.file.id, upload.file);
    return json(meta(upload.file));
  }
  if (auth !== "Bearer access-1") return json({ error: { code: 401, errors: [{ reason: "authError" }] } }, 401);

  if (url.pathname === "/drive/v3/files" && method === "GET") {
    const found = query(url.searchParams.get("q") ?? "");
    return json({ files: found.map(meta) });
  }
  if (url.pathname === "/drive/v3/files" && method === "POST") {
    const req = JSON.parse((await body()).toString()) as { name: string; mimeType: string; parents: string[] };
    return json(meta(add(req.name, req.parents[0], req.mimeType)));
  }
  if (url.pathname === "/drive/v3/about") return json({ user: { emailAddress: "someone@example.com" } });
  const copy = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(url.pathname);
  if (copy) {
    const from = files.get(copy[1])!;
    const req = JSON.parse((await body()).toString()) as { name: string; parents: string[] };
    const made = add(req.name, req.parents[0], from.mimeType);
    made.bytes = from.bytes;
    return json(meta(made));
  }
  const exp = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname);
  if (exp) return new Response(`%PDF export of ${files.get(exp[1])!.name}`, { headers: { "content-type": "application/pdf" } });
  const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (one) {
    const file = files.get(decodeURIComponent(one[1]));
    if (!file) return json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, 404);
    if (method === "GET" && url.searchParams.get("alt") === "media") {
      const range = /bytes=(\d+)-(\d*)/.exec(new Headers(init.headers).get("range") ?? "");
      if (!range) return new Response(new Uint8Array(file.bytes!), { headers: { "content-length": String(file.bytes!.length) } });
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : file.bytes!.length - 1;
      return new Response(new Uint8Array(file.bytes!.subarray(start, end + 1)), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${file.bytes!.length}`, "content-length": String(end - start + 1) },
      });
    }
    if (method === "PATCH") {
      const req = JSON.parse((await body()).toString() || "{}") as { name?: string; trashed?: boolean };
      if (req.name) file.name = req.name;
      if (req.trashed) file.trashed = true;
      const add = url.searchParams.get("addParents");
      const remove = url.searchParams.get("removeParents");
      if (add && remove) file.parents = [add];
      return json(meta(file));
    }
  }
  if (url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "resumable") {
    const req = JSON.parse((await body()).toString()) as { name: string; parents: string[] };
    const file: File = { id: `id${++seq}`, name: req.name, mimeType: "text/plain", parents: req.parents, created: seq };
    const session = `s${seq}`;
    uploads.set(session, { file, chunks: [] });
    return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/session/${session}` } });
  }
  return json({ error: { code: 400, message: `unhandled ${method} ${url.pathname}` } }, 400);
}

const driver = (root = "/") => googleDriveDriver({ root, clientId: "1-abc.apps.googleusercontent.com", clientSecret: "secret-1", refreshToken: "refresh-1" });
const text = async (stream: ReadableStream<Uint8Array>) => Buffer.from(await new Response(stream).arrayBuffer()).toString();

beforeAll(() => {
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return /googleapis\.com/.test(href) ? fakeGoogle(input, init) : realFetch(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());

function reset() {
  files = new Map();
  seq = 0;
  seen.length = 0;
  const work = add("Work", "root", FOLDER);
  add("notes.txt", work.id, "text/plain", "hello drive");
  add("Plan", work.id, DOC);
  add("a/b.txt", work.id, "text/plain", "slash in a name"); // a path can't name this
  add("dup.txt", work.id, "text/plain", "first");
  add("dup.txt", work.id, "text/plain", "second");
  add("it's.txt", work.id, "text/plain", "quoted");
  const sub = add("Sub", work.id, FOLDER);
  add("deep.csv", sub.id, "text/csv", "a,b\n1,2\n");
}
afterEach(reset);

describe("Google Drive paths", () => {
  it("normalises folder roots and refuses dot segments", () => {
    expect(driveFolder("/")).toBe("/");
    expect(driveFolder("Work/Sub/")).toBe("/Work/Sub");
    expect(driveFolder("/Work/../Private")).toBeNull();
  });

  it("escapes names inside a Drive query", () => {
    expect(driveQuote(`it's`)).toBe(`'it\\'s'`);
    expect(driveQuote(`a\\b`)).toBe(`'a\\\\b'`);
  });

  it("lists Google documents as PDFs and leaves out what a path can't name", () => {
    expect(driveListedName({ name: "Plan", mimeType: DOC })).toBe("Plan.pdf");
    expect(driveListedName({ name: "Form", mimeType: "application/vnd.google-apps.form" })).toBeNull();
    expect(driveListedName({ name: "a/b", mimeType: "text/plain" })).toBeNull();
    expect(driveListedName({ name: "..", mimeType: FOLDER })).toBeNull();
  });
});

describe("Google Drive driver", () => {
  reset();

  it("verifies a folder root and lists it like a bucket", async () => {
    const work = driver("/Work");
    await expect(work.verify()).resolves.toEqual({});
    const listing = await work.list("");
    expect(listing.folders).toEqual(["Sub/"]);
    expect(listing.files.map((file) => file.key).sort()).toEqual(["Plan.pdf", "dup.txt", "it's.txt", "notes.txt"]);
    await expect(driver("/Missing").verify()).rejects.toMatchObject({ status: 404 });
  });

  it("reads files, byte ranges and Google documents", async () => {
    const work = driver("/Work");
    expect(await text((await work.read("notes.txt")).stream)).toBe("hello drive");
    const part = await work.read("notes.txt", { start: 6, end: 10 });
    expect(await text(part.stream)).toBe("drive");
    expect(part.range).toEqual({ start: 6, end: 10 });
    const doc = await work.read("Plan.pdf");
    expect(doc.contentType).toBe("application/pdf");
    expect(await text(doc.stream)).toBe("%PDF export of Plan");
    expect(await text((await work.read("dup.txt")).stream)).toBe("first");
    expect(await text((await work.read("it's.txt")).stream)).toBe("quoted");
    expect(await text((await driver("/").read("Work/Sub/deep.csv")).stream)).toBe("a,b\n1,2\n");
    await expect(work.read("nothing.txt")).rejects.toMatchObject({ status: 404 });
  });

  it("walks folders for listKeys and stats", async () => {
    const work = driver("/Work");
    const { keys } = await work.listKeys("", 100);
    expect(keys).toContain("Sub/deep.csv");
    const stats = await work.stats("");
    // notes, Plan.pdf, dup (once), it's, Sub/deep.csv: "a/b.txt" has no path, so it isn't counted.
    expect(stats.objects).toBe(5);
  });

  it("uploads into new folders, copies, renames and deletes to the bin", async () => {
    const work = driver("/Work");
    await work.upload("New/inner/upload.txt", new Response("uploaded bytes").body!, undefined, "text/plain");
    expect(await text((await work.read("New/inner/upload.txt")).stream)).toBe("uploaded bytes");
    await work.copy("notes.txt", "Sub/notes-copy.txt");
    expect(await text((await work.read("Sub/notes-copy.txt")).stream)).toBe("hello drive");
    await expect(work.copy("notes.txt", "Sub/notes-copy.txt")).rejects.toMatchObject({ status: 409 });
    await work.rename!("Sub/notes-copy.txt", "moved.txt");
    expect(await text((await work.read("moved.txt")).stream)).toBe("hello drive");
    const { failed } = await work.remove(["moved.txt", "already-gone.txt"]);
    expect(failed).toEqual([]);
    await expect(work.read("moved.txt")).rejects.toMatchObject({ status: 404 });
  });

  it("asks for a reconnect when the refresh token stops working", async () => {
    const broken = googleDriveDriver({ root: "/", clientId: "2-x.apps.googleusercontent.com", clientSecret: "s", refreshToken: "revoked" });
    await expect(broken.list("")).rejects.toMatchObject({ status: 401 });
  });
});
