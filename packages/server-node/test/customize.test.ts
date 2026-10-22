// 許可リストのカスタマイズの口（labels、stamp、scope、roles、rules）と、whoAmI / isInRole の差し替え、同梱の画面の設定（screen）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkConfig,
  createHttpServer,
  Handlers,
  loadConfig,
  screenPage,
  startServer,
  Unauthenticated,
  type ApplyLogEntry,
  type HandlerDeps,
  type ServerConfig,
  type TableMeta,
} from "../src/index.js";
import { CONFIG, FakeDialect } from "./fake.js";

const TERM: TableMeta = {
  table: "dbo.M_Term",
  columns: [
    { name: "Company", type: "string", dbType: "varchar(3)", maxLength: 3, nullable: false },
    { name: "Code", type: "string", dbType: "varchar(4)", maxLength: 4, nullable: false },
    { name: "Kind", type: "string", dbType: "varchar(1)", maxLength: 1, nullable: false },
    { name: "StartDate", type: "date", dbType: "date", nullable: false },
    { name: "EndDate", type: "date", dbType: "date", nullable: true },
    { name: "Price", type: "decimal", dbType: "decimal(9,2)", precision: 9, scale: 2, nullable: true },
    { name: "UpdatedAt", type: "datetime", dbType: "datetime2(3)", scale: 3, nullable: true },
    { name: "UpdatedBy", type: "string", dbType: "varchar(8)", maxLength: 8, nullable: true },
  ],
  primaryKey: ["Company", "Code"],
  foreignKeys: [],
};

const TERM_CONFIG: ServerConfig = {
  ...CONFIG,
  targets: {
    ...CONFIG.targets,
    term: {
      table: "dbo.M_Term",
      access: "update",
      key: ["Code"],
      readable: ["Code", "Kind", "StartDate", "EndDate", "Price"],
      updatable: ["StartDate", "EndDate", "Price"],
      labels: { Price: "単価", StartDate: "開始日" },
      stamp: { UpdatedAt: "now", UpdatedBy: "user" },
      scope: { Company: "001" },
    },
  },
  rules: {
    targets: {
      term: [
        { column: "Price", min: 0 },
        { column: "Price", maxChangePercent: 50 },
        { column: "EndDate", min: { column: "StartDate" }, message: "終了日は開始日より後にしてください" },
        { column: "Price", max: 0, when: { column: "Kind", equals: "9" } },
        { column: "Price", max: 1000, severity: "warning" },
      ],
    },
  },
};

function setup(deps: Partial<HandlerDeps> = {}, config: ServerConfig = TERM_CONFIG) {
  const dialect = new FakeDialect();
  dialect.metas["dbo.m_term"] = TERM;
  dialect.tables["dbo.m_term"] = [
    { Company: "001", Code: "T1", Kind: "1", StartDate: "2026-04-01", EndDate: "2026-09-30", Price: "100.00", UpdatedAt: "2026-01-05T10:00:00.000", UpdatedBy: "old" },
    { Company: "001", Code: "T9", Kind: "9", StartDate: "2026-04-01", EndDate: null, Price: null, UpdatedAt: null, UpdatedBy: null },
    { Company: "002", Code: "T2", Kind: "1", StartDate: "2026-04-01", EndDate: null, Price: "500.00", UpdatedAt: null, UpdatedBy: null },
  ];
  const logs: ApplyLogEntry[] = [];
  const handlers = new Handlers({ config, dialect, whoAmI: () => "tester", log: async (e) => void logs.push(e), ...deps });
  return { dialect, logs, handlers };
}

const ID = "6f1c2a8e-3b0d-4e7a-9c55-1d2e3f4a5b6c";
const apply = (rows: unknown[], mode = "execute", requestId = ID) => ({ v: 1, requestId, mode, changes: [{ target: "term", rows }] });
const code = (res: Record<string, unknown>) => (res.error as { code: string } | undefined)?.code;

test("describe: 表示名、stamp、scope、サーバの業務ルール", async () => {
  const { handlers } = setup();
  const d = await handlers.handle("describe", { v: 1, target: "term" });
  assert.equal(d.ok, true, JSON.stringify(d));
  const cols = d.columns as { name: string; label?: string }[];
  assert.deepEqual(cols.map((c) => [c.name, c.label]), [["Code", undefined], ["Kind", undefined], ["StartDate", "開始日"], ["EndDate", undefined], ["Price", "単価"]]);
  assert.deepEqual(d.stamp, [{ column: "UpdatedAt", value: "now" }, { column: "UpdatedBy", value: "user" }]);
  assert.deepEqual(d.scope, { Company: "001" });
  assert.equal((d.rules as unknown[]).length, 5);
  // ルールを書いていないターゲットには rules を返さない。
  assert.equal((await handlers.handle("describe", { v: 1, target: "product" })).rules, undefined);
});

test("scope: 外の行は fetch で見えず、apply は not_found", async () => {
  const { handlers, dialect } = setup();
  const res = await handlers.handle("fetch", { v: 1, target: "term", keys: [{ Code: "T1" }, { Code: "T2" }], columns: ["Price"] });
  // 値にはキーと頼んだ列だけ（scope の列は出さない）。
  assert.deepEqual(res.rows, [{ index: 0, found: true, values: { Code: "T1", Price: "100.00" } }, { index: 1, found: false }]);
  const out = await handlers.handle("apply", apply([{ key: { Code: "T2" }, before: { Price: "500.00" }, after: { Price: "600.00" } }]));
  assert.equal(code(out), "conflict");
  assert.deepEqual(out.conflicts, [{ target: "term", index: 0, key: { Code: "T2" }, reason: "not_found" }]);
  assert.equal(dialect.updates, 0);
});

test("scope: キー列に書いたら、その値と厳密に同じキーだけ", async () => {
  const config: ServerConfig = { ...TERM_CONFIG, rules: undefined, targets: { term: { ...TERM_CONFIG.targets.term!, key: undefined, readable: ["Company", "Code", "Price"], updatable: ["Price"], labels: undefined } } };
  config.targets.term!.scope = { Company: "A01" };
  const { handlers, dialect } = setup({}, config);
  dialect.tables["dbo.m_term"]![0]!.Company = "A01";
  // DB の比べ方（ここでは大文字小文字を問わない）で同じでも、scope の値と違えば外。
  const res = await handlers.handle("fetch", { v: 1, target: "term", keys: [{ Company: "A01", Code: "T1" }, { Company: "002", Code: "T2" }, { Company: "a01", Code: "T1" }] });
  assert.deepEqual((res.rows as { found: boolean }[]).map((r) => r.found), [true, false, false], JSON.stringify(res));
});

test("stamp: 反映した時刻と人を入れ、戻し SQL は前の値に戻す", async () => {
  const { handlers, dialect, logs } = setup({ whoAmI: () => "E1234" });
  const res = await handlers.handle("apply", apply([{ key: { Code: "T1" }, before: { Price: "100.00" }, after: { Price: "120.00" } }]));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.appliedBy, "E1234");
  const row = dialect.tables["dbo.m_term"]![0]!;
  assert.equal(row.Price, "120.00");
  assert.equal(row.UpdatedAt, dialect.clock);
  assert.equal(row.UpdatedBy, "E1234");
  // 反映する SQL は DB の時刻の式、戻し SQL は前の値（ロックして読んだもの）。条件はデータの列だけ。
  assert.match(res.script as string, /SET \{"Price":"120.00","UpdatedBy":"E1234"\} NOW UpdatedAt WHERE \{"Code":"T1","Company":"001","Price":"100.00"\}/);
  assert.match(res.undoScript as string, /SET \{"Price":"100.00","UpdatedAt":"2026-01-05T10:00:00.000","UpdatedBy":"old"\} WHERE \{"Code":"T1","Company":"001","Price":"120.00"\}/);
  assert.deepEqual(logs[0]!.rows[0]!.stampBefore, { UpdatedAt: "2026-01-05T10:00:00.000", UpdatedBy: "old" });
});

test("stamp: 反映した人の名前が列に入らなければ、DB に触る前に止める", async () => {
  const { handlers, dialect } = setup({ whoAmI: () => "DOMAIN\\long-user" });
  const res = await handlers.handle("apply", apply([{ key: { Code: "T1" }, before: { Price: "100.00" }, after: { Price: "120.00" } }], "check"));
  assert.equal(code(res), "bad_request");
  assert.match((res.error as { message: string }).message, /stamp の列 UpdatedBy に入りません/);
  assert.equal(dialect.updates, 0);
});

test("サーバの業務ルール: error のルールだけを、反映した後の行で見る", async () => {
  const { handlers, dialect } = setup();
  const errors = async (rows: unknown[]) => {
    const res = await handlers.handle("apply", apply(rows, "check"));
    return res.ok ? [] : (res.rowErrors as { index: number; code: string; column: string; message: string }[]);
  };
  // 開始日だけを変えても、DB の終了日と比べる。
  assert.deepEqual(await errors([{ key: { Code: "T1" }, before: { StartDate: "2026-04-01" }, after: { StartDate: "2026-10-01" } }]), [
    { target: "term", index: 0, code: "rule_violation", column: "StartDate", message: "終了日は開始日より後にしてください" },
  ]);
  // 変動率、when の付いたルール（区分が 9 の行だけ）。warning のルール（1000 以下）は見ない。
  const e = await errors([
    { key: { Code: "T1" }, before: { Price: "100.00" }, after: { Price: "2000.00" } },
    { key: { Code: "T9" }, before: { Price: null }, after: { Price: "1.00" } },
  ]);
  assert.deepEqual(e.map((x) => [x.index, x.column]), [[0, "Price"], [1, "Price"]]);
  assert.match(e[0]!.message, /50/);
  assert.match(e[1]!.message, /0 以下/);
  assert.deepEqual(await errors([{ key: { Code: "T1" }, before: { Price: "100.00" }, after: { Price: "120.00" } }]), []);
  assert.equal(dialect.updates, 0);
});

test("roles: 一覧に出さず、使えば forbidden。判定の手段がなければ閉じる", async () => {
  const config: ServerConfig = { ...CONFIG, targets: { ...CONFIG.targets, category: { ...CONFIG.targets.category!, roles: ["Master"] } } };
  const closed = setup({}, config).handlers;
  assert.deepEqual(((await closed.handle("describe", { v: 1 })).targets as { target: string }[]).map((t) => t.target), ["product"]);
  assert.equal(code(await closed.handle("describe", { v: 1, target: "category" })), "forbidden");
  assert.equal(code(await closed.handle("fetch", { v: 1, target: "category", keys: [] })), "forbidden");
  // 参照先が使えないときは「確かめられない」（referencedTarget が null）。
  const product = await closed.handle("describe", { v: 1, target: "product" });
  assert.equal((product.foreignKeys as { referencedTarget: string | null }[])[0]!.referencedTarget, null);

  const seen: unknown[] = [];
  const open = setup({ isInRole: (role, ctx) => (seen.push(ctx), role === "Master") }, config).handlers;
  const ctx = { req: { headers: { "x-user": "u1" } } };
  assert.equal((await open.handle("describe", { v: 1, target: "category" }, ctx)).ok, true);
  assert.equal(seen[0], ctx);
});

test("whoAmI: 文脈を受け取り、名前を返さなければ Unauthenticated（HTTP は 401）", async () => {
  const { handlers } = setup({ whoAmI: (ctx) => (ctx.req?.headers["x-user"] as string | undefined) ?? null });
  await assert.rejects(handlers.handle("describe", { v: 1 }), Unauthenticated);
  const res = await handlers.handle("apply", apply([{ key: { Code: "T1" }, before: { Price: "100.00" }, after: { Price: "120.00" } }]), { req: { headers: { "x-user": "u1" } } });
  assert.equal(res.appliedBy, "u1");

  const server = createHttpServer(handlers, { token: "t" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as { port: number };
    const call = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/describe`, { method: "POST", headers: { Authorization: "Bearer t", "X-Patchiri": "1", "Content-Type": "application/json", ...headers }, body: '{"v":1}' });
    assert.equal((await call({})).status, 401);
    const ok = await call({ "X-User": "u1" });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { ok: boolean }).ok, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("設定の誤り: labels、stamp、scope、roles、rules、lockWaitSeconds", () => {
  const term = TERM_CONFIG.targets.term!;
  const bad = (patch: Partial<typeof term>, top: Partial<ServerConfig> = {}) => () => checkConfig({ ...TERM_CONFIG, ...top, targets: { term: { ...term, ...patch } } });
  assert.throws(bad({ labels: { Nope: "x" } }), /labels の Nope が readable にありません/);
  assert.throws(bad({ labels: { Price: "kind" } }), /labels の kind が Kind とぶつかります/);
  assert.throws(bad({ labels: { Price: "金額", EndDate: "金額" } }), /ぶつかります/);
  assert.throws(bad({ stamp: { Price: "now" } }), /updatable にもあります/);
  assert.throws(bad({ stamp: { Code: "user" } }), /キー列 Code は stamp にできません/);
  assert.throws(bad({ stamp: { UpdatedAt: "today" as "now" } }), /"now" か "user"/);
  assert.throws(bad({ scope: { Price: "1" } }), /範囲の列は変えられません/);
  assert.throws(bad({ scope: { Company: null as unknown as string } }), /文字列、数、true \/ false/);
  assert.throws(bad({ roles: [] }), /roles はロールの名前の配列です/);
  assert.throws(bad({}, { rules: { targets: { nope: [] } } }), /rules.targets の nope は targets にありません/);
  assert.throws(bad({}, { rules: "rules.json" }), /ファイルの中身にしてから/);
  assert.throws(bad({}, { lockWaitSeconds: 5, database: { ...TERM_CONFIG.database, lockWaitSeconds: 10 } }), /違います/);
  assert.doesNotThrow(bad({}, { lockWaitSeconds: 5 }));
});

test("許可リストと DB が合わない stamp・scope・rules は internal_error（ログに理由）", async () => {
  const errors: unknown[] = [];
  const term = TERM_CONFIG.targets.term!;
  const run = async (patch: Partial<typeof term>, top: Partial<ServerConfig> = {}) => {
    const { handlers } = setup({ logError: (e) => errors.push(e) }, { ...TERM_CONFIG, ...top, targets: { term: { ...term, ...patch } } });
    const res = await handlers.handle("describe", { v: 1, target: "term" });
    return [code(res), String(errors.at(-1))];
  };
  assert.deepEqual((await run({ stamp: { Kind: "now" } }))[0], "internal_error");
  assert.match((await run({ stamp: { Kind: "now" } }))[1]!, /日付・時刻の列ではありません/);
  assert.match((await run({ stamp: { StartDate: "user" } as Record<string, "user"> }))[1]!, /updatable にも|文字列の列ではありません/);
  assert.match((await run({ scope: { Company: "0001" } }))[1]!, /scope.Company の値が列に合いません/);
  assert.match((await run({}, { rules: { targets: { term: [{ column: "Nope", min: 0 }] } } }))[1]!, /rules.targets.term の誤り/);
});

test("画面の設定: screen を index.html のタイトルと data- 属性、足す CSS にする", async () => {
  const html = '<!doctype html><html><head><title>patchiri</title></head><body><div id="root"></div></body></html>';
  assert.equal(screenPage(html, {}, null), html);
  const page = screenPage(html, { title: 'A&B "$&" 更新', theme: "dark", noteRequired: "依頼番号", excel: false }, ".pt-app { --pt-accent: red } /* </style> */");
  assert.match(page, /<title>A&amp;B &quot;\$&amp;&quot; 更新<\/title>/);
  assert.match(page, /<div id="root" data-title="A&amp;B &quot;\$&amp;&quot; 更新" data-theme="dark" data-note-required="依頼番号" data-excel="false"><\/div>/);
  assert.match(page, /<style>\n\.pt-app \{ --pt-accent: red \} \/\* <\\\/style> \*\/\n<\/style>/);
  assert.match(screenPage(html, { noteRequired: true, theme: "auto", excel: true }, null), /<div id="root" data-note-required="true"><\/div>/);

  // 設定ファイルから: css は設定ファイルのフォルダから読み、Node 版が配る画面に入る。
  const dir = await mkdtemp(join(tmpdir(), "patchiri-screen-"));
  const web = join(dir, "web");
  await writeFile(join(dir, "patchiri.screen.css"), ".pt-app { --pt-accent: #0b7a75 }");
  await mkdir(web);
  await writeFile(join(web, "index.html"), html);
  await writeFile(join(dir, "patchiri.config.json"), JSON.stringify({ ...CONFIG, listen: { port: 0 }, screen: { title: "単価の更新", css: "patchiri.screen.css" } }));
  const config = await loadConfig(join(dir, "patchiri.config.json"));
  assert.equal(config.screen?.css, join(dir, "patchiri.screen.css"));
  const server = await startServer(config, { dialect: new FakeDialect(), web, token: "t" });
  try {
    const res = await fetch(`${server.url}/`);
    const body = await res.text();
    assert.match(body, /<title>単価の更新<\/title>/);
    assert.match(body, /data-title="単価の更新"/);
    assert.match(body, /--pt-accent: #0b7a75/);
    assert.equal(await (await fetch(`${server.url}/index.html`)).text(), body);
  } finally {
    await server.close();
  }
  // CSS のファイルが読めなければ起動しない。
  await assert.rejects(startServer({ ...config, screen: { css: join(dir, "nothing.css") } }, { dialect: new FakeDialect(), web, token: "t" }), /screen.css のファイル .* が読めません/);
});

test("設定の誤り: screen", () => {
  const bad = (screen: unknown) => () => checkConfig({ ...CONFIG, screen } as ServerConfig);
  assert.throws(bad("x"), /screen は/);
  assert.throws(bad({ titel: "x" }), /screen.titel という項目はありません/);
  assert.throws(bad({ title: " " }), /screen.title は空でない文字列です/);
  assert.throws(bad({ theme: "blue" }), /screen.theme は/);
  assert.throws(bad({ noteRequired: "" }), /screen.noteRequired は/);
  assert.throws(bad({ excel: "yes" }), /screen.excel は true \/ false です/);
  assert.throws(bad({ css: 1 }), /screen.css は/);
  assert.doesNotThrow(bad({ title: "x", theme: "light", noteRequired: false, excel: true, css: "a.css" }));
});
