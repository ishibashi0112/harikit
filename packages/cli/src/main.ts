#!/usr/bin/env node
// harikit の CLI。
//   harikit targets                         使えるターゲットの一覧
//   harikit diff <file.xlsx|csv> -t product  検証して差分と反映計画（plan.json）を作る
//   harikit apply <plan.json> [--execute]    反映する（既定は check: DB は変えずに確かめるだけ）

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  buildApplyRequest,
  diffToCsv,
  HarikitApiError,
  HarikitClient,
  issuesToCsv,
  prepare,
  readCsv,
  readXlsx,
  type ApplyRequest,
  type RulesConfig,
  type Sheet,
} from "@harikit/core";

interface Plan {
  harikitPlan: 1;
  createdAt: string;
  source: string;
  target: string;
  counts: Record<string, number>;
  request: ApplyRequest;
}

const USAGE = `使い方:
  harikit targets
  harikit diff <file.xlsx|file.csv> --target <ターゲット> [--sheet <シート名>] [--out <フォルダ>] [--encoding shift_jis]
               [--rules <業務ルールの JSON>]（省くと、今のフォルダの harikit.rules.json があれば使う）
  harikit apply <plan.json> [--execute] [--note <メモ>]

共通: --server <URL>（既定 HARIKIT_SERVER か http://127.0.0.1:7357）、--token <トークン>（既定 HARIKIT_TOKEN）、--style rest|webmethod`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: "string", short: "t" },
    sheet: { type: "string" },
    out: { type: "string", short: "o" },
    encoding: { type: "string" },
    rules: { type: "string" },
    execute: { type: "boolean", default: false },
    note: { type: "string" },
    server: { type: "string" },
    token: { type: "string" },
    style: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function client(): HarikitClient {
  const style = values.style ?? "rest";
  if (style !== "rest" && style !== "webmethod") throw new Error("--style は rest か webmethod です");
  const token = values.token ?? process.env.HARIKIT_TOKEN;
  return new HarikitClient({
    baseUrl: values.server ?? process.env.HARIKIT_SERVER ?? "http://127.0.0.1:7357",
    style,
    ...(token && { token }),
  });
}

async function readSheet(file: string): Promise<Sheet> {
  const data = await readFile(file);
  if (extname(file).toLowerCase() === ".csv") return readCsv(data, values.encoding ?? "utf-8", basename(file));
  const sheets = await readXlsx(data);
  const sheet = values.sheet ? sheets.find((s) => s.name === values.sheet) : sheets[0];
  if (!sheet) throw new Error(values.sheet ? `シート「${values.sheet}」がありません` : "シートがありません");
  return sheet;
}

async function readRules(): Promise<{ path: string; config: RulesConfig } | undefined> {
  let path = values.rules;
  if (!path) {
    try {
      await access("harikit.rules.json");
      path = "harikit.rules.json";
    } catch {
      return undefined;
    }
  }
  try {
    return { path, config: JSON.parse(await readFile(path, "utf8")) as RulesConfig };
  } catch (e) {
    throw new Error(`業務ルール ${path} が読めません: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function cmdTargets(): Promise<number> {
  const res = await client().targets();
  for (const t of res.targets) console.log(`${t.target}\t${t.access}\t${t.table}`);
  return 0;
}

async function cmdDiff(file: string | undefined): Promise<number> {
  if (!file || !values.target) throw new Error(USAGE);
  const sheet = await readSheet(file);
  const rules = await readRules();
  if (rules) console.log(`業務ルール: ${rules.path}`);
  const result = await prepare(client(), values.target, sheet, rules ? { rules: rules.config } : {});
  const out = values.out ?? join("harikit-out", `${values.target}-${stamp()}`);
  await mkdir(out, { recursive: true });

  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");
  if (result.issues.length > 0) await writeFile(join(out, "issues.csv"), issuesToCsv(result.issues));
  for (const i of result.issues.slice(0, 20)) console.log(`${i.severity === "error" ? "エラー" : "警告"}\t${i.cell ?? "-"}\t${i.message}`);
  if (result.issues.length > 20) console.log(`…ほか ${result.issues.length - 20} 件（issues.csv を見てください）`);

  if (!result.ok || !result.diff) {
    console.log(`\nエラーが ${errors.length} 件あるので、差分は作っていません: ${join(out, "issues.csv")}`);
    return 1;
  }
  const d = result.diff;
  await writeFile(join(out, "diff.csv"), diffToCsv(d));
  const request = buildApplyRequest(d, { mode: "check" });
  const plan: Plan = { harikitPlan: 1, createdAt: new Date().toISOString(), source: basename(file), target: d.target, counts: d.counts, request };
  await writeFile(join(out, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  console.log(`\n変わる ${d.counts.change} 行、同じ ${d.counts.same} 行、キーなし ${d.counts.not_found} 行${warnings.length ? `（警告 ${warnings.length} 件）` : ""}`);
  console.log(`差分: ${join(out, "diff.csv")}`);
  console.log(`反映計画: ${join(out, "plan.json")}`);
  if (d.counts.change > 0) console.log(`\n承認が済んだら: harikit apply ${join(out, "plan.json")} で確認、--execute で反映`);
  return 0;
}

async function cmdApply(planFile: string | undefined): Promise<number> {
  if (!planFile) throw new Error(USAGE);
  const plan = JSON.parse(await readFile(planFile, "utf8")) as Plan;
  if (plan.harikitPlan !== 1) throw new Error(`${planFile} は harikit の反映計画ではありません`);
  const rows = plan.request.changes[0]?.rows.length ?? 0;
  if (rows === 0) {
    console.log("変わる行がないので、反映するものはありません");
    return 0;
  }
  const mode = values.execute ? "execute" : "check";
  const note = values.note ?? plan.request.note;
  const { v: _, ...req } = { ...plan.request, mode, ...(note !== undefined && { note }) } as ApplyRequest;
  const res = await client().apply(req);
  const dir = dirname(planFile);
  await writeFile(join(dir, `result-${mode}.json`), JSON.stringify(res, null, 2) + "\n");
  if (!res.ok) {
    console.log(`止めました: ${res.error.message}`);
    for (const c of res.conflicts ?? []) console.log(`  衝突\t${JSON.stringify(c.key)}\t${c.reason}${c.current ? `\t今の値 ${JSON.stringify(c.current)}` : ""}`);
    for (const e of res.rowErrors ?? []) console.log(`  誤り\t${e.index} 番目\t${e.code}\t${e.column ?? ""}\t${e.message ?? ""}`);
    if (res.conflicts?.length) console.log("\n差分を取った後に DB が変わっています。harikit diff からやり直してください。");
    return 1;
  }
  await writeFile(join(dir, mode === "execute" ? "applied.sql" : "check.sql"), res.script);
  await writeFile(join(dir, "undo.sql"), res.undoScript);
  const updated = res.results.reduce((n, r) => n + r.updated, 0);
  if (mode === "execute") console.log(`反映しました: ${updated} 行（${res.appliedBy}、${res.appliedAt}）`);
  else console.log(`確かめました: ${rows} 行とも差分どおりで、反映できます（DB は変えていません）`);
  console.log(`SQL: ${join(dir, mode === "execute" ? "applied.sql" : "check.sql")}`);
  console.log(`戻し SQL: ${join(dir, "undo.sql")}`);
  if (mode === "check") console.log(`\n反映するには: harikit apply ${planFile} --execute`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, arg] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  if (cmd === "targets") return cmdTargets();
  if (cmd === "diff") return cmdDiff(arg);
  if (cmd === "apply") return cmdApply(arg);
  console.log(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof HarikitApiError ? `サーバ: ${e.failure.error.message}（${e.failure.error.code}）` : e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
