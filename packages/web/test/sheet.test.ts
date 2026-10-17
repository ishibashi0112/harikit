import { test } from "node:test";
import assert from "node:assert/strict";
import { HarikitClient, prepare, type FetchRequest, type Row, type TableDescription } from "@harikit/core";
import { addConflictMarks, addHeader, buildMarks, diffGridRows, headerInfo, liveMark, markKey, toSheet, type GridRow } from "../src/sheet.js";

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
    { name: "UpdatedAt", type: "datetime", dbType: "datetime2(3)", scale: 3, nullable: false, updatable: false },
  ],
  foreignKeys: [],
  limits: { maxFetchKeys: 1000, maxApplyRows: 5000 },
};

const db: Record<string, Row> = {
  A001: { ProductCode: "A001", ProductName: "ボールペン黒", UnitPrice: "120.00" },
  A002: { ProductCode: "A002", ProductName: "ボールペン赤", UnitPrice: null },
};

/** describe と fetch だけを返すサーバの代わり。 */
const client = new HarikitClient({
  baseUrl: "http://127.0.0.1:7357",
  fetch: async (url, init) => {
    const name = String(url).split("/").pop();
    const body = JSON.parse(String(init?.body)) as FetchRequest;
    const res =
      name === "describe"
        ? product
        : { ok: true, v: 1, target: body.target, rows: body.keys.map((k, index) => (db[String(k.ProductCode)] ? { index, found: true, values: db[String(k.ProductCode)] } : { index, found: false })) };
    return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } });
  },
});

let id = 0;
const grid = (cells: (string | null)[][]): GridRow[] =>
  cells.map((r) => {
    const row: GridRow = { id: ++id };
    r.forEach((v, c) => {
      if (v !== null) row[String.fromCharCode(65 + c)] = v;
    });
    return row;
  });

test("toSheet: 空のセルは null、後ろの空の行は落とす", () => {
  const rows = grid([
    ["ProductCode", "UnitPrice"],
    ["A001", ""],
    [null, null],
    ["A002", "150"],
    [null, null],
    ["", null],
  ]);
  assert.deepEqual(toSheet(rows, 3).rows, [
    ["ProductCode", "UnitPrice", null],
    ["A001", null, null],
    [null, null, null],
    ["A002", "150", null],
  ]);
});

test("addHeader: 空いている列に入れる。もうあればその列、埋まっていれば右端の次", () => {
  const rows = grid([["ProductCode", null, "UnitPrice"], ["A001", null, "1"]]);
  const a = addHeader(rows, 3, "ProductName");
  assert.equal(a.col, 1);
  assert.equal(a.rows[0]!.B, "ProductName");
  assert.equal(a.rows[1], rows[1]);
  assert.equal(addHeader(a.rows, 3, "unitprice").col, 2);
  const full = addHeader(a.rows, 3, "UpdatedAt");
  assert.equal(full.col, 3);
  assert.equal(full.rows[0]!.D, "UpdatedAt");
});

test("buildMarks: 誤り、警告、変わるセル、キーなしをセルの印にする", async () => {
  const rows = grid([
    ["ProductCode", "UnitPrice", "ProductName"],
    ["A001", "130", "ボールペン黒 "],
    ["A002", "abc", "ボールペン赤"],
    ["X999", "100", "新しい商品"],
  ]);
  const errors = await prepare(client, "product", toSheet(rows, 3));
  assert.equal(errors.ok, false);
  let marks = buildMarks(rows, errors);
  assert.deepEqual(liveMark(marks, rows[2]!, "B")?.errors, ["数値ではありません"]);
  assert.equal(liveMark(marks, rows[1]!, "C")?.warn, true);

  // 直したセルの印は消える（値が検証したときと違う）。
  const fixed = rows.map((r, i) => (i === 2 ? { ...r, B: "150" } : r));
  assert.equal(liveMark(marks, fixed[2]!, "B"), undefined);

  const ok = await prepare(client, "product", toSheet(fixed, 3));
  assert.equal(ok.ok, true);
  marks = buildMarks(fixed, ok);
  const price = liveMark(marks, fixed[1]!, "B")!;
  assert.equal(price.kind, "change");
  assert.deepEqual(price.notes, ["DB の今の値: 120.00"]);
  assert.equal(liveMark(marks, fixed[2]!, "B")!.notes[0], "DB の今の値: （空）");
  assert.equal(liveMark(marks, fixed[3]!, "A")!.kind, "not_found");
  assert.equal(liveMark(marks, fixed[3]!, "B"), undefined);

  // 反映で衝突した行（変わる行の並びで 1 番目 = A002）のキーに印を足す。
  const withConflict = addConflictMarks(marks, fixed, ok, [{ target: "product", index: 1, key: { ProductCode: "A002" }, reason: "changed", columns: ["UnitPrice"], current: { UnitPrice: "90.00" } }]);
  const conflict = withConflict.get(markKey(fixed[2]!.id, "A"))!;
  assert.equal(conflict.kind, "conflict");
  assert.match(conflict.notes.at(-1)!, /UnitPrice=90\.00/);
  assert.equal(marks.get(markKey(fixed[2]!.id, "A")), undefined);

  const d = diffGridRows(ok.diff!);
  assert.deepEqual(
    d.map((r) => [r.row, r.status, r["k:ProductCode"], r["b:UnitPrice"], r["a:UnitPrice"], r.changed]),
    [
      [2, "変わる", "A001", "120.00", "130.00", ["ProductName", "UnitPrice"]],
      [3, "変わる", "A002", null, "150.00", ["UnitPrice"]],
      [4, "キーなし", "X999", undefined, "100.00", []],
    ],
  );
});

test("buildMarks と diffGridRows: Excel の表示から読み替えたセルに印と貼った値を残す", async () => {
  const rows = grid([
    ["ProductCode", "UnitPrice"],
    ["A001", "¥1,300"],
    ["A002", "1,500"],
  ]);
  const result = await prepare(client, "product", toSheet(rows, 2));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const marks = buildMarks(rows, result);
  const price = liveMark(marks, rows[1]!, "B")!;
  assert.equal(price.read, true);
  assert.equal(price.kind, "change");
  assert.deepEqual(price.notes, ["「¥1,300」を 1300.00 として読みました", "DB の今の値: 120.00"]);
  assert.equal(liveMark(marks, rows[1]!, "A"), undefined);
  // 書き直したら印は消える。
  assert.equal(liveMark(marks, { ...rows[1]!, B: "1300" }, "B"), undefined);

  const d = diffGridRows(result.diff!, result.validation.readings);
  assert.deepEqual(
    d.map((r) => [r["a:UnitPrice"], r.pasted]),
    [
      ["1300.00", { UnitPrice: "¥1,300" }],
      ["1500.00", { UnitPrice: "1,500" }],
    ],
  );
});

test("headerInfo: 見出しの名前がどの列に当たるか", () => {
  assert.equal(headerInfo(product, "productcode")?.kind, "key");
  assert.equal(headerInfo(product, " UnitPrice ")?.kind, "update");
  assert.equal(headerInfo(product, "UpdatedAt")?.kind, "readonly");
  assert.equal(headerInfo(product, "Foo")?.kind, "unknown");
  assert.equal(headerInfo(product, ""), undefined);
});
