// Excel の表示の形（2024/4/1、1,200、¥1,200、令和6年4月1日、午後1:30 など）を読む。
// 表への貼り付けや Excel が書き出した CSV は、セルの値ではなく表示された文字列で届くため。
// 読み方が一つに決まるものだけを読み、決まらないもの（4/1/2024、24/4/1、12.5%、1.2E+05）は理由をつけて断る。
// 数・日付・時刻・真偽の列にだけ使う。文字列の列は書かれたとおりが値なので、ここを通さない。

/** 読めた値、読めない理由、または表示の形として心当たりがない（null）。 */
export type DisplayRead<T> = { ok: T } | { error: string } | null;

export interface DisplayDate {
  /** "YYYY-MM-DD"。 */
  date: string;
  /** "HH:mm:ss"（秒の小数があれば付く）。時刻の表示がなければ無し。 */
  time?: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 全角の英数字と記号を半角に、全角空白などを半角空白にして、前後の空白を除く。 */
export function normalizeDisplay(text: string): string {
  return text
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/￥/g, "¥")
    .replace(/−/g, "-")
    .replace(/[　 ]/g, " ")
    .trim();
}

/**
 * 数の表示を、符号と数字と小数点だけの文字列（"-1200.5"）にする。
 * 読むもの: 桁区切り（1,200）、通貨（¥1,200、$1,200、1,200円）、負の数（-1,200、▲1,200、△1,200、(1,200)）、全角。
 */
export function readNumberText(text: string): DisplayRead<string> {
  let s = normalizeDisplay(text);
  if (s === "") return null;
  if (/^#+$/.test(s)) return { error: "列の幅が足りず「###」と表示されています。Excel で列の幅を広げてからコピーしてください" };
  if (/%$/.test(s)) return { error: "「%」の付いた数は読み替えません（12.5% を 0.125 と 12.5 のどちらで入れるか決まらないため）。DB に入れる数で書いてください" };
  if (/\d[eE][+-]?\d+$/.test(s)) return { error: "指数の表示（1.2E+05 など）は Excel が桁を丸めていることがあるので読みません。表示形式を「数値」にしてからコピーしてください" };
  if (/^[¥$\\]?\s*-\s*$/.test(s)) return { error: "「-」は数として読みません（会計の表示形式では 0 を「-」と表示するため）。0 か空にしてください" };
  let neg = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    neg = true;
    s = paren[1]!.trim();
  }
  const triangle = /^[▲△]\s*(.*)$/.exec(s);
  if (triangle) {
    if (neg) return null;
    neg = true;
    s = triangle[1]!;
  }
  const m = /^([+-]?)\s*([¥$\\]?)\s*([+-]?)\s*(\d[\d,]*(?:\.\d+)?)\s*(円?)$/.exec(s);
  if (!m) return null;
  const [, sign1, currency, sign2, body, yen] = m as unknown as [string, string, string, string, string, string];
  if ((sign1 && sign2) || (currency && yen) || (neg && (sign1 || sign2))) return null;
  if (body.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(body)) {
    return { error: "「,」が 3 桁ごとの区切りになっていません（小数点は「.」で書きます）" };
  }
  if (sign1 === "-" || sign2 === "-") neg = true;
  return { ok: (neg ? "-" : "") + body.replace(/,/g, "") };
}

/** 時刻の表示（9:30、9:30:15、午後1:30、1:30 PM、PM 1:30、9時30分）を "HH:mm:ss" にする。 */
function parseTime(s: string): DisplayRead<string> {
  let h: number, mi: number, sec: number;
  let frac = "";
  let half: string | undefined;
  let m = /^(午前|午後|[AP]M)?\s*(\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?\s*([AP]M?)?$/i.exec(s);
  if (m) {
    h = +m[2]!;
    mi = +m[3]!;
    sec = m[4] ? +m[4] : 0;
    frac = m[5] ?? "";
    if (m[1] && m[6]) return null;
    half = (m[1] ?? m[6])?.toUpperCase();
  } else {
    m = /^(午前|午後)?\s*(\d{1,2})\s*時\s*(\d{1,2})\s*分(?:\s*(\d{1,2})\s*秒)?$/.exec(s);
    if (!m) return null;
    h = +m[2]!;
    mi = +m[3]!;
    sec = m[4] ? +m[4] : 0;
    half = m[1];
  }
  if (half) {
    if (h > 12) return { error: "午前・午後と 13 時以降が一緒に書かれています" };
    const pm = half === "午後" || half.startsWith("P");
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || mi > 59 || sec > 59) return { error: "時刻として正しくありません" };
  return { ok: `${pad(h)}:${pad(mi)}:${pad(sec)}${frac}` };
}

const ERAS: { names: string[]; start: [number, number, number] }[] = [
  { names: ["令和", "令", "R"], start: [2019, 5, 1] },
  { names: ["平成", "平", "H"], start: [1989, 1, 8] },
  { names: ["昭和", "昭", "S"], start: [1926, 12, 25] },
  { names: ["大正", "大", "T"], start: [1912, 7, 30] },
  { names: ["明治", "明", "M"], start: [1868, 10, 23] },
];

const WEEKDAYS = "日月火水木金土";

function ymd(y: number, m: number, d: number): number {
  return y * 10000 + m * 100 + d;
}

/** 存在する日付なら曜日（0 が日曜）、なければ -1。 */
function weekday(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.getUTCDay() : -1;
}

const DATE_SEP = /^(\d{4})([/.-])(\d{1,2})\2(\d{1,2})/;
const DATE_KANJI = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
const DATE_WAREKI = /^(明治|大正|昭和|平成|令和|[明大昭平令MTSHR])\s*(\d{1,2}|元)\s*(?:年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日|([/.-])(\d{1,2})\5(\d{1,2}))/i;

/**
 * 日付の表示を読む。後ろに時刻があれば一緒に読む。
 * 読むもの: 2024/4/1、2024-4-1、2024.4.1、2024年4月1日、令和6年4月1日、R6.4.1、曜日つき（2024/4/1(月)）、時刻つき（2024/4/1 9:30）。
 */
export function readDateText(text: string): DisplayRead<DisplayDate> {
  const s = normalizeDisplay(text);
  let y: number, mo: number, d: number;
  let era: (typeof ERAS)[number] | undefined;
  let rest: string;
  let m: RegExpExecArray | null;
  if ((m = DATE_SEP.exec(s))) {
    [y, mo, d] = [+m[1]!, +m[3]!, +m[4]!];
    rest = s.slice(m[0].length);
    // 区切りなしで時刻が続くと（2024/4/19:30）日と時が分けられない。
    if (rest !== "" && !/^[\s(T]/.test(rest)) return null;
    if (m[2] === "-" && rest.startsWith("T")) rest = " " + rest.slice(1);
  } else if ((m = DATE_KANJI.exec(s))) {
    [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
    rest = s.slice(m[0].length);
  } else if ((m = DATE_WAREKI.exec(s))) {
    const name = m[1]!;
    era = ERAS.find((e) => e.names.some((n) => n.toUpperCase() === name.toUpperCase()))!;
    const ey = m[2] === "元" ? 1 : +m[2]!;
    if (ey < 1) return { error: `和暦の年が正しくありません（${m[0]}）` };
    [y, mo, d] = [era.start[0] + ey - 1, +(m[3] ?? m[6])!, +(m[4] ?? m[7])!];
    rest = s.slice(m[0].length);
    if (m[5] && rest !== "" && !/^[\s(]/.test(rest)) return null;
  } else {
    return refuseDate(s);
  }
  const datePart = s.slice(0, s.length - rest.length);
  const wd = weekday(y, mo, d);
  if (wd < 0) return { error: `日付として正しくありません（${datePart}）` };
  if (era) {
    const i = ERAS.indexOf(era);
    const next = ERAS[i - 1];
    const v = ymd(y, mo, d);
    if (v < ymd(...era.start) || (next && v >= ymd(...next.start))) return { error: `${datePart} は${era.names[0]}の期間にありません` };
  }
  const w = /^\s*\(([日月火水木金土])(?:曜日?)?\)/.exec(rest);
  if (w) {
    if (WEEKDAYS.indexOf(w[1]!) !== wd) return { error: `曜日が日付と合いません（${datePart} は${WEEKDAYS[wd]}曜日）` };
    rest = rest.slice(w[0].length);
  }
  rest = rest.trim();
  const date = `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
  if (rest === "") return { ok: { date } };
  const t = parseTime(rest);
  if (t === null || "error" in t) return t;
  return { ok: { date, time: t.ok } };
}

/** 日付に見えるが、年月日の順や年が決まらない表示に理由を返す。 */
function refuseDate(s: string): DisplayRead<DisplayDate> {
  if (/^\d{1,2}([/.-])\d{1,2}\1\d{1,4}(?:[\s(]|$)/.test(s)) {
    return { error: `年月日の順が決まりません（${s.split(/[\s(]/)[0]}）。年を 4 桁にして 2024/04/01 の形にしてください` };
  }
  if (/^\d{1,2}[/-]\d{1,2}(?:\s*\(.\))?$/.test(s) || /^\d{1,2}\s*月\s*\d{1,2}\s*日/.test(s)) return { error: `年がありません（${s}）` };
  if (/^\d{4}[/.-]\d{1,2}$/.test(s) || /^\d{4}\s*年\s*\d{1,2}\s*月$/.test(s)) return { error: `日がありません（${s}）` };
  return null;
}

/** 時刻の表示を読む。読むもの: 9:30、9:30:15、午後1:30、1:30 PM、9時30分。 */
export function readTimeText(text: string): DisplayRead<string> {
  return parseTime(normalizeDisplay(text));
}

/** 真偽の表示（TRUE / FALSE、1 / 0、全角も）を読む。 */
export function readBooleanText(text: string): boolean | undefined {
  const s = normalizeDisplay(text).toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return undefined;
}
