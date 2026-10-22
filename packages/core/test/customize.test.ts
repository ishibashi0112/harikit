import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPlan,
  compileRules,
  diff,
  planDigest,
  prepare,
  ruleColumnsToFetch,
  sha256Hex,
  validate,
  verifyPlan,
  type FetchRequest,
  type PatchiriApi,
  type Row,
  type Sheet,
  type TableDescription,
} from "../src/index.js";

const term: TableDescription = {
  ok: true,
  v: 1,
  target: "term",
  table: "dbo.M_Term",
  access: "update",
  dialect: "sqlserver",
  key: ["Code"],
  columns: [
    { name: "Code", type: "string", dbType: "varchar(10)", maxLength: 10, nullable: false, updatable: false, label: "コード" },
    { name: "Kind", type: "string", dbType: "varchar(1)", maxLength: 1, nullable: false, updatable: true, label: "区分" },
    { name: "Price", type: "decimal", dbType: "decimal(9,2)", precision: 9, scale: 2, nullable: true, updatable: true, label: "単価" },
    { name: "Qty", type: "integer", dbType: "int", nullable: true, updatable: true },
    { name: "StartDate", type: "date", dbType: "date", nullable: true, updatable: true },
    { name: "EndDate", type: "date", dbType: "date", nullable: true, updatable: true },
  ],
  foreignKeys: [],
  limits: { maxFetchKeys: 1000, maxApplyRows: 5000 },
};

const sheet = (rows: Sheet["rows"]): Sheet => ({ name: "s", rows });

test("見出しは列名、表示名、別名のどれでもよい", () => {
  const v = validate(term, sheet([["コード", "単価", "数量"], ["A", "1", "2"]]), { aliases: { 数量: "Qty" } });
  assert.deepEqual(v.issues, []);
  assert.deepEqual(v.columnIndex, { Code: 0, Price: 1, Qty: 2 });
  assert.deepEqual(v.rows[0]!.values, { Price: "1.00", Qty: 2 });
  const dup = validate(term, sheet([["Code", "price", "単価"]]));
  assert.deepEqual(dup.issues.map((i) => [i.code, i.message]), [["duplicate_column", "列「Price」が 2 回あります"]]);
});

test("問題には種類のコードが付く", () => {
  const v = validate(term, sheet([["Code", "Nope", "Price"], ["A", 1, "x"], [null, 1, "1"], ["A", 1, " 1"]]));
  assert.deepEqual(v.issues.map((i) => [i.code, i.cell ?? null]), [["unknown_column", "B1"]]);
  const w = validate(term, sheet([["Code", "Price", "Kind"], ["A", "x", "1"], [null, "1", "1"], ["A", "1", " "]]));
  assert.deepEqual(
    w.issues.map((i) => [i.code, i.cell]),
    [
      ["invalid_value", "B2"],
      ["invalid_value", "A3"],
      ["whitespace", "C4"],
      ["duplicate_key", "A4"],
    ],
  );
  assert.deepEqual(w.issues[3]!.params, { firstRow: 1 });
});

test("readDisplay: false なら Excel の表示の形を読まない", () => {
  const rows = sheet([["Code", "Price", "StartDate"], ["A", "¥1,200", "2024/4/1"], ["B", "1200", "2024-04-01"]]);
  assert.equal(validate(term, rows).ok, true);
  const strict = validate(term, rows, { readDisplay: false });
  assert.deepEqual(strict.issues.map((i) => [i.cell, i.message]), [
    ["B2", "数値ではありません"],
    ["C2", "日付として読めません（2024-04-01 の形で書きます）"],
  ]);
  assert.deepEqual(strict.readings, []);
});

test("checkRow で自前の確かめを足せる", () => {
  const v = validate(term, sheet([["Code", "Price", "Qty"], ["A", "100", 0], ["B", "100", 3]]), {
    checkRow: ({ values }) =>
      values.Qty === 0 ? [{ column: "数量", message: "数量 0 は使えません" }, { message: "行全体の注意", severity: "warning", code: "note" }] : [],
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.issues.map((i) => [i.severity, i.code, i.cell ?? null, i.message]), [
    ["error", "custom", null, "数量 0 は使えません"],
    ["warning", "note", null, "行全体の注意"],
  ]);
  const named = validate(term, sheet([["Code", "Qty"], ["A", 0]]), { checkRow: () => [{ column: "Qty", message: "だめ" }] });
  assert.deepEqual(named.issues.map((i) => [i.cell, i.column]), [["B2", "Qty"]]);
  assert.equal(named.rows[0]!.ok, false);
});

test("行のルール: ほかの列との比較と when", () => {
  const { rules, issues } = compileRules(term, [
    { column: "EndDate", min: { column: "StartDate" } },
    { column: "Price", max: 0, when: { column: "Kind", equals: "9" }, message: "区分 9 は単価 0 です" },
    { column: "Qty", required: true, when: { column: "Kind", oneOf: ["1", "2"] } },
  ]);
  assert.deepEqual(issues, []);
  assert.deepEqual(rules.map((r) => r.columns), [["EndDate", "StartDate"], ["Price", "Kind"], ["Qty", "Kind"]]);
  const v = validate(
    term,
    sheet([
      ["Code", "Kind", "Price", "Qty", "StartDate", "EndDate"],
      ["A", "9", "10", 1, "2024-04-01", "2024-03-31"],
      ["B", "9", "0", 1, "2024-04-01", null],
      ["C", "1", "5", null, null, "2024-01-01"],
      ["D", "3", "5", null, "2024-04-01", "2024-04-01"],
    ]),
    { rules },
  );
  assert.deepEqual(v.issues.map((i) => [i.code, i.cell, i.message]), [
    ["rule_violation", "F2", "StartDate（2024-04-01） 以上にしてください"],
    ["rule_violation", "C2", "区分 9 は単価 0 です"],
    ["rule_violation", "D4", "必須です（業務ルール）"],
  ]);
});

test("取込に無い列を見る行のルールは、差分で DB の値を使って見る", () => {
  const { rules } = compileRules(term, [
    { column: "EndDate", min: { column: "StartDate" } },
    { column: "Price", max: 0, when: { column: "Kind", equals: "9" } },
    { column: "Price", maxChangePercent: 10, when: { column: "Kind", equals: "1" } },
  ]);
  const v = validate(term, sheet([["Code", "StartDate", "Price"], ["A", "2024-05-01", "120"], ["B", "2024-01-01", "100"], ["C", "2024-01-01", "100"]]), { rules });
  assert.deepEqual(v.issues, []);
  assert.deepEqual(ruleColumnsToFetch(rules, v), ["EndDate", "Kind"]);
  const d = diff(
    term,
    v,
    [
      { index: 0, found: true, values: { Code: "A", StartDate: "2024-04-01", EndDate: "2024-04-30", Price: "100.00", Kind: "1" } },
      { index: 1, found: true, values: { Code: "B", StartDate: "2023-01-01", EndDate: "2024-04-30", Price: "90.00", Kind: "9" } },
      { index: 2, found: true, values: { Code: "C", StartDate: "2024-01-01", EndDate: "2024-04-30", Price: "100.00", Kind: "9" } },
    ],
    { rules },
  );
  assert.deepEqual(d.issues.map((i) => [i.code, i.cell, i.message]), [
    ["rule_violation", "C2", "今の値 100.00 から 20% 変わります（±10% まで）"],
    // ルールの列（EndDate）が取込に無いので、取込にある列のセルに付け、文の頭にルールの列と DB の今の値を付ける。
    ["rule_violation", "B2", "EndDate（2024-04-30）は StartDate（2024-05-01） 以上にしてください"],
    ["rule_violation", "C3", "0 以下にしてください"],
  ]);
});

test("行のルールの設定の誤り", () => {
  const { issues } = compileRules(term, [
    { column: "EndDate", min: { column: "Nope" } },
    { column: "EndDate", min: { column: "Price" } },
    { column: "Price", max: 0, when: { column: "Kind" } },
    { column: "Price", max: 0, when: { column: "Kind", equals: "9", x: 1 } },
    { column: "Price", max: 0, when: { column: "Qty", equals: "abc" } },
    { column: "Qty", min: { column: "Price" } },
  ]);
  assert.deepEqual(issues.map((i) => i.message), [
    '業務ルール 1 番目: min の列 "Nope" は term にありません',
    "業務ルール 2 番目: min の列 Price は EndDate と比べられる型ではありません",
    "業務ルール 3 番目: when には equals、oneOf、empty のどれか 1 つを書きます",
    "業務ルール 4 番目: when に知らない項目 x があります",
    "業務ルール 5 番目: when の値が列 Qty の型として読めません",
  ]);
});

/** describe と fetch だけを返す、HTTP を通さないつなぎ。 */
function fakeApi(desc: TableDescription, db: Record<string, Row>, seen: FetchRequest["columns"][] = []): PatchiriApi {
  return {
    targets: async () => ({ ok: true, v: 1, targets: [{ target: desc.target, table: desc.table, access: desc.access }] }),
    describe: async () => desc,
    fetch: async (req) => {
      seen.push(req.columns);
      return { ok: true, v: 1, target: req.target, rows: req.keys.map((k, index) => (db[String(k.Code)] ? { index, found: true, values: db[String(k.Code)]! } : { index, found: false })) };
    },
    apply: async () => ({ ok: false, v: 1, error: { code: "x", message: "x" } }),
  };
}

test("prepare: サーバのルールは外せず、手元のルールはその上に足す。HTTP を通さないつなぎも渡せる", async () => {
  const desc: TableDescription = { ...term, rules: [{ column: "Price", greaterThan: 0 }, { column: "EndDate", min: { column: "StartDate" } }] };
  const seen: FetchRequest["columns"][] = [];
  const api = fakeApi(desc, { A: { Code: "A", Price: "10.00", StartDate: "2024-04-01", EndDate: "2024-04-30" } }, seen);
  const r = await prepare(api, "term", sheet([["Code", "Price", "EndDate"], ["A", "0", "2024-05-31"]]), { rules: { targets: { term: [{ column: "Price", max: 100 }] } } });
  assert.deepEqual(r.issues.map((i) => i.message), ["0 より大きくしてください"]);
  const r2 = await prepare(api, "term", sheet([["Code", "Price"], ["A", "200"]]), { rules: { targets: { term: [{ column: "Price", max: 100 }] } } });
  assert.deepEqual(r2.issues.map((i) => i.message), ["100 以下にしてください"]);
  const r3 = await prepare(api, "term", sheet([["Code", "EndDate"], ["A", "2024-03-01"]]));
  assert.deepEqual(r3.issues.map((i) => [i.cell, i.message]), [["B2", "StartDate（2024-04-01） 以上にしてください"]]);
  assert.deepEqual(seen.at(-1), ["EndDate", "StartDate"]);
  const bad = await prepare(fakeApi({ ...term, rules: [{ column: "Nope" }] }, {}), "term", sheet([["Code", "Price"], ["A", "1"]]));
  assert.deepEqual(bad.issues.map((i) => i.message), ["サーバの業務ルール 1 番目: 列 Nope は term にありません"]);
});

test("計画の指紋", () => {
  assert.equal(sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex(new TextEncoder().encode("a".repeat(1000))), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  const v = validate(term, sheet([["Code", "Price"], ["A", "130"]]));
  const d = diff(term, v, [{ index: 0, found: true, values: { Code: "A", Price: "120.00" } }]);
  const plan = buildPlan(d, "x.xlsx", { requestId: "req-00000001", note: "承認 #1" });
  assert.match(plan.digest!, /^[0-9a-f]{64}$/);
  assert.equal(plan.digest, planDigest({ requestId: "req-00000001", changes: [{ target: "term", rows: [{ op: "update", key: { Code: "A" }, before: { Price: "120.00" }, after: { Price: "130.00" } }] }] }));
  assert.equal(verifyPlan(plan), true);
  assert.equal(verifyPlan({ ...plan, request: { ...plan.request, mode: "execute", note: "別のメモ" } }), true);
  const tampered = structuredClone(plan);
  tampered.request.changes[0]!.rows[0]!.after.Price = "1300.00";
  assert.equal(verifyPlan(tampered), false);
  assert.equal(verifyPlan({ request: plan.request }), null);
});
