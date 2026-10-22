// 設定ファイルを読む。

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { checkConfig, type ServerConfig } from "./config.js";

export async function loadConfig(path: string): Promise<ServerConfig> {
  const config = JSON.parse(await readFile(path, "utf8")) as ServerConfig;
  if (process.env.PATCHIRI_DB_PASSWORD) config.database.password = process.env.PATCHIRI_DB_PASSWORD;
  // 業務ルールはファイルのパス（設定ファイルのフォルダから）でも書ける。
  if (typeof config.rules === "string") {
    const file = resolve(dirname(path), config.rules);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      throw new Error(`設定の誤り: rules のファイル ${file} が読めません（${e instanceof Error ? e.message : String(e)}）`);
    }
    try {
      config.rules = JSON.parse(text) as ServerConfig["rules"];
    } catch (e) {
      throw new Error(`設定の誤り: rules のファイル ${file} が JSON として読めません（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  checkConfig(config);
  return config;
}
