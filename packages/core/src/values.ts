// 値の形の確認と比較。仕様 1.3 の「JSON での値」を扱う。
// サーバ側の Node 版もここを使い、クライアントとサーバで判定がずれないようにする。

import { byteCount } from "./encoding.js";
import type { ColumnDef, ColumnType, Value } from "./types.js";

const INTEGER_RANGES: Record<string, [number, number]> = {
  tinyint: [0, 255],
  smallint: [-32768, 32767],
  int: [-2147483648, 2147483647],
};

const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

export const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
export const BIGINT_RE = /^-?\d+$/;
export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// 秒の小数は Oracle の TIMESTAMP(9) まで。桁の上限は列の scale で見る。
export const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?$/;
export const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(\.\d{1,7})?$/;

/** dbType の先頭の型名（"decimal(9,2)" → "decimal"）。 */
export function baseDbType(dbType: string): string {
  return dbType.toLowerCase().replace(/\(.*$/, "").trim();
}

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(2000, m, 0)).getUTCDate();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= (m === 2 ? (leap ? 29 : 28) : days);
}

function validTime(h: number, mi: number, s: number): boolean {
  return h < 24 && mi < 60 && s < 60;
}

/**
 * 値が列の型として正しい形かを見る。正しければ null、違えば理由を返す。
 * 桁数や NOT NULL も見る（DB 定義でわかる範囲）。
 */
export function checkValue(col: ColumnDef, v: Value): string | null {
  if (v === null) return col.nullable ? null : "必須です（NOT NULL）";
  switch (col.type) {
    case "string": {
      if (typeof v !== "string") return "文字列ではありません";
      if (v === "" && col.emptyIsNull) return "この列では空文字は NULL になります（空にするなら null）";
      if (col.maxLength !== undefined && col.maxLength >= 0) {
        const len = [...v].length;
        if (len > col.maxLength) return `${col.maxLength} 文字を超えています（${len} 文字）`;
      }
      if (col.encoding) {
        const n = byteCount(v, col.encoding);
        if (n && "unencodable" in n) return `「${n.unencodable}」は列の文字コード（${col.encoding}）で表せません`;
        if (n && col.maxBytes !== undefined && n.bytes > col.maxBytes) return `${col.maxBytes} バイトを超えています（${n.bytes} バイト）`;
      }
      return null;
    }
    case "integer": {
      if (typeof v !== "number" || !Number.isInteger(v)) return "整数ではありません";
      const [min, max] = INTEGER_RANGES[baseDbType(col.dbType)] ?? INTEGER_RANGES.int!;
      const range = [typeof col.min === "number" ? col.min : min, typeof col.max === "number" ? col.max : max] as const;
      if (v < range[0] || v > range[1]) return `範囲外です（${range[0]}〜${range[1]}）`;
      return null;
    }
    case "bigint": {
      if (typeof v !== "string" || !BIGINT_RE.test(v)) return "整数ではありません";
      const n = BigInt(v);
      const min = typeof col.min === "string" && BIGINT_RE.test(col.min) ? BigInt(col.min) : BIGINT_MIN;
      const max = typeof col.max === "string" && BIGINT_RE.test(col.max) ? BigInt(col.max) : BIGINT_MAX;
      if (n < min || n > max) return col.min === undefined && col.max === undefined ? "範囲外です（bigint）" : `範囲外です（${min}〜${max}）`;
      return null;
    }
    case "decimal": {
      if (typeof v !== "string" || !DECIMAL_RE.test(v)) return "数値ではありません";
      if (col.precision !== undefined) {
        const scale = col.scale ?? 0;
        const [int = "", frac = ""] = v.replace(/^-/, "").split(".");
        const intDigits = int.replace(/^0+/, "").length;
        const fracDigits = frac.replace(/0+$/, "").length;
        if (fracDigits > scale) return `小数は ${scale} 桁までです`;
        if (intDigits > col.precision - scale) return `整数部は ${col.precision - scale} 桁までです`;
      }
      return null;
    }
    case "float":
      return typeof v === "number" && Number.isFinite(v) ? null : "数値ではありません";
    case "boolean":
      return typeof v === "boolean" ? null : "true / false ではありません";
    case "date": {
      const m = typeof v === "string" ? DATE_RE.exec(v) : null;
      if (!m || !validDate(+m[1]!, +m[2]!, +m[3]!)) return "日付（YYYY-MM-DD）ではありません";
      return null;
    }
    case "datetime": {
      const m = typeof v === "string" ? DATETIME_RE.exec(v) : null;
      if (!m || !validDate(+m[1]!, +m[2]!, +m[3]!) || !validTime(+m[4]!, +m[5]!, +m[6]!)) {
        return "日時（YYYY-MM-DDTHH:mm:ss）ではありません";
      }
      return checkFraction(col, m[7]);
    }
    case "time": {
      const m = typeof v === "string" ? TIME_RE.exec(v) : null;
      if (!m || !validTime(+m[1]!, +m[2]!, +m[3]!)) return "時刻（HH:mm:ss）ではありません";
      return checkFraction(col, m[4]);
    }
    case "other":
      return "この型の列は扱えません";
  }
}

/** 秒の小数の桁数を、列の scale（datetime2(3) なら 3）と比べる。 */
function checkFraction(col: ColumnDef, fraction: string | undefined): string | null {
  if (col.scale === undefined || !fraction) return null;
  const digits = fraction.slice(1).replace(/0+$/, "").length;
  return digits > col.scale ? `秒の小数は ${col.scale} 桁までです` : null;
}

function canonicalDecimal(v: string): string {
  let neg = v.startsWith("-");
  let [int = "0", frac = ""] = v.replace(/^-/, "").split(".");
  int = int.replace(/^0+(?=\d)/, "");
  frac = frac.replace(/0+$/, "");
  if (int === "0" && frac === "") neg = false;
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

function canonicalFraction(v: string): string {
  return v.replace(/\.(\d*?)0+$/, (_, d: string) => (d ? "." + d : ""));
}

/** 比較用に値をそろえる（"120" と "120.00" を同じにする、など）。 */
export function canonical(type: ColumnType, v: Value): Value {
  if (v === null || typeof v !== "string") return v;
  switch (type) {
    case "decimal":
      return DECIMAL_RE.test(v) ? canonicalDecimal(v) : v;
    case "bigint":
      return BIGINT_RE.test(v) ? BigInt(v).toString() : v;
    case "datetime":
    case "time":
      return canonicalFraction(v);
    default:
      return v;
  }
}

/** 型に沿って2つの値が同じかを見る。NULL 同士は同じ。 */
export function sameValue(type: ColumnType, a: Value, b: Value): boolean {
  return canonical(type, a) === canonical(type, b);
}

/** 列の定義に沿って比べる。固定長の char / nchar は DB が末尾を空白で埋めるので、末尾の空白は見ない。 */
export function sameColumnValue(col: Pick<ColumnDef, "type" | "dbType">, a: Value, b: Value): boolean {
  if (col.type === "string" && typeof a === "string" && typeof b === "string" && /^n?char$/.test(baseDbType(col.dbType))) {
    return a.replace(/ +$/, "") === b.replace(/ +$/, "");
  }
  return sameValue(col.type, a, b);
}
