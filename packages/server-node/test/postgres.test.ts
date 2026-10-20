// PostgreSQL の方言のうち、DB につながずに確かめられるところ（型の対応、人が読む SQL）。

import { test } from "node:test";
import assert from "node:assert/strict";
import type { TableMeta } from "../src/index.js";
import { PostgresDialect } from "../src/index.js";
import { pgColumn, quoteString, type PgDictColumn } from "../src/postgres.js";

const dict = (d: Partial<PgDictColumn>): PgDictColumn => ({
  name: "c",
  typeName: "varchar",
  typeKind: "b",
  formatted: "character varying(10)",
  qualifiedType: "pg_catalog.varchar",
  nullable: true,
  hasDefault: false,
  identity: false,
  generated: false,
  ...d,
});

const noDb = { withSession: async () => Promise.reject(new Error("つながない")), close: async () => undefined };

test("型の対応: 文字列の桁と文字コード、numeric、日時、enum", () => {
  assert.deepEqual(pgColumn(dict({}), "UTF8"), { name: "c", type: "string", dbType: "varchar(10)", nullable: true, baseType: "varchar", castType: "text", maxLength: 10, encoding: "utf-8" });
  assert.deepEqual([pgColumn(dict({ formatted: "character varying" })).dbType, pgColumn(dict({ formatted: "character varying" })).maxLength], ["varchar", -1]);
  const ch = pgColumn(dict({ typeName: "bpchar", formatted: "character(6)" }), "EUC_JP");
  assert.deepEqual([ch.dbType, ch.castType, ch.maxLength, ch.encoding], ["char(6)", "bpchar", 6, "euc-jp"]);
  assert.equal(pgColumn(dict({ typeName: "text", formatted: "text" }), "SQL_ASCII").encoding, undefined);
  const n = (formatted: string) => pgColumn(dict({ typeName: "numeric", formatted }));
  assert.deepEqual([n("numeric(9,2)").type, n("numeric(9,2)").dbType, n("numeric(9,2)").precision, n("numeric(9,2)").scale], ["decimal", "numeric(9,2)", 9, 2]);
  assert.deepEqual([n("numeric").dbType, n("numeric").precision], ["numeric", undefined]);
  // 負の scale は丸められて戻し SQL が合わなくなるので扱わない。
  assert.equal(n("numeric(5,-2)").type, "other");
  const ts = pgColumn(dict({ typeName: "timestamp", formatted: "timestamp(3) without time zone" }));
  assert.deepEqual([ts.type, ts.dbType, ts.scale], ["datetime", "timestamp(3)", 3]);
  assert.deepEqual([pgColumn(dict({ typeName: "timestamp", formatted: "timestamp without time zone" })).scale], [6]);
  assert.equal(pgColumn(dict({ typeName: "timestamptz", formatted: "timestamp with time zone" })).type, "other");
  assert.deepEqual([pgColumn(dict({ typeName: "int2", formatted: "smallint" })).type, pgColumn(dict({ typeName: "int8", formatted: "bigint" })).type], ["integer", "bigint"]);
  assert.equal(pgColumn(dict({ typeName: "uuid", formatted: "uuid" })).type, "other");
  const e = pgColumn(dict({ typeName: "status", typeKind: "e", formatted: "status", qualifiedType: "app.status" }), "UTF8");
  assert.deepEqual([e.type, e.dbType, e.castType], ["string", "status", "app.status"]);
  const id = pgColumn(dict({ typeName: "int4", formatted: "integer", identity: true, hasDefault: true }));
  assert.deepEqual([id.identity, id.hasDefault], [true, undefined]);
});

test("文字列のリテラル: \\ を含む値は E'' で書く", () => {
  assert.equal(quoteString("O'Reilly"), "'O''Reilly'");
  assert.equal(quoteString("a\\b'c"), "E'a\\\\b''c'");
});

test("人が読む SQL: DO ブロック 1 つ。値に区切りが入っていたら別の区切りにする", () => {
  const meta = {
    table: "app.m_item",
    schema: "app",
    name: "m_item",
    columns: [
      pgColumn(dict({ name: "code", typeName: "bpchar", formatted: "character(6)", nullable: false }), "UTF8"),
      pgColumn(dict({ name: "name", typeName: "text", formatted: "text" }), "UTF8"),
      pgColumn(dict({ name: "price", typeName: "numeric", formatted: "numeric(9,2)" })),
      pgColumn(dict({ name: "ratio", typeName: "float4", formatted: "real" })),
      pgColumn(dict({ name: "released", typeName: "date", formatted: "date" })),
    ],
    primaryKey: ["code"],
    foreignKeys: [],
  } as TableMeta;
  const d = new PostgresDialect(noDb);
  const apply = d.renderScript(meta, "-- harikit x", [{ key: { code: "A1" }, set: { name: "ペン $harikit$", price: "130.00", ratio: 0.1 }, expect: { name: "ペン", price: null, ratio: 0.5 } }], "apply");
  assert.equal(
    apply,
    [
      "-- harikit x",
      "-- 1 つのトランザクションで流す。どれかの行が見つからないか値が変わっていたら、何も反映せずに止まる（harikit: で始まるエラー）。",
      "-- psql、pgAdmin、DBeaver などで流せる素の SQL（DO ブロック 1 つ）。自動コミットを切っているときは、流した後に COMMIT する。",
      "SET client_encoding = 'UTF8';",
      "DO $harikit_1$",
      "#variable_conflict use_column",
      "DECLARE",
      "  harikit_rows integer;",
      "BEGIN",
      `  UPDATE "app"."m_item" SET "name" = 'ペン $harikit$', "price" = 130.00, "ratio" = CAST(0.1 AS real) WHERE "code" = 'A1' AND "name" COLLATE "C" = 'ペン' AND "price" IS NULL AND "ratio" = CAST(0.5 AS real);`,
      "  GET DIAGNOSTICS harikit_rows = ROW_COUNT;",
      "  IF harikit_rows <> 1 THEN RAISE EXCEPTION USING MESSAGE = 'harikit: 行が見つからないか、値が変わっています（code=A1）。何も反映していません'; END IF;",
      "END",
      "$harikit_1$;",
      "",
    ].join("\n"),
  );
  const undo = d.renderScript(meta, "-- harikit x の戻し", [{ key: { code: "A'1" }, set: { released: "2024-04-01" }, expect: { released: null } }], "undo");
  assert.match(undo, /^DO \$harikit\$\n#variable_conflict use_column\nDECLARE\n {2}harikit_rows integer;\n {2}harikit_done integer := 0;\nBEGIN$/m);
  assert.match(undo, /SET "released" = DATE '2024-04-01' WHERE "code" = 'A''1' AND "released" IS NULL;/);
  // メッセージは書式（%）として読ませない。
  assert.match(undo, /ELSE RAISE NOTICE USING MESSAGE = 'harikit: 戻していない行（後から別の更新が入った）: code=A''1'; END IF;/);
  assert.match(undo, /RAISE NOTICE 'harikit: % \/ 1 行を戻しました', harikit_done;\nEND\n\$harikit\$;\n$/);
});
