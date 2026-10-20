// MySQL と MariaDB の方言。SQL はここでだけ組み、値はすべてパラメータで渡す（mysql2 の execute。サーバ側のプリペアドステートメント）。
// テーブル名と列名は DB の定義から取り、`` で囲む。
//
// MySQL で気をつけること（MySQL 8.4 と MariaDB 11.4 で確かめた）:
// - 既定の照合順序（utf8mb4_0900_ai_ci、utf8mb4_uca1400_ai_ci）は大文字小文字だけでなく、かなと全角半角、濁点も区別しない
//   （'ボールペン' = 'ﾎﾞｰﾙﾍﾟﾝ'、'ボ' = 'ホ'）。値が変わっていないかは、utf8mb4 にしてからバイト列（BINARY）で比べる。
//   _bin の照合順序は PAD SPACE（末尾の空白を見ない）のものが多いので使わない。キーは列の照合順序のまま。
// - CHAR は読むときに末尾の空白が落ちる。比べるときも両方の末尾の空白を落とす。
// - プリペアドステートメントのパラメータをじかに CAST すると、型の決め方が変わって値が崩れる（MySQL 8.4 で、CAST(? AS UNSIGNED) は
//   9223372036854775807 で頭打ち、文字列の '09:00:00' の CAST(? AS TIME(6)) は 00:00:00）。数値と日時は文字列で渡し、
//   CAST(CAST(? AS CHAR) AS …) で読む。
// - FLOAT の列は DOUBLE の値と比べると合わない（0.1 が違う値になる）。CAST(? AS FLOAT) にして比べ、読むときも CAST(… AS CHAR) で読む。
// - 影響行数（affectedRows）は当たった行の数で、トリガーの中の行数は入らない（mysql2 は FOUND_ROWS を付けてつなぐ）。
// - sql_mode が厳格でないと、桁あふれや表せない字が黙って切り詰められる。反映の前にセッションを STRICT_ALL_TABLES にする。

import mysql from "mysql2/promise";
import type { ColumnType, Row, Value } from "patchiri-core";
import { canonical, DATE_RE, DATETIME_RE, DECIMAL_RE, TIME_RE } from "patchiri-core";
import type { MySqlConnection } from "./config.js";
import { DbError, LOCKED_MESSAGE, scriptKeyText, type ColumnMeta, type Dialect, type ForeignKeyMeta, type LockedRow, type ScriptUpdate, type TableMeta, type Transaction } from "./dialect.js";

/** 内部で使う列の情報。 */
export interface MyColumn extends ColumnMeta {
  /** DATA_TYPE（"varchar"、"int"、"datetime" など）。 */
  baseType: string;
  unsigned: boolean;
  /** 文字列の列の文字コード（CHARACTER_SET_NAME）。 */
  charset?: string;
}

interface MyMeta extends TableMeta {
  schema: string;
  name: string;
}

/** information_schema.COLUMNS の 1 行。 */
export interface MyDictColumn {
  name: string;
  dataType: string;
  columnType: string;
  chars: number | null;
  bytes: number | null;
  precision: number | null;
  scale: number | null;
  fsp: number | null;
  nullable: boolean;
  default: string | null;
  extra: string;
  charset: string | null;
}

/** 文字コード（CHARACTER_SET_NAME）→ WHATWG の文字コード名。 */
const CHARSETS: Record<string, string> = {
  utf8mb4: "utf-8",
  // 3 バイトまで（補助面の字は入らない）。最後の確認は DB で行う。
  utf8mb3: "utf-8",
  utf8: "utf-8",
  cp932: "shift_jis",
  // NEC・IBM の拡張文字を持たない。最後の確認は DB で行う。
  sjis: "shift_jis",
  ujis: "euc-jp",
  eucjpms: "euc-jp",
  // MySQL の latin1 は cp1252。
  latin1: "windows-1252",
  latin2: "iso-8859-2",
  latin5: "windows-1254",
  latin7: "iso-8859-13",
  greek: "iso-8859-7",
  hebrew: "iso-8859-8",
  cp1250: "windows-1250",
  cp1251: "windows-1251",
  cp1256: "windows-1256",
  cp1257: "windows-1257",
  cp866: "ibm866",
  koi8r: "koi8-r",
  koi8u: "koi8-u",
  tis620: "windows-874",
  gbk: "gbk",
  gb2312: "gbk",
  big5: "big5",
  euckr: "euc-kr",
  // MySQL の utf16 はビッグエンディアン。
  utf16: "utf-16be",
  utf16le: "utf-16le",
};

/** 整数の型の範囲（signed、unsigned）。 */
const INTEGER_RANGES: Record<string, [[number, number], [number, number]]> = {
  tinyint: [[-128, 127], [0, 255]],
  smallint: [[-32768, 32767], [0, 65535]],
  mediumint: [[-8388608, 8388607], [0, 16777215]],
  int: [[-2147483648, 2147483647], [0, 4294967295]],
};

const TEXT_TYPES = new Set(["tinytext", "text", "mediumtext", "longtext"]);

/** 名前を `` で囲む。 */
export function quoteName(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/** "db.m_product"、"`db`.`m_product`"、"m_product" を [データベース, 名前] に分ける。データベースを省くと undefined。 */
export function splitMySqlName(table: string): [string | undefined, string] {
  const parts: string[] = [];
  const re = /\s*(?:`((?:[^`]|``)+)`|([^.`\s]+))\s*(?:\.|$)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < table.length && (m = re.exec(table))) parts.push(m[1] !== undefined ? m[1].replace(/``/g, "`") : m[2]!);
  if (re.lastIndex < table.length || parts.length === 0 || parts.length > 2) throw new Error(`テーブル名 ${table} が読めません`);
  return parts.length === 1 ? [undefined, parts[0]!] : [parts[0]!, parts[1]!];
}

/** information_schema.COLUMNS の行を列の定義にする。 */
export function mysqlColumn(d: MyDictColumn): MyColumn {
  const base = d.dataType.toLowerCase();
  const unsigned = /\bunsigned\b/i.test(d.columnType);
  const col: MyColumn = { name: d.name, type: "other", dbType: d.columnType, nullable: d.nullable, baseType: base, unsigned };
  const set = (type: ColumnType, dbType: string) => {
    col.type = type;
    col.dbType = dbType;
  };
  const sign = unsigned ? " unsigned" : "";
  switch (base) {
    case "char":
    case "varchar":
      set("string", `${base}(${d.chars})`);
      col.maxLength = d.chars ?? -1;
      break;
    case "tinytext":
    case "text":
    case "mediumtext":
    case "longtext":
      // 上限はバイト数（text は 65535 バイト）。
      set("string", base);
      col.maxLength = -1;
      if (d.bytes !== null) col.maxBytes = d.bytes;
      break;
    case "enum":
      // 値はラベルの文字列（ラベルにない値は、厳格な sql_mode なら DB がエラーにする）。
      set("string", d.columnType);
      if (d.chars !== null) col.maxLength = d.chars;
      break;
    case "tinyint":
    case "smallint":
    case "mediumint":
    case "int": {
      // tinyint(1)（BOOLEAN の別名）も 0 / 1 以外の値を持てるので、整数のまま扱う。
      set("integer", base + sign);
      const [min, max] = INTEGER_RANGES[base]![unsigned ? 1 : 0];
      col.min = min;
      col.max = max;
      break;
    }
    case "bigint":
      set("bigint", base + sign);
      if (unsigned) {
        col.min = "0";
        col.max = "18446744073709551615";
      }
      break;
    case "decimal":
      set("decimal", `decimal(${d.precision},${d.scale})${sign}`);
      col.precision = d.precision ?? 10;
      col.scale = d.scale ?? 0;
      break;
    case "float":
    case "double":
      set("float", base + sign);
      break;
    case "bit":
      if (d.precision === 1) set("boolean", "bit(1)");
      break;
    case "date":
      set("date", "date");
      break;
    case "datetime":
    case "time":
      set(base === "time" ? "time" : "datetime", d.fsp ? `${base}(${d.fsp})` : base);
      col.scale = d.fsp ?? 0;
      break;
    // timestamp はセッションの time_zone で値が変わるので扱わない（仕様 1.3 の datetime はタイムゾーンを持たない）。
  }
  if (col.type === "string" && d.charset) {
    col.charset = d.charset.toLowerCase();
    const encoding = CHARSETS[col.charset];
    if (encoding) col.encoding = encoding;
  }
  if (/auto_increment/i.test(d.extra)) col.identity = true;
  if (/\b(VIRTUAL|STORED|PERSISTENT) GENERATED\b/i.test(d.extra)) col.computed = true;
  // MariaDB は DEFAULT NULL を 'NULL' と出す。
  if (!col.identity && !col.computed && d.default !== null && d.default.toUpperCase() !== "NULL") col.hasDefault = true;
  return col;
}

/** SELECT で値を仕様 1.3 の形で受け取るための式。 */
function selectExpr(col: MyColumn, prefix = ""): string {
  const q = prefix + quoteName(col.name);
  if (col.baseType === "float") return `CAST(${q} AS CHAR)`;
  if (col.type === "boolean") return `CAST(${q} AS UNSIGNED)`;
  return q;
}

function readValue(col: MyColumn, v: unknown): Value {
  if (v === null || v === undefined) return null;
  switch (col.type) {
    case "integer":
    case "float":
      return Number(v);
    case "boolean":
      return Number(v) === 1;
    case "datetime":
      return canonical("datetime", String(v).replace(" ", "T"));
    case "time":
      return canonical("time", String(v));
    case "other":
      if (Buffer.isBuffer(v)) return v.toString("hex").toUpperCase();
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    default:
      return Buffer.isBuffer(v) ? v.toString("utf8") : String(v);
  }
}

/** 値を渡す式を作り、パラメータを足す。数値と日時は文字列で渡して DB で読む（精度を崩さない）。 */
function bindValue(params: unknown[], col: MyColumn, v: Value): string {
  if (v === null) return "NULL";
  switch (col.type) {
    case "string":
      params.push(String(v));
      return "?";
    case "integer":
    case "bigint":
      params.push(String(v));
      return `CAST(CAST(? AS CHAR) AS ${col.unsigned ? "UNSIGNED" : "SIGNED"})`;
    case "decimal":
      params.push(String(v));
      return `CAST(CAST(? AS CHAR) AS DECIMAL(65,${col.scale ?? 0}))`;
    case "float":
      params.push(Number(v));
      return col.baseType === "float" ? "CAST(? AS FLOAT)" : "?";
    case "boolean":
      params.push(v ? "1" : "0");
      return "CAST(CAST(? AS CHAR) AS UNSIGNED)";
    case "date":
      params.push(String(v));
      return "CAST(CAST(? AS CHAR) AS DATE)";
    case "datetime":
      params.push(String(v).replace("T", " "));
      return "CAST(CAST(? AS CHAR) AS DATETIME(6))";
    case "time":
      params.push(String(v));
      return "CAST(CAST(? AS CHAR) AS TIME(6))";
    default:
      throw new Error(`列 ${col.name} の型 ${col.dbType} は扱えません`);
  }
}

/**
 * 人が読む SQL の文字列のリテラル。\ の読み方は sql_mode（NO_BACKSLASH_ESCAPES）で変わるので、\ や NUL を含む値は
 * 16 進（_utf8mb4 X'…'）で書く。改行はそのまま書く（mysql コマンドは引用の中の改行や ; を文の区切りにしない）。
 */
export function quoteString(s: string): string {
  if (/[\\\0]/.test(s)) return `_utf8mb4 X'${Buffer.from(s, "utf8").toString("hex").toUpperCase()}'`;
  return `'${s.replace(/'/g, "''")}'`;
}

/** 人が読む SQL 用の値の書き方。値は checkValue で形を確かめた後のものだけが来る。 */
export function literal(col: MyColumn, v: Value): string {
  if (v === null) return "NULL";
  switch (col.type) {
    case "string":
      return quoteString(String(v));
    case "integer":
    case "bigint":
    case "decimal":
      if (!DECIMAL_RE.test(String(v))) throw new Error(`数値ではない値: ${String(v)}`);
      return String(v);
    case "float": {
      if (!Number.isFinite(Number(v))) throw new Error(`数値ではない値: ${String(v)}`);
      const n = String(Number(v));
      return col.baseType === "float" ? `CAST(${n} AS FLOAT)` : n;
    }
    case "boolean":
      return v ? "1" : "0";
    case "date":
      if (!DATE_RE.test(String(v))) throw new Error(`日付ではない値: ${String(v)}`);
      return `DATE '${String(v)}'`;
    case "datetime":
      if (!DATETIME_RE.test(String(v))) throw new Error(`日時ではない値: ${String(v)}`);
      return `TIMESTAMP '${String(canonical("datetime", v)).replace("T", " ")}'`;
    case "time":
      if (!TIME_RE.test(String(v))) throw new Error(`時刻ではない値: ${String(v)}`);
      return `TIME '${String(canonical("time", v))}'`;
    default:
      throw new Error(`列 ${col.name} の型 ${col.dbType} は SQL に書けません`);
  }
}

function keyCondition(col: MyColumn, expr: string): string {
  return `${quoteName(col.name)} = ${expr}`;
}

/**
 * 値が厳密に同じかの条件（仕様 1.6）。文字列は列の照合順序を使わず、utf8mb4 にしてからバイト列で比べる
 * （列が cp932 などでも、Unicode の同じ字なら同じバイト列になる）。CHAR は両方の末尾の空白を落としてから比べる。NULL は NULL とだけ同じ。
 */
function sameCondition(col: MyColumn, expr: string | null): string {
  const q = quoteName(col.name);
  if (expr === null) return `${q} IS NULL`;
  if (col.type !== "string") return `${q} = ${expr}`;
  const utf = (x: string) => (col.baseType === "char" ? `RTRIM(CONVERT(${x} USING utf8mb4))` : `CONVERT(${x} USING utf8mb4)`);
  return `CAST(${utf(q)} AS BINARY) = CAST(${utf(expr)} AS BINARY)`;
}

function quoteTable(m: MyMeta): string {
  return `${quoteName(m.schema)}.${quoteName(m.name)}`;
}

function cols(meta: TableMeta, names: string[]): MyColumn[] {
  return names.map((n) => {
    const c = (meta.columns as MyColumn[]).find((x) => x.name === n);
    if (!c) throw new Error(`列 ${n} が ${meta.table} にありません`);
    return c;
  });
}

/** ドライバのエラーを DbError にする。ロック待ちの時間切れなどは、画面に出せる説明を付ける。 */
function toDbError(e: unknown): DbError {
  if (e instanceof DbError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const errno = (e as { errno?: unknown } | undefined)?.errno;
  let publicMessage: string | undefined;
  // 1205: innodb_lock_wait_timeout を超えた。
  if (errno === 1205) publicMessage = LOCKED_MESSAGE;
  // 1366: 列の文字コードで表せない字（Incorrect string value）。3988: パラメータを列の文字コードにできない（MySQL 8.0.22 以降）。
  else if (errno === 1366 || errno === 3988) publicMessage = "列の文字コードで表せない字があります。値を確かめてください";
  return new DbError(message, { cause: e, ...(publicMessage && { publicMessage }) });
}

type Rec = Record<string, unknown>;
type Executor = mysql.Pool | mysql.PoolConnection;

/** パラメータのある文は execute（サーバ側のプリペアドステートメント）で流す。値を SQL の文字列に埋め込まない。 */
async function query(c: Executor, sql: string, params: unknown[] = []): Promise<Rec[]> {
  try {
    const [rows] = params.length ? await c.execute<mysql.RowDataPacket[]>(sql, params as never) : await c.query<mysql.RowDataPacket[]>(sql);
    return rows as Rec[];
  } catch (e) {
    throw toDbError(e);
  }
}

/** 名前として SQL に書く文字コード名（DB の定義から来るが、形を確かめる）。 */
const SAFE_NAME = /^[a-z0-9_]+$/;

class MyTransaction implements Transaction {
  constructor(private readonly c: mysql.PoolConnection) {}

  async lockAndCompare(meta: TableMeta, keyColumns: string[], key: Row, before: Row): Promise<LockedRow> {
    const m = meta as MyMeta;
    const keyCols = cols(m, keyColumns);
    const beforeCols = cols(m, Object.keys(before));
    const params: unknown[] = [];
    const select = [...keyCols, ...beforeCols].map((c, i) => `${selectExpr(c)} AS ${quoteName(`__v${i}`)}`);
    // パラメータは SQL に出てくる順に足す（SELECT の比べる式が WHERE より前）。
    const checks = beforeCols.map((c, i) => {
      const v = before[c.name]!;
      const cond = sameCondition(c, v === null ? null : bindValue(params, c, v));
      return `CASE WHEN ${cond} THEN 1 ELSE 0 END AS ${quoteName(`__m${i}`)}`;
    });
    const where = keyCols.map((c) => keyCondition(c, bindValue(params, c, key[c.name]!)));
    const rows = await query(this.c, `SELECT ${[...select, ...checks].join(", ")} FROM ${quoteTable(m)} WHERE ${where.join(" AND ")} FOR UPDATE`, params);
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
    const m = meta as MyMeta;
    const params: unknown[] = [];
    const assigns = cols(m, Object.keys(set)).map((c) => `${quoteName(c.name)} = ${bindValue(params, c, set[c.name]!)}`);
    const where = cols(m, keyColumns).map((c) => keyCondition(c, bindValue(params, c, key[c.name]!)));
    try {
      const [res] = await this.c.execute<mysql.ResultSetHeader>(`UPDATE ${quoteTable(m)} SET ${assigns.join(", ")} WHERE ${where.join(" AND ")}`, params as never);
      return res.affectedRows;
    } catch (e) {
      throw toDbError(e);
    }
  }
}

export class MySqlDialect implements Dialect {
  readonly name = "mysql";
  private readonly pool: mysql.Pool;

  constructor(private readonly conn: MySqlConnection) {
    this.pool = mysql.createPool({
      host: conn.host,
      port: conn.port ?? 3306,
      database: conn.database,
      user: conn.user,
      password: conn.password,
      ...(conn.ssl && { ssl: conn.ssl === true ? {} : conn.ssl }),
      charset: "utf8mb4",
      // 値はドライバに読み替えさせない（日時は文字列、bigint と decimal は文字列で受ける）。
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      connectionLimit: 4,
    });
  }

  normalizeTable(table: string): string {
    // 比べるのは DB で引いた名前（describeTable の table と外部キーの参照先）どうしなので、そのまま比べる。
    return table;
  }

  async describeTable(table: string): Promise<TableMeta> {
    const [given, first] = splitMySqlName(table);
    const schema = given ?? String((await query(this.pool, "SELECT DATABASE() AS `s`"))[0]!.s ?? "");
    const found = (await query(this.pool, "SELECT TABLE_SCHEMA AS `s`, TABLE_NAME AS `t` FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [schema, first]))[0];
    if (!found) throw new DbError(`テーブル ${table} が見つかりません`);
    const s = String(found.s);
    const t = String(found.t);
    const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
    const colRows = await query(
      this.pool,
      `SELECT COLUMN_NAME AS \`name\`, DATA_TYPE AS \`type\`, COLUMN_TYPE AS \`ctype\`, CHARACTER_MAXIMUM_LENGTH AS \`chars\`, CHARACTER_OCTET_LENGTH AS \`bytes\`,
              NUMERIC_PRECISION AS \`prec\`, NUMERIC_SCALE AS \`scale\`, DATETIME_PRECISION AS \`fsp\`, IS_NULLABLE AS \`nullable\`,
              COLUMN_DEFAULT AS \`def\`, EXTRA AS \`extra\`, CHARACTER_SET_NAME AS \`cs\`
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [s, t],
    );
    const columns = colRows.map((r) =>
      mysqlColumn({
        name: String(r.name),
        dataType: String(r.type),
        columnType: String(r.ctype),
        chars: num(r.chars),
        bytes: num(r.bytes),
        precision: num(r.prec),
        scale: num(r.scale),
        fsp: num(r.fsp),
        nullable: r.nullable === "YES",
        default: r.def === null || r.def === undefined ? null : String(r.def),
        extra: String(r.extra ?? ""),
        charset: r.cs === null || r.cs === undefined ? null : String(r.cs),
      }),
    );
    const pkRows = await query(
      this.pool,
      `SELECT COLUMN_NAME AS \`col\` FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`,
      [s, t],
    );
    const fkRows = await query(
      this.pool,
      `SELECT CONSTRAINT_NAME AS \`name\`, COLUMN_NAME AS \`col\`, REFERENCED_TABLE_SCHEMA AS \`rschema\`, REFERENCED_TABLE_NAME AS \`rtable\`, REFERENCED_COLUMN_NAME AS \`rcol\`
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [s, t],
    );
    const fks = new Map<string, ForeignKeyMeta>();
    for (const r of fkRows) {
      const key = String(r.name);
      let fk = fks.get(key);
      if (!fk) {
        fk = { name: key, columns: [], referencedTable: `${r.rschema}.${r.rtable}`, referencedColumns: [] };
        fks.set(key, fk);
      }
      fk.columns.push(String(r.col));
      fk.referencedColumns.push(String(r.rcol));
    }
    const meta: MyMeta = {
      table: `${s}.${t}`,
      schema: s,
      name: t,
      columns,
      primaryKey: pkRows.map((r) => String(r.col)),
      foreignKeys: [...fks.values()],
    };
    return meta;
  }

  async fetchRows(meta: TableMeta, keyColumns: string[], columns: string[], keys: Row[]): Promise<(Row | null)[]> {
    const m = meta as MyMeta;
    const keyCols = cols(m, keyColumns);
    const outCols = cols(m, columns);
    const out: (Row | null)[] = keys.map(() => null);
    // キーは UNION ALL で表にして結び、どのキーに当たったかを __i で戻す（照合順序で当たるので JS では突き合わせない）。
    const chunk = Math.max(1, Math.min(500, Math.floor(30000 / keyCols.length)));
    for (let start = 0; start < keys.length; start += chunk) {
      const part = keys.slice(start, start + chunk);
      const params: unknown[] = [];
      const values = part.map((k, i) => {
        const items = keyCols.map((c, j) => bindValue(params, c, k[c.name]!) + (i === 0 ? ` AS ${quoteName(`k${j}`)}` : ""));
        return `SELECT ${i}${i === 0 ? " AS `__i`" : ""}, ${items.join(", ")}`;
      });
      const on = keyCols.map((c, j) => `t.${quoteName(c.name)} = v.${quoteName(`k${j}`)}`);
      const select = outCols.map((c, i) => `${selectExpr(c, "t.")} AS ${quoteName(`__v${i}`)}`);
      const rows = await query(this.pool, `SELECT v.\`__i\`, ${select.join(", ")} FROM ${quoteTable(m)} t JOIN (${values.join(" UNION ALL ")}) v ON ${on.join(" AND ")}`, params);
      for (const r of rows) {
        const i = start + Number(r.__i);
        if (out[i]) throw new DbError(`キー ${JSON.stringify(keys[i])} に当たる行が複数あります（キーが一意ではありません）`);
        const row: Row = {};
        outCols.forEach((c, j) => (row[c.name] = readValue(c, r[`__v${j}`])));
        out[i] = row;
      }
    }
    return out;
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<{ commit: boolean; value: T }>): Promise<T> {
    let c: mysql.PoolConnection;
    try {
      c = await this.pool.getConnection();
    } catch (e) {
      throw toDbError(e);
    }
    try {
      // 桁あふれや表せない字を黙って切り詰めさせない。ほかのセッションがロックしている行は lockWaitSeconds だけ待つ（仕様 7 章の手順 3）。
      const wait = Math.trunc(this.conn.lockWaitSeconds ?? 10);
      await query(c, `SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION', SESSION innodb_lock_wait_timeout = ${wait}`);
      await query(c, "START TRANSACTION");
      const { commit, value } = await fn(new MyTransaction(c));
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
      c.release();
    }
  }

  async checkStrings(meta: TableMeta, items: { column: string; value: string }[]): Promise<({ encodable: boolean; bytes: number } | null)[]> {
    const out: ({ encodable: boolean; bytes: number } | null)[] = items.map(() => null);
    // utf8mb4 の列は見ない。ほかの文字コードの列は、その文字コードにして戻し、元と同じか（表せない字は「?」になる）とバイト数を見る。
    const byCharset = new Map<string, number[]>();
    items.forEach((it, i) => {
      const cs = cols(meta, [it.column])[0]!.charset;
      if (!cs || cs === "utf8mb4" || cs === "binary" || !SAFE_NAME.test(cs)) return;
      byCharset.set(cs, [...(byCharset.get(cs) ?? []), i]);
    });
    for (const [cs, indexes] of byCharset) {
      for (let start = 0; start < indexes.length; start += 500) {
        const part = indexes.slice(start, start + 500);
        const params: unknown[] = [];
        const selects = part.map((i, j) => {
          params.push(items[i]!.value, items[i]!.value, items[i]!.value);
          // パラメータをじかに CONVERT すると、表せない字で MySQL 8.4 はエラー（3988）になるので、いったん utf8mb4 の値にしてから変える。
          const back = `CONVERT(CONVERT(CONVERT(? USING utf8mb4) USING ${cs}) USING utf8mb4)`;
          return `SELECT ${j} AS \`j\`, CASE WHEN CAST(${back} AS BINARY) = CAST(CONVERT(? USING utf8mb4) AS BINARY) THEN 1 ELSE 0 END AS \`ok\`, LENGTH(CONVERT(CONVERT(? USING utf8mb4) USING ${cs})) AS \`b\``;
        });
        for (const r of await query(this.pool, selects.join(" UNION ALL "), params)) out[part[Number(r.j)]!] = { encodable: Number(r.ok) === 1, bytes: Number(r.b) };
      }
    }
    return out;
  }

  private conditions(m: MyMeta, u: ScriptUpdate): string {
    const keyConds = cols(m, Object.keys(u.key)).map((c) => keyCondition(c, literal(c, u.key[c.name]!)));
    const valueConds = cols(m, Object.keys(u.expect)).map((c) => sameCondition(c, u.expect[c.name] === null ? null : literal(c, u.expect[c.name]!)));
    return [...keyConds, ...valueConds].join(" AND ");
  }

  private assigns(m: MyMeta, u: ScriptUpdate): string {
    return cols(m, Object.keys(u.set))
      .map((c) => `${quoteName(c.name)} = ${literal(c, u.set[c.name]!)}`)
      .join(", ");
  }

  /**
   * MySQL はストアドプログラムの外で IF や SIGNAL を使えないので、素の SQL で 1 トランザクションにする。
   * 反映は、先に全部の行を FOR UPDATE でロックして数え、1 行でも当たらなければどの UPDATE も当たらない条件（@patchiri_ok）にする
   * （行が合わないときは、流し続けるクライアントでも半端に反映しない）。最後の SELECT に結果を出す。
   * 途中の文が DB のエラーになったときは、MySQL はその文だけを戻して続けるので、エラーで止まるクライアントで流す前提（先頭のコメントに書く）。
   * 戻しは当たらなかった行を飛ばし、最後の SELECT に出す。
   */
  renderScript(meta: TableMeta, head: string, updates: ScriptUpdate[], kind: "apply" | "undo"): string {
    const m = meta as MyMeta;
    const lines = [head];
    if (kind === "apply") lines.push("-- 1 つのトランザクションで流す。先に全部の行をロックして確かめ、1 行でも見つからないか値が変わっていたら、何も反映しない（最後の行に結果が出る）。");
    else lines.push("-- 今の値が patchiri で入れた値のままの行だけ戻す。その後に別の更新が入った行は戻さず、最後の行に出す。");
    lines.push("-- mysql コマンド、MySQL Workbench、DBeaver、HeidiSQL などで流せる素の SQL。エラーが出たらそこで止める（飛ばして続けると、最後の COMMIT で一部の行だけ反映される）。", "SET NAMES utf8mb4;");
    const count = (u: ScriptUpdate) => `SELECT COUNT(*) INTO @patchiri_n FROM ${quoteTable(m)} WHERE ${this.conditions(m, u)} FOR UPDATE;`;
    const note = (u: ScriptUpdate) => `@patchiri_ng = IF(@patchiri_n = 1, @patchiri_ng, CONCAT_WS(', ', @patchiri_ng, ${quoteString(scriptKeyText(u.key))}))`;
    if (kind === "apply") {
      lines.push("SET @patchiri_ok = 1, @patchiri_ng = NULL;", "START TRANSACTION;");
      for (const u of updates) lines.push(count(u), `SET @patchiri_ok = @patchiri_ok AND @patchiri_n = 1, ${note(u)};`);
      for (const u of updates) lines.push(`UPDATE ${quoteTable(m)} SET ${this.assigns(m, u)} WHERE ${this.conditions(m, u)} AND @patchiri_ok = 1;`);
      lines.push(
        "COMMIT;",
        `SELECT CONVERT(IF(@patchiri_ok = 1, 'patchiri: ${updates.length} 行を反映しました', CONCAT('patchiri: 行が見つからないか、値が変わっています（', @patchiri_ng, '）。何も反映していません')) USING utf8mb4) AS \`patchiri\`;`,
      );
    } else {
      lines.push("SET @patchiri_done = 0, @patchiri_ng = NULL;", "START TRANSACTION;");
      for (const u of updates) {
        lines.push(count(u), `UPDATE ${quoteTable(m)} SET ${this.assigns(m, u)} WHERE ${this.conditions(m, u)};`, `SET @patchiri_done = @patchiri_done + @patchiri_n, ${note(u)};`);
      }
      lines.push(
        "COMMIT;",
        `SELECT CONVERT(CONCAT('patchiri: ', @patchiri_done, ' / ${updates.length} 行を戻しました', IFNULL(CONCAT('。戻していない行（後から別の更新が入った）: ', @patchiri_ng), '')) USING utf8mb4) AS \`patchiri\`;`,
      );
    }
    return lines.join("\n") + "\n";
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
