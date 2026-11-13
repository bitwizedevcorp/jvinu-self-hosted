/**
 * An in-memory stand-in for the parts of the Dropbox API the driver uses — routes, argument
 * headers, cursors, upload sessions, async batch deletes, error summaries — so the contract
 * suite runs without an account. It mirrors Dropbox's documented behaviour; it can't prove
 * Dropbox itself still behaves that way, which is what the live-account mode is for.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Node = { display: string; folder: boolean; bytes?: Buffer; modified: string };

export const MOCK_APP_KEY = "mockappkey00001";
export const MOCK_REFRESH_TOKEN = "mock-refresh-token";
export const MOCK_CODE = "mock-access-code-1";

export async function startDropboxMock(): Promise<{ url: string; close: () => void; stats: { throttled: number } }> {
  const nodes = new Map<string, Node>(); // path_lower → node; "" is the root
  nodes.set("", { display: "", folder: true, modified: new Date().toISOString() });
  const sessions = new Map<string, Buffer[]>();
  const jobs = new Map<string, { polls: number; result: unknown }>();
  const stats = { throttled: 0 };
  let uploads = 0;

  const lower = (path: string) => path.toLowerCase().replace(/\/$/, "");
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

  function entry(node: Node) {
    return node.folder
      ? { ".tag": "folder", name: nameOf(node.display), path_display: node.display, path_lower: lower(node.display) }
      : {
          ".tag": "file",
          name: nameOf(node.display),
          path_display: node.display,
          path_lower: lower(node.display),
          size: node.bytes!.length,
          server_modified: node.modified.replace(/\.\d+Z$/, "Z"),
          content_hash: `hash-${node.bytes!.length}`,
        };
  }

  function ensureParents(path: string) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const display = `/${parts.slice(0, i).join("/")}`;
      if (!nodes.has(lower(display))) nodes.set(lower(display), { display, folder: true, modified: new Date().toISOString() });
    }
  }

  function subtree(path: string) {
    const root = lower(path);
    return [...nodes.keys()].filter((key) => key !== "" && (key === root || key.startsWith(`${root}/`)));
  }

  class Conflict extends Error {}
  const fail = (summary: string): never => {
    throw new Conflict(summary);
  };

  function list(path: string, recursive: boolean) {
    const node = nodes.get(lower(path));
    if (!node) fail("path/not_found/..");
    if (!node!.folder) fail("path/not_folder/..");
    const root = lower(path);
    const all = [...nodes.entries()]
      .filter(([key]) => key !== "" && key !== root && (root === "" || key.startsWith(`${root}/`)))
      .filter(([key]) => recursive || parentOf(key) === root)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => entry(value));
    // Like Dropbox, a recursive listing of a folder includes the folder itself.
    return recursive && root ? [entry(node!), ...all] : all;
  }

  function page(state: { path: string; recursive: boolean; limit: number; offset: number }) {
    const all = list(state.path, state.recursive);
    const entries = all.slice(state.offset, state.offset + state.limit);
    const offset = state.offset + entries.length;
    const cursor = Buffer.from(JSON.stringify({ ...state, offset })).toString("base64url");
    return { entries, cursor, has_more: offset < all.length };
  }

  function put(path: string, bytes: Buffer) {
    const existing = nodes.get(lower(path));
    if (existing?.folder) fail("path/conflict/folder/..");
    ensureParents(path);
    const node = { display: path, folder: false, bytes, modified: new Date().toISOString() };
    nodes.set(lower(path), node);
    return entry(node);
  }

  function transfer(from: string, to: string, move: boolean) {
    if (!nodes.has(lower(from)) || !lower(from)) fail("from_lookup/not_found/..");
    if (nodes.has(lower(to))) fail("to/conflict/file/..");
    ensureParents(to);
    for (const key of subtree(from)) {
      const node = nodes.get(key)!;
      const display = to + node.display.slice(from.length);
      nodes.set(lower(display), { ...node, display });
      if (move) nodes.delete(key);
    }
    return { metadata: entry(nodes.get(lower(to))!) };
  }

  let range: string | undefined; // the current request's Range header, for downloads
  const routes: Record<string, (args: Record<string, unknown>, body: Buffer, res: ServerResponse) => unknown> = {
    "users/get_current_account": () => ({ email: "mock@example.com" }),
    "files/list_folder": (a) =>
      page({ path: String(a.path), recursive: Boolean(a.recursive), limit: Math.min(Number(a.limit ?? 2000), 2000), offset: 0 }),
    "files/list_folder/continue": (a) => page(JSON.parse(Buffer.from(String(a.cursor), "base64url").toString())),
    "files/get_metadata": (a) => {
      const node = nodes.get(lower(String(a.path)));
      return node ? entry(node) : fail("path/not_found/..");
    },
    "files/create_folder_v2": (a) => {
      const path = String(a.path);
      if (nodes.has(lower(path))) fail(`path/conflict/${nodes.get(lower(path))!.folder ? "folder" : "file"}/..`);
      ensureParents(path);
      nodes.set(lower(path), { display: path, folder: true, modified: new Date().toISOString() });
      return { metadata: entry(nodes.get(lower(path))!) };
    },
    "files/upload": (a, body) => put(String(a.path), body),
    "files/upload_session/start": (_a, body) => {
      const id = randomUUID();
      sessions.set(id, [body]);
      return { session_id: id };
    },
    "files/upload_session/append_v2": (a, body) => {
      const cursor = a.cursor as { session_id: string; offset: number };
      const parts = sessions.get(cursor.session_id) ?? fail("lookup_failed/not_found/..");
      const have = parts!.reduce((sum, part) => sum + part.length, 0);
      if (have !== cursor.offset) fail("lookup_failed/incorrect_offset/..");
      parts!.push(body);
      return null;
    },
    "files/upload_session/finish": (a, body) => {
      const cursor = a.cursor as { session_id: string; offset: number };
      const parts = sessions.get(cursor.session_id) ?? fail("lookup_failed/not_found/..");
      if (parts!.reduce((sum, part) => sum + part.length, 0) !== cursor.offset) fail("lookup_failed/incorrect_offset/..");
      sessions.delete(cursor.session_id);
      return put(String((a.commit as { path: string }).path), Buffer.concat([...parts!, body]));
    },
    "files/download": (a, _body, res) => {
      const node = nodes.get(lower(String(a.path)));
      if (!node) fail("path/not_found/..");
      if (node!.folder) fail("path/not_file/..");
      const bytes = node!.bytes!;
      const headers = { "content-type": "application/octet-stream", "dropbox-api-result": JSON.stringify(entry(node!)) };
      // Dropbox honours a single Range on downloads, like any HTTP server.
      const wanted = /^bytes=(\d+)-(\d*)$/.exec(String(range ?? ""));
      if (wanted) {
        const start = Number(wanted[1]);
        const end = Math.min(wanted[2] ? Number(wanted[2]) : bytes.length - 1, bytes.length - 1);
        if (start >= bytes.length) {
          res.writeHead(416, { "content-range": `bytes */${bytes.length}` });
          res.end();
          return undefined;
        }
        res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": String(end - start + 1) });
        res.end(bytes.subarray(start, end + 1));
        return undefined;
      }
      res.writeHead(200, { ...headers, "content-length": String(bytes.length) });
      res.end(bytes);
      return undefined;
    },
    "files/delete_batch": (a) => {
      const entries = (a.entries as { path: string }[]).map(({ path }) => {
        if (!nodes.has(lower(path)) || !lower(path))
          return { ".tag": "failure", failure: { ".tag": "path_lookup", path_lookup: { ".tag": "not_found" } } };
        for (const key of subtree(path)) nodes.delete(key);
        return { ".tag": "success", metadata: {} };
      });
      const id = randomUUID();
      jobs.set(id, { polls: 0, result: { ".tag": "complete", entries } });
      return { ".tag": "async_job_id", async_job_id: id };
    },
    "files/delete_batch/check": (a) => {
      const job = jobs.get(String(a.async_job_id)) ?? fail("invalid_async_job_id/..");
      // Not done on the first poll, as with real batch jobs.
      return job!.polls++ === 0 ? { ".tag": "in_progress" } : job!.result;
    },
    "files/copy_v2": (a) => transfer(String(a.from_path), String(a.to_path), false),
    "files/move_v2": (a) => transfer(String(a.from_path), String(a.to_path), true),
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };

    if (req.url === "/oauth2/token") {
      const form = new URLSearchParams(body.toString());
      // The shapes Dropbox really answers with (checked against api.dropboxapi.com).
      if (form.get("client_id") !== MOCK_APP_KEY) return json(400, { error: "invalid_client: Invalid client_id" });
      const ok =
        form.get("grant_type") === "refresh_token"
          ? form.get("refresh_token") === MOCK_REFRESH_TOKEN
          : form.get("code") === MOCK_CODE && (form.get("code_verifier") ?? "").length >= 43;
      if (!ok) return json(400, { error: "invalid_grant" });
      return json(200, {
        access_token: `access-${randomUUID()}`,
        expires_in: 14400,
        token_type: "bearer",
        ...(form.get("grant_type") === "authorization_code" ? { refresh_token: MOCK_REFRESH_TOKEN } : {}),
      });
    }

    const route = req.url?.replace(/^\/2\//, "") ?? "";
    const handler = routes[route];
    if (!handler) return json(404, { error_summary: "not_found" });
    if (!/^Bearer access-/.test(req.headers.authorization ?? ""))
      return json(401, { error_summary: "invalid_access_token/", error: { ".tag": "invalid_access_token" } });

    // Writes are throttled now and then, as Dropbox does under load.
    if (/upload$|create_folder/.test(route) && ++uploads % 40 === 0) {
      stats.throttled++;
      return json(429, { error_summary: "too_many_write_operations/" }, { "retry-after": "0" });
    }

    range = req.headers.range;
    const header = req.headers["dropbox-api-arg"];
    let args: Record<string, unknown>;
    try {
      args = header ? JSON.parse(String(header)) : body.length ? JSON.parse(body.toString()) : {};
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      return res.end("Error in call: could not decode input as JSON");
    }
    try {
      const out = handler(args, header ? body : Buffer.alloc(0), res);
      if (out !== undefined) json(200, out);
    } catch (error) {
      if (error instanceof Conflict) return json(409, { error_summary: error.message, error: {} });
      throw error;
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error("[dropbox-mock]", error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close(), stats };
}
