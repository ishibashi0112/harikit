// グリッドの行と取込データ（Sheet）の行き来、検証と差分の結果をセルの印にすること。
// グリッドは Excel と同じく A、B、C… の列で、1 行目が見出し（DB の列名）。Excel 取込と同じ検証に通す。
// React に依存しない（テストを Node で回すため）。

import {
  cellRef,
  columnLetter,
  headerColumn,
  type Cell,
  type ColumnDef,
  type Conflict,
  type DiffResult,
  type DiffStatus,
  type PrepareResult,
  type Reading,
  type Sheet,
  type TableDescription,
  type Value,
} from "patchiri-core";

export interface GridRow {
  id: number;
  [col: string]: unknown;
}

/** セルの文字列。空は ""。 */
export function cellText(row: GridRow, col: string): string {
  const v = row[col];
  return v === null || v === undefined ? "" : String(v);
}

/** 空のセルが並んだ行を作る。 */
export function blankRows(count: number, nextId: () => number): GridRow[] {
  return Array.from({ length: count }, () => ({ id: nextId() }));
}

/** 外から渡された表（1 行目が見出し、空文字は空のセル）をグリッドの行にする。行は少なくとも minRows、列は一番長い行に合わせる。 */
export function rowsFromCells(cells: readonly (readonly string[])[], minRows: number, nextId: () => number): { rows: GridRow[]; columnCount: number } {
  const rows = cells.map((cs) => {
    const row: GridRow = { id: nextId() };
    cs.forEach((v, c) => {
      if (v) row[columnLetter(c)] = v;
    });
    return row;
  });
  const columnCount = cells.reduce((n, cs) => Math.max(n, cs.length), 0);
  return { rows: [...rows, ...blankRows(Math.max(0, minRows - rows.length), nextId)], columnCount };
}

/** グリッドの行を取込データにする。空のセルは null、後ろの空の行は落とす。値は貼り付けたままの文字列。 */
export function toSheet(rows: readonly GridRow[], columnCount: number, name = "grid"): Sheet {
  const out: Cell[][] = rows.map((r) => Array.from({ length: columnCount }, (_, c) => cellText(r, columnLetter(c)) || null));
  while (out.length > 0 && out[out.length - 1]!.every((c) => c === null)) out.pop();
  return { name, rows: out };
}

/** 列の見せる名前（表示名があればそれ）。 */
export function columnTitle(col: Pick<ColumnDef, "name" | "label">): string {
  return col.label || col.name;
}

/**
 * 見出しの行（1 行目）に列の見出しを足す。入れるのは表示名があればそれ、無ければ列名。
 * もうその列の見出し（列名でも表示名でも）があればその列番号を、空きが無ければ右端の次を返す。
 */
export function addHeader(rows: readonly GridRow[], columnCount: number, column: string | Pick<ColumnDef, "name" | "label">): { rows: GridRow[]; col: number } {
  const head = rows[0];
  if (!head) throw new Error("行がありません");
  const def = typeof column === "string" ? { name: column } : column;
  const names = [def.name, def.label].filter((n): n is string => !!n).map((n) => n.trim().toLowerCase());
  for (let c = 0; c < columnCount; c++) {
    if (names.includes(cellText(head, columnLetter(c)).trim().toLowerCase())) return { rows: [...rows], col: c };
  }
  const name = columnTitle(def);
  let col = 0;
  while (col < columnCount && cellText(head, columnLetter(col)) !== "") col++;
  return { rows: [{ ...head, [columnLetter(col)]: name }, ...rows.slice(1)], col };
}

export type MarkKind = "change" | "not_found" | "conflict";

/** 1 つのセルに付ける印。 */
export interface CellMark {
  /** 検証したときのセルの文字列。そこから書き換えたら印は出さない。 */
  text: string;
  errors: string[];
  notes: string[];
  warn: boolean;
  kind?: MarkKind;
  /** Excel の表示の形（2024/4/1、¥1,200 など）から読み替えたセル。 */
  read?: boolean;
}

/** 行の id と列の文字（"B"）で引く。 */
export type Marks = Map<string, CellMark>;

export const markKey = (rowId: number, col: string) => `${rowId}:${col}`;

function display(v: Value | undefined): string {
  return v === null || v === undefined ? "（空）" : String(v);
}

function markAt(marks: Marks, rows: readonly GridRow[], row: number, col: number): CellMark | undefined {
  const r = rows[row];
  if (!r) return undefined;
  const letter = columnLetter(col);
  const key = markKey(r.id, letter);
  let m = marks.get(key);
  if (!m) {
    m = { text: cellText(r, letter), errors: [], notes: [], warn: false };
    marks.set(key, m);
  }
  return m;
}

/** 読み替えたセルのメモ。 */
export function readingNote(r: Pick<Reading, "text" | "value">): string {
  return `「${r.text}」を ${display(r.value)} として読みました`;
}

/** 検証と差分の結果をセルの印にする。rows は検証に渡したときのグリッドの行。 */
export function buildMarks(rows: readonly GridRow[], result: PrepareResult): Marks {
  const marks: Marks = new Map();
  for (const r of result.validation.readings) {
    const m = markAt(marks, rows, r.row, r.col);
    if (!m) continue;
    m.read = true;
    m.notes.push(readingNote(r));
  }
  for (const i of result.issues) {
    if (i.row === undefined || i.col === undefined) continue;
    const m = markAt(marks, rows, i.row, i.col);
    if (!m) continue;
    if (i.severity === "error") m.errors.push(i.message);
    else {
      m.notes.push(`警告: ${i.message}`);
      m.warn = true;
    }
  }
  const d = result.diff;
  if (!d) return marks;
  const index = result.validation.columnIndex;
  for (const r of d.rows) {
    if (r.status === "change") {
      for (const c of r.changes) {
        const m = markAt(marks, rows, r.row, index[c.column]!);
        if (!m) continue;
        m.kind = "change";
        m.notes.push(`DB の今の値: ${display(c.before)}`);
      }
    } else if (r.status === "not_found") {
      for (const k of d.keyColumns) {
        const m = markAt(marks, rows, r.row, index[k]!);
        if (!m) continue;
        m.kind = "not_found";
        m.notes.push("DB にこのキーの行がありません（反映しません）");
      }
    }
  }
  return marks;
}

/** apply が衝突で止めた行のキーのセルに印を足す。conflicts の index は「変わる」行の並び。 */
export function addConflictMarks(marks: Marks, rows: readonly GridRow[], result: PrepareResult, conflicts: readonly Conflict[]): Marks {
  const d = result.diff;
  if (!d) return marks;
  const next: Marks = new Map(marks);
  const changeRows = d.rows.filter((r) => r.status === "change");
  for (const c of conflicts) {
    const r = changeRows[c.index];
    if (!r) continue;
    const message =
      c.reason === "not_found"
        ? "差分を取った後に DB から行が消えています"
        : `差分を取った後に DB が変わっています${c.current ? `（今: ${Object.entries(c.current).map(([k, v]) => `${k}=${display(v)}`).join("、")}）` : ""}`;
    for (const k of d.keyColumns) {
      const col = result.validation.columnIndex[k]!;
      const row = rows[r.row];
      if (!row) continue;
      const key = markKey(row.id, columnLetter(col));
      const m = next.get(key);
      next.set(key, { ...m, text: cellText(row, columnLetter(col)), errors: m?.errors ?? [], notes: [...(m?.notes ?? []), message], warn: m?.warn ?? false, kind: "conflict" });
    }
  }
  return next;
}

/** 印が今のセルの値にまだ当てはまるか。 */
export function liveMark(marks: Marks, row: GridRow, col: string): CellMark | undefined {
  const m = marks.get(markKey(row.id, col));
  return m && m.text === cellText(row, col) ? m : undefined;
}

export interface HeaderInfo {
  kind: "key" | "update" | "readonly" | "unknown";
  note: string;
}

/** 見出しのセル（1 行目）の名前が、ターゲットのどの列に当たるか。列名、表示名、別名（aliases）で探す。 */
export function headerInfo(desc: TableDescription, text: string, aliases?: Record<string, string>): HeaderInfo | undefined {
  const name = text.trim();
  if (name === "") return undefined;
  const col = headerColumn(desc, name, aliases);
  if (!col) return { kind: "unknown", note: `「${name}」は ${desc.target} の列にありません` };
  const isKey = desc.key.some((k) => k.toLowerCase() === col.name.toLowerCase());
  // 列名でない見出し（表示名や別名）には、どの列に当たったかを添える。
  const which = col.name.toLowerCase() === name.toLowerCase() ? "" : `${col.name}・`;
  const parts = [col.dbType, col.nullable ? "空を許す" : "必須"];
  if (isKey) return { kind: "key", note: `キー（行を探す列）・${which}${parts.join("・")}` };
  if (!col.updatable) return { kind: "readonly", note: `${col.name} は更新できない列です` };
  return { kind: "update", note: `更新する列・${which}${parts.join("・")}` };
}

/** 差分を表で見せるための行。列のキーは "row"、"status"、"k:列名"、"b:列名"（前）、"a:列名"（後）。 */
export interface DiffGridRow {
  id: number;
  row: number;
  status: string;
  /** 変わる列の名前。 */
  changed: string[];
  /** 列名 → Excel の表示の形から読み替えたときの、貼った文字列。 */
  pasted: Record<string, string>;
  [col: string]: unknown;
}

export const STATUS_LABEL: Record<DiffStatus, string> = { change: "変わる", same: "同じ", not_found: "キーなし" };

export function diffGridRows(d: DiffResult, readings: readonly Reading[] = []): DiffGridRow[] {
  const pasted = new Map<number, Record<string, string>>();
  for (const r of readings) {
    let p = pasted.get(r.row);
    if (!p) pasted.set(r.row, (p = {}));
    p[r.column] = r.text;
  }
  return d.rows.map((r, i) => {
    const out: DiffGridRow = { id: i, row: r.row + 1, status: STATUS_LABEL[r.status], changed: r.changes.map((c) => c.column), pasted: pasted.get(r.row) ?? {} };
    for (const k of d.keyColumns) out[`k:${k}`] = r.key[k] ?? null;
    for (const c of d.updateColumns) {
      // キーなしの行は DB の値が無いので undefined（空と区別する）。
      out[`b:${c}`] = r.current ? (r.current[c] ?? null) : undefined;
      out[`a:${c}`] = r.input[c] ?? null;
    }
    return out;
  });
}

/** 問題の一覧に出す場所（"B3"、シート全体なら "-"）。 */
export function issuePlace(i: { row?: number; col?: number; cell?: string }): string {
  if (i.cell) return i.cell;
  if (i.row !== undefined && i.col !== undefined) return cellRef(i.row, i.col);
  return "-";
}

/** ファイル名に付ける日時（20261017-153000）。 */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * .xlsx のセルを、表に入れる文字列にする（表のセルは文字列だけ）。検証で読める形にそろえる:
 * 数は 15 桁で丸めた数字、日付は時刻が 0 なら 2024-04-01、時刻だけなら 09:30:00、ほかは 2024-04-01T09:30:00。
 */
export function cellString(cell: Cell): string {
  if (cell === null) return "";
  if (typeof cell === "string") return cell;
  if (typeof cell === "number") return Number.isInteger(cell) ? String(cell) : String(parseFloat(cell.toPrecision(15)));
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  if (cell.kind === "error") return cell.text;
  const iso = cell.iso.replace(/\.0+$/, "");
  if (/^(1899-12-3[01]|1904-01-01)T/.test(iso)) return iso.slice(11);
  return iso.endsWith("T00:00:00") ? iso.slice(0, 10) : iso;
}

/** シートの見出しの行（0 始まり）から下を、表に入れるセルにする。columns を渡せば、その列（0 始まり）だけをその順に入れる。 */
export function excelCells(sheet: Sheet, headerRow: number, columns?: readonly number[]): string[][] {
  return sheet.rows.slice(headerRow).map((r) => (columns ? columns.map((c) => cellString(r[c] ?? null)) : r.map(cellString)));
}

/** 見出しの行を当てる。上から 20 行のうち、ターゲットの列に当たる見出しが一番多い行（無ければ 0）。 */
export function guessHeaderRow(sheet: Sheet, desc: Pick<TableDescription, "columns"> | null, aliases?: Record<string, string>): number {
  if (!desc) return 0;
  let best = 0;
  let bestCount = 0;
  sheet.rows.slice(0, 20).forEach((r, i) => {
    const count = r.filter((c) => typeof c === "string" && headerColumn(desc, c, aliases)).length;
    if (count > bestCount) [best, bestCount] = [i, count];
  });
  return best;
}
