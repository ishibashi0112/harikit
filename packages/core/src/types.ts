// サーバ API（docs/api-spec.md v1）の型。

/** 正規化した列の型（仕様 1.3）。 */
export type ColumnType =
  | "string"
  | "integer"
  | "bigint"
  | "decimal"
  | "float"
  | "boolean"
  | "date"
  | "datetime"
  | "time"
  | "other";

/** JSON で行き来する値。bigint / decimal / 日付時刻は文字列。 */
export type Value = string | number | boolean | null;

export type Row = Record<string, Value>;

export interface ColumnDef {
  name: string;
  type: ColumnType;
  dbType: string;
  nullable: boolean;
  updatable: boolean;
  /** 文字数。max は -1。 */
  maxLength?: number;
  /** 桁をバイトで数える文字列の列の上限バイト数（varchar(10) なら 10、nvarchar(10) なら 20）。 */
  maxBytes?: number;
  /** 文字列の列の文字コード（WHATWG の名前。"shift_jis"、"windows-1252"、"utf-8"、"utf-16le" など）。 */
  encoding?: string;
  /** 空文字を入れると NULL になる列（Oracle の文字列の列）。取込の空文字は NULL として扱う。 */
  emptyIsNull?: boolean;
  precision?: number;
  scale?: number;
  /**
   * 整数の列（integer / bigint）の範囲。値と同じ書き方で、integer は数値、bigint は文字列。
   * 無ければ dbType の型名で決める（tinyint は 0〜255 など）。同じ型名でも範囲が DB で違う（MySQL の tinyint は -128〜127、unsigned）ときに付く。
   */
  min?: number | string;
  max?: number | string;
  identity?: boolean;
  computed?: boolean;
  hasDefault?: boolean;
  /** 表示名（許可リストの labels）。取込の見出しは列名でもこれでもよい。 */
  label?: string;
}

export interface ForeignKeyDef {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  referencedTarget: string | null;
}

export interface Limits {
  maxFetchKeys: number;
  maxApplyRows: number;
}

export type Access = "update" | "read";

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface Failure {
  ok: false;
  v: 1;
  error: ApiError;
  rowErrors?: RowError[];
  conflicts?: Conflict[];
  requestId?: string;
  mode?: ApplyMode;
}

export interface RowError {
  target: string;
  index: number;
  code: string;
  column?: string;
  message?: string;
}

export interface DescribeRequest {
  v: 1;
  target?: string;
}

export interface TargetSummary {
  target: string;
  table: string;
  access: Access;
}

export interface DescribeTargetsResponse {
  ok: true;
  v: 1;
  targets: TargetSummary[];
}

/** サーバが反映のたびに入れる列（許可リストの stamp）。now は DB の今の時刻、user は反映した人。 */
export interface StampDef {
  column: string;
  value: "now" | "user";
}

export interface TableDescription {
  ok: true;
  v: 1;
  target: string;
  table: string;
  access: Access;
  dialect: string;
  key: string[];
  columns: ColumnDef[];
  foreignKeys: ForeignKeyDef[];
  limits: Limits;
  /** サーバに置いた業務ルール（patchiri.rules.json のこのターゲットの分）。コアは外せないルールとして使う。 */
  rules?: unknown[];
  stamp?: StampDef[];
  /** このターゲットで触れる行の固定の条件（許可リストの scope）。 */
  scope?: Row;
}

export interface FetchRequest {
  v: 1;
  target: string;
  keys: Row[];
  columns?: string[];
}

export type FetchedRow =
  | { index: number; found: true; values: Row }
  | { index: number; found: false };

export interface FetchResponse {
  ok: true;
  v: 1;
  target: string;
  rows: FetchedRow[];
}

export type ApplyMode = "check" | "execute";

export interface ApplyRow {
  op?: "update";
  key: Row;
  before: Row;
  after: Row;
}

export interface ApplyRequest {
  v: 1;
  requestId: string;
  mode: ApplyMode;
  note?: string;
  changes: { target: string; rows: ApplyRow[] }[];
}

export interface Conflict {
  target: string;
  index: number;
  key: Row;
  reason: "not_found" | "changed";
  columns?: string[];
  current?: Row;
}

export interface ApplyResponse {
  ok: true;
  v: 1;
  requestId: string;
  mode: ApplyMode;
  appliedAt: string;
  appliedBy: string;
  results: { target: string; updated: number }[];
  script: string;
  undoScript: string;
}
