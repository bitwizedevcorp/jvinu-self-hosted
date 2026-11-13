/**
 * An in-memory stand-in for the parts of Microsoft Graph (and the Microsoft sign-in
 * endpoints) the OneDrive driver uses — path addressing, paged children, redirected
 * downloads, upload sessions, monitored copies, rotating refresh tokens, the device-code
 * flow — so the contract suite runs without an account. It mirrors the documented
 * behaviour; it can't prove Graph itself still behaves that way, which is what the
 * live-account mode is for.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Node = { id: string; display: string; folder: boolean; bytes?: Buffer; modified: string };

export const MOCK_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
export const MOCK_TENANT = "common";
export const MOCK_REFRESH_TOKEN = "mock-refresh-0";
export const MOCK_USER_CODE = "MOCK1234";
const FRAGMENT = 320 * 1024;

export async function startOneDriveMock(): Promise<{
  url: string;
  close: () => void;
  stats: { throttled: number; refreshes: number; sessionsCancelled: number };
  /** Marks the pending device sign-in as approved (or declined) by the user. */
  answerDeviceCode: (answer: "approve" | "decline") => void;
}> {
  const nodes = new Map<string, Node>(); // lower-cased path → node; "" is the root
  nodes.set("", { id: "root", display: "", folder: true, modified: new Date().toISOString() });
  const sessions = new Map<string, { path: string; total: number; parts: Buffer[] }>();
  const copies = new Map<string, { polls: number; error?: string }>();
  const devices = new Map<string, "pending" | "approve" | "decline" | "used">();
  const stats = { throttled: 0, refreshes: 0, sessionsCancelled: 0 };
  let writes = 0;
  let origin = "";

  const lower = (path: string) => path.toLowerCase().replace(/\/$/, "");
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const byId = (id: string) => [...nodes.values()].find((node) => node.id === id);
  const childrenOf = (path: string) =>
    [...nodes.entries()]
      .filter(([key]) => key !== "" && parentOf(key) === lower(path))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, node]) => node);
  const subtree = (path: string) => [...nodes.keys()].filter((key) => key !== "" && (key === lower(path) || key.startsWith(`${lower(path)}/`)));

  function item(node: Node) {
    const parent = node.display ? nodes.get(lower(parentOf(node.display))) : undefined;
    return {
      id: node.id,
      name: node.display ? nameOf(node.display) : "root",
      lastModifiedDateTime: node.modified,
      parentReference: { driveId: "mock-drive", ...(parent ? { id: parent.id } : {}) },
      ...(node.folder
        ? { folder: { childCount: childrenOf(node.display).length }, size: 0 }
        : { file: { mimeType: "application/octet-stream", hashes: { sha256Hash: `HASH${node.bytes!.length}` } }, size: node.bytes!.length }),
    };
  }

  class Failure extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
    ) {
      super(code);
    }
  }
  const fail = (status: number, code: string): never => {
    throw new Failure(status, code);
  };

  function ensureParents(path: string) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const display = `/${parts.slice(0, i).join("/")}`;
      const existing = nodes.get(lower(display));
      if (existing && !existing.folder) fail(409, "nameAlreadyExists");
      if (!existing) nodes.set(lower(display), { id: randomUUID(), display, folder: true, modified: new Date().toISOString() });
    }
  }

  /** Uploading to a path creates the folders above it, as OneDrive does. */
  function put(path: string, bytes: Buffer) {
    const existing = nodes.get(lower(path));
    if (existing?.folder) fail(409, "nameAlreadyExists");
    ensureParents(path);
    const node = { id: existing?.id ?? randomUUID(), display: path, folder: false, bytes, modified: new Date().toISOString() };
    nodes.set(lower(path), node);
    return item(node);
  }

  function transfer(from: string, to: string, move: boolean) {
    for (const key of subtree(from)) {
      const node = nodes.get(key)!;
      const display = to + node.display.slice(from.length);
      if (move) nodes.delete(key);
      nodes.set(lower(display), { ...node, id: move ? node.id : randomUUID(), display });
    }
  }

  const need = (path: string): Node => nodes.get(lower(path)) ?? fail(404, "itemNotFound");

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", origin);
    const method = req.method ?? "GET";
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const error = (status: number, code: string) => json(status, { error: { code, message: `Mock: ${code}` } });

    /* ---- Sign-in ------------------------------------------------------------- */
    const login = /^\/([^/]+)\/oauth2\/v2\.0\/(token|devicecode)$/.exec(url.pathname);
    if (login) {
      const form = new URLSearchParams(body.toString());
      if (form.get("client_id") !== MOCK_CLIENT_ID || login[1] !== MOCK_TENANT)
        return json(400, { error: "unauthorized_client", error_description: "AADSTS700016: Application was not found in the directory. Trace ID: 0000" });
      if (login[2] === "devicecode") {
        const deviceCode = `device-${randomUUID()}`;
        devices.set(deviceCode, "pending");
        return json(200, {
          device_code: deviceCode,
          user_code: MOCK_USER_CODE,
          verification_uri: "https://microsoft.com/devicelogin",
          expires_in: 900,
          interval: 5,
          message: "To sign in, use a web browser…",
        });
      }
      const tokens = (refreshToken: string) => ({ token_type: "Bearer", access_token: `access-${randomUUID()}`, expires_in: 3600, refresh_token: refreshToken });
      if (form.get("grant_type") === "refresh_token") {
        if (!/^mock-refresh-\d+$/.test(form.get("refresh_token") ?? "")) return json(400, { error: "invalid_grant", error_description: "AADSTS70000: The refresh token has expired." });
        // Every refresh hands back a new refresh token, as Microsoft does.
        return json(200, tokens(`mock-refresh-${++stats.refreshes}`));
      }
      const state = devices.get(form.get("device_code") ?? "");
      if (!state || state === "used") return json(400, { error: "expired_token" });
      if (state === "pending") return json(400, { error: "authorization_pending" });
      if (state === "decline") return json(400, { error: "authorization_declined" });
      devices.set(form.get("device_code")!, "used");
      return json(200, tokens(MOCK_REFRESH_TOKEN));
    }

    /* ---- Pre-authenticated URLs: no bearer token, and none must be sent ---------- */
    const plain = /^\/(download|upload|monitor)\/([^/]+)$/.exec(url.pathname);
    if (plain) {
      if (req.headers.authorization) return error(401, "unauthenticated");
      const [, kind, id] = plain;
      if (kind === "download") {
        const node = byId(id);
        if (!node?.bytes) return error(404, "itemNotFound");
        const bytes = node.bytes;
        const wanted = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
        if (!wanted) {
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length) });
          return void res.end(bytes);
        }
        const start = Number(wanted[1]);
        const end = Math.min(wanted[2] ? Number(wanted[2]) : bytes.length - 1, bytes.length - 1);
        if (start >= bytes.length) {
          res.writeHead(416, { "content-range": `bytes */${bytes.length}` });
          return void res.end();
        }
        res.writeHead(206, {
          "content-type": "application/octet-stream",
          "content-range": `bytes ${start}-${end}/${bytes.length}`,
          "content-length": String(end - start + 1),
        });
        return void res.end(bytes.subarray(start, end + 1));
      }
      if (kind === "upload") {
        const session = sessions.get(id);
        if (!session) return error(404, "itemNotFound");
        if (method === "DELETE") {
          sessions.delete(id);
          stats.sessionsCancelled++;
          return json(204, undefined);
        }
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers["content-range"] ?? ""));
        const have = session.parts.reduce((sum, part) => sum + part.length, 0);
        if (range && session.total === -1) session.total = Number(range[3]);
        if (!range || Number(range[1]) !== have || Number(range[2]) - Number(range[1]) + 1 !== body.length || Number(range[3]) !== session.total)
          return error(416, "invalidRange");
        const last = have + body.length === session.total;
        if (have + body.length > session.total) return error(416, "invalidRange");
        // Every fragment but the last must be a multiple of 320 KiB.
        if (!last && body.length % FRAGMENT !== 0) return error(400, "invalidRequest");
        session.parts.push(body);
        if (!last) return json(202, { nextExpectedRanges: [`${have + body.length}-`] });
        sessions.delete(id);
        try {
          return json(201, put(session.path, Buffer.concat(session.parts)));
        } catch (caught) {
          if (caught instanceof Failure) return error(caught.status, caught.code);
          throw caught;
        }
      }
      const copy = copies.get(id);
      if (!copy) return error(404, "itemNotFound");
      // Not done on the first poll, as with real copies.
      if (copy.polls++ === 0) return json(202, { status: "inProgress", percentageComplete: 10 });
      return copy.error
        ? json(200, { status: "failed", error: { code: copy.error, message: `Mock: ${copy.error}` } })
        : json(200, { status: "completed", percentageComplete: 100 });
    }

    /* ---- Graph ----------------------------------------------------------------- */
    if (!/^Bearer access-/.test(req.headers.authorization ?? "")) return error(401, "InvalidAuthenticationToken");
    if (url.pathname === "/v1.0/me") return json(200, { userPrincipalName: "mock@example.com", mail: null });

    const rest = url.pathname.startsWith("/v1.0/me/drive/root") ? url.pathname.slice("/v1.0/me/drive/root".length) : null;
    if (rest === null) return error(400, "BadRequest");
    // "" | "/children" | ":/a/b:" | ":/a/b:/children" — the path is percent-encoded, so it holds no ":".
    let path = "";
    let action = rest;
    if (rest.startsWith(":")) {
      const end = rest.indexOf(":", 1);
      path = decodeURIComponent(end === -1 ? rest.slice(1) : rest.slice(1, end)).replace(/\/$/, "");
      action = end === -1 ? "" : rest.slice(end + 1);
    }

    // Writes are throttled now and then, as Graph does under load.
    if (method !== "GET" && ++writes % 40 === 0) {
      stats.throttled++;
      return json(429, { error: { code: "activityLimitReached", message: "Mock: throttled" } }, { "retry-after": "0" });
    }

    try {
      if (action === "" && method === "GET") return json(200, item(need(path)));

      if (action === "" && method === "DELETE") {
        if (!path) return error(400, "invalidRequest");
        need(path);
        for (const key of subtree(path)) nodes.delete(key);
        return json(204, undefined);
      }

      if (action === "" && method === "PATCH") {
        const node = need(path);
        const change = JSON.parse(body.toString()) as { name?: string; parentReference?: { id?: string } };
        const parent = change.parentReference?.id ? (byId(change.parentReference.id) ?? fail(404, "itemNotFound")) : nodes.get(lower(parentOf(node.display)))!;
        if (!parent.folder) fail(400, "invalidRequest");
        const to = `${parent.display}/${change.name ?? nameOf(node.display)}`;
        if (lower(to) !== lower(node.display) && nodes.has(lower(to))) fail(409, "nameAlreadyExists");
        transfer(node.display, to, true);
        return json(200, item(nodes.get(lower(to))!));
      }

      if (action === "/children" && method === "GET") {
        const folder = need(path);
        if (!folder.folder) fail(400, "invalidRequest");
        const all = childrenOf(path);
        const top = Math.min(Number(url.searchParams.get("$top") ?? 200), 999);
        const skip = Number(url.searchParams.get("$skiptoken") ?? 0);
        const next = new URL(url.href);
        next.searchParams.set("$skiptoken", String(skip + top));
        return json(200, {
          value: all.slice(skip, skip + top).map(item),
          ...(skip + top < all.length ? { "@odata.nextLink": next.href } : {}),
        });
      }

      if (action === "/children" && method === "POST") {
        const parent = need(path);
        if (!parent.folder) fail(400, "invalidRequest");
        const { name } = JSON.parse(body.toString()) as { name: string };
        const display = `${parent.display}/${name}`;
        if (nodes.has(lower(display))) fail(409, "nameAlreadyExists");
        const node = { id: randomUUID(), display, folder: true, modified: new Date().toISOString() };
        nodes.set(lower(display), node);
        return json(201, item(node));
      }

      if (action === "/content" && method === "PUT") return json(201, put(path, body));

      if (action === "/content" && method === "GET") {
        const node = need(path);
        if (node.folder) fail(400, "invalidRequest");
        res.writeHead(302, { location: `${origin}/download/${node.id}` });
        return void res.end();
      }

      if (action === "/createUploadSession" && method === "POST") {
        if (nodes.get(lower(path))?.folder) fail(409, "nameAlreadyExists");
        const id = randomUUID();
        // The total arrives with the first fragment's Content-Range.
        sessions.set(id, { path, total: -1, parts: [] });
        return json(200, { uploadUrl: `${origin}/upload/${id}`, expirationDateTime: new Date(Date.now() + 3_600_000).toISOString() });
      }

      if (action === "/copy" && method === "POST") {
        const node = need(path);
        const request = JSON.parse(body.toString()) as { name?: string; parentReference?: { id?: string } };
        const parent = byId(request.parentReference?.id ?? "") ?? fail(404, "itemNotFound");
        const to = `${parent.display}/${request.name ?? nameOf(node.display)}`;
        const id = randomUUID();
        // A name clash only shows up when the monitor is polled: copies run in the background.
        if (nodes.has(lower(to))) copies.set(id, { polls: 0, error: "nameAlreadyExists" });
        else {
          transfer(node.display, to, false);
          copies.set(id, { polls: 0 });
        }
        res.writeHead(202, { location: `${origin}/monitor/${id}` });
        return void res.end();
      }

      return error(400, "BadRequest");
    } catch (caught) {
      if (caught instanceof Failure) return error(caught.status, caught.code);
      throw caught;
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error("[onedrive-mock]", error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    url: origin,
    close: () => server.close(),
    stats,
    answerDeviceCode: (answer) => {
      for (const [code, state] of devices) if (state === "pending") devices.set(code, answer);
    },
  };
}
