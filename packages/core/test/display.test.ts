import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupReadings,
  readDateText,
  readingsToCsv,
  readNumberText,
  readTimeText,
  validate,
  type Sheet,
  type TableDescription,
} from "../src/index.js";

const ok = <T>(r: { ok: T } | { error: string } | null): T => {
  assert.ok(r && "ok" in r, JSON.stringify(r));
  return r.ok;
};
const error = (r: { ok: unknown } | { error: string } | null): string => {
  assert.ok(r && "error" in r, JSON.stringify(r));
  return r.error;
};

test("数の表示: 桁区切り、通貨、負の数、全角を読む", () => {
  const cases: [string, string][] = [
    ["1,200", "1200"],
    ["1,234,567.50", "1234567.50"],
    ["¥1,200", "1200"],
    ["￥１，２００", "1200"],
    ["\\1,200", "1200"],
    ["$1,234.50", "1234.50"],
    ["1,200円", "1200"],
    ["-1,200", "-1200"],
    ["−1,200", "-1200"],
    ["-¥1,200", "-1200"],
    ["¥-1,200", "-1200"],
    ["▲1,200", "-1200"],
    ["△ 1,200", "-1200"],
    ["(1,200)", "-1200"],
    ["(¥1,200)", "-1200"],
    ["+12", "12"],
    [" 1200 ", "1200"],
  ];
  for (const [text, want] of cases) assert.equal(ok(readNumberText(text)), want, text);
});

test("数の表示: 決まらないもの、丸められているかもしれないものは理由をつけて断る", () => {
  assert.match(error(readNumberText("12.5%")), /0\.125 と 12\.5 のどちら/);
  assert.match(error(readNumberText("1.2E+05")), /指数の表示/);
  assert.match(error(readNumberText("###")), /列の幅が足りず/);
  assert.match(error(readNumberText("1,2")), /3 桁ごとの区切り/);
  assert.match(error(readNumberText("12,00,000")), /3 桁ごとの区切り/);
  assert.match(error(readNumberText("¥ -")), /会計の表示形式/);
  for (const text of ["abc", "1,200-", "1.", "▲-1", "--1", "¥1,200円"]) assert.equal(readNumberText(text), null, text);
});

test("日付の表示: 年が先頭の 4 桁なら区切りを問わず読む。和暦と曜日と時刻も", () => {
  const cases: [string, string, string?][] = [
    ["2024/04/01", "2024-04-01"],
    ["2024/4/1", "2024-04-01"],
    ["2024-4-1", "2024-04-01"],
    ["2024.4.1", "2024-04-01"],
    ["２０２４／４／１", "2024-04-01"],
    ["2024年4月1日", "2024-04-01"],
    ["令和6年4月1日", "2024-04-01"],
    ["令和元年5月1日", "2019-05-01"],
    ["R6.4.1", "2024-04-01"],
    ["H31.4.30", "2019-04-30"],
    ["昭和64年1月7日", "1989-01-07"],
    ["2024/4/1(月)", "2024-04-01"],
    ["2024年4月1日（月曜日）", "2024-04-01"],
    ["2024/2/29", "2024-02-29"],
    ["2024/4/1 9:30", "2024-04-01", "09:30:00"],
    ["2024/4/1 午後1:30", "2024-04-01", "13:30:00"],
    ["2024/4/1 1:30:15 PM", "2024-04-01", "13:30:15"],
    ["2024-04-01T09:30", "2024-04-01", "09:30:00"],
    ["令和6年4月1日 9時30分", "2024-04-01", "09:30:00"],
    ["2024/4/1 9:30:15.123456789", "2024-04-01", "09:30:15.123456789"],
  ];
  for (const [text, date, time] of cases) assert.deepEqual(ok(readDateText(text)), time ? { date, time } : { date }, text);
});

test("日付の表示: 年月日の順が決まらないもの、ありえない日は断る", () => {
  assert.match(error(readDateText("4/1/2024")), /年月日の順が決まりません（4\/1\/2024）/);
  assert.match(error(readDateText("01/04/2024")), /年月日の順が決まりません/);
  assert.match(error(readDateText("24/4/1")), /年月日の順が決まりません/);
  assert.match(error(readDateText("4/1")), /年がありません/);
  assert.match(error(readDateText("4月1日")), /年がありません/);
  assert.match(error(readDateText("2024/4")), /日がありません/);
  assert.match(error(readDateText("2023/2/29")), /日付として正しくありません/);
  assert.match(error(readDateText("2024/13/1")), /日付として正しくありません/);
  assert.match(error(readDateText("H31.5.1")), /平成の期間にありません/);
  assert.match(error(readDateText("昭和64年1月8日")), /昭和の期間にありません/);
  assert.match(error(readDateText("2024/4/1(火)")), /曜日が日付と合いません（2024\/4\/1 は月曜日）/);
  // 日と時が続いていて分けられない。
  assert.equal(readDateText("2024/4/19:30"), null);
});

test("時刻の表示: 1 桁の時、午前午後、AM/PM、時分秒を読む", () => {
  const cases: [string, string][] = [
    ["9:30", "09:30:00"],
    ["9:30:15.123", "09:30:15.123"],
    ["午後1:30", "13:30:00"],
    ["午前12:00", "00:00:00"],
    ["12:00 PM", "12:00:00"],
    ["PM 1:30", "13:30:00"],
    ["9時30分15秒", "09:30:15"],
  ];
  for (const [text, want] of cases) assert.equal(ok(readTimeText(text)), want, text);
  assert.match(error(readTimeText("13:30 PM")), /午前・午後と 13 時以降/);
  assert.match(error(readTimeText("25:00")), /時刻として正しくありません/);
});

const item: TableDescription = {
  ok: true,
  v: 1,
  target: "item",
  table: "dbo.M_Item",
  access: "update",
  dialect: "sqlserver",
  key: ["ItemNo"],
  columns: [
    { name: "ItemNo", type: "integer", dbType: "int", nullable: false, updatable: false },
    { name: "Name", type: "string", dbType: "nvarchar(50)", maxLength: 50, nullable: true, updatable: true },
    { name: "Price", type: "decimal", dbType: "decimal(9,2)", precision: 9, scale: 2, nullable: true, updatable: true },
    { name: "Stock", type: "bigint", dbType: "bigint", nullable: true, updatable: true },
    { name: "Rate", type: "float", dbType: "float", nullable: true, updatable: true },
    { name: "Active", type: "boolean", dbType: "bit", nullable: true, updatable: true },
    { name: "ReleaseDate", type: "date", dbType: "date", nullable: true, updatable: true },
    { name: "ShipAt", type: "datetime", dbType: "datetime2(0)", scale: 0, nullable: true, updatable: true },
    { name: "OpenAt", type: "time", dbType: "time(0)", scale: 0, nullable: true, updatable: true },
  ],
  foreignKeys: [],
  limits: { maxFetchKeys: 1000, maxApplyRows: 5000 },
};

const header = ["ItemNo", "Name", "Price", "Stock", "Rate", "Active", "ReleaseDate", "ShipAt", "OpenAt"];
const sheet = (rows: Sheet["rows"]): Sheet => ({ name: "s", rows: [header, ...rows] });

test("検証: 数・日付・時刻・真偽の列は表示の形を読み、読み替えたセルを残す。文字列の列はそのまま", () => {
  const v = validate(item, sheet([["1,001", "2024/04/01", "¥1,200", "12,345", "0.5", "ＴＲＵＥ", "2024/4/1", "2024/4/1 9:30", "午後1:30"]]));
  assert.ok(v.ok, JSON.stringify(v.issues));
  assert.deepEqual(v.rows[0], {
    row: 1,
    key: { ItemNo: 1001 },
    values: { Name: "2024/04/01", Price: "1200.00", Stock: "12345", Rate: 0.5, Active: true, ReleaseDate: "2024-04-01", ShipAt: "2024-04-01T09:30:00", OpenAt: "13:30:00" },
    ok: true,
  });
  assert.deepEqual(
    v.readings.map((r) => [r.cell, r.column, r.text, r.value]),
    [
      ["A2", "ItemNo", "1,001", 1001],
      ["C2", "Price", "¥1,200", "1200.00"],
      ["D2", "Stock", "12,345", "12345"],
      ["F2", "Active", "ＴＲＵＥ", true],
      ["G2", "ReleaseDate", "2024/4/1", "2024-04-01"],
      ["H2", "ShipAt", "2024/4/1 9:30", "2024-04-01T09:30:00"],
      ["I2", "OpenAt", "午後1:30", "13:30:00"],
    ],
  );
});

test("検証: これまでの形は読み替えとして数えない", () => {
  const v = validate(item, sheet([["1", "x", "1200", "5", "0.5", "true", "2024-04-01", "2024-04-01 09:30:00", "09:30"], ["2", "y", 1200, 5, 0.5, true, null, null, null]]));
  assert.ok(v.ok, JSON.stringify(v.issues));
  assert.deepEqual(v.readings, []);
  assert.equal(v.rows[0]!.values.OpenAt, "09:30:00");
});

test("検証: 読めない表示は理由つきのエラー。Excel のエラー値は文字列の列でも断る", () => {
  const v = validate(
    item,
    sheet([
      ["1", "#N/A", "12.5%", "1.5", "1.2E+05", "はい", "4/1/2024", "2024/4/1(火)", "25:00"],
      ["2", null, "¥1,234,567,890", null, null, null, "2024/4/1 9:30", null, null],
    ]),
  );
  assert.deepEqual(
    v.issues.map((i) => [i.cell, i.message]),
    [
      ["B2", "セルがエラー値です（#N/A）"],
      ["C2", "「%」の付いた数は読み替えません（12.5% を 0.125 と 12.5 のどちらで入れるか決まらないため）。DB に入れる数で書いてください"],
      ["D2", "整数ではありません"],
      ["E2", "指数の表示（1.2E+05 など）は Excel が桁を丸めていることがあるので読みません。表示形式を「数値」にしてからコピーしてください"],
      ["F2", "true / false ではありません"],
      ["G2", "年月日の順が決まりません（4/1/2024）。年を 4 桁にして 2024/04/01 の形にしてください"],
      ["H2", "曜日が日付と合いません（2024/4/1 は月曜日）"],
      ["I2", "時刻（HH:mm:ss）ではありません"],
      ["C3", "整数部は 7 桁までです"],
      ["G3", "時刻つきの日付です"],
    ],
  );
  assert.deepEqual(v.readings, []);
});

test("読み替えを列ごとにまとめ、CSV にする", () => {
  const v = validate(item, sheet([["1", null, "¥1,200", null, null, null, "2024/4/1"], ["2", null, "¥980", null, null, null, "2024/4/2"], ["3", null, "500"]]));
  assert.deepEqual(
    groupReadings(v.readings).map((g) => [g.column, g.count, g.first.cell]),
    [
      ["Price", 2, "C2"],
      ["ReleaseDate", 2, "G2"],
    ],
  );
  assert.equal(readingsToCsv(v.readings).split("\r\n")[1], "C2,2,Price,\"¥1,200\",1200.00");
});
