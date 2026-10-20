// PostgreSQL の方言。SQL はここでだけ組み、値はすべてパラメータで渡す。
// テーブル名と列名は DB の定義から取り、"" で囲む。
//
// ドライバは import しない（pg のつなぎは pg-pool.ts）。PgConnector を差し替えれば、ブラウザの PGlite でも同じ方言が動く。
// そのため値はすべて文字列で渡して SQL 側で型を付け（$1::numeric）、読むときも SQL 側で文字列にする（ドライバごとの読み替えに頼らない）。
//
// PostgreSQL で気をつけること（PostgreSQL 18 で確かめた）:
// - 文字列の = は列の照合順序に従う。既定（deterministic）なら 1 字ずつ比べるが、ICU の nondeterministic な照合順序
//   （大文字小文字を区別しないなど）では違う字も同じになる。値が変わっていないかは COLLATE "C" で比べる。キーは列の照合順序のまま。
// - char(n)（bpchar）どうしの比べ方は末尾の空白を見ない。パラメータも bpchar にして比べる（text にすると末尾の空白まで比べる）。
//   char(n) を text にすると末尾の空白が落ちるので、読むときは CAST しない。
// - 列の文字コードで表せない字はエラー（22P05）になり、「?」に置き換わらない。varchar(n) の n は文字数。
// - UPDATE の行数は文そのものの行数で、トリガーの中の行数は入らない。

import type { ColumnType, Row, Value } from "@harikit/core";
import { canonical, DATE_RE, DATETIME_RE, DECIMAL_RE, TIME_RE } from "@harikit/core";
import { DbError, LOCKED_MESSAGE, scriptKeyText, type ColumnMeta, type Dialect, type ForeignKeyMeta, type LockedRow, type ScriptUpdate, type TableMeta, type Transaction } from "./dialect.js";

/** 1 本のつなぎ。値は文字列か null で渡す。 */
export interface PgSession {
  query(text: string, params?: (string | null)[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** つなぎの貸し出し口（pg の Pool、PGlite など）。BEGIN / COMMIT / ROLLBACK は方言が流す。 */
export interface PgConnector {
  withSession<T>(fn: (s: PgSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PostgresOptions {
  /** 反映のとき、ほかのセッションがロックしている行を待つ秒数。既定は 10。 */
  lockWaitSeconds?: number;
}

/** 内部で使う列の情報。 */
export interface PgColumn extends ColumnMeta {
  /** 基の型名（pg_type.typname。"varchar"、"bpchar"、"int4" など）。列が domain ならその基の型。 */
  baseType: string;
  /** 値を渡すときに付ける型（"text"、"bpchar"、"numeric" など。enum は "スキーマ"."型名"）。 */
  castType: string;
}

interface PgMeta extends TableMeta {
  schema: string;
  name: string;
}

/** pg_attribute の 1 行（domain は基の型に読み替えたもの）。 */
export interface PgDictColumn {
  name: string;
  /** 基の型名（pg_type.typname）。 */
  typeName: string;
  /** 基の型の種類（pg_type.typtype。"b" は基本の型、"e" は enum）。 */
  typeKind: string;
  /** format_type の結果（"character varying(10)"、"numeric(9,2)"、"timestamp(3) without time zone"）。 */
  formatted: string;
  /** enum のときに CAST に使う名前（"public"."status"）。 */
  qualifiedType: string;
  nullable: boolean;
  hasDefault: boolean;
  identity: boolean;
  generated: boolean;
}

/** DB の文字コード（server_encoding）→ WHATWG の文字コード名。 */
const ENCODINGS: Record<string, string> = {
  UTF8: "utf-8",
  EUC_JP: "euc-jp",
  EUC_KR: "euc-kr",
  // GB2312 の範囲。GBK はそれより広いので、表せない字の最後の確認は DB（エラー 22P05）。
  EUC_CN: "gbk",
  // WHATWG には ISO-8859-1 がなく windows-1252 として読む。
  LATIN1: "windows-1252",
  LATIN2: "iso-8859-2",
  LATIN3: "iso-8859-3",
  LATIN4: "iso-8859-4",
  LATIN5: "windows-1254",
  LATIN6: "iso-8859-10",
  LATIN7: "iso-8859-13",
  LATIN8: "iso-8859-14",
  LATIN9: "iso-8859-15",
  LATIN10: "iso-8859-16",
  ISO_8859_5: "iso-8859-5",
  ISO_8859_6: "iso-8859-6",
  ISO_8859_7: "iso-8859-7",
  ISO_8859_8: "iso-8859-8",
  KOI8R: "koi8-r",
  KOI8U: "koi8-u",
  WIN866: "ibm866",
  WIN874: "windows-874",
  WIN1250: "windows-1250",
  WIN1251: "windows-1251",
  WIN1252: "windows-1252",
  WIN1253: "windows-1253",
  WIN1254: "windows-1254",
  WIN1255: "windows-1255",
  WIN1256: "windows-1256",
  WIN1257: "windows-1257",
  WIN1258: "windows-1258",
};

/** 基本の型 → 仕様 1.3 の型、値に付ける型、dbType に出す名前。 */
const TYPES: Record<string, { type: ColumnType; cast: string; name: string }> = {
  int2: { type: "integer", cast: "smallint", name: "smallint" },
  int4: { type: "integer", cast: "integer", name: "integer" },
  int8: { type: "bigint", cast: "bigint", name: "bigint" },
  numeric: { type: "decimal", cast: "numeric", name: "numeric" },
  float4: { type: "float", cast: "real", name: "real" },
  float8: { type: "float", cast: "double precision", name: "double precision" },
  bool: { type: "boolean", cast: "boolean", name: "boolean" },
  date: { type: "date", cast: "date", name: "date" },
  timestamp: { type: "datetime", cast: "timestamp", name: "timestamp" },
  time: { type: "time", cast: "time", name: "time" },
  bpchar: { type: "string", cast: "bpchar", name: "char" },
  varchar: { type: "string", cast: "text", name: "varchar" },
  text: { type: "string", cast: "text", name: "text" },
};

/** 名前を "" で囲む。 */
export function quoteName(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** format_type の括弧の中の数（"numeric(9,2)" → [9, 2]）。 */
function typeArgs(formatted: string): number[] {
  const m = /\((-?\d+)(?:,(-?\d+))?\)/.exec(formatted);
  return m ? [Number(m[1]), ...(m[2] !== undefined ? [Number(m[2])] : [])] : [];
}

/** pg_attribute の行を列の定義にする。encoding は DB の文字コード（server_encoding）。 */
export function pgColumn(d: PgDictColumn, encoding?: string): PgColumn {
  const col: PgColumn = { name: d.name, type: "other", dbType: d.formatted, nullable: d.nullable, baseType: d.typeName, castType: "text" };
  const args = typeArgs(d.formatted);
  const known = d.typeKind === "b" ? TYPES[d.typeName] : undefined;
  if (d.typeKind === "e") {
    // enum の値は文字列として扱う（ラベルにない値は DB がエラーにする）。比べ方はラベルの一致なのでもともと厳密。
    col.type = "string";
    col.dbType = d.typeName;
    col.castType = d.qualifiedType;
  } else if (known) {
    col.type = known.type;
    col.castType = known.cast;
    col.dbType = known.name;
    switch (known.type) {
      case "string":
        col.dbType = args.length ? `${known.name}(${args[0]})` : known.name;
        col.maxLength = args.length ? args[0]! : -1;
        break;
      case "decimal":
        if (args.length) {
          // 負の scale（numeric(5,-2)、PostgreSQL 15 以降）は入れた値が丸められ、戻し SQL の条件が合わなくなるので扱わない。
          if ((args[1] ?? 0) < 0) {
            col.type = "other";
            col.dbType = d.formatted;
            break;
          }
          col.dbType = `numeric(${args[0]},${args[1] ?? 0})`;
          col.precision = args[0]!;
          col.scale = args[1] ?? 0;
        }
        break;
      case "datetime":
      case "time":
        if (args.length) col.dbType = `${known.name}(${args[0]})`;
        col.scale = args[0] ?? 6;
        break;
    }
  }
  if (col.type === "string" && encoding && ENCODINGS[encoding]) col.encoding = ENCODINGS[encoding];
  if (d.identity) col.identity = true;
  if (d.generated) col.computed = true;
  if (d.hasDefault && !d.identity && !d.generated) col.hasDefault = true;
  return col;
}

/** 文字列の列のうち、text か char(n) の比べ方をするもの（enum は除く）。 */
const isText = (col: PgColumn) => col.castType === "text" || col.castType === "bpchar";

/** SELECT で値を文字列で受け取るための式。char(n) は text にすると末尾の空白が落ちるので、文字列の列はそのまま読む。 */
function selectExpr(col: PgColumn, prefix = ""): string {
  const q = prefix + quoteName(col.name);
  if (isText(col)) return q;
  if (col.type === "date") return `to_char(${q}, 'YYYY-MM-DD')`;
  if (col.type === "datetime") return `to_char(${q}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
  return `${q}::text`;
}

function readValue(col: PgColumn, v: unknown): Value {
  if (v === null || v === undefined) return null;
  const s = String(v);
  switch (col.type) {
    case "integer":
      return Number(s);
    case "float": {
      // NaN と Infinity は JSON の数値にできないので、そのまま文字列で見せる（値の形の確認で弾かれ、更新はできない）。
      const n = Number(s);
      return Number.isFinite(n) ? n : s;
    }
    case "boolean":
      return s === "true" || s === "t";
    case "datetime":
    case "time":
      return canonical(col.type, s);
    default:
      return s;
  }
}

/** 値を渡す文字列。日時の T は空白にする（どちらも読めるが、人が読む SQL とそろえる）。 */
function paramText(col: PgColumn, v: Exclude<Value, null>): string {
  switch (col.type) {
    case "boolean":
      return v ? "true" : "false";
    case "datetime":
      return String(v).replace("T", " ");
    default:
      return String(v);
  }
}

/** 値を渡す式を作り、パラメータを足す。型は SQL 側で付ける。 */
function bindValue(params: (string | null)[], col: PgColumn, v: Value): string {
  if (col.type === "other") throw new Error(`列 ${col.name} の型 ${col.dbType} は扱えません`);
  if (v === null) return "NULL";
  params.push(paramText(col, v));
  return `$${params.length}::${col.castType}`;
}

/**
 * 人が読む SQL の文字列のリテラル。standard_conforming_strings が off のセッションでも同じ値になるよう、
 * \ を含む値は E'' で書く。改行はそのまま書く（psql は引用の中の改行を文の区切りにしない）。
 */
export function quoteString(s: string): string {
  return s.includes("\\") ? `E'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'` : `'${s.replace(/'/g, "''")}'`;
}

/** 人が読む SQL 用の値の書き方。値は checkValue で形を確かめた後のものだけが来る。 */
export function literal(col: PgColumn, v: Value): string {
  if (v === null) return "NULL";
  switch (col.type) {
    case "string":
      // 型を書かないリテラルは列の型（varchar、char(n)、enum）として読まれる。
      return quoteString(String(v));
    case "integer":
    case "bigint":
    case "decimal":
      if (!DECIMAL_RE.test(String(v))) throw new Error(`数値ではない値: ${String(v)}`);
      return String(v);
    case "float":
      if (!Number.isFinite(Number(v))) throw new Error(`数値ではない値: ${String(v)}`);
      // 0.1 は numeric のリテラルなので、列の型にしてから比べる（real の列と double precision の 0.1 は違う値）。
      return `CAST(${String(Number(v))} AS ${col.castType})`;
    case "boolean":
      return v ? "TRUE" : "FALSE";
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

function keyCondition(col: PgColumn, expr: string): string {
  return `${quoteName(col.name)} = ${expr}`;
}

/**
 * 値が厳密に同じかの条件（仕様 1.6）。文字列は COLLATE "C"（バイトの並び）で比べ、列の照合順序を使わない。
 * char(n) は bpchar どうしの比べ方なので末尾の空白を見ない。enum はラベルの一致。NULL は NULL とだけ同じ。
 */
function sameCondition(col: PgColumn, expr: string | null): string {
  if (expr === null) return `${quoteName(col.name)} IS NULL`;
  return isText(col) ? `${quoteName(col.name)} COLLATE "C" = ${expr}` : `${quoteName(col.name)} = ${expr}`;
}

function quoteTable(m: PgMeta): string {
  return `${quoteName(m.schema)}.${quoteName(m.name)}`;
}

function cols(meta: TableMeta, names: string[]): PgColumn[] {
  return names.map((n) => {
    const c = (meta.columns as PgColumn[]).find((x) => x.name === n);
    if (!c) throw new Error(`列 ${n} が ${meta.table} にありません`);
    return c;
  });
}

/** ドライバのエラーを DbError にする。ロック待ちの時間切れなどは、画面に出せる説明を付ける。 */
function toDbError(e: unknown): DbError {
  if (e instanceof DbError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown } | undefined)?.code;
  let publicMessage: string | undefined;
  // 55P03: lock_timeout を超えた。
  if (code === "55P03") publicMessage = LOCKED_MESSAGE;
  // 22P05: DB の文字コードに無い字。
  else if (code === "22P05") publicMessage = "DB の文字コードで表せない字があります。値を確かめてください";
  return new DbError(message, { cause: e, ...(publicMessage && { publicMessage }) });
}

async function run(s: PgSession, text: string, params: (string | null)[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
  try {
    return await s.query(text, params);
  } catch (e) {
    throw toDbError(e);
  }
}

class PgTransaction implements Transaction {
  constructor(private readonly s: PgSession) {}

  async lockAndCompare(meta: TableMeta, keyColumns: string[], key: Row, before: Row): Promise<LockedRow> {
    const m = meta as PgMeta;
    const keyCols = cols(m, keyColumns);
    const beforeCols = cols(m, Object.keys(before));
    const params: (string | null)[] = [];
    const where = keyCols.map((c) => keyCondition(c, bindValue(params, c, key[c.name]!)));
    const checks = beforeCols.map((c, i) => {
      const v = before[c.name]!;
      const cond = sameCondition(c, v === null ? null : bindValue(params, c, v));
      return `CASE WHEN ${cond} THEN '1' ELSE '0' END AS ${quoteName(`__m${i}`)}`;
    });
    const select = [...keyCols, ...beforeCols].map((c, i) => `${selectExpr(c)} AS ${quoteName(`__v${i}`)}`);
    const { rows } = await run(this.s, `SELECT ${[...select, ...checks].join(", ")} FROM ${quoteTable(m)} WHERE ${where.join(" AND ")} FOR UPDATE`, params);
    if (rows.length === 0) return { found: false };
    if (rows.length > 1) throw new DbError(`キー ${JSON.stringify(key)} に当たる行が ${rows.length} 行あります（キーが一意ではありません）`);
    const row = rows[0]!;
    const dbKey: Row = {};
    keyCols.forEach((c, i) => (dbKey[c.name] = canonical(c.type, readValue(c, row[`__v${i}`]))));
    const current: Row = {};
    const changed: string[] = [];
    beforeCols.forEach((c, i) => {
      current[c.name] = readValue(c, row[`__v${keyCols.length + i}`]);
      if (String(row[`__m${i}`]) !== "1") changed.push(c.name);
    });
    return { found: true, current, changed, dbKey };
  }

  async update(meta: TableMeta, keyColumns: string[], key: Row, set: Row): Promise<number> {
    const m = meta as PgMeta;
    const params: (string | null)[] = [];
    const assigns = cols(m, Object.keys(set)).map((c) => `${quoteName(c.name)} = ${bindValue(params, c, set[c.name]!)}`);
    const where = cols(m, keyColumns).map((c) => keyCondition(c, bindValue(params, c, key[c.name]!)));
    // rowCount は UPDATE 文そのものの行数で、トリガーの中の行数は入らない。
    const res = await run(this.s, `UPDATE ${quoteTable(m)} SET ${assigns.join(", ")} WHERE ${where.join(" AND ")}`, params);
    return res.rowCount ?? 0;
  }
}

export class PostgresDialect implements Dialect {
  readonly name = "postgresql";
  private encodingPromise: Promise<string> | undefined;

  constructor(
    private readonly connector: PgConnector,
    private readonly options: PostgresOptions = {},
  ) {}

  private async withSession<T>(fn: (s: PgSession) => Promise<T>): Promise<T> {
    try {
      return await this.connector.withSession(fn);
    } catch (e) {
      throw toDbError(e);
    }
  }

  /** DB の文字コード（server_encoding）。 */
  private encoding(s: PgSession): Promise<string> {
    this.encodingPromise ??= run(s, `SELECT current_setting('server_encoding') AS "e"`).then((r) => String(r.rows[0]!.e));
    this.encodingPromise.catch(() => (this.encodingPromise = undefined));
    return this.encodingPromise;
  }

  normalizeTable(table: string): string {
    // 比べるのは DB で引いた名前（describeTable の table と外部キーの参照先）どうしなので、そのまま比べる。
    return table;
  }

  async describeTable(table: string): Promise<TableMeta> {
    return this.withSession(async (s) => {
      const encoding = await this.encoding(s);
      // 名前は SQL の読み方で読む（"" で囲まない名前は小文字、スキーマを省くと search_path）。
      let found: Record<string, unknown> | undefined;
      try {
        found = (
          await s.query(
            `SELECT c.oid::text AS "oid", n.nspname::text AS "schema", c.relname::text AS "name" FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass($1::text) AND c.relkind IN ('r', 'p', 'v', 'f')`,
            [table],
          )
        ).rows[0];
      } catch {
        // 名前として読めない（"a.b.c.d" など）。
      }
      if (!found) throw new DbError(`テーブル ${table} が見つかりません`);
      const oid = String(found.oid);
      const colRows = await run(
        s,
        `SELECT a.attname::text AS "name", bt.typname::text AS "type", bt.typtype::text AS "kind",
                format_type(bt.oid, CASE WHEN t.typtype = 'd' THEN t.typtypmod ELSE a.atttypmod END) AS "fmt",
                quote_ident(bn.nspname) || '.' || quote_ident(bt.typname) AS "qtype",
                (NOT a.attnotnull AND NOT (t.typtype = 'd' AND t.typnotnull))::text AS "nullable",
                a.atthasdef::text AS "hasdef",
                (a.attidentity <> '' OR COALESCE(pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%', false))::text AS "ident",
                (a.attgenerated <> '')::text AS "gen"
           FROM pg_attribute a
           JOIN pg_type t ON t.oid = a.atttypid
           JOIN pg_type bt ON bt.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
           JOIN pg_namespace bn ON bn.oid = bt.typnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [oid],
      );
      const columns = colRows.rows.map((r) =>
        pgColumn(
          {
            name: String(r.name),
            typeName: String(r.type),
            typeKind: String(r.kind),
            formatted: String(r.fmt),
            qualifiedType: String(r.qtype),
            nullable: r.nullable === "true",
            hasDefault: r.hasdef === "true",
            identity: r.ident === "true",
            generated: r.gen === "true",
          },
          encoding,
        ),
      );
      const pkRows = await run(
        s,
        `SELECT a.attname::text AS "col" FROM pg_index i
           CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE i.indrelid = $1::oid AND i.indisprimary ORDER BY k.ord`,
        [oid],
      );
      const fkRows = await run(
        s,
        `SELECT con.conname::text AS "name", a.attname::text AS "col", rn.nspname::text AS "rschema", rc.relname::text AS "rtable", ra.attname::text AS "rcol"
           FROM pg_constraint con
           CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, rattnum, ord)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
           JOIN pg_class rc ON rc.oid = con.confrelid
           JOIN pg_namespace rn ON rn.oid = rc.relnamespace
           JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.rattnum
          WHERE con.conrelid = $1::oid AND con.contype = 'f' ORDER BY con.conname, k.ord`,
        [oid],
      );
      const fks = new Map<string, ForeignKeyMeta>();
      for (const r of fkRows.rows) {
        const key = String(r.name);
        let fk = fks.get(key);
        if (!fk) {
          fk = { name: key, columns: [], referencedTable: `${r.rschema}.${r.rtable}`, referencedColumns: [] };
          fks.set(key, fk);
        }
        fk.columns.push(String(r.col));
        fk.referencedColumns.push(String(r.rcol));
      }
      const meta: PgMeta = {
        table: `${found.schema}.${found.name}`,
        schema: String(found.schema),
        name: String(found.name),
        columns,
        primaryKey: pkRows.rows.map((r) => String(r.col)),
        foreignKeys: [...fks.values()],
      };
      return meta;
    });
  }

  async fetchRows(meta: TableMeta, keyColumns: string[], columns: string[], keys: Row[]): Promise<(Row | null)[]> {
    const m = meta as PgMeta;
    const keyCols = cols(m, keyColumns);
    const outCols = cols(m, columns);
    const out: (Row | null)[] = keys.map(() => null);
    // キーは VALUES で表にして結び、どのキーに当たったかを __i で戻す（照合順序で当たるので JS では突き合わせない）。
    // パラメータは 1 回 65535 個まで。
    const chunk = Math.max(1, Math.min(1000, Math.floor(30000 / keyCols.length)));
    await this.withSession(async (s) => {
      for (let start = 0; start < keys.length; start += chunk) {
        const part = keys.slice(start, start + chunk);
        const params: (string | null)[] = [];
        const values = part.map((k, i) => `(${[String(i), ...keyCols.map((c) => bindValue(params, c, k[c.name]!))].join(", ")})`);
        const alias = keyCols.map((_, j) => quoteName(`k${j}`));
        const on = keyCols.map((c, j) => `t.${quoteName(c.name)} = v.${alias[j]}`);
        const select = outCols.map((c, i) => `${selectExpr(c, "t.")} AS ${quoteName(`__v${i}`)}`);
        const { rows } = await run(
          s,
          `SELECT v."__i"::text AS "__i", ${select.join(", ")} FROM (VALUES ${values.join(", ")}) AS v("__i", ${alias.join(", ")})
             JOIN ${quoteTable(m)} t ON ${on.join(" AND ")}`,
          params,
        );
        for (const r of rows) {
          const i = start + Number(r.__i);
          if (out[i]) throw new DbError(`キー ${JSON.stringify(keys[i])} に当たる行が複数あります（キーが一意ではありません）`);
          const row: Row = {};
          outCols.forEach((c, j) => (row[c.name] = readValue(c, r[`__v${j}`])));
          out[i] = row;
        }
      }
    });
    return out;
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<{ commit: boolean; value: T }>): Promise<T> {
    return this.withSession(async (s) => {
      await run(s, "BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        // ほかのセッションがロックしている行は lockWaitSeconds だけ待つ（仕様 7 章の手順 3）。SET LOCAL なのでこのトランザクションの中だけ。
        await run(s, `SELECT set_config('lock_timeout', $1::text, true)`, [`${this.options.lockWaitSeconds ?? 10}s`]);
        const { commit, value } = await fn(new PgTransaction(s));
        await run(s, commit ? "COMMIT" : "ROLLBACK");
        return value;
      } catch (e) {
        try {
          await s.query("ROLLBACK");
        } catch {
          // つながりが切れていれば、DB 側で取り消される。
        }
        throw e;
      }
    });
  }

  private renderUpdate(m: PgMeta, u: ScriptUpdate): string {
    const assigns = cols(m, Object.keys(u.set)).map((c) => `${quoteName(c.name)} = ${literal(c, u.set[c.name]!)}`);
    const keyConds = cols(m, Object.keys(u.key)).map((c) => keyCondition(c, literal(c, u.key[c.name]!)));
    const valueConds = cols(m, Object.keys(u.expect)).map((c) => sameCondition(c, u.expect[c.name] === null ? null : literal(c, u.expect[c.name]!)));
    return `UPDATE ${quoteTable(m)} SET ${assigns.join(", ")} WHERE ${[...keyConds, ...valueConds].join(" AND ")}`;
  }

  /**
   * DO ブロック（PL/pgSQL の無名ブロック）1 つにして、人が流しても 1 トランザクションになるようにする。psql のメタコマンドは使わない
   * （pgAdmin、DBeaver などでも流せるように）。反映は 1 行でも当たらなければエラーで止まり、全部戻る。戻しは当たらなかった行を飛ばし、NOTICE に出す。
   */
  renderScript(meta: TableMeta, head: string, updates: ScriptUpdate[], kind: "apply" | "undo"): string {
    const m = meta as PgMeta;
    const body: string[] = ["#variable_conflict use_column", "DECLARE", "  harikit_rows integer;"];
    if (kind === "undo") body.push("  harikit_done integer := 0;");
    body.push("BEGIN");
    for (const u of updates) {
      body.push(`  ${this.renderUpdate(m, u)};`, "  GET DIAGNOSTICS harikit_rows = ROW_COUNT;");
      if (kind === "apply") {
        const msg = quoteString(`harikit: 行が見つからないか、値が変わっています（${scriptKeyText(u.key)}）。何も反映していません`);
        body.push(`  IF harikit_rows <> 1 THEN RAISE EXCEPTION USING MESSAGE = ${msg}; END IF;`);
      } else {
        const msg = quoteString(`harikit: 戻していない行（後から別の更新が入った）: ${scriptKeyText(u.key)}`);
        body.push(`  IF harikit_rows = 1 THEN harikit_done := harikit_done + 1; ELSE RAISE NOTICE USING MESSAGE = ${msg}; END IF;`);
      }
    }
    if (kind === "undo") body.push(`  RAISE NOTICE 'harikit: % / ${updates.length} 行を戻しました', harikit_done;`);
    body.push("END");
    const text = body.join("\n");
    // 値に区切りの文字列が入っていたら、別の区切りにする。
    let tag = "$harikit$";
    for (let i = 1; text.includes(tag); i++) tag = `$harikit_${i}$`;
    const lines = [head];
    if (kind === "apply") lines.push("-- 1 つのトランザクションで流す。どれかの行が見つからないか値が変わっていたら、何も反映せずに止まる（harikit: で始まるエラー）。");
    else lines.push("-- 今の値が harikit で入れた値のままの行だけ戻す。その後に別の更新が入った行は戻さず、NOTICE に出す。");
    lines.push(
      "-- psql、pgAdmin、DBeaver などで流せる素の SQL（DO ブロック 1 つ）。自動コミットを切っているときは、流した後に COMMIT する。",
      "SET client_encoding = 'UTF8';",
      `DO ${tag}`,
      text,
      `${tag};`,
    );
    return lines.join("\n") + "\n";
  }

  async close(): Promise<void> {
    await this.connector.close();
  }
}
