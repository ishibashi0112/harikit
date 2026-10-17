// 文字コードでのバイト数。varchar のように桁をバイトで数える列の検証に使う。
// 表は TextDecoder で全バイト列を読んで作る（ブラウザでも Node でも同じ結果になる）。

/** 2 バイト文字を持つ文字コード（WHATWG の名前）。 */
const DOUBLE_BYTE = new Set(["shift_jis", "gbk", "euc-kr", "big5"]);

const tables = new Map<string, Map<number, number> | null>();

function buildTable(encoding: string): Map<number, number> | null {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding);
  } catch {
    return null;
  }
  const table = new Map<number, number>();
  const add = (bytes: number[]) => {
    const s = decoder.decode(new Uint8Array(bytes));
    const cp = s.codePointAt(0);
    if (cp === undefined || cp === 0xfffd || s.length !== (cp > 0xffff ? 2 : 1)) return;
    if (!table.has(cp)) table.set(cp, bytes.length);
  };
  for (let b = 0; b < 0x100; b++) add([b]);
  if (DOUBLE_BYTE.has(encoding)) {
    for (let lead = 0x81; lead <= 0xfe; lead++) for (let trail = 0x40; trail <= 0xfe; trail++) add([lead, trail]);
  }
  return table;
}

export type ByteCount = { bytes: number } | { unencodable: string } | null;

/**
 * 文字列をその文字コードで書いたときのバイト数。表せない文字があればその文字を返す。
 * 知らない文字コードなら null（確かめない）。
 */
export function byteCount(s: string, encoding: string): ByteCount {
  const enc = encoding.toLowerCase();
  if (enc === "utf-8") return { bytes: new TextEncoder().encode(s).length };
  if (enc === "utf-16le") return { bytes: s.length * 2 };
  if (!tables.has(enc)) tables.set(enc, buildTable(enc));
  const table = tables.get(enc);
  if (!table) return null;
  let bytes = 0;
  for (const ch of s) {
    const n = table.get(ch.codePointAt(0)!);
    if (n === undefined) return { unencodable: ch };
    bytes += n;
  }
  return { bytes };
}
