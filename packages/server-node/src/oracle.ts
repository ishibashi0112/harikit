// Oracle の方言。SQL はここでだけ組み、値はすべてパラメータで渡す。
// テーブル名と列名は DB の定義から取り、"" で囲む。node-oracledb の Thin モード（Oracle Client が要らない）でつなぐ。
//
// Oracle で気をつけること（Oracle 23ai Free と 21c XE で確かめた）:
// - CHAR / NCHAR の列を VARCHAR2 のパラメータと比べると末尾の空白を詰めずに比べるので、'A001' では 'A001      ' に当たらない。
//   パラメータを列と同じ型に CAST して、固定長どうしの比べ方（末尾の空白を見ない）にする。UNION ALL を通すと CHAR のパラメータも VARCHAR2 になる。
// - NVARCHAR2 / NCHAR の値は NVARCHAR2 で渡す（VARCHAR2 で渡すと DB の文字コードを通り、表せない字が崩れる）。
// - 空文字は NULL になる。文字列の列に emptyIsNull を付け、コアが空文字を NULL として扱う。
// - = はセッションの NLS_COMP に従うので、つないだときに BINARY にする。値が変わっていないかは 12.2 以降なら COLLATE BINARY も付ける
//   （列に照合順序が付いていても、人が流す SQL でも厳密に比べるため）。キーは列の照合順序のまま。

import oracledb from "oracledb";
import type { ColumnType, Row, Value } from "patchiri-core";
import { byteCount, canonical, DATETIME_RE, DECIMAL_RE } from "patchiri-core";
import type { OracleConnection } from "./config.js";
import { DbError, LOCKED_MESSAGE, scriptKeyText, type ColumnMeta, type Dialect, type ForeignKeyMeta, type LockedRow, type ScriptUpdate, type TableMeta, type Transaction } from "./dialect.js";

/** 内部で使う列の情報。 */
export interface OraColumn extends ColumnMeta {
  /** DATA_TYPE から精度を外した型名（"VARCHAR2"、"TIMESTAMP" など）。 */
  baseType: string;
  /** CHAR / NCHAR の値はこの型に CAST して比べる（"CHAR(6 BYTE)"）。 */
  castType?: string;
}

interface OraMeta extends TableMeta {
  owner: string;
  name: string;
  /** 値の厳密な比べ方に COLLATE BINARY を使えるか（12.2 以降）。 */
  collate: boolean;
  /** DB の文字コード（WHATWG の名前）。戻し SQL で N'' に書けない字を見分ける。 */
  dbEncoding?: string;
}

/** ALL_TAB_COLS の 1 行。 */
export interface DictColumn {
  name: string;
  dataType: string;
  dataLength: number;
  charLength: number;
  charUsed: string | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  defaultLength: number | null;
  virtual: boolean;
  identity: boolean;
}

/** DB の文字コード（NLS_CHARACTERSET / NLS_NCHAR_CHARACTERSET）→ WHATWG の文字コード名。 */
const CHARSETS: Record<string, string> = {
  AL32UTF8: "utf-8",
  // CESU-8。補助面の字は 6 バイトになるので、バイト数の最後の確認は DB で行う。
  UTF8: "utf-8",
  // 中身は UTF-16BE だが、バイト数は同じ。
  AL16UTF16: "utf-16le",
  JA16SJIS: "shift_jis",
  JA16SJISTILDE: "shift_jis",
  JA16EUC: "euc-jp",
  JA16EUCTILDE: "euc-jp",
  ZHS16GBK: "gbk",
  ZHT16BIG5: "big5",
  ZHT16MSWIN950: "big5",
  ZHT16HKSCS: "big5",
  KO16MSWIN949: "euc-kr",
  KO16KSC5601: "euc-kr",
  TH8TISASCII: "windows-874",
  EE8MSWIN1250: "windows-1250",
  CL8MSWIN1251: "windows-1251",
  WE8MSWIN1252: "windows-1252",
  // WHATWG には ISO-8859-1 がなく windows-1252 として読む。違う字（0x80〜0x9F）は DB で確かめる。
  WE8ISO8859P1: "windows-1252",
  WE8ISO8859P15: "iso-8859-15",
  EL8MSWIN1253: "windows-1253",
  TR8MSWIN1254: "windows-1254",
  IW8MSWIN1255: "windows-1255",
  AR8MSWIN1256: "windows-1256",
  BLT8MSWIN1257: "windows-1257",
  VN8MSWIN1258: "windows-1258",
};

/** 比べ方をそろえる。人が流すスクリプトの先頭にも入れる（数値はリテラルで書くので NLS_NUMERIC_CHARACTERS は要らない）。 */
const SESSION_SQL_COMPARE = "ALTER SESSION SET NLS_COMP = 'BINARY' NLS_SORT = 'BINARY'";
/** つないだセッションの比べ方と数値の書き方をそろえる。 */
const SESSION_SQL = `${SESSION_SQL_COMPARE} NLS_NUMERIC_CHARACTERS = '.,'`;

/** 名前を "" で囲む。 */
export function quoteName(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * "PATCHIRI.M_PRODUCT"、"m_product"、'"Mixed"."Name"' を [スキーマ, 名前] に分ける。
 * "" で囲まない名前は大文字にする（Oracle と同じ）。スキーマを省くと undefined。
 */
export function splitOracleName(table: string): [string | undefined, string] {
  const parts: string[] = [];
  const re = /\s*(?:"([^"]+)"|([^."\s@]+))\s*(?:\.|$)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < table.length && (m = re.exec(table))) parts.push(m[1] !== undefined ? m[1] : m[2]!.toUpperCase());
  if (re.lastIndex < table.length || parts.length === 0 || parts.length > 2) throw new Error(`テーブル名 ${table} が読めません`);
  return parts.length === 1 ? [undefined, parts[0]!] : [parts[0]!, parts[1]!];
}

/** ALL_TAB_COLS の行を列の定義にする。charsets は DB と各国語の文字コード（NLS の名前）。 */
export function oracleColumn(d: DictColumn, charsets: { db?: string; nchar?: string }): OraColumn {
  const base = d.dataType.replace(/\(\d+\)/g, "").trim();
  const col: OraColumn = { name: d.name, type: "other", dbType: d.dataType, nullable: d.nullable, baseType: base };
  const set = (type: ColumnType, dbType: string) => {
    col.type = type;
    col.dbType = dbType;
  };
  switch (base) {
    case "VARCHAR2":
    case "CHAR": {
      // 桁の単位は列ごと（VARCHAR2(10 BYTE) / VARCHAR2(10 CHAR)）。どちらでもバイトの上限は DATA_LENGTH。
      const spec = `${d.charLength} ${d.charUsed === "C" ? "CHAR" : "BYTE"}`;
      set("string", `${base}(${spec})`);
      if (base === "CHAR") col.castType = `CHAR(${spec})`;
      const encoding = charsets.db && CHARSETS[charsets.db];
      if (encoding) col.encoding = encoding;
      break;
    }
    case "NVARCHAR2":
    case "NCHAR": {
      set("string", `${base}(${d.charLength})`);
      if (base === "NCHAR") col.castType = `NCHAR(${d.charLength})`;
      const encoding = charsets.nchar && CHARSETS[charsets.nchar];
      if (encoding) col.encoding = encoding;
      break;
    }
    case "NUMBER":
      // 負の scale（NUMBER(5,-2)）は入れた値が丸められ、戻し SQL の条件が合わなくなるので扱わない。
      if (d.scale !== null && d.scale < 0) break;
      // INTEGER は NUMBER(*,0)。精度のない NUMBER は桁を見ない。
      if (d.precision === null && d.scale === null) set("decimal", "NUMBER");
      else {
        set("decimal", d.precision === null ? `NUMBER(*,${d.scale})` : `NUMBER(${d.precision},${d.scale ?? 0})`);
        col.precision = d.precision ?? 38;
        col.scale = d.scale ?? 0;
      }
      break;
    case "FLOAT":
      set("decimal", d.precision === null ? "FLOAT" : `FLOAT(${d.precision})`);
      break;
    case "BINARY_FLOAT":
    case "BINARY_DOUBLE":
      set("float", base);
      break;
    case "DATE":
      // Oracle の DATE は時刻（秒まで）を持つ。
      set("datetime", "DATE");
      col.scale = 0;
      break;
    case "TIMESTAMP":
      set("datetime", `TIMESTAMP(${d.scale ?? 6})`);
      col.scale = d.scale ?? 6;
      break;
    case "BOOLEAN":
      set("boolean", "BOOLEAN");
      break;
    case "RAW":
      col.dbType = `RAW(${d.dataLength})`;
      break;
  }
  if (col.type === "string") {
    col.maxLength = d.charLength;
    col.maxBytes = d.dataLength;
    col.emptyIsNull = true;
  }
  if (d.identity) col.identity = true;
  if (d.virtual) col.computed = true;
  if (!d.identity && !d.virtual && (d.defaultLength ?? 0) > 0) col.hasDefault = true;
  return col;
}

/** SELECT で値を仕様 1.3 の形で受け取るための式。NUMBER はドライバから文字列で受ける。 */
function selectExpr(col: OraColumn, prefix = ""): string {
  const q = prefix + quoteName(col.name);
  switch (col.baseType) {
    case "DATE":
      return `TO_CHAR(${q}, 'YYYY-MM-DD"T"HH24:MI:SS')`;
    case "TIMESTAMP":
      return `TO_CHAR(${q}, 'YYYY-MM-DD"T"HH24:MI:SS.FF9')`;
    case "TIMESTAMP WITH TIME ZONE":
    case "TIMESTAMP WITH LOCAL TIME ZONE":
      return `TO_CHAR(${q}, 'YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM')`;
    case "INTERVAL YEAR TO MONTH":
    case "INTERVAL DAY TO SECOND":
      return `TO_CHAR(${q})`;
    case "RAW":
      return `RAWTOHEX(${q})`;
    case "ROWID":
    case "UROWID":
      return `ROWIDTOCHAR(${q})`;
    default:
      return q;
  }
}

/** Oracle の数値の文字列（".5"、"-.5"）を仕様の形にし、scale の桁まで 0 を足す（NUMBER(9,2) の 120 → "120.00"）。 */
export function decimalText(s: string, scale?: number): string {
  let t = s.replace(/^(-?)\./, "$10.");
  if (scale !== undefined && scale > 0 && DECIMAL_RE.test(t)) {
    const [int, frac = ""] = t.split(".");
    if (frac.length < scale) t = `${int}.${frac.padEnd(scale, "0")}`;
  }
  return t;
}

function readValue(col: OraColumn, v: unknown): Value {
  if (v === null || v === undefined) return null;
  switch (col.type) {
    case "decimal":
      return decimalText(String(v), col.scale);
    case "datetime":
      return canonical("datetime", String(v));
    case "float":
      return Number(v);
    case "boolean":
      return Boolean(v);
  }
  if (Buffer.isBuffer(v)) return v.toString("hex").toUpperCase();
  return typeof v === "string" || typeof v === "number" ? v : String(v);
}

/** 日時の値（"2024-04-01T10:00:00"）を TO_DATE / TO_TIMESTAMP に渡す形にする。TIMESTAMP は小数を 9 桁にそろえる。 */
function dateTimeText(col: OraColumn, v: Value): string {
  const s = String(canonical("datetime", v));
  if (!DATETIME_RE.test(s)) throw new Error(`日時ではない値: ${s}`);
  const [date, time] = s.split("T") as [string, string];
  if (col.baseType === "DATE") return `${date} ${time}`;
  const [hms, frac = ""] = time.split(".");
  return `${date} ${hms}.${frac.padEnd(9, "0")}`;
}

type Binds = Record<string, oracledb.BindParameter | string | number>;

/** 値を渡す式を作り、パラメータを足す。数値と日時は文字列で渡して DB で読む（精度を崩さない）。 */
function bindValue(binds: Binds, name: string, col: OraColumn, v: Value): string {
  if (v === null) return "NULL";
  const p = `:${name}`;
  switch (col.baseType) {
    case "VARCHAR2":
      binds[name] = { val: String(v), type: oracledb.DB_TYPE_VARCHAR };
      return p;
    case "CHAR":
      binds[name] = { val: String(v), type: oracledb.DB_TYPE_VARCHAR };
      return `CAST(${p} AS ${col.castType})`;
    case "NVARCHAR2":
      binds[name] = { val: String(v), type: oracledb.DB_TYPE_NVARCHAR };
      return p;
    case "NCHAR":
      binds[name] = { val: String(v), type: oracledb.DB_TYPE_NVARCHAR };
      return `CAST(${p} AS ${col.castType})`;
    case "NUMBER":
    case "FLOAT":
      binds[name] = { val: String(v), type: oracledb.DB_TYPE_VARCHAR };
      return `TO_NUMBER(${p})`;
    case "BINARY_FLOAT":
    case "BINARY_DOUBLE":
      binds[name] = { val: Number(v), type: oracledb.DB_TYPE_BINARY_DOUBLE };
      return p;
    case "BOOLEAN":
      binds[name] = { val: Boolean(v), type: oracledb.DB_TYPE_BOOLEAN };
      return p;
    case "DATE":
      binds[name] = { val: dateTimeText(col, v), type: oracledb.DB_TYPE_VARCHAR };
      return `TO_DATE(${p}, 'YYYY-MM-DD HH24:MI:SS')`;
    case "TIMESTAMP":
      binds[name] = { val: dateTimeText(col, v), type: oracledb.DB_TYPE_VARCHAR };
      return `TO_TIMESTAMP(${p}, 'YYYY-MM-DD HH24:MI:SS.FF9')`;
    default:
      throw new Error(`列 ${col.name} の型 ${col.dbType} は扱えません`);
  }
}

const quoteString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** リテラルの一続き。literal は '' / N'' の文字列のリテラルか（CHR や UNISTR は関数の値で、型が VARCHAR2 / NVARCHAR2 になる）。 */
interface Piece {
  text: string;
  literal: boolean;
}

/**
 * NVARCHAR2 / NCHAR のリテラル（改行を含まない一続き）。N'' の中身は DB の文字コードを通るので、DB の文字コードで表せない字があれば
 * UNISTR の \XXXX で書く（表せる字はそのまま残して読めるようにする）。UNISTR は NVARCHAR2 を返す。
 */
function nationalPiece(s: string, dbEncoding: string | undefined): Piece {
  const plain = (ch: string) => {
    if (ch.codePointAt(0)! < 0x80) return true;
    if (!dbEncoding || dbEncoding === "utf-16le") return false;
    const n = byteCount(ch, dbEncoding);
    return n !== null && "bytes" in n;
  };
  const chars = [...s];
  if (chars.every(plain)) return { text: `N${quoteString(s)}`, literal: true };
  let body = "";
  for (const ch of chars) {
    if (ch === "\\") body += "\\005C";
    else if (ch === "'") body += "''";
    else if (plain(ch)) body += ch;
    else for (let i = 0; i < ch.length; i++) body += "\\" + ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  }
  return { text: `UNISTR('${body}')`, literal: false };
}

/**
 * 人が流す SQL で、1 つのリテラルに書く長さ（文字数）。SQL*Plus は 1 行が 2499 文字（23ai は 4999）を超えると読まないので、
 * 長い値は分けて || でつなぐ。UNISTR の \XXXX は 1 字が 10 文字まで膨らむ。
 */
const LITERAL_CHUNK = 100;

/**
 * 文字列の列のリテラル。改行は値の中に書かず CHR(10) / UNISTR('\000A') にする。SQL*Plus は文字列の中でも、
 * / や . だけの行を文の終わりとして、# で始まる行を SQL*Plus のコマンドとして読んでしまうため。
 * 分けてつないだ値は VARCHAR2 / NVARCHAR2 になるので、CHAR / NCHAR の列では列の型に CAST する（末尾の空白を見ない比べ方のまま）。
 */
function stringLiteral(col: OraColumn, s: string, dbEncoding: string | undefined): string {
  const national = col.baseType === "NVARCHAR2" || col.baseType === "NCHAR";
  const pieces: Piece[] = [];
  for (const token of s.split(/(\r|\n)/)) {
    if (token === "") continue;
    if (token === "\r" || token === "\n") {
      const code = token === "\n" ? 10 : 13;
      pieces.push({ text: national ? `UNISTR('\\${code.toString(16).toUpperCase().padStart(4, "0")}')` : `CHR(${code})`, literal: false });
      continue;
    }
    const chars = [...token];
    for (let i = 0; i < chars.length; i += LITERAL_CHUNK) {
      const part = chars.slice(i, i + LITERAL_CHUNK).join("");
      pieces.push(national ? nationalPiece(part, dbEncoding) : { text: quoteString(part), literal: true });
    }
  }
  // 文字列のリテラル（'' と N''）はそのままで CHAR / NCHAR の列と末尾の空白を見ずに比べられる。
  if (pieces.length === 0) return quoteString(s);
  if (pieces.length === 1 && pieces[0]!.literal) return pieces[0]!.text;
  const joined = pieces.map((p) => p.text).join("\n      || ");
  return col.castType ? `CAST(${joined} AS ${col.castType})` : joined;
}

/** 人が読む SQL 用の値の書き方。値は checkValue で形を確かめた後のものだけが来る。 */
export function literal(col: OraColumn, v: Value, dbEncoding?: string): string {
  if (v === null) return "NULL";
  switch (col.baseType) {
    case "VARCHAR2":
    case "CHAR":
    case "NVARCHAR2":
    case "NCHAR":
      // 文字列のリテラルは CHAR 扱いなので、CHAR の列とは末尾の空白を見ずに比べ、VARCHAR2 の列とは厳密に比べる。
      return stringLiteral(col, String(v), dbEncoding);
    case "NUMBER":
    case "FLOAT":
      if (!DECIMAL_RE.test(String(v))) throw new Error(`数値ではない値: ${String(v)}`);
      return String(v);
    case "BINARY_FLOAT":
    case "BINARY_DOUBLE":
      if (!Number.isFinite(Number(v))) throw new Error(`数値ではない値: ${String(v)}`);
      return String(Number(v));
    case "BOOLEAN":
      return v ? "TRUE" : "FALSE";
    case "DATE":
      return `TO_DATE('${dateTimeText(col, v)}', 'YYYY-MM-DD HH24:MI:SS')`;
    case "TIMESTAMP":
      return `TIMESTAMP '${String(canonical("datetime", v)).replace("T", " ")}'`;
    default:
      throw new Error(`列 ${col.name} の型 ${col.dbType} は SQL に書けません`);
  }
}

function keyCondition(col: OraColumn, expr: string): string {
  return `${quoteName(col.name)} = ${expr}`;
}

/** 値が厳密に同じかの条件（仕様 1.6）。NULL は NULL とだけ同じ。 */
function sameCondition(col: OraColumn, expr: string | null, collate: boolean): string {
  if (expr === null) return `${quoteName(col.name)} IS NULL`;
  return col.type === "string" && collate ? `${quoteName(col.name)} COLLATE BINARY = ${expr}` : `${quoteName(col.name)} = ${expr}`;
}

function quoteTable(m: OraMeta): string {
  return `${quoteName(m.owner)}.${quoteName(m.name)}`;
}

function cols(meta: TableMeta, names: string[]): OraColumn[] {
  return names.map((n) => {
    const c = (meta.columns as OraColumn[]).find((x) => x.name === n);
    if (!c) throw new Error(`列 ${n} が ${meta.table} にありません`);
    return c;
  });
}

/** ドライバのエラーを DbError にする。ロック待ちの時間切れなどは、画面に出せる説明を付ける。 */
function toDbError(e: unknown): DbError {
  if (e instanceof DbError) return e;
  const err = e as { message?: string; errorNum?: number; code?: string } | undefined;
  const message = err?.message ?? String(e);
  let publicMessage: string | undefined;
  // 23ai は ORA-00054、それより前は ORA-30006 を返す。
  if (err?.errorNum === 54 || err?.errorNum === 30006) publicMessage = LOCKED_MESSAGE;
  else if (err?.code === "NJS-138") publicMessage = "この Oracle には Thin モードでつなげません（11g など）。サーバの設定で database.thick を使ってください";
  return new DbError(message, { cause: e, ...(publicMessage && { publicMessage }) });
}

const fetchTypeHandler = (m: oracledb.Metadata<unknown>): oracledb.FetchTypeResponse | undefined => {
  if (m.dbType === oracledb.DB_TYPE_NUMBER) return { type: oracledb.STRING };
  if (m.dbType === oracledb.DB_TYPE_CLOB || m.dbType === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING };
  if (m.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER };
  return undefined;
};

type Rec = Record<string, unknown>;

/** 値を読む問い合わせ。NUMBER は文字列で受ける。 */
async function query(c: oracledb.Connection, sql: string, binds: Binds = {}): Promise<Rec[]> {
  try {
    const res = await c.execute<Rec>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeHandler });
    return res.rows ?? [];
  } catch (e) {
    throw toDbError(e);
  }
}

/** データ辞書の問い合わせ。数値は数値で受ける。 */
async function dictionary(c: oracledb.Connection, sql: string, binds: Binds = {}): Promise<Rec[]> {
  try {
    const res = await c.execute<Rec>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return res.rows ?? [];
  } catch (e) {
    throw toDbError(e);
  }
}

const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));

class OraTransaction implements Transaction {
  constructor(
    private readonly c: oracledb.Connection,
    private readonly lockWait: number,
  ) {}

  async lockAndCompare(meta: TableMeta, keyColumns: string[], key: Row, before: Row): Promise<LockedRow> {
    const m = meta as OraMeta;
    const keyCols = cols(m, keyColumns);
    const beforeCols = cols(m, Object.keys(before));
    const binds: Binds = {};
    const where = keyCols.map((c, i) => keyCondition(c, bindValue(binds, `k${i}`, c, key[c.name]!)));
    const checks = beforeCols.map((c, i) => {
      const v = before[c.name]!;
      const cond = sameCondition(c, v === null ? null : bindValue(binds, `b${i}`, c, v), m.collate);
      return `CASE WHEN ${cond} THEN 1 ELSE 0 END AS ${quoteName(`__m${i}`)}`;
    });
    const select = [...keyCols, ...beforeCols].map((c, i) => `${selectExpr(c)} AS ${quoteName(`__v${i}`)}`);
    const rows = await query(this.c, `SELECT ${[...select, ...checks].join(", ")} FROM ${quoteTable(m)} WHERE ${where.join(" AND ")} FOR UPDATE WAIT ${this.lockWait}`, binds);
    if (rows.length === 0) return { found: false };
    if (rows.length > 1) throw new DbError(`キー ${JSON.stringify(key)} に当たる行が ${rows.length} 行あります（キーが一意ではありません）`);
    const row = rows[0]!;
    const dbKey: Row = {};
    keyCols.forEach((c, i) => (dbKey[c.name] = canonical(c.type, readValue(c, row[`__v${i}`]))));
    const current: Row = {};
    const changed: string[] = [];
    beforeCols.forEach((c, i) => {
      current[c.name] = readValue(c, row[`__v${keyCols.length + i}`]);
      if (Number(row[`__m${i}`]) !== 1) changed.push(c.name);
    });
    return { found: true, current, changed, dbKey };
  }

  async update(meta: TableMeta, keyColumns: string[], key: Row, set: Row): Promise<number> {
    const m = meta as OraMeta;
    const binds: Binds = {};
    const assigns = cols(m, Object.keys(set)).map((c, i) => `${quoteName(c.name)} = ${bindValue(binds, `p${i}`, c, set[c.name]!)}`);
    const where = cols(m, keyColumns).map((c, i) => keyCondition(c, bindValue(binds, `k${i}`, c, key[c.name]!)));
    try {
      // rowsAffected は UPDATE 文そのものの行数で、トリガーの中の行数は入らない。
      const res = await this.c.execute(`UPDATE ${quoteTable(m)} SET ${assigns.join(", ")} WHERE ${where.join(" AND ")}`, binds);
      return res.rowsAffected ?? 0;
    } catch (e) {
      throw toDbError(e);
    }
  }
}

/** Thick モードの初期化は 1 プロセスに 1 回だけ。 */
let thickReady = false;

export class OracleDialect implements Dialect {
  readonly name = "oracle";
  private poolPromise: Promise<oracledb.Pool> | undefined;
  private infoPromise: Promise<{ version: number; db?: string; nchar?: string }> | undefined;

  constructor(private readonly conn: OracleConnection) {}

  private pool(): Promise<oracledb.Pool> {
    this.poolPromise ??= (async () => {
      const thick = this.conn.thick;
      if (thick && !thickReady) {
        oracledb.initOracleClient(typeof thick === "object" && thick.libDir ? { libDir: thick.libDir } : undefined);
        thickReady = true;
      }
      return oracledb.createPool({
        user: this.conn.user,
        password: this.conn.password,
        connectString: this.conn.connectString,
        ...(this.conn.configDir && { configDir: this.conn.configDir }),
        poolMin: 0,
        poolMax: 4,
        poolIncrement: 1,
        sessionCallback: (c, _tag, done) => void c.execute(SESSION_SQL).then(() => done(), done),
      });
    })();
    // つなげなかったら、次の呼び出しでやり直す（DB が後から起きた場合など）。
    this.poolPromise.catch(() => (this.poolPromise = undefined));
    return this.poolPromise;
  }

  private async connect(): Promise<oracledb.Connection> {
    try {
      return await (await this.pool()).getConnection();
    } catch (e) {
      throw toDbError(e);
    }
  }

  private async withConnection<T>(fn: (c: oracledb.Connection) => Promise<T>): Promise<T> {
    const c = await this.connect();
    try {
      return await fn(c);
    } finally {
      await c.close();
    }
  }

  /** DB の版と文字コード。 */
  private info(c: oracledb.Connection) {
    this.infoPromise ??= dictionary(c, `SELECT parameter AS "p", value AS "v" FROM nls_database_parameters WHERE parameter IN ('NLS_CHARACTERSET', 'NLS_NCHAR_CHARACTERSET')`).then((rows) => {
      const get = (p: string) => rows.find((r) => r.p === p)?.v as string | undefined;
      return { version: c.oracleServerVersion, db: get("NLS_CHARACTERSET"), nchar: get("NLS_NCHAR_CHARACTERSET") };
    });
    this.infoPromise.catch(() => (this.infoPromise = undefined));
    return this.infoPromise;
  }

  /** 許可リストのテーブル名を、実際のスキーマと名前にする。シノニム（自分のスキーマ、PUBLIC）もたどる。 */
  private async resolveTable(c: oracledb.Connection, table: string): Promise<[string, string]> {
    const [given, first] = splitOracleName(table);
    let owner = given ?? String((await dictionary(c, `SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS "s" FROM dual`))[0]!.s);
    let name = first;
    let allowPublic = given === undefined;
    for (let depth = 0; depth < 8; depth++) {
      const found = await dictionary(c, `SELECT 1 AS "x" FROM all_tab_cols WHERE owner = :o AND table_name = :t AND ROWNUM = 1`, { o: owner, t: name });
      if (found.length > 0) return [owner, name];
      const syn = await dictionary(
        c,
        `SELECT table_owner AS "o", table_name AS "t" FROM all_synonyms
          WHERE synonym_name = :t AND db_link IS NULL AND (owner = :o OR (owner = 'PUBLIC' AND :pub = 1))
          ORDER BY CASE owner WHEN 'PUBLIC' THEN 1 ELSE 0 END`,
        { t: name, o: owner, pub: allowPublic ? 1 : 0 },
      );
      if (syn.length === 0) break;
      owner = String(syn[0]!.o);
      name = String(syn[0]!.t);
      allowPublic = false;
    }
    throw new DbError(`テーブル ${table} が見つかりません`);
  }

  normalizeTable(table: string): string {
    // 比べるのは DB で引いた名前（describeTable の table と外部キーの参照先）どうしなので、そのまま比べる。
    return table;
  }

  async describeTable(table: string): Promise<TableMeta> {
    return this.withConnection(async (c) => {
      const info = await this.info(c);
      const [owner, name] = await this.resolveTable(c, table);
      const identity = info.version >= 1201000000 ? `, identity_column AS "ident"` : "";
      const colRows = await dictionary(
        c,
        `SELECT column_name AS "name", data_type AS "type", data_length AS "len", char_length AS "chars", char_used AS "unit",
                data_precision AS "prec", data_scale AS "scale", nullable AS "nullable", default_length AS "deflen", virtual_column AS "virt"${identity}
           FROM all_tab_cols WHERE owner = :o AND table_name = :t AND hidden_column = 'NO' ORDER BY column_id`,
        { o: owner, t: name },
      );
      const columns = colRows.map((r) =>
        oracleColumn(
          {
            name: String(r.name),
            dataType: String(r.type),
            dataLength: Number(r.len),
            charLength: Number(r.chars),
            charUsed: (r.unit as string | null) ?? null,
            precision: num(r.prec),
            scale: num(r.scale),
            nullable: r.nullable === "Y",
            defaultLength: num(r.deflen),
            virtual: r.virt === "YES",
            identity: r.ident === "YES",
          },
          info,
        ),
      );
      const pkRows = await dictionary(
        c,
        `SELECT cc.column_name AS "col" FROM all_constraints k
           JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name
          WHERE k.owner = :o AND k.table_name = :t AND k.constraint_type = 'P' ORDER BY cc.position`,
        { o: owner, t: name },
      );
      const fkRows = await dictionary(
        c,
        `SELECT k.constraint_name AS "name", cc.column_name AS "col", r.owner AS "rowner", r.table_name AS "rtable", rc.column_name AS "rcol"
           FROM all_constraints k
           JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name
           JOIN all_constraints r ON r.owner = k.r_owner AND r.constraint_name = k.r_constraint_name
           JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position
          WHERE k.owner = :o AND k.table_name = :t AND k.constraint_type = 'R' ORDER BY k.constraint_name, cc.position`,
        { o: owner, t: name },
      );
      const fks = new Map<string, ForeignKeyMeta>();
      for (const r of fkRows) {
        const key = String(r.name);
        let fk = fks.get(key);
        if (!fk) {
          fk = { name: key, columns: [], referencedTable: `${r.rowner}.${r.rtable}`, referencedColumns: [] };
          fks.set(key, fk);
        }
        fk.columns.push(String(r.col));
        fk.referencedColumns.push(String(r.rcol));
      }
      const meta: OraMeta = {
        table: `${owner}.${name}`,
        owner,
        name,
        columns,
        primaryKey: pkRows.map((r) => String(r.col)),
        foreignKeys: [...fks.values()],
        collate: info.version >= 1202000000,
        ...(info.db && CHARSETS[info.db] && { dbEncoding: CHARSETS[info.db] }),
      };
      return meta;
    });
  }

  async fetchRows(meta: TableMeta, keyColumns: string[], columns: string[], keys: Row[]): Promise<(Row | null)[]> {
    const m = meta as OraMeta;
    const keyCols = cols(m, keyColumns);
    const outCols = cols(m, columns);
    const out: (Row | null)[] = keys.map(() => null);
    // キーは DUAL の UNION ALL で表にして結び、どのキーに当たったかを __i で戻す（照合順序で当たるので JS では突き合わせない）。
    const chunk = Math.max(1, Math.min(500, Math.floor(30000 / keyCols.length)));
    await this.withConnection(async (c) => {
      for (let start = 0; start < keys.length; start += chunk) {
        const part = keys.slice(start, start + chunk);
        const binds: Binds = {};
        const values = part.map((k, i) => {
          const items = keyCols.map((col, j) => bindValue(binds, `k${i}_${j}`, col, k[col.name]!) + (i === 0 ? ` AS ${quoteName(`k${j}`)}` : ""));
          return `SELECT ${i}${i === 0 ? ` AS "__i"` : ""}, ${items.join(", ")} FROM dual`;
        });
        const on = keyCols.map((col, j) => `t.${quoteName(col.name)} = v.${quoteName(`k${j}`)}`);
        const select = outCols.map((col, i) => `${selectExpr(col, "t.")} AS ${quoteName(`__v${i}`)}`);
        const rows = await query(c, `SELECT v."__i", ${select.join(", ")} FROM ${quoteTable(m)} t JOIN (${values.join(" UNION ALL ")}) v ON ${on.join(" AND ")}`, binds);
        for (const r of rows) {
          const i = start + Number(r.__i);
          if (out[i]) throw new DbError(`キー ${JSON.stringify(keys[i])} に当たる行が複数あります（キーが一意ではありません）`);
          const row: Row = {};
          outCols.forEach((col, j) => (row[col.name] = readValue(col, r[`__v${j}`])));
          out[i] = row;
        }
      }
    });
    return out;
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<{ commit: boolean; value: T }>): Promise<T> {
    const c = await this.connect();
    try {
      const { commit, value } = await fn(new OraTransaction(c, this.conn.lockWaitSeconds ?? 10));
      try {
        if (commit) await c.commit();
        else await c.rollback();
      } catch (e) {
        throw toDbError(e);
      }
      return value;
    } catch (e) {
      try {
        await c.rollback();
      } catch {
        // つながりが切れていれば、DB 側で取り消される。
      }
      throw e;
    } finally {
      await c.close().catch(() => undefined);
    }
  }

  async checkStrings(meta: TableMeta, items: { column: string; value: string }[]): Promise<({ encodable: boolean; bytes: number } | null)[]> {
    const out: ({ encodable: boolean; bytes: number } | null)[] = items.map(() => null);
    // NVARCHAR2 / NCHAR は Unicode なので見ない。VARCHAR2 / CHAR は DB の文字コードにして戻し、元と同じか（表せない字は置き換わる）とバイト数を見る。
    const targets = items.map((it, i) => ({ it, i, col: cols(meta, [it.column])[0]! })).filter((x) => x.col.baseType === "VARCHAR2" || x.col.baseType === "CHAR");
    if (targets.length === 0) return out;
    await this.withConnection(async (c) => {
      for (let start = 0; start < targets.length; start += 1000) {
        const part = targets.slice(start, start + 1000);
        let res: oracledb.Results<{ ok: number; b: number }>;
        try {
          res = await c.executeMany<{ ok: number; b: number }>(
            `DECLARE v VARCHAR2(32767); BEGIN v := TO_CHAR(:s); :ok := CASE WHEN TO_NCHAR(v) = :s THEN 1 ELSE 0 END; :b := NVL(LENGTHB(v), 0); END;`,
            part.map((x) => ({ s: x.it.value })),
            {
              bindDefs: {
                s: { type: oracledb.DB_TYPE_NVARCHAR, maxSize: 32767 },
                ok: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
                b: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
              },
            },
          );
        } catch (e) {
          throw toDbError(e);
        }
        res.outBinds?.forEach((r, j) => (out[part[j]!.i] = { encodable: Number(r.ok) === 1, bytes: Number(r.b) }));
      }
    });
    return out;
  }

  private renderUpdate(m: OraMeta, u: ScriptUpdate): string {
    const lit = (c: OraColumn, v: Value) => literal(c, v, m.dbEncoding);
    const assigns = cols(m, Object.keys(u.set)).map((c) => `${quoteName(c.name)} = ${lit(c, u.set[c.name]!)}`);
    const keyConds = cols(m, Object.keys(u.key)).map((c) => keyCondition(c, lit(c, u.key[c.name]!)));
    const valueConds = cols(m, Object.keys(u.expect)).map((c) => sameCondition(c, u.expect[c.name] === null ? null : lit(c, u.expect[c.name]!), m.collate));
    const conds = [...keyConds, ...valueConds];
    const one = `UPDATE ${quoteTable(m)} SET ${assigns.join(", ")} WHERE ${conds.join(" AND ")}`;
    // SQL*Plus の 1 行の上限より十分短く。長い文や、分けてつないだ値を含む文は、列と条件ごとに行を分ける。
    if (one.length <= 1000 && !one.includes("\n")) return one;
    return [`UPDATE ${quoteTable(m)}`, `     SET ${assigns.join(",\n         ")}`, `   WHERE ${conds.join("\n     AND ")}`].join("\n");
  }

  /**
   * PL/SQL のブロックにして、人が流しても 1 トランザクションになるようにする（SQL*Plus は文ごとにエラーを飛ばして進むため）。
   * 反映は 1 行でも当たらなければ全部取り消して止まる。戻しは当たらなかった行を飛ばし、DBMS_OUTPUT に出す。
   */
  renderScript(meta: TableMeta, head: string, updates: ScriptUpdate[], kind: "apply" | "undo"): string {
    const m = meta as OraMeta;
    const lines = [head];
    if (kind === "apply") lines.push("-- 1 つのトランザクションで流す。どれかの行が見つからないか値が変わっていたら、何も反映せずに止まる（ORA-20001）。");
    else lines.push("-- 今の値が patchiri で入れた値のままの行だけ戻す。その後に別の更新が入った行は戻さず、DBMS_OUTPUT に出す。");
    lines.push(
      "-- SQL*Plus、SQLcl、SQL Developer で流せる形（値の & を置き換えないよう SET DEFINE OFF にしてある）。",
      "-- キーを大文字小文字を区別して比べるよう、このセッションの NLS_COMP / NLS_SORT を BINARY にする（流した後もこのセッションに残る）。",
      "SET DEFINE OFF",
      `${SESSION_SQL_COMPARE};`,
    );
    if (kind === "undo") lines.push("SET SERVEROUTPUT ON", "DECLARE", "  n PLS_INTEGER := 0;");
    lines.push("BEGIN");
    for (const u of updates) {
      lines.push(`  ${this.renderUpdate(m, u)};`);
      if (kind === "apply") {
        const msg = quoteString(`patchiri: 行が見つからないか、値が変わっています（${scriptKeyText(u.key)}）。何も反映していません`);
        lines.push(`  IF SQL%ROWCOUNT <> 1 THEN RAISE_APPLICATION_ERROR(-20001, ${msg}); END IF;`);
      } else {
        const msg = quoteString(`patchiri: 戻していない行（後から別の更新が入った）: ${scriptKeyText(u.key)}`);
        lines.push(`  IF SQL%ROWCOUNT = 1 THEN n := n + 1; ELSE DBMS_OUTPUT.PUT_LINE(${msg}); END IF;`);
      }
    }
    lines.push("  COMMIT;");
    if (kind === "undo") lines.push(`  DBMS_OUTPUT.PUT_LINE('patchiri: ' || n || ' / ${updates.length} 行を戻しました');`);
    lines.push("EXCEPTION", "  WHEN OTHERS THEN", "    ROLLBACK;", "    RAISE;", "END;", "/");
    return lines.join("\n") + "\n";
  }

  async close(): Promise<void> {
    if (this.poolPromise) await (await this.poolPromise).close(0);
  }
}
