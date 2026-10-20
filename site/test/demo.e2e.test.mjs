// デモを本物のブラウザ（Chromium）で通しで動かす。ビルドした site/dist を配って、
// 貼る → 検証 → 差分 → 確かめる → ほかの人が書き換えて止まる → やり直して反映 → 戻し SQL で戻す、を確かめる。
//   npm run build:site && npm run test:site
// Chromium は Playwright のもの（npx playwright install chromium）。別のものを使うときは PATCHIRI_TEST_CHROMIUM にパスを渡す。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".svg": "image/svg+xml",
};

let server;
let browser;
let base;

before(async () => {
  server = createServer(async (req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (path.endsWith("/")) path += "index.html";
    try {
      const body = await readFile(join(dist, path));
      res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.PATCHIRI_TEST_CHROMIUM ? { executablePath: process.env.PATCHIRI_TEST_CHROMIUM } : {});
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function openDemo() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "ja-JP" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/demo/`);
  await page.getByRole("button", { name: "サンプル ▾" }).waitFor({ timeout: 60_000 });
  return { page, errors };
}

async function pickSample(page, name) {
  await page.getByRole("button", { name: "サンプル ▾" }).click();
  await page.getByRole("menuitem", { name }).click();
}

async function prepare(page) {
  await page.getByRole("button", { name: "検証して差分を見る" }).click();
  await page.locator(".pt-summary").waitFor();
}

async function apply(page, mode) {
  if (mode === "check") return page.getByRole("button", { name: "DB で確かめる" }).click();
  await page.getByRole("button", { name: "反映する" }).first().click();
  await page.locator(".pt-confirm").getByRole("button", { name: "反映する" }).click();
}

test("価格改定のサンプルを反映して、戻し SQL で戻す", async () => {
  const { page, errors } = await openDemo();
  await pickSample(page, /価格改定/);
  await prepare(page);
  const counts = await page.locator(".pt-count strong").allTextContents();
  assert.deepEqual(counts, ["7", "2", "1"], "変わる・同じ・キーなし");

  await apply(page, "check");
  await page.getByText("7 行とも差分どおりで、反映できます").waitFor();

  // patchiri の外で差分の行が変わると、反映は何もせずに止まる。
  await page.getByRole("button", { name: "ほかの人が書き換える" }).click();
  await apply(page, "execute");
  await page.getByText(/1 行が差分を取った後に変わっていた/).waitFor();

  // やり直せば反映できる。
  await prepare(page);
  await apply(page, "check");
  await page.getByText("7 行とも差分どおりで、反映できます").waitFor();
  await apply(page, "execute");
  await page.getByText(/反映しました: 7 行/).waitFor();

  await page.getByRole("button", { name: "DB の中身", exact: true }).click();
  await page.getByText(/今 \d+ 個/).waitFor();
  await page.getByRole("tab", { name: "SQL を流す" }).click();
  await page.getByRole("button", { name: "直近の戻し SQL を入れる" }).click();
  await page.getByRole("button", { name: "流す", exact: true }).click();
  await page.getByText(/7 \/ 7 行を戻しました/).waitFor();

  // 戻した後は、DB を作ったときから変わったのは「ほかの人」が変えた 1 個だけ。
  await page.getByRole("tab", { name: /m_product/ }).click();
  await page.getByText("今 1 個").waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test("誤りのあるサンプルは差分を作らずにセルを示す", async () => {
  const { page, errors } = await openDemo();
  await pickSample(page, /誤りあり/);
  await prepare(page);
  await page.getByText(/エラーが 7 件あるので、差分は作っていません/).waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});
