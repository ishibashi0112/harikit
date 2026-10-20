// HTTP の入口（rest スタイル、仕様 1.1）。POST /describe、/fetch、/apply を受ける。
// 画面（packages/web）を渡されたときは、その静的ファイルも GET で配る。データは API からしか出ない。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Handlers } from "./handlers.js";

export interface StaticFile {
  type: string;
  body: Buffer;
}

export interface HttpOptions {
  /** Authorization: Bearer に求めるトークン。 */
  token: string;
  /** 本文の上限（バイト）。既定は 32MB。 */
  maxBodyBytes?: number;
  /** GET で配るファイル（"/main.js" → 中身。"/" は index.html）。 */
  files?: ReadonlyMap<string, StaticFile>;
}

/** 画面に許すこと。通信は同じオリジン（このサーバ）だけで、外には出さない。 */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function sendFile(req: IncomingMessage, res: ServerResponse, file: StaticFile): void {
  res.writeHead(200, {
    "Content-Type": file.type,
    "Content-Length": file.body.length,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": PAGE_CSP,
    "Referrer-Policy": "no-referrer",
  });
  res.end(req.method === "HEAD" ? undefined : file.body);
}

const ROUTES = new Set(["describe", "fetch", "apply"]);

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createHttpServer(handlers: Handlers, options: HttpOptions): Server {
  const limit = options.maxBodyBytes ?? 32 * 1024 * 1024;
  return createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").replace(/[?#].*$/, "");
      if (req.method === "GET" || req.method === "HEAD") {
        const file = options.files?.get(path);
        return file ? sendFile(req, res, file) : send(res, 404, { message: "not found" });
      }
      const name = path.replace(/^\/+/, "");
      if (req.method !== "POST" || !ROUTES.has(name)) return send(res, 404, { message: "not found" });
      if (!tokenOk(req.headers.authorization, options.token)) return send(res, 401, { message: "token required" });
      if (req.headers["x-patchiri"] !== "1") return send(res, 403, { message: "X-Patchiri: 1 header required" });
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return send(res, 415, { message: "application/json required" });
      const body = await readBody(req, limit);
      if (body === null) return send(res, 413, { message: "request too large" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return send(res, 200, { ok: false, v: 1, error: { code: "bad_request", message: "JSON として読めません" } });
      }
      send(res, 200, await handlers.handle(name as "describe" | "fetch" | "apply", parsed));
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { message: "internal error" });
    }
  });
}
