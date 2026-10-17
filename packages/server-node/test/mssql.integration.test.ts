// 実際の SQL Server で通すテスト。HARIKIT_TEST_MSSQL があるときだけ動く。
//   HARIKIT_TEST_MSSQL='{"server":"localhost","user":"sa","password":"..."}' npm test

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sql from "mssql";
import { buildApplyRequest, HarikitClient, prepare, type ApplyResponse, type Failure } from "@harikit/core";
import { startServer, type RunningServer, type ServerConfig } from "../src/index.js";

const env = process.env.HARIKIT_TEST_MSSQL;
const skip = env ? false : "HARIKIT_TEST_MSSQL がないので飛ばす";
const conn = env ? (JSON.parse(env) as { server: string; port?: number; user: string; password: string }) : undefined;
const DB = "HarikitTest";

let admin: sql.ConnectionPool;
let server: RunningServer;
let client: HarikitClient;

const q = async (text: string) => (await admin.request().query(text)).recordset;

before(async () => {
  if (!conn) return;
  const base = { server: conn.server, port: conn.port ?? 1433, user: conn.user, password: conn.password, options: { encrypt: false, trustServerCertificate: true } };
  const master = await new sql.ConnectionPool({ ...base, database: "master" }).connect();
  // 既定の照合順序は日本語以外にしておき、列だけ Japanese_CI_AS の varchar を混ぜる（照合順序の違いで文字が崩れないか見る）。
  await master.request().query(`IF DB_ID('${DB}') IS NULL CREATE DATABASE ${DB} COLLATE SQL_Latin1_General_CP1_CI_AS`);
  await master.close();
  admin = await new sql.ConnectionPool({ ...base, database: DB }).connect();
  // 前の回のテーブルは別のバッチで消す（同じバッチだと古い定義で INSERT がコンパイルされる）。
  await q(`DROP TABLE IF EXISTS dbo.Item; DROP TABLE IF EXISTS dbo.Kind;`);
  await q(`CREATE TABLE dbo.Kind (KindCode varchar(4) NOT NULL PRIMARY KEY);
    CREATE TABLE dbo.Item (
      Code varchar(10) NOT NULL PRIMARY KEY,
      Name nvarchar(50) NOT NULL,
      KindCode varchar(4) NULL REFERENCES dbo.Kind (KindCode),
      Price decimal(9,2) NULL,
      Cost money NULL,
      Big bigint NULL,
      Qty smallint NULL,
      Active bit NOT NULL DEFAULT 1,
      Released date NULL,
      Stamp datetime2(3) NULL,
      Legacy datetime NULL,
      OpenAt time(0) NULL,
      Guid uniqueidentifier NULL,
      RowId int IDENTITY(1,1) NOT NULL,
      Memo varchar(20) COLLATE Japanese_CI_AS NULL,
      Grade char(3) NULL
    );
    INSERT INTO dbo.Kind VALUES ('K1'), ('K2');
    INSERT INTO dbo.Item (Code, Name, KindCode, Price, Cost, Big, Qty, Released, Stamp, Legacy, OpenAt, Memo, Grade) VALUES
      ('A001', N'ペン', 'K1', 120.00, 80.5, 9007199254740993, 5, '2024-04-01', '2026-10-17T09:30:00.123', '2026-10-17T09:30:00', '09:00', N'メモ', 'A'),
      ('A002', N'ノート', 'K1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);`);
  const config: ServerConfig = {
    listen: { port: 0 },
    database: { dialect: "sqlserver", server: conn.server, port: conn.port ?? 1433, database: DB, user: conn.user, password: conn.password, options: { encrypt: false, trustServerCertificate: true } },
    targets: {
      item: {
        table: "dbo.Item",
        access: "update",
        readable: ["Code", "Name", "KindCode", "Price", "Cost", "Big", "Qty", "Active", "Released", "Stamp", "Legacy", "OpenAt", "Guid", "RowId", "Memo", "Grade"],
        updatable: ["Name", "KindCode", "Price", "Cost", "Big", "Qty", "Active", "Released", "Stamp", "Legacy", "OpenAt", "Guid", "RowId", "Memo", "Grade"],
      },
      kind: { table: "Kind", access: "read", readable: ["KindCode"] },
    },
    logDir: await mkdtemp(join(tmpdir(), "harikit-log-")),
  };
  server = await startServer(config, { token: "test" });
  client = new HarikitClient({ baseUrl: server.url, token: "test" });
});

after(async () => {
  await server?.close();
  await admin?.close();
});

test("describe: 型、桁、主キー、外部キー、更新できない列", { skip }, async () => {
  const d = await client.describe("item");
  assert.deepEqual(d.key, ["Code"]);
  const col = (n: string) => d.columns.find((c) => c.name === n)!;
  assert.deepEqual({ ...col("Name") }, { name: "Name", type: "string", dbType: "nvarchar(50)", nullable: false, maxLength: 50, updatable: true });
  assert.deepEqual([col("Price").type, col("Price").precision, col("Price").scale], ["decimal", 9, 2]);
  assert.deepEqual([col("Cost").type, col("Cost").dbType], ["decimal", "money"]);
  assert.equal(col("Big").type, "bigint");
  assert.deepEqual([col("Stamp").type, col("Stamp").dbType], ["datetime", "datetime2(3)"]);
  assert.equal(col("Active").hasDefault, true);
  assert.deepEqual([col("Guid").type, col("Guid").updatable], ["other", false]);
  assert.deepEqual([col("RowId").identity, col("RowId").updatable], [true, false]);
  assert.equal(d.foreignKeys[0]!.referencedTarget, "kind");
});

test("fetch: 値は仕様の形で返り、キーは DB の照合順序で引く", { skip }, async () => {
  const res = await client.fetch({ target: "item", keys: [{ Code: "a001" }, { Code: "Z" }] });
  assert.equal(res.rows[1]!.found, false);
  const row = res.rows[0]!;
  assert.ok(row.found);
  const { Guid: _, ...values } = row.values;
  assert.deepEqual(values, {
    Code: "A001",
    Name: "ペン",
    KindCode: "K1",
    Price: "120.00",
    Cost: "80.5000",
    Big: "9007199254740993",
    Qty: 5,
    Active: true,
    Released: "2024-04-01",
    Stamp: "2026-10-17T09:30:00.123",
    Legacy: "2026-10-17T09:30:00",
    OpenAt: "09:00:00",
    RowId: 1,
    Memo: "メモ",
    Grade: "A  ",
  });
});

test("Excel 相当の取込から反映、衝突、戻しまで", { skip }, async () => {
  const sheet = {
    name: "s",
    rows: [
      ["Code", "Price", "Big", "Stamp", "Released", "KindCode", "OpenAt"],
      ["A001", 130, "9007199254740995", { kind: "date" as const, iso: "2026-10-18T08:00:00.000" }, "2024-04-02", "K2", "10:30"],
      ["A002", 99.9, null, null, null, "K1", null],
    ],
  };
  const p = await prepare(client, "item", sheet);
  assert.ok(p.ok, JSON.stringify(p.issues));
  assert.deepEqual(p.diff!.counts, { change: 2, same: 0, not_found: 0 });
  assert.deepEqual(p.diff!.rows[1]!.changes.map((c) => c.column), ["Price"]);

  const bad = await prepare(client, "item", { name: "s", rows: [["Code", "KindCode"], ["A001", "K9"]] });
  assert.deepEqual(bad.issues.map((i) => [i.cell, i.message]), [["B2", "dbo.Kind にありません"]]);

  // 差分を取った後に別の人が変えたら止まる。
  await q(`UPDATE dbo.Item SET Price = 121 WHERE Code = 'A001'`);
  const req = buildApplyRequest(p.diff!, { mode: "execute" });
  const conflict = (await client.apply(req)) as Failure;
  assert.equal(conflict.error.code, "conflict");
  assert.deepEqual(conflict.conflicts!.map((c) => [c.index, c.columns]), [[0, ["Price"]]]);
  assert.equal((await q(`SELECT Price FROM dbo.Item WHERE Code = 'A002'`))[0]!.Price, null);
  await q(`UPDATE dbo.Item SET Price = 120 WHERE Code = 'A001'`);

  const check = (await client.apply({ ...req, mode: "check" })) as ApplyResponse;
  assert.equal(check.ok, true);
  const done = (await client.apply(req)) as ApplyResponse;
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(done.results, [{ target: "item", updated: 2 }]);
  const [a] = await q(`SELECT CONVERT(varchar(30), Price) AS Price, CONVERT(varchar(20), Big) AS Big, CONVERT(varchar(30), Stamp, 126) AS Stamp, KindCode, CONVERT(varchar(8), OpenAt) AS OpenAt FROM dbo.Item WHERE Code = 'A001'`);
  assert.deepEqual({ ...a }, { Price: "130.00", Big: "9007199254740995", Stamp: "2026-10-18T08:00:00", KindCode: "K2", OpenAt: "10:30:00" });

  // 出力した SQL はそのまま流せる。戻しは、後から変わった行には触らない。
  await q(`UPDATE dbo.Item SET Price = 98 WHERE Code = 'A002'`);
  await q(done.undoScript);
  const rows = await q(`SELECT Code, CONVERT(varchar(30), Price) AS Price, CONVERT(varchar(20), Big) AS Big, KindCode FROM dbo.Item ORDER BY Code`);
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { Code: "A001", Price: "120.00", Big: "9007199254740993", KindCode: "K1" },
    { Code: "A002", Price: "98.00", Big: null, KindCode: "K1" },
  ]);
  await q(`UPDATE dbo.Item SET Price = NULL WHERE Code = 'A002'`);
  await q(done.script);
  assert.equal((await q(`SELECT CONVERT(varchar(30), Price) AS Price FROM dbo.Item WHERE Code = 'A002'`))[0]!.Price, "99.90");
});

test("名前に ] や ' を含む値もパラメータで安全に通る", { skip }, async () => {
  const p = await prepare(client, "item", { name: "s", rows: [["Code", "Name"], ["A002", "O'Reilly]; DROP TABLE dbo.Kind;--"]] });
  assert.ok(p.ok);
  const res = (await client.apply(buildApplyRequest(p.diff!, { mode: "execute" }))) as ApplyResponse;
  assert.equal(res.ok, true);
  assert.equal((await q(`SELECT Name FROM dbo.Item WHERE Code = 'A002'`))[0]!.Name, "O'Reilly]; DROP TABLE dbo.Kind;--");
  await q(res.undoScript);
  assert.equal((await q(`SELECT Name FROM dbo.Item WHERE Code = 'A002'`))[0]!.Name, "ノート");
  assert.equal((await q(`SELECT COUNT(*) AS n FROM dbo.Kind`))[0]!.n, 2);
});

test("照合順序が DB の既定と違う varchar 列でも日本語が崩れない。char 列の埋め空白は差分にしない", { skip }, async () => {
  const p = await prepare(client, "item", { name: "s", rows: [["Code", "Memo", "Grade"], ["A001", "ボールペン（黒）", "A"]] });
  assert.ok(p.ok, JSON.stringify(p.issues));
  assert.deepEqual(p.diff!.rows[0]!.changes.map((c) => c.column), ["Memo"]);
  const res = (await client.apply(buildApplyRequest(p.diff!, { mode: "execute" }))) as ApplyResponse;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((await q(`SELECT Memo FROM dbo.Item WHERE Code = 'A001'`))[0]!.Memo, "ボールペン（黒）");
  const again = await prepare(client, "item", { name: "s", rows: [["Code", "Memo"], ["A001", "ボールペン（黒）"]] });
  assert.deepEqual(again.diff!.counts, { change: 0, same: 1, not_found: 0 });
  // 出力した SQL を流しても崩れない。
  await q(res.undoScript);
  assert.equal((await q(`SELECT Memo FROM dbo.Item WHERE Code = 'A001'`))[0]!.Memo, "メモ");
  await q(res.script);
  assert.equal((await q(`SELECT Memo FROM dbo.Item WHERE Code = 'A001'`))[0]!.Memo, "ボールペン（黒）");
});
