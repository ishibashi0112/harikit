// 実際の MySQL / MariaDB で通すテスト。PATCHIRI_TEST_MYSQL があるときだけ動く。
//   PATCHIRI_TEST_MYSQL='{"host":"localhost","port":3306,"database":"patchiri","user":"root","password":"..."}' npm test
// トリガーを作るので、user は root など権限のあるもの。テスト用のテーブルは database に作り直す。

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { buildApplyRequest, PatchiriClient, prepare, type ApplyResponse, type Failure, type Sheet } from "patchiri-core";
import { startServer, type RunningServer, type ServerConfig } from "../src/index.js";
import { stampScenario } from "./stamp-scenario.js";

const env = process.env.PATCHIRI_TEST_MYSQL;
const skip = env ? false : "PATCHIRI_TEST_MYSQL がないので飛ばす";
const conn = env ? (JSON.parse(env) as { host: string; port?: number; database: string; user: string; password: string }) : undefined;

let admin: mysql.Connection;
let server: RunningServer;
let client: PatchiriClient;
let mariadb = false;

const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params))[0] as Record<string, unknown>[];
const one = async (sql: string) => (await q(sql))[0]!;

/** 出力した SQL をそのまま流し、最後の SELECT の結果（patchiri: …）を返す。 */
async function runScript(script: string, sqlMode?: string): Promise<string> {
  const c = await mysql.createConnection({ ...conn!, multipleStatements: true, charset: "utf8mb4" });
  try {
    if (sqlMode !== undefined) await c.query(`SET SESSION sql_mode = '${sqlMode}'`);
    const [results] = await c.query(script);
    const last = (results as unknown[]).at(-1) as { patchiri: string }[];
    return last[0]!.patchiri;
  } finally {
    await c.end();
  }
}

const sheet = (rows: Sheet["rows"]): Sheet => ({ name: "s", rows });

before(async () => {
  if (!conn) return;
  admin = await mysql.createConnection({ ...conn, charset: "utf8mb4", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  mariadb = /mariadb/i.test(String((await one("SELECT VERSION() AS v")).v));
  for (const t of ["item_audit", "item", "kind", "legacy", "bin_item"]) await q(`DROP TABLE IF EXISTS ${t}`);
  await q(`CREATE TABLE kind (kind_code varchar(4) PRIMARY KEY) DEFAULT CHARSET utf8mb4`);
  await q(`CREATE TABLE item (
      code varchar(10) PRIMARY KEY,
      name varchar(50) NOT NULL,
      kind_code varchar(4),
      price decimal(9,2),
      big bigint,
      ubig bigint unsigned,
      qty smallint,
      tiny tinyint,
      flag tinyint(1),
      rate double,
      ratio float,
      active bit(1) NOT NULL DEFAULT b'1',
      released date,
      stamp datetime(3),
      open_at time,
      memo varchar(20) CHARACTER SET cp932 COLLATE cp932_japanese_ci,
      sj varchar(10) CHARACTER SET sjis,
      m3 varchar(10) CHARACTER SET utf8mb3,
      grade char(3),
      status enum('draft', 'active', 'retired'),
      remark text,
      raw_id varbinary(4),
      created timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      row_no int NOT NULL AUTO_INCREMENT UNIQUE,
      double_price decimal(10,2) AS (price * 2) VIRTUAL,
      CONSTRAINT fk_item_kind FOREIGN KEY (kind_code) REFERENCES kind (kind_code)
    ) DEFAULT CHARSET utf8mb4`);
  await q(`CREATE TABLE item_audit (code varchar(10), note varchar(10))`);
  // 監査ログを 2 行書く UPDATE トリガー。影響行数に混ざらないこと。
  await q(`CREATE TRIGGER tr_item AFTER UPDATE ON item FOR EACH ROW
    BEGIN
      INSERT INTO item_audit VALUES (NEW.code, 'new');
      INSERT INTO item_audit VALUES (OLD.code, 'old');
    END`);
  // 古い業務 DB によくある固定長のキー。
  await q(`CREATE TABLE legacy (cd char(6) PRIMARY KEY, nm varchar(20) NOT NULL, kana char(4)) DEFAULT CHARSET utf8mb4`);
  // 大文字小文字を区別する照合順序のキー。
  await q(`CREATE TABLE bin_item (code varchar(10) COLLATE utf8mb4_bin PRIMARY KEY, name varchar(20)) DEFAULT CHARSET utf8mb4`);
  await q(`INSERT INTO kind VALUES ('K1'), ('K2')`);
  await q(`INSERT INTO item (code, name, kind_code, price, big, ubig, qty, tiny, flag, rate, ratio, released, stamp, open_at, memo, grade, status, raw_id) VALUES
      ('A001', 'ペン', 'K1', 120, 9007199254740993, 18446744073709551615, 5, -5, 1, 0.1, 0.1, '2024-04-01', '2026-10-17 09:30:00.123', '09:00', 'メモ', 'A', 'active', 0x0A0B)`);
  await q(`INSERT INTO item (code, name, kind_code, price) VALUES ('A002', 'ノート', 'K1', 0.5)`);
  await q(`INSERT INTO legacy VALUES ('L1', 'old', 'ab'), ('L22', 'old2', NULL)`);
  await q(`INSERT INTO bin_item VALUES ('A001', 'up')`);
  const config: ServerConfig = {
    listen: { port: 0 },
    database: { dialect: "mysql", host: conn.host, port: conn.port ?? 3306, database: conn.database, user: conn.user, password: conn.password, lockWaitSeconds: 1 },
    targets: {
      item: {
        table: "item",
        access: "update",
        readable: ["code", "name", "kind_code", "price", "big", "ubig", "qty", "tiny", "flag", "rate", "ratio", "active", "released", "stamp", "open_at", "memo", "sj", "m3", "grade", "status", "remark", "raw_id", "created", "row_no", "double_price"],
        updatable: ["name", "kind_code", "price", "big", "ubig", "qty", "tiny", "flag", "rate", "ratio", "active", "released", "stamp", "open_at", "memo", "sj", "m3", "grade", "status", "remark", "raw_id", "created", "row_no", "double_price"],
      },
      kind: { table: `${conn.database}.kind`, access: "read", readable: ["kind_code"] },
      legacy: { table: "`legacy`", access: "update", readable: ["cd", "nm", "kana"], updatable: ["nm", "kana"] },
      bin: { table: "bin_item", access: "update", readable: ["code", "name"], updatable: ["name"] },
    },
    logDir: await mkdtemp(join(tmpdir(), "patchiri-log-")),
  };
  server = await startServer(config, { token: "test", web: false });
  client = new PatchiriClient({ baseUrl: server.url, token: "test" });
});

after(async () => {
  await server?.close();
  await admin?.end();
});

test("describe: 型、桁と文字コード、整数の範囲、主キー、外部キー、更新できない列", { skip }, async () => {
  const d = await client.describe("item");
  assert.equal(d.dialect, "mysql");
  // table は DB で引いた名前（データベースを省くと接続先のもの）。
  assert.equal(d.table, `${conn!.database}.item`);
  assert.deepEqual(d.key, ["code"]);
  const col = (n: string) => ({ ...d.columns.find((c) => c.name === n)! });
  assert.deepEqual(col("code"), { name: "code", type: "string", dbType: "varchar(10)", nullable: false, updatable: false, maxLength: 10, encoding: "utf-8" });
  assert.deepEqual([col("memo").encoding, col("sj").encoding, col("m3").encoding], ["shift_jis", "shift_jis", "utf-8"]);
  assert.deepEqual([col("grade").dbType, col("grade").maxLength], ["char(3)", 3]);
  assert.deepEqual([col("remark").dbType, col("remark").maxLength, col("remark").maxBytes], ["text", -1, 65535]);
  assert.deepEqual([col("price").type, col("price").dbType, col("price").precision, col("price").scale], ["decimal", "decimal(9,2)", 9, 2]);
  assert.deepEqual([col("big").type, col("big").min], ["bigint", undefined]);
  assert.deepEqual([col("ubig").type, col("ubig").dbType, col("ubig").min, col("ubig").max], ["bigint", "bigint unsigned", "0", "18446744073709551615"]);
  assert.deepEqual([col("qty").type, col("qty").min, col("qty").max], ["integer", -32768, 32767]);
  assert.deepEqual([col("tiny").dbType, col("tiny").min, col("tiny").max, col("flag").type], ["tinyint", -128, 127, "integer"]);
  assert.deepEqual([col("rate").type, col("rate").dbType, col("ratio").dbType], ["float", "double", "float"]);
  assert.deepEqual([col("active").type, col("active").dbType, col("active").hasDefault], ["boolean", "bit(1)", true]);
  assert.deepEqual([col("released").type, col("stamp").type, col("stamp").dbType, col("stamp").scale], ["date", "datetime", "datetime(3)", 3]);
  assert.deepEqual([col("open_at").type, col("open_at").scale], ["time", 0]);
  assert.deepEqual([col("status").type, col("status").dbType], ["string", "enum('draft','active','retired')"]);
  assert.deepEqual([col("raw_id").type, col("raw_id").updatable, col("created").type, col("created").updatable], ["other", false, "other", false]);
  assert.deepEqual([col("row_no").identity, col("row_no").updatable], [true, false]);
  assert.deepEqual([col("double_price").computed, col("double_price").updatable], [true, false]);
  assert.deepEqual(d.foreignKeys, [{ name: "fk_item_kind", columns: ["kind_code"], referencedTable: `${conn!.database}.kind`, referencedColumns: ["kind_code"], referencedTarget: "kind" }]);
});

test("fetch: 値は仕様の形で返る。キーは列の照合順序で探す", { skip }, async () => {
  // 既定の照合順序（_ai_ci）は大文字小文字を区別しない。
  const res = await client.fetch({ target: "item", keys: [{ code: "A001" }, { code: "a001" }, { code: "A002" }, { code: "Z9" }] });
  assert.deepEqual(res.rows.map((r) => r.found), [true, true, true, false]);
  const row = res.rows[0]!;
  assert.ok(row.found);
  assert.deepEqual(row.values, {
    code: "A001",
    name: "ペン",
    kind_code: "K1",
    price: "120.00",
    big: "9007199254740993",
    ubig: "18446744073709551615",
    qty: 5,
    tiny: -5,
    flag: 1,
    rate: 0.1,
    ratio: 0.1,
    active: true,
    released: "2024-04-01",
    stamp: "2026-10-17T09:30:00.123",
    open_at: "09:00:00",
    memo: "メモ",
    sj: null,
    m3: null,
    grade: "A",
    status: "active",
    remark: null,
    raw_id: "0A0B",
    created: row.values.created,
    row_no: 1,
    double_price: "240.00",
  });
  assert.ok(res.rows[2]!.found && res.rows[2]!.values.price === "0.50");
  // utf8mb4_bin の列は区別する。
  const bin = await client.fetch({ target: "bin", keys: [{ code: "A001" }, { code: "a001" }] });
  assert.deepEqual(bin.rows.map((r) => r.found), [true, false]);
});

test("同じ行を照合順序で指す 2 行は duplicate_key", { skip }, async () => {
  const res = (await client.apply({
    requestId: crypto.randomUUID(),
    mode: "check",
    changes: [{ target: "item", rows: [{ key: { code: "A001" }, before: { qty: 5 }, after: { qty: 6 } }, { key: { code: "a001" }, before: { qty: 5 }, after: { qty: 7 } }] }],
  })) as Failure;
  assert.deepEqual(res.rowErrors!.map((e) => [e.index, e.code]), [[1, "duplicate_key"]]);
});

test("CHAR のキーと、詰め物の空白", { skip }, async () => {
  const res = await client.fetch({ target: "legacy", keys: [{ cd: "L1" }, { cd: "L22" }, { cd: "L3" }] });
  assert.deepEqual(res.rows.map((r) => (r.found ? r.values : null)), [{ cd: "L1", nm: "old", kana: "ab" }, { cd: "L22", nm: "old2", kana: null }, null]);
  const p = await prepare(client, "legacy", sheet([["cd", "nm", "kana"], ["L1", "new", "ab  "], ["L22", "new2", "cd"]]));
  assert.ok(p.ok, JSON.stringify(p.issues));
  assert.deepEqual(p.diff!.rows.map((r) => r.changes.map((c) => c.column)), [["nm"], ["nm", "kana"]]);
  const done = (await client.apply(buildApplyRequest(p.diff!, { mode: "execute" }))) as ApplyResponse;
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(await q(`SELECT cd, nm, kana FROM legacy ORDER BY cd`), [
    { cd: "L1", nm: "new", kana: "ab" },
    { cd: "L22", nm: "new2", kana: "cd" },
  ]);
  assert.equal(await runScript(done.undoScript), "patchiri: 2 / 2 行を戻しました");
  assert.deepEqual(await q(`SELECT nm, kana FROM legacy ORDER BY cd`), [{ nm: "old", kana: "ab" }, { nm: "old2", kana: null }]);
});

test("Excel 相当の取込から反映、衝突、戻しまで", { skip }, async () => {
  const p = await prepare(
    client,
    "item",
    sheet([
      ["Code", "Price", "Big", "UBig", "Stamp", "Released", "Kind_Code", "Rate", "Open_At", "Active", "Tiny"],
      ["A001", 130, "9007199254740995", "18446744073709551614", { kind: "date", iso: "2026-10-18T08:00:00.000" }, "2024/4/2", "K2", 0.25, "13:30", false, -128],
      ["A002", 99.9, null, null, null, { kind: "date", iso: "2024-05-01T00:00:00.000" }, "K1", null, null, true, null],
    ]),
  );
  assert.ok(p.ok, JSON.stringify(p.issues));
  assert.deepEqual(p.diff!.counts, { change: 2, same: 0, not_found: 0 });
  assert.deepEqual(p.diff!.rows[1]!.changes.map((c) => c.column), ["price", "released"]);

  const bad = await prepare(client, "item", sheet([["code", "kind_code", "stamp", "tiny", "ubig"], ["A001", "K9", "2024-04-02T10:30:00.1234", 200, "-1"]]));
  assert.deepEqual(bad.issues.map((i) => [i.cell, i.message]), [
    ["B2", `${conn!.database}.kind にありません`],
    ["C2", "秒の小数は 3 桁までです"],
    ["D2", "範囲外です（-128〜127）"],
    ["E2", "範囲外です（0〜18446744073709551615）"],
  ]);

  // 差分を取った後に別の人が変えたら止まる。
  await q(`UPDATE item SET price = 121 WHERE code = 'A001'`);
  const req = buildApplyRequest(p.diff!, { mode: "execute" });
  const conflict = (await client.apply(req)) as Failure;
  assert.equal(conflict.error.code, "conflict");
  assert.deepEqual(conflict.conflicts!.map((c) => [c.index, c.columns]), [[0, ["price"]]]);
  assert.equal((await one(`SELECT price FROM item WHERE code = 'A002'`)).price, "0.50");
  await q(`UPDATE item SET price = 120 WHERE code = 'A001'`);

  const check = (await client.apply({ ...req, mode: "check" })) as ApplyResponse;
  assert.equal(check.ok, true, JSON.stringify(check));
  await q(`DELETE FROM item_audit`);
  const done = (await client.apply(req)) as ApplyResponse;
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(done.results, [{ target: "item", updated: 2 }]);
  assert.equal(Number((await one(`SELECT COUNT(*) AS n FROM item_audit`)).n), 4);
  const a = await one(`SELECT price, big, ubig, stamp, released, kind_code, rate, open_at, IF(active = 1, 'on', 'off') AS active, tiny FROM item WHERE code = 'A001'`);
  assert.deepEqual(a, { price: "130.00", big: "9007199254740995", ubig: "18446744073709551614", stamp: "2026-10-18 08:00:00.000", released: "2024-04-02", kind_code: "K2", rate: 0.25, open_at: "13:30:00", active: "off", tiny: -128 });
  assert.match(done.script, /^-- patchiri .* 2行 実行済み\n/);
  assert.match(done.script, /`stamp` = TIMESTAMP '2026-10-18 08:00:00'/);
  assert.match(done.script, /`released` = DATE '2024-04-02'/);

  // 戻しは、後から変わった行には触らず、その行を最後に出す。
  await q(`UPDATE item SET price = 98 WHERE code = 'A002'`);
  assert.equal(await runScript(done.undoScript), "patchiri: 1 / 2 行を戻しました。戻していない行（後から別の更新が入った）: code=A002");
  const rows = await q(`SELECT code, price, big, ubig, kind_code, released, IF(active = 1, 'on', 'off') AS active, tiny FROM item ORDER BY code`);
  assert.deepEqual(rows, [
    { code: "A001", price: "120.00", big: "9007199254740993", ubig: "18446744073709551615", kind_code: "K1", released: "2024-04-01", active: "on", tiny: -5 },
    { code: "A002", price: "98.00", big: null, ubig: null, kind_code: "K1", released: "2024-05-01", active: "on", tiny: null },
  ]);

  // 反映の SQL は、1 行でも当たらなければどの行も反映しない（A002 は 98 に変わっている）。
  assert.equal(await runScript(done.script), "patchiri: 行が見つからないか、値が変わっています（code=A002）。何も反映していません");
  assert.equal((await one(`SELECT price FROM item WHERE code = 'A001'`)).price, "120.00");
  await q(`UPDATE item SET price = 0.5, released = NULL WHERE code = 'A002'`);
  assert.equal(await runScript(done.script), "patchiri: 2 行を反映しました");
  assert.equal((await one(`SELECT price FROM item WHERE code = 'A002'`)).price, "99.90");
  await runScript(done.undoScript);
});

test("' や \\ を含む値もパラメータで安全に通り、出力した SQL でも崩れない（NO_BACKSLASH_ESCAPES でも）", { skip }, async () => {
  const name = "O'Reilly \\' & Sons\"; DROP TABLE kind;--";
  const p = await prepare(client, "item", sheet([["code", "name"], ["A002", name]]));
  assert.ok(p.ok);
  const res = (await client.apply(buildApplyRequest(p.diff!, { mode: "execute" }))) as ApplyResponse;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((await one(`SELECT name FROM item WHERE code = 'A002'`)).name, name);
  assert.match(res.script, /`name` = _utf8mb4 X'[0-9A-F]+'/);
  for (const mode of ["STRICT_ALL_TABLES", "STRICT_ALL_TABLES,NO_BACKSLASH_ESCAPES"]) {
    assert.equal(await runScript(res.undoScript, mode), "patchiri: 1 / 1 行を戻しました");
    assert.equal((await one(`SELECT name FROM item WHERE code = 'A002'`)).name, "ノート");
    assert.equal(await runScript(res.script, mode), "patchiri: 1 行を反映しました");
    assert.equal((await one(`SELECT name FROM item WHERE code = 'A002'`)).name, name);
  }
  assert.equal(Number((await one(`SELECT COUNT(*) AS n FROM kind`)).n), 2);
  await runScript(res.undoScript);
});

test("値が変わっていないかは厳密に比べる。大文字小文字、全角半角、濁点、末尾の空白だけの後からの更新も上書きしない", { skip }, async () => {
  await q(`UPDATE item SET memo = 'ペン', name = 'Pen', grade = 'B' WHERE code = 'A002'`);
  const p = await prepare(client, "item", sheet([["code", "memo", "name", "grade"], ["A002", "ペン芯", "Pencil", "C"]]));
  assert.ok(p.ok, JSON.stringify(p.issues));
  assert.deepEqual(p.diff!.rows[0]!.changes.map((c) => c.column), ["name", "memo", "grade"]);
  const req = buildApplyRequest(p.diff!, { mode: "execute" });

  for (const [memo, nm] of [["ﾍﾟﾝ", "Pen"], ["ペン", "PEN"], ["ヘン", "Pen"], ["ペン", "Pen "]]) {
    await q(`UPDATE item SET memo = ?, name = ? WHERE code = 'A002'`, [memo, nm]);
    const conflict = (await client.apply(req)) as Failure;
    assert.equal(conflict.error.code, "conflict", `${memo} ${nm}`);
  }

  // 元に戻せば通る。CHAR の詰め物の空白は違いにしない。
  await q(`UPDATE item SET memo = 'ペン', name = 'Pen' WHERE code = 'A002'`);
  const done = (await client.apply({ ...req, requestId: crypto.randomUUID() })) as ApplyResponse;
  assert.equal(done.ok, true, JSON.stringify(done));

  // 反映の後に、大文字小文字だけ違う値へ直された行は、戻し SQL が上書きしない。
  await q(`UPDATE item SET name = 'PENCIL' WHERE code = 'A002'`);
  assert.equal(await runScript(done.undoScript), "patchiri: 0 / 1 行を戻しました。戻していない行（後から別の更新が入った）: code=A002");
  assert.deepEqual(await one(`SELECT memo, name, grade FROM item WHERE code = 'A002'`), { memo: "ペン芯", name: "PENCIL", grade: "C" });

  await q(`UPDATE item SET name = 'Pencil' WHERE code = 'A002'`);
  await runScript(done.undoScript);
  assert.deepEqual(await one(`SELECT memo, name, grade FROM item WHERE code = 'A002'`), { memo: "ペン", name: "Pen", grade: "B" });
});

test("列の文字コードで表せない字は、DB に聞いて断る（sjis の ①、utf8mb3 の 𠮷）", { skip }, async () => {
  const p = await prepare(client, "item", sheet([["code", "sj", "m3"], ["A001", "①", "𠮷"]]));
  assert.ok(p.ok, JSON.stringify(p.issues));
  const res = (await client.apply(buildApplyRequest(p.diff!, { mode: "execute" }))) as Failure;
  assert.deepEqual(res.rowErrors!.map((e) => [e.column, e.code]), [["sj", "invalid_value"], ["m3", "invalid_value"]]);
  const ok = await prepare(client, "item", sheet([["code", "sj", "m3"], ["A001", "ｱ漢字", "漢字"]]));
  const done = (await client.apply(buildApplyRequest(ok.diff!, { mode: "execute" }))) as ApplyResponse;
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(await one(`SELECT sj, m3 FROM item WHERE code = 'A001'`), { sj: "ｱ漢字", m3: "漢字" });
  await runScript(done.undoScript);
});

test("FLOAT、ENUM、BIT(1) の列", { skip }, async () => {
  const p = await prepare(client, "item", sheet([["code", "ratio", "status", "active"], ["A001", 0.3, "retired", false]]));
  assert.ok(p.ok, JSON.stringify(p.issues));
  const done = (await client.apply(buildApplyRequest(p.diff!, { mode: "execute" }))) as ApplyResponse;
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(done.undoScript, /`ratio` = CAST\(0\.1 AS FLOAT\)/);
  const again = await prepare(client, "item", sheet([["code", "ratio", "status", "active"], ["A001", 0.3, "retired", false]]));
  assert.deepEqual(again.diff!.counts, { change: 0, same: 1, not_found: 0 });
  assert.equal(await runScript(done.undoScript), "patchiri: 1 / 1 行を戻しました");
  assert.deepEqual(await one(`SELECT CAST(ratio AS CHAR) AS ratio, status, IF(active = 1, 'on', 'off') AS active FROM item WHERE code = 'A001'`), { ratio: "0.1", status: "active", active: "on" });
  // ラベルにない値は DB が断る（何も変えない）。
  const bad = await prepare(client, "item", sheet([["code", "status"], ["A001", "unknown"]]));
  const res = (await client.apply(buildApplyRequest(bad.diff!, { mode: "execute" }))) as Failure;
  assert.equal(res.error.code, "db_error");
  assert.equal((await one(`SELECT status FROM item WHERE code = 'A001'`)).status, "active");
});

test("ほかのセッションがロックしている行は、待ちきれなければわかる言葉で止まる", { skip }, async () => {
  const other = await mysql.createConnection(conn!);
  try {
    await other.query("START TRANSACTION");
    await other.query(`UPDATE item SET qty = 6 WHERE code = 'A001'`);
    const p = await prepare(client, "item", sheet([["code", "qty"], ["A001", 7]]));
    assert.ok(p.ok, JSON.stringify(p.issues));
    const res = (await client.apply(buildApplyRequest(p.diff!, { mode: "execute" }))) as Failure;
    assert.equal(res.error.code, "db_error");
    assert.match(res.error.message, /ほかのセッションにロックされています/);
  } finally {
    await other.query("ROLLBACK");
    await other.end();
  }
  assert.equal((await one(`SELECT qty FROM item WHERE code = 'A001'`)).qty, 5);
});

test("改行や ; だけの行、長い値も、出力した SQL で崩れない", { skip }, async () => {
  const nm = "a\r\n;\ndelimiter //\nb";
  const remark = "あ".repeat(150) + "\n" + "b".repeat(120);
  const before = { L1: await one(`SELECT nm FROM legacy WHERE cd = 'L1'`), A002: await one(`SELECT remark FROM item WHERE code = 'A002'`) };
  const p1 = await prepare(client, "legacy", sheet([["cd", "nm"], ["L1", nm]]));
  assert.ok(p1.ok, JSON.stringify(p1.issues));
  const d1 = (await client.apply(buildApplyRequest(p1.diff!, { mode: "execute" }))) as ApplyResponse;
  assert.equal(d1.ok, true, JSON.stringify(d1));
  const p2 = await prepare(client, "item", sheet([["code", "remark"], ["A002", remark]]));
  assert.ok(p2.ok, JSON.stringify(p2.issues));
  const d2 = (await client.apply(buildApplyRequest(p2.diff!, { mode: "execute" }))) as ApplyResponse;
  assert.equal(d2.ok, true, JSON.stringify(d2));

  assert.equal(await runScript(d1.undoScript), "patchiri: 1 / 1 行を戻しました");
  assert.equal(await runScript(d2.undoScript), "patchiri: 1 / 1 行を戻しました");
  assert.deepEqual(await one(`SELECT nm FROM legacy WHERE cd = 'L1'`), before.L1);
  assert.deepEqual(await one(`SELECT remark FROM item WHERE code = 'A002'`), before.A002);
  assert.equal(await runScript(d1.script), "patchiri: 1 行を反映しました");
  assert.equal(await runScript(d2.script), "patchiri: 1 行を反映しました");
  assert.deepEqual(await one(`SELECT nm FROM legacy WHERE cd = 'L1'`), { nm });
  assert.deepEqual(await one(`SELECT remark FROM item WHERE code = 'A002'`), { remark });
  assert.equal(await runScript(d1.undoScript), "patchiri: 1 / 1 行を戻しました");
  assert.equal(await runScript(d2.undoScript), "patchiri: 1 / 1 行を戻しました");
});

test("stamp（DB の時刻と反映した人）、scope、表示名、サーバの業務ルール", { skip }, async () => {
  await stampScenario({
    database: { dialect: "mysql", host: conn!.host, port: conn!.port ?? 3306, database: conn!.database, user: conn!.user, password: conn!.password },
    table: "term",
    reset: async () => {
      await q(`DROP TABLE IF EXISTS term`);
      await q(`CREATE TABLE term (company varchar(3) NOT NULL, code varchar(4) NOT NULL, kind varchar(1) NOT NULL, startdate date NOT NULL, enddate date,
        price decimal(9,2), updatedat datetime(3), updatedon date, updatedby varchar(10), PRIMARY KEY (company, code)) DEFAULT CHARSET utf8mb4`);
      await q(`INSERT INTO term VALUES ('001', 'T1', '1', '2026-04-01', '2026-09-30', 100, '2026-01-05 10:00:00', '2026-01-05', 'old'),
        ('002', 'T1', '1', '2026-04-01', NULL, 500, NULL, NULL, NULL)`);
    },
    row: async (company) => {
      const r = await one(`SELECT CAST(price AS char) AS price, DATE_FORMAT(startdate, '%Y-%m-%d') AS startDate, DATE_FORMAT(updatedat, '%Y-%m-%d %H:%i:%s') AS updatedAt,
        DATE_FORMAT(updatedon, '%Y-%m-%d') AS updatedOn, updatedby AS updatedBy FROM term WHERE company = '${company}'`);
      return r as never;
    },
    today: async () => String((await one(`SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS d`)).d),
    runScript: (script) => runScript(script),
  });
});
