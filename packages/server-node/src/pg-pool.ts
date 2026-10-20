// PostgreSQL の方言に、pg（node-postgres）の Pool でつなぐ。

import pg from "pg";
import type { PostgresConnection } from "./config.js";
import type { PgConnector, PgSession } from "./postgres.js";

/** 値は方言が SQL 側で文字列にして読むので、pg には型の読み替えをさせない。 */
const RAW_TYPES = { getTypeParser: () => (v: string) => v };

export class PgPoolConnector implements PgConnector {
  private readonly pool: pg.Pool;

  constructor(conn: PostgresConnection) {
    this.pool = new pg.Pool({
      host: conn.host,
      port: conn.port ?? 5432,
      database: conn.database,
      user: conn.user,
      password: conn.password,
      ...(conn.ssl !== undefined && { ssl: conn.ssl }),
      application_name: "harikit",
      max: 4,
    });
    // 使っていないつなぎが DB 側で切られたときのエラー。次に借りるときにつなぎ直すので、落とさない。
    this.pool.on("error", () => undefined);
  }

  async withSession<T>(fn: (s: PgSession) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const session: PgSession = {
      query: async (text, params = []) => {
        const res = await client.query({ text, values: params, types: RAW_TYPES });
        return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount };
      },
    };
    try {
      const value = await fn(session);
      client.release();
      return value;
    } catch (e) {
      // 途中で失敗したつなぎは使い回さない（方言がロールバックした後でも、念のため捨てる）。
      client.release(true);
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
