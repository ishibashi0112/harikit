// DB ごとの違いを閉じ込める入口。handlers はこの形だけを使う。

import type { ColumnDef, Row } from "@harikit/core";

/** DB から読んだ列の定義。updatable は許可リストと合わせて handlers が決める。 */
export type ColumnMeta = Omit<ColumnDef, "updatable">;

export interface ForeignKeyMeta {
  name: string;
  columns: string[];
  /** スキーマ付きの名前（"dbo.M_Category"）。 */
  referencedTable: string;
  referencedColumns: string[];
}

export interface TableMeta {
  /** スキーマ付きの名前（"dbo.M_Product"）。 */
  table: string;
  /** DB の列順。 */
  columns: ColumnMeta[];
  primaryKey: string[];
  foreignKeys: ForeignKeyMeta[];
}

export interface LockedRow {
  found: boolean;
  /** before に書かれた列の今の値。 */
  current?: Row;
  /** before と今の値が違う列。 */
  changed?: string[];
  /** DB にあるキーの値（照合順序で同じ行を指す 2 行を見分けるため）。 */
  dbKey?: Row;
}

export interface Transaction {
  /** 更新ロックを掛けて 1 行読み、before と DB の比較規則で比べる。 */
  lockAndCompare(meta: TableMeta, keyColumns: string[], key: Row, before: Row): Promise<LockedRow>;
  /** パラメータ付き UPDATE を 1 行流し、影響行数を返す。 */
  update(meta: TableMeta, keyColumns: string[], key: Row, set: Row): Promise<number>;
}

/** DB がエラーを返したとき。message は生のエラー文。 */
export class DbError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DbError";
  }
}

export interface Dialect {
  readonly name: string;
  /** テーブル名をこの DB の正規の形（比較用）にする。 */
  normalizeTable(table: string): string;
  describeTable(table: string): Promise<TableMeta>;
  /** keys と同じ順で、見つかった行（キー列と columns）か null を返す。 */
  fetchRows(meta: TableMeta, keyColumns: string[], columns: string[], keys: Row[]): Promise<(Row | null)[]>;
  /** fn の後、commit が true ならコミット、false ならロールバックする。例外でもロールバック。 */
  transaction<T>(fn: (tx: Transaction) => Promise<{ commit: boolean; value: T }>): Promise<T>;
  /** 人が読む UPDATE 文を 1 本作る。where は「この値のときだけ」の条件。 */
  renderUpdate(meta: TableMeta, set: Row, where: Row): string;
  close(): Promise<void>;
}
