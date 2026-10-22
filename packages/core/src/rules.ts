// 業務ルール。DB の定義ではわからない決まり（価格は 0 より大きい、変動は ±50% 以内など）を設定ファイルで足す。
//
// {
//   "targets": {
//     "product": [
//       { "column": "UnitPrice", "greaterThan": 0 },
//       { "column": "UnitPrice", "maxChangePercent": 50, "severity": "warning" },
//       { "column": "EndDate", "min": { "column": "StartDate" } },
//       { "column": "UnitPrice", "max": 0, "when": { "column": "Kind", "equals": "9" } }
//     ]
//   }
// }
//
// 境界（min など）にほかの列を書いたものと when の付いたものは「行のルール」で、行のほかの列の値も見る。
// 取込にその列がなければ、差分で DB の今の値を使って見る。

import type { ColumnDef, Row, TableDescription, Value } from "./types.js";
import type { Issue } from "./validate.js";
import { canonical, checkValue, DATE_RE } from "./values.js";

/** 境界の値。{ column } はその行のほかの列の値（同じ型の列）。 */
export type RuleBound = number | string | { column: string };

/** ルールを当てる条件。column の値が equals か oneOf のどれかなら（empty なら空なら）当てる。 */
export interface RuleCondition {
  column: string;
  equals?: Value;
  oneOf?: Value[];
  /** true なら空（NULL か ""）のとき、false なら空でないときに当てる。 */
  empty?: boolean;
}

export interface Rule {
  column: string;
  /** 空を許さない（DB では NULL を許す列でも）。 */
  required?: boolean;
  /** 以上。 */
  min?: RuleBound;
  /** 以下。 */
  max?: RuleBound;
  /** より大きい。 */
  greaterThan?: RuleBound;
  /** より小さい。 */
  lessThan?: RuleBound;
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
  /** この条件に合う行だけに当てる。 */
  when?: RuleCondition;
}

export interface RulesConfig {
  targets?: Record<string, Rule[]>;
}

const RULE_KEYS = new Set(["column", "required", "min", "max", "greaterThan", "lessThan", "pattern", "oneOf", "maxChangePercent", "severity", "message", "when"]);
const WHEN_KEYS = new Set(["column", "equals", "oneOf", "empty"]);
const BOUND_KEYS = ["min", "max", "greaterThan", "lessThan"] as const;
const ORDERED_TYPES = new Set(["integer", "bigint", "decimal", "float", "date", "datetime", "time"]);
const NUMERIC_TYPES = new Set(["integer", "bigint", "decimal", "float"]);

type BoundKey = (typeof BOUND_KEYS)[number];

/** 検証に使える形にしたルール。境界値は列の型の値にそろえてある。 */
export interface CompiledRule extends Rule {
  col: ColumnDef;
  bounds: Partial<Record<BoundKey, Value>>;
  /** 境界にほかの列を書いたもの（列の定義）。 */
  boundColumns: Partial<Record<BoundKey, ColumnDef>>;
  regex?: RegExp;
  whenCol?: ColumnDef;
  /** when の equals / oneOf を列の型の値にしたもの。 */
  whenValues?: Value[];
  /** このルールが見る列（自分、境界の列、when の列）。2 つ以上なら行のルール。 */
  columns: string[];
}

/** ほかの列の値も見るルールか。 */
export function isRowRule(rule: CompiledRule): boolean {
  return rule.columns.length > 1;
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

/** 数の値（数値か 10 進の文字列）を 10 進の文字列にする。 */
function decimalText(v: Value): string {
  if (typeof v !== "number") return String(v);
  if (Number.isInteger(v)) return BigInt(v).toString();
  const s = String(parseFloat(v.toPrecision(15)));
  return /e/i.test(s) ? v.toFixed(20).replace(/0+$/, "").replace(/\.$/, "") : s;
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

/** 設定ファイルのルールを describe の結果と照らし、使える形にする。誤りは issues に入れる（source は文の頭に付ける名前）。 */
export function compileRules(desc: Pick<TableDescription, "target" | "columns">, rules: unknown, source = "業務ルール"): { rules: CompiledRule[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const out: CompiledRule[] = [];
  const bad = (i: number, message: string, column?: string) =>
    issues.push({ severity: "error", code: "rules_invalid", message: `${source} ${i + 1} 番目: ${message}`, ...(column !== undefined && { column }) });
  if (rules === undefined) return { rules: out, issues };
  if (!Array.isArray(rules)) {
    issues.push({ severity: "error", code: "rules_invalid", message: `${source}: ${desc.target} はルールの配列にしてください` });
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
    const rule: CompiledRule = { ...(r as unknown as Rule), column: col.name, col, bounds: {}, boundColumns: {}, columns: [col.name] };
    const use = (c: ColumnDef) => {
      if (!rule.columns.includes(c.name)) rule.columns.push(c.name);
    };
    for (const k of BOUND_KEYS) {
      if (r[k] === undefined) continue;
      if (!ORDERED_TYPES.has(col.type)) return bad(i, `${k} は数値か日付の列だけに使えます`, col.name);
      const ref = r[k];
      if (typeof ref === "object" && ref !== null && !Array.isArray(ref)) {
        const o = ref as Record<string, unknown>;
        const other = typeof o.column === "string" && Object.keys(o).length === 1 ? byName.get(o.column.toLowerCase()) : undefined;
        if (!other) return bad(i, `${k} の列 ${JSON.stringify(o.column)} は ${desc.target} にありません`, col.name);
        if (!sameKind(col, other)) return bad(i, `${k} の列 ${other.name} は ${col.name} と比べられる型ではありません`, col.name);
        rule.boundColumns[k] = other;
        use(other);
        continue;
      }
      const v = toColumnValue(col, ref);
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
    if (r.when !== undefined) {
      const w = r.when;
      if (typeof w !== "object" || w === null || Array.isArray(w)) return bad(i, "when は { column, equals } の形です", col.name);
      const wo = w as Record<string, unknown>;
      const unknownWhen = Object.keys(wo).filter((k) => !WHEN_KEYS.has(k));
      if (unknownWhen.length > 0) return bad(i, `when に知らない項目 ${unknownWhen.join(", ")} があります`, col.name);
      const wc = typeof wo.column === "string" ? byName.get(wo.column.toLowerCase()) : undefined;
      if (!wc) return bad(i, `when の列 ${String(wo.column)} は ${desc.target} にありません`, col.name);
      const kinds = ["equals", "oneOf", "empty"].filter((k) => wo[k] !== undefined);
      if (kinds.length !== 1) return bad(i, "when には equals、oneOf、empty のどれか 1 つを書きます", col.name);
      if (wo.empty !== undefined && typeof wo.empty !== "boolean") return bad(i, "when.empty は true / false です", col.name);
      if (wo.oneOf !== undefined && (!Array.isArray(wo.oneOf) || wo.oneOf.length === 0)) return bad(i, "when.oneOf は値の配列です", col.name);
      if (wo.equals !== undefined || wo.oneOf !== undefined) {
        const raw = wo.equals !== undefined ? [wo.equals] : (wo.oneOf as unknown[]);
        const values = raw.map((v) => toColumnValue(wc, v));
        if (values.some((v) => v === null)) return bad(i, `when の値が列 ${wc.name} の型として読めません`, col.name);
        rule.whenValues = values;
      }
      rule.when = { ...(wo as unknown as RuleCondition), column: wc.name };
      rule.whenCol = wc;
      use(wc);
    }
    out.push(rule);
  });
  return { rules: out, issues };
}

const show = (v: Value) => (typeof v === "string" ? v : JSON.stringify(v));

const isEmpty = (v: Value | undefined) => v === null || v === undefined || v === "";

/** 行の値で、when の条件に合うか。条件の列が行に無ければ undefined（見られない）。 */
function whenHolds(rule: CompiledRule, row: Row): boolean | undefined {
  if (!rule.when || !rule.whenCol) return true;
  if (!(rule.when.column in row)) return undefined;
  const v = row[rule.when.column]!;
  if (rule.when.empty !== undefined) return isEmpty(v) === rule.when.empty;
  if (isEmpty(v)) return false;
  return rule.whenValues!.some((w) => compareEqual(rule.whenCol!, w, v));
}

/**
 * 1 つのセルの値をルールで見る。合わなければ理由を返す。変動率はここでは見ない（差分で見る）。
 * row を渡すと、境界の列と when の列をその行の値で見る（行に無い列があれば見ない）。row を渡さなければ行のルールは見ない。
 */
export function checkRule(rule: CompiledRule, v: Value, row?: Row): string | null {
  if (isRowRule(rule) && !row) return null;
  if (row && rule.columns.some((c) => c !== rule.column && !(c in row))) return null;
  if (row && whenHolds(rule, row) !== true) return null;
  const msg = (m: string) => rule.message ?? m;
  if (v === null || v === "") return rule.required ? msg("必須です（業務ルール）") : null;
  // ほかの列の値は型が違いうる（int と decimal など）ので、数は 10 進の文字列にして比べる。
  const cmp = (b: Value) =>
    NUMERIC_TYPES.has(rule.col.type) && typeof b !== typeof v ? compareDecimal(decimalText(v), decimalText(b)) : compareValues(rule.col, v, b);
  const bound = (k: BoundKey): { value: Value; text: string } | undefined => {
    const fixed = rule.bounds[k];
    if (fixed !== undefined) return { value: fixed, text: show(fixed) };
    const other = rule.boundColumns[k];
    if (!other || !row) return undefined;
    const ov = row[other.name];
    // 比べる相手の列が空なら、その境界は見ない。
    return isEmpty(ov) ? undefined : { value: ov!, text: `${other.name}（${show(ov!)}）` };
  };
  const min = bound("min");
  const max = bound("max");
  const greaterThan = bound("greaterThan");
  const lessThan = bound("lessThan");
  if (min && cmp(min.value) < 0) return msg(`${min.text} 以上にしてください`);
  if (max && cmp(max.value) > 0) return msg(`${max.text} 以下にしてください`);
  if (greaterThan && cmp(greaterThan.value) <= 0) return msg(`${greaterThan.text} より大きくしてください`);
  if (lessThan && cmp(lessThan.value) >= 0) return msg(`${lessThan.text} より小さくしてください`);
  if (rule.regex && typeof v === "string" && !rule.regex.test(v)) return msg(`決まった形（${rule.pattern}）になっていません`);
  if (rule.oneOf && !rule.oneOf.some((o) => compareEqual(rule.col, o, v))) return msg(`使える値は ${rule.oneOf.map(show).join(", ")} です`);
  return null;
}

/**
 * ルールの列とは別の列のセルに付ける文（行のルールで、ルールの列が取込に無いか、その行で変えていないとき）。
 * ルールの文はルールの列についてのものなので、頭にその列と今の値を付ける。message を書いたルールはそのまま。
 */
export function ruleMessageAt(rule: CompiledRule, message: string, column: string, row: Row): string {
  if (column === rule.column || rule.message !== undefined) return message;
  const v = row[rule.column];
  const head = isEmpty(v) ? `${rule.column} は` : `${rule.column}（${show(v!)}）は`;
  return /^[\x21-\x7e]/.test(message) ? `${head} ${message}` : `${head}${message}`;
}

/** 行の値（列名 → 値）でルールを見る。ルールの列が行に無ければ見ない。 */
export function checkRuleRow(rule: CompiledRule, row: Row): string | null {
  if (!(rule.column in row)) return null;
  return checkRule(rule, row[rule.column]!, row);
}

function compareEqual(col: ColumnDef, a: Value, b: Value): boolean {
  return ORDERED_TYPES.has(col.type) ? compareValues(col, a, b) === 0 : a === b;
}

/** 境界に書いたほかの列と比べられるか（数どうし、または同じ日付・時刻の型）。 */
function sameKind(a: ColumnDef, b: ColumnDef): boolean {
  if (NUMERIC_TYPES.has(a.type)) return NUMERIC_TYPES.has(b.type);
  return a.type === b.type;
}

/** 今の値から新しい値への変動がルールの上限を超えていれば理由を返す。row を渡すと when をその行で見る。 */
export function checkChange(rule: CompiledRule, before: Value, after: Value, row?: Row): string | null {
  if (rule.maxChangePercent === undefined || before === null || after === null) return null;
  if (rule.when && (!row || whenHolds(rule, row) !== true)) return null;
  const b = Number(before);
  const a = Number(after);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b === 0) return a === 0 ? null : (rule.message ?? `今の値が 0 なので変動率を出せません（${show(after)} にします）`);
  const pct = (Math.abs(a - b) / Math.abs(b)) * 100;
  if (pct <= rule.maxChangePercent + 1e-9) return null;
  return rule.message ?? `今の値 ${show(before)} から ${Math.round(pct * 10) / 10}% 変わります（±${rule.maxChangePercent}% まで）`;
}
