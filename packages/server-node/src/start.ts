// 設定からサーバを組み立てて起動する。

import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, extname, join, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type { ServerConfig } from "./config.js";
import type { Dialect } from "./dialect.js";
import { Handlers } from "./handlers.js";
import { createHttpServer, type StaticFile } from "./http.js";
import { fileLogger } from "./log.js";
import { SqlServerDialect } from "./mssql.js";
import { MySqlDialect } from "./mysql.js";
import { OracleDialect } from "./oracle.js";
import { PgPoolConnector } from "./pg-pool.js";
import { PostgresDialect } from "./postgres.js";

export interface StartOptions {
  /** 省くと乱数で作る。 */
  token?: string;
  /** テスト用に方言を差し替える。 */
  dialect?: Dialect;
  /** 配る画面のフォルダ。省くとビルドした patchiri-web、false で配らない。 */
  web?: string | false;
}

export interface RunningServer {
  url: string;
  token: string;
  /** 画面を開く URL（トークンつき）。画面が無ければ null。 */
  webUrl: string | null;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** ビルドした画面（patchiri-web の dist/app）のフォルダ。入っていなければ null。 */
export function defaultWebDir(): string | null {
  try {
    return join(dirname(createRequire(import.meta.url).resolve("patchiri-web/package.json")), "dist", "app");
  } catch {
    return null;
  }
}

/** フォルダの中身を、配るファイルの表にする（起動時に読んでおく）。index.html が無ければ null。 */
export async function loadWebFiles(dir: string): Promise<Map<string, StaticFile> | null> {
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch {
    return null;
  }
  const files = new Map<string, StaticFile>();
  for (const name of names) {
    const type = TYPES[extname(name).toLowerCase()];
    if (!type) continue;
    const body = await readFile(join(dir, name)).catch(() => null);
    if (body) files.set("/" + name.split(sep).join("/"), { type, body });
  }
  const index = files.get("/index.html");
  if (!index) return null;
  files.set("/", index);
  return files;
}

/** 設定の database.dialect に合う方言を作る。 */
export function createDialect(database: ServerConfig["database"]): Dialect {
  switch (database.dialect) {
    case "oracle":
      return new OracleDialect(database);
    case "postgresql":
      return new PostgresDialect(new PgPoolConnector(database), { ...(database.lockWaitSeconds !== undefined && { lockWaitSeconds: database.lockWaitSeconds }) });
    case "mysql":
      return new MySqlDialect(database);
    default:
      return new SqlServerDialect(database);
  }
}

export async function startServer(config: ServerConfig, options: StartOptions = {}): Promise<RunningServer> {
  const dialect = options.dialect ?? createDialect(config.database);
  const token = options.token ?? randomBytes(24).toString("base64url");
  const handlers = new Handlers({
    config,
    dialect,
    whoAmI: () => userInfo().username,
    log: fileLogger(config.logDir ?? "patchiri-log"),
    logError: (e) => console.error(e),
  });
  const webDir = options.web === undefined ? defaultWebDir() : options.web;
  const files = webDir ? await loadWebFiles(webDir) : null;
  const server = createHttpServer(handlers, { token, ...(files && { files }) });
  const host = config.listen?.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen?.port ?? 7357, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return {
    url,
    token,
    // トークンは # の後ろに置く（サーバのログや Referer に出ない）。画面が読んでアドレス欄から消す。
    webUrl: files ? `${url}/#token=${token}` : null,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await dialect.close();
    },
  };
}
