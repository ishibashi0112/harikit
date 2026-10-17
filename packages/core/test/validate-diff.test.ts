import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApplyRequest, diff, validate, validRows, type Sheet, type TableDescription } from "../src/index.js";

const product: TableDescription = {
  ok: true,
  v: 1,
  target: "product",
  table: "dbo.M_Product",
  access: "update",
  dialect: "sqlserver",
  key: ["ProductCode"],
  columns: [
    { name: "ProductCode", type: "string", dbType: "varchar(10)", maxLength: 10, nullable: false, updatable: false },
    { name: "ProductName", type: "string", dbType: "nvarchar(50)", maxLength: 50, nullable: false, updatable: true },
    { name: "UnitPrice", type: "decimal", dbType: "decimal(9,2)", precision: 9, scale: 2, nullable: true, updatable: true },
    { name: "ReleaseDate", type: "date", dbType: "date", nullable: true, updatable: true },
    { name: "UpdatedAt", type: "datetime", dbType: "datetime2(3)", scale: 3, nullable: false, updatable: false },
  ],
  foreignKeys: [],
  limits: { maxFetchKeys: 1000, maxApplyRows: 5000 },
};

const sheet = (rows: Sheet["rows"]): Sheet => ({ name: "s", rows });

test("見出しの誤り: 無い列、更新できない列、キーなし", () => {
  const v = validate(product, sheet([["productname", "Foo", "UpdatedAt"]]));
  assert.equal(v.ok, false);
  assert.deepEqual(
    v.issues.map((i) => [i.cell, i.message]),
    [
      ["B1", "列「Foo」は product にありません"],
      ["C1", "列「UpdatedAt」は更新できません"],
      [undefined, "キーの列「ProductCode」がありません"],
    ],
  );
});

test("値の変換と行の誤り", () => {
  const v = validate(
    product,
    sheet([
      ["ProductCode", "UnitPrice", "ReleaseDate", "ProductName"],
      ["A001", 130, { kind: "date", iso: "2024-04-01T00:00:00.000" }, "ペン "],
      ["A002", "abc", "04/01/2024", "x"],
      [null, null, null, null],
      ["A001", 1, null, "y"],
      [1001, 0.1 + 0.2, null, { kind: "date", iso: "2024-01-02T00:00:00.000" }],
    ]),
  );
  assert.equal(v.ok, false);
  assert.deepEqual(v.updateColumns, ["ProductName", "UnitPrice", "ReleaseDate"]);
  assert.deepEqual(v.rows[0], { row: 1, key: { ProductCode: "A001" }, values: { UnitPrice: "130.00", ReleaseDate: "2024-04-01", ProductName: "ペン " }, ok: true });
  assert.deepEqual(
    v.issues.map((i) => [i.severity, i.cell, i.message]),
    [
      ["warning", "D2", "前後に空白があります（そのまま使います）"],
      ["error", "B3", "数値ではありません"],
      ["error", "C3", "年月日の順が決まりません（04/01/2024）。年を 4 桁にして 2024/04/01 の形にしてください"],
      ["error", "A5", "キーが 2 行目と重複しています"],
      ["error", "D6", "日付として入っています（文字列にしてください）"],
    ],
  );
  assert.equal(v.rows[3]!.values.UnitPrice, "0.30");
  assert.equal(v.rows[3]!.key.ProductCode, "1001");
});

test("差分: 変わる列だけを apply に送る", () => {
  const v = validate(
    product,
    sheet([
      ["ProductCode", "ProductName", "UnitPrice"],
      ["A001", "ペン黒", 130],
      ["A002", "ペン赤", 100],
      ["Z999", "なし", 1],
    ]),
  );
  assert.ok(v.ok);
  const d = diff(product, v, [
    { index: 0, found: true, values: { ProductCode: "A001", ProductName: "ペン黒", UnitPrice: "120.00" } },
    { index: 1, found: true, values: { ProductCode: "A002", ProductName: "ペン赤", UnitPrice: "100" } },
    { index: 2, found: false },
  ]);
  assert.deepEqual(d.counts, { change: 1, same: 1, not_found: 1 });
  const req = buildApplyRequest(d, { mode: "check", requestId: "6f1c2a8e-3b0d-4e7a-9c55-1d2e3f4a5b6c" });
  assert.deepEqual(req.changes, [
    { target: "product", rows: [{ op: "update", key: { ProductCode: "A001" }, before: { UnitPrice: "120.00" }, after: { UnitPrice: "130.00" } }] },
  ]);
});

test("差分: DB 上で同じ行を指す 2 行はエラー", () => {
  const v = validate(product, sheet([["ProductCode", "ProductName"], ["a001", "x"], ["A001", "y"]]));
  assert.equal(validRows(v).length, 2);
  const d = diff(product, v, [
    { index: 0, found: true, values: { ProductCode: "A001", ProductName: "z" } },
    { index: 1, found: true, values: { ProductCode: "A001", ProductName: "z" } },
  ]);
  assert.deepEqual(d.issues.map((i) => [i.cell, i.message]), [["A3", "2 行目と DB 上で同じ行を指しています"]]);
});

test("差分: 文字列は厳密に比べる（全角半角、かな、大文字小文字、末尾の空白）。char の詰め物の空白だけは見ない", () => {
  const desc: TableDescription = {
    ...product,
    columns: [...product.columns, { name: "Grade", type: "string", dbType: "char(3)", maxLength: 3, nullable: true, updatable: true }],
  };
  const v = validate(
    desc,
    sheet([
      ["ProductCode", "ProductName", "Grade"],
      ["A001", "ボールペン", "A"],
      ["A002", "ぼーるぺん", "A"],
      ["A003", "pen", "A"],
      ["A004", "Pen", "A"],
      ["A005", "Pen", "A"],
    ]),
  );
  assert.ok(v.ok, JSON.stringify(v.issues));
  const d = diff(desc, v, [
    { index: 0, found: true, values: { ProductCode: "A001", ProductName: "ﾎﾞｰﾙﾍﾟﾝ", Grade: "A  " } },
    { index: 1, found: true, values: { ProductCode: "A002", ProductName: "ボールペン", Grade: "A  " } },
    { index: 2, found: true, values: { ProductCode: "A003", ProductName: "Pen", Grade: "A  " } },
    { index: 3, found: true, values: { ProductCode: "A004", ProductName: "Pen ", Grade: "A  " } },
    { index: 4, found: true, values: { ProductCode: "A005", ProductName: "Pen", Grade: "A  " } },
  ]);
  assert.deepEqual(d.rows.map((r) => [r.status, r.changes.map((c) => c.column)]), [
    ["change", ["ProductName"]],
    ["change", ["ProductName"]],
    ["change", ["ProductName"]],
    ["change", ["ProductName"]],
    ["same", []],
  ]);
});

test("空文字が NULL になる列（Oracle の文字列）は、取込の空文字を NULL として読む", () => {
  const ora: TableDescription = {
    ...product,
    dialect: "oracle",
    key: ["CODE"],
    columns: [
      { name: "CODE", type: "string", dbType: "VARCHAR2(10 BYTE)", maxLength: 10, nullable: false, updatable: false, emptyIsNull: true },
      { name: "NAME", type: "string", dbType: "NVARCHAR2(50)", maxLength: 50, nullable: false, updatable: true, emptyIsNull: true },
      { name: "NOTE", type: "string", dbType: "VARCHAR2(20 BYTE)", maxLength: 20, nullable: true, updatable: true, emptyIsNull: true },
    ],
  };
  const v = validate(ora, sheet([["CODE", "NAME", "NOTE"], ["A001", "", ""], ["", "x", " "]]));
  assert.deepEqual(v.issues.map((i) => [i.cell, i.message]), [
    ["B2", "必須です（NOT NULL）"],
    ["A3", "必須です（NOT NULL）"],
    ["C3", "前後に空白があります（そのまま使います）"],
  ]);
  // 空白だけの値は NULL にならない（Oracle でも空白のまま入る）。
  assert.deepEqual(v.rows.map((r) => r.values), [{ NOTE: null }, { NAME: "x", NOTE: " " }]);
  const ok = validate(ora, sheet([["CODE", "NOTE"], ["A001", ""]]));
  assert.deepEqual(ok.rows[0]!.values, { NOTE: null });
  const d = diff(ora, ok, [{ index: 0, found: true, values: { CODE: "A001", NOTE: null } }]);
  assert.deepEqual(d.counts, { change: 0, same: 1, not_found: 0 });
});
