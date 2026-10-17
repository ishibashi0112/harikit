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
  /**
   * 更新ロックを掛けて 1 行読み、before と比べる。行はキーで DB の比較規則（照合順序）で探し、
   * 値は厳密に比べる（仕様 1.6。大文字小文字、かな、全角半角、末尾の空白を区別する。char / nchar の末尾の空白だけは見ない）。
   */
  lockAndCompare(meta: TableMeta, keyColumns: string[], key: Row, before: Row): Promise<LockedRow>;
  /** パラメータ付き UPDATE を 1 行流し、影響行数を返す。 */
  update(meta: TableMeta, keyColumns: string[], key: Row, set: Row): Promise<number>;
}

/** DB がエラーを返したとき。message は生のエラー文。 */
export class DbError extends Error {
  /** 利用者に見せてよい説明（接続先や SQL を含まない）。あれば db_error の message にこれを出す。 */
  readonly publicMessage?: string;
  constructor(message: string, options?: { cause?: unknown; publicMessage?: string }) {
    super(message, options);
    this.name = "DbError";
    if (options?.publicMessage) this.publicMessage = options.publicMessage;
  }
}

/** 人が読む SQL の UPDATE 1 本分。key で行を探し（照合順序）、expect は「この値のときだけ」の条件（厳密に比べる）。 */
export interface ScriptUpdate {
  set: Row;
  key: Row;
  expect: Row;
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
  /**
   * 文字列の値が列の文字コードで表せるか、何バイトになるかを DB 自身に確かめる（コアの表は目安なので、これが最後の確認）。
   * 確かめない列（nvarchar など）の値には null を返す。
   */
  checkStrings?(meta: TableMeta, items: { column: string; value: string }[]): Promise<({ encodable: boolean; bytes: number } | null)[]>;
  /**
   * 人が流せる SQL（値を埋め込んだもの）を作る。head は先頭のコメント行。人が流しても 1 トランザクションになる形に包む。
   * apply は反映する SQL、undo は戻し SQL（今の値が expect のままの行だけ戻す）。
   */
  renderScript(meta: TableMeta, head: string, updates: ScriptUpdate[], kind: "apply" | "undo"): string;
  close(): Promise<void>;
}
