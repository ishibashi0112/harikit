// 実際の DB で、stamp（DB の時刻と反映した人）、scope、表示名、サーバの業務ルールを通す筋書き。4 つの DB の結合テストから呼ぶ。
// テーブルは Term（Company, Code, Kind, StartDate, EndDate, Price, UpdatedAt, UpdatedOn, UpdatedBy）。Oracle は大文字の名前でよい。

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApplyRequest, PatchiriClient, prepare, type ApplyResponse, type Failure } from "patchiri-core";
import { startServer, type ServerConfig } from "../src/index.js";

export interface StampRow {
  price: string;
  startDate: string;
  /** "2026-01-05 10:00:00" の形（秒まで）。 */
  updatedAt: string | null;
  updatedOn: string | null;
  updatedBy: string | null;
}

export interface StampDb {
  database: ServerConfig["database"];
  /** テーブルの名前（設定に書く形）。 */
  table: string;
  /**
   * テーブルを作り直して 2 行入れる。
   * ('001', 'T1', '1', 2026-04-01, 2026-09-30, 100.00, 2026-01-05 10:00:00, 2026-01-05, 'old') と ('002', 'T1', '1', 2026-04-01, NULL, 500.00, NULL, NULL, NULL)。
   */
  reset(): Promise<void>;
  row(company: string): Promise<StampRow>;
  /** DB の今日の日付（YYYY-MM-DD）。 */
  today(): Promise<string>;
  runScript(script: string): Promise<unknown>;
}

export async function stampScenario(db: StampDb): Promise<void> {
  await db.reset();
  const config: ServerConfig = {
    listen: { port: 0 },
    database: db.database,
    targets: {
      term: {
        table: db.table,
        access: "update",
        key: ["Code"],
        readable: ["Code", "Kind", "StartDate", "EndDate", "Price"],
        updatable: ["StartDate", "EndDate", "Price"],
        labels: { Price: "単価" },
        stamp: { UpdatedAt: "now", UpdatedOn: "now", UpdatedBy: "user" },
        scope: { Company: "001" },
      },
    },
    rules: { targets: { term: [{ column: "EndDate", min: { column: "StartDate" } }] } },
    logDir: await mkdtemp(join(tmpdir(), "patchiri-log-")),
  };
  const server = await startServer(config, { token: "test", web: false, whoAmI: () => "E1234" });
  try {
    const client = new PatchiriClient({ baseUrl: server.url, token: "test" });
    const d = await client.describe("term");
    assert.equal(d.columns.find((c) => c.label === "単価")?.name.toLowerCase(), "price");
    assert.deepEqual(d.stamp?.map((s) => [s.column.toLowerCase(), s.value]), [["updatedat", "now"], ["updatedon", "now"], ["updatedby", "user"]]);

    // 見出しは表示名でよい。行は scope（Company = '001'）の中だけ。
    const result = await prepare(client, "term", { name: "s", rows: [["Code", "単価"], ["T1", "120"]] });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.diff!.rows[0]!.current![d.columns.find((c) => c.label === "単価")!.name], "100.00");
    const res = (await client.apply(buildApplyRequest(result.diff!, { mode: "execute" }))) as ApplyResponse;
    assert.equal(res.ok, true, JSON.stringify(res));
    const after = await db.row("001");
    assert.equal(after.price, "120.00");
    assert.equal(after.updatedBy, "E1234");
    assert.equal(after.updatedOn, await db.today());
    assert.notEqual(after.updatedAt, null);
    assert.notEqual(after.updatedAt, "2026-01-05 10:00:00");
    assert.equal(after.updatedAt!.slice(0, 10), await db.today());
    // 同じキーでも scope の外の行は変えない。
    assert.equal((await db.row("002")).price, "500.00");

    // 戻し SQL は stamp の列も前の値に戻す。
    await db.runScript(res.undoScript);
    assert.deepEqual(await db.row("001"), { price: "100.00", startDate: "2026-04-01", updatedAt: "2026-01-05 10:00:00", updatedOn: "2026-01-05", updatedBy: "old" });

    // サーバの業務ルールは、変えない列（終了日）を DB の値で見る。
    const startDate = d.columns.find((c) => c.name.toLowerCase() === "startdate")!.name;
    const code = d.key[0]!;
    const current = (await client.fetch({ target: "term", keys: [{ [code]: "T1" }], columns: [startDate] })).rows[0]!;
    assert.ok(current.found && current.values);
    // Oracle の DATE は日時の列（2026-04-01T00:00:00）。
    const before = current.values[startDate] as string;
    const bad = (await client.apply({
      requestId: "rule-check-0001",
      mode: "check",
      changes: [{ target: "term", rows: [{ op: "update", key: { [code]: "T1" }, before: { [startDate]: before }, after: { [startDate]: before.replace("2026-04-01", "2026-10-01") } }] }],
    })) as Failure;
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.rowErrors?.map((e) => [e.code, e.column]), [["rule_violation", startDate]]);
    assert.match(bad.rowErrors![0]!.message!, /^EndDate（2026-09-30(T00:00:00)?）は StartDate（2026-10-01(T00:00:00)?） 以上にしてください$/i);
  } finally {
    await server.close();
  }
}
