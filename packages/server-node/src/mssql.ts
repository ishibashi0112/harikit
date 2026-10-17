// SQL Server の方言。SQL はここでだけ組み、値はすべてパラメータで渡す。
// テーブル名と列名は許可リストと DB の定義から取り、[] で囲む。

import sql from "mssql";
import type { ColumnType, Row, Value } from "@harikit/core";
import { canonical } from "@harikit/core";
import type { SqlServerConnection } from "./config.js";
import { DbError, type ColumnMeta, type Dialect, type ForeignKeyMeta, type LockedRow, type TableMeta, type Transaction } from "./dialect.js";

/** 内部で使う列の情報。sqlType は CAST に使う型（DB の定義から作る）。 */
interface MsColumn extends ColumnMeta {
  baseType: string;
  sqlType: string;
  /** 列の照合順序（char / varchar だけ）。 */
  collation?: string;
}

type Executor = { request(): sql.Request };

const TYPE_MAP: Record<string, ColumnType> = {
  char: "string",
  varchar: "string",
  nchar: "string",
  nvarchar: "string",
  tinyint: "integer",
  smallint: "integer",
  int: "integer",
  bigint: "bigint",
  decimal: "decimal",
  numeric: "decimal",
  money: "decimal",
  smallmoney: "decimal",
  real: "float",
  float: "float",
  bit: "boolean",
  date: "date",
  datetime: "datetime",
  datetime2: "datetime",
  smalldatetime: "datetime",
  time: "time",
};

/** 照合順序のコードページ → WHATWG の文字コード名。 */
const CODE_PAGES: Record<number, string> = {
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  65001: "utf-8",
};

/** 名前を [] で囲む。] は ]] にする。 */
export function quoteName(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

/** "dbo.M_Product" や "[dbo].[M_Product]" を [スキーマ, 名前] に分ける。スキーマを省くと dbo。 */
export function splitTableName(table: string): [string, string] {
  const parts: string[] = [];
  const re = /\s*(?:\[((?:[^\]]|\]\])*)\]|([^.[\]]+))\s*(?:\.|$)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < table.length && (m = re.exec(table))) parts.push(m[1] !== undefined ? m[1].replace(/]]/g, "]") : m[2]!.trim());
  if (re.lastIndex < table.length || parts.length === 0 || parts.length > 2) throw new Error(`テーブル名 ${table} が読めません`);
  return parts.length === 1 ? ["dbo", parts[0]!] : [parts[0]!, parts[1]!];
}

export function quoteTable(table: string): string {
  return splitTableName(table).map(quoteName).join(".");
}

function dbTypeText(base: string, bytes: number, precision: number, scale: number): string {
  switch (base) {
    case "char":
    case "varchar":
    case "binary":
    case "varbinary":
      return `${base}(${bytes === -1 ? "max" : bytes})`;
    case "nchar":
    case "nvarchar":
      return `${base}(${bytes === -1 ? "max" : bytes / 2})`;
    case "decimal":
    case "numeric":
      return `${base}(${precision},${scale})`;
    case "datetime2":
    case "time":
    case "datetimeoffset":
      return `${base}(${scale})`;
    default:
      return base;
  }
}

/** SELECT で値を仕様 1.3 の形で受け取るための式。 */
function selectExpr(col: MsColumn, prefix = ""): string {
  const q = prefix + quoteName(col.name);
  switch (col.baseType) {
    case "decimal":
    case "numeric":
      return `CONVERT(varchar(50), ${q})`;
    case "money":
    case "smallmoney":
      return `CONVERT(varchar(50), ${q}, 2)`;
    case "bigint":
      return `CONVERT(varchar(20), ${q})`;
    case "date":
      return `CONVERT(char(10), ${q}, 23)`;
    case "datetime":
    case "datetime2":
    case "smalldatetime":
      return `CONVERT(varchar(27), ${q}, 126)`;
    case "time":
      return `CONVERT(varchar(16), ${q})`;
    case "binary":
    case "varbinary":
      return `CONVERT(varchar(max), ${q}, 1)`;
    default:
      return col.type === "other" ? `CONVERT(nvarchar(max), ${q})` : q;
  }
}

function readValue(col: MsColumn, v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (col.type === "datetime" || col.type === "time") return canonical(col.type, String(v));
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

/**
 * 値を渡す式を作り、パラメータを足す。文字列は列が varchar でも nvarchar で渡す
 * （varchar で渡すと DB の既定の照合順序のコードページで送られ、列の照合順序が違うと
 * 日本語が「?」になる）。数値と日時以外は文字列で渡して DB の型へ CAST する（精度を崩さない）。
 */
function bindValue(req: sql.Request, name: string, col: MsColumn, v: Value): string {
  switch (col.baseType) {
    case "char":
    case "varchar":
    case "nchar":
    case "nvarchar": {
      const len = col.maxLength === undefined || col.maxLength === -1 || col.maxLength > 4000 ? sql.MAX : col.maxLength;
      req.input(name, sql.NVarChar(len), v);
      return `@${name}`;
    }
    case "tinyint":
      req.input(name, sql.TinyInt, v);
      return `@${name}`;
    case "smallint":
      req.input(name, sql.SmallInt, v);
      return `@${name}`;
    case "int":
      req.input(name, sql.Int, v);
      return `@${name}`;
    case "real":
    case "float":
      req.input(name, sql.Float, v);
      return `@${name}`;
    case "bit":
      req.input(name, sql.Bit, v);
      return `@${name}`;
    default:
      req.input(name, sql.VarChar(64), v === null ? null : String(v));
      return `CAST(@${name} AS ${col.sqlType})`;
  }
}

/** 人が読む SQL 用の値の書き方。値は checkValue で形を確かめた後のものだけが来る。 */
export function literal(col: MsColumn, v: Value): string {
  if (v === null) return "NULL";
  switch (col.type) {
    case "string": {
      // varchar の列にも N'' で書く（列の照合順序で変換され、DB の既定と違っても崩れない）。
      return `N'${String(v).replace(/'/g, "''")}'`;
    }
    case "boolean":
      return v ? "1" : "0";
    case "integer":
    case "float":
      return String(Number(v));
    case "bigint":
    case "decimal":
      if (!/^-?\d+(\.\d+)?$/.test(String(v))) throw new Error(`数値ではない値: ${String(v)}`);
      return String(v);
    case "date":
    case "datetime":
    case "time":
      if (!/^[0-9:T.-]+$/.test(String(v))) throw new Error(`日付ではない値: ${String(v)}`);
      return `'${String(v)}'`;
    default:
      throw new Error(`列 ${col.name} の型は SQL に書けません`);
  }
}

function condition(col: MsColumn, expr: string | null): string {
  return expr === null ? `${quoteName(col.name)} IS NULL` : `${quoteName(col.name)} = ${expr}`;
}

/**
 * 値が厳密に同じかの条件（仕様 1.6）。文字列は列の照合順序を使わず、nvarchar に直してから BIN2 で比べる
 * （varchar のまま BIN2 を当てるとコードページが変わって日本語が「?」に崩れる）。
 * `=` は末尾の空白を無視するので、可変長の列は DATALENGTH も比べる。char / nchar の末尾の空白は詰め物なので見ない。
 * expr は nvarchar の値（パラメータか N'' リテラル）。
 */
function sameCondition(col: MsColumn, expr: string | null): string {
  if (expr === null || col.type !== "string") return condition(col, expr);
  const v = `CAST(${quoteName(col.name)} AS nvarchar(max))`;
  const eq = `${v} COLLATE Latin1_General_BIN2 = ${expr}`;
  return col.baseType === "char" || col.baseType === "nchar" ? eq : `(${eq} AND DATALENGTH(${v}) = DATALENGTH(${expr}))`;
}

function cols(meta: TableMeta, names: string[]): MsColumn[] {
  return names.map((n) => {
    const c = (meta.columns as MsColumn[]).find((x) => x.name === n);
    if (!c) throw new Error(`列 ${n} が ${meta.table} にありません`);
    return c;
  });
}

async function run(exec: Executor, build: (req: sql.Request) => string): Promise<sql.IResult<Record<string, unknown>>> {
  const req = exec.request();
  const text = build(req);
  try {
    return await req.query(text);
  } catch (e) {
    throw new DbError(e instanceof Error ? e.message : String(e), { cause: e });
  }
}

class MsTransaction implements Transaction {
  constructor(private readonly tx: sql.Transaction) {}

  async lockAndCompare(meta: TableMeta, keyColumns: string[], key: Row, before: Row): Promise<LockedRow> {
    const keyCols = cols(meta, keyColumns);
    const beforeCols = cols(meta, Object.keys(before));
    const res = await run(this.tx, (req) => {
      const where = keyCols.map((c, i) => condition(c, bindValue(req, `k${i}`, c, key[c.name]!)));
      const checks = beforeCols.map((c, i) => {
        const v = before[c.name]!;
        const cond = sameCondition(c, v === null ? null : bindValue(req, `b${i}`, c, v));
        return `CASE WHEN ${cond} THEN 1 ELSE 0 END AS ${quoteName(`__m${i}`)}`;
      });
      const select = [...keyCols, ...beforeCols].map((c, i) => `${selectExpr(c)} AS ${quoteName(`__v${i}`)}`);
      return `SELECT ${[...select, ...checks].join(", ")} FROM ${quoteTable(meta.table)} WITH (UPDLOCK, HOLDLOCK) WHERE ${where.join(" AND ")}`;
    });
    const rows = res.recordset;
    if (rows.length === 0) return { found: false };
    if (rows.length > 1) throw new DbError(`キー ${JSON.stringify(key)} に当たる行が ${rows.length} 行あります（キーが一意ではありません）`);
    const row = rows[0]!;
    const dbKey: Row = {};
    keyCols.forEach((c, i) => (dbKey[c.name] = canonical(c.type, readValue(c, row[`__v${i}`]))));
    const current: Row = {};
    const changed: string[] = [];
    beforeCols.forEach((c, i) => {
      current[c.name] = readValue(c, row[`__v${keyCols.length + i}`]);
      if (row[`__m${i}`] !== 1) changed.push(c.name);
    });
    return { found: true, current, changed, dbKey };
  }

  async update(meta: TableMeta, keyColumns: string[], key: Row, set: Row): Promise<number> {
    const keyCols = cols(meta, keyColumns);
    const setCols = cols(meta, Object.keys(set));
    const res = await run(this.tx, (req) => {
      const assigns = setCols.map((c, i) => `${quoteName(c.name)} = ${bindValue(req, `p${i}`, c, set[c.name]!)}`);
      const where = keyCols.map((c, i) => condition(c, bindValue(req, `k${i}`, c, key[c.name]!)));
      // rowsAffected にはトリガーの文の行数も入るので、UPDATE 本体の行数は @@ROWCOUNT で読む。
      return `UPDATE ${quoteTable(meta.table)} SET ${assigns.join(", ")} WHERE ${where.join(" AND ")}; SELECT @@ROWCOUNT AS [n];`;
    });
    // トリガーが結果セットを返すこともあるので、最後の結果セットを読む。
    const sets = res.recordsets as sql.IRecordSet<{ n: number }>[];
    return Number(sets[sets.length - 1]?.[0]?.n ?? 0);
  }
}

export class SqlServerDialect implements Dialect {
  readonly name = "sqlserver";
  private poolPromise: Promise<sql.ConnectionPool> | undefined;

  constructor(private readonly conn: SqlServerConnection) {}

  private pool(): Promise<sql.ConnectionPool> {
    this.poolPromise ??= new sql.ConnectionPool({
      server: this.conn.server,
      port: this.conn.port ?? 1433,
      database: this.conn.database,
      user: this.conn.user,
      password: this.conn.password,
      options: { encrypt: this.conn.options?.encrypt ?? true, trustServerCertificate: this.conn.options?.trustServerCertificate ?? false, instanceName: this.conn.options?.instanceName },
    }).connect();
    return this.poolPromise;
  }

  normalizeTable(table: string): string {
    return splitTableName(table).join(".").toLowerCase();
  }

  async describeTable(table: string): Promise<TableMeta> {
    const pool = await this.pool();
    const [schema, name] = splitTableName(table);
    const qualified = quoteTable(table);
    const colRes = await run(pool, (req) => {
      req.input("name", sql.NVarChar(512), qualified);
      return `SELECT c.name, TYPE_NAME(c.system_type_id) AS base_type, c.max_length, c.precision, c.scale,
                c.is_nullable, c.is_identity, c.is_computed, c.default_object_id,
                c.collation_name, CONVERT(int, COLLATIONPROPERTY(c.collation_name, 'CodePage')) AS code_page
                FROM sys.columns c WHERE c.object_id = OBJECT_ID(@name) ORDER BY c.column_id`;
    });
    if (colRes.recordset.length === 0) throw new DbError(`テーブル ${table} が見つかりません`);
    const columns: MsColumn[] = colRes.recordset.map((r) => {
      const base = String(r.base_type);
      const bytes = Number(r.max_length);
      const type = TYPE_MAP[base] ?? "other";
      const maxLength = bytes === -1 ? -1 : base === "nchar" || base === "nvarchar" ? bytes / 2 : bytes;
      const precision = Number(r.precision);
      const scale = Number(r.scale);
      const dbType = dbTypeText(base, bytes, precision, scale);
      const col: MsColumn = {
        name: String(r.name),
        type,
        dbType,
        nullable: Boolean(r.is_nullable),
        baseType: base,
        sqlType: dbType,
      };
      if (type === "string") {
        col.maxLength = maxLength;
        // 桁はバイトで決まる。nchar / nvarchar は UTF-16、char / varchar は照合順序のコードページ。
        const encoding = base.startsWith("n") ? "utf-16le" : CODE_PAGES[Number(r.code_page)];
        if (encoding) col.encoding = encoding;
        if (bytes !== -1) col.maxBytes = bytes;
        if (!base.startsWith("n") && typeof r.collation_name === "string") col.collation = r.collation_name;
      }
      if (type === "decimal") {
        col.precision = precision;
        col.scale = scale;
      }
      if (type === "datetime" || type === "time") col.scale = base === "datetime" ? 3 : scale;
      if (r.is_identity) col.identity = true;
      if (r.is_computed) col.computed = true;
      if (Number(r.default_object_id) !== 0) col.hasDefault = true;
      return col;
    });
    const pkRes = await run(pool, (req) => {
      req.input("name", sql.NVarChar(512), qualified);
      return `SELECT c.name FROM sys.indexes i
                JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                WHERE i.object_id = OBJECT_ID(@name) AND i.is_primary_key = 1 ORDER BY ic.key_ordinal`;
    });
    const fkRes = await run(pool, (req) => {
      req.input("name", sql.NVarChar(512), qualified);
      return `SELECT fk.name, pc.name AS col, OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS ref_schema,
                OBJECT_NAME(fk.referenced_object_id) AS ref_table, rc.name AS ref_col
                FROM sys.foreign_keys fk
                JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
                JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
                JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
                WHERE fk.parent_object_id = OBJECT_ID(@name) ORDER BY fk.name, fkc.constraint_column_id`;
    });
    const fks = new Map<string, ForeignKeyMeta>();
    for (const r of fkRes.recordset) {
      const key = String(r.name);
      let fk = fks.get(key);
      if (!fk) {
        fk = { name: key, columns: [], referencedTable: `${r.ref_schema}.${r.ref_table}`, referencedColumns: [] };
        fks.set(key, fk);
      }
      fk.columns.push(String(r.col));
      fk.referencedColumns.push(String(r.ref_col));
    }
    return {
      table: `${schema}.${name}`,
      columns,
      primaryKey: pkRes.recordset.map((r) => String(r.name)),
      foreignKeys: [...fks.values()],
    };
  }

  async fetchRows(meta: TableMeta, keyColumns: string[], columns: string[], keys: Row[]): Promise<(Row | null)[]> {
    const pool = await this.pool();
    const keyCols = cols(meta, keyColumns);
    const outCols = cols(meta, columns);
    const out: (Row | null)[] = keys.map(() => null);
    // 1 回のパラメータは 2100 個まで、VALUES は 1000 行まで。
    const chunk = Math.min(1000, Math.floor(2000 / keyCols.length));
    for (let start = 0; start < keys.length; start += chunk) {
      const part = keys.slice(start, start + chunk);
      const res = await run(pool, (req) => {
        const values = part.map((k, i) => `(${[String(i), ...keyCols.map((c, j) => bindValue(req, `k${i}_${j}`, c, k[c.name]!))].join(", ")})`);
        const alias = keyCols.map((_, j) => quoteName(`k${j}`));
        const on = keyCols.map((c, j) => `t.${quoteName(c.name)} = v.${alias[j]}`);
        const select = outCols.map((c, i) => `${selectExpr(c, "t.")} AS ${quoteName(`__v${i}`)}`);
        return `SELECT v.[__i], ${select.join(", ")} FROM (VALUES ${values.join(", ")}) AS v([__i], ${alias.join(", ")})
                  JOIN ${quoteTable(meta.table)} t ON ${on.join(" AND ")}`;
      });
      for (const r of res.recordset) {
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
    const pool = await this.pool();
    const tx = new sql.Transaction(pool);
    try {
      await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    } catch (e) {
      throw new DbError(e instanceof Error ? e.message : String(e), { cause: e });
    }
    try {
      const { commit, value } = await fn(new MsTransaction(tx));
      if (commit) await tx.commit();
      else await tx.rollback();
      return value;
    } catch (e) {
      try {
        await tx.rollback();
      } catch {
        // すでにロールバックされている（XACT_ABORT など）。
      }
      throw e;
    }
  }

  async checkStrings(meta: TableMeta, items: { column: string; value: string }[]): Promise<({ encodable: boolean; bytes: number } | null)[]> {
    const out: ({ encodable: boolean; bytes: number } | null)[] = items.map(() => null);
    const byColumn = new Map<MsColumn, number[]>();
    items.forEach((it, i) => {
      const [col] = cols(meta, [it.column]) as MsColumn[];
      // 照合順序の名前は DB の定義から来るが、SQL に書くので形を確かめる。
      if (!col!.collation || !/^[A-Za-z0-9_]+$/.test(col!.collation)) return;
      byColumn.set(col!, [...(byColumn.get(col!) ?? []), i]);
    });
    const pool = await this.pool();
    for (const [col, indexes] of byColumn) {
      for (let start = 0; start < indexes.length; start += 1000) {
        const part = indexes.slice(start, start + 1000);
        const res = await run(pool, (req) => {
          const values = part.map((i, j) => {
            req.input(`s${j}`, sql.NVarChar(sql.MAX), items[i]!.value);
            return `(${j}, @s${j})`;
          });
          // 列の照合順序で varchar にして戻し、元と同じか（表せない字は「?」になる）とバイト数を見る。
          const asVarchar = `CAST(v.[s] COLLATE ${col.collation} AS varchar(max))`;
          return `SELECT v.[j], CASE WHEN CAST(${asVarchar} AS nvarchar(max)) COLLATE Latin1_General_BIN2 = v.[s] COLLATE Latin1_General_BIN2 THEN 1 ELSE 0 END AS [ok],
                    DATALENGTH(${asVarchar}) AS [bytes] FROM (VALUES ${values.join(", ")}) AS v([j], [s])`;
        });
        for (const r of res.recordset) out[part[Number(r.j)]!] = { encodable: r.ok === 1, bytes: Number(r.bytes) };
      }
    }
    return out;
  }

  renderUpdate(meta: TableMeta, set: Row, key: Row, expect: Row): string {
    const assigns = cols(meta, Object.keys(set)).map((c) => `${quoteName(c.name)} = ${literal(c, set[c.name]!)}`);
    const keyConds = cols(meta, Object.keys(key)).map((c) => condition(c, key[c.name] === null ? null : literal(c, key[c.name]!)));
    const valueConds = cols(meta, Object.keys(expect)).map((c) => sameCondition(c, expect[c.name] === null ? null : literal(c, expect[c.name]!)));
    return `UPDATE ${quoteTable(meta.table)} SET ${assigns.join(", ")} WHERE ${[...keyConds, ...valueConds].join(" AND ")}`;
  }

  async close(): Promise<void> {
    if (this.poolPromise) await (await this.poolPromise).close();
  }
}
