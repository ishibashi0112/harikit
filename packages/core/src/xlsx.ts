// Excel（.xlsx）の読み込み。依存なしで、ブラウザと Node の両方で動く。
// 値だけを読む（書式、数式、結合セルは見ない）。

import type { Cell, Sheet } from "./table.js";

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
}

function readZipEntries(buf: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("xlsx として読めません（zip ではありません）");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("xlsx の中身が壊れています");
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { name, method, compressedSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(buf: Uint8Array, entry: ZipEntry): Promise<string> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const p = entry.offset;
  const nameLen = view.getUint16(p + 26, true);
  const extraLen = view.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  let data: Uint8Array;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = await inflateRaw(raw);
  else throw new Error(`xlsx の圧縮形式 ${entry.method} には対応していません`);
  return new TextDecoder().decode(data);
}

function decodeXml(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(#x[0-9A-Fa-f]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e]!;
    });
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]!] = decodeXml(m[2]!);
  return out;
}

/** <t> の中身をつなげる。ふりがな（rPh）は除く。 */
function textOf(xml: string): string {
  const body = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
  let out = "";
  for (const m of body.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) out += decodeXml(m[1] ?? "");
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(stripped) && !/^general$/i.test(stripped.trim());
}

function dateStyles(stylesXml: string | undefined): boolean[] {
  if (!stylesXml) return [];
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<(?:\w+:)?numFmt\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]!);
    custom.set(Number(a.numFmtId), a.formatCode ?? "");
  }
  const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(stylesXml)?.[1] ?? "";
  const out: boolean[] = [];
  for (const m of xfs.matchAll(/<(?:\w+:)?xf\b([^>]*?)(?:\/>|>)/g)) {
    const id = Number(attrs(m[1]!).numFmtId ?? 0);
    const code = custom.get(id);
    out.push(code !== undefined ? isDateFormat(code) : BUILTIN_DATE_FORMATS.has(id));
  }
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Excel のシリアル値を "YYYY-MM-DDTHH:mm:ss.fff" にする（タイムゾーンなし）。 */
export function serialToIso(serial: number, date1904 = false): string {
  let ms = Math.round(serial * 86400000);
  // 1900 年方式は 1900-02-29（存在しない日）を数えているので、それより前は 1 日ずらす。
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : serial < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + ms);
  ms = d.getUTCMilliseconds();
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(ms, 3)}`;
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml: string, shared: string[], dates: boolean[], date1904: boolean): Cell[][] {
  const rows: Cell[][] = [];
  const data = /<(?:\w+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/.exec(xml)?.[1] ?? "";
  let nextRow = 0;
  for (const rm of data.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const ra = attrs(rm[1]!);
    const r = ra.r ? Number(ra.r) - 1 : nextRow;
    nextRow = r + 1;
    const row: Cell[] = [];
    let nextCol = 0;
    for (const cm of (rm[2] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const a = attrs(cm[1]!);
      const c = a.r ? colIndex(a.r) : nextCol;
      nextCol = c + 1;
      const inner = cm[2] ?? "";
      const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
      let value: Cell = null;
      switch (a.t) {
        case "s":
          value = v === undefined ? null : (shared[Number(v)] ?? null);
          break;
        case "inlineStr":
          value = textOf(/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/.exec(inner)?.[1] ?? "");
          break;
        case "str":
          value = v === undefined ? null : decodeXml(v);
          break;
        case "b":
          value = v === undefined ? null : v === "1";
          break;
        case "e":
          value = { kind: "error", text: v === undefined ? "#ERROR" : decodeXml(v) };
          break;
        case "d":
          value = v === undefined ? null : { kind: "date", iso: decodeXml(v) };
          break;
        default:
          if (v !== undefined && v !== "") {
            const n = Number(v);
            value = dates[Number(a.s ?? 0)] ? { kind: "date", iso: serialToIso(n, date1904) } : n;
          }
      }
      if (value !== null) {
        while (row.length < c) row.push(null);
        row[c] = value;
      }
    }
    while (rows.length < r) rows.push([]);
    rows[r] = row;
  }
  return rows;
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** .xlsx のバイト列を読み、シートの一覧を返す。 */
export async function readXlsx(data: Uint8Array | ArrayBuffer): Promise<Sheet[]> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const entries = readZipEntries(buf);
  const read = async (name: string) => {
    const e = entries.get(name);
    return e ? readEntry(buf, e) : undefined;
  };
  const workbook = await read("xl/workbook.xml");
  if (!workbook) throw new Error("xlsx として読めません（workbook.xml がありません）");
  const rels = (await read("xl/_rels/workbook.xml.rels")) ?? "";
  const relTargets = new Map<string, string>();
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]!);
    if (a.Id && a.Target) relTargets.set(a.Id, resolvePath("xl/workbook.xml", a.Target));
  }
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);
  const sharedXml = await read("xl/sharedStrings.xml");
  const shared: string[] = [];
  if (sharedXml) {
    for (const m of sharedXml.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)) shared.push(textOf(m[1] ?? ""));
  }
  const dates = dateStyles(await read("xl/styles.xml"));
  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]!);
    const path = a["r:id"] ? relTargets.get(a["r:id"]) : undefined;
    const xml = path ? await read(path) : undefined;
    if (!xml) continue;
    sheets.push({ name: a.name ?? "", rows: parseSheet(xml, shared, dates, date1904) });
  }
  return sheets;
}
