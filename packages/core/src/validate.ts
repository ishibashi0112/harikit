// 検証。取込データを DB の定義（describe の結果）で全行チェックし、型をそろえた値にする。
// 数・日付・時刻・真偽の列は、Excel の表示の形（2024/4/1、1,200 など）も読み、読み替えたセルを readings に残す。
// 文字列の列は直さない（全角半角も前後の空白もそのまま。前後の空白は警告だけ出す）。

import { readBooleanText, readDateText, readNumberText, readTimeText } from "./display.js";
import { byteCount } from "./encoding.js";
import { checkRule, isRowRule, type CompiledRule } from "./rules.js";
import { cellRef, type Cell, type Sheet } from "./table.js";
import type { ColumnDef, Row, TableDescription, Value } from "./types.js";
import { BIGINT_RE, canonical, checkValue, DATE_RE, DATETIME_RE, DECIMAL_RE, TIME_RE } from "./values.js";

export interface Issue {
  severity: "error" | "warning";
  message: string;
  /**
   * 問題の種類（文を差し替えたり、種類ごとに扱いを変えたりするため）。
   * unknown_column、duplicate_column、column_not_updatable、missing_key_column、no_update_columns、encoding_unknown、
   * invalid_value、key_empty、duplicate_key、whitespace、rule_violation、rules_invalid、reference_missing、reference_unchecked、
   * same_db_row、それと checkRow が返したもの（既定は custom）。
   */
  code?: string;
  /** 文に入れた値（列名、行番号など）。 */
  params?: Record<string, unknown>;
  /** シートの行（0 始まり）。シート全体の問題なら無し。 */
  row?: number;
  /** シートの列（0 始まり）。 */
  col?: number;
  /** "B3" の形のセル番地。 */
  cell?: string;
  column?: string;
}

export interface ParsedRow {
  /** シートの行（0 始まり）。 */
  row: number;
  key: Row;
  /** 正しく読めたセルの値。誤りのあるセルは入らない。 */
  values: Row;
  /** この行に誤りがないか。 */
  ok: boolean;
}

/** Excel の表示の形から読み替えたセル。 */
export interface Reading {
  /** シートの行（0 始まり）。 */
  row: number;
  /** シートの列（0 始まり）。 */
  col: number;
  /** "B3" の形のセル番地。 */
  cell: string;
  column: string;
  /** 取り込んだままの文字列（"2024/4/1"、"¥1,200"）。 */
  text: string;
  /** 読み替えた値（DB に送る形）。 */
  value: Value;
}

export interface ValidationResult {
  ok: boolean;
  keyColumns: string[];
  updateColumns: string[];
  /** 列名 → シートの列（0 始まり）。 */
  columnIndex: Record<string, number>;
  /** 誤りのある行も含む。差分に使うのは ok の行だけ。 */
  rows: ParsedRow[];
  issues: Issue[];
  /** Excel の表示の形から読み替えたセル（誤りのないセルだけ）。 */
  readings: Reading[];
}

/** checkRow に渡す 1 行。 */
export interface RowCheckInput {
  /** シートの行（0 始まり）。 */
  row: number;
  key: Row;
  /** 正しく読めたセルの値（誤りのあるセルは入らない）。 */
  values: Row;
  /** 列名 → シートの列（0 始まり）。 */
  columnIndex: Record<string, number>;
}

/** checkRow が返す問題。column を書けばそのセルを指す。 */
export interface RowCheckIssue {
  message: string;
  column?: string;
  /** 既定は "error"。 */
  severity?: "error" | "warning";
  /** 既定は "custom"。 */
  code?: string;
}

export interface ValidateOptions {
  /** 見出しの行（0 始まり）。既定は 0。 */
  headerRow?: number;
  /** 業務ルール（compileRules で作ったもの）。変動率のルールと、取込に無い列を見る行のルールは差分で見る。 */
  rules?: CompiledRule[];
  /** 見出しの別名（見出しの文字 → 列名）。describe の表示名（label）に加えて使う。大文字小文字は問わない。 */
  aliases?: Record<string, string>;
  /** Excel の表示の形（2024/4/1、¥1,200 など）を読み替えるか。既定は true。false なら決まった形（2024-04-01、1200）だけを受ける。 */
  readDisplay?: boolean;
  /** 行ごとの自前の確かめ。業務ルールの形で書けない決まりに使う。 */
  checkRow?: (input: RowCheckInput) => RowCheckIssue[] | void | null | undefined;
}

/** read は Excel の表示の形から読み替えたこと。 */
type Converted = { value: Value; read?: true } | { error: string };

const read = (value: Value): Converted => ({ value, read: true });

function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toFixed(0);
  // Excel の数値は 15 桁精度なので、浮動小数の端数（0.1+0.2 など）をそこで丸める。
  return String(parseFloat(n.toPrecision(15)));
}

function padScale(v: string, scale: number | undefined): string {
  if (!DECIMAL_RE.test(v) || scale === undefined) return v;
  const c = canonical("decimal", v) as string;
  const [int, frac = ""] = c.split(".");
  if (frac.length > scale) return v;
  return scale === 0 ? int! : `${int}.${frac.padEnd(scale, "0")}`;
}

/** 数の表示（1,200、¥1,200、▲1,200 など）を読む。整数の列なら小数のある数は断る。 */
function numberText(text: string, fallback: string, integer: boolean, make: (n: string) => Value): Converted {
  const r = readNumberText(text);
  if (r === null) return { error: fallback };
  if ("error" in r) return r;
  const n = canonical("decimal", r.ok) as string;
  if (integer && n.includes(".")) return { error: fallback };
  return read(make(n));
}

/** Excel のエラー値。貼り付けや CSV では文字列で届くので、.xlsx のエラーのセルと同じく文字列の列でも断る。 */
const EXCEL_ERRORS = new Set(["#N/A", "#VALUE!", "#REF!", "#DIV/0!", "#NUM!", "#NAME?", "#NULL!", "#SPILL!", "#CALC!", "#GETTING_DATA", "#FIELD!", "#BLOCKED!", "#BUSY!", "#CONNECT!", "#UNKNOWN!"]);

/** セルの値を列の型の値にする。形の確認は checkValue で別に行う。readDisplay が false なら Excel の表示の形は読まない。 */
export function convertCell(col: ColumnDef, cell: Cell, readDisplay = true): Converted {
  if (cell === null) return { value: null };
  if (typeof cell === "object" && cell.kind === "error") return { error: `セルがエラー値です（${cell.text}）` };
  if (cell === "" && col.type !== "string") return { value: null };
  if (typeof cell === "string" && EXCEL_ERRORS.has(cell.trim())) return { error: `セルがエラー値です（${cell.trim()}）` };
  const date = typeof cell === "object" && cell.kind === "date" ? cell.iso : undefined;
  switch (col.type) {
    case "string":
      // Oracle などでは空文字は NULL として入るので、差分も NULL で取る（NOT NULL の列なら「必須」になる）。
      if (typeof cell === "string") return { value: cell === "" && col.emptyIsNull ? null : cell };
      if (typeof cell === "number") return { value: formatNumber(cell) };
      if (date !== undefined) return { error: "日付として入っています（文字列にしてください）" };
      return { error: "文字列ではありません" };
    case "integer":
      if (typeof cell === "number") return { value: cell };
      if (typeof cell === "string") {
        if (/^-?\d+$/.test(cell)) return { value: Number(cell) };
        return readDisplay ? numberText(cell, "整数ではありません", true, Number) : { error: "整数ではありません" };
      }
      return { error: "整数ではありません" };
    case "bigint":
      if (typeof cell === "number") return Number.isSafeInteger(cell) ? { value: String(cell) } : { error: "整数ではありません（精度が足りません）" };
      if (typeof cell === "string") {
        if (BIGINT_RE.test(cell)) return { value: cell };
        return readDisplay ? numberText(cell, "整数ではありません", true, String) : { error: "整数ではありません" };
      }
      return { error: "整数ではありません" };
    case "decimal":
      if (typeof cell === "number") return { value: padScale(formatNumber(cell), col.scale) };
      if (typeof cell === "string") {
        if (DECIMAL_RE.test(cell)) return { value: padScale(cell, col.scale) };
        return readDisplay ? numberText(cell, "数値ではありません", false, (n) => padScale(n, col.scale)) : { error: "数値ではありません" };
      }
      return { error: "数値ではありません" };
    case "float":
      if (typeof cell === "number") return { value: cell };
      if (typeof cell === "string") {
        if (DECIMAL_RE.test(cell)) return { value: Number(cell) };
        return readDisplay ? numberText(cell, "数値ではありません", false, Number) : { error: "数値ではありません" };
      }
      return { error: "数値ではありません" };
    case "boolean":
      if (typeof cell === "boolean") return { value: cell };
      if (cell === 1 || cell === 0) return { value: cell === 1 };
      if (typeof cell === "string") {
        const s = cell.toLowerCase();
        if (s === "true" || s === "1") return { value: true };
        if (s === "false" || s === "0") return { value: false };
        const b = readDisplay ? readBooleanText(cell) : undefined;
        if (b !== undefined) return read(b);
      }
      return { error: "true / false ではありません" };
    case "date":
      if (date !== undefined) {
        return date.endsWith("T00:00:00.000") ? { value: date.slice(0, 10) } : { error: "時刻つきの日付です" };
      }
      if (typeof cell === "string") {
        if (DATE_RE.test(cell)) return { value: cell };
        if (!readDisplay) return { error: "日付として読めません（2024-04-01 の形で書きます）" };
        const r = readDateText(cell);
        if (r === null) return { error: "日付として読めません（2024-04-01 や 2024/4/1 の形で書きます）" };
        if ("error" in r) return r;
        if (r.ok.time !== undefined && !/^00:00:00(\.0*)?$/.test(r.ok.time)) return { error: "時刻つきの日付です" };
        return read(r.ok.date);
      }
      return { error: "日付ではありません" };
    case "datetime":
      // Excel の日付は .000 まで付くので、0 だけの小数は落とす（Oracle の DATE などと差分の見た目をそろえる）。
      if (date !== undefined) return { value: date.replace(/\.0+$/, "") };
      if (typeof cell === "string") {
        if (DATE_RE.test(cell)) return { value: `${cell}T00:00:00` };
        const iso = cell.replace(/^(\d{4}-\d{2}-\d{2}) (?=\d)/, "$1T");
        if (DATETIME_RE.test(iso)) return { value: iso };
        if (!readDisplay) return { error: "日時として読めません（2024-04-01 09:30:00 の形で書きます）" };
        const r = readDateText(cell);
        if (r === null) return { error: "日時として読めません（2024-04-01 09:30:00 や 2024/4/1 9:30 の形で書きます）" };
        if ("error" in r) return r;
        return read(`${r.ok.date}T${r.ok.time ?? "00:00:00"}`);
      }
      return { error: "日時ではありません" };
    case "time":
      if (date !== undefined) {
        if (/^(1899-12-3[01]|1904-01-01)T/.test(date)) return { value: date.slice(11) };
        return { error: "日付つきの時刻です" };
      }
      if (typeof cell === "string") {
        if (TIME_RE.test(cell)) return { value: cell };
        if (/^\d{2}:\d{2}$/.test(cell)) return { value: `${cell}:00` };
        if (!readDisplay) return { error: "時刻として読めません（09:30:00 の形で書きます）" };
        const r = readTimeText(cell);
        if (r === null) return { error: "時刻として読めません（09:30:00 や 9:30 の形で書きます）" };
        if ("error" in r) return r;
        return read(r.ok);
      }
      return { error: "時刻ではありません" };
    case "other":
      return { error: "この型の列は扱えません" };
  }
}

function isBlankRow(row: Cell[] | undefined): boolean {
  return !row || row.every((c) => c === null || c === "");
}

/** 見出しの文字から列を探す。列名、表示名（label）、別名（aliases）の順。どれも大文字小文字は問わない。 */
export function headerColumn(desc: Pick<TableDescription, "columns">, header: string, aliases?: Record<string, string>): ColumnDef | undefined {
  const name = header.trim().toLowerCase();
  if (!name) return undefined;
  const byName = desc.columns.find((c) => c.name.toLowerCase() === name);
  if (byName) return byName;
  const byLabel = desc.columns.find((c) => c.label !== undefined && c.label.trim().toLowerCase() === name);
  if (byLabel) return byLabel;
  if (!aliases) return undefined;
  for (const [alias, column] of Object.entries(aliases)) {
    if (alias.trim().toLowerCase() === name) return desc.columns.find((c) => c.name.toLowerCase() === column.toLowerCase());
  }
  return undefined;
}

/** シートを describe の結果で検証する。見出しは DB の列名か表示名（大文字小文字は問わない）。 */
export function validate(desc: TableDescription, sheet: Sheet, options: ValidateOptions = {}): ValidationResult {
  const headerRow = options.headerRow ?? 0;
  const readDisplay = options.readDisplay ?? true;
  const issues: Issue[] = [];
  const err = (code: string, message: string, row?: number, col?: number, column?: string, params?: Record<string, unknown>) =>
    issues.push({
      severity: "error",
      code,
      message,
      ...(row !== undefined && { row }),
      ...(col !== undefined && { col }),
      ...(row !== undefined && col !== undefined && { cell: cellRef(row, col) }),
      ...(column !== undefined && { column }),
      ...(params && { params }),
    });

  const byName = new Map(desc.columns.map((c) => [c.name.toLowerCase(), c]));
  const keySet = new Set(desc.key.map((k) => k.toLowerCase()));
  const columnIndex: Record<string, number> = {};
  const header = sheet.rows[headerRow] ?? [];
  header.forEach((h, c) => {
    if (h === null || h === "") return;
    const name = typeof h === "string" ? h.trim() : String(h);
    const col = headerColumn(desc, name, options.aliases);
    if (!col) return err("unknown_column", `列「${name}」は ${desc.target} にありません`, headerRow, c, undefined, { header: name });
    if (columnIndex[col.name] !== undefined) return err("duplicate_column", `列「${col.name}」が 2 回あります`, headerRow, c, col.name);
    if (!keySet.has(col.name.toLowerCase()) && !col.updatable) return err("column_not_updatable", `列「${col.name}」は更新できません`, headerRow, c, col.name);
    columnIndex[col.name] = c;
  });

  const keyColumns = desc.key;
  const updateColumns = desc.columns.filter((c) => columnIndex[c.name] !== undefined && !keySet.has(c.name.toLowerCase())).map((c) => c.name);
  for (const k of keyColumns) if (columnIndex[k] === undefined) err("missing_key_column", `キーの列「${k}」がありません`, undefined, undefined, k);
  if (updateColumns.length === 0) err("no_update_columns", "更新する列がありません");

  const readings: Reading[] = [];
  const result: ValidationResult = { ok: false, keyColumns, updateColumns, columnIndex, rows: [], issues, readings };
  if (issues.length > 0) return result;
  for (const name of [...keyColumns, ...updateColumns]) {
    const col = byName.get(name.toLowerCase())!;
    if (col.encoding && byteCount("", col.encoding) === null) {
      issues.push({
        severity: "warning",
        code: "encoding_unknown",
        message: `列「${name}」の文字コード（${col.encoding}）を確認できないので、バイト数と表せない字は見ていません`,
        column: name,
      });
    }
  }

  const rules = options.rules ?? [];
  const cellRules = rules.filter((r) => !isRowRule(r));
  // 行のルールのうち、見る列が全部取込にあるものはここで見る（無い列があるものは差分で DB の値を使って見る）。
  const inSheet = (c: string) => columnIndex[c] !== undefined;
  const rowRules = rules.filter((r) => isRowRule(r) && r.columns.every(inSheet) && r.columns.some((c) => updateColumns.includes(c)));
  const colDefs = new Map(desc.columns.map((c) => [c.name, c]));
  const seen = new Map<string, number>();
  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    const cells = sheet.rows[r];
    if (isBlankRow(cells)) continue;
    const key: Row = {};
    const values: Row = {};
    let rowOk = true;
    const ruleIssue = (rule: CompiledRule, message: string, column: string) => {
      const severity = rule.severity ?? "error";
      const c = columnIndex[column]!;
      issues.push({ severity, code: "rule_violation", message, row: r, col: c, cell: cellRef(r, c), column });
      if (severity === "error") rowOk = false;
    };
    for (const name of [...keyColumns, ...updateColumns]) {
      const c = columnIndex[name]!;
      const col = colDefs.get(name)!;
      const conv = convertCell(col, cells![c] ?? null, readDisplay);
      let message = "error" in conv ? conv.error : checkValue(col, conv.value);
      let code = "invalid_value";
      if (!message && keyColumns.includes(name) && "value" in conv && conv.value === null) {
        message = "キーが空です";
        code = "key_empty";
      }
      if (message) {
        err(code, message, r, c, name);
        rowOk = false;
        continue;
      }
      const value = (conv as { value: Value }).value;
      if ("read" in conv) readings.push({ row: r, col: c, cell: cellRef(r, c), column: name, text: String(cells![c]), value });
      for (const rule of cellRules) {
        if (rule.column !== name) continue;
        const broken = checkRule(rule, value);
        if (broken) ruleIssue(rule, broken, name);
      }
      if (typeof value === "string" && value !== value.trim()) {
        issues.push({ severity: "warning", code: "whitespace", message: "前後に空白があります（そのまま使います）", row: r, col: c, cell: cellRef(r, c), column: name });
      }
      (keyColumns.includes(name) ? key : values)[name] = value;
    }
    const all: Row = { ...key, ...values };
    for (const rule of rowRules) {
      const broken = checkRule(rule, all[rule.column] ?? null, all);
      if (broken && rule.column in all) ruleIssue(rule, broken, rule.column);
    }
    if (options.checkRow) {
      for (const x of options.checkRow({ row: r, key, values, columnIndex }) ?? []) {
        const severity = x.severity ?? "error";
        const column = x.column !== undefined ? headerColumn(desc, x.column)?.name ?? x.column : undefined;
        const c = column !== undefined ? columnIndex[column] : undefined;
        issues.push({
          severity,
          code: x.code ?? "custom",
          message: x.message,
          row: r,
          ...(c !== undefined && { col: c, cell: cellRef(r, c) }),
          ...(column !== undefined && { column }),
        });
        if (severity === "error") rowOk = false;
      }
    }
    if (keyColumns.every((k) => k in key)) {
      const keyString = JSON.stringify(keyColumns.map((k) => canonical(colDefs.get(k)!.type, key[k]!)));
      const first = seen.get(keyString);
      if (first !== undefined) {
        for (const k of keyColumns) err("duplicate_key", `キーが ${first + 1} 行目と重複しています`, r, columnIndex[k], k, { firstRow: first });
        rowOk = false;
      } else seen.set(keyString, r);
    }
    result.rows.push({ row: r, key, values, ok: rowOk });
  }
  result.ok = !issues.some((i) => i.severity === "error");
  return result;
}

export interface ReadingGroup {
  column: string;
  count: number;
  /** 列で最初に読み替えたセル（例として見せる）。 */
  first: Reading;
}

/** 読み替えたセルを列ごとにまとめる（シートの列の順）。 */
export function groupReadings(readings: readonly Reading[]): ReadingGroup[] {
  const groups = new Map<string, ReadingGroup>();
  for (const r of readings) {
    const g = groups.get(r.column);
    if (g) g.count++;
    else groups.set(r.column, { column: r.column, count: 1, first: r });
  }
  return [...groups.values()].sort((a, b) => a.first.col - b.first.col);
}
