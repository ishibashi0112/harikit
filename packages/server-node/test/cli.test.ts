// CLI（packages/cli）を、メモリ上の方言で動かしたサーバに向けて通す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Handlers } from "../src/index.js";
import { CONFIG, FakeDialect } from "./fake.js";

const CLI = fileURLToPath(new URL("../../../cli/dist/src/main.js", import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, PATCHIRI_SERVER: "", PATCHIRI_TOKEN: "", PATCHIRI_STYLE: "", ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

/** API 3 本だけを受け、届いたヘッダを残すサーバ。 */
async function startServer() {
  const dialect = new FakeDialect();
  const handlers = new Handlers({ config: CONFIG, dialect, whoAmI: () => "tester", log: async () => {} });
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const name = (req.url ?? "").replace(/^\/+/, "") as "describe" | "fetch" | "apply";
      void handlers.handle(name, JSON.parse(Buffer.concat(chunks).toString("utf8"))).then((body) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, dialect, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("CLI: 見出しの行、ヘッダ、JSON の出力、計画の指紋", async () => {
  const srv = await startServer();
  const dir = await mkdtemp(join(tmpdir(), "patchiri-cli-"));
  try {
    await writeFile(join(dir, "in.csv"), "単価改定 2026-10\nProductCode,UnitPrice\nA001,130\nA002,\n");
    const common = ["--server", srv.url, "--json"];
    const diff = await run(["diff", "in.csv", "-t", "product", "--header-row", "2", "--out", "out", "--header", "X-Test: 1", ...common], dir);
    assert.equal(diff.code, 0, diff.stderr);
    const d = JSON.parse(diff.stdout) as { ok: boolean; counts: Record<string, number>; digest: string; files: Record<string, string> };
    assert.equal(d.ok, true);
    assert.deepEqual(d.counts, { change: 1, same: 1, not_found: 0 });
    assert.match(d.digest, /^[0-9a-f]{64}$/);
    assert.equal(srv.seen[0]!["x-test"], "1");
    assert.match(diff.stderr, /指紋 [0-9a-f]{12}/);

    const planFile = join(dir, "out", "plan.json");
    const check = await run(["apply", planFile, ...common], dir);
    assert.equal(check.code, 0, check.stderr);
    assert.deepEqual(JSON.parse(check.stdout).digest, d.digest);
    assert.equal(srv.dialect.updates, 0);

    const wrong = await run(["apply", planFile, "--digest", "00000000", ...common], dir);
    assert.equal(wrong.code, 1);
    assert.match(JSON.parse(wrong.stdout).error.message, /--digest の 00000000 と合いません/);

    const plan = JSON.parse(await readFile(planFile, "utf8"));
    plan.request.changes[0].rows[0].after.UnitPrice = "1300.00";
    const tamperedFile = join(dir, "tampered.json");
    await writeFile(tamperedFile, JSON.stringify(plan));
    const tampered = await run(["apply", tamperedFile, ...common], dir);
    assert.equal(tampered.code, 1);
    assert.match(tampered.stderr, /指紋（[0-9a-f]{12}）と合いません/);
    assert.equal(srv.dialect.updates, 0);

    const exec = await run(["apply", planFile, "--execute", "--digest", d.digest.slice(0, 12), ...common], dir);
    assert.equal(exec.code, 0, exec.stderr);
    assert.deepEqual(JSON.parse(exec.stdout).updated, 1);
    assert.equal(srv.dialect.updates, 1);
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI: patchiri.cli.json の既定値。トークンは書けない", async () => {
  const srv = await startServer();
  const dir = await mkdtemp(join(tmpdir(), "patchiri-cli-"));
  try {
    await writeFile(join(dir, "patchiri.cli.json"), JSON.stringify({ server: srv.url, headers: { "X-From": "config" } }));
    const targets = await run(["targets", "--json"], dir);
    assert.equal(targets.code, 0, targets.stderr);
    assert.deepEqual(JSON.parse(targets.stdout).targets.map((t: { target: string }) => t.target), ["product", "category"]);
    assert.equal(srv.seen.at(-1)!["x-from"], "config");
    await writeFile(join(dir, "bad.json"), JSON.stringify({ server: srv.url, token: "x" }));
    const bad = await run(["targets", "--config", "bad.json"], dir);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /トークンは書けません/);

    // rules と out は設定ファイルのフォルダから見る。
    await mkdir(join(dir, "conf"));
    await writeFile(join(dir, "conf", "patchiri.cli.json"), JSON.stringify({ server: srv.url, rules: "r.json", out: "o" }));
    await writeFile(join(dir, "conf", "r.json"), JSON.stringify({ targets: { product: [{ column: "UnitPrice", greaterThan: 200 }] } }));
    await writeFile(join(dir, "in.csv"), "ProductCode,UnitPrice\nA001,130\n");
    const ruled = await run(["diff", "in.csv", "-t", "product", "--config", join("conf", "patchiri.cli.json"), "--json"], dir);
    assert.equal(ruled.code, 1, ruled.stderr);
    assert.equal(JSON.parse(ruled.stdout).out, join(dir, "conf", "o"));
    assert.match(await readFile(join(dir, "conf", "o", "issues.csv"), "utf8"), /200 より大きくしてください/);
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});
