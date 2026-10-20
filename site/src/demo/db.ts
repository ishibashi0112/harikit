// デモの DB。ブラウザの中で動く PostgreSQL（PGlite）で、このタブを閉じると消える。
// PGlite のつなぎは 1 本だけなので、patchiri の反映（BEGIN〜COMMIT）とデモの操作（中身を見る、SQL を流す）が
// 混ざらないよう、問い合わせはすべてここで 1 つずつ順に流す。

import { PGlite, types, type Results } from "@electric-sql/pglite";
import type { PgConnector, PgSession } from "patchiri-server-node/postgres";
import { SEED_SQL } from "./seed.js";

/** 1 つの文の結果（SQL の欄に出すもの）。 */
export interface StatementResult {
  command: string;
  rowCount: number | null;
  columns: string[];
  rows: (string | null)[][];
}

export interface RunResult {
  statements: StatementResult[];
  /** RAISE NOTICE などの知らせ（戻し SQL が飛ばした行など）。 */
  notices: string[];
}

/** 最初の値を覚えておくテーブルと、そのキー列。 */
const SNAPSHOT = [
  ["m_product", "product_code", "SELECT product_code, product_name, category_code, unit_price, release_date, on_sale::text AS on_sale FROM m_product"],
  ["m_category", "category_code", "SELECT * FROM m_category"],
] as const;

/** 表示用に、値はすべて DB が返した文字列のまま受け取る（PGlite の既定は日付を Date などにする）。 */
const TEXT_PARSERS: Record<number, (v: string) => string> = Object.fromEntries(
  (Object.values(types) as unknown[]).filter((oid) => typeof oid === "number").map((oid) => [oid, (v: string) => v]),
);

export class DemoDb {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly pg: PGlite) {}

  static async open(): Promise<DemoDb> {
    const db = new DemoDb(await PGlite.create());
    await db.reset();
    return db;
  }

  /** fn を、ほかの問い合わせと重ならないように流す。 */
  private exclusive<T>(fn: (pg: PGlite) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn(this.pg));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** patchiri の PostgreSQL の方言に渡すつなぎ。withSession の間は、ほかの問い合わせを待たせる。 */
  connector(): PgConnector {
    return {
      withSession: <T>(fn: (s: PgSession) => Promise<T>) =>
        this.exclusive(async (pg) => {
          const session: PgSession = {
            query: async (text, params) => {
              const r = await pg.query<Record<string, unknown>>(text, params ?? [], { parsers: TEXT_PARSERS });
              return { rows: r.rows, rowCount: r.rowCount ?? r.affectedRows ?? null };
            },
          };
          try {
            return await fn(session);
          } finally {
            // 方言が COMMIT か ROLLBACK を流しそこねても、次の人が開いたトランザクションの中で動かないようにする。
            await pg.query("ROLLBACK").catch(() => undefined);
          }
        }),
      close: () => this.exclusive((pg) => pg.close()),
    };
  }

  /** 作った直後の値。テーブル名 → 「キー\u0000列名」→ 値。DB の中身で「変わったセル」を見分けるのに使う。 */
  initial = new Map<string, Map<string, string | null>>();

  /** テーブルを作り直して、最初のデータに戻す。 */
  reset(): Promise<void> {
    return this.exclusive(async (pg) => {
      await pg.exec(SEED_SQL);
      const initial = new Map<string, Map<string, string | null>>();
      for (const [table, key, sql] of SNAPSHOT) {
        const values = new Map<string, string | null>();
        const r = await pg.query<Record<string, string | null>>(sql, [], { parsers: TEXT_PARSERS });
        for (const row of r.rows) for (const [c, v] of Object.entries(row)) values.set(`${row[key]}\u0000${c}`, v);
        initial.set(table, values);
      }
      this.initial = initial;
    });
  }

  /** 1 つの文を流して行を返す（値は表示用の文字列）。 */
  query(sql: string, params: unknown[] = []): Promise<Record<string, string | null>[]> {
    return this.exclusive(async (pg) => (await pg.query<Record<string, string | null>>(sql, params, { parsers: TEXT_PARSERS })).rows);
  }

  /** 人が書いた SQL（複数の文でもよい）を流す。 */
  run(sql: string): Promise<RunResult> {
    return this.exclusive(async (pg) => {
      const notices: string[] = [];
      let results: Results[];
      try {
        results = await pg.exec(sql, { parsers: TEXT_PARSERS, onNotice: (n) => notices.push(n.message ?? String(n)) });
      } finally {
        // 途中で止まった SQL がトランザクションを開いたままにしないように。
        await pg.query("ROLLBACK").catch(() => undefined);
      }
      return {
        notices,
        statements: results.map((r) => ({
          command: r.command ?? "",
          rowCount: r.rowCount ?? null,
          columns: r.fields.map((f) => f.name),
          rows: r.rows.map((row) => r.fields.map((f) => (row[f.name] as string | null) ?? null)),
        })),
      };
    });
  }
}
