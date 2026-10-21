// Patchiri.aspx の画面を本物のブラウザで通しで動かし、実際の SQL Server で確かめるテスト。
// 載せ先のフォーム認証でログインして、貼る → 検証 → 差分 → DB で確かめる → 反映 までと、
// 権限のない人が開けないこと、ログインが切れたときの案内を見る。
// ページは名前とフォルダを変えて置く（Admin/MasterUpdate.aspx。載せ先が好きな名前にできることの確認）。
// PATCHIRI_TEST_MSSQL があり、ASP.NET を動かせるとき（test/host.mjs）だけ動く。画面は先に npm run build で作っておく。
//   PATCHIRI_TEST_MSSQL='{"server":"localhost","user":"sa","password":"..."}' npm run test:dotnet
// ブラウザは Playwright の Chromium（npx playwright install chromium）。ほかのものは PATCHIRI_TEST_CHROMIUM（実行ファイル）か
// PATCHIRI_TEST_BROWSER_CHANNEL（msedge など、入っているブラウザ）で選ぶ。
// PATCHIRI_TEST_SCREENSHOTS にフォルダを渡すと、途中の画面を PNG で残す。

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sql from "mssql";
import { createSite, hostUnavailable, startSite, testDatabase } from "./host.mjs";

const env = process.env.PATCHIRI_TEST_MSSQL;
const skip = !env ? "PATCHIRI_TEST_MSSQL がないので飛ばす" : hostUnavailable();
const conn = env ? JSON.parse(env) : undefined;
/** 結合テスト（webmethod.integration.test.mjs）と同時に流しても当たらないよう、DB を分ける。 */
const DB = `${testDatabase}_Screen`;
const shots = process.env.PATCHIRI_TEST_SCREENSHOTS;
const PAGE = "Admin/MasterUpdate.aspx";

let admin;
let site;
let url;
let root;
let browser;

const q = async (text) => (await admin.request().query(text)).recordset;
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

async function shot(page, name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

before(async () => {
  if (skip) return;
  const base = { server: conn.server, port: conn.port ?? 1433, user: conn.user, password: conn.password, options: { encrypt: false, trustServerCertificate: true } };
  const master = await new sql.ConnectionPool({ ...base, database: "master" }).connect();
  await master.request().query(`IF DB_ID('${DB}') IS NULL CREATE DATABASE ${DB} COLLATE Japanese_CI_AS`);
  await master.close();
  admin = await new sql.ConnectionPool({ ...base, database: DB }).connect();
  await q(`DROP TABLE IF EXISTS dbo.m_product`);
  await q(`CREATE TABLE dbo.m_product (
      product_code varchar(10) NOT NULL PRIMARY KEY,
      product_name nvarchar(40) NOT NULL,
      unit_price decimal(9,0) NOT NULL,
      sales_start date NULL
    );
    INSERT INTO dbo.m_product VALUES
      ('A001', N'ボールペン 黒', 120, '2024-04-01'),
      ('A002', N'ボールペン 赤', 120, '2024-04-01'),
      ('B001', N'ノート A4', 250, NULL);`);

  root = await createSite({ page: PAGE });
  const cs = `Server=${conn.server},${conn.port ?? 1433};Database=${DB};User Id=${conn.user};Password=${conn.password};Encrypt=false`;
  // 載せ先によくある形: フォーム認証で、patchiri のページは tester だけに許す。
  await writeFile(
    join(root, "Web.config"),
    `<?xml version="1.0"?>
<configuration>
  <connectionStrings><add name="Patchiri" connectionString="${xml(cs)}" /></connectionStrings>
  <system.web>
    <compilation debug="true" targetFramework="4.5" />
    <authentication mode="Forms"><forms loginUrl="Login.aspx" name=".PATCHIRITEST" /></authentication>
  </system.web>
  <location path="${PAGE}">
    <system.web>
      <authorization>
        <allow users="tester" />
        <deny users="*" />
      </authorization>
    </system.web>
  </location>
</configuration>
`,
  );
  // 載せ先のログインの画面の代わり。パスワードが pw なら、その名前でログインしたことにする。
  // 日本語を含むので BOM を付ける（BOM がないと IIS の ASP.NET は OS の既定の文字コードで読み、ラベルが化ける）。
  await writeFile(
    join(root, "Login.aspx"),
    `\ufeff<%@ Page Language="C#" %>
<script runat="server">
  protected void Page_Load(object sender, EventArgs e) {
    if (Request.HttpMethod == "POST" && Request.Form["password"] == "pw") FormsAuthentication.RedirectFromLoginPage(Request.Form["user"], false);
  }
</script>
<!doctype html>
<html><head><meta charset="utf-8"><title>ログイン</title></head>
<body><form method="post"><input name="user" aria-label="ユーザー"><input name="password" type="password" aria-label="パスワード"><button>ログイン</button></form></body></html>
`,
  );
  await writeFile(
    join(root, "App_Data", "patchiri.config.json"),
    JSON.stringify({
      targets: {
        product: { table: "dbo.m_product", access: "update", readable: ["product_code", "product_name", "unit_price", "sales_start"], updatable: ["product_name", "unit_price", "sales_start"] },
      },
    }),
  );
  site = await startSite(root, { page: PAGE });
  url = site.url;
  const { chromium } = await import("playwright");
  const options = {};
  if (process.env.PATCHIRI_TEST_CHROMIUM) options.executablePath = process.env.PATCHIRI_TEST_CHROMIUM;
  if (process.env.PATCHIRI_TEST_BROWSER_CHANNEL) options.channel = process.env.PATCHIRI_TEST_BROWSER_CHANNEL;
  browser = await chromium.launch(options);
});

after(async () => {
  await browser?.close();
  await site?.stop();
  await admin?.close();
});

/** ページを開き、載せ先のログインの画面に回されたらログインする。 */
async function open(user) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ja-JP" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // 読めなかったものは URL 付きで残す。favicon.ico は載せ先のサイトのもの（Edge はサイトの直下に取りに行き、IIS の既定のサイトにはない）。
  page.on("response", (r) => r.status() >= 400 && !new URL(r.url()).pathname.endsWith("/favicon.ico") && errors.push(`HTTP ${r.status()}: ${r.url()}`));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  await page.goto(`${url}/${PAGE}`);
  assert.match(page.url(), /Login\.aspx\?ReturnUrl=/, "ログインしていなければ、画面の前に載せ先のログインの画面に回る");
  await page.getByLabel("ユーザー").fill(user);
  await page.getByLabel("パスワード").fill("pw");
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForLoadState();
  return { context, page, errors };
}

/** 表の A1 を選んで、Excel からコピーした形（タブ区切り）を貼る。 */
async function paste(page, rows) {
  await page.locator('[role="gridcell"]').first().click();
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, rows.map((r) => r.join("\t")).join("\r\n") + "\r\n");
}

test("載せ先のログインのまま、画面で貼って検証して反映する", { skip }, async () => {
  const { context, page, errors } = await open("tester");
  await page.getByText("tester でログインしています").waitFor();
  // 対象が 1 つなら選んだ状態で始まり、列の一覧が出る。
  await page.getByText("unit_price", { exact: true }).waitFor();
  await shot(page, "1-open");

  await paste(page, [
    ["product_code", "unit_price", "sales_start"],
    ["A001", "¥130", "2024/4/1"],
    ["A002", "120", "2024/4/1"],
    ["B001", "260", "2026/11/1"],
    ["Z999", "100", ""],
  ]);
  await page.getByRole("button", { name: "検証して差分を見る" }).click();
  await page.locator(".pt-summary").waitFor();
  assert.deepEqual(await page.locator(".pt-count strong").allTextContents(), ["2", "1", "1"], "変わる・同じ・キーなし");
  await shot(page, "2-diff");

  await page.getByLabel(/メモ/).fill("依頼 #42");
  await page.getByRole("button", { name: "DB で確かめる" }).click();
  await page.getByText("2 行とも差分どおりで、反映できます").waitFor();
  await page.getByRole("button", { name: "反映する" }).first().click();
  await page.locator(".pt-confirm").getByRole("button", { name: "反映する" }).click();
  await page.getByText(/反映しました: 2 行（tester、/).waitFor();
  await shot(page, "3-applied");

  const rows = await q(`SELECT product_code, CONVERT(varchar(20), unit_price) AS unit_price, CONVERT(varchar(10), sales_start, 23) AS sales_start FROM dbo.m_product ORDER BY product_code`);
  assert.deepEqual(rows.map((r) => [r.product_code, r.unit_price, r.sales_start]), [
    ["A001", "130", "2024-04-01"],
    ["A002", "120", "2024-04-01"],
    ["B001", "260", "2026-11-01"],
  ]);
  // 反映ログの「誰が」は、載せ先のログイン名（クライアントが名乗る名前ではない）。
  const logDir = join(root, "App_Data", "patchiri-log");
  const file = (await readdir(logDir)).find((f) => f.startsWith("apply-"));
  const entries = (await readFile(join(logDir, file), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(entries.map((e) => [e.mode, e.outcome, e.appliedBy, e.note]), [
    ["check", "checked", "tester", "依頼 #42"],
    ["execute", "applied", "tester", "依頼 #42"],
  ]);
  assert.deepEqual(errors, []);

  // ログインが切れたら、貼った表を残したまま、別のタブでログインし直すよう案内する。
  await context.clearCookies();
  await page.getByRole("button", { name: "検証して差分を見る" }).click();
  await page.getByRole("alert").getByText(/ログインが切れたか、このページを使う権限がありません。別のタブで/).waitFor();
  await shot(page, "4-logged-out");
  const other = await context.newPage();
  await other.goto(`${url}/${PAGE}`);
  await other.getByLabel("ユーザー").fill("tester");
  await other.getByLabel("パスワード").fill("pw");
  await other.getByRole("button", { name: "ログイン" }).click();
  await other.getByText("tester でログインしています").waitFor();
  await other.close();
  // 元のタブでそのまま続けられる（反映した後なので、今度は変わる行がない）。
  await page.getByRole("button", { name: "検証して差分を見る" }).click();
  await page.getByText("変わる行はありません。").waitFor();
  await context.close();
});

test("権限のない人は、画面も API も使えない", { skip }, async () => {
  const { context, page } = await open("guest");
  // フォーム認証は、権限のない人もログインの画面に回す。
  assert.match(page.url(), /Login\.aspx\?ReturnUrl=/);
  const res = await page.request.post(`${url}/${PAGE}/Describe`, {
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Patchiri": "1" },
    data: { req: { v: 1 } },
    maxRedirects: 0,
  });
  assert.notEqual(res.status(), 200);
  await context.close();
});
