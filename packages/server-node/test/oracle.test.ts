// Oracle の方言のうち、DB につながずに確かめられるところ（名前の読み方、型の対応、人が読む SQL）。

import { test } from "node:test";
import assert from "node:assert/strict";
import type { TableMeta } from "../src/index.js";
import { OracleDialect, splitOracleName } from "../src/index.js";
import { decimalText, oracleColumn, type DictColumn } from "../src/oracle.js";

const dict = (d: Partial<DictColumn>): DictColumn => ({
  name: "C",
  dataType: "VARCHAR2",
  dataLength: 10,
  charLength: 10,
  charUsed: "B",
  precision: null,
  scale: null,
  nullable: true,
  defaultLength: null,
  virtual: false,
  identity: false,
  ...d,
});

test("テーブル名: \"\" で囲まない名前は大文字、スキーマは省ける", () => {
  assert.deepEqual(splitOracleName("m_product"), [undefined, "M_PRODUCT"]);
  assert.deepEqual(splitOracleName("app.M_Product"), ["APP", "M_PRODUCT"]);
  assert.deepEqual(splitOracleName('"App"."Mixed Name"'), ["App", "Mixed Name"]);
  assert.throws(() => splitOracleName("a.b.c"));
  assert.throws(() => splitOracleName("t@dblink"));
});

test("型の対応: 文字列の桁と文字コード、NUMBER、DATE、TIMESTAMP", () => {
  const sjis = { db: "JA16SJISTILDE", nchar: "AL16UTF16" };
  assert.deepEqual(oracleColumn(dict({ dataType: "VARCHAR2", dataLength: 20, charLength: 20 }), sjis), {
    name: "C", type: "string", dbType: "VARCHAR2(20 BYTE)", nullable: true, baseType: "VARCHAR2", encoding: "shift_jis", maxLength: 20, maxBytes: 20, emptyIsNull: true,
  });
  const charSem = oracleColumn(dict({ dataType: "CHAR", dataLength: 12, charLength: 6, charUsed: "C" }), sjis);
  assert.deepEqual([charSem.dbType, charSem.castType, charSem.maxLength, charSem.maxBytes], ["CHAR(6 CHAR)", "CHAR(6 CHAR)", 6, 12]);
  const nv = oracleColumn(dict({ dataType: "NVARCHAR2", dataLength: 100, charLength: 50, charUsed: "C" }), sjis);
  assert.deepEqual([nv.dbType, nv.encoding, nv.maxLength, nv.maxBytes], ["NVARCHAR2(50)", "utf-16le", 50, 100]);
  assert.equal(oracleColumn(dict({}), { db: "US7ASCII" }).encoding, undefined);

  const n = (precision: number | null, scale: number | null) => oracleColumn(dict({ dataType: "NUMBER", dataLength: 22, precision, scale }), sjis);
  assert.deepEqual([n(9, 2).type, n(9, 2).dbType, n(9, 2).precision, n(9, 2).scale], ["decimal", "NUMBER(9,2)", 9, 2]);
  assert.deepEqual([n(null, 0).dbType, n(null, 0).precision, n(null, 0).scale], ["NUMBER(*,0)", 38, 0]);
  assert.deepEqual([n(null, null).dbType, n(null, null).precision], ["NUMBER", undefined]);
  // 負の scale は丸められて戻し SQL が合わなくなるので扱わない。
  assert.equal(n(5, -2).type, "other");

  const date = oracleColumn(dict({ dataType: "DATE", dataLength: 7 }), sjis);
  assert.deepEqual([date.type, date.scale], ["datetime", 0]);
  const ts = oracleColumn(dict({ dataType: "TIMESTAMP(3)", dataLength: 11, scale: 3 }), sjis);
  assert.deepEqual([ts.type, ts.dbType, ts.scale], ["datetime", "TIMESTAMP(3)", 3]);
  assert.equal(oracleColumn(dict({ dataType: "TIMESTAMP(6) WITH TIME ZONE", scale: 6 }), sjis).type, "other");
  assert.equal(oracleColumn(dict({ dataType: "CLOB" }), sjis).type, "other");
  assert.equal(oracleColumn(dict({ dataType: "BINARY_DOUBLE" }), sjis).type, "float");
  const id = oracleColumn(dict({ dataType: "NUMBER", identity: true, defaultLength: 32 }), sjis);
  assert.deepEqual([id.identity, id.hasDefault], [true, undefined]);
});

test("数値の文字列: 先頭の 0 を足し、scale まで 0 を埋める", () => {
  assert.equal(decimalText(".5"), "0.5");
  assert.equal(decimalText("-.5", 2), "-0.50");
  assert.equal(decimalText("120", 2), "120.00");
  assert.equal(decimalText("12345678901234567890.123456789"), "12345678901234567890.123456789");
});

test("人が読む SQL: PL/SQL のブロックにし、N'' で書けない字は UNISTR にする", () => {
  const sjis = { db: "JA16SJIS", nchar: "AL16UTF16" };
  const meta = {
    table: "APP.M_ITEM",
    owner: "APP",
    name: "M_ITEM",
    collate: true,
    dbEncoding: "shift_jis",
    columns: [
      oracleColumn(dict({ name: "CODE", dataType: "CHAR", dataLength: 6, charLength: 6, nullable: false }), sjis),
      oracleColumn(dict({ name: "NAME", dataType: "NVARCHAR2", dataLength: 40, charLength: 20, charUsed: "C" }), sjis),
      oracleColumn(dict({ name: "PRICE", dataType: "NUMBER", dataLength: 22, precision: 9, scale: 2 }), sjis),
      oracleColumn(dict({ name: "RELEASED", dataType: "DATE", dataLength: 7 }), sjis),
    ],
    primaryKey: ["CODE"],
    foreignKeys: [],
  } as TableMeta;
  const d = new OracleDialect({ dialect: "oracle", connectString: "x", user: "x" });
  const updates = [{ key: { CODE: "A1" }, set: { NAME: "𠮷野家\\'", PRICE: "130.00" }, expect: { NAME: "ペン", PRICE: null } }];
  const apply = d.renderScript(meta, "-- patchiri x", updates, "apply");
  assert.equal(
    apply,
    [
      "-- patchiri x",
      "-- 1 つのトランザクションで流す。どれかの行が見つからないか値が変わっていたら、何も反映せずに止まる（ORA-20001）。",
      "-- SQL*Plus、SQLcl、SQL Developer で流せる形（値の & を置き換えないよう SET DEFINE OFF にしてある）。",
      "-- キーを大文字小文字を区別して比べるよう、このセッションの NLS_COMP / NLS_SORT を BINARY にする（流した後もこのセッションに残る）。",
      "SET DEFINE OFF",
      "ALTER SESSION SET NLS_COMP = 'BINARY' NLS_SORT = 'BINARY';",
      "BEGIN",
      `  UPDATE "APP"."M_ITEM" SET "NAME" = UNISTR('\\D842\\DFB7野家\\005C'''), "PRICE" = 130.00 WHERE "CODE" = 'A1' AND "NAME" COLLATE BINARY = N'ペン' AND "PRICE" IS NULL;`,
      "  IF SQL%ROWCOUNT <> 1 THEN RAISE_APPLICATION_ERROR(-20001, 'patchiri: 行が見つからないか、値が変わっています（CODE=A1）。何も反映していません'); END IF;",
      "  COMMIT;",
      "EXCEPTION",
      "  WHEN OTHERS THEN",
      "    ROLLBACK;",
      "    RAISE;",
      "END;",
      "/",
      "",
    ].join("\n"),
  );
  const undo = d.renderScript(meta, "-- patchiri x の戻し", [{ key: { CODE: "A1" }, set: { RELEASED: "2024-04-01T00:00:00.000" }, expect: { RELEASED: null } }], "undo");
  assert.match(undo, /^SET DEFINE OFF\nALTER SESSION SET NLS_COMP = 'BINARY' NLS_SORT = 'BINARY';\nSET SERVEROUTPUT ON\nDECLARE\n {2}n PLS_INTEGER := 0;\nBEGIN$/m);
  assert.match(undo, /SET "RELEASED" = TO_DATE\('2024-04-01 00:00:00', 'YYYY-MM-DD HH24:MI:SS'\) WHERE "CODE" = 'A1' AND "RELEASED" IS NULL;/);
  assert.match(undo, /IF SQL%ROWCOUNT = 1 THEN n := n \+ 1; ELSE DBMS_OUTPUT.PUT_LINE\('patchiri: 戻していない行（後から別の更新が入った）: CODE=A1'\); END IF;/);
  assert.match(undo, /DBMS_OUTPUT.PUT_LINE\('patchiri: ' \|\| n \|\| ' \/ 1 行を戻しました'\);/);
});

test("人が読む SQL: 改行は値の中に書かず、長い値は行を分ける（SQL*Plus が / や # で始まる行をコマンドとして読まないように）", () => {
  const charsets = { db: "AL32UTF8", nchar: "AL16UTF16" };
  const meta = {
    table: "APP.T",
    owner: "APP",
    name: "T",
    collate: true,
    dbEncoding: "utf-8",
    columns: [
      oracleColumn(dict({ name: "CD", dataType: "CHAR", dataLength: 6, charLength: 6, nullable: false }), charsets),
      oracleColumn(dict({ name: "NOTE", dataType: "VARCHAR2", dataLength: 400, charLength: 400 }), charsets),
      oracleColumn(dict({ name: "KANA", dataType: "NCHAR", dataLength: 8, charLength: 4, charUsed: "C" }), charsets),
    ],
    primaryKey: ["CD"],
    foreignKeys: [],
  } as TableMeta;
  const d = new OracleDialect({ dialect: "oracle", connectString: "x", user: "x" });
  const long = "あ".repeat(150);
  const script = d.renderScript(meta, "-- patchiri x", [{ key: { CD: "A\n1" }, set: { NOTE: "a\r\n/\n#host rm x\n.\nb", KANA: "ア\nイ" }, expect: { NOTE: long, KANA: null } }], "apply");
  const lines = script.split("\n");
  // 最後の / のほかに、/ や . だけの行、# で始まる行がない。
  assert.deepEqual(lines.filter((l) => /^\s*[/.]\s*$/.test(l) || /^\s*#/.test(l)), ["/"]);
  assert.ok(lines.every((l) => l.length < 1000));
  assert.match(script, /\n {2}UPDATE "APP"."T"\n {5}SET "NOTE" = 'a'\n {6}\|\| CHR\(13\)\n {6}\|\| CHR\(10\)\n {6}\|\| '\/'\n/);
  assert.match(script, /"KANA" = CAST\(N'ア'\n {6}\|\| UNISTR\('\\000A'\)\n {6}\|\| N'イ' AS NCHAR\(4\)\)/);
  assert.match(script, /\n {3}WHERE "CD" = CAST\('A'\n {6}\|\| CHR\(10\)\n {6}\|\| '1' AS CHAR\(6 BYTE\)\)\n {5}AND "NOTE" COLLATE BINARY = '(あ){100}'\n {6}\|\| '(あ){50}'\n {5}AND "KANA" IS NULL;/);
  // メッセージのキーの改行は空白にする。
  assert.match(script, /（CD=A 1）/);
});

