// harikit の画面。表に貼り付けて、検証 → 差分 → DB で確かめる → 反映、を順に行う。
// 検証・差分・反映の中身はコア（@harikit/core）で、CLI と同じ。

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { SpreadsheetGrid, type GridColumn, type SpreadsheetGridHandle } from "@ishibashi0112/spreadsheet-grid";
import {
  buildApplyRequest,
  buildPlan,
  columnLetter,
  diffToCsv,
  groupReadings,
  HarikitApiError,
  HarikitHttpError,
  issuesToCsv,
  prepare,
  readingsToCsv,
  type ApplyMode,
  type ApplyResponse,
  type DiffResult,
  type Failure,
  type HarikitClient,
  type Issue,
  type PrepareResult,
  type Reading,
  type TableDescription,
  type TargetSummary,
} from "@harikit/core";
import { download, loadRules, makeClient, parseRules, saveToken, storeRules, takeToken, type RulesFile } from "./browser.js";
import {
  addConflictMarks,
  addHeader,
  blankRows,
  buildMarks,
  cellText,
  diffGridRows,
  headerInfo,
  issuePlace,
  liveMark,
  readingNote,
  stamp,
  toSheet,
  type DiffGridRow,
  type GridRow,
  type Marks,
} from "./sheet.js";

const INITIAL_ROWS = 100;
const INITIAL_COLUMNS = 10;
const TARGET_KEY = "harikit.target";
const EMPTY_MARKS: Marks = new Map();

let lastId = 0;
const nextId = () => ++lastId;

type Connection =
  | { state: "connecting" }
  | { state: "need-token"; message?: string }
  | { state: "ready"; client: HarikitClient; targets: TargetSummary[] }
  | { state: "offline"; message: string };

interface Prepared {
  result: PrepareResult;
  /** 検証したときの表。 */
  rows: GridRow[];
  version: number;
  target: string;
  rules: RulesFile | null;
  /** 確かめるときと反映するときで同じものを使う（二度押しでも一度だけ反映される）。 */
  requestId: string;
  marks: Marks;
  at: Date;
}

type Applied =
  | { mode: ApplyMode; state: "running" }
  | { mode: ApplyMode; state: "ok"; response: ApplyResponse }
  | { mode: ApplyMode; state: "failed"; failure: Failure };

function errorMessage(e: unknown): string {
  if (e instanceof HarikitApiError) return `${e.failure.error.message}（${e.failure.error.code}）`;
  if (e instanceof TypeError) return "サーバに届きません。harikit サーバが動いているか確かめてください";
  return e instanceof Error ? e.message : String(e);
}

function remembered(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 覚えられなくても困らない。
  }
}

export function App() {
  const [conn, setConn] = useState<Connection>({ state: "connecting" });
  const [target, setTarget] = useState("");
  const [desc, setDesc] = useState<TableDescription | null>(null);
  const [rules, setRules] = useState<RulesFile | null>(() => loadRules());
  const [rows, setRows] = useState<GridRow[]>(() => blankRows(INITIAL_ROWS, nextId));
  const [columnCount, setColumnCount] = useState(INITIAL_COLUMNS);
  const [version, setVersion] = useState(0);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [tab, setTab] = useState<"input" | "diff">("input");
  const [error, setError] = useState<string | null>(null);
  const gridRef = useRef<SpreadsheetGridHandle<GridRow>>(null);

  const connect = useCallback(async (token: string | null) => {
    if (!token) return setConn({ state: "need-token" });
    setConn({ state: "connecting" });
    const client = makeClient(token);
    try {
      const res = await client.targets();
      const targets = res.targets.filter((t) => t.access === "update");
      setConn({ state: "ready", client, targets });
      const last = remembered(TARGET_KEY);
      setTarget((cur) => cur || (targets.some((t) => t.target === last) ? last : targets.length === 1 ? targets[0]!.target : ""));
    } catch (e) {
      if (e instanceof HarikitHttpError && e.status === 401) {
        saveToken(null);
        setConn({ state: "need-token", message: "トークンが違います。サーバを起動したときに出た URL から開き直すか、トークンを貼ってください" });
      } else setConn({ state: "offline", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void connect(takeToken());
  }, [connect]);

  useEffect(() => {
    setDesc(null);
    if (conn.state !== "ready" || !target) return;
    remember(TARGET_KEY, target);
    let alive = true;
    conn.client.describe(target).then(
      (d) => alive && setDesc(d),
      (e: unknown) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [conn, target]);

  const stale = prepared !== null && (prepared.version !== version || prepared.target !== target || prepared.rules !== rules);
  const marks = prepared && prepared.target === target ? prepared.marks : EMPTY_MARKS;
  const diff = prepared?.result.diff ?? null;

  const onRowsChange = useCallback((next: GridRow[]) => {
    setRows(next);
    setVersion((v) => v + 1);
  }, []);

  const sheetColumn = useCallback(
    (c: number): GridColumn<GridRow> => {
      const letter = columnLetter(c);
      return {
        key: letter,
        title: letter,
        width: 140,
        validate: ({ row }) => {
          const m = liveMark(marks, row, letter);
          return m && m.errors.length > 0 ? m.errors.join("\n") : true;
        },
        cellClassName: ({ row, sourceRowIndex }) => {
          if (sourceRowIndex === 0) {
            const info = desc && headerInfo(desc, cellText(row, letter));
            return info ? `hk-head hk-head--${info.kind}` : "hk-head";
          }
          const m = liveMark(marks, row, letter);
          if (!m) return undefined;
          return [m.kind && `hk-${m.kind}`, m.warn && "hk-warn", m.read && "hk-read"].filter(Boolean).join(" ") || undefined;
        },
        cellNote: ({ row, sourceRowIndex }) => {
          if (sourceRowIndex === 0) return desc ? headerInfo(desc, cellText(row, letter))?.note : undefined;
          return liveMark(marks, row, letter)?.notes.join("\n");
        },
      };
    },
    [marks, desc],
  );

  const columns = useMemo(() => Array.from({ length: columnCount }, (_, c) => sheetColumn(c)), [columnCount, sheetColumn]);

  const clearSheet = () => {
    setRows(blankRows(INITIAL_ROWS, nextId));
    setColumnCount(INITIAL_COLUMNS);
    setVersion((v) => v + 1);
    setTab("input");
  };

  const insertHeader = (name: string) => {
    const { rows: next, col } = addHeader(rows, columnCount, name);
    if (col >= columnCount) setColumnCount(col + 1);
    onRowsChange(next);
    setTab("input");
    requestAnimationFrame(() => gridRef.current?.selectCell(1, col, { scrollIntoView: true }));
  };

  const jump = (i: { row?: number; col?: number }) => {
    if (i.row === undefined || i.col === undefined) return;
    setTab("input");
    requestAnimationFrame(() => gridRef.current?.selectCell(i.row!, i.col!, { scrollIntoView: true }));
  };

  const runPrepare = async () => {
    if (conn.state !== "ready" || !target) return;
    const snapshot = rows;
    const v = version;
    setPreparing(true);
    setApplied(null);
    setConfirming(false);
    setError(null);
    try {
      const result = await prepare(conn.client, target, toSheet(snapshot, columnCount), rules ? { rules: rules.config } : {});
      setPrepared({ result, rows: snapshot, version: v, target, rules, requestId: crypto.randomUUID(), marks: buildMarks(snapshot, result), at: new Date() });
      if (result.ok && result.diff) setTab("diff");
    } catch (e) {
      setPrepared(null);
      setError(errorMessage(e));
    } finally {
      setPreparing(false);
    }
  };

  const runApply = async (mode: ApplyMode) => {
    if (conn.state !== "ready" || !prepared?.result.diff) return;
    const p = prepared;
    setConfirming(false);
    setApplied({ mode, state: "running" });
    const { v: _, ...req } = buildApplyRequest(p.result.diff!, { mode, requestId: p.requestId, ...(note.trim() && { note: note.trim() }) });
    try {
      const res = await conn.client.apply(req);
      if (res.ok) return setApplied({ mode, state: "ok", response: res });
      setApplied({ mode, state: "failed", failure: res });
      const conflicts = res.conflicts;
      if (conflicts?.length) setPrepared((cur) => (cur === p ? { ...p, marks: addConflictMarks(p.marks, p.rows, p.result, conflicts) } : cur));
    } catch (e) {
      setApplied({ mode, state: "failed", failure: { ok: false, v: 1, error: { code: "network", message: errorMessage(e) } } });
    }
  };

  const onRulesFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      setRules(parseRules(file.name, text));
      storeRules({ name: file.name, text });
    } catch (e) {
      setError(`業務ルールを読めません: ${errorMessage(e)}`);
    }
  };

  if (conn.state !== "ready") return <ConnectionScreen conn={conn} onToken={(t) => (saveToken(t), void connect(t))} onRetry={() => void connect(takeToken())} />;

  const base = prepared ? `${prepared.target}-${stamp(prepared.at)}` : "";

  return (
    <div className="hk-app">
      <header className="hk-bar">
        <h1>harikit</h1>
        <label className="hk-field">
          <span>対象</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">選んでください</option>
            {conn.targets.map((t) => (
              <option key={t.target} value={t.target}>
                {t.target}（{t.table}）
              </option>
            ))}
          </select>
        </label>
        <div className="hk-field">
          <span>業務ルール</span>
          {rules ? (
            <span className="hk-rules">
              {rules.name}
              <button
                type="button"
                className="hk-link"
                onClick={() => {
                  setRules(null);
                  storeRules(null);
                }}
              >
                外す
              </button>
            </span>
          ) : (
            <span className="hk-muted">なし</span>
          )}
          <label className="hk-button hk-button--small">
            ファイルを選ぶ
            <input type="file" accept=".json,application/json" hidden onChange={(e) => void onRulesFile(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
          </label>
        </div>
        <span className="hk-server">{location.host} につながっています</span>
      </header>

      {error && (
        <div className="hk-banner hk-banner--error" role="alert">
          {error}
          <button type="button" className="hk-link" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}

      <main className="hk-main">
        <section className="hk-sheet">
          <div className="hk-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "input"} onClick={() => setTab("input")}>
              貼り付け
            </button>
            <button type="button" role="tab" aria-selected={tab === "diff"} disabled={!diff} onClick={() => setTab("diff")}>
              差分{diff ? `（変わる ${diff.counts.change} 行）` : ""}
            </button>
            <span className="hk-tabs-hint">
              {tab === "input" ? "Excel で見出しの行ごとコピーして、A1 を選んで Ctrl+V。Ctrl+Z で戻せます" : "検証した時点の DB の値（前）と、貼り付けた値（後）"}
            </span>
            {tab === "input" && (
              <button type="button" className="hk-link" onClick={clearSheet}>
                表を空にする
              </button>
            )}
          </div>
          <div className="hk-grid" hidden={tab !== "input"}>
            <SpreadsheetGrid<GridRow>
              ref={gridRef}
              rows={rows}
              columns={columns}
              onRowsChange={onRowsChange}
              onColumnsChange={(next) => setColumnCount((n) => Math.max(n, next.length))}
              rowKeyGetter={(r) => r.id}
              createRow={() => ({ id: nextId() })}
              createOverflowColumn={sheetColumn}
              height="100%"
              density="compact"
              theme="auto"
              imeDirectInput
              enableSorting={false}
              enableColumnFilter={false}
              enableGlobalFilter={false}
              enableColumnMenu={false}
              showTopBar={false}
              showBottomBarCounts={false}
              ariaLabel="貼り付ける表"
            />
          </div>
          {diff && (
            <div className="hk-grid" hidden={tab !== "diff"}>
              <DiffGrid diff={diff} readings={prepared!.result.validation.readings} />
            </div>
          )}
        </section>

        <aside className="hk-side">
          <ColumnsCard desc={desc} target={target} onAdd={insertHeader} />

          <Card step="2" title="検証して差分を見る">
            <button type="button" className="hk-button hk-button--primary" disabled={!target || preparing} onClick={() => void runPrepare()}>
              {preparing ? "検証しています…" : "検証して差分を見る"}
            </button>
            {stale && <p className="hk-banner hk-banner--stale">検証した後に表か設定を変えました。もう一度押してください。</p>}
            {prepared && (
              <div className={stale ? "hk-dim" : undefined}>
                <PrepareSummary result={prepared.result} onJump={jump} />
                <div className="hk-actions">
                  {diff && (
                    <button type="button" className="hk-button hk-button--small" onClick={() => download(`${base}-diff.csv`, diffToCsv(diff), "text/csv;charset=utf-8")}>
                      差分 CSV
                    </button>
                  )}
                  {prepared.result.issues.length > 0 && (
                    <button type="button" className="hk-button hk-button--small" onClick={() => download(`${base}-issues.csv`, issuesToCsv(prepared.result.issues), "text/csv;charset=utf-8")}>
                      問題の一覧 CSV
                    </button>
                  )}
                  {prepared.result.validation.readings.length > 0 && (
                    <button type="button" className="hk-button hk-button--small" onClick={() => download(`${base}-readings.csv`, readingsToCsv(prepared.result.validation.readings), "text/csv;charset=utf-8")}>
                      読み替えの一覧 CSV
                    </button>
                  )}
                  {diff && prepared.result.ok && diff.counts.change > 0 && (
                    <button
                      type="button"
                      className="hk-button hk-button--small"
                      onClick={() => download(`${base}-plan.json`, JSON.stringify(buildPlan(diff, "grid", { requestId: prepared.requestId, ...(note.trim() && { note: note.trim() }) }), null, 2) + "\n", "application/json")}
                    >
                      反映計画 plan.json
                    </button>
                  )}
                </div>
              </div>
            )}
          </Card>

          {prepared?.result.ok && diff && diff.counts.change > 0 && (
            <ApplyCard
              rows={diff.counts.change}
              disabled={stale}
              note={note}
              onNote={setNote}
              applied={applied}
              confirming={confirming}
              onCheck={() => void runApply("check")}
              onAsk={() => setConfirming(true)}
              onCancel={() => setConfirming(false)}
              onExecute={() => void runApply("execute")}
              base={base}
            />
          )}
        </aside>
      </main>
    </div>
  );
}

function Card({ step, title, children }: { step: string; title: string; children: ReactNode }) {
  return (
    <section className="hk-card">
      <h2>
        <span className="hk-step">{step}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ColumnsCard({ desc, target, onAdd }: { desc: TableDescription | null; target: string; onAdd: (name: string) => void }) {
  if (!target) {
    return (
      <Card step="1" title="表に貼り付ける">
        <p className="hk-muted">上の「対象」で、更新するテーブルを選んでください。</p>
      </Card>
    );
  }
  if (!desc) {
    return (
      <Card step="1" title="表に貼り付ける">
        <p className="hk-muted">列を読んでいます…</p>
      </Card>
    );
  }
  const keys = new Set(desc.key.map((k) => k.toLowerCase()));
  const cols = desc.columns.filter((c) => keys.has(c.name.toLowerCase()) || c.updatable);
  return (
    <Card step="1" title="表に貼り付ける">
      <p className="hk-help">
        1 行目は列名です。キーの列と、変える列だけを貼ってください（列の順は自由）。貼っていない列は変わりません。日付や数は Excel の表示のまま（2024/4/1、¥1,200 など）で貼れます。
      </p>
      <ul className="hk-columns">
        {cols.map((c) => {
          const isKey = keys.has(c.name.toLowerCase());
          return (
            <li key={c.name}>
              <span className={isKey ? "hk-tag hk-tag--key" : "hk-tag"}>{isKey ? "キー" : "更新"}</span>
              <span className="hk-colname" title={c.name}>
                {c.name}
              </span>
              <span className="hk-muted">
                {c.dbType}
                {c.nullable ? "" : "・必須"}
              </span>
              <button type="button" className="hk-link" title={`1 行目に ${c.name} を入れる`} onClick={() => onAdd(c.name)}>
                ＋見出し
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

const STATUS_TEXT = { change: "変わる", same: "同じ", not_found: "キーなし" } as const;

function PrepareSummary({ result, onJump }: { result: PrepareResult; onJump: (at: { row?: number; col?: number }) => void }) {
  const errors = result.issues.filter((i) => i.severity === "error").length;
  const warnings = result.issues.length - errors;
  const d = result.diff;
  return (
    <div className="hk-summary">
      {d && (
        <div className="hk-counts">
          {(["change", "same", "not_found"] as const).map((s) => (
            <div key={s} className={`hk-count hk-count--${s}`}>
              <strong>{d.counts[s]}</strong>
              <span>{STATUS_TEXT[s]}</span>
            </div>
          ))}
        </div>
      )}
      {errors > 0 ? (
        <p className="hk-status hk-status--error">エラーが {errors} 件あるので、差分は作っていません。赤いセルを直して、もう一度押してください。</p>
      ) : d && d.counts.change === 0 ? (
        <p className="hk-status">変わる行はありません。</p>
      ) : (
        d && <p className="hk-status hk-status--ok">差分ができました。「差分」のタブが承認資料になります。</p>
      )}
      {result.issues.length > 0 && (
        <>
          <p className="hk-muted">
            エラー {errors} 件、警告 {warnings} 件
          </p>
          <ul className="hk-issues">
            {result.issues.slice(0, 200).map((i, n) => (
              <li key={n}>
                <button type="button" className={`hk-issue hk-issue--${i.severity}`} disabled={i.row === undefined} onClick={() => onJump(i)}>
                  <span className="hk-issue-place">{issuePlace(i)}</span>
                  <span>{i.message}</span>
                </button>
              </li>
            ))}
          </ul>
          {result.issues.length > 200 && <p className="hk-muted">…ほか {result.issues.length - 200} 件（CSV を見てください）</p>}
        </>
      )}
      <Readings readings={result.validation.readings} onJump={onJump} />
    </div>
  );
}

/** Excel の表示の形から読み替えたセルを、列ごとに 1 行で見せる。 */
function Readings({ readings, onJump }: { readings: readonly Reading[]; onJump: (at: { row?: number; col?: number }) => void }) {
  const groups = useMemo(() => groupReadings(readings), [readings]);
  if (groups.length === 0) return null;
  return (
    <div className="hk-readings">
      <p className="hk-muted">Excel の表示から読み替えたセル: {readings.length} 個</p>
      <ul className="hk-issues">
        {groups.map((g) => (
          <li key={g.column}>
            <button type="button" className="hk-issue hk-issue--read" title={readingNote(g.first)} onClick={() => onJump(g.first)}>
              <span className="hk-issue-place">{g.column}</span>
              <span>
                {g.count} 個。例: {g.first.text} → {String(g.first.value)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="hk-muted hk-small">
        表では<span className="hk-read-sample">点線の下線</span>のセルです。表示で丸めた数や秒は丸めたまま読むので、元の桁が要るときは Excel の表示形式を変えてからコピーしてください。
      </p>
    </div>
  );
}

function ApplyCard(props: {
  rows: number;
  disabled: boolean;
  note: string;
  onNote: (s: string) => void;
  applied: Applied | null;
  confirming: boolean;
  onCheck: () => void;
  onAsk: () => void;
  onCancel: () => void;
  onExecute: () => void;
  base: string;
}) {
  const { applied } = props;
  const ref = useRef<HTMLDivElement>(null);
  // 結果や確認は横の欄の下のほうに出るので、見える所まで送る。
  useEffect(() => {
    if (applied || props.confirming) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [applied, props.confirming]);
  const running = applied?.state === "running";
  const executed = applied?.mode === "execute" && applied.state === "ok";
  const checked = applied?.mode === "check" && applied.state === "ok";
  return (
    <Card step="3" title="確かめて反映する">
      <label className="hk-note">
        <span>メモ（反映ログに残ります。依頼番号など）</span>
        <input type="text" value={props.note} disabled={executed} onChange={(e) => props.onNote(e.target.value)} />
      </label>
      {!executed && (
        <div className="hk-actions">
          <button type="button" className="hk-button" disabled={props.disabled || running} onClick={props.onCheck}>
            DB で確かめる
          </button>
          <button type="button" className="hk-button hk-button--danger" disabled={props.disabled || running || !(checked || applied?.mode === "execute")} onClick={props.onAsk}>
            反映する
          </button>
        </div>
      )}
      {!executed && !checked && !running && applied === null && <p className="hk-muted">反映の前に「DB で確かめる」を押します（DB は変えません）。</p>}
      {props.confirming && (
        <div className="hk-confirm" role="alertdialog" aria-label="反映の確認">
          <p>
            <strong>{props.rows} 行</strong>を DB に反映します。よろしいですか？
          </p>
          <div className="hk-actions">
            <button type="button" className="hk-button hk-button--danger" onClick={props.onExecute}>
              反映する
            </button>
            <button type="button" className="hk-button" onClick={props.onCancel}>
              やめる
            </button>
          </div>
        </div>
      )}
      {running && <p className="hk-muted">{applied!.mode === "check" ? "確かめています…" : "反映しています…"}</p>}
      {applied && applied.state !== "running" && <ApplyResult applied={applied} rows={props.rows} base={props.base} />}
      <div ref={ref} />
    </Card>
  );
}

function ApplyResult({ applied, rows, base }: { applied: Exclude<Applied, { state: "running" }>; rows: number; base: string }) {
  if (applied.state === "failed") {
    const f = applied.failure;
    return (
      <div className="hk-status hk-status--error">
        <p>止めました: {f.error.message}</p>
        {f.conflicts && f.conflicts.length > 0 && (
          <>
            <ul className="hk-plain">
              {f.conflicts.slice(0, 20).map((c) => (
                <li key={c.index}>
                  {Object.values(c.key).join("・")}: {c.reason === "not_found" ? "行がなくなっています" : `${(c.columns ?? []).join("、")} が変わっています`}
                </li>
              ))}
            </ul>
            <p>差分を取った後に DB が変わっています。「検証して差分を見る」からやり直してください。何も反映していません。</p>
          </>
        )}
        {f.rowErrors && f.rowErrors.length > 0 && (
          <ul className="hk-plain">
            {f.rowErrors.slice(0, 20).map((e, n) => (
              <li key={n}>
                {e.index + 1} 番目: {e.column ? `${e.column} ` : ""}
                {e.message ?? e.code}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const r = applied.response;
  const updated = r.results.reduce((n, x) => n + x.updated, 0);
  const sqlName = applied.mode === "execute" ? `${base}-applied.sql` : `${base}-check.sql`;
  return (
    <div className="hk-status hk-status--ok">
      {applied.mode === "execute" ? (
        <p>
          反映しました: {updated} 行（{r.appliedBy}、{new Date(r.appliedAt).toLocaleString("ja-JP")}）
        </p>
      ) : (
        <p>{rows} 行とも差分どおりで、反映できます（DB は変えていません）。</p>
      )}
      <div className="hk-actions">
        <button type="button" className="hk-button hk-button--small" onClick={() => download(sqlName, r.script, "application/sql;charset=utf-8")}>
          {applied.mode === "execute" ? "実行した SQL" : "実行する SQL"}
        </button>
        <button type="button" className="hk-button hk-button--small" onClick={() => download(`${base}-undo.sql`, r.undoScript, "application/sql;charset=utf-8")}>
          戻し SQL
        </button>
        {applied.mode === "execute" && (
          <button type="button" className="hk-button hk-button--small" onClick={() => download(`${base}-result.json`, JSON.stringify(r, null, 2) + "\n", "application/json")}>
            結果 JSON
          </button>
        )}
      </div>
    </div>
  );
}

/** 変わるセルの空（NULL）は「（空）」と見せる。変わらないセルは空のまま。 */
function emptyIfChanged(column: string) {
  return ({ value, row }: { value: unknown; row: DiffGridRow }) =>
    value === null && row.changed.includes(column) ? "（空）" : value === null || value === undefined ? "" : String(value);
}

/** 読み替えたセルに、貼った文字列のメモを付ける。 */
function pastedNote(column: string) {
  return ({ row }: { row: DiffGridRow }) => (row.pasted[column] !== undefined ? `貼った値: ${row.pasted[column]}` : undefined);
}

function DiffGrid({ diff, readings }: { diff: DiffResult; readings: readonly Reading[] }) {
  const rows = useMemo(() => diffGridRows(diff, readings), [diff, readings]);
  const columns = useMemo<GridColumn<DiffGridRow>[]>(
    () => [
      { key: "row", title: "行", width: 64, align: "right", pinned: "left" },
      { key: "status", title: "状態", width: 104, pinned: "left", filterType: "set", conditionalFormat: { chips: { 変わる: "info", 同じ: "neutral", キーなし: "warning" } } },
      ...diff.keyColumns.map((k): GridColumn<DiffGridRow> => ({ key: `k:${k}`, title: k, width: 120, pinned: "left", cellNote: pastedNote(k) })),
      ...diff.updateColumns.flatMap((c): GridColumn<DiffGridRow>[] => [
        {
          key: `b:${c}`,
          title: `${c}（前）`,
          width: 150,
          valueFormatter: emptyIfChanged(c),
          cellClassName: ({ row }) => (row.changed.includes(c) ? "hk-before" : undefined),
        },
        {
          key: `a:${c}`,
          title: `${c}（後）`,
          width: 150,
          valueFormatter: emptyIfChanged(c),
          cellClassName: ({ row }) => (row.changed.includes(c) ? "hk-change" : undefined),
          cellNote: pastedNote(c),
        },
      ]),
    ],
    [diff],
  );
  return (
    <SpreadsheetGrid<DiffGridRow>
      rows={rows}
      columns={columns}
      rowKeyGetter={(r) => r.id}
      readOnly
      height="100%"
      density="compact"
      theme="auto"
      enableColumnMenu
      showTopBarSummary={false}
      showBottomBarCounts={false}
      globalFilterPlaceholder="差分を絞り込む"
      ariaLabel="差分"
    />
  );
}

function ConnectionScreen({ conn, onToken, onRetry }: { conn: Exclude<Connection, { state: "ready" }>; onToken: (t: string) => void; onRetry: () => void }) {
  const [token, setToken] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (token.trim()) onToken(token.trim());
  };
  return (
    <div className="hk-center">
      <div className="hk-card hk-connect">
        <h1>harikit</h1>
        {conn.state === "connecting" && <p className="hk-muted">サーバにつないでいます…</p>}
        {conn.state === "offline" && (
          <>
            <p className="hk-status hk-status--error">{conn.message}</p>
            <button type="button" className="hk-button" onClick={onRetry}>
              もう一度つなぐ
            </button>
          </>
        )}
        {conn.state === "need-token" && (
          <form onSubmit={submit}>
            <p>{conn.message ?? "harikit サーバを起動したときに出た URL から開くと、そのまま使えます。トークンだけを貼ることもできます。"}</p>
            <label className="hk-note">
              <span>トークン</span>
              <input type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
            </label>
            <button type="submit" className="hk-button hk-button--primary">
              つなぐ
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
