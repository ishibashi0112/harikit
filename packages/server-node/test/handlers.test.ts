import { test } from "node:test";
import assert from "node:assert/strict";
import { sameValue, type Row } from "@harikit/core";
import { Handlers, createHttpServer, type ApplyLogEntry, type Dialect, type ServerConfig, type TableMeta, type Transaction } from "../src/index.js";

const META: TableMeta = {
  table: "dbo.M_Product",
  columns: [
    { name: "ProductCode", type: "string", dbType: "varchar(10)", maxLength: 10, nullable: false },
    { name: "ProductName", type: "string", dbType: "nvarchar(50)", maxLength: 50, nullable: false },
    { name: "CategoryCode", type: "string", dbType: "varchar(4)", maxLength: 4, nullable: false },
    { name: "UnitPrice", type: "decimal", dbType: "decimal(9,2)", precision: 9, scale: 2, nullable: true },
    { name: "Secret", type: "string", dbType: "varchar(10)", maxLength: 10, nullable: true },
  ],
  primaryKey: ["ProductCode"],
  foreignKeys: [{ name: "FK_M_Product_Category", columns: ["CategoryCode"], referencedTable: "dbo.M_Category", referencedColumns: ["CategoryCode"] }],
};
const CATEGORY: TableMeta = {
  table: "dbo.M_Category",
  columns: [{ name: "CategoryCode", type: "string", dbType: "varchar(4)", maxLength: 4, nullable: false }],
  primaryKey: ["CategoryCode"],
  foreignKeys: [],
};

/** メモリ上の表で動く方言。トランザクションは写しを取って戻す。 */
class FakeDialect implements Dialect {
  readonly name = "sqlserver";
  tables: Record<string, Row[]> = {
    "dbo.m_product": [
      { ProductCode: "A001", ProductName: "ボールペン黒", CategoryCode: "C01", UnitPrice: "120.00", Secret: "s" },
      { ProductCode: "A002", ProductName: "ボールペン赤", CategoryCode: "C01", UnitPrice: null, Secret: "s" },
    ],
    "dbo.m_category": [{ CategoryCode: "C01" }],
  };
  updates = 0;
  normalizeTable(t: string) {
    return (t.includes(".") ? t : `dbo.${t}`).toLowerCase();
  }
  async describeTable(t: string) {
    return this.normalizeTable(t) === "dbo.m_product" ? META : CATEGORY;
  }
  private find(table: string, keyColumns: string[], key: Row) {
    return this.tables[this.normalizeTable(table)]!.find((r) => keyColumns.every((k) => String(r[k]).toLowerCase() === String(key[k]).toLowerCase()));
  }
  async fetchRows(meta: TableMeta, keyColumns: string[], columns: string[], keys: Row[]) {
    return keys.map((k) => {
      const r = this.find(meta.table, keyColumns, k);
      return r ? Object.fromEntries(columns.map((c) => [c, r[c]!])) : null;
    });
  }
  async transaction<T>(fn: (tx: Transaction) => Promise<{ commit: boolean; value: T }>) {
    const saved = structuredClone(this.tables);
    const tx: Transaction = {
      lockAndCompare: async (meta, keyColumns, key, before) => {
        const r = this.find(meta.table, keyColumns, key);
        if (!r) return { found: false };
        const types = new Map(meta.columns.map((c) => [c.name, c.type]));
        const current = Object.fromEntries(Object.keys(before).map((c) => [c, r[c]!]));
        const changed = Object.keys(before).filter((c) => !sameValue(types.get(c)!, r[c]!, before[c]!));
        return { found: true, current, changed, dbKey: Object.fromEntries(keyColumns.map((k) => [k, r[k]!])) };
      },
      update: async (meta, keyColumns, key, set) => {
        const r = this.find(meta.table, keyColumns, key);
        if (!r) return 0;
        Object.assign(r, set);
        this.updates++;
        return 1;
      },
    };
    try {
      const { commit, value } = await fn(tx);
      if (!commit) this.tables = saved;
      return value;
    } catch (e) {
      this.tables = saved;
      throw e;
    }
  }
  renderUpdate(meta: TableMeta, set: Row, where: Row) {
    return `UPDATE ${meta.table} SET ${JSON.stringify(set)} WHERE ${JSON.stringify(where)}`;
  }
  async close() {}
}

const CONFIG: ServerConfig = {
  database: { dialect: "sqlserver", server: "x", database: "x" },
  targets: {
    product: {
      table: "dbo.M_Product",
      access: "update",
      readable: ["ProductCode", "ProductName", "CategoryCode", "UnitPrice"],
      updatable: ["ProductName", "CategoryCode", "UnitPrice"],
    },
    category: { table: "dbo.M_Category", access: "read", readable: ["CategoryCode"] },
  },
  limits: { maxFetchKeys: 3, maxApplyRows: 3 },
};

function setup() {
  const dialect = new FakeDialect();
  const logs: ApplyLogEntry[] = [];
  const handlers = new Handlers({
    config: CONFIG,
    dialect,
    whoAmI: () => "tester",
    log: async (e) => void logs.push(e),
    now: () => new Date(2026, 9, 17, 10, 15, 2, 481),
  });
  return { dialect, logs, handlers };
}

const ID = "6f1c2a8e-3b0d-4e7a-9c55-1d2e3f4a5b6c";
const applyReq = (rows: unknown[], mode = "execute", requestId = ID) => ({ v: 1, requestId, mode, changes: [{ target: "product", rows }] });

test("describe: 一覧と、readable の列だけの定義", async () => {
  const { handlers } = setup();
  const list = await handlers.handle("describe", { v: 1 });
  assert.deepEqual(list.targets, [
    { target: "product", table: "dbo.M_Product", access: "update" },
    { target: "category", table: "dbo.M_Category", access: "read" },
  ]);
  const d = await handlers.handle("describe", { v: 1, target: "product" });
  assert.equal(d.ok, true);
  assert.deepEqual(d.key, ["ProductCode"]);
  const cols = d.columns as { name: string; updatable: boolean }[];
  assert.deepEqual(cols.map((c) => [c.name, c.updatable]), [["ProductCode", false], ["ProductName", true], ["CategoryCode", true], ["UnitPrice", true]]);
  assert.deepEqual((d.foreignKeys as { referencedTarget: string }[])[0]!.referencedTarget, "category");
});

test("共通のエラー: 版、ターゲット", async () => {
  const { handlers } = setup();
  assert.equal(((await handlers.handle("describe", { v: 2 })).error as { code: string }).code, "version_unsupported");
  assert.equal(((await handlers.handle("describe", { v: 1, target: "M_Product" })).error as { code: string }).code, "unknown_target");
  assert.equal(((await handlers.handle("describe", { v: 1, target: "__proto__" })).error as { code: string }).code, "unknown_target");
});

test("fetch: 順番どおり、見つからない行も返す", async () => {
  const { handlers } = setup();
  const res = await handlers.handle("fetch", { v: 1, target: "product", keys: [{ ProductCode: "A002" }, { productcode: "Z999" }], columns: ["UnitPrice"] });
  assert.deepEqual(res.rows, [
    { index: 0, found: true, values: { ProductCode: "A002", UnitPrice: null } },
    { index: 1, found: false },
  ]);
  const err = async (body: unknown) => ((await handlers.handle("fetch", body)).error as { code: string }).code;
  assert.equal(await err({ v: 1, target: "product", keys: [{ ProductCode: "A001", X: 1 }] }), "key_mismatch");
  assert.equal(await err({ v: 1, target: "product", keys: [{}] }), "key_mismatch");
  assert.equal(await err({ v: 1, target: "product", keys: [], columns: ["Secret"] }), "column_not_allowed");
  assert.equal(await err({ v: 1, target: "product", keys: [{}, {}, {}, {}] }), "too_many_rows");
});

test("apply execute: 反映して、ログと SQL を残す。同じ requestId は再実行しない", async () => {
  const { handlers, dialect, logs } = setup();
  const rows = [
    { op: "update", key: { ProductCode: "A001" }, before: { UnitPrice: "120.00" }, after: { UnitPrice: "130.00" } },
    { key: { ProductCode: "A002" }, before: { UnitPrice: null, ProductName: "ボールペン赤" }, after: { UnitPrice: "130", ProductName: "ボールペン（赤）" } },
  ];
  const res = await handlers.handle("apply", { ...applyReq(rows), note: "承認 #123" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.results, [{ target: "product", updated: 2 }]);
  assert.equal(res.appliedBy, "tester");
  assert.equal(res.appliedAt, "2026-10-17T10:15:02.481");
  assert.match(res.undoScript as string, /SET \{"UnitPrice":"120.00"\} WHERE \{"ProductCode":"A001","UnitPrice":"130.00"\}/);
  assert.equal(dialect.tables["dbo.m_product"]![1]!.ProductName, "ボールペン（赤）");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.outcome, "applied");
  assert.equal(logs[0]!.note, "承認 #123");
  const again = await handlers.handle("apply", applyReq(rows));
  assert.deepEqual(again, res);
  assert.equal(dialect.updates, 2);
});

test("apply: 1 行でも変わっていたら全部止める", async () => {
  const { handlers, dialect } = setup();
  dialect.tables["dbo.m_product"]![1]!.UnitPrice = "125.00";
  const res = await handlers.handle("apply", applyReq([
    { key: { ProductCode: "A001" }, before: { UnitPrice: "120.00" }, after: { UnitPrice: "130.00" } },
    { key: { ProductCode: "A002" }, before: { UnitPrice: null, ProductName: "ボールペン赤" }, after: { UnitPrice: "130.00", ProductName: "x" } },
    { key: { ProductCode: "Z999" }, before: { UnitPrice: "1" }, after: { UnitPrice: "2" } },
  ]));
  assert.equal(res.ok, false);
  assert.equal((res.error as { code: string }).code, "conflict");
  assert.deepEqual(res.conflicts, [
    { target: "product", index: 1, key: { ProductCode: "A002" }, reason: "changed", columns: ["UnitPrice"], current: { UnitPrice: "125.00", ProductName: "ボールペン赤" } },
    { target: "product", index: 2, key: { ProductCode: "Z999" }, reason: "not_found" },
  ]);
  assert.equal(dialect.tables["dbo.m_product"]![0]!.UnitPrice, "120.00");
  assert.equal(dialect.updates, 0);
});

test("apply check: DB を変えずに SQL を返す", async () => {
  const { handlers, dialect } = setup();
  const res = await handlers.handle("apply", applyReq([{ key: { ProductCode: "A001" }, before: { UnitPrice: "120.00" }, after: { UnitPrice: "130.00" } }], "check"));
  assert.equal(res.ok, true);
  assert.deepEqual(res.results, [{ target: "product", updated: 0 }]);
  assert.match(res.script as string, /実行予定/);
  assert.equal(dialect.tables["dbo.m_product"]![0]!.UnitPrice, "120.00");
});

test("apply: 行ごとの誤りはまとめて返し、DB に触らない", async () => {
  const { handlers, dialect } = setup();
  const res = await handlers.handle("apply", applyReq([
    { key: { ProductCode: "A001" }, before: { Secret: "s" }, after: { Secret: "t" } },
    { key: { ProductCode: "A001", X: 1 }, before: { UnitPrice: "1" }, after: { UnitPrice: "2" } },
    { key: { ProductCode: "A002" }, before: { UnitPrice: "1" }, after: { UnitPrice: "1.00" } },
  ]));
  assert.equal((res.error as { code: string }).code, "bad_request");
  assert.deepEqual(
    (res.rowErrors as { index: number; code: string }[]).map((e) => [e.index, e.code]),
    [[0, "column_not_allowed"], [1, "key_mismatch"], [2, "bad_request"]],
  );
  const bad = await handlers.handle("apply", applyReq([{ key: { ProductCode: "A001" }, before: { UnitPrice: "1" }, after: { UnitPrice: "1; DROP TABLE x" } }]));
  assert.deepEqual((bad.rowErrors as { code: string }[]).map((e) => e.code), ["invalid_value"]);
  const dup = await handlers.handle("apply", applyReq([
    { key: { ProductCode: "A001" }, before: { UnitPrice: "120.00" }, after: { UnitPrice: "1" } },
    { key: { ProductCode: "a001" }, before: { UnitPrice: "120.00" }, after: { UnitPrice: "2" } },
  ]));
  assert.deepEqual((dup.rowErrors as { index: number; code: string }[]).map((e) => [e.index, e.code]), [[1, "duplicate_key"]]);
  assert.match((dup.rowErrors as { message: string }[])[0]!.message, /DB 上で同じ行/);
  const sameJson = await handlers.handle("apply", applyReq([
    { key: { ProductCode: "A001" }, before: { UnitPrice: "120.00" }, after: { UnitPrice: "1" } },
    { key: { ProductCode: "A001" }, before: { UnitPrice: "120.00" }, after: { UnitPrice: "2" } },
  ]));
  assert.deepEqual((sameJson.rowErrors as { index: number; code: string }[]).map((e) => [e.index, e.code]), [[1, "duplicate_key"]]);
  const tooMany = await handlers.handle("apply", applyReq([{}, {}, {}, {}]));
  assert.equal((tooMany.error as { code: string }).code, "too_many_rows");
  const twoTables = await handlers.handle("apply", { ...applyReq([]), changes: [{ target: "product", rows: [] }, { target: "product", rows: [] }] });
  assert.equal((twoTables.error as { code: string }).code, "bad_request");
  assert.equal(dialect.updates, 0);
});

test("HTTP: トークン、X-Harikit、Content-Type を求める", async () => {
  const { handlers } = setup();
  const server = createHttpServer(handlers, { token: "t0ken" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const post = (path: string, headers: Record<string, string>, body = '{"v":1}') =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body });
  const good = { Authorization: "Bearer t0ken", "X-Harikit": "1", "Content-Type": "application/json" };
  try {
    assert.equal((await post("/describe", { ...good, Authorization: "Bearer nope" })).status, 401);
    assert.equal((await post("/describe", { Authorization: "Bearer t0ken", "Content-Type": "application/json" })).status, 403);
    assert.equal((await post("/describe", { ...good, "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post("/sql", good)).status, 404);
    const res = await post("/describe", good);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);
    const broken = await post("/describe", good, "{");
    assert.equal(((await broken.json()) as { error: { code: string } }).error.code, "bad_request");
  } finally {
    server.close();
  }
});

test("apply: コミットした後にログが書けなくても、結果と戻し SQL は返す", async () => {
  const dialect = new FakeDialect();
  const errors: unknown[] = [];
  const handlers = new Handlers({
    config: CONFIG,
    dialect,
    whoAmI: () => "tester",
    log: async () => {
      throw new Error("disk full");
    },
    logError: (e) => errors.push(e),
  });
  const res = await handlers.handle("apply", applyReq([{ key: { ProductCode: "A001" }, before: { UnitPrice: "120.00" }, after: { UnitPrice: "130.00" } }]));
  assert.equal(res.ok, true);
  assert.match(res.undoScript as string, /120.00/);
  assert.equal(dialect.tables["dbo.m_product"]![0]!.UnitPrice, "130.00");
  assert.equal(errors.length, 1);
});
