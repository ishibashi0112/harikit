// 設定からサーバを組み立てて起動する。

import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import type { AddressInfo } from "node:net";
import type { ServerConfig } from "./config.js";
import type { Dialect } from "./dialect.js";
import { Handlers } from "./handlers.js";
import { createHttpServer } from "./http.js";
import { fileLogger } from "./log.js";
import { SqlServerDialect } from "./mssql.js";

export interface StartOptions {
  /** 省くと乱数で作る。 */
  token?: string;
  /** テスト用に方言を差し替える。 */
  dialect?: Dialect;
}

export interface RunningServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

export async function startServer(config: ServerConfig, options: StartOptions = {}): Promise<RunningServer> {
  const dialect = options.dialect ?? new SqlServerDialect(config.database);
  const token = options.token ?? randomBytes(24).toString("base64url");
  const handlers = new Handlers({
    config,
    dialect,
    whoAmI: () => userInfo().username,
    log: fileLogger(config.logDir ?? "harikit-log"),
    logError: (e) => console.error(e),
  });
  const server = createHttpServer(handlers, { token });
  const host = config.listen?.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen?.port ?? 7357, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    token,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await dialect.close();
    },
  };
}
