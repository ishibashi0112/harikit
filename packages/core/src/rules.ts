// 業務ルール。DB の定義ではわからない決まり（価格は 0 より大きい、変動は ±50% 以内など）を設定ファイルで足す。
//
// {
//   "targets": {
//     "product": [
//       { "column": "UnitPrice", "greaterThan": 0 },
//       { "column": "UnitPrice", "maxChangePercent": 50, "severity": "warning" }
//     ]
//   }
// }

import type { ColumnDef, TableDescription, Value } from "./types.js";
import type { Issue } from "./validate.js";
import { canonical, checkValue, DATE_RE } from "./values.js";

export interface Rule {
  column: string;
  /** 空を許さない（DB では NULL を許す列でも）。 */
  required?: boolean;
  /** 以上。 */
  min?: number | string;
  /** 以下。 */
  max?: number | string;
  /** より大きい。 */
  greaterThan?: number | string;
  /** より小さい。 */
  lessThan?: number | string;
  /** 文字列が合うべき正規表現。 */
  pattern?: string;
  /** 使ってよい値。 */
  oneOf?: Value[];
  /** DB の今の値からの変動の上限（%）。数値の列だけ。 */
  maxChangePercent?: number;
  /** 既定は "error"。"warning" なら差分は作り、承認資料に残す。 */
  severity?: "error" | "warning";
  /** 決まりに合わないときに出す文。 */
  message?: string;
}

export interface RulesConfig {
  targets?: Record<string, Rule[]>;
}

const RULE_KEYS = new Set(["column", "required", "min", "max", "greaterThan", "lessThan", "pattern", "oneOf", "maxChangePercent", "severity", "message"]);
const BOUND_KEYS = ["min", "max", "greaterThan", "lessThan"] as const;
const ORDERED_TYPES = new Set(["integer", "bigint", "decimal", "float", "date", "datetime", "time"]);
const NUMERIC_TYPES = new Set(["integer", "bigint", "decimal", "float"]);

/** 検証に使える形にしたルール。境界値は列の型の値にそろえてある。 */
export interface CompiledRule extends Rule {
  col: ColumnDef;
  bounds: Partial<Record<(typeof BOUND_KEYS)[number], Value>>;
  regex?: RegExp;
}

/** ルールの値（0、"2026-04-01" など）を列の型の値にする。読めなければ null。 */
function toColumnValue(col: ColumnDef, v: unknown): Value {
  if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") return null;
  let value: Value = v;
  if (typeof v === "number" && (col.type === "decimal" || col.type === "bigint")) value = String(v);
  if (col.type === "datetime" && typeof v === "string" && DATE_RE.test(v)) value = `${v}T00:00:00`;
  // 桁の上限はルールの値には当てない（「100 万以下」などは列の桁より小さいとは限らない）。
  const loose: ColumnDef = { ...col, nullable: true, maxLength: undefined, maxBytes: undefined, encoding: undefined, precision: undefined };
  return checkValue(loose, value) === null ? value : null;
}

function compareDecimal(a: string, b: string): number {
  const ca = canonical("decimal", a) as string;
  const cb = canonical("decimal", b) as string;
  const neg = (s: string) => s.startsWith("-");
  if (neg(ca) !== neg(cb)) return neg(ca) ? -1 : 1;
  const sign = neg(ca) ? -1 : 1;
  const [ai = "", af = ""] = ca.replace(/^-/, "").split(".");
  const [bi = "", bf = ""] = cb.replace(/^-/, "").split(".");
  if (ai.length !== bi.length) return (ai.length < bi.length ? -1 : 1) * sign;
  const len = Math.max(af.length, bf.length);
  const x = ai + af.padEnd(len, "0");
  const y = bi + bf.padEnd(len, "0");
  return x === y ? 0 : (x < y ? -1 : 1) * sign;
}

/** 型に沿って大小を比べる。 */
export function compareValues(col: ColumnDef, a: Value, b: Value): number {
  switch (col.type) {
    case "integer":
    case "float":
      return Math.sign(Number(a) - Number(b));
    case "bigint": {
      const x = BigInt(String(a));
      const y = BigInt(String(b));
      return x === y ? 0 : x < y ? -1 : 1;
    }
    case "decimal":
      return compareDecimal(String(a), String(b));
    default: {
      const x = String(canonical(col.type, a));
      const y = String(canonical(col.type, b));
      return x === y ? 0 : x < y ? -1 : 1;
    }
  }
}

/** 設定ファイルのルールを describe の結果と照らし、使える形にする。誤りは issues に入れる。 */
export function compileRules(desc: TableDescription, rules: unknown): { rules: CompiledRule[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const out: CompiledRule[] = [];
  const bad = (i: number, message: string, column?: string) =>
    issues.push({ severity: "error", message: `業務ルール ${i + 1} 番目: ${message}`, ...(column !== undefined && { column }) });
  if (rules === undefined) return { rules: out, issues };
  if (!Array.isArray(rules)) {
    issues.push({ severity: "error", message: `業務ルール: ${desc.target} はルールの配列にしてください` });
    return { rules: out, issues };
  }
  const byName = new Map(desc.columns.map((c) => [c.name.toLowerCase(), c]));
  rules.forEach((raw: unknown, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(i, "オブジェクトではありません");
    const r = raw as Record<string, unknown>;
    const unknownKeys = Object.keys(r).filter((k) => !RULE_KEYS.has(k));
    if (unknownKeys.length > 0) return bad(i, `知らない項目 ${unknownKeys.join(", ")} があります`);
    const col = typeof r.column === "string" ? byName.get(r.column.toLowerCase()) : undefined;
    if (!col) return bad(i, `列 ${String(r.column)} は ${desc.target} にありません`);
    if (r.severity !== undefined && r.severity !== "error" && r.severity !== "warning") return bad(i, "severity は error か warning です", col.name);
    if (r.message !== undefined && typeof r.message !== "string") return bad(i, "message は文字列です", col.name);
    if (r.required !== undefined && typeof r.required !== "boolean") return bad(i, "required は true / false です", col.name);
    const rule: CompiledRule = { ...(r as unknown as Rule), column: col.name, col, bounds: {} };
    for (const k of BOUND_KEYS) {
      if (r[k] === undefined) continue;
      if (!ORDERED_TYPES.has(col.type)) return bad(i, `${k} は数値か日付の列だけに使えます`, col.name);
      const v = toColumnValue(col, r[k]);
      if (v === null) return bad(i, `${k} の値 ${JSON.stringify(r[k])} が列の型として読めません`, col.name);
      rule.bounds[k] = v;
    }
    if (r.pattern !== undefined) {
      if (col.type !== "string" || typeof r.pattern !== "string") return bad(i, "pattern は文字列の列に、正規表現の文字列で書きます", col.name);
      try {
        rule.regex = new RegExp(r.pattern, "u");
      } catch {
        return bad(i, `pattern ${r.pattern} は正規表現として読めません`, col.name);
      }
    }
    if (r.oneOf !== undefined) {
      if (!Array.isArray(r.oneOf) || r.oneOf.length === 0) return bad(i, "oneOf は値の配列です", col.name);
      const values = r.oneOf.map((v) => toColumnValue(col, v));
      if (values.some((v) => v === null)) return bad(i, "oneOf に列の型として読めない値があります", col.name);
      rule.oneOf = values;
    }
    if (r.maxChangePercent !== undefined) {
      if (!NUMERIC_TYPES.has(col.type)) return bad(i, "maxChangePercent は数値の列だけに使えます", col.name);
      if (typeof r.maxChangePercent !== "number" || !(r.maxChangePercent >= 0)) return bad(i, "maxChangePercent は 0 以上の数です", col.name);
    }
    out.push(rule);
  });
  return { rules: out, issues };
}

const show = (v: Value) => (typeof v === "string" ? v : JSON.stringify(v));

/** 1 つのセルの値をルールで見る。合わなければ理由を返す。変動率はここでは見ない（差分で見る）。 */
export function checkRule(rule: CompiledRule, v: Value): string | null {
  const msg = (m: string) => rule.message ?? m;
  if (v === null || v === "") return rule.required ? msg("必須です（業務ルール）") : null;
  const cmp = (b: Value) => compareValues(rule.col, v, b);
  const { min, max, greaterThan, lessThan } = rule.bounds;
  if (min !== undefined && cmp(min) < 0) return msg(`${show(min)} 以上にしてください`);
  if (max !== undefined && cmp(max) > 0) return msg(`${show(max)} 以下にしてください`);
  if (greaterThan !== undefined && cmp(greaterThan) <= 0) return msg(`${show(greaterThan)} より大きくしてください`);
  if (lessThan !== undefined && cmp(lessThan) >= 0) return msg(`${show(lessThan)} より小さくしてください`);
  if (rule.regex && typeof v === "string" && !rule.regex.test(v)) return msg(`決まった形（${rule.pattern}）になっていません`);
  if (rule.oneOf && !rule.oneOf.some((o) => compareEqual(rule.col, o, v))) return msg(`使える値は ${rule.oneOf.map(show).join(", ")} です`);
  return null;
}

function compareEqual(col: ColumnDef, a: Value, b: Value): boolean {
  return ORDERED_TYPES.has(col.type) ? compareValues(col, a, b) === 0 : a === b;
}

/** 今の値から新しい値への変動がルールの上限を超えていれば理由を返す。 */
export function checkChange(rule: CompiledRule, before: Value, after: Value): string | null {
  if (rule.maxChangePercent === undefined || before === null || after === null) return null;
  const b = Number(before);
  const a = Number(after);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b === 0) return a === 0 ? null : (rule.message ?? `今の値が 0 なので変動率を出せません（${show(after)} にします）`);
  const pct = (Math.abs(a - b) / Math.abs(b)) * 100;
  if (pct <= rule.maxChangePercent + 1e-9) return null;
  return rule.message ?? `今の値 ${show(before)} から ${Math.round(pct * 10) / 10}% 変わります（±${rule.maxChangePercent}% まで）`;
}
