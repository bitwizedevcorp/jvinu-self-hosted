/**
 * An in-memory stand-in for the parts of Google's APIs the Google Drive driver uses — token
 * exchange and refresh, files.list with its query language, media with ranges, export,
 * resumable uploads (new files and overwrites), update, copy — so the driver runs in tests
 * without an account. It follows Google's documented behaviour; it can't prove Google still does.
 *
 * It answers through a replaced global fetch, for googleapis.com hosts only.
 */
import { GDRIVE_READONLY_SCOPE, GDRIVE_SCOPE } from "../app/lib/server/drivers/gdrive";

export const FOLDER = "application/vnd.google-apps.folder";
export const DOC = "application/vnd.google-apps.document";

export type MockFile = { id: string; name: string; mimeType: string; parents: string[]; bytes?: Buffer; trashed?: boolean; created: number };

export const MOCK_DRIVE = { clientId: "1-abc.apps.googleusercontent.com", clientSecret: "secret-1", refreshToken: "refresh-1" };

/**
 * `pageSize`: how many items one files.list page holds. Google may return fewer than asked
 * for; a small page puts same-named items on different pages.
 */
export function createGoogleDriveMock({ pageSize = 2 }: { pageSize?: number } = {}) {
  const files = new Map<string, MockFile>();
  const uploads = new Map<string, { file: MockFile; chunks: Buffer[] }>();
  const seen: string[] = [];
  let seq = 0;
  let realFetch: typeof fetch | null = null;

  function add(name: string, parent: string, mimeType: string, bytes?: string | Buffer): MockFile {
    const file: MockFile = {
      id: `id${++seq}`,
      name,
      mimeType,
      parents: [parent],
      bytes: bytes === undefined ? undefined : Buffer.from(bytes),
      created: seq,
    };
    files.set(file.id, file);
    return file;
  }

  /** Just enough of the Drive query language: `'x' in parents`, `name = 'y'`, `trashed = false`. */
  function query(q: string): MockFile[] {
    const unquote = (s: string) => s.replace(/\\(.)/g, "$1");
    const parent = /^'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
    const name = / and name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
    return [...files.values()]
      .filter((f) => !f.trashed && (parent === undefined || f.parents.includes(unquote(parent))) && (name === undefined || f.name === unquote(name)))
      .sort((a, b) => a.created - b.created);
  }

  const meta = (f: MockFile) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    ...(f.bytes ? { size: String(f.bytes.length), md5Checksum: `md5-${f.id}` } : {}),
    modifiedTime: "2026-01-02T03:04:05.000Z",
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  function startUpload(file: MockFile) {
    const session = `s${++seq}`;
    uploads.set(session, { file, chunks: [] });
    return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/session/${session}` } });
  }

  async function answer(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
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
      if (form.get("grant_type") === "authorization_code") {
        // The code says which access the user was asked for; Google echoes the granted scope.
        if (!form.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
        const code = form.get("code");
        if (code !== "code-full" && code !== "code-read") return json({ error: "invalid_grant" }, 400);
        return json({
          access_token: code === "code-read" ? "access-read" : "access-1",
          refresh_token: code === "code-read" ? "refresh-read" : "refresh-1",
          scope: code === "code-read" ? GDRIVE_READONLY_SCOPE : GDRIVE_SCOPE,
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (form.get("refresh_token") === "refresh-read") return json({ access_token: "access-read", expires_in: 3600, token_type: "Bearer" });
      if (form.get("refresh_token") !== "refresh-1") return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "access-1", expires_in: 3600, token_type: "Bearer" });
    }

    const auth = headers.get("authorization");
    if (url.pathname.startsWith("/upload/drive/v3/session/")) {
      const upload = uploads.get(url.pathname.split("/").pop()!);
      if (!upload) return json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, 404);
      upload.chunks.push(await body());
      if (/\/\*$/.test(headers.get("content-range") ?? "")) return new Response(null, { status: 308 });
      upload.file.bytes = Buffer.concat(upload.chunks);
      files.set(upload.file.id, upload.file);
      uploads.delete(url.pathname.split("/").pop()!);
      return json(meta(upload.file));
    }
    // Read-only access: Google refuses every change itself.
    if (auth === "Bearer access-read" && method !== "GET")
      return json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, 403);
    if (auth !== "Bearer access-1" && auth !== "Bearer access-read")
      return json({ error: { code: 401, errors: [{ reason: "authError" }] } }, 401);

    if (url.pathname === "/drive/v3/files" && method === "GET") {
      const found = query(url.searchParams.get("q") ?? "");
      const from = Number(url.searchParams.get("pageToken") ?? 0);
      const page = found.slice(from, from + pageSize);
      return json({ files: page.map(meta), ...(from + pageSize < found.length ? { nextPageToken: String(from + pageSize) } : {}) });
    }
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      const req = JSON.parse((await body()).toString()) as { name: string; mimeType: string; parents: string[] };
      return json(meta(add(req.name, req.parents[0], req.mimeType)));
    }
    if (url.pathname === "/drive/v3/about") return json({ user: { emailAddress: "someone@example.com" } });
    const copy = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(url.pathname);
    if (copy) {
      const from = files.get(decodeURIComponent(copy[1]));
      if (!from) return json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, 404);
      const req = JSON.parse((await body()).toString()) as { name: string; parents: string[] };
      const made = add(req.name, req.parents[0], from.mimeType);
      made.bytes = from.bytes;
      return json(meta(made));
    }
    const exp = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname);
    if (exp) return new Response(`%PDF export of ${files.get(decodeURIComponent(exp[1]))!.name}`, { headers: { "content-type": "application/pdf" } });
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const file = files.get(decodeURIComponent(one[1]));
      if (!file) return json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, 404);
      if (method === "GET" && url.searchParams.get("alt") === "media") {
        const bytes = file.bytes ?? Buffer.alloc(0);
        const range = /bytes=(\d+)-(\d*)/.exec(headers.get("range") ?? "");
        if (!range) return new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } });
        const start = Number(range[1]);
        if (start >= bytes.length) return json({ error: { code: 416, message: "Requested range not satisfiable" } }, 416);
        const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
        return new Response(new Uint8Array(bytes.subarray(start, end + 1)), {
          status: 206,
          headers: { "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": String(end - start + 1) },
        });
      }
      if (method === "PATCH") {
        const req = JSON.parse((await body()).toString() || "{}") as { name?: string; trashed?: boolean };
        if (req.name) file.name = req.name;
        if (req.trashed) file.trashed = true;
        const addTo = url.searchParams.get("addParents");
        const removeFrom = url.searchParams.get("removeParents");
        if (addTo && removeFrom) file.parents = [addTo];
        return json(meta(file));
      }
    }
    if (url.searchParams.get("uploadType") === "resumable") {
      const contentType = headers.get("x-upload-content-type") ?? "application/octet-stream";
      if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
        const req = JSON.parse((await body()).toString()) as { name: string; parents: string[] };
        return startUpload({ id: `id${++seq}`, name: req.name, mimeType: contentType, parents: req.parents, created: seq });
      }
      const existing = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (existing && method === "PATCH") {
        const file = files.get(decodeURIComponent(existing[1]));
        if (!file) return json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, 404);
        return startUpload({ ...file, mimeType: contentType });
      }
    }
    return json({ error: { code: 400, message: `unhandled ${method} ${url.pathname}` } }, 400);
  }

  return {
    files,
    seen,
    add,
    /** Empties the drive. */
    clear() {
      files.clear();
      uploads.clear();
      seen.length = 0;
      seq = 0;
    },
    /** Answers googleapis.com requests from here; everything else goes to the network as before. */
    install() {
      if (realFetch) return;
      const original = globalThis.fetch;
      realFetch = original;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return /^https:\/\/[a-z0-9.-]*googleapis\.com\//.test(href) ? answer(input, init) : original(input, init);
      }) as typeof fetch;
    },
    uninstall() {
      if (realFetch) globalThis.fetch = realFetch;
      realFetch = null;
    },
  };
}
