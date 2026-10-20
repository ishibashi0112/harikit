// API 3 本（describe / fetch / apply）の中身。HTTP と DB の違いはここの外に置く。

import {
  canonical,
  checkValue,
  sameColumnValue,
  type ApiError,
  type ApplyMode,
  type ColumnDef,
  type Conflict,
  type Failure,
  type ForeignKeyDef,
  type Limits,
  type Row,
  type RowError,
  type TableDescription,
  type Value,
} from "patchiri-core";
import { DEFAULT_LIMITS, type ServerConfig, type TargetConfig } from "./config.js";
import { DbError, type Dialect, type TableMeta } from "./dialect.js";

export interface ApplyLogEntry {
  requestId: string;
  mode: ApplyMode;
  note?: string;
  appliedBy: string;
  appliedAt: string;
  target: string;
  table: string;
  outcome: "applied" | "checked" | "conflict" | "error";
  rows: { key: Row; before: Row; after: Row }[];
  conflicts?: Conflict[];
  error?: string;
}

export interface HandlerDeps {
  config: ServerConfig;
  dialect: Dialect;
  /** 反映した人（Node 版は OS のユーザー名）。 */
  whoAmI: () => string;
  log: (entry: ApplyLogEntry) => Promise<void>;
  /** サーバ側のエラーを残す。 */
  logError?: (err: unknown) => void;
  now?: () => Date;
}

type Body = Record<string, unknown>;
type Result = Record<string, unknown> & { ok: boolean; v: 1 };

/** 業務上の失敗。HTTP 200 の ok:false で返す（仕様 1.5）。 */
class Fail extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly extra: Partial<Failure> & { details?: Record<string, unknown> } = {},
  ) {
    super(message);
  }
}

const REQUEST_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;

function localIso(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

interface Resolved {
  name: string;
  target: TargetConfig;
  meta: TableMeta;
  key: string[];
  columns: ColumnDef[];
  byName: Map<string, ColumnDef>;
}

export class Handlers {
  private readonly limits: Limits;
  private readonly metaCache = new Map<string, Promise<TableMeta>>();
  /** execute が成功した requestId と、その結果（二度押し・再送対策）。 */
  private readonly applied = new Map<string, Result>();

  constructor(private readonly deps: HandlerDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.config.limits };
  }

  async handle(name: "describe" | "fetch" | "apply", body: unknown): Promise<Result> {
    try {
      if (!isObject(body)) throw new Fail("bad_request", "リクエストが JSON のオブジェクトではありません");
      if (body.v !== 1) throw new Fail("version_unsupported", `v=${JSON.stringify(body.v)} には対応していません（1 だけ）`);
      if (name === "describe") return await this.describe(body);
      if (name === "fetch") return await this.fetch(body);
      return await this.apply(body);
    } catch (e) {
      return this.failure(e, body);
    }
  }

  private failure(e: unknown, body: unknown): Result {
    let error: ApiError;
    let extra: Partial<Failure> = {};
    if (e instanceof Fail) {
      error = { code: e.code, message: e.message, ...(e.extra.details && { details: e.extra.details }) };
      const { details: _, ...rest } = e.extra;
      extra = rest;
    } else if (e instanceof DbError) {
      this.deps.logError?.(e);
      error = { code: "db_error", message: this.deps.config.exposeDbErrors ? e.message : (e.publicMessage ?? "DB がエラーを返しました（詳細はサーバのログ）") };
    } else {
      this.deps.logError?.(e);
      error = { code: "internal_error", message: "サーバでエラーが起きました（詳細はサーバのログ）" };
    }
    const b = isObject(body) ? body : {};
    return {
      ok: false,
      v: 1,
      ...(typeof b.requestId === "string" && { requestId: b.requestId }),
      ...((b.mode === "check" || b.mode === "execute") && { mode: b.mode }),
      error,
      ...extra,
    };
  }

  private getMeta(table: string): Promise<TableMeta> {
    let p = this.metaCache.get(table);
    if (!p) {
      p = this.deps.dialect.describeTable(table);
      p.catch(() => this.metaCache.delete(table));
      this.metaCache.set(table, p);
    }
    return p;
  }

  private async resolve(name: unknown): Promise<Resolved> {
    if (typeof name !== "string" || !Object.hasOwn(this.deps.config.targets, name)) {
      throw new Fail("unknown_target", `ターゲット ${String(name)} はありません`, { details: { target: name } });
    }
    const target = this.deps.config.targets[name]!;
    const meta = await this.getMeta(target.table);
    const dbCols = new Map(meta.columns.map((c) => [c.name.toLowerCase(), c]));
    const pick = (list: string[]) =>
      list.map((c) => {
        const col = dbCols.get(c.toLowerCase());
        if (!col) throw new Error(`許可リストの列 ${name}.${c} が ${meta.table} にありません`);
        return col.name;
      });
    const readable = new Set(pick(target.readable));
    const key = target.key ? pick(target.key) : meta.primaryKey;
    if (key.length === 0) throw new Error(`${name} のキーがわかりません（主キーがないので key を設定してください）`);
    for (const k of key) if (!readable.has(k)) throw new Error(`${name} のキー列 ${k} が readable にありません`);
    const updatable = new Set(target.access === "update" ? pick(target.updatable ?? []) : []);
    const columns: ColumnDef[] = meta.columns
      .filter((c) => readable.has(c.name))
      .map((c) => {
        // 方言が内部用に持つ項目は出さない。
        const col: ColumnDef = {
          name: c.name,
          type: c.type,
          dbType: c.dbType,
          nullable: c.nullable,
          updatable: updatable.has(c.name) && !key.includes(c.name) && c.type !== "other" && !c.identity && !c.computed,
        };
        for (const k of ["maxLength", "maxBytes", "encoding", "emptyIsNull", "precision", "scale", "min", "max", "identity", "computed", "hasDefault"] as const) {
          if (c[k] !== undefined) (col as unknown as Record<string, unknown>)[k] = c[k];
        }
        return col;
      });
    return { name, target, meta, key, columns, byName: new Map(columns.map((c) => [c.name.toLowerCase(), c])) };
  }

  private async describe(body: Body): Promise<Result> {
    if (body.target === undefined) {
      return {
        ok: true,
        v: 1,
        targets: Object.entries(this.deps.config.targets).map(([target, t]) => ({ target, table: t.table, access: t.access })),
      };
    }
    const r = await this.resolve(body.target);
    const readableNames = new Set(r.columns.map((c) => c.name));
    const foreignKeys: ForeignKeyDef[] = [];
    for (const fk of r.meta.foreignKeys) {
      if (!fk.columns.every((c) => readableNames.has(c))) continue;
      foreignKeys.push({ ...fk, referencedTarget: await this.findReferenceTarget(fk.referencedTable, fk.referencedColumns) });
    }
    const res: TableDescription = {
      ok: true,
      v: 1,
      target: r.name,
      table: r.target.table,
      access: r.target.access,
      dialect: this.deps.dialect.name,
      key: r.key,
      columns: r.columns,
      foreignKeys,
      limits: this.limits,
    };
    return res as unknown as Result;
  }

  /**
   * 参照先テーブルを、キーがちょうど参照先の列になっている読めるターゲットから探す。
   * テーブルは DB で引いた名前で比べる（Oracle のシノニムや既定のスキーマで書いたターゲットも当たるように）。
   */
  private async findReferenceTarget(table: string, columns: string[]): Promise<string | null> {
    const want = this.deps.dialect.normalizeTable(table);
    const cols = new Set(columns.map((c) => c.toLowerCase()));
    for (const name of Object.keys(this.deps.config.targets)) {
      try {
        const r = await this.resolve(name);
        if (this.deps.dialect.normalizeTable(r.meta.table) !== want) continue;
        if (r.key.length === cols.size && r.key.every((k) => cols.has(k.toLowerCase()))) return name;
      } catch {
        // 参照先の設定がおかしいときは「確認できない」扱いにする。
      }
    }
    return null;
  }

  /** キーのオブジェクトを確かめ、列名を DB の綴りにそろえる。 */
  private normalizeKey(r: Resolved, key: unknown): { key?: Row; error?: { code: string; column?: string; message: string } } {
    if (!isObject(key)) return { error: { code: "key_mismatch", message: "キーがオブジェクトではありません" } };
    const out: Row = {};
    for (const [k, v] of Object.entries(key)) {
      const name = r.key.find((x) => x.toLowerCase() === k.toLowerCase());
      if (!name || name in out) return { error: { code: "key_mismatch", column: k, message: `キーに列 ${k} は使えません` } };
      const col = r.byName.get(name.toLowerCase())!;
      const msg = v === null ? "キーが null です" : checkValue({ ...col, nullable: true }, v as Value);
      if (msg) return { error: { code: "invalid_value", column: name, message: msg } };
      out[name] = v as Value;
    }
    if (Object.keys(out).length !== r.key.length) return { error: { code: "key_mismatch", message: `キーの列は ${r.key.join(", ")} です` } };
    return { key: out };
  }

  private async fetch(body: Body): Promise<Result> {
    const r = await this.resolve(body.target);
    if (!Array.isArray(body.keys)) throw new Fail("bad_request", "keys がありません");
    if (body.keys.length > this.limits.maxFetchKeys) {
      throw new Fail("too_many_rows", `keys は ${this.limits.maxFetchKeys} 件までです`, { details: { limit: this.limits.maxFetchKeys } });
    }
    let columns: string[];
    if (body.columns === undefined) columns = r.columns.map((c) => c.name);
    else {
      if (!Array.isArray(body.columns)) throw new Fail("bad_request", "columns は列名の配列です");
      columns = body.columns.map((c) => {
        const col = typeof c === "string" ? r.byName.get(c.toLowerCase()) : undefined;
        if (!col) throw new Fail("column_not_allowed", `列 ${String(c)} は読めません`, { details: { column: c } });
        return col.name;
      });
    }
    const keys = body.keys.map((k, index) => {
      const n = this.normalizeKey(r, k);
      if (n.error) throw new Fail(n.error.code === "invalid_value" ? "bad_request" : n.error.code, `keys[${index}]: ${n.error.message}`, { details: { index } });
      return n.key!;
    });
    const all = [...r.key, ...columns.filter((c) => !r.key.includes(c))];
    const rows = keys.length === 0 ? [] : await this.deps.dialect.fetchRows(r.meta, r.key, all, keys);
    return {
      ok: true,
      v: 1,
      target: r.name,
      rows: rows.map((values, index) => (values ? { index, found: true, values } : { index, found: false })),
    };
  }

  private async apply(body: Body): Promise<Result> {
    const requestId = body.requestId;
    if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) throw new Fail("bad_request", "requestId がないか、形が違います");
    const mode = body.mode as ApplyMode;
    if (mode !== "check" && mode !== "execute") throw new Fail("bad_request", "mode は \"check\" か \"execute\" です");
    if (body.note !== undefined && typeof body.note !== "string") throw new Fail("bad_request", "note は文字列です");
    const note = body.note as string | undefined;
    if (mode === "execute") {
      const done = this.applied.get(requestId);
      if (done) return done;
    }
    if (!Array.isArray(body.changes) || body.changes.length !== 1 || !isObject(body.changes[0])) {
      throw new Fail("bad_request", "changes は要素 1 つの配列です（v1 は 1 テーブルだけ）");
    }
    const change = body.changes[0];
    const r = await this.resolve(change.target);
    if (r.target.access !== "update") throw new Fail("bad_request", `${r.name} は読むだけのターゲットです`);
    if (!Array.isArray(change.rows) || change.rows.length === 0) throw new Fail("bad_request", "rows がありません");
    if (change.rows.length > this.limits.maxApplyRows) {
      throw new Fail("too_many_rows", `rows は ${this.limits.maxApplyRows} 行までです`, { details: { limit: this.limits.maxApplyRows } });
    }

    // 1. 許可リストとの照合。行ごとの誤りはまとめて返す。
    const rowErrors: RowError[] = [];
    const rows: { key: Row; before: Row; after: Row }[] = [];
    const rowIndexes: number[] = [];
    const seenKeys = new Map<string, number>();
    change.rows.forEach((raw: unknown, index: number) => {
      const rowErr = (code: string, message: string, column?: string) =>
        rowErrors.push({ target: r.name, index, code, ...(column !== undefined && { column }), message });
      if (!isObject(raw)) return rowErr("bad_request", "行がオブジェクトではありません");
      if (raw.op !== undefined && raw.op !== "update") return rowErr("bad_request", `op ${String(raw.op)} には対応していません（update だけ）`);
      const k = this.normalizeKey(r, raw.key);
      if (k.error) return rowErr(k.error.code, k.error.message, k.error.column);
      if (!isObject(raw.before) || !isObject(raw.after)) return rowErr("bad_request", "before と after がありません");
      const before: Row = {};
      const after: Row = {};
      let bad = false;
      const afterNames = new Map(Object.keys(raw.after).map((c) => [c.toLowerCase(), c]));
      if (afterNames.size === 0) return rowErr("bad_request", "更新する列がありません");
      if (Object.keys(raw.before).length !== afterNames.size) return rowErr("bad_request", "before と after の列が違います");
      for (const [c, bv] of Object.entries(raw.before)) {
        const col = r.byName.get(c.toLowerCase());
        if (!col || !col.updatable) {
          rowErr("column_not_allowed", `列 ${c} は更新が許可されていません`, c);
          bad = true;
          continue;
        }
        const ac = afterNames.get(c.toLowerCase());
        if (ac === undefined || col.name in before) {
          rowErr("bad_request", "before と after の列が違います", col.name);
          bad = true;
          continue;
        }
        const av = raw.after[ac] as Value;
        const bMsg = checkValue({ ...col, nullable: true }, bv as Value);
        const aMsg = checkValue(col, av);
        if (bMsg || aMsg) {
          rowErr("invalid_value", `${bMsg ? "before" : "after"}: ${bMsg ?? aMsg}`, col.name);
          bad = true;
          continue;
        }
        if (sameColumnValue(col, bv as Value, av)) {
          rowErr("bad_request", "before と after が同じです", col.name);
          bad = true;
          continue;
        }
        before[col.name] = bv as Value;
        after[col.name] = av;
      }
      if (bad) return;
      const id = JSON.stringify(r.key.map((kc) => canonical(r.byName.get(kc.toLowerCase())!.type, k.key![kc]!)));
      if (seenKeys.has(id)) return rowErr("duplicate_key", `${seenKeys.get(id)} 番目の行とキーが同じです`);
      seenKeys.set(id, index);
      rows.push({ key: k.key!, before, after });
      rowIndexes.push(index);
    });
    if (rowErrors.length === 0) rowErrors.push(...(await this.checkStrings(r, rows, rowIndexes)));
    if (rowErrors.length > 0) {
      const n = new Set(rowErrors.map((e) => e.index)).size;
      throw new Fail("bad_request", `${n} 行に誤りがあります`, { rowErrors });
    }

    const appliedBy = this.deps.whoAmI();
    const appliedAt = localIso(this.deps.now?.() ?? new Date());
    const logBase = { requestId, mode, ...(note !== undefined && { note }), appliedBy, appliedAt, target: r.name, table: r.meta.table, rows };

    // SQL の文面は先に作る（コミットした後に失敗して戻し SQL が返らない、を避ける）。
    const { script, undoScript } = this.renderScripts(r, requestId, mode, rows);

    // 2〜6. トランザクションの中で、ロックを掛けて今の値を確かめてから流す。
    type Outcome = { conflicts: Conflict[]; updated: number; duplicate?: [number, number] };
    let outcome: Outcome;
    try {
      outcome = await this.deps.dialect.transaction<Outcome>(async (tx) => {
        const conflicts: Conflict[] = [];
        const dbKeys = new Map<string, number>();
        for (const [index, row] of rows.entries()) {
          const locked = await tx.lockAndCompare(r.meta, r.key, row.key, row.before);
          if (!locked.found) {
            conflicts.push({ target: r.name, index, key: row.key, reason: "not_found" });
            continue;
          }
          const dbKey = JSON.stringify(r.key.map((kc) => locked.dbKey?.[kc] ?? null));
          const other = dbKeys.get(dbKey);
          if (other !== undefined) return { commit: false, value: { conflicts: [], updated: 0, duplicate: [other, index] } };
          dbKeys.set(dbKey, index);
          if (locked.changed && locked.changed.length > 0) {
            conflicts.push({ target: r.name, index, key: row.key, reason: "changed", columns: locked.changed, current: locked.current! });
          }
        }
        if (conflicts.length > 0 || mode === "check") return { commit: false, value: { conflicts, updated: 0 } };
        let updated = 0;
        for (const row of rows) {
          const n = await tx.update(r.meta, r.key, row.key, row.after);
          if (n !== 1) throw new DbError(`UPDATE の影響行数が ${n} でした（1 のはず）: ${JSON.stringify(row.key)}`);
          updated += n;
        }
        return { commit: true, value: { conflicts, updated } };
      });
    } catch (e) {
      await this.safeLog({ ...logBase, outcome: "error", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }

    if (outcome.duplicate) {
      const [a, b] = outcome.duplicate;
      throw new Fail("bad_request", "1 行に誤りがあります", {
        rowErrors: [{ target: r.name, index: b, code: "duplicate_key", message: `${a} 番目の行と DB 上で同じ行を指しています` }],
      });
    }
    if (outcome.conflicts.length > 0) {
      await this.safeLog({ ...logBase, outcome: "conflict", conflicts: outcome.conflicts });
      throw new Fail("conflict", `${outcome.conflicts.length} 行が差分を取った後に変わっていたため、何も反映していません`, {
        conflicts: outcome.conflicts,
      });
    }

    const result: Result = {
      ok: true,
      v: 1,
      requestId,
      mode,
      appliedAt,
      appliedBy,
      results: [{ target: r.name, updated: outcome.updated }],
      script,
      undoScript,
    };
    if (mode === "execute") this.applied.set(requestId, result);
    // コミットした後なので、ログが書けなくても結果（戻し SQL）は返す。
    await this.safeLog({ ...logBase, outcome: mode === "execute" ? "applied" : "checked" });
    return result;
  }

  /**
   * 書き込む文字列が列の文字コードで表せるか、バイト数に収まるかを DB で確かめる。
   * checkValue の表（WHATWG）は DB のコードページより広いことがある（big5 と cp950 など）ので、最後はここで見る。
   */
  private async checkStrings(r: Resolved, rows: { after: Row }[], rowIndexes: number[]): Promise<RowError[]> {
    if (!this.deps.dialect.checkStrings) return [];
    const items: { column: string; value: string; index: number }[] = [];
    rows.forEach((row, i) => {
      for (const [column, value] of Object.entries(row.after)) {
        if (typeof value === "string" && r.byName.get(column.toLowerCase())?.type === "string") items.push({ column, value, index: rowIndexes[i]! });
      }
    });
    if (items.length === 0) return [];
    const results = await this.deps.dialect.checkStrings(r.meta, items);
    const errors: RowError[] = [];
    results.forEach((res, i) => {
      if (!res) return;
      const { column, index } = items[i]!;
      const col = r.byName.get(column.toLowerCase())!;
      const enc = col.encoding ? `（${col.encoding}）` : "";
      if (!res.encodable) errors.push({ target: r.name, index, code: "invalid_value", column, message: `after: 列の文字コード${enc}で表せない字があります` });
      else if (col.maxBytes !== undefined && res.bytes > col.maxBytes) {
        errors.push({ target: r.name, index, code: "invalid_value", column, message: `after: ${col.maxBytes} バイトを超えています（${res.bytes} バイト）` });
      }
    });
    return errors;
  }

  private async safeLog(entry: ApplyLogEntry): Promise<void> {
    try {
      await this.deps.log(entry);
    } catch (e) {
      this.deps.logError?.(e);
    }
  }

  private renderScripts(r: Resolved, requestId: string, mode: ApplyMode, rows: { key: Row; before: Row; after: Row }[]) {
    const d = this.deps.dialect;
    const head = `-- patchiri ${requestId} ${r.name} (${r.meta.table}) ${rows.length}行`;
    const script = d.renderScript(r.meta, `${head} ${mode === "check" ? "実行予定" : "実行済み"}`, rows.map((row) => ({ set: row.after, key: row.key, expect: row.before })), "apply");
    const undoScript = d.renderScript(r.meta, `${head} の戻し`, rows.map((row) => ({ set: row.before, key: row.key, expect: row.after })), "undo");
    return { script, undoScript };
  }
}

