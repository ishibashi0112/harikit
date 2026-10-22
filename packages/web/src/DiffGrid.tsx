"use client";

// 差分の表。PatchiriApp の「差分」のタブで使い、自前の画面にも使えるよう公開する。

import { useMemo } from "react";
import { SpreadsheetGrid, type GridColumn } from "@ishibashi0112/spreadsheet-grid";
import type { DiffResult, Reading, TableDescription } from "patchiri-core";
import { columnTitle, diffGridRows, type DiffGridRow } from "./sheet.js";

/** 変わるセルの空（NULL）は「（空）」と見せる。変わらないセルは空のまま。 */
function emptyIfChanged(column: string) {
  return ({ value, row }: { value: unknown; row: DiffGridRow }) =>
    value === null && row.changed.includes(column) ? "（空）" : value === null || value === undefined ? "" : String(value);
}

/** 読み替えたセルに、貼った文字列のメモを付ける。 */
function pastedNote(column: string) {
  return ({ row }: { row: DiffGridRow }) => (row.pasted[column] !== undefined ? `貼った値: ${row.pasted[column]}` : undefined);
}

export interface DiffGridProps {
  diff: DiffResult;
  /** 見出しに表示名（label）を使うための定義。省けば列名。 */
  desc?: Pick<TableDescription, "columns">;
  /** Excel の表示の形から読み替えたセル（貼った文字列をメモに出す）。 */
  readings?: readonly Reading[];
  theme?: "auto" | "light" | "dark";
}

/** 差分を、行ごとに「前」と「後」を並べた読むだけの表で見せる（承認資料）。spreadsheet-grid の CSS が要る。 */
export function DiffGrid({ diff, desc, readings = [], theme = "auto" }: DiffGridProps) {
  const rows = useMemo(() => diffGridRows(diff, readings), [diff, readings]);
  const columns = useMemo<GridColumn<DiffGridRow>[]>(() => {
    const t = (name: string) => {
      const col = desc?.columns.find((c) => c.name === name);
      return col ? columnTitle(col) : name;
    };
    return [
      { key: "row", title: "行", width: 64, align: "right", pinned: "left" },
      { key: "status", title: "状態", width: 104, pinned: "left", filterType: "set", conditionalFormat: { chips: { 変わる: "info", 同じ: "neutral", キーなし: "warning" } } },
      ...diff.keyColumns.map((k): GridColumn<DiffGridRow> => ({ key: `k:${k}`, title: t(k), width: 120, pinned: "left", cellNote: pastedNote(k) })),
      ...diff.updateColumns.flatMap((c): GridColumn<DiffGridRow>[] => [
        {
          key: `b:${c}`,
          title: `${t(c)}（前）`,
          width: 150,
          valueFormatter: emptyIfChanged(c),
          cellClassName: ({ row }) => (row.changed.includes(c) ? "pt-before" : undefined),
        },
        {
          key: `a:${c}`,
          title: `${t(c)}（後）`,
          width: 150,
          valueFormatter: emptyIfChanged(c),
          cellClassName: ({ row }) => (row.changed.includes(c) ? "pt-change" : undefined),
          cellNote: pastedNote(c),
        },
      ]),
    ];
  }, [diff, desc]);
  return (
    <SpreadsheetGrid<DiffGridRow>
      rows={rows}
      columns={columns}
      rowKeyGetter={(r) => r.id}
      readOnly
      height="100%"
      density="compact"
      theme={theme}
      enableColumnMenu
      showTopBarSummary={false}
      showBottomBarCounts={false}
      globalFilterPlaceholder="差分を絞り込む"
      ariaLabel="差分"
    />
  );
}
