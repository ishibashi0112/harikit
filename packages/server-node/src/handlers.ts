// API 3 本（describe / fetch / apply）の中身。HTTP と DB の違いはここの外に置く。

import {
  canonical,
  checkChange,
  checkRule,
  checkValue,
  compileRules,
  ruleMessageAt,
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
  type CompiledRule,
  type StampDef,
  type TableDescription,
  type Value,
} from "patchiri-core";
import { DEFAULT_LIMITS, type ServerConfig, type TargetConfig } from "./config.js";
import { DbError, type ColumnMeta, type Dialect, type TableMeta } from "./dialect.js";

export interface ApplyLogEntry {
  requestId: string;
  mode: ApplyMode;
  note?: string;
  appliedBy: string;
  appliedAt: string;
  target: string;
  table: string;
  outcome: "applied" | "checked" | "conflict" | "error";
  /** stampBefore は stamp の列の、反映する前の値（stamp を書いたターゲットだけ）。 */
  rows: { key: Row; before: Row; after: Row; stampBefore?: Row }[];
  conflicts?: Conflict[];
  error?: string;
}

/** whoAmI と isInRole に渡す、呼び出しの文脈。HTTP の入口（http.ts）では req に届いた要求（node:http の IncomingMessage）が入る。 */
export interface RequestContext {
  req?: { headers: Record<string, string | string[] | undefined> };
}

/** whoAmI が名前を返さなかった（未ログイン）。HTTP の入口は 401 にする。 */
export class Unauthenticated extends Error {
  constructor() {
    super("ログインしていません");
    this.name = "Unauthenticated";
  }
}

export interface HandlerDeps {
  config: ServerConfig;
  dialect: Dialect;
  /** 反映した人（Node 版の既定は OS のユーザー名）。名前を返さなければ（null や ""）未ログインで、handle は Unauthenticated を投げる。 */
  whoAmI: (ctx: RequestContext) => string | null | undefined | Promise<string | null | undefined>;
  /** ロールの判定（許可リストの roles）。無ければ、roles を書いたターゲットは誰も使えない（閉じる側に倒す）。 */
  isInRole?: (role: string, ctx: RequestContext) => boolean | Promise<boolean>;
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
  /** stamp の列（DB の綴り）。 */
  stamp: (StampDef & { col: ColumnMeta })[];
  /** scope（DB の綴り）。 */
  scope: Row;
  /** scope のうちキーでない列。DB で行を探すときはキーに足す。 */
  scopeColumns: string[];
  /** サーバに置いた業務ルール（rules を書いていなければ undefined）。 */
  rules?: { raw: unknown[]; compiled: CompiledRule[] };
}

/** 1 回の呼び出しの、呼んだ人。 */
interface Caller {
  user: string;
  ctx: RequestContext;
}

export class Handlers {
  private readonly limits: Limits;
  private readonly metaCache = new Map<string, Promise<TableMeta>>();
  /** execute が成功した requestId と、その結果（二度押し・再送対策）。 */
  private readonly applied = new Map<string, Result>();

  constructor(private readonly deps: HandlerDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.config.limits };
  }

  /** API 1 本を呼ぶ。ctx は whoAmI と isInRole に渡す。whoAmI が名前を返さなければ Unauthenticated を投げる。 */
  async handle(name: "describe" | "fetch" | "apply", body: unknown, ctx: RequestContext = {}): Promise<Result> {
    let user: string | null | undefined;
    try {
      user = await this.deps.whoAmI(ctx);
    } catch (e) {
      return this.failure(e, body);
    }
    if (!user) throw new Unauthenticated();
    const caller: Caller = { user, ctx };
    try {
      if (!isObject(body)) throw new Fail("bad_request", "リクエストが JSON のオブジェクトではありません");
      if (body.v !== 1) throw new Fail("version_unsupported", `v=${JSON.stringify(body.v)} には対応していません（1 だけ）`);
      if (name === "describe") return await this.describe(body, caller);
      if (name === "fetch") return await this.fetch(body, caller);
      return await this.apply(body, caller);
    } catch (e) {
      return this.failure(e, body);
    }
  }

  /** ターゲットを使えるか（roles）。roles を書いていなければ誰でも。判定の手段がなければ使えない。 */
  private async allowed(target: TargetConfig, caller: Caller): Promise<boolean> {
    if (!target.roles) return true;
    const isInRole = this.deps.isInRole;
    if (!isInRole) return false;
    for (const role of target.roles) if (await isInRole(role, caller.ctx)) return true;
    return false;
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

  private async resolve(name: unknown, caller: Caller): Promise<Resolved> {
    if (typeof name !== "string" || !Object.hasOwn(this.deps.config.targets, name)) {
      throw new Fail("unknown_target", `ターゲット ${String(name)} はありません`, { details: { target: name } });
    }
    const target = this.deps.config.targets[name]!;
    if (!(await this.allowed(target, caller))) throw new Fail("forbidden", `ターゲット ${name} を使う権限がありません`, { details: { target: name } });
    const meta = await this.getMeta(target.table);
    const dbCols = new Map(meta.columns.map((c) => [c.name.toLowerCase(), c]));
    const pick = (list: string[]) =>
      list.map((c) => {
        const col = dbCols.get(c.toLowerCase());
        if (!col) throw new Error(`許可リストの列 ${name}.${c} が ${meta.table} にありません`);
        return col.name;
      });
    const readable = new Set(pick(target.readable));
    const labels = new Map(Object.entries(target.labels ?? {}).map(([c, l]) => [pick([c])[0]!.toLowerCase(), l.trim()]));
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
        const label = labels.get(c.name.toLowerCase());
        if (label !== undefined) col.label = label;
        return col;
      });
    const stamp = Object.entries(target.stamp ?? {}).map(([c, value]) => {
      const col = dbCols.get(c.toLowerCase());
      if (!col) throw new Error(`許可リストの列 ${name}.stamp.${c} が ${meta.table} にありません`);
      if (key.includes(col.name)) throw new Error(`${name} のキー列 ${col.name} は stamp にできません`);
      if (col.identity || col.computed) throw new Error(`${name}.stamp の ${col.name} は自動で入る列（IDENTITY や計算列）です`);
      if (value === "now" && !this.deps.dialect.nowExpression?.(col)) throw new Error(`${name}.stamp の ${col.name} は日付・時刻の列ではありません（"now" は日付・時刻の列だけ）`);
      if (value === "user" && col.type !== "string") throw new Error(`${name}.stamp の ${col.name} は文字列の列ではありません（"user" は文字列の列だけ）`);
      return { column: col.name, value, col };
    });
    const scope: Row = {};
    for (const [c, v] of Object.entries(target.scope ?? {})) {
      const col = dbCols.get(c.toLowerCase());
      if (!col) throw new Error(`許可リストの列 ${name}.scope.${c} が ${meta.table} にありません`);
      const msg = checkValue({ ...col, updatable: false, nullable: false }, v);
      if (msg) throw new Error(`${name}.scope.${col.name} の値が列に合いません（${msg}）`);
      scope[col.name] = v;
    }
    const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c]));
    const resolved: Resolved = { name, target, meta, key, columns, byName, stamp, scope, scopeColumns: Object.keys(scope).filter((c) => !key.includes(c)) };
    const rules = this.deps.config.rules;
    if (typeof rules === "object" && rules.targets && Object.hasOwn(rules.targets, name)) {
      const raw = rules.targets[name]!;
      const { rules: compiled, issues } = compileRules({ target: name, columns }, raw, "サーバの業務ルール");
      if (issues.length > 0) throw new Error(`rules.targets.${name} の誤り: ${issues.map((i) => i.message).join(" / ")}`);
      resolved.rules = { raw, compiled };
    }
    return resolved;
  }

  private async describe(body: Body, caller: Caller): Promise<Result> {
    if (body.target === undefined) {
      const targets = [];
      for (const [target, t] of Object.entries(this.deps.config.targets)) {
        // 使えないターゲットは一覧に出さない（roles）。
        if (await this.allowed(t, caller)) targets.push({ target, table: t.table, access: t.access });
      }
      return { ok: true, v: 1, targets };
    }
    const r = await this.resolve(body.target, caller);
    const readableNames = new Set(r.columns.map((c) => c.name));
    const foreignKeys: ForeignKeyDef[] = [];
    for (const fk of r.meta.foreignKeys) {
      if (!fk.columns.every((c) => readableNames.has(c))) continue;
      foreignKeys.push({ ...fk, referencedTarget: await this.findReferenceTarget(fk.referencedTable, fk.referencedColumns, caller) });
    }
    const res: TableDescription = {
      ok: true,
      v: 1,
      target: r.name,
      table: r.meta.table,
      access: r.target.access,
      dialect: this.deps.dialect.name,
      key: r.key,
      columns: r.columns,
      foreignKeys,
      limits: this.limits,
      ...(r.rules && { rules: r.rules.raw }),
      ...(r.stamp.length > 0 && { stamp: r.stamp.map(({ column, value }) => ({ column, value })) }),
      ...(Object.keys(r.scope).length > 0 && { scope: r.scope }),
    };
    return res as unknown as Result;
  }

  /**
   * 参照先テーブルを、キーがちょうど参照先の列になっている読めるターゲットから探す。
   * テーブルは DB で引いた名前で比べる（Oracle のシノニムや既定のスキーマで書いたターゲットも当たるように）。
   */
  private async findReferenceTarget(table: string, columns: string[], caller: Caller): Promise<string | null> {
    const want = this.deps.dialect.normalizeTable(table);
    const cols = new Set(columns.map((c) => c.toLowerCase()));
    for (const name of Object.keys(this.deps.config.targets)) {
      try {
        // 使えないターゲット（roles）も「確認できない」扱いになる。
        const r = await this.resolve(name, caller);
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

  /** キーが scope の中か（scope に書いたキー列は、その値と厳密に同じでなければ外）。 */
  private inScope(r: Resolved, key: Row): boolean {
    return r.key.every((k) => !(k in r.scope) || sameColumnValue(r.byName.get(k.toLowerCase()) ?? r.meta.columns.find((c) => c.name === k)!, key[k]!, r.scope[k]!));
  }

  /** DB で行を探すときのキーの列（キーに scope の列を足したもの）。 */
  private dbKeyColumns(r: Resolved): string[] {
    return [...r.key, ...r.scopeColumns];
  }

  /** DB で行を探すときのキー（scope の値を足したもの）。 */
  private dbKey(r: Resolved, key: Row): Row {
    const out: Row = { ...key };
    for (const c of r.scopeColumns) out[c] = r.scope[c]!;
    return out;
  }

  private async fetch(body: Body, caller: Caller): Promise<Result> {
    const r = await this.resolve(body.target, caller);
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
    // scope の外のキーは DB に聞かずに「見つからない」。
    const asked = keys.map((k, index) => ({ k, index })).filter(({ k }) => this.inScope(r, k));
    const found = asked.length === 0 ? [] : await this.deps.dialect.fetchRows(r.meta, this.dbKeyColumns(r), all, asked.map(({ k }) => this.dbKey(r, k)));
    const rows: (Row | null)[] = keys.map(() => null);
    asked.forEach(({ index }, i) => {
      const values = found[i];
      if (values) rows[index] = Object.fromEntries(all.map((c) => [c, values[c] ?? null]));
    });
    return {
      ok: true,
      v: 1,
      target: r.name,
      rows: rows.map((values, index) => (values ? { index, found: true, values } : { index, found: false })),
    };
  }

  private async apply(body: Body, caller: Caller): Promise<Result> {
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
    const r = await this.resolve(change.target, caller);
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

    const appliedBy = caller.user;
    await this.checkStampUser(r, appliedBy);
    const appliedAt = localIso(this.deps.now?.() ?? new Date());
    const logRows: ApplyLogEntry["rows"] = rows.map((row) => ({ ...row }));
    const logBase = { requestId, mode, ...(note !== undefined && { note }), appliedBy, appliedAt, target: r.name, table: r.meta.table, rows: logRows };

    // 反映する SQL の文面は先に作る。戻し SQL は stamp の列の今の値を使うので、ロックして読んだ後（コミットの前）に作る。
    const script = this.renderApplyScript(r, requestId, mode, rows, appliedBy);
    const userStamp: Row = Object.fromEntries(r.stamp.filter((s) => s.value === "user").map((s) => [s.column, appliedBy]));
    const nowStamp = r.stamp.filter((s) => s.value === "now").map((s) => s.column);
    // ロックした行から読む列: stamp の列（戻し SQL のため）と、サーバの業務ルールが見るほかの列。
    const dbKeyCols = this.dbKeyColumns(r);
    const ruleColumns = (r.rules?.compiled ?? []).filter((rule) => (rule.severity ?? "error") === "error").flatMap((rule) => rule.columns);
    const readFor = (row: { before: Row }) =>
      [...new Set([...r.stamp.map((s) => s.column), ...ruleColumns])].filter((c) => !dbKeyCols.includes(c) && !(c in row.before));

    // 2〜6. トランザクションの中で、ロックを掛けて今の値を確かめてから流す。
    type Outcome = { conflicts: Conflict[]; updated: number; duplicate?: [number, number]; rowErrors?: RowError[]; undoScript?: string };
    let outcome: Outcome;
    try {
      outcome = await this.deps.dialect.transaction<Outcome>(async (tx) => {
        const conflicts: Conflict[] = [];
        const dbKeys = new Map<string, number>();
        const readValues: Row[] = [];
        for (const [index, row] of rows.entries()) {
          if (!this.inScope(r, row.key)) {
            conflicts.push({ target: r.name, index, key: row.key, reason: "not_found" });
            readValues.push({});
            continue;
          }
          const locked = await tx.lockAndCompare(r.meta, dbKeyCols, this.dbKey(r, row.key), row.before, readFor(row));
          readValues.push(locked.read ?? {});
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
        if (conflicts.length > 0) return { commit: false, value: { conflicts, updated: 0 } };
        const ruleErrors = this.checkServerRules(r, rows, rowIndexes, readValues);
        if (ruleErrors.length > 0) return { commit: false, value: { conflicts, updated: 0, rowErrors: ruleErrors } };
        rows.forEach((row, i) => {
          if (r.stamp.length > 0) logRows[i]!.stampBefore = Object.fromEntries(r.stamp.map((s) => [s.column, readValues[i]![s.column] ?? null]));
        });
        const undoScript = this.renderUndoScript(r, requestId, rows, logRows);
        if (mode === "check") return { commit: false, value: { conflicts, updated: 0, undoScript } };
        let updated = 0;
        for (const row of rows) {
          const n = await tx.update(r.meta, dbKeyCols, this.dbKey(r, row.key), { ...row.after, ...userStamp }, nowStamp);
          if (n !== 1) throw new DbError(`UPDATE の影響行数が ${n} でした（1 のはず）: ${JSON.stringify(row.key)}`);
          updated += n;
        }
        return { commit: true, value: { conflicts, updated, undoScript } };
      });
    } catch (e) {
      await this.safeLog({ ...logBase, outcome: "error", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }

    if (outcome.duplicate) {
      const [a, b] = outcome.duplicate;
      throw new Fail("bad_request", "1 行に誤りがあります", {
        rowErrors: [{ target: r.name, index: rowIndexes[b]!, code: "duplicate_key", message: `${rowIndexes[a]} 番目の行と DB 上で同じ行を指しています` }],
      });
    }
    if (outcome.rowErrors) {
      const n = new Set(outcome.rowErrors.map((e) => e.index)).size;
      throw new Fail("bad_request", `${n} 行がサーバの業務ルールに合いません`, { rowErrors: outcome.rowErrors });
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
      undoScript: outcome.undoScript!,
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

  /** stamp の "user" の列に、反映した人の名前が入るか。入らなければ DB に触る前に止める。 */
  private async checkStampUser(r: Resolved, user: string): Promise<void> {
    for (const s of r.stamp) {
      if (s.value !== "user") continue;
      const msg = checkValue({ ...s.col, updatable: false, nullable: false }, user);
      let bad = msg;
      if (!bad && this.deps.dialect.checkStrings) {
        const [res] = await this.deps.dialect.checkStrings(r.meta, [{ column: s.column, value: user }]);
        if (res && !res.encodable) bad = "列の文字コードで表せない字があります";
        else if (res && s.col.maxBytes !== undefined && res.bytes > s.col.maxBytes) bad = `${s.col.maxBytes} バイトを超えています（${res.bytes} バイト）`;
      }
      if (bad) throw new Fail("bad_request", `反映した人の名前（${user}）が stamp の列 ${s.column} に入りません（${bad}）`, { details: { column: s.column } });
    }
  }

  /**
   * サーバに置いた業務ルールのうち error のものを、反映した後の行（ロックして読んだ値に after を重ねたもの）で見る。
   * 行が変える列にかかわるルールだけを見る（変えない列のルールは見ない）。
   */
  private checkServerRules(r: Resolved, rows: { key: Row; before: Row; after: Row }[], rowIndexes: number[], readValues: Row[]): RowError[] {
    const rules = (r.rules?.compiled ?? []).filter((rule) => (rule.severity ?? "error") === "error");
    if (rules.length === 0) return [];
    const errors: RowError[] = [];
    rows.forEach((row, i) => {
      const merged: Row = { ...readValues[i], ...r.scope, ...row.key, ...row.after };
      for (const rule of rules) {
        const touched = rule.columns.filter((c) => c in row.after);
        if (touched.length === 0) continue;
        const column = rule.column in row.after ? rule.column : touched[0]!;
        const broken =
          checkRule(rule, merged[rule.column] ?? null, merged) ??
          (rule.column in row.after ? checkChange(rule, row.before[rule.column] ?? null, row.after[rule.column] ?? null, merged) : null);
        if (broken) errors.push({ target: r.name, index: rowIndexes[i]!, code: "rule_violation", column, message: ruleMessageAt(rule, broken, column, merged) });
      }
    });
    return errors;
  }

  private scriptHead(r: Resolved, requestId: string, rows: unknown[]): string {
    return `-- patchiri ${requestId} ${r.name} (${r.meta.table}) ${rows.length}行`;
  }

  private renderApplyScript(r: Resolved, requestId: string, mode: ApplyMode, rows: { key: Row; before: Row; after: Row }[], user: string): string {
    const userStamp: Row = Object.fromEntries(r.stamp.filter((s) => s.value === "user").map((s) => [s.column, user]));
    const now = r.stamp.filter((s) => s.value === "now").map((s) => s.column);
    const head = `${this.scriptHead(r, requestId, rows)} ${mode === "check" ? "実行予定" : "実行済み"}`;
    const updates = rows.map((row) => ({ set: { ...row.after, ...userStamp }, key: this.dbKey(r, row.key), expect: row.before, ...(now.length > 0 && { now }) }));
    return this.deps.dialect.renderScript(r.meta, head, updates, "apply");
  }

  /** 戻し SQL。stamp の列は反映する前の値（ロックして読んだ値）に戻す。戻す条件はデータの列が after のままか。 */
  private renderUndoScript(r: Resolved, requestId: string, rows: { key: Row; before: Row; after: Row }[], logRows: ApplyLogEntry["rows"]): string {
    const updates = rows.map((row, i) => ({ set: { ...row.before, ...logRows[i]!.stampBefore }, key: this.dbKey(r, row.key), expect: row.after }));
    return this.deps.dialect.renderScript(r.meta, `${this.scriptHead(r, requestId, rows)} の戻し`, updates, "undo");
  }
}

