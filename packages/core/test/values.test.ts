import { test } from "node:test";
import assert from "node:assert/strict";
import { checkValue, sameColumnValue, sameValue, type ColumnDef } from "../src/index.js";

const col = (c: Partial<ColumnDef>): ColumnDef => ({ name: "c", type: "string", dbType: "varchar(10)", nullable: true, updatable: true, ...c });

test("文字列の桁数は文字数で数える", () => {
  const c = col({ maxLength: 3 });
  assert.equal(checkValue(c, "あいう"), null);
  assert.match(checkValue(c, "あいうえ")!, /3 文字を超えています/);
  assert.equal(checkValue(col({ maxLength: -1 }), "x".repeat(10000)), null);
});

test("NOT NULL", () => {
  assert.match(checkValue(col({ nullable: false }), null)!, /必須/);
  assert.equal(checkValue(col({ nullable: true }), null), null);
});

test("decimal の精度と桁", () => {
  const c = col({ type: "decimal", dbType: "decimal(9,2)", precision: 9, scale: 2 });
  assert.equal(checkValue(c, "1234567.89"), null);
  assert.equal(checkValue(c, "120.500"), null);
  assert.match(checkValue(c, "1.234")!, /小数は 2 桁/);
  assert.match(checkValue(c, "12345678")!, /整数部は 7 桁/);
  assert.match(checkValue(c, 120 as unknown as string)!, /数値ではありません/);
  assert.match(checkValue(c, "1e3")!, /数値ではありません/);
});

test("整数の範囲は dbType で決まる", () => {
  assert.match(checkValue(col({ type: "integer", dbType: "tinyint" }), 256)!, /範囲外/);
  assert.equal(checkValue(col({ type: "integer", dbType: "int" }), 256), null);
  assert.match(checkValue(col({ type: "integer", dbType: "int" }), 1.5)!, /整数ではありません/);
  assert.match(checkValue(col({ type: "bigint", dbType: "bigint" }), "9223372036854775808")!, /範囲外/);
});

test("日付と日時", () => {
  const d = col({ type: "date", dbType: "date" });
  assert.equal(checkValue(d, "2024-02-29"), null);
  assert.ok(checkValue(d, "2023-02-29"));
  assert.ok(checkValue(d, "2026/10/17"));
  const dt = col({ type: "datetime", dbType: "datetime2(3)", scale: 3 });
  assert.equal(checkValue(dt, "2026-10-17T09:30:00.123"), null);
  assert.match(checkValue(dt, "2026-10-17T09:30:00.1234")!, /3 桁まで/);
  assert.ok(checkValue(dt, "2026-10-17 09:30:00"));
});

test("型に沿った比較", () => {
  assert.ok(sameValue("decimal", "120", "120.00"));
  assert.ok(sameValue("decimal", "-0.0", "0"));
  assert.ok(!sameValue("decimal", "120", "120.01"));
  assert.ok(sameValue("datetime", "2026-10-17T09:30:00", "2026-10-17T09:30:00.000"));
  assert.ok(sameValue("string", null, null));
  assert.ok(!sameValue("string", null, ""));
  assert.ok(!sameValue("string", "a", "A"));
});

test("char / nchar は末尾の空白を見ない", () => {
  assert.ok(sameColumnValue({ type: "string", dbType: "char(4)" }, "C1  ", "C1"));
  assert.ok(sameColumnValue({ type: "string", dbType: "nchar(4)" }, "C1  ", "C1"));
  assert.ok(!sameColumnValue({ type: "string", dbType: "varchar(4)" }, "C1  ", "C1"));
  assert.ok(sameColumnValue({ type: "decimal", dbType: "decimal(9,2)" }, "1.0", "1"));
});

test("空文字が NULL になる列では、空文字は値の形として通さない", () => {
  const c = col({ dbType: "VARCHAR2(20 BYTE)", emptyIsNull: true });
  assert.match(checkValue(c, "")!, /空文字は NULL になります/);
  assert.equal(checkValue(c, " "), null);
  assert.equal(checkValue(col({}), ""), null);
});

test("日時の秒の小数は 9 桁まで読み、桁は列の scale で見る（Oracle の TIMESTAMP(9)）", () => {
  assert.equal(checkValue(col({ type: "datetime", dbType: "TIMESTAMP(9)", scale: 9 }), "2026-10-17T09:30:00.123456789"), null);
  assert.match(checkValue(col({ type: "datetime", dbType: "TIMESTAMP(6)", scale: 6 }), "2026-10-17T09:30:00.123456789")!, /6 桁まで/);
  assert.match(checkValue(col({ type: "datetime", dbType: "DATE", scale: 0 }), "2026-10-17T09:30:00.5")!, /0 桁まで/);
  assert.equal(checkValue(col({ type: "datetime", dbType: "DATE", scale: 0 }), "2026-10-17T09:30:00.000"), null);
});
