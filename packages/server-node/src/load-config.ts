// 設定ファイルを読む。

import { readFile } from "node:fs/promises";
import { checkConfig, type ServerConfig } from "./config.js";

export async function loadConfig(path: string): Promise<ServerConfig> {
  const config = JSON.parse(await readFile(path, "utf8")) as ServerConfig;
  if (process.env.HARIKIT_DB_PASSWORD) config.database.password = process.env.HARIKIT_DB_PASSWORD;
  checkConfig(config);
  return config;
}
