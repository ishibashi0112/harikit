// サーバの設定（許可リスト、接続先、待ち受け）。仕様 2 の許可リストを含む。

import { readFile } from "node:fs/promises";
import type { Access, Limits } from "@harikit/core";

export interface TargetConfig {
  table: string;
  access: Access;
  /** 省くと DB の主キー。 */
  key?: string[];
  readable: string[];
  updatable?: string[];
}

export interface SqlServerConnection {
  dialect: "sqlserver";
  server: string;
  port?: number;
  database: string;
  user?: string;
  /** 設定ファイルに書かず、環境変数 HARIKIT_DB_PASSWORD で渡してもよい。 */
  password?: string;
  options?: { encrypt?: boolean; trustServerCertificate?: boolean; instanceName?: string };
}

export interface OracleConnection {
  dialect: "oracle";
  /** つなぐ先。"host:1521/サービス名"（Easy Connect）か、tnsnames.ora の別名。 */
  connectString: string;
  user: string;
  /** 設定ファイルに書かず、環境変数 HARIKIT_DB_PASSWORD で渡してもよい。 */
  password?: string;
  /** tnsnames.ora を置いたフォルダ（別名でつなぐとき）。 */
  configDir?: string;
  /**
   * Oracle Client（Instant Client）を使う Thick モードにする。既定は Client の要らない Thin モードで、
   * Thin モードでつながらない古い DB（11g など）のときだけ使う。libDir は Windows と macOS での Client のフォルダ。
   */
  thick?: boolean | { libDir?: string };
  /** 反映のとき、ほかのセッションがロックしている行を待つ秒数。既定は 10。 */
  lockWaitSeconds?: number;
}

export type DatabaseConnection = SqlServerConnection | OracleConnection;

export interface ServerConfig {
  listen?: { host?: string; port?: number };
  database: DatabaseConnection;
  targets: Record<string, TargetConfig>;
  limits?: Partial<Limits>;
  /** 反映ログ（JSON Lines）を置くフォルダ。既定は ./harikit-log。 */
  logDir?: string;
  /** db_error の message に DB の生のエラー文を出すか。既定は出さない。 */
  exposeDbErrors?: boolean;
}

export const DEFAULT_LIMITS: Limits = { maxFetchKeys: 1000, maxApplyRows: 5000 };

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string" && s.length > 0);

/** 許可リストの形を確かめる。おかしければ起動時に止める。 */
export function checkConfig(config: ServerConfig): void {
  const fail = (m: string): never => {
    throw new Error(`設定の誤り: ${m}`);
  };
  const db = config.database;
  if (!db || (db.dialect !== "sqlserver" && db.dialect !== "oracle")) fail("database.dialect は \"sqlserver\" か \"oracle\" です");
  if (db.dialect === "oracle") {
    if (typeof db.connectString !== "string" || !db.connectString) fail("database.connectString がありません（例 \"localhost:1521/FREEPDB1\"）");
    if (typeof db.user !== "string" || !db.user) fail("database.user がありません");
    if (db.lockWaitSeconds !== undefined && !(Number.isInteger(db.lockWaitSeconds) && db.lockWaitSeconds >= 1)) fail("database.lockWaitSeconds は 1 以上の整数です");
  }
  if (!config.targets || typeof config.targets !== "object") fail("targets がありません");
  for (const [name, t] of Object.entries(config.targets)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) fail(`ターゲット名 ${name} に使えない文字があります`);
    if (typeof t.table !== "string" || !t.table) fail(`${name}.table がありません`);
    if (t.access !== "update" && t.access !== "read") fail(`${name}.access は "update" か "read" です`);
    if (!isStringArray(t.readable)) fail(`${name}.readable は列名の配列です`);
    const readable = new Set(t.readable.map((c) => c.toLowerCase()));
    if (t.key !== undefined) {
      if (!isStringArray(t.key) || t.key.length === 0) fail(`${name}.key は列名の配列です`);
      for (const k of t.key) if (!readable.has(k.toLowerCase())) fail(`${name}.key の ${k} が readable にありません`);
    }
    if (t.updatable !== undefined) {
      if (!isStringArray(t.updatable)) fail(`${name}.updatable は列名の配列です`);
      if (t.access !== "update" && t.updatable.length > 0) fail(`${name} は read なので updatable を持てません`);
      for (const c of t.updatable) if (!readable.has(c.toLowerCase())) fail(`${name}.updatable の ${c} が readable にありません`);
      for (const c of t.updatable) if (t.key?.some((k) => k.toLowerCase() === c.toLowerCase())) fail(`${name} のキー列 ${c} は更新できません`);
    }
  }
}

export async function loadConfig(path: string): Promise<ServerConfig> {
  const config = JSON.parse(await readFile(path, "utf8")) as ServerConfig;
  if (process.env.HARIKIT_DB_PASSWORD) config.database.password = process.env.HARIKIT_DB_PASSWORD;
  checkConfig(config);
  return config;
}
