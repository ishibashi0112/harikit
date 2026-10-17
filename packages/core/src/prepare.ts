// 取込から差分までを通す。describe → 検証 → 参照先の確認 → fetch → 差分。

import type { HarikitClient } from "./client.js";
import { diff, validRows, type DiffResult } from "./diff.js";
import { compileRules, type RulesConfig } from "./rules.js";
import { cellRef, type Sheet } from "./table.js";
import type { FetchedRow, Row, TableDescription } from "./types.js";
import { validate, type Issue, type ValidateOptions, type ValidationResult } from "./validate.js";
import { canonical } from "./values.js";

export interface PrepareResult {
  description: TableDescription;
  validation: ValidationResult;
  /** 検証か参照先の確認でエラーがあれば null。 */
  diff: DiffResult | null;
  /** 検証、参照先、差分の問題をまとめたもの。 */
  issues: Issue[];
  ok: boolean;
}

/** キーを上限ごとに分けて fetch する。 */
export async function fetchAll(client: HarikitClient, desc: Pick<TableDescription, "target" | "limits">, keys: Row[], columns?: string[]): Promise<FetchedRow[]> {
  const size = Math.max(1, desc.limits.maxFetchKeys);
  const out: FetchedRow[] = [];
  for (let start = 0; start < keys.length; start += size) {
    const res = await client.fetch({ target: desc.target, keys: keys.slice(start, start + size), ...(columns && { columns }) });
    for (const r of res.rows) out.push({ ...r, index: r.index + start });
  }
  return out;
}

/** 外部キーの参照先に値があるかを確かめる。 */
export async function checkReferences(client: HarikitClient, desc: TableDescription, v: ValidationResult): Promise<Issue[]> {
  const issues: Issue[] = [];
  const types = new Map(desc.columns.map((c) => [c.name, c.type]));
  for (const fk of desc.foreignKeys) {
    const present = fk.columns.filter((c) => v.updateColumns.includes(c));
    if (present.length === 0) continue;
    if (fk.referencedTarget === null || present.length !== fk.columns.length) {
      issues.push({ severity: "warning", message: `参照先 ${fk.referencedTable} を確認できません（${fk.name}）` });
      continue;
    }
    const refDesc = { target: fk.referencedTarget, limits: desc.limits };
    const tuples = new Map<string, { key: Row; rows: number[] }>();
    for (const p of v.rows) {
      const vals = fk.columns.map((c) => p.values[c] ?? null);
      if (vals.some((x) => x === null)) continue;
      const id = JSON.stringify(fk.columns.map((c, i) => canonical(types.get(c)!, vals[i]!)));
      let t = tuples.get(id);
      if (!t) {
        const key: Row = {};
        fk.referencedColumns.forEach((rc, i) => (key[rc] = vals[i]!));
        t = { key, rows: [] };
        tuples.set(id, t);
      }
      t.rows.push(p.row);
    }
    const list = [...tuples.values()];
    const found = await fetchAll(client, refDesc, list.map((t) => t.key), []);
    found.forEach((f, i) => {
      if (f.found) return;
      for (const r of list[i]!.rows) {
        for (const c of fk.columns) {
          const col = v.columnIndex[c]!;
          issues.push({ severity: "error", message: `${fk.referencedTable} にありません`, row: r, col, cell: cellRef(r, col), column: c });
        }
      }
    });
  }
  return issues;
}

export interface PrepareOptions extends Omit<ValidateOptions, "rules"> {
  /** 業務ルールの設定（ファイルの中身）。このターゲットの分だけ使う。 */
  rules?: RulesConfig;
}

/** シートを検証して差分まで作る。エラーがあれば差分は作らない（変動率のエラーは差分を作ってから出る）。 */
export async function prepare(client: HarikitClient, target: string, sheet: Sheet, options: PrepareOptions = {}): Promise<PrepareResult> {
  const description = await client.describe(target);
  if (description.access !== "update") throw new Error(`${target} は読むだけのターゲットです`);
  const targets = options.rules?.targets;
  const compiled = compileRules(description, targets && Object.hasOwn(targets, target) ? targets[target] : undefined);
  const validation = validate(description, sheet, { ...options, rules: compiled.rules });
  const issues = [...compiled.issues, ...validation.issues];
  const done = (d: DiffResult | null): PrepareResult => {
    const all = sortIssues(d ? [...issues, ...d.issues] : issues);
    return { description, validation, diff: d, issues: all, ok: d !== null && !all.some((i) => i.severity === "error") };
  };
  if (compiled.issues.length > 0) return done(null);
  // 見出しの誤りでなければ、他の行に誤りがあっても参照先は確かめる（依頼者へ一度に返すため）。
  if (validation.rows.length > 0) issues.push(...(await checkReferences(client, description, validation)));
  if (issues.some((i) => i.severity === "error")) return done(null);
  const fetched = await fetchAll(client, description, validRows(validation).map((r) => r.key), validation.updateColumns);
  return done(diff(description, validation, fetched, { rules: compiled.rules }));
}

function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => (a.row ?? -1) - (b.row ?? -1) || (a.col ?? -1) - (b.col ?? -1));
}
