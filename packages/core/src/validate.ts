// 検証。取込データを DB の定義（describe の結果）で全行チェックし、型をそろえた値にする。
// 入力の揺れ（全角半角、前後の空白）は直さない。前後の空白は警告だけ出す。

import { checkRule, type CompiledRule } from "./rules.js";
import { cellRef, type Cell, type Sheet } from "./table.js";
import type { ColumnDef, Row, TableDescription, Value } from "./types.js";
import { canonical, checkValue, DATE_RE, DECIMAL_RE } from "./values.js";

export interface Issue {
  severity: "error" | "warning";
  message: string;
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

export interface ValidationResult {
  ok: boolean;
  keyColumns: string[];
  updateColumns: string[];
  /** 列名 → シートの列（0 始まり）。 */
  columnIndex: Record<string, number>;
  /** 誤りのある行も含む。差分に使うのは ok の行だけ。 */
  rows: ParsedRow[];
  issues: Issue[];
}

export interface ValidateOptions {
  /** 見出しの行（0 始まり）。既定は 0。 */
  headerRow?: number;
  /** 業務ルール（compileRules で作ったもの）。変動率のルールは差分で見る。 */
  rules?: CompiledRule[];
}

type Converted = { value: Value } | { error: string };

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

/** セルの値を列の型の値にする。形の確認は checkValue で別に行う。 */
export function convertCell(col: ColumnDef, cell: Cell): Converted {
  if (cell === null) return { value: null };
  if (typeof cell === "object" && cell.kind === "error") return { error: `セルがエラー値です（${cell.text}）` };
  if (cell === "" && col.type !== "string") return { value: null };
  const date = typeof cell === "object" && cell.kind === "date" ? cell.iso : undefined;
  switch (col.type) {
    case "string":
      if (typeof cell === "string") return { value: cell };
      if (typeof cell === "number") return { value: formatNumber(cell) };
      if (date !== undefined) return { error: "日付として入っています（文字列にしてください）" };
      return { error: "文字列ではありません" };
    case "integer":
      if (typeof cell === "number") return { value: cell };
      if (typeof cell === "string" && /^-?\d+$/.test(cell)) return { value: Number(cell) };
      return { error: "整数ではありません" };
    case "bigint":
      if (typeof cell === "number") return Number.isSafeInteger(cell) ? { value: String(cell) } : { error: "整数ではありません（精度が足りません）" };
      if (typeof cell === "string") return { value: cell };
      return { error: "整数ではありません" };
    case "decimal":
      if (typeof cell === "number") return { value: padScale(formatNumber(cell), col.scale) };
      if (typeof cell === "string") return { value: padScale(cell, col.scale) };
      return { error: "数値ではありません" };
    case "float":
      if (typeof cell === "number") return { value: cell };
      if (typeof cell === "string" && DECIMAL_RE.test(cell)) return { value: Number(cell) };
      return { error: "数値ではありません" };
    case "boolean":
      if (typeof cell === "boolean") return { value: cell };
      if (cell === 1 || cell === 0) return { value: cell === 1 };
      if (typeof cell === "string") {
        const s = cell.toLowerCase();
        if (s === "true" || s === "1") return { value: true };
        if (s === "false" || s === "0") return { value: false };
      }
      return { error: "true / false ではありません" };
    case "date":
      if (date !== undefined) {
        return date.endsWith("T00:00:00.000") ? { value: date.slice(0, 10) } : { error: "時刻つきの日付です" };
      }
      if (typeof cell === "string") return { value: cell };
      return { error: "日付ではありません" };
    case "datetime":
      if (date !== undefined) return { value: date };
      if (typeof cell === "string") {
        if (DATE_RE.test(cell)) return { value: `${cell}T00:00:00` };
        return { value: cell.replace(/^(\d{4}-\d{2}-\d{2}) (?=\d)/, "$1T") };
      }
      return { error: "日時ではありません" };
    case "time":
      if (date !== undefined) {
        if (/^(1899-12-3[01]|1904-01-01)T/.test(date)) return { value: date.slice(11) };
        return { error: "日付つきの時刻です" };
      }
      if (typeof cell === "string") return { value: /^\d{2}:\d{2}$/.test(cell) ? `${cell}:00` : cell };
      return { error: "時刻ではありません" };
    case "other":
      return { error: "この型の列は扱えません" };
  }
}

function isBlankRow(row: Cell[] | undefined): boolean {
  return !row || row.every((c) => c === null || c === "");
}

/** シートを describe の結果で検証する。見出しは DB の列名（大文字小文字は問わない）。 */
export function validate(desc: TableDescription, sheet: Sheet, options: ValidateOptions = {}): ValidationResult {
  const headerRow = options.headerRow ?? 0;
  const issues: Issue[] = [];
  const err = (message: string, row?: number, col?: number, column?: string) =>
    issues.push({
      severity: "error",
      message,
      ...(row !== undefined && { row }),
      ...(col !== undefined && { col }),
      ...(row !== undefined && col !== undefined && { cell: cellRef(row, col) }),
      ...(column !== undefined && { column }),
    });

  const byName = new Map(desc.columns.map((c) => [c.name.toLowerCase(), c]));
  const keySet = new Set(desc.key.map((k) => k.toLowerCase()));
  const columnIndex: Record<string, number> = {};
  const header = sheet.rows[headerRow] ?? [];
  header.forEach((h, c) => {
    if (h === null || h === "") return;
    const name = typeof h === "string" ? h.trim() : String(h);
    const col = byName.get(name.toLowerCase());
    if (!col) return err(`列「${name}」は ${desc.target} にありません`, headerRow, c);
    if (columnIndex[col.name] !== undefined) return err(`列「${col.name}」が 2 回あります`, headerRow, c, col.name);
    if (!keySet.has(col.name.toLowerCase()) && !col.updatable) return err(`列「${col.name}」は更新できません`, headerRow, c, col.name);
    columnIndex[col.name] = c;
  });

  const keyColumns = desc.key;
  const updateColumns = desc.columns.filter((c) => columnIndex[c.name] !== undefined && !keySet.has(c.name.toLowerCase())).map((c) => c.name);
  for (const k of keyColumns) if (columnIndex[k] === undefined) err(`キーの列「${k}」がありません`, undefined, undefined, k);
  if (updateColumns.length === 0) err("更新する列がありません");

  const result: ValidationResult = { ok: false, keyColumns, updateColumns, columnIndex, rows: [], issues };
  if (issues.length > 0) return result;

  const colDefs = new Map(desc.columns.map((c) => [c.name, c]));
  const seen = new Map<string, number>();
  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    const cells = sheet.rows[r];
    if (isBlankRow(cells)) continue;
    const key: Row = {};
    const values: Row = {};
    let rowOk = true;
    for (const name of [...keyColumns, ...updateColumns]) {
      const c = columnIndex[name]!;
      const col = colDefs.get(name)!;
      const conv = convertCell(col, cells![c] ?? null);
      let message = "error" in conv ? conv.error : checkValue(col, conv.value);
      if (!message && keyColumns.includes(name) && "value" in conv && conv.value === null) message = "キーが空です";
      if (message) {
        err(message, r, c, name);
        rowOk = false;
        continue;
      }
      const value = (conv as { value: Value }).value;
      for (const rule of options.rules ?? []) {
        if (rule.column !== name) continue;
        const broken = checkRule(rule, value);
        if (!broken) continue;
        const severity = rule.severity ?? "error";
        issues.push({ severity, message: broken, row: r, col: c, cell: cellRef(r, c), column: name });
        if (severity === "error") rowOk = false;
      }
      if (typeof value === "string" && value !== value.trim()) {
        issues.push({ severity: "warning", message: "前後に空白があります（そのまま使います）", row: r, col: c, cell: cellRef(r, c), column: name });
      }
      (keyColumns.includes(name) ? key : values)[name] = value;
    }
    if (keyColumns.every((k) => k in key)) {
      const keyString = JSON.stringify(keyColumns.map((k) => canonical(colDefs.get(k)!.type, key[k]!)));
      const first = seen.get(keyString);
      if (first !== undefined) {
        for (const k of keyColumns) err(`キーが ${first + 1} 行目と重複しています`, r, columnIndex[k], k);
        rowOk = false;
      } else seen.set(keyString, r);
    }
    result.rows.push({ row: r, key, values, ok: rowOk });
  }
  result.ok = !issues.some((i) => i.severity === "error");
  return result;
}
