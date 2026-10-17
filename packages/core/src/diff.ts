// 差分。検証済みの行を DB の今の値と比べ、「変わる」「同じ」「キーなし」に分ける（仕様 5）。

import { checkChange, type CompiledRule } from "./rules.js";
import { cellRef } from "./table.js";
import type { ApplyMode, ApplyRequest, FetchedRow, Row, TableDescription, Value } from "./types.js";
import type { Issue, ParsedRow, ValidationResult } from "./validate.js";
import { canonical, sameColumnValue } from "./values.js";

export type DiffStatus = "change" | "same" | "not_found";

export interface ColumnChange {
  column: string;
  before: Value;
  after: Value;
}

export interface DiffRow {
  /** シートの行（0 始まり）。 */
  row: number;
  key: Row;
  status: DiffStatus;
  /** DB の今の値（取込に含まれる列だけ）。キーなしのときは無し。 */
  current?: Row;
  /** 取込の値。 */
  input: Row;
  /** 変わる列だけ。 */
  changes: ColumnChange[];
}

export interface DiffResult {
  target: string;
  keyColumns: string[];
  updateColumns: string[];
  rows: DiffRow[];
  counts: Record<DiffStatus, number>;
  issues: Issue[];
}

/** 検証で誤りのなかった行。fetch に渡すキーと差分の行はこの順。 */
export function validRows(validation: ValidationResult): ParsedRow[] {
  return validation.rows.filter((r) => r.ok);
}

/** fetch の結果（validRows と同じ順）と取込の行を比べる。 */
export function diff(desc: TableDescription, validation: ValidationResult, fetched: FetchedRow[], options: { rules?: CompiledRule[] } = {}): DiffResult {
  const changeRules = (options.rules ?? []).filter((r) => r.maxChangePercent !== undefined);
  const cols = new Map(desc.columns.map((c) => [c.name, c]));
  const counts: Record<DiffStatus, number> = { change: 0, same: 0, not_found: 0 };
  const issues: Issue[] = [];
  const byDbKey = new Map<string, ParsedRow>();
  const rows = validRows(validation).map((p, i): DiffRow => {
    const f = fetched[i];
    if (!f || f.index !== i) throw new Error("fetch の結果が取込の行と合いません");
    if (!f.found) {
      counts.not_found++;
      return { row: p.row, key: p.key, status: "not_found", input: p.values, changes: [] };
    }
    // DB の照合順序で同じ行に当たる 2 行（大文字小文字違いなど）は、どちらが勝つか決まらないので止める。
    const dbKey = JSON.stringify(validation.keyColumns.map((k) => canonical(cols.get(k)!.type, f.values[k] ?? null)));
    const other = byDbKey.get(dbKey);
    if (other) {
      for (const k of validation.keyColumns) {
        const c = validation.columnIndex[k]!;
        issues.push({ severity: "error", message: `${other.row + 1} 行目と DB 上で同じ行を指しています`, row: p.row, col: c, cell: cellRef(p.row, c), column: k });
      }
    }
    byDbKey.set(dbKey, p);
    const current: Row = {};
    const changes: ColumnChange[] = [];
    for (const col of validation.updateColumns) {
      const before = f.values[col] ?? null;
      const after = p.values[col] ?? null;
      current[col] = before;
      if (sameColumnValue(cols.get(col)!, before, after)) continue;
      changes.push({ column: col, before, after });
      for (const rule of changeRules) {
        if (rule.column !== col) continue;
        const broken = checkChange(rule, before, after);
        const c = validation.columnIndex[col]!;
        if (broken) issues.push({ severity: rule.severity ?? "error", message: broken, row: p.row, col: c, cell: cellRef(p.row, c), column: col });
      }
    }
    const status: DiffStatus = changes.length > 0 ? "change" : "same";
    counts[status]++;
    return { row: p.row, key: p.key, status, current, input: p.values, changes };
  });
  return { target: desc.target, keyColumns: validation.keyColumns, updateColumns: validation.updateColumns, rows, counts, issues };
}

export interface ApplyRequestOptions {
  mode: ApplyMode;
  note?: string;
  /** 省くと作る。再送のときは前と同じものを渡す。 */
  requestId?: string;
}

/** 「変わる」行の、変わる列だけで apply のリクエストを作る。 */
export function buildApplyRequest(d: DiffResult, options: ApplyRequestOptions): ApplyRequest {
  const rows = d.rows
    .filter((r) => r.status === "change")
    .map((r) => {
      const before: Row = {};
      const after: Row = {};
      for (const c of r.changes) {
        before[c.column] = c.before;
        after[c.column] = c.after;
      }
      return { op: "update" as const, key: r.key, before, after };
    });
  return {
    v: 1,
    requestId: options.requestId ?? crypto.randomUUID(),
    mode: options.mode,
    ...(options.note !== undefined && { note: options.note }),
    changes: [{ target: d.target, rows }],
  };
}
