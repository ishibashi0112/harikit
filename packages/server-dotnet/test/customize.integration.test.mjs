// .NET 版サーバのカスタマイズの口を、ASP.NET（WebMethod）と実際の SQL Server で通すテスト。
// 許可リストの labels / stamp / scope / roles と rules（ファイル）、画面の設定（screen）、Global.asax で差し替える PatchiriWebMethods.WhoAmI / IsInRole、
// ページごとの許可リスト（Call の configPath）を見る。場面は Node 版の stamp-scenario.ts と同じ。
// PATCHIRI_TEST_MSSQL があり、ASP.NET を動かせるときだけ動く（webmethod.integration.test.mjs と同じ）。

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sql from "mssql";
import { buildApplyRequest, PatchiriClient, prepare } from "patchiri-core";
import { createSite, hostUnavailable, startSite, testDatabase } from "./host.mjs";

const env = process.env.PATCHIRI_TEST_MSSQL;
const skip = !env ? "PATCHIRI_TEST_MSSQL がないので飛ばす" : hostUnavailable();
const conn = env ? JSON.parse(env) : undefined;
const DB = `${testDatabase}_Custom`;
/** 載せ先の自前のログインの代わり: X-Emp ヘッダを社員番号、X-Roles ヘッダをロール（, 区切り）とする。 */
const EMP = "E1234";

let admin;
let site;
let url;
let root;
let client;

const q = async (text) => (await admin.request().query(text)).recordset;
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

async function call(page, method, req, headers = {}) {
  const res = await fetch(`${url}/${page}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Patchiri": "1", ...headers },
    body: JSON.stringify({ req }),
    redirect: "manual",
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text).d ?? JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const RULES = { targets: { term: [{ column: "EndDate", min: { column: "StartDate" } }, { column: "Price", max: 1000, severity: "warning" }] } };

async function reset() {
  await q(`DROP TABLE IF EXISTS dbo.Term`);
  await q(`CREATE TABLE dbo.Term (
      Company varchar(3) NOT NULL, Code varchar(4) NOT NULL, Kind varchar(1) NOT NULL, StartDate date NOT NULL, EndDate date NULL,
      Price decimal(9,2) NULL, UpdatedAt datetime2(3) NULL, UpdatedOn date NULL, UpdatedBy varchar(10) NULL, PRIMARY KEY (Company, Code));
    INSERT INTO dbo.Term VALUES ('001', 'T1', '1', '2026-04-01', '2026-09-30', 100.00, '2026-01-05T10:00:00', '2026-01-05', 'old'),
      ('002', 'T1', '1', '2026-04-01', NULL, 500.00, NULL, NULL, NULL);`);
}

async function row(company) {
  const [r] = await q(`SELECT CONVERT(varchar(20), Price) AS price, CONVERT(char(10), StartDate, 23) AS startDate, CONVERT(char(19), UpdatedAt, 120) AS updatedAt,
    CONVERT(char(10), UpdatedOn, 23) AS updatedOn, UpdatedBy AS updatedBy FROM dbo.Term WHERE Company = '${company}' AND Code = 'T1'`);
  return { ...r };
}

const today = async () => String((await q(`SELECT CONVERT(char(10), SYSDATETIME(), 23) AS d`))[0].d);

/** Patchiri.aspx と同じ WebMethod で、許可リストだけを configPath で別にしたページ。 */
const otherPage = (configPath) => `<%@ Page Language="C#" EnableSessionState="False" EnableViewState="False" %>
<%@ Import Namespace="System.Collections.Generic" %>
<%@ Import Namespace="System.Web.Services" %>
<%@ Import Namespace="Patchiri.Server" %>
<script runat="server">
    const string ConfigPath = "${configPath}";
    [WebMethod] public static Dictionary<string, object> Describe(Dictionary<string, object> req) { return PatchiriWebMethods.Call("describe", req, ConfigPath); }
    [WebMethod] public static Dictionary<string, object> Fetch(Dictionary<string, object> req) { return PatchiriWebMethods.Call("fetch", req, ConfigPath); }
    [WebMethod] public static Dictionary<string, object> Apply(Dictionary<string, object> req) { return PatchiriWebMethods.Call("apply", req, ConfigPath); }
</script>
`;

before(async () => {
  if (skip) return;
  const base = { server: conn.server, port: conn.port ?? 1433, user: conn.user, password: conn.password, options: { encrypt: false, trustServerCertificate: true } };
  const master = await new sql.ConnectionPool({ ...base, database: "master" }).connect();
  await master.request().query(`IF DB_ID('${DB}') IS NULL CREATE DATABASE ${DB} COLLATE SQL_Latin1_General_CP1_CI_AS`);
  await master.close();
  admin = await new sql.ConnectionPool({ ...base, database: DB }).connect();
  await reset();

  root = await createSite();
  const cs = `Server=${conn.server},${conn.port ?? 1433};Database=${DB};User Id=${conn.user};Password=${conn.password};Encrypt=false`;
  await writeFile(
    join(root, "Web.config"),
    `<?xml version="1.0"?>
<configuration>
  <connectionStrings><add name="Patchiri" connectionString="${xml(cs)}" /></connectionStrings>
  <system.web><compilation debug="true" targetFramework="4.5" /></system.web>
</configuration>
`,
  );
  // 載せ先の自前のログイン（Session の社員番号など）の代わりに、ヘッダで「誰が」とロールを決める。
  await writeFile(
    join(root, "Global.asax"),
    `<%@ Application Language="C#" %>
<%@ Import Namespace="Patchiri.Server" %>
<script runat="server">
  protected void Application_Start(object sender, EventArgs e) {
    PatchiriWebMethods.WhoAmI = ctx => ctx.Request.Headers["X-Emp"];
    PatchiriWebMethods.IsInRole = (ctx, role) => Array.IndexOf((ctx.Request.Headers["X-Roles"] ?? "").Split(','), role) >= 0;
  }
</script>
`,
  );
  await writeFile(
    join(root, "App_Data", "patchiri.config.json"),
    JSON.stringify({
      targets: {
        term: {
          table: "dbo.Term",
          access: "update",
          key: ["Code"],
          readable: ["Code", "Kind", "StartDate", "EndDate", "Price"],
          updatable: ["StartDate", "EndDate", "Price"],
          labels: { Price: "単価" },
          stamp: { UpdatedAt: "now", UpdatedOn: "now", UpdatedBy: "user" },
          scope: { Company: "001" },
        },
      },
      // 設定ファイルのフォルダ（App_Data）から読む。
      rules: "patchiri.rules.json",
      database: { lockWaitSeconds: 1 },
      screen: { title: "単価の更新 <A&B>", theme: "dark", noteRequired: "依頼番号", excel: false, css: "patchiri.screen.css" },
    }),
  );
  await writeFile(join(root, "App_Data", "patchiri.rules.json"), JSON.stringify(RULES));
  await writeFile(join(root, "App_Data", "patchiri.screen.css"), ".pt-app { --pt-accent: #0b7a75 } /* </style> */");
  // ページごとの許可リスト: 会社 002 の行だけを、ロール MasterAdmin の人だけが触れる。
  await writeFile(join(root, "Other.aspx"), otherPage("~/App_Data/other.config.json"));
  await writeFile(
    join(root, "App_Data", "other.config.json"),
    JSON.stringify({
      targets: {
        term002: { table: "dbo.Term", access: "update", key: ["Code"], readable: ["Code", "Price"], updatable: ["Price"], scope: { Company: "002" }, roles: ["MasterAdmin"] },
        open: { table: "dbo.Term", access: "read", key: ["Code"], readable: ["Code"], scope: { Company: "002" } },
      },
    }),
  );
  // 設定の誤り（表示名がほかの列の名前とぶつかる）。
  await writeFile(join(root, "Broken.aspx"), otherPage("~/App_Data/broken.config.json"));
  await writeFile(
    join(root, "App_Data", "broken.config.json"),
    JSON.stringify({ targets: { term: { table: "dbo.Term", access: "read", readable: ["Code", "Kind"], labels: { Code: "kind" } } } }),
  );

  site = await startSite(root);
  url = site.url;
  client = new PatchiriClient({ baseUrl: `${url}/Patchiri.aspx`, style: "webmethod", headers: { "X-Emp": EMP } });
});

after(async () => {
  await site?.stop();
  await admin?.close();
});

test("WhoAmI が名前を返さなければ、API も画面も 401", { skip }, async () => {
  const api = await call("Patchiri.aspx", "Describe", { v: 1 });
  assert.equal(api.status, 401);
  assert.deepEqual(api.body, { message: "login required" });
  // 画面は 401。フォーム認証が効いていれば（Mono の既定）ASP.NET がログインの画面への転送（302）にする。
  const page = await fetch(`${url}/Patchiri.aspx`, { redirect: "manual" });
  assert.ok([302, 401].includes(page.status), String(page.status));
  // 名前があれば画面を返し、その名前を見出しに出す。画面の設定（screen）は Node 版と同じ data- 属性と、足す CSS。
  const ok = await fetch(`${url}/Patchiri.aspx`, { headers: { "X-Emp": EMP } });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /data-user="E1234" data-title="単価の更新 &lt;A&amp;B&gt;" data-theme="dark" data-note-required="依頼番号" data-excel="false">/);
  assert.match(html, /<title>単価の更新 &lt;A&amp;B&gt;<\/title>/);
  assert.match(html, /<style>\n\.pt-app \{ --pt-accent: #0b7a75 \} \/\* <\\\/style> \*\/\n<\/style>/);
});

test("describe: 表示名、stamp、scope、ファイルに置いた業務ルール", { skip }, async () => {
  const d = await client.describe("term");
  assert.deepEqual(d.columns.map((c) => [c.name, c.label]), [["Code", undefined], ["Kind", undefined], ["StartDate", undefined], ["EndDate", undefined], ["Price", "単価"]]);
  assert.deepEqual(d.stamp, [{ column: "UpdatedAt", value: "now" }, { column: "UpdatedOn", value: "now" }, { column: "UpdatedBy", value: "user" }]);
  assert.deepEqual(d.scope, { Company: "001" });
  assert.deepEqual(d.rules, RULES.targets.term);
});

test("stamp は DB の時刻と WhoAmI の名前。scope の外の行は変えず、戻し SQL は stamp も戻す", { skip }, async () => {
  await reset();
  // 見出しは表示名でよい。
  const p = await prepare(client, "term", { name: "s", rows: [["Code", "単価"], ["T1", "120"]] });
  assert.equal(p.ok, true, JSON.stringify(p.issues));
  assert.equal(p.diff.rows[0].current.Price, "100.00");
  const req = buildApplyRequest(p.diff, { mode: "execute" });
  const check = await client.apply({ ...req, mode: "check" });
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.match(check.script, /SYSDATETIME\(\)/);
  assert.match(check.script, /'E1234'/);
  const res = await client.apply(req);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.appliedBy, EMP);
  const after = await row("001");
  assert.equal(after.price, "120.00");
  assert.equal(after.updatedBy, EMP);
  assert.equal(after.updatedOn, await today());
  assert.equal(after.updatedAt.slice(0, 10), await today());
  assert.equal((await row("002")).price, "500.00");

  // 反映ログに stamp の列の前の値を残す。
  const logDir = join(root, "App_Data", "patchiri-log");
  const file = (await readdir(logDir)).find((f) => f.startsWith("apply-"));
  const entry = (await readFile(join(logDir, file), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.requestId === req.requestId && e.outcome === "applied");
  assert.deepEqual(entry.rows[0].stampBefore, { UpdatedAt: "2026-01-05T10:00:00", UpdatedOn: "2026-01-05", UpdatedBy: "old" });

  await q(res.undoScript);
  assert.deepEqual(await row("001"), { price: "100.00", startDate: "2026-04-01", updatedAt: "2026-01-05 10:00:00", updatedOn: "2026-01-05", updatedBy: "old" });
});

test("サーバの業務ルールは、変えない列を DB の値で見る。warning のルールでは止めない", { skip }, async () => {
  await reset();
  const bad = await client.apply({
    v: 1,
    requestId: crypto.randomUUID(),
    mode: "check",
    changes: [{ target: "term", rows: [{ op: "update", key: { Code: "T1" }, before: { StartDate: "2026-04-01" }, after: { StartDate: "2026-10-01" } }] }],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "bad_request");
  assert.deepEqual(bad.rowErrors.map((e) => [e.code, e.column, e.message]), [["rule_violation", "StartDate", "EndDate（2026-09-30）は StartDate（2026-10-01） 以上にしてください"]]);
  const warn = await client.apply({
    v: 1,
    requestId: crypto.randomUUID(),
    mode: "check",
    changes: [{ target: "term", rows: [{ op: "update", key: { Code: "T1" }, before: { Price: "100.00" }, after: { Price: "5000" } }] }],
  });
  assert.equal(warn.ok, true, JSON.stringify(warn));
});

test("rules のファイルを書き直すと読み直す", { skip }, async () => {
  const file = join(root, "App_Data", "patchiri.rules.json");
  await writeFile(file, JSON.stringify({ targets: { term: [{ column: "Price", min: 0 }] } }));
  // 更新日時の刻みが粗いファイルシステムでも変わったとわかるように、先の時刻にする。
  const later = new Date(Date.now() + 60_000);
  await utimes(file, later, later);
  assert.deepEqual((await client.describe("term")).rules, [{ column: "Price", min: 0 }]);
  await writeFile(file, JSON.stringify(RULES));
  const later2 = new Date(Date.now() + 120_000);
  await utimes(file, later2, later2);
  assert.deepEqual((await client.describe("term")).rules, RULES.targets.term);
});

test("反映した人の名前が stamp の列に入らなければ、DB に触る前に止める", { skip }, async () => {
  await reset();
  const long = new PatchiriClient({ baseUrl: `${url}/Patchiri.aspx`, style: "webmethod", headers: { "X-Emp": "E12345678901" } });
  const res = await long.apply({
    v: 1,
    requestId: crypto.randomUUID(),
    mode: "execute",
    changes: [{ target: "term", rows: [{ op: "update", key: { Code: "T1" }, before: { Price: "100.00" }, after: { Price: "101" } }] }],
  });
  assert.equal(res.error.code, "bad_request");
  assert.match(res.error.message, /UpdatedBy/);
  assert.equal((await row("001")).price, "100.00");
});

test("ページごとの許可リストと、IsInRole で判定する roles", { skip }, async () => {
  await reset();
  const as = (roles) => new PatchiriClient({ baseUrl: `${url}/Other.aspx`, style: "webmethod", headers: { "X-Emp": EMP, ...(roles && { "X-Roles": roles }) } });
  // ロールのない人には一覧に出さず、指しても forbidden。
  assert.deepEqual((await as().targets()).targets.map((t) => t.target), ["open"]);
  const denied = await call("Other.aspx", "Describe", { v: 1, target: "term002" }, { "X-Emp": EMP, "X-Roles": "Viewer" });
  assert.equal(denied.body.error.code, "forbidden");
  const admin = as("Viewer,MasterAdmin");
  assert.deepEqual((await admin.targets()).targets.map((t) => t.target), ["term002", "open"]);
  // scope は会社 002 の行。Patchiri.aspx の許可リスト（会社 001）とは別に読む。
  const f = await admin.fetch({ target: "term002", keys: [{ Code: "T1" }], columns: ["Price"] });
  assert.deepEqual(f.rows, [{ index: 0, found: true, values: { Code: "T1", Price: "500.00" } }]);
  assert.deepEqual((await client.targets()).targets.map((t) => t.target), ["term"]);
});

test("設定の誤りは internal_error で、中身はサーバのログに残す", { skip }, async () => {
  const res = await call("Broken.aspx", "Describe", { v: 1 }, { "X-Emp": EMP });
  assert.equal(res.status, 200);
  assert.equal(res.body.error.code, "internal_error");
  const logDir = join(root, "App_Data", "patchiri-log");
  const file = (await readdir(logDir)).find((f) => f.startsWith("error-"));
  assert.match(await readFile(join(logDir, file), "utf8"), /term\.labels/);
});
