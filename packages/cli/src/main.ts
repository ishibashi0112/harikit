#!/usr/bin/env node
// patchiri の CLI。
//   patchiri targets                         使えるターゲットの一覧
//   patchiri diff <file.xlsx|csv> -t product  検証して差分と反映計画（plan.json）を作る
//   patchiri apply <plan.json> [--execute]    反映する（既定は check: DB は変えずに確かめるだけ）

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildPlan,
  diffToCsv,
  groupReadings,
  PatchiriApiError,
  PatchiriClient,
  issuesToCsv,
  planDigest,
  prepare,
  readCsv,
  readingsToCsv,
  readXlsx,
  verifyPlan,
  type ApplyPlan,
  type ApplyRequest,
  type RulesConfig,
  type Sheet,
} from "patchiri-core";

const USAGE = `使い方:
  patchiri targets
  patchiri diff <file.xlsx|file.csv> --target <ターゲット> [--sheet <シート名>] [--header-row <行>] [--out <フォルダ>] [--encoding shift_jis]
               [--rules <業務ルールの JSON>]（省くと、今のフォルダの patchiri.rules.json があれば使う）
               [--strict]（Excel の表示の形（2024/4/1、¥1,200 など）を読み替えない）
  patchiri apply <plan.json> [--execute] [--note <メモ>] [--digest <承認した計画の指紋>]

共通: --server <URL>（既定 PATCHIRI_SERVER か http://127.0.0.1:7357）、--token <トークン>（既定 PATCHIRI_TOKEN）、
      --style rest|webmethod（既定 PATCHIRI_STYLE）、--header "名前: 値"（何度でも）、--json（結果を JSON で標準出力に）、
      --config <CLI の設定>（省くと、今のフォルダの patchiri.cli.json があれば使う）`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: "string", short: "t" },
    sheet: { type: "string" },
    "header-row": { type: "string" },
    strict: { type: "boolean" },
    out: { type: "string", short: "o" },
    encoding: { type: "string" },
    rules: { type: "string" },
    execute: { type: "boolean", default: false },
    note: { type: "string" },
    digest: { type: "string" },
    server: { type: "string" },
    token: { type: "string" },
    style: { type: "string" },
    header: { type: "string", multiple: true },
    json: { type: "boolean", default: false },
    config: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

/** CLI の設定（patchiri.cli.json）。コマンドのオプションが優先。トークンは書かない（PATCHIRI_TOKEN で渡す）。rules と out は設定ファイルのフォルダから。 */
interface CliConfig {
  server?: string;
  style?: "rest" | "webmethod";
  headers?: Record<string, string>;
  rules?: string;
  headerRow?: number;
  out?: string;
  /** false なら Excel の表示の形を読み替えない（--strict と同じ）。 */
  readDisplay?: boolean;
}

let cliConfig: CliConfig = {};

async function loadCliConfig(): Promise<void> {
  const path = values.config ?? "patchiri.cli.json";
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (values.config) throw new Error(`CLI の設定 ${path} が読めません: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const c = JSON.parse(text) as CliConfig & { token?: unknown };
  if (typeof c !== "object" || c === null) throw new Error(`CLI の設定 ${path} はオブジェクトにしてください`);
  if (c.token !== undefined) throw new Error(`CLI の設定 ${path} にトークンは書けません（PATCHIRI_TOKEN か --token で渡してください）`);
  // ファイルの場所は設定ファイルのフォルダから。
  for (const k of ["rules", "out"] as const) if (typeof c[k] === "string") c[k] = resolve(dirname(path), c[k]);
  cliConfig = c;
}

/** 人向けの出力。--json のときは標準エラーに出し、標準出力は JSON だけにする。 */
const say = (...args: unknown[]) => (values.json ? console.error(...args) : console.log(...args));

function printJson(value: unknown): void {
  if (values.json) console.log(JSON.stringify(value, null, 2));
}

/** --header "名前: 値" を集める（設定ファイルの headers に重ねる）。 */
function headers(): Record<string, string> {
  const out: Record<string, string> = { ...cliConfig.headers };
  for (const h of values.header ?? []) {
    const i = h.indexOf(":");
    if (i <= 0) throw new Error(`--header は "名前: 値" の形です: ${h}`);
    out[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return out;
}

/** 見出しの行（1 始まりで受け、0 始まりにする）。 */
function headerRow(): number | undefined {
  const raw = values["header-row"] ?? cliConfig.headerRow;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error("--header-row は 1 以上の行の番号です");
  return n - 1;
}

/** 指紋の短い形（画面と出力に出す）。 */
const shortDigest = (d: string) => d.slice(0, 12);

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function client(): PatchiriClient {
  const style = values.style ?? (process.env.PATCHIRI_STYLE || cliConfig.style) ?? "rest";
  if (style !== "rest" && style !== "webmethod") throw new Error("--style は rest か webmethod です");
  const token = values.token ?? (process.env.PATCHIRI_TOKEN || undefined);
  const extra = headers();
  return new PatchiriClient({
    baseUrl: values.server ?? (process.env.PATCHIRI_SERVER || cliConfig.server) ?? "http://127.0.0.1:7357",
    style,
    ...(token && { token }),
    ...(Object.keys(extra).length > 0 && { headers: extra }),
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
  let path = values.rules ?? cliConfig.rules;
  if (!path) {
    try {
      await access("patchiri.rules.json");
      path = "patchiri.rules.json";
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
  for (const t of res.targets) say(`${t.target}\t${t.access}\t${t.table}`);
  printJson({ ok: true, targets: res.targets });
  return 0;
}

async function cmdDiff(file: string | undefined): Promise<number> {
  if (!file || !values.target) throw new Error(USAGE);
  const sheet = await readSheet(file);
  const rules = await readRules();
  if (rules) say(`業務ルール: ${rules.path}`);
  const row = headerRow();
  const readDisplay = values.strict ? false : cliConfig.readDisplay;
  const result = await prepare(client(), values.target, sheet, {
    ...(rules && { rules: rules.config }),
    ...(row !== undefined && { headerRow: row }),
    ...(readDisplay !== undefined && { readDisplay }),
  });
  if (result.description.rules) say(`サーバの業務ルール: ${result.description.rules.length} 件`);
  const out = values.out ?? cliConfig.out ?? join("patchiri-out", `${values.target}-${stamp()}`);
  await mkdir(out, { recursive: true });
  const files: Record<string, string> = {};

  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");
  if (result.issues.length > 0) await writeFile((files.issues = join(out, "issues.csv")), issuesToCsv(result.issues));
  for (const i of result.issues.slice(0, 20)) say(`${i.severity === "error" ? "エラー" : "警告"}\t${i.cell ?? "-"}\t${i.message}`);
  if (result.issues.length > 20) say(`…ほか ${result.issues.length - 20} 件（issues.csv を見てください）`);

  const readings = result.validation.readings;
  if (readings.length > 0) {
    await writeFile((files.readings = join(out, "readings.csv")), readingsToCsv(readings));
    say(`\nExcel の表示から読み替えたセル ${readings.length} 個（${join(out, "readings.csv")}）`);
    for (const g of groupReadings(readings)) say(`  ${g.column}\t${g.count} 個\t例 ${g.first.cell}: ${g.first.text} → ${String(g.first.value)}`);
  }

  const summary = { errors: errors.length, warnings: warnings.length, readings: readings.length };
  if (!result.ok || !result.diff) {
    say(`\nエラーが ${errors.length} 件あるので、差分は作っていません: ${join(out, "issues.csv")}`);
    printJson({ ok: false, target: values.target, out, ...summary, files });
    return 1;
  }
  const d = result.diff;
  await writeFile((files.diff = join(out, "diff.csv")), diffToCsv(d));
  const plan = buildPlan(d, basename(file));
  await writeFile((files.plan = join(out, "plan.json")), JSON.stringify(plan, null, 2) + "\n");
  say(`\n変わる ${d.counts.change} 行、同じ ${d.counts.same} 行、キーなし ${d.counts.not_found} 行${warnings.length ? `（警告 ${warnings.length} 件）` : ""}`);
  say(`差分: ${join(out, "diff.csv")}`);
  say(`反映計画: ${join(out, "plan.json")}（指紋 ${shortDigest(plan.digest!)}）`);
  if (d.counts.change > 0) say(`\n承認が済んだら: patchiri apply ${join(out, "plan.json")} で確認、--execute で反映`);
  printJson({ ok: true, target: values.target, out, counts: d.counts, ...summary, digest: plan.digest, files });
  return 0;
}

async function cmdApply(planFile: string | undefined): Promise<number> {
  if (!planFile) throw new Error(USAGE);
  const plan = JSON.parse(await readFile(planFile, "utf8")) as ApplyPlan;
  if (plan.patchiriPlan !== 1) throw new Error(`${planFile} は patchiri の反映計画ではありません`);
  // 承認した後に計画が書き換えられていないかを、指紋で確かめる。
  if (verifyPlan(plan) === false) throw new Error(`${planFile} の中身が、作ったときの指紋（${shortDigest(plan.digest!)}）と合いません。書き換えられていないか確かめてください`);
  const digest = plan.digest ?? planDigest(plan.request);
  if (values.digest !== undefined) {
    const want = values.digest.trim().toLowerCase();
    if (!/^[0-9a-f]{8,64}$/.test(want)) throw new Error("--digest は計画の指紋（16 進 8〜64 桁）です");
    if (!digest.startsWith(want)) throw new Error(`計画の指紋 ${shortDigest(digest)} が、--digest の ${want} と合いません。承認した計画か確かめてください`);
  }
  const rows = plan.request.changes[0]?.rows.length ?? 0;
  if (rows === 0) {
    say("変わる行がないので、反映するものはありません");
    printJson({ ok: true, mode: values.execute ? "execute" : "check", rows: 0, digest });
    return 0;
  }
  const mode = values.execute ? "execute" : "check";
  const note = values.note ?? plan.request.note;
  const { v: _, ...req } = { ...plan.request, mode, ...(note !== undefined && { note }) } as ApplyRequest;
  const res = await client().apply(req);
  const dir = dirname(planFile);
  const files: Record<string, string> = { result: join(dir, `result-${mode}.json`) };
  await writeFile(files.result!, JSON.stringify(res, null, 2) + "\n");
  if (!res.ok) {
    say(`止めました: ${res.error.message}`);
    for (const c of res.conflicts ?? []) say(`  衝突\t${JSON.stringify(c.key)}\t${c.reason}${c.current ? `\t今の値 ${JSON.stringify(c.current)}` : ""}`);
    for (const e of res.rowErrors ?? []) say(`  誤り\t${e.index} 番目\t${e.code}\t${e.column ?? ""}\t${e.message ?? ""}`);
    if (res.conflicts?.length) say("\n差分を取った後に DB が変わっています。patchiri diff からやり直してください。");
    printJson({ ok: false, mode, digest, error: res.error, conflicts: res.conflicts ?? [], rowErrors: res.rowErrors ?? [], files });
    return 1;
  }
  await writeFile((files.script = join(dir, mode === "execute" ? "applied.sql" : "check.sql")), res.script);
  await writeFile((files.undo = join(dir, "undo.sql")), res.undoScript);
  const updated = res.results.reduce((n, r) => n + r.updated, 0);
  if (mode === "execute") say(`反映しました: ${updated} 行（${res.appliedBy}、${res.appliedAt}、計画の指紋 ${shortDigest(digest)}）`);
  else say(`確かめました: ${rows} 行とも差分どおりで、反映できます（DB は変えていません。計画の指紋 ${shortDigest(digest)}）`);
  say(`SQL: ${files.script}`);
  say(`戻し SQL: ${files.undo}`);
  if (mode === "check") say(`\n反映するには: patchiri apply ${planFile} --execute`);
  printJson({ ok: true, mode, rows, updated, appliedBy: res.appliedBy, appliedAt: res.appliedAt, requestId: res.requestId, digest, files });
  return 0;
}

async function main(): Promise<number> {
  const [cmd, arg] = positionals;
  await loadCliConfig();
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
    const message = e instanceof PatchiriApiError ? `サーバ: ${e.failure.error.message}（${e.failure.error.code}）` : e instanceof Error ? e.message : String(e);
    console.error(message);
    printJson({ ok: false, error: { code: e instanceof PatchiriApiError ? e.failure.error.code : "cli_error", message } });
    process.exit(1);
  },
);
