// SQL Server の方言のうち、DB につながずに確かめられるところ（人が読む SQL）。

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ColumnMeta, ScriptUpdate, TableMeta } from "../src/index.js";
import { SqlServerDialect } from "../src/index.js";

const column = (c: Partial<ColumnMeta> & { baseType: string; sqlType: string }) => ({ name: "C", type: "string", dbType: c.sqlType, nullable: true, ...c });

test("人が読む SQL: 反映用は 1 行に当たらなければ THROW で全部戻し、戻し用は止めずに続ける", () => {
  const meta = {
    table: "dbo.M_Item",
    columns: [
      column({ name: "Code", baseType: "varchar", sqlType: "varchar(10)", nullable: false }),
      column({ name: "Name", baseType: "nvarchar", sqlType: "nvarchar(50)" }),
      column({ name: "Price", type: "decimal", baseType: "decimal", sqlType: "decimal(9,2)" }),
    ],
    primaryKey: ["Code"],
    foreignKeys: [],
  } as TableMeta;
  const d = new SqlServerDialect({ dialect: "sqlserver", server: "x", database: "x" });
  const updates: ScriptUpdate[] = [
    { key: { Code: "A1" }, set: { Price: "130.00" }, expect: { Price: "120.00" } },
    { key: { Code: "O'1" }, set: { Name: "ペン" }, expect: { Name: null } },
  ];
  assert.equal(
    d.renderScript(meta, "-- patchiri x", updates, "apply"),
    [
      "-- patchiri x",
      "-- 1 つのトランザクションで流す。どれかの行が見つからないか値が変わっていたら、何も反映せずに止まる（エラー 50001）。",
      "SET XACT_ABORT ON;",
      "BEGIN TRANSACTION;",
      "UPDATE [dbo].[M_Item] SET [Price] = 130.00 WHERE [Code] = N'A1' AND [Price] = 120.00;",
      "IF @@ROWCOUNT <> 1 THROW 50001, N'patchiri: 行が見つからないか、値が変わっています（Code=A1）。何も反映していません', 1;",
      "UPDATE [dbo].[M_Item] SET [Name] = N'ペン' WHERE [Code] = N'O''1' AND [Name] IS NULL;",
      "IF @@ROWCOUNT <> 1 THROW 50001, N'patchiri: 行が見つからないか、値が変わっています（Code=O''1）。何も反映していません', 1;",
      "COMMIT;",
      "",
    ].join("\n"),
  );
  const undo = d.renderScript(meta, "-- patchiri x の戻し", updates, "undo");
  assert.doesNotMatch(undo, /THROW/);
  assert.match(undo, /^-- 今の値が patchiri で入れた値のままの行だけ戻す。/m);
});
