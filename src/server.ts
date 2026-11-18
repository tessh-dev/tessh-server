// node:http glue: IncomingMessage -> Request, a `(Request) => Promise<Response>` handler, Response -> ServerResponse.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIPv4 } from "node:net";
import { CLIENT_IP_HEADER } from "./http.ts";

export type Handler = (req: Request) => Promise<Response>;

/** Bodies over this are refused before they are read in full. The API itself takes at most 1 MiB. */
const MAX_BODY = 2 * 1024 * 1024;

class TooLarge extends Error {}

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(",")[0]?.trim() || undefined;
}

function forwardedChain(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v.join(",") : v;
}

/** The URL the client used. Behind a reverse proxy, X-Forwarded-Proto and X-Forwarded-Host say what that was. */
export function requestURL(req: IncomingMessage): string {
  const proto = first(req.headers["x-forwarded-proto"]) === "https" ? "https" : "http";
  const host = first(req.headers["x-forwarded-host"]) ?? req.headers.host ?? "localhost";
  const safeHost = /^[A-Za-z0-9.:[\]-]+$/.test(host) ? host : "localhost";
  const path = req.url?.startsWith("/") ? req.url : "/";
  return `${proto}://${safeHost}${path}`;
}

/** Loopback and private addresses: a reverse proxy on this machine or network, whose X-Forwarded-For can be trusted. */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^::ffff:/, "");
  if (isIPv4(a)) {
    const [p, q] = a.split(".").map(Number) as [number, number];
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168);
  }
  return a === "::1" || /^f[cd][0-9a-f]{2}:/.test(a);
}

/** The client's address: the socket's, unless that is a local proxy, then the last X-Forwarded-For entry (the one the proxy saw). */
export function clientAddress(remote: string | undefined, forwardedFor: string | undefined): string {
  const socket = remote ?? "unknown";
  if (!remote || !isPrivateAddress(remote)) return socket;
  const last = forwardedFor?.split(",").pop()?.trim();
  return last || socket;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new TooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new TooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k.startsWith(":")) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.set(k, v);
  }
  headers.delete(CLIENT_IP_HEADER);
  headers.set(CLIENT_IP_HEADER, clientAddress(req.socket.remoteAddress, forwardedChain(req.headers["x-forwarded-for"])));
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;
  return new Request(requestURL(req), { method, headers, body });
}

async function send(res: ServerResponse, r: Response, head: boolean): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const setCookie = r.headers.getSetCookie();
  if (setCookie.length) headers["set-cookie"] = setCookie;
  const body = head || r.body === null ? null : Buffer.from(await r.arrayBuffer());
  if (body && !("content-length" in headers)) headers["content-length"] = String(body.length);
  res.writeHead(r.status, headers);
  res.end(body ?? undefined);
}

function plain(res: ServerResponse, status: number, body: object): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(s)) });
  res.end(s);
}

export function serve(handler: Handler, log: (msg: string) => void = console.error): Server {
  const server = createServer(async (req, res) => {
    try {
      const request = await toRequest(req);
      const response = await handler(request);
      await send(res, response, req.method === "HEAD");
    } catch (e) {
      if (e instanceof TooLarge) return plain(res, 413, { error: "invalid_request", message: "Request body too large" });
      // Never log bodies or headers: they carry tokens and encrypted vault data.
      log(`error: ${req.method} ${(req.url ?? "").split("?")[0]}: ${(e as Error)?.stack ?? String(e)}`);
      if (!res.headersSent) plain(res, 500, { error: "internal", message: "Internal server error" });
      else res.destroy();
    }
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  return server;
}
