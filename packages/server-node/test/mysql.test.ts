// MySQL の方言のうち、DB につながずに確かめられるところ（名前の読み方、型の対応、人が読む SQL）。

import { test } from "node:test";
import assert from "node:assert/strict";
import type { TableMeta } from "../src/index.js";
import { MySqlDialect, splitMySqlName } from "../src/index.js";
import { mysqlColumn, quoteString, type MyDictColumn } from "../src/mysql.js";

const dict = (d: Partial<MyDictColumn>): MyDictColumn => ({
  name: "c",
  dataType: "varchar",
  columnType: "varchar(10)",
  chars: 10,
  bytes: 40,
  precision: null,
  scale: null,
  fsp: null,
  nullable: true,
  default: null,
  extra: "",
  charset: "utf8mb4",
  ...d,
});

test("テーブル名: `` で囲める。データベースは省ける", () => {
  assert.deepEqual(splitMySqlName("m_product"), [undefined, "m_product"]);
  assert.deepEqual(splitMySqlName("app.M_Product"), ["app", "M_Product"]);
  assert.deepEqual(splitMySqlName("`my app`.`a``b`"), ["my app", "a`b"]);
  assert.throws(() => splitMySqlName("a.b.c"));
});

test("型の対応: 文字列の桁と文字コード、整数の範囲、decimal、日時", () => {
  assert.deepEqual(mysqlColumn(dict({})), { name: "c", type: "string", dbType: "varchar(10)", nullable: true, baseType: "varchar", unsigned: false, maxLength: 10, charset: "utf8mb4", encoding: "utf-8" });
  assert.equal(mysqlColumn(dict({ charset: "cp932" })).encoding, "shift_jis");
  assert.equal(mysqlColumn(dict({ charset: "swe7" })).encoding, undefined);
  const text = mysqlColumn(dict({ dataType: "text", columnType: "text", chars: 65535, bytes: 65535 }));
  assert.deepEqual([text.dbType, text.maxLength, text.maxBytes], ["text", -1, 65535]);
  const int = (dataType: string, columnType: string) => mysqlColumn(dict({ dataType, columnType, charset: null }));
  assert.deepEqual([int("tinyint", "tinyint(4)").dbType, int("tinyint", "tinyint(4)").min, int("tinyint", "tinyint(4)").max], ["tinyint", -128, 127]);
  assert.deepEqual([int("tinyint", "tinyint(1)").type], ["integer"]);
  assert.deepEqual([int("int", "int(10) unsigned").dbType, int("int", "int(10) unsigned").max], ["int unsigned", 4294967295]);
  assert.deepEqual([int("bigint", "bigint").type, int("bigint", "bigint").max], ["bigint", undefined]);
  assert.deepEqual([int("bigint", "bigint unsigned").min, int("bigint", "bigint unsigned").max], ["0", "18446744073709551615"]);
  const dec = mysqlColumn(dict({ dataType: "decimal", columnType: "decimal(9,2)", precision: 9, scale: 2, charset: null }));
  assert.deepEqual([dec.type, dec.dbType, dec.precision, dec.scale], ["decimal", "decimal(9,2)", 9, 2]);
  const dt = mysqlColumn(dict({ dataType: "datetime", columnType: "datetime(3)", fsp: 3, charset: null }));
  assert.deepEqual([dt.type, dt.dbType, dt.scale], ["datetime", "datetime(3)", 3]);
  assert.equal(mysqlColumn(dict({ dataType: "timestamp", columnType: "timestamp", fsp: 0, charset: null })).type, "other");
  assert.equal(mysqlColumn(dict({ dataType: "bit", columnType: "bit(1)", precision: 1, charset: null })).type, "boolean");
  assert.equal(mysqlColumn(dict({ dataType: "bit", columnType: "bit(8)", precision: 8, charset: null })).type, "other");
  const id = mysqlColumn(dict({ dataType: "int", columnType: "int", charset: null, extra: "auto_increment" }));
  assert.deepEqual([id.identity, id.hasDefault], [true, undefined]);
  assert.equal(mysqlColumn(dict({ extra: "VIRTUAL GENERATED" })).computed, true);
  // MariaDB は DEFAULT NULL を 'NULL' と出す。
  assert.equal(mysqlColumn(dict({ default: "NULL" })).hasDefault, undefined);
});

test("文字列のリテラル: \\ を含む値は 16 進で書く（NO_BACKSLASH_ESCAPES でも同じ値になる）", () => {
  assert.equal(quoteString("O'Reilly"), "'O''Reilly'");
  assert.equal(quoteString("a\\b"), "_utf8mb4 X'615C62'");
});

test("人が読む SQL: 先に全部の行をロックして数え、1 行でも合わなければどの UPDATE も当たらない", async () => {
  const meta = {
    table: "app.m_item",
    schema: "app",
    name: "m_item",
    columns: [
      mysqlColumn(dict({ name: "code", dataType: "char", columnType: "char(6)", chars: 6, nullable: false })),
      mysqlColumn(dict({ name: "name", columnType: "varchar(50)", chars: 50 })),
      mysqlColumn(dict({ name: "price", dataType: "decimal", columnType: "decimal(9,2)", precision: 9, scale: 2, charset: null })),
    ],
    primaryKey: ["code"],
    foreignKeys: [],
  } as TableMeta;
  const d = new MySqlDialect({ dialect: "mysql", host: "localhost", database: "app", user: "x" });
  try {
    const apply = d.renderScript(meta, "-- patchiri x", [{ key: { code: "A1" }, set: { name: "ペン", price: "130.00" }, expect: { name: "ﾍﾟﾝ", price: null } }], "apply");
    const where = "`code` = 'A1' AND CAST(CONVERT(`name` USING utf8mb4) AS BINARY) = CAST(CONVERT('ﾍﾟﾝ' USING utf8mb4) AS BINARY) AND `price` IS NULL";
    assert.equal(
      apply,
      [
        "-- patchiri x",
        "-- 1 つのトランザクションで流す。先に全部の行をロックして確かめ、1 行でも見つからないか値が変わっていたら、何も反映しない（最後の行に結果が出る）。",
        "-- mysql コマンド、MySQL Workbench、DBeaver、HeidiSQL などで流せる素の SQL。エラーが出たらそこで止める（飛ばして続けると、最後の COMMIT で一部の行だけ反映される）。",
        "SET NAMES utf8mb4;",
        "SET @patchiri_ok = 1, @patchiri_ng = NULL;",
        "START TRANSACTION;",
        `SELECT COUNT(*) INTO @patchiri_n FROM \`app\`.\`m_item\` WHERE ${where} FOR UPDATE;`,
        "SET @patchiri_ok = @patchiri_ok AND @patchiri_n = 1, @patchiri_ng = IF(@patchiri_n = 1, @patchiri_ng, CONCAT_WS(', ', @patchiri_ng, 'code=A1'));",
        `UPDATE \`app\`.\`m_item\` SET \`name\` = 'ペン', \`price\` = 130.00 WHERE ${where} AND @patchiri_ok = 1;`,
        "COMMIT;",
        "SELECT CONVERT(IF(@patchiri_ok = 1, 'patchiri: 1 行を反映しました', CONCAT('patchiri: 行が見つからないか、値が変わっています（', @patchiri_ng, '）。何も反映していません')) USING utf8mb4) AS `patchiri`;",
        "",
      ].join("\n"),
    );
    // CHAR は両方の末尾の空白を落として比べる。
    const undo = d.renderScript(meta, "-- patchiri x の戻し", [{ key: { code: "A1" }, set: { code: "A1" }, expect: { code: "B1 " } }], "undo");
    assert.match(undo, /CAST\(RTRIM\(CONVERT\(`code` USING utf8mb4\)\) AS BINARY\) = CAST\(RTRIM\(CONVERT\('B1 ' USING utf8mb4\)\) AS BINARY\)/);
    assert.match(undo, /SET @patchiri_done = @patchiri_done \+ @patchiri_n, @patchiri_ng = /);
    assert.match(undo, /' \/ 1 行を戻しました'/);
  } finally {
    await d.close();
  }
});
