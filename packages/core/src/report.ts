// 承認資料とエラー一覧を CSV にする。Excel でそのまま開けるよう BOM を付ける。

import type { DiffResult, DiffStatus } from "./diff.js";
import type { Value } from "./types.js";
import type { Issue } from "./validate.js";

const STATUS_LABEL: Record<DiffStatus, string> = { change: "変わる", same: "同じ", not_found: "キーなし" };

function csvField(v: Value | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: (Value | undefined)[][]): string {
  return "﻿" + rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** 差分を 1 行 1 キーの表にする。変わる列には「*」を付ける。 */
export function diffToCsv(d: DiffResult): string {
  const header = ["行", "状態", ...d.keyColumns, ...d.updateColumns.flatMap((c) => [`${c}（前）`, `${c}（後）`, `${c} 変更`])];
  const body = d.rows.map((r) => {
    const changed = new Set(r.changes.map((c) => c.column));
    return [
      r.row + 1,
      STATUS_LABEL[r.status],
      ...d.keyColumns.map((k) => r.key[k]),
      ...d.updateColumns.flatMap((c) => [r.current?.[c] ?? null, r.input[c], changed.has(c) ? "*" : ""]),
    ];
  });
  return toCsv([header, ...body]);
}

/** 検証の問題をセル番地つきの一覧にする。 */
export function issuesToCsv(issues: Issue[]): string {
  return toCsv([
    ["種類", "セル", "行", "列", "内容"],
    ...issues.map((i) => [i.severity === "error" ? "エラー" : "警告", i.cell ?? "", i.row === undefined ? "" : i.row + 1, i.column ?? "", i.message]),
  ]);
}
