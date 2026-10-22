// サーバの設定（許可リスト、接続先、待ち受け）。仕様 2 の許可リストを含む。
// handlers がブラウザでも動くよう、ここでは node: のモジュールを使わない（ファイルから読むのは load-config.ts）。

import type { Access, Limits, RulesConfig } from "patchiri-core";

export interface TargetConfig {
  table: string;
  access: Access;
  /** 省くと DB の主キー。 */
  key?: string[];
  readable: string[];
  updatable?: string[];
  /** 列の表示名（{ "UnitPrice": "単価" }）。取込の見出しは列名でもこれでもよい。 */
  labels?: Record<string, string>;
  /** 反映する行ごとにサーバが入れる列。"now" は DB の今の時刻、"user" は反映した人。 */
  stamp?: Record<string, "now" | "user">;
  /** このターゲットで触れる行の固定の条件（等号だけ）。外の行は見えない。 */
  scope?: Record<string, string | number | boolean>;
  /** このターゲットを使えるロール（どれか 1 つ）。判定は HandlerDeps.isInRole。 */
  roles?: string[];
}

export interface SqlServerConnection {
  dialect: "sqlserver";
  server: string;
  port?: number;
  database: string;
  user?: string;
  /** 設定ファイルに書かず、環境変数 PATCHIRI_DB_PASSWORD で渡してもよい。 */
  password?: string;
  options?: { encrypt?: boolean; trustServerCertificate?: boolean; instanceName?: string };
  /** 反映のとき、ほかのセッションがロックしている行を待つ秒数。既定は 10。 */
  lockWaitSeconds?: number;
}

export interface OracleConnection {
  dialect: "oracle";
  /** つなぐ先。"host:1521/サービス名"（Easy Connect）か、tnsnames.ora の別名。 */
  connectString: string;
  user: string;
  /** 設定ファイルに書かず、環境変数 PATCHIRI_DB_PASSWORD で渡してもよい。 */
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

export interface PostgresConnection {
  dialect: "postgresql";
  host: string;
  port?: number;
  database: string;
  user: string;
  /** 設定ファイルに書かず、環境変数 PATCHIRI_DB_PASSWORD で渡してもよい。 */
  password?: string;
  /** TLS でつなぐ。rejectUnauthorized: false は自己署名の証明書を受ける（社内の検証用など）。 */
  ssl?: boolean | { rejectUnauthorized?: boolean };
  /** 反映のとき、ほかのセッションがロックしている行を待つ秒数。既定は 10。 */
  lockWaitSeconds?: number;
}

/** MySQL と MariaDB。 */
export interface MySqlConnection {
  dialect: "mysql";
  host: string;
  port?: number;
  /** スキーマを省いたテーブル名はこのデータベースのものとして読む。 */
  database: string;
  user: string;
  /** 設定ファイルに書かず、環境変数 PATCHIRI_DB_PASSWORD で渡してもよい。 */
  password?: string;
  /** TLS でつなぐ。rejectUnauthorized: false は自己署名の証明書を受ける（社内の検証用など）。 */
  ssl?: boolean | { rejectUnauthorized?: boolean };
  /** 反映のとき、ほかのセッションがロックしている行を待つ秒数。既定は 10。 */
  lockWaitSeconds?: number;
}

export type DatabaseConnection = SqlServerConnection | OracleConnection | PostgresConnection | MySqlConnection;

const DIALECTS = ["sqlserver", "oracle", "postgresql", "mysql"];

/** 同梱の画面の設定（Node 版が配る画面、C#・VB.NET 版のページ）。どれも任意。 */
export interface ScreenConfig {
  /** 見出しとブラウザのタブの名前。既定は「patchiri」。 */
  title?: string;
  /** 色。既定は "auto"（OS の設定に合わせる）。 */
  theme?: "auto" | "light" | "dark";
  /** メモを書かないと反映できないようにする。文字列なら欄の名前（「依頼番号」など）。 */
  noteRequired?: boolean | string;
  /** 「Excel を開く」を出すか。既定は出す。 */
  excel?: boolean;
  /** 画面に足す CSS のファイル（設定ファイルのフォルダから。色の変数 --pt-accent などの上書きに使う）。 */
  css?: string;
}

export interface ServerConfig {
  listen?: { host?: string; port?: number };
  database: DatabaseConnection;
  targets: Record<string, TargetConfig>;
  limits?: Partial<Limits>;
  /** 反映ログ（JSON Lines）を置くフォルダ。既定は ./patchiri-log。 */
  logDir?: string;
  /** db_error の message に DB の生のエラー文を出すか。既定は出さない。 */
  exposeDbErrors?: boolean;
  /**
   * サーバに置く業務ルール（patchiri.rules.json と同じ形）。書いたときだけ describe で返し、apply で error のルールを見る。
   * 設定ファイルではファイルのパス（設定ファイルのフォルダから）も書ける（loadConfig が読んで中身にする）。
   */
  rules?: RulesConfig | string;
  /** 反映で行のロックを待つ秒数。database.lockWaitSeconds と同じ（どちらに書いてもよい）。 */
  lockWaitSeconds?: number;
  /** 同梱の画面の設定。 */
  screen?: ScreenConfig;
}

export const DEFAULT_LIMITS: Limits = { maxFetchKeys: 1000, maxApplyRows: 5000 };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string" && s.length > 0);

/** 許可リストの形を確かめる。おかしければ起動時に止める。 */
export function checkConfig(config: ServerConfig): void {
  const fail = (m: string): never => {
    throw new Error(`設定の誤り: ${m}`);
  };
  const db = config.database;
  if (!db || !DIALECTS.includes(db.dialect)) fail(`database.dialect は ${DIALECTS.map((d) => `"${d}"`).join("、")} のどれかです`);
  if (db.dialect === "oracle") {
    if (typeof db.connectString !== "string" || !db.connectString) fail("database.connectString がありません（例 \"localhost:1521/FREEPDB1\"）");
    if (typeof db.user !== "string" || !db.user) fail("database.user がありません");
  }
  if (db.dialect === "postgresql" || db.dialect === "mysql") {
    for (const k of ["host", "database", "user"] as const) if (typeof db[k] !== "string" || !db[k]) fail(`database.${k} がありません`);
  }
  if (db.lockWaitSeconds !== undefined && !(Number.isInteger(db.lockWaitSeconds) && db.lockWaitSeconds >= 1)) fail("database.lockWaitSeconds は 1 以上の整数です");
  if (config.screen !== undefined) checkScreen(config.screen, fail);
  if (config.lockWaitSeconds !== undefined) {
    if (!(Number.isInteger(config.lockWaitSeconds) && config.lockWaitSeconds >= 1)) fail("lockWaitSeconds は 1 以上の整数です");
    if (db.lockWaitSeconds !== undefined && db.lockWaitSeconds !== config.lockWaitSeconds) fail("lockWaitSeconds と database.lockWaitSeconds が違います（どちらか一方に書いてください）");
  }
  if (config.rules !== undefined) {
    const rules: unknown = config.rules;
    if (typeof rules === "string") fail("rules はファイルの中身にしてから渡してください（loadConfig が読みます）");
    if (!isObject(rules) || (rules.targets !== undefined && !isObject(rules.targets))) fail("rules は { \"targets\": { … } } の形です");
    for (const [name, list] of Object.entries(((rules as Record<string, unknown>).targets as Record<string, unknown> | undefined) ?? {})) {
      if (!Object.hasOwn(config.targets ?? {}, name)) fail(`rules.targets の ${name} は targets にありません`);
      if (!Array.isArray(list)) fail(`rules.targets.${name} はルールの配列です`);
    }
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
    const has = (list: string[] | undefined, c: string) => list?.some((x) => x.toLowerCase() === c.toLowerCase()) ?? false;
    if (t.labels !== undefined) {
      if (!isObject(t.labels)) fail(`${name}.labels は { "列名": "表示名" } の形です`);
      const seen = new Map<string, string>();
      for (const c of t.readable) seen.set(c.toLowerCase(), c);
      for (const [c, label] of Object.entries(t.labels)) {
        if (!readable.has(c.toLowerCase())) fail(`${name}.labels の ${c} が readable にありません`);
        if (typeof label !== "string" || !label.trim()) fail(`${name}.labels.${c} は文字列です`);
        const k = label.trim().toLowerCase();
        const other = seen.get(k);
        if (other !== undefined && other.toLowerCase() !== c.toLowerCase()) fail(`${name}.labels の ${label} が ${other} とぶつかります`);
        seen.set(k, c);
      }
    }
    if (t.stamp !== undefined) {
      if (!isObject(t.stamp)) fail(`${name}.stamp は { "列名": "now" か "user" } の形です`);
      if (t.access !== "update") fail(`${name} は read なので stamp を持てません`);
      for (const [c, v] of Object.entries(t.stamp)) {
        if (v !== "now" && v !== "user") fail(`${name}.stamp.${c} は "now" か "user" です`);
        if (has(t.key, c)) fail(`${name} のキー列 ${c} は stamp にできません`);
        if (has(t.updatable, c)) fail(`${name}.stamp の ${c} は updatable にもあります（どちらか一方にしてください）`);
      }
    }
    if (t.scope !== undefined) {
      if (!isObject(t.scope) || Object.keys(t.scope).length === 0) fail(`${name}.scope は { "列名": 値 } の形です`);
      for (const [c, v] of Object.entries(t.scope)) {
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") fail(`${name}.scope.${c} は文字列、数、true / false のどれかです`);
        if (has(t.updatable, c)) fail(`${name}.scope の ${c} は updatable にもあります（範囲の列は変えられません）`);
        if (t.stamp && Object.keys(t.stamp).some((x) => x.toLowerCase() === c.toLowerCase())) fail(`${name}.scope の ${c} は stamp にもあります`);
      }
    }
    if (t.roles !== undefined && (!isStringArray(t.roles) || t.roles.length === 0)) fail(`${name}.roles はロールの名前の配列です`);
  }
}

/** 反映で行のロックを待つ秒数（最上位か database のどちらか）。 */
export function lockWaitSeconds(config: ServerConfig): number | undefined {
  return config.lockWaitSeconds ?? config.database.lockWaitSeconds;
}

function checkScreen(screen: unknown, fail: (m: string) => never): void {
  if (!isObject(screen)) fail("screen は { \"title\": … } の形です");
  const s = screen as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!["title", "theme", "noteRequired", "excel", "css"].includes(k)) fail(`screen.${k} という項目はありません`);
  if (s.title !== undefined && (typeof s.title !== "string" || !s.title.trim())) fail("screen.title は空でない文字列です");
  if (s.theme !== undefined && !["auto", "light", "dark"].includes(s.theme as string)) fail('screen.theme は "auto"、"light"、"dark" のどれかです');
  if (s.noteRequired !== undefined && typeof s.noteRequired !== "boolean" && (typeof s.noteRequired !== "string" || !s.noteRequired.trim())) {
    fail("screen.noteRequired は true / false か、欄の名前（空でない文字列）です");
  }
  if (s.excel !== undefined && typeof s.excel !== "boolean") fail("screen.excel は true / false です");
  if (s.css !== undefined && (typeof s.css !== "string" || !s.css)) fail("screen.css は CSS のファイルのパスです");
}
