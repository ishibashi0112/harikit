import { test } from "node:test";
import assert from "node:assert/strict";
import { byteCount, checkValue, compileRules, diff, validate, type ColumnDef, type TableDescription } from "../src/index.js";

const product: TableDescription = {
  ok: true,
  v: 1,
  target: "product",
  table: "dbo.M_Product",
  access: "update",
  dialect: "sqlserver",
  key: ["ProductCode"],
  columns: [
    { name: "ProductCode", type: "string", dbType: "varchar(10)", maxLength: 10, maxBytes: 10, encoding: "shift_jis", nullable: false, updatable: false },
    { name: "Memo", type: "string", dbType: "varchar(10)", maxLength: 10, maxBytes: 10, encoding: "shift_jis", nullable: true, updatable: true },
    { name: "UnitPrice", type: "decimal", dbType: "decimal(9,2)", precision: 9, scale: 2, nullable: true, updatable: true },
    { name: "Qty", type: "integer", dbType: "int", nullable: true, updatable: true },
    { name: "ReleaseDate", type: "date", dbType: "date", nullable: true, updatable: true },
  ],
  foreignKeys: [],
  limits: { maxFetchKeys: 1000, maxApplyRows: 5000 },
};

test("バイト数: shift_jis、windows-1252、UTF-8、UTF-16", () => {
  assert.deepEqual(byteCount("ｱA鍵①髙", "shift_jis"), { bytes: 1 + 1 + 2 + 2 + 2 });
  assert.deepEqual(byteCount("𠮷", "shift_jis"), { unencodable: "𠮷" });
  assert.deepEqual(byteCount("café", "windows-1252"), { bytes: 4 });
  assert.deepEqual(byteCount("鍵", "windows-1252"), { unencodable: "鍵" });
  assert.deepEqual(byteCount("鍵", "utf-8"), { bytes: 3 });
  assert.deepEqual(byteCount("𠮷a", "utf-16le"), { bytes: 6 });
  assert.equal(byteCount("x", "no-such-encoding"), null);
});

test("バイト数: euc-jp（Oracle の JA16EUC）", () => {
  assert.deepEqual(byteCount("Aあ鍵ｱ", "euc-jp"), { bytes: 1 + 2 + 2 + 2 });
  assert.deepEqual(byteCount("𠮷", "euc-jp"), { unencodable: "𠮷" });
});

test("varchar の桁はバイトで数え、表せない字は弾く", () => {
  const memo = product.columns[1]!;
  assert.equal(checkValue(memo, "ボールペン"), null);
  assert.equal(checkValue(memo, "ﾎﾞｰﾙﾍﾟﾝ黒"), null);
  assert.match(checkValue(memo, "ボールペン黒")!, /10 バイトを超えています（12 バイト）/);
  assert.match(checkValue(memo, "𠮷野家")!, /「𠮷」は列の文字コード（shift_jis）で表せません/);
  const nv: ColumnDef = { name: "n", type: "string", dbType: "nvarchar(2)", maxLength: 2, maxBytes: 4, encoding: "utf-16le", nullable: true, updatable: true };
  assert.match(checkValue(nv, "𠮷a")!, /4 バイトを超えています/);
});

test("ルールの設定の誤りを見つける", () => {
  const { issues } = compileRules(product, [
    { column: "Nope", min: 0 },
    { column: "Memo", min: 0 },
    { column: "UnitPrice", greaterthan: 0 },
    { column: "UnitPrice", min: "abc" },
    { column: "Memo", pattern: "(" },
    { column: "Memo", maxChangePercent: 10 },
    { column: "Qty", severity: "info", min: 1 },
  ]);
  assert.deepEqual(issues.map((i) => i.message), [
    "業務ルール 1 番目: 列 Nope は product にありません",
    "業務ルール 2 番目: min は数値か日付の列だけに使えます",
    "業務ルール 3 番目: 知らない項目 greaterthan があります",
    '業務ルール 4 番目: min の値 "abc" が列の型として読めません',
    "業務ルール 5 番目: pattern ( は正規表現として読めません",
    "業務ルール 6 番目: maxChangePercent は数値の列だけに使えます",
    "業務ルール 7 番目: severity は error か warning です",
  ]);
  assert.equal(compileRules(product, { not: "array" }).issues.length, 1);
});

test("セルのルールと変動率のルール", () => {
  const { rules, issues } = compileRules(product, [
    { column: "UnitPrice", greaterThan: 0 },
    { column: "UnitPrice", max: "1000.5" },
    { column: "UnitPrice", maxChangePercent: 50, severity: "warning" },
    { column: "Qty", required: true, message: "数量は必ず入れてください" },
    { column: "Qty", oneOf: [1, 10, 100] },
    { column: "ProductCode", pattern: "^[A-Z]\\d{3}$" },
    { column: "ReleaseDate", min: "2020-01-01" },
  ]);
  assert.deepEqual(issues, []);
  const v = validate(
    product,
    {
      name: "s",
      rows: [
        ["ProductCode", "UnitPrice", "Qty", "ReleaseDate"],
        ["A001", 0, 10, "2024-04-01"],
        ["a002", 1000.51, null, "2019-12-31"],
        ["A003", 1000.5, 5, null],
        ["A004", 300, 100, null],
      ],
    },
    { rules },
  );
  assert.deepEqual(
    v.issues.map((i) => [i.severity, i.cell, i.message]),
    [
      ["error", "B2", "0 より大きくしてください"],
      ["error", "A3", "決まった形（^[A-Z]\\d{3}$）になっていません"],
      ["error", "B3", "1000.5 以下にしてください"],
      ["error", "C3", "数量は必ず入れてください"],
      ["error", "D3", "2020-01-01 以上にしてください"],
      ["error", "C4", "使える値は 1, 10, 100 です"],
    ],
  );
  const ok = validate(product, { name: "s", rows: [["ProductCode", "UnitPrice"], ["A001", 181], ["A002", 150], ["A003", 1]] }, { rules });
  assert.ok(ok.ok);
  const d = diff(
    product,
    ok,
    [
      { index: 0, found: true, values: { ProductCode: "A001", UnitPrice: "120.00" } },
      { index: 1, found: true, values: { ProductCode: "A002", UnitPrice: "100.00" } },
      { index: 2, found: true, values: { ProductCode: "A003", UnitPrice: "0.00" } },
    ],
    { rules },
  );
  assert.deepEqual(
    d.issues.map((i) => [i.severity, i.cell, i.message]),
    [
      ["warning", "B2", "今の値 120.00 から 50.8% 変わります（±50% まで）"],
      ["warning", "B4", "今の値が 0 なので変動率を出せません（1.00 にします）"],
    ],
  );
});

test("知らない文字コードの列は確かめず、警告を出す", () => {
  const desc: TableDescription = {
    ...product,
    columns: product.columns.map((c) => (c.name === "Memo" ? { ...c, encoding: "x-unknown" } : c)),
  };
  const v = validate(desc, { name: "s", rows: [["ProductCode", "Memo"], ["A001", "ボールペン（黒）替芯"]] });
  assert.ok(v.ok);
  assert.deepEqual(v.issues.map((i) => [i.severity, i.message]), [["warning", "列「Memo」の文字コード（x-unknown）を確認できないので、バイト数と表せない字は見ていません"]]);
});
