// 取込データの形。Excel・CSV・グリッド貼付のどれも、ここにそろえてから検証に渡す。

export interface DateCell {
  kind: "date";
  /** "YYYY-MM-DDTHH:mm:ss.fff"（タイムゾーンなし）。 */
  iso: string;
}

export interface ErrorCell {
  kind: "error";
  /** "#N/A" など。 */
  text: string;
}

/** 1つのセルの値。空のセルは null。 */
export type Cell = string | number | boolean | DateCell | ErrorCell | null;

export interface Sheet {
  name: string;
  /** rows[0] がシートの 1 行目。 */
  rows: Cell[][];
}

/** 列番号（0 始まり）を "A"、"AB" などにする。 */
export function columnLetter(col: number): string {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** 行・列（どちらも 0 始まり）を "B3" の形にする。 */
export function cellRef(row: number, col: number): string {
  return columnLetter(col) + (row + 1);
}

/** CSV の文字列を読む（RFC 4180）。値はすべて文字列、空欄は null。 */
export function parseCsv(text: string, name = "csv"): Sheet {
  const src = text.replace(/^﻿/, "");
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  const endField = () => {
    row.push(field === "" && !wasQuoted ? null : field);
    field = "";
    wasQuoted = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ",") endField();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endField();
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || wasQuoted || row.length > 0) {
    endField();
    rows.push(row);
  }
  return { name, rows };
}

/** CSV のバイト列を読む。encoding は "utf-8"（既定）や "shift_jis"。 */
export function readCsv(data: Uint8Array | ArrayBuffer, encoding = "utf-8", name = "csv"): Sheet {
  return parseCsv(new TextDecoder(encoding).decode(data), name);
}
