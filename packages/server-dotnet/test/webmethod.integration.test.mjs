// .NET 版サーバを ASP.NET（WebMethod）で動かし、実際の SQL Server で通すテスト。
// クライアントは Node 版のテストと同じ @harikit/core を webmethod スタイルで使う（同じクライアントで両方が動くことの確認）。
// HARIKIT_TEST_MSSQL があり、ASP.NET を動かせるとき（既定は Mono。IIS などは test/host.mjs）だけ動く。
//   HARIKIT_TEST_MSSQL='{"server":"localhost","user":"sa","password":"..."}' npm run test:dotnet

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sql from "mssql";
import { buildApplyRequest, HarikitClient, prepare } from "@harikit/core";
import { createSite, hostUnavailable, serverFile, startSite, testDatabase } from "./host.mjs";

const env = process.env.HARIKIT_TEST_MSSQL;
const skip = !env ? "HARIKIT_TEST_MSSQL がないので飛ばす" : hostUnavailable();
const conn = env ? JSON.parse(env) : undefined;
const DB = testDatabase;
const USER = "CONTOSO\\tester";
/** Web.config の maxJsonLength。大きすぎる結果を DB を変える前に止めるかを見るため、小さめにしておく。 */
const MAX_JSON = 400000;

let admin;
let site;
let url;
let root;
let client;

const q = async (text) => (await admin.request().query(text)).recordset;
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** 生の WebMethod 呼び出し（クライアントを通さず、ヘッダや本文を自分で決める）。 */
async function call(method, req, headers = { "Content-Type": "application/json; charset=utf-8", "X-Harikit": "1" }) {
  const res = await fetch(`${url}/Harikit.aspx/${method}`, { method: "POST", headers, body: JSON.stringify({ req }) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text).d;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const applyReq = (rows, extra = {}) => ({ v: 1, requestId: crypto.randomUUID(), mode: "check", changes: [{ target: "item", rows }], ...extra });

before(async () => {
  if (skip) return;
  const base = { server: conn.server, port: conn.port ?? 1433, user: conn.user, password: conn.password, options: { encrypt: false, trustServerCertificate: true } };
  const master = await new sql.ConnectionPool({ ...base, database: "master" }).connect();
  // 既定の照合順序は日本語以外にしておき、列だけ Japanese_CI_AS の varchar を混ぜる（Node 版のテストと同じ）。
  await master.request().query(`IF DB_ID('${DB}') IS NULL CREATE DATABASE ${DB} COLLATE SQL_Latin1_General_CP1_CI_AS`);
  await master.close();
  admin = await new sql.ConnectionPool({ ...base, database: DB }).connect();
  await q(`DROP TABLE IF EXISTS dbo.Item; DROP TABLE IF EXISTS dbo.Kind; DROP TABLE IF EXISTS dbo.ItemAudit;`);
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
      Grade char(3) NULL,
      Ratio real NULL
    );
    CREATE TABLE dbo.ItemAudit (Code varchar(10), Note nvarchar(10));
    INSERT INTO dbo.Kind VALUES ('K1'), ('K2');
    INSERT INTO dbo.Item (Code, Name, KindCode, Price, Cost, Big, Qty, Released, Stamp, Legacy, OpenAt, Memo, Grade, Ratio) VALUES
      ('A001', N'ペン', 'K1', 120.00, 80.5, 9007199254740993, 5, '2024-04-01', '2026-10-17T09:30:00.123', '2026-10-17T09:30:00', '09:00', N'メモ', 'A', 0.1),
      ('A002', N'ノート', 'K1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);`);
  // 業務 DB によくある監査トリガー（SET NOCOUNT ON なし）。UPDATE の影響行数にトリガーの行数を混ぜないかを見る。
  await q(`CREATE TRIGGER dbo.TrItem ON dbo.Item AFTER UPDATE AS
    INSERT INTO dbo.ItemAudit SELECT Code, N'new' FROM inserted UNION ALL SELECT Code, N'old' FROM deleted;`);

  root = await createSite();
  await copyFile(serverFile("test/Probe.aspx"), join(root, "Probe.aspx"));
  const cs = `Server=${conn.server},${conn.port ?? 1433};Database=${DB};User Id=${conn.user};Password=${conn.password};Encrypt=false`;
  await writeFile(
    join(root, "Web.config"),
    `<?xml version="1.0"?>
<configuration>
  <appSettings><add key="harikit:config" value="~/App_Data/harikit.config.json" /></appSettings>
  <connectionStrings><add name="Harikit" connectionString="${xml(cs)}" /></connectionStrings>
  <system.web><compilation debug="true" targetFramework="4.5" /></system.web>
  <system.web.extensions><scripting><webServices><jsonSerialization maxJsonLength="${MAX_JSON}" /></webServices></scripting></system.web.extensions>
</configuration>
`,
  );
  // 載せ先の認証の代わり: X-Test-User ヘッダの名前でログインしたことにする。
  await writeFile(
    join(root, "Global.asax"),
    `<%@ Application Language="C#" %>
<%@ Import Namespace="System.Security.Principal" %>
<script runat="server">
  protected void Application_AuthenticateRequest(object sender, EventArgs e) {
    var name = Request.Headers["X-Test-User"];
    if (!string.IsNullOrEmpty(name)) Context.User = new GenericPrincipal(new GenericIdentity(name), new string[0]);
  }
</script>
`,
  );
  await writeFile(
    join(root, "App_Data", "harikit.config.json"),
    JSON.stringify({
      targets: {
        item: {
          table: "dbo.Item",
          access: "update",
          readable: ["Code", "Name", "KindCode", "Price", "Cost", "Big", "Qty", "Active", "Released", "Stamp", "Legacy", "OpenAt", "Guid", "RowId", "Memo", "Grade", "Ratio"],
          updatable: ["Name", "KindCode", "Price", "Cost", "Big", "Qty", "Active", "Released", "Stamp", "Legacy", "OpenAt", "Guid", "RowId", "Memo", "Grade", "Ratio"],
        },
        kind: { table: "Kind", access: "read", readable: ["KindCode"] },
      },
      lockWaitSeconds: 1,
    }),
  );

  site = await startSite(root);
  url = site.url;
  client = new HarikitClient({ baseUrl: `${url}/Harikit.aspx`, style: "webmethod", headers: { "X-Test-User": USER } });
});

after(async () => {
  await site?.stop();
  await admin?.close();
});

test("describe: 型、桁、文字コード、主キー、外部キー、更新できない列", { skip }, async () => {
  const list = await client.targets();
  assert.deepEqual(list.targets, [
    { target: "item", table: "dbo.Item", access: "update" },
    { target: "kind", table: "Kind", access: "read" },
  ]);
  const d = await client.describe("item");
  assert.equal(d.dialect, "sqlserver");
  assert.equal(d.table, "dbo.Item");
  assert.deepEqual(d.key, ["Code"]);
  assert.deepEqual(d.limits, { maxFetchKeys: 1000, maxApplyRows: 5000 });
  const col = (n) => d.columns.find((c) => c.name === n);
  assert.deepEqual(d.columns.map((c) => c.name).slice(0, 3), ["Code", "Name", "KindCode"]);
  assert.deepEqual({ ...col("Name") }, { name: "Name", type: "string", dbType: "nvarchar(50)", nullable: false, updatable: true, maxLength: 50, maxBytes: 100, encoding: "utf-16le" });
  assert.deepEqual({ ...col("Code") }, { name: "Code", type: "string", dbType: "varchar(10)", nullable: false, updatable: false, maxLength: 10, maxBytes: 10, encoding: "windows-1252" });
  assert.deepEqual([col("Memo").encoding, col("Memo").maxBytes, col("Memo").maxLength], ["shift_jis", 20, 20]);
  assert.deepEqual([col("Price").type, col("Price").precision, col("Price").scale], ["decimal", 9, 2]);
  assert.deepEqual([col("Cost").type, col("Cost").dbType], ["decimal", "money"]);
  assert.equal(col("Big").type, "bigint");
  assert.deepEqual([col("Qty").type, col("Qty").dbType], ["integer", "smallint"]);
  assert.deepEqual([col("Stamp").type, col("Stamp").dbType, col("Stamp").scale], ["datetime", "datetime2(3)", 3]);
  assert.deepEqual([col("Legacy").scale, col("OpenAt").scale], [3, 0]);
  assert.equal(col("Active").hasDefault, true);
  assert.deepEqual([col("Guid").type, col("Guid").updatable], ["other", false]);
  assert.deepEqual([col("RowId").identity, col("RowId").updatable], [true, false]);
  assert.deepEqual(d.foreignKeys, [
    { name: d.foreignKeys[0].name, columns: ["KindCode"], referencedTable: "dbo.Kind", referencedColumns: ["KindCode"], referencedTarget: "kind" },
  ]);
});

test("fetch: 値は仕様の形で返り、キーは DB の照合順序で引く", { skip }, async () => {
  const res = await client.fetch({ target: "item", keys: [{ Code: "a001" }, { Code: "Z" }, { code: "A001" }] });
  assert.deepEqual(res.rows[1], { index: 1, found: false });
  const row = res.rows[0];
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
    // real は float のまま返す（Node 版と同じ。0.1 にすると送り返した before が DB と合わない）。
    Ratio: 0.10000000149011612,
  });
  assert.deepEqual(res.rows[2].values, row.values);
  const keysOnly = await client.fetch({ target: "kind", keys: [{ KindCode: "K1" }, { KindCode: "K9" }], columns: [] });
  assert.deepEqual(keysOnly.rows, [{ index: 0, found: true, values: { KindCode: "K1" } }, { index: 1, found: false }]);
});

test("Excel 相当の取込から反映、衝突、戻しまで（監査トリガーのあるテーブル）", { skip }, async () => {
  const sheet = {
    name: "s",
    rows: [
      ["Code", "Price", "Big", "Stamp", "Released", "KindCode", "OpenAt"],
      ["A001", 130, "9007199254740995", { kind: "date", iso: "2026-10-18T08:00:00.000" }, "2024-04-02", "K2", "10:30"],
      ["A002", 99.9, null, null, null, "K1", null],
    ],
  };
  const p = await prepare(client, "item", sheet);
  assert.ok(p.ok, JSON.stringify(p.issues));
  assert.deepEqual(p.diff.counts, { change: 2, same: 0, not_found: 0 });
  assert.deepEqual(p.diff.rows[1].changes.map((c) => c.column), ["Price"]);

  const bad = await prepare(client, "item", { name: "s", rows: [["Code", "KindCode"], ["A001", "K9"]] });
  assert.deepEqual(bad.issues.map((i) => [i.cell, i.message]), [["B2", "dbo.Kind にありません"]]);

  // 差分を取った後に別の人が変えたら止まる。
  await q(`UPDATE dbo.Item SET Price = 121 WHERE Code = 'A001'`);
  const req = buildApplyRequest(p.diff, { mode: "execute", note: "依頼 2026-10-17\n承認 #123" });
  const conflict = await client.apply(req);
  assert.equal(conflict.error.code, "conflict");
  assert.deepEqual(conflict.conflicts.map((c) => [c.index, c.reason, c.columns, c.current]), [[0, "changed", ["Price"], { Price: "121.00", Big: "9007199254740993", Stamp: "2026-10-17T09:30:00.123", Released: "2024-04-01", KindCode: "K1", OpenAt: "09:00:00" }]]);
  assert.equal((await q(`SELECT Price FROM dbo.Item WHERE Code = 'A002'`))[0].Price, null);
  await q(`UPDATE dbo.Item SET Price = 120 WHERE Code = 'A001'`);
  await q(`DELETE FROM dbo.ItemAudit`);

  const check = await client.apply({ ...req, mode: "check" });
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.results, [{ target: "item", updated: 0 }]);
  assert.match(check.script, /実行予定\n-- [^\n]*何も反映せずに止まる[^\n]*\nSET XACT_ABORT ON;\nBEGIN TRANSACTION;\n/);
  assert.equal((await q(`SELECT COUNT(*) AS n FROM dbo.ItemAudit`))[0].n, 0);

  const done = await client.apply(req);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(done.results, [{ target: "item", updated: 2 }]);
  assert.equal(done.appliedBy, USER);
  assert.match(done.appliedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.equal((await q(`SELECT COUNT(*) AS n FROM dbo.ItemAudit`))[0].n, 4);
  const [a] = await q(`SELECT CONVERT(varchar(30), Price) AS Price, CONVERT(varchar(20), Big) AS Big, CONVERT(varchar(30), Stamp, 126) AS Stamp, KindCode, CONVERT(varchar(8), OpenAt) AS OpenAt FROM dbo.Item WHERE Code = 'A001'`);
  assert.deepEqual({ ...a }, { Price: "130.00", Big: "9007199254740995", Stamp: "2026-10-18T08:00:00", KindCode: "K2", OpenAt: "10:30:00" });

  // 同じ requestId の再送は、流し直さず前回の結果を返す。
  const again = await client.apply(req);
  assert.deepEqual(again, done);

  // 反映ログ（JSON Lines）。note は改行ごとログにだけ入り、スクリプトには入らない。
  const logDir = join(root, "App_Data", "harikit-log");
  const file = (await readdir(logDir)).find((f) => f.startsWith("apply-"));
  const entries = (await readFile(join(logDir, file), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const mine = entries.filter((e) => e.requestId === req.requestId).map((e) => [e.mode, e.outcome, e.appliedBy, e.note]);
  assert.deepEqual(mine, [
    ["execute", "conflict", USER, "依頼 2026-10-17\n承認 #123"],
    ["check", "checked", USER, "依頼 2026-10-17\n承認 #123"],
    ["execute", "applied", USER, "依頼 2026-10-17\n承認 #123"],
  ]);
  assert.ok(!done.script.includes("承認"));

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
  assert.equal((await q(`SELECT CONVERT(varchar(30), Price) AS Price FROM dbo.Item WHERE Code = 'A002'`))[0].Price, "99.90");
  await q(done.undoScript);
});

test("名前に ] や ' を含む値もパラメータで安全に通る", { skip }, async () => {
  const p = await prepare(client, "item", { name: "s", rows: [["Code", "Name"], ["A002", "O'Reilly]; DROP TABLE dbo.Kind;--"]] });
  assert.ok(p.ok);
  const res = await client.apply(buildApplyRequest(p.diff, { mode: "execute" }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((await q(`SELECT Name FROM dbo.Item WHERE Code = 'A002'`))[0].Name, "O'Reilly]; DROP TABLE dbo.Kind;--");
  await q(res.undoScript);
  assert.equal((await q(`SELECT Name FROM dbo.Item WHERE Code = 'A002'`))[0].Name, "ノート");
  assert.equal((await q(`SELECT COUNT(*) AS n FROM dbo.Kind`))[0].n, 2);
});

test("照合順序が DB の既定と違う varchar 列でも日本語が崩れない。char 列の埋め空白は差分にしない", { skip }, async () => {
  const p = await prepare(client, "item", { name: "s", rows: [["Code", "Memo", "Grade"], ["A001", "ボールペン（黒）", "A"]] });
  assert.ok(p.ok, JSON.stringify(p.issues));
  assert.deepEqual(p.diff.rows[0].changes.map((c) => c.column), ["Memo"]);
  const res = await client.apply(buildApplyRequest(p.diff, { mode: "execute" }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((await q(`SELECT Memo FROM dbo.Item WHERE Code = 'A001'`))[0].Memo, "ボールペン（黒）");
  const again = await prepare(client, "item", { name: "s", rows: [["Code", "Memo"], ["A001", "ボールペン（黒）"]] });
  assert.deepEqual(again.diff.counts, { change: 0, same: 1, not_found: 0 });
  // 出力した SQL を流しても崩れない。
  await q(res.undoScript);
  assert.equal((await q(`SELECT Memo FROM dbo.Item WHERE Code = 'A001'`))[0].Memo, "メモ");
  await q(res.script);
  assert.equal((await q(`SELECT Memo FROM dbo.Item WHERE Code = 'A001'`))[0].Memo, "ボールペン（黒）");
  await q(res.undoScript);
});

test("値が変わっていないかは厳密に比べ、キーは照合順序で探す（仕様 1.6）", { skip }, async () => {
  const memo = async () => (await q(`SELECT Memo FROM dbo.Item WHERE Code = 'A001'`))[0].Memo;
  await q(`UPDATE dbo.Item SET Memo = N'ボールペン' WHERE Code = 'A001'`);
  // Japanese_CI_AS の = なら同じとみなす値は、before としては「変わっていた」。
  for (const before of ["ﾎﾞｰﾙﾍﾟﾝ", "ぼーるぺん", "ボールペン "]) {
    const res = await client.apply(applyReq([{ key: { Code: "A001" }, before: { Memo: before }, after: { Memo: "ノート" } }], { mode: "execute" }));
    assert.equal(res.ok, false, before);
    assert.equal(res.error.code, "conflict", before);
    assert.deepEqual(res.conflicts[0].columns, ["Memo"]);
  }
  // char の埋め空白は区別しないが、大文字小文字は区別する（列は SQL_Latin1_General_CP1_CI_AS）。
  const lower = await client.apply(applyReq([{ key: { Code: "A001" }, before: { Grade: "a" }, after: { Grade: "B" } }]));
  assert.equal(lower.error?.code, "conflict", JSON.stringify(lower));
  // キーは照合順序のまま（a001 で A001 を指せる）。
  const res = await client.apply(
    applyReq([{ key: { Code: "a001" }, before: { Memo: "ボールペン", Grade: "A" }, after: { Memo: "ノート", Grade: "B" } }], { mode: "execute" }),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(await memo(), "ノート");
  // 反映の後に別の人が半角に直した行は、戻し SQL で上書きしない。
  await q(`UPDATE dbo.Item SET Memo = N'ﾉｰﾄ' WHERE Code = 'A001'`);
  await q(res.undoScript);
  assert.equal(await memo(), "ﾉｰﾄ");
  await q(`UPDATE dbo.Item SET Memo = N'ノート ' WHERE Code = 'A001'`);
  await q(res.undoScript);
  assert.equal(await memo(), "ノート ");
  // harikit で入れた値のままなら戻す。
  await q(`UPDATE dbo.Item SET Memo = N'ノート' WHERE Code = 'A001'`);
  await q(res.undoScript);
  assert.equal(await memo(), "ボールペン");
  assert.equal((await q(`SELECT Grade FROM dbo.Item WHERE Code = 'A001'`))[0].Grade, "A  ");
  await q(`UPDATE dbo.Item SET Memo = N'メモ' WHERE Code = 'A001'`);
});

test("出力した script は、後から行が変わっていたら何も反映せずに止まる。undoScript は飛ばして続ける", { skip }, async () => {
  const qty = async () => Object.fromEntries((await q(`SELECT Code, Qty FROM dbo.Item WHERE Code IN ('A001', 'A002', 'O''K')`)).map((r) => [r.Code, r.Qty]));
  await q(`INSERT INTO dbo.Item (Code, Name) VALUES ('O''K', N'x')`);
  try {
    const res = await client.apply(
      applyReq([
        { key: { Code: "A001" }, before: { Qty: 5 }, after: { Qty: 6 } },
        { key: { Code: "O'K" }, before: { Qty: null }, after: { Qty: 7 } },
      ]),
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.script.includes("IF @@ROWCOUNT <> 1 THROW 50001, N'harikit: 行が見つからないか、値が変わっています（Code=O''K）。何も反映していません', 1;"), res.script);
    // check の後に別の人が 2 行目を変えた。流しても 1 行目も含めて何も変わらない（監査トリガーがあっても止まり方は同じ）。
    await q(`UPDATE dbo.Item SET Qty = 1 WHERE Code = 'O''K'`);
    await assert.rejects(q(res.script), (e) => e.number === 50001 && e.message.includes("Code=O'K"));
    assert.deepEqual(await qty(), { A001: 5, A002: null, "O'K": 1 });
    // 元に戻せば流せる。
    await q(`UPDATE dbo.Item SET Qty = NULL WHERE Code = 'O''K'`);
    await q(res.script);
    assert.deepEqual(await qty(), { A001: 6, A002: null, "O'K": 7 });
    // 戻しは、後から変わった行（A001）を飛ばして残りを戻す。
    await q(`UPDATE dbo.Item SET Qty = 9 WHERE Code = 'A001'`);
    await q(res.undoScript);
    assert.deepEqual(await qty(), { A001: 9, A002: null, "O'K": null });
  } finally {
    await q(`DELETE FROM dbo.Item WHERE Code = 'O''K'; UPDATE dbo.Item SET Qty = 5 WHERE Code = 'A001'`);
  }
});

test("ほかのセッションが行をロックしたままなら、lockWaitSeconds で待つのをやめて何も変えない", { skip }, async () => {
  const tx = new sql.Transaction(admin);
  await tx.begin();
  let res;
  const started = Date.now();
  try {
    await new sql.Request(tx).query(`UPDATE dbo.Item SET Qty = Qty WHERE Code = 'A001'`);
    res = await client.apply(applyReq([{ key: { Code: "A001" }, before: { Qty: 5 }, after: { Qty: 6 } }], { mode: "execute" }));
  } finally {
    await tx.rollback();
  }
  assert.ok(Date.now() - started < 8000, `${Date.now() - started} ms`);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error.code, "db_error");
  assert.match(res.error.message, /ほかのセッションにロックされています/);
  assert.equal((await q(`SELECT Qty FROM dbo.Item WHERE Code = 'A001'`))[0].Qty, 5);
  // 待つ設定は接続に残さない（プールに戻った接続を使う fetch や載せ先の処理が、知らずに 1 秒で止まらないように）。
  const tx2 = new sql.Transaction(admin);
  await tx2.begin();
  await new sql.Request(tx2).query(`UPDATE dbo.Item SET Qty = Qty WHERE Code = 'A001'`);
  const t0 = Date.now();
  const released = new Promise((resolve) => setTimeout(resolve, 2000)).then(() => tx2.rollback());
  const f = await client.fetch({ target: "item", keys: [{ Code: "A001" }], columns: ["Qty"] });
  await released;
  assert.equal(f.rows[0].values.Qty, 5);
  assert.ok(Date.now() - t0 >= 1500, `${Date.now() - t0} ms`);
});

test("real の列は fetch した値を before に送り返しても衝突しない", { skip }, async () => {
  // 0.11 などは real にすると 0.10999999940395355。JavaScriptSerializer はこれを decimal で読み、
  // Convert.ToDouble(decimal) だと 1 つ隣の double になって衝突していた。
  for (const v of [0.1, 0.11, 0.7, 12.34, 98765.43]) {
    await q(`UPDATE dbo.Item SET Ratio = ${v} WHERE Code = 'A001'`);
    const f = await client.fetch({ target: "item", keys: [{ Code: "A001" }], columns: ["Ratio"] });
    const ratio = f.rows[0].values.Ratio;
    assert.equal(ratio, Math.fround(v));
    const res = await client.apply(applyReq([{ key: { Code: "A001" }, before: { Ratio: ratio }, after: { Ratio: 0.25 } }], { mode: "execute" }));
    assert.equal(res.ok, true, `${v}: ${JSON.stringify(res)}`);
    await q(res.undoScript);
    assert.equal((await q(`SELECT Ratio FROM dbo.Item WHERE Code = 'A001'`))[0].Ratio, ratio);
  }
  await q(`UPDATE dbo.Item SET Ratio = 0.1 WHERE Code = 'A001'`);
});

test("64 文字より長い数の文字列も切らずに渡す（先頭の 0 が切られて別の値にならない）", { skip }, async () => {
  const after = "0".repeat(66) + "130.00";
  const res = await client.apply(applyReq([{ key: { Code: "A002" }, before: { Price: null }, after: { Price: after } }], { mode: "execute" }));
  // DB が読めれば 130.00 が入り、読めなければ db_error で何も変えない。0.00 などの別の値は入らない。
  const price = (await q(`SELECT Price FROM dbo.Item WHERE Code = 'A002'`))[0].Price;
  if (res.ok) {
    assert.equal(price, 130);
    await q(res.undoScript);
    assert.equal((await q(`SELECT Price FROM dbo.Item WHERE Code = 'A002'`))[0].Price, null);
  } else {
    assert.equal(res.error.code, "db_error", JSON.stringify(res));
    assert.equal(price, null);
  }
});

test("サーバの値の確認: バイト数、列の文字コードで表せない字、型の形はまとめて invalid_value", { skip }, async () => {
  const { body } = await call(
    "Apply",
    applyReq([
      // Memo は varchar(20) の cp932。日本語 11 文字は 22 バイト。
      { key: { Code: "A001" }, before: { Memo: "メモ" }, after: { Memo: "あいうえおかきくけこさ" } },
      // 「𠮷」は cp932 にない。
      { key: { Code: "A001" }, before: { Memo: "メモ" }, after: { Memo: "𠮷野家" } },
      // Grade は char(3) の cp1252。日本語は表せない。
      { key: { Code: "A002" }, before: { Grade: null }, after: { Grade: "あ" } },
      { key: { Code: "A002" }, before: { Price: null }, after: { Price: "1; DROP TABLE dbo.Kind" } },
      { key: { Code: "A002" }, before: { Price: null }, after: { Price: "１２０" } },
      { key: { Code: "A002" }, before: { Released: null }, after: { Released: "2024-02-30" } },
      { key: { Code: "A002" }, before: { Qty: null }, after: { Qty: 40000 } },
      { key: { Code: "A002" }, before: { Name: "ノート" }, after: { Name: null } },
      { key: { Code: "A002" }, before: { Stamp: null }, after: { Stamp: "2026-10-17T09:30:00.1234" } },
      { key: { Code: "A002" }, before: { RowId: 2 }, after: { RowId: 3 } },
      { key: { Code: "A002" }, before: { Price: null }, after: { Price: null } },
      { key: { Code: "A002", Name: "x" }, before: { Price: null }, after: { Price: "1" } },
    ]),
  );
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "bad_request");
  assert.equal(body.error.message, "12 行に誤りがあります");
  assert.deepEqual(
    body.rowErrors.map((e) => [e.index, e.code, e.column, e.message]),
    [
      [0, "invalid_value", "Memo", "after: 20 バイトを超えています（22 バイト）"],
      [1, "invalid_value", "Memo", "after: 「𠮷」は列の文字コード（shift_jis）で表せません"],
      [2, "invalid_value", "Grade", "after: 「あ」は列の文字コード（windows-1252）で表せません"],
      [3, "invalid_value", "Price", "after: 数値ではありません"],
      [4, "invalid_value", "Price", "after: 数値ではありません"],
      [5, "invalid_value", "Released", "after: 日付（YYYY-MM-DD）ではありません"],
      [6, "invalid_value", "Qty", "after: 範囲外です（-32768〜32767）"],
      [7, "invalid_value", "Name", "after: 必須です（NOT NULL）"],
      [8, "invalid_value", "Stamp", "after: 秒の小数は 3 桁までです"],
      [9, "column_not_allowed", "RowId", "列 RowId は更新が許可されていません"],
      [10, "bad_request", "Price", "before と after が同じです"],
      [11, "key_mismatch", "Name", "キーに列 Name は使えません"],
    ],
  );
});

test("文字コードの最後の確認は DB で行う（.NET の文字コードで見逃しても止まる）", { skip }, async () => {
  // Probe.aspx は .NET の文字コードでの確認を外した方言で apply を流す。
  const res = await fetch(`${url}/Probe.aspx/Apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      req: applyReq([
        { key: { Code: "A001" }, before: { Grade: null }, after: { Grade: "あ" } },
        { key: { Code: "A002" }, before: { Memo: null }, after: { Memo: "あいうえおかきくけこさ" } },
        { key: { Code: "Z1" }, before: { Memo: null }, after: { Memo: "𠮷野家" } },
        { key: { Code: "Z2" }, before: { Memo: null }, after: { Memo: "ボールペン（黒）" } },
      ]),
    }),
  });
  const body = (await res.json()).d;
  assert.equal(body.error?.message, "3 行に誤りがあります", JSON.stringify(body));
  assert.deepEqual(
    body.rowErrors.map((e) => [e.index, e.code, e.column, e.message]),
    [
      [0, "invalid_value", "Grade", "after: 列の文字コード（windows-1252）で表せない字があります"],
      [1, "invalid_value", "Memo", "after: 20 バイトを超えています（22 バイト）"],
      [2, "invalid_value", "Memo", "after: 列の文字コード（shift_jis）で表せない字があります"],
    ],
  );
});

test("照合順序で同じ行を指す 2 行は duplicate_key で止め、何も変えない", { skip }, async () => {
  const res = await client.apply(
    applyReq(
      [
        { key: { Code: "A002" }, before: { Price: null }, after: { Price: "1" } },
        { key: { Code: "a002" }, before: { Price: null }, after: { Price: "2" } },
      ],
      { mode: "execute" },
    ),
  );
  assert.equal(res.ok, false);
  assert.deepEqual(res.rowErrors.map((e) => [e.index, e.code]), [[1, "duplicate_key"]]);
  assert.equal((await q(`SELECT Price FROM dbo.Item WHERE Code = 'A002'`))[0].Price, null);
  const same = await client.apply(applyReq([
    { key: { Code: "A002" }, before: { Price: null }, after: { Price: "1" } },
    { key: { Code: "A002" }, before: { Price: null }, after: { Price: "2" } },
  ]));
  assert.deepEqual(same.rowErrors.map((e) => [e.index, e.code, e.message]), [[1, "duplicate_key", "0 番目の行とキーが同じです"]]);
});

test("リクエストの誤りは HTTP 200 の ok:false で返す", { skip }, async () => {
  const codes = async (method, req) => {
    const { status, body } = await call(method, req);
    assert.equal(status, 200);
    return [body.ok, body.error.code];
  };
  assert.deepEqual(await codes("Describe", { v: 2 }), [false, "version_unsupported"]);
  assert.deepEqual(await codes("Describe", null), [false, "bad_request"]);
  assert.deepEqual(await codes("Describe", { v: 1, target: "M_Product" }), [false, "unknown_target"]);
  assert.deepEqual(await codes("Fetch", { v: 1, target: "item", keys: [{ Code: "A001" }], columns: ["Secret"] }), [false, "column_not_allowed"]);
  assert.deepEqual(await codes("Fetch", { v: 1, target: "item", keys: [{ Name: "A001" }] }), [false, "key_mismatch"]);
  assert.deepEqual(await codes("Fetch", { v: 1, target: "item", keys: Array.from({ length: 1001 }, (_, i) => ({ Code: `X${i}` })) }), [false, "too_many_rows"]);
  assert.deepEqual(await codes("Apply", { ...applyReq([]), mode: "execute" }), [false, "bad_request"]);
  assert.deepEqual(await codes("Apply", { ...applyReq([]), changes: [{ target: "kind", rows: [] }] }), [false, "bad_request"]);
  // requestId はスクリプトのコメントに入るので、改行などは通さない。
  const row = { key: { Code: "A001" }, before: { Price: "120.00" }, after: { Price: "121" } };
  assert.deepEqual(await codes("Apply", applyReq([row], { requestId: "abcdefgh\nDROP TABLE dbo.Kind" })), [false, "bad_request"]);
  const { body } = await call("Apply", applyReq([row], { requestId: "abc" }));
  assert.deepEqual([body.requestId, body.mode], ["abc", "check"]);
});

test("X-Harikit がなければ 403、WebMethod 以外は 404 / 415", { skip }, async () => {
  const noHeader = await call("Describe", { v: 1 }, { "Content-Type": "application/json" });
  assert.equal(noHeader.status, 403);
  const page = await fetch(`${url}/Harikit.aspx`);
  assert.equal(page.status, 404);
  const form = await fetch(`${url}/Harikit.aspx`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Harikit": "1" }, body: "a=1" });
  assert.equal(form.status, 415);
});

test("返せないほど大きい結果になる apply は、DB を変える前に止める", { skip }, async () => {
  // Web.config の maxJsonLength を小さくしてある。行は DB になくてもよい（DB に触る前に止まるはず）。
  const rows = Array.from({ length: 2500 }, (_, i) => ({ key: { Code: `Z${i}` }, before: { Name: "x" }, after: { Name: "あ".repeat(30) } }));
  const { status, body } = await call("Apply", applyReq(rows, { mode: "execute" }));
  assert.equal(status, 200);
  assert.equal(body.error.code, "too_many_rows");
  assert.equal(body.error.details.maxJsonLength, MAX_JSON);
  assert.equal((await q(`SELECT COUNT(*) AS n FROM dbo.Item`))[0].n, 2);
});
