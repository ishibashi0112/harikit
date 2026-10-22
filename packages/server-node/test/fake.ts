// テスト用のメモリ上の方言と許可リスト（handlers と CLI のテストで使う）。

import { sameValue, type Row } from "patchiri-core";
import type { Dialect, ScriptUpdate, ServerConfig, TableMeta, Transaction } from "../src/index.js";

export const META: TableMeta = {
  table: "dbo.M_Product",
  columns: [
    { name: "ProductCode", type: "string", dbType: "varchar(10)", maxLength: 10, nullable: false },
    { name: "ProductName", type: "string", dbType: "nvarchar(50)", maxLength: 50, nullable: false },
    { name: "CategoryCode", type: "string", dbType: "varchar(4)", maxLength: 4, maxBytes: 4, encoding: "windows-1252", nullable: false },
    { name: "UnitPrice", type: "decimal", dbType: "decimal(9,2)", precision: 9, scale: 2, nullable: true },
    { name: "Secret", type: "string", dbType: "varchar(10)", maxLength: 10, nullable: true },
  ],
  primaryKey: ["ProductCode"],
  foreignKeys: [{ name: "FK_M_Product_Category", columns: ["CategoryCode"], referencedTable: "dbo.M_Category", referencedColumns: ["CategoryCode"] }],
};
export const CATEGORY: TableMeta = {
  table: "dbo.M_Category",
  columns: [{ name: "CategoryCode", type: "string", dbType: "varchar(4)", maxLength: 4, nullable: false }],
  primaryKey: ["CategoryCode"],
  foreignKeys: [],
};

/** メモリ上の表で動く方言。トランザクションは写しを取って戻す。 */
export class FakeDialect implements Dialect {
  readonly name = "sqlserver";
  tables: Record<string, Row[]> = {
    "dbo.m_product": [
      { ProductCode: "A001", ProductName: "ボールペン黒", CategoryCode: "C01", UnitPrice: "120.00", Secret: "s" },
      { ProductCode: "A002", ProductName: "ボールペン赤", CategoryCode: "C01", UnitPrice: null, Secret: "s" },
    ],
    "dbo.m_category": [{ CategoryCode: "C01" }],
  };
  updates = 0;
  checkStrings?: Dialect["checkStrings"];
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
  renderScript(meta: TableMeta, head: string, updates: ScriptUpdate[]) {
    return [head, ...updates.map((u) => `UPDATE ${meta.table} SET ${JSON.stringify(u.set)} WHERE ${JSON.stringify({ ...u.key, ...u.expect })};`)].join("\n") + "\n";
  }
  async close() {}
}

export const CONFIG: ServerConfig = {
  database: { dialect: "sqlserver", server: "x", database: "x" },
  targets: {
    product: {
      table: "dbo.M_Product",
      access: "update",
      readable: ["ProductCode", "ProductName", "CategoryCode", "UnitPrice"],
      updatable: ["ProductName", "CategoryCode", "UnitPrice"],
    },
    category: { table: "M_Category", access: "read", readable: ["CategoryCode"] },
  },
  limits: { maxFetchKeys: 3, maxApplyRows: 3 },
};
