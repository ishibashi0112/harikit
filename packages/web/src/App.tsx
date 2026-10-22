"use client";

// patchiri の画面。表に貼り付けて、検証 → 差分 → DB で確かめる → 反映、を順に行う。
// 検証・差分・反映の中身はコア（patchiri-core）で、CLI と同じ。
// Node 版サーバが配る同梱アプリ（main.tsx）でも、ほかの React アプリに埋め込むとき（index.ts）でも、この PatchiriApp を使う。

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { SpreadsheetGrid, type GridColumn, type SpreadsheetGridHandle } from "@ishibashi0112/spreadsheet-grid";
import {
  buildPlan,
  columnLetter,
  diffToCsv,
  groupReadings,
  headerColumn,
  PatchiriHttpError,
  issuesToCsv,
  readingsToCsv,
  readXlsx,
  type ApplyMode,
  type ApplyRequest,
  type ApplyResponse,
  type ColumnDef,
  type Issue,
  type PatchiriApi,
  type PrepareResult,
  type Reading,
  type Sheet,
  type TableDescription,
  type ValidateOptions,
} from "patchiri-core";
import { download, loadRules, makeClient, parseRules, saveToken, storeRules, takeToken, type RulesFile } from "./browser.js";
import { DiffGrid } from "./DiffGrid.js";
import {
  addConflictMarks,
  addHeader,
  blankRows,
  buildMarks,
  cellString,
  cellText,
  columnTitle,
  excelCells,
  guessHeaderRow,
  headerInfo,
  issuePlace,
  liveMark,
  readingNote,
  rowsFromCells,
  stamp,
  toSheet,
  type GridRow,
  type Marks,
} from "./sheet.js";
import { errorText, usePatchiri, type BeforeApplyVerdict, type PatchiriApplied, type PatchiriPrepared } from "./usePatchiri.js";

const INITIAL_ROWS = 100;
const INITIAL_COLUMNS = 10;
const EMPTY_MARKS: Marks = new Map();

let lastId = 0;
const nextId = () => ++lastId;

/** つながる前の画面に出すもの。 */
type ConnectionView = { state: "connecting" } | { state: "need-token"; message?: string } | { state: "offline"; message: string };

/** 検証したときの表。印を付けるのと、検証した後に表や業務ルールを変えたかを見るのに使う。 */
interface Snapshot {
  prepared: PatchiriPrepared;
  rows: GridRow[];
  version: number;
  rules: RulesFile | null;
}

const tokenClient = (token: string | null) => (token ? makeClient(token) : null);

/** 最初の業務ルール。渡されたものがあればそれを、無ければこのブラウザが覚えたものを使う。 */
function startRules(given: { name: string; text: string } | undefined, key: string | null): { rules: RulesFile | null; error: string | null } {
  if (!given) return { rules: loadRules(key), error: null };
  try {
    return { rules: parseRules(given.name, given.text), error: null };
  } catch (e) {
    return { rules: null, error: `業務ルールを読めません: ${errorText(e)}` };
  }
}

function remembered(key: string | null): string {
  if (key === null) return "";
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function remember(key: string | null, value: string): void {
  if (key === null) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // 覚えられなくても困らない。
  }
}

/** 画面の文言のうち、差し替えられるもの（PatchiriAppProps の messages）。 */
export interface PatchiriMessages {
  /** 「表に貼り付ける」の欄の説明。 */
  pasteHelp: string;
  /** 表の上の一言。 */
  pasteHint: string;
  /** メモの欄の名前。 */
  noteLabel: string;
  /** 反映する前の確かめ。{rows} は行数に置き換える。 */
  confirmApply: string;
}

export const DEFAULT_MESSAGES: PatchiriMessages = {
  pasteHelp:
    "1 行目は列名です。キーの列と、変える列だけを貼ってください（列の順は自由）。貼っていない列は変わりません。日付や数は Excel の表示のまま（2024/4/1、¥1,200 など）で貼れます。",
  pasteHint: "Excel で見出しの行ごとコピーして、A1 を選んで Ctrl+V。Ctrl+Z で戻せます",
  noteLabel: "メモ（反映ログに残ります。依頼番号など）",
  confirmApply: "{rows} 行を DB に反映します。よろしいですか？",
};

export interface PatchiriAppProps {
  /**
   * つなぐ先。渡すとトークンの画面を出さず、このクライアントでつなぐ（ほかのアプリに埋め込むとき）。
   * PatchiriClient のほか、PatchiriApi の形なら HTTP でないつなぎでもよい。
   * 渡さなければ、画面を配ったサーバ（同じオリジン）に URL の #token= のトークンでつなぐ。
   * 描くたびに作り直すとつなぎ直すので、コンポーネントの外か useMemo で作っておく。
   */
  client?: PatchiriApi;
  /** 見出しの右に「… につながっています」と出す名前。既定は client を渡したときは出さず、渡さないときは location.host。 */
  serverLabel?: string;
  /** 見出しの右端に置くもの（埋め込む側のボタンなど）。 */
  headerExtra?: ReactNode;
  /** 最初に読み込んでおく業務ルール（patchiri.rules.json の名前と中身）。このブラウザが覚えたものより優先する。最初に描いたときだけ読む。 */
  initialRules?: { name: string; text: string };
  /** 見出しの左の名前。既定は「patchiri」。 */
  title?: ReactNode;
  /** 対象を決めておく（許可リストのターゲット名）。渡すと「対象」を選ぶ欄を出さない。 */
  target?: string;
  /** 「対象」で選べるターゲットを絞る（許可リストのターゲット名）。 */
  targets?: readonly string[];
  /** 色。既定は "auto"（OS の設定に合わせる）。 */
  theme?: "auto" | "light" | "dark";
  /**
   * このブラウザに覚えるもの（選んだ対象、業務ルールのファイル）のキーの頭。既定は "patchiri"。
   * null なら何も覚えない。1 つのオリジンに画面を 2 つ置くときは分ける。
   */
  storageKey?: string | null;
  /** 手元の業務ルールのファイルを選べるか。既定は true。false なら、サーバに置いたルールと initialRules だけを使う。 */
  rulesFile?: boolean;
  /** 「Excel を開く」を出す（.xlsx を読んで表に入れる。ファイルはブラウザの中で読み、どこにも送らない）。既定は出さない。 */
  excel?: boolean;
  /** 見出しの別名（見出しの文字 → 列名）。サーバの表示名（labels）に加えて使う。 */
  aliases?: Record<string, string>;
  /** Excel の表示の形（2024/4/1、¥1,200 など）を読み替えるか。既定は true。 */
  readDisplay?: boolean;
  /** 行ごとの自前の確かめ（業務ルールの形で書けない決まり）。返した問題はセルに印を付ける。 */
  checkRow?: ValidateOptions["checkRow"];
  /** 問題の文を言い換える（Issue の code と params を見る）。undefined を返せば元の文。 */
  formatIssue?: (issue: Issue) => string | undefined;
  /** メモを書かないと「DB で確かめる」「反映する」を押せないようにする。文字列なら欄の名前（「依頼番号」など）。 */
  noteRequired?: boolean | string;
  /** 文言の差し替え。 */
  messages?: Partial<PatchiriMessages>;
  /** 検証したとき（差分ができたかは result.ok と result.diff）。 */
  onPrepared?: (result: PrepareResult, target: string) => void;
  /**
   * 「DB で確かめる」「反映する」でサーバに送る直前。false か文字列（止めた理由。画面に出す）を返すと送らない。
   * 外の承認の確かめなどに使う。例外を投げても送らない。
   */
  onBeforeApply?: (request: Omit<ApplyRequest, "v">, mode: ApplyMode) => BeforeApplyVerdict | Promise<BeforeApplyVerdict>;
  /** サーバが確かめた、または反映したとき。 */
  onApplied?: (response: ApplyResponse, mode: ApplyMode) => void;
  ref?: Ref<PatchiriAppHandle>;
}

export interface PatchiriAppHandle {
  /**
   * 表を入れ替える。1 行目が見出し（列名）で、空文字は空のセル。行や列が足りなければ増やす。
   * 検証した後なら、その結果は古い扱いになる（もう一度「検証して差分を見る」を押す）。
   */
  loadCells(cells: readonly (readonly string[])[]): void;
}

export function PatchiriApp(props: PatchiriAppProps) {
  const { client: given, serverLabel, headerExtra, initialRules, ref, theme = "auto", storageKey = "patchiri", rulesFile = true } = props;
  const targetKey = storageKey === null ? null : `${storageKey}.target`;
  const rulesKey = storageKey === null || !rulesFile ? null : `${storageKey}.rules`;
  const text = { ...DEFAULT_MESSAGES, ...props.messages };
  const noteLabel = typeof props.noteRequired === "string" ? props.noteRequired : text.noteLabel;
  const [start] = useState(() => startRules(initialRules, rulesKey));
  // 埋め込む側がクライアントを渡したときは、アドレス欄のトークンには触らない。
  const [tokenApi, setTokenApi] = useState(() => (given ? null : tokenClient(takeToken())));
  const [rules, setRules] = useState<RulesFile | null>(start.rules);
  const [initialTarget] = useState(() => remembered(targetKey));
  const ctl = usePatchiri({
    client: given ?? tokenApi,
    ...(props.target !== undefined && { target: props.target }),
    ...(props.targets && { targets: props.targets }),
    initialTarget,
    rules: rules?.config ?? null,
    ...(props.aliases && { aliases: props.aliases }),
    ...(props.readDisplay !== undefined && { readDisplay: props.readDisplay }),
    ...(props.checkRow && { checkRow: props.checkRow }),
    ...(props.formatIssue && { formatIssue: props.formatIssue }),
    ...(props.onPrepared && { onPrepared: props.onPrepared }),
    ...(props.onBeforeApply && { onBeforeApply: props.onBeforeApply }),
    ...(props.onApplied && { onApplied: props.onApplied }),
  });
  const { target, description: desc, applied, preparing } = ctl;
  const [rows, setRows] = useState<GridRow[]>(() => blankRows(INITIAL_ROWS, nextId));
  const [columnCount, setColumnCount] = useState(INITIAL_COLUMNS);
  const [version, setVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [tab, setTab] = useState<"input" | "diff">("input");
  const [localError, setError] = useState<string | null>(start.error);
  /** 開いた Excel（シートと見出しの行を選んでから表に入れる）。 */
  const [book, setBook] = useState<{ name: string; sheets: Sheet[] } | null>(null);
  const gridRef = useRef<SpreadsheetGridHandle<GridRow>>(null);
  const error = localError ?? ctl.error;

  useEffect(() => {
    if (props.target === undefined && target) remember(targetKey, target);
  }, [props.target, target, targetKey]);

  // トークンが違えば忘れて、入れ直してもらう。
  const tokenRejected = !given && ctl.connection.state === "failed" && ctl.connection.error instanceof PatchiriHttpError && ctl.connection.error.status === 401;
  useEffect(() => {
    if (tokenRejected) saveToken(null);
  }, [tokenRejected]);

  // 今の検証の結果（対象を変えるとフックが捨てる）。
  const shown = snapshot && snapshot.prepared === ctl.prepared ? snapshot : null;
  const prepared = shown?.prepared ?? null;
  const stale = shown !== null && (shown.version !== version || shown.rules !== rules);
  const diff = prepared?.result.diff ?? null;
  const marks = useMemo(() => {
    if (!shown) return EMPTY_MARKS;
    const base = buildMarks(shown.rows, shown.prepared.result);
    const conflicts = applied?.state === "failed" && applied.requestId === shown.prepared.requestId ? applied.failure.conflicts : undefined;
    return conflicts?.length ? addConflictMarks(base, shown.rows, shown.prepared.result, conflicts) : base;
  }, [shown, applied]);

  // 差分が無くなったら（対象を変えたなど）、貼った表に戻す。
  useEffect(() => {
    if (!diff) setTab("input");
  }, [diff]);

  const onRowsChange = useCallback((next: GridRow[]) => {
    setRows(next);
    setVersion((v) => v + 1);
  }, []);

  const aliases = props.aliases;
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
            const info = desc && headerInfo(desc, cellText(row, letter), aliases);
            return info ? `pt-head pt-head--${info.kind}` : "pt-head";
          }
          const m = liveMark(marks, row, letter);
          if (!m) return undefined;
          return [m.kind && `pt-${m.kind}`, m.warn && "pt-warn", m.read && "pt-read"].filter(Boolean).join(" ") || undefined;
        },
        cellNote: ({ row, sourceRowIndex }) => {
          if (sourceRowIndex === 0) return desc ? headerInfo(desc, cellText(row, letter), aliases)?.note : undefined;
          return liveMark(marks, row, letter)?.notes.join("\n");
        },
      };
    },
    [marks, desc, aliases],
  );

  const columns = useMemo(() => Array.from({ length: columnCount }, (_, c) => sheetColumn(c)), [columnCount, sheetColumn]);

  const loadCells = useCallback((cells: readonly (readonly string[])[]) => {
    const { rows: next, columnCount: n } = rowsFromCells(cells, INITIAL_ROWS, nextId);
    setRows(next);
    setColumnCount(Math.max(INITIAL_COLUMNS, n));
    setVersion((v) => v + 1);
    setTab("input");
  }, []);

  useImperativeHandle(ref, () => ({ loadCells }), [loadCells]);

  const clearSheet = () => {
    setRows(blankRows(INITIAL_ROWS, nextId));
    setColumnCount(INITIAL_COLUMNS);
    setVersion((v) => v + 1);
    setTab("input");
  };

  const insertHeader = (column: ColumnDef) => {
    const { rows: next, col } = addHeader(rows, columnCount, column);
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
    if (!target) return;
    const snap = rows;
    const v = version;
    const r = rules;
    setConfirming(false);
    setError(null);
    const p = await ctl.prepare(toSheet(snap, columnCount));
    if (!p) {
      // 差分のタブを見ていても、差分は消えるので貼った表に戻す（ログインが切れたときなど）。
      setSnapshot(null);
      setTab("input");
      return;
    }
    setSnapshot({ prepared: p, rows: snap, version: v, rules: r });
    if (p.result.ok && p.result.diff) setTab("diff");
  };

  const runApply = (mode: ApplyMode) => {
    setConfirming(false);
    void ctl.apply(mode, note);
  };

  const openExcel = async (file: File) => {
    try {
      const sheets = await readXlsx(await file.arrayBuffer());
      if (sheets.length === 0) throw new Error("シートがありません");
      setBook({ name: file.name, sheets });
    } catch (e) {
      setError(`${file.name} を読めません: ${errorText(e)}`);
    }
  };

  const onRulesFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      setRules(parseRules(file.name, text));
      storeRules(rulesKey, { name: file.name, text });
    } catch (e) {
      setError(`業務ルールを読めません: ${errorText(e)}`);
    }
  };

  const themeAttr = theme === "auto" ? undefined : theme;
  const title = props.title ?? "patchiri";
  const connection = ctl.connection;
  if (connection.state !== "ready") {
    const view: ConnectionView =
      connection.state === "idle" || tokenRejected
        ? { state: "need-token", ...(tokenRejected && { message: "トークンが違います。サーバを起動したときに出た URL から開き直すか、トークンを貼ってください" }) }
        : connection.state === "failed"
          ? { state: "offline", message: connection.message }
          : { state: "connecting" };
    return (
      <ConnectionScreen
        conn={view}
        title={title}
        theme={themeAttr}
        onToken={(t) => {
          saveToken(t);
          setTokenApi(makeClient(t));
        }}
        onRetry={ctl.reconnect}
      />
    );
  }

  const base = prepared ? `${prepared.target}-${stamp(prepared.at)}` : "";
  const server = serverLabel ?? (given ? undefined : location.host);
  const fixed = props.target !== undefined ? connection.targets.find((t) => t.target === props.target) : undefined;
  const serverRules = desc?.rules?.length ?? 0;

  return (
    <div className="pt-app" data-theme={themeAttr}>
      <header className="pt-bar">
        <h1>{title}</h1>
        {fixed ? (
          <div className="pt-field">
            <span>対象</span>
            <strong>
              {fixed.target}（{fixed.table}）
            </strong>
          </div>
        ) : (
          <label className="pt-field">
            <span>対象</span>
            <select value={target} onChange={(e) => ctl.setTarget(e.target.value)}>
              <option value="">選んでください</option>
              {connection.targets.map((t) => (
                <option key={t.target} value={t.target}>
                  {t.target}（{t.table}）
                </option>
              ))}
            </select>
          </label>
        )}
        {(rulesFile || rules || serverRules > 0) && (
          <div className="pt-field">
            <span>業務ルール</span>
            {serverRules > 0 && (
              <span className="pt-rules pt-rules--server" title={`サーバに置いた業務ルールです。外せません。\n${serverRuleList(desc!)}`}>
                <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                  <path fill="currentColor" d="M4 7V5a4 4 0 1 1 8 0v2h1a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h1Zm2 0h4V5a2 2 0 1 0-4 0v2Z" />
                </svg>
                サーバ {serverRules} 件
              </span>
            )}
            {rules ? (
              <span className="pt-rules">
                {rules.name}
                {rulesFile && (
                  <button
                    type="button"
                    className="pt-link"
                    onClick={() => {
                      setRules(null);
                      storeRules(rulesKey, null);
                    }}
                  >
                    外す
                  </button>
                )}
              </span>
            ) : (
              serverRules === 0 && <span className="pt-muted">なし</span>
            )}
            {rulesFile && (
              <label className="pt-button pt-button--small">
                ファイルを選ぶ
                <input type="file" accept=".json,application/json" hidden onChange={(e) => void onRulesFile(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
              </label>
            )}
          </div>
        )}
        {(server || headerExtra) && (
          <div className="pt-bar-end">
            {server && <span className="pt-server">{server} につながっています</span>}
            {headerExtra}
          </div>
        )}
      </header>

      {error && (
        <div className="pt-banner pt-banner--error" role="alert">
          {error}
          <button
            type="button"
            className="pt-link"
            onClick={() => {
              setError(null);
              ctl.clearError();
            }}
          >
            閉じる
          </button>
        </div>
      )}

      <main className="pt-main">
        <section className="pt-sheet">
          <div className="pt-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "input"} onClick={() => setTab("input")}>
              貼り付け
            </button>
            <button type="button" role="tab" aria-selected={tab === "diff"} disabled={!diff} onClick={() => setTab("diff")}>
              差分{diff ? `（変わる ${diff.counts.change} 行）` : ""}
            </button>
            <span className="pt-tabs-hint">{tab === "input" ? text.pasteHint : "検証した時点の DB の値（前）と、貼り付けた値（後）"}</span>
            {tab === "input" && props.excel && (
              <label className="pt-button pt-button--small">
                Excel を開く
                <input
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void openExcel(file);
                  }}
                />
              </label>
            )}
            {tab === "input" && (
              <button type="button" className="pt-link" onClick={clearSheet}>
                表を空にする
              </button>
            )}
          </div>
          {book && (
            <ExcelPanel
              book={book}
              desc={desc}
              aliases={aliases}
              onLoad={(cells) => {
                setBook(null);
                loadCells(cells);
              }}
              onCancel={() => setBook(null)}
            />
          )}
          <div className="pt-grid" hidden={tab !== "input"}>
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
              theme={theme}
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
            <div className="pt-grid" hidden={tab !== "diff"}>
              <DiffGrid diff={diff} desc={prepared!.result.description} readings={prepared!.result.validation.readings} theme={theme} />
            </div>
          )}
        </section>

        <aside className="pt-side">
          <ColumnsCard desc={desc} target={target} help={text.pasteHelp} onAdd={insertHeader} />

          <Card step="2" title="検証して差分を見る">
            <button type="button" className="pt-button pt-button--primary" disabled={!target || preparing} onClick={() => void runPrepare()}>
              {preparing ? "検証しています…" : "検証して差分を見る"}
            </button>
            {stale && <p className="pt-banner pt-banner--stale">検証した後に表か設定を変えました。もう一度押してください。</p>}
            {prepared && (
              <div className={stale ? "pt-dim" : undefined}>
                <PrepareSummary result={prepared.result} onJump={jump} />
                <div className="pt-actions">
                  {diff && (
                    <button type="button" className="pt-button pt-button--small" onClick={() => download(`${base}-diff.csv`, diffToCsv(diff), "text/csv;charset=utf-8")}>
                      差分 CSV
                    </button>
                  )}
                  {prepared.result.issues.length > 0 && (
                    <button type="button" className="pt-button pt-button--small" onClick={() => download(`${base}-issues.csv`, issuesToCsv(prepared.result.issues), "text/csv;charset=utf-8")}>
                      問題の一覧 CSV
                    </button>
                  )}
                  {prepared.result.validation.readings.length > 0 && (
                    <button type="button" className="pt-button pt-button--small" onClick={() => download(`${base}-readings.csv`, readingsToCsv(prepared.result.validation.readings), "text/csv;charset=utf-8")}>
                      読み替えの一覧 CSV
                    </button>
                  )}
                  {diff && prepared.result.ok && diff.counts.change > 0 && (
                    <button
                      type="button"
                      className="pt-button pt-button--small"
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
              noteLabel={noteLabel}
              noteRequired={!!props.noteRequired}
              confirmText={text.confirmApply}
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
    <section className="pt-card">
      <h2>
        <span className="pt-step">{step}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** サーバに置いた業務ルールを、1 件 1 行の文にする（見出しの印の説明）。 */
function serverRuleList(desc: TableDescription): string {
  const title = (name: string) => {
    const col = desc.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
    return col ? columnTitle(col) : name;
  };
  return (desc.rules ?? [])
    .map((r) => {
      const rule = r as { column?: unknown; message?: unknown };
      const column = typeof rule.column === "string" ? title(rule.column) : "?";
      return typeof rule.message === "string" ? `・${column}: ${rule.message}` : `・${column}`;
    })
    .join("\n");
}

const STAMP_TEXT = { now: "反映した日時", user: "反映した人の名前" } as const;

function ColumnsCard({ desc, target, help, onAdd }: { desc: TableDescription | null; target: string; help: string; onAdd: (col: ColumnDef) => void }) {
  if (!target) {
    return (
      <Card step="1" title="表に貼り付ける">
        <p className="pt-muted">上の「対象」で、更新するテーブルを選んでください。</p>
      </Card>
    );
  }
  if (!desc) {
    return (
      <Card step="1" title="表に貼り付ける">
        <p className="pt-muted">列を読んでいます…</p>
      </Card>
    );
  }
  const keys = new Set(desc.key.map((k) => k.toLowerCase()));
  const cols = desc.columns.filter((c) => keys.has(c.name.toLowerCase()) || c.updatable);
  const titleOf = (name: string) => {
    const col = desc.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
    return col?.label ? `${col.label}（${col.name}）` : name;
  };
  const scope = Object.entries(desc.scope ?? {});
  return (
    <Card step="1" title="表に貼り付ける">
      <p className="pt-help">{help}</p>
      <ul className="pt-columns">
        {cols.map((c) => {
          const isKey = keys.has(c.name.toLowerCase());
          const head = columnTitle(c);
          return (
            <li key={c.name}>
              <span className={isKey ? "pt-tag pt-tag--key" : "pt-tag"}>{isKey ? "キー" : "更新"}</span>
              <span className="pt-colname" title={c.label ? `見出しは「${c.label}」でも「${c.name}」でも` : c.name}>
                {head}
                {c.label && <span className="pt-colname-db">{c.name}</span>}
              </span>
              <span className="pt-muted">
                {c.dbType}
                {c.nullable ? "" : "・必須"}
              </span>
              <button type="button" className="pt-link" title={`1 行目に ${head} を入れる`} onClick={() => onAdd(c)}>
                ＋見出し
              </button>
            </li>
          );
        })}
      </ul>
      {(desc.stamp?.length || scope.length > 0) && (
        <dl className="pt-auto">
          {desc.stamp?.map((st) => (
            <div key={st.column}>
              <dt>
                <span className="pt-tag pt-tag--auto">自動</span>
                {titleOf(st.column)}
              </dt>
              <dd>{STAMP_TEXT[st.value]}が入ります</dd>
            </div>
          ))}
          {scope.length > 0 && (
            <div>
              <dt>
                <span className="pt-tag pt-tag--scope">範囲</span>
                {scope.map(([c, v]) => `${titleOf(c)} が ${String(v)}`).join("、")}
              </dt>
              <dd>の行だけを変えられます（ほかの行は「キーなし」になります）</dd>
            </div>
          )}
        </dl>
      )}
    </Card>
  );
}

/** 開いた Excel のシートと見出しの行を選んで、表に入れる。 */
function ExcelPanel(props: {
  book: { name: string; sheets: Sheet[] };
  desc: TableDescription | null;
  aliases: Record<string, string> | undefined;
  onLoad: (cells: string[][]) => void;
  onCancel: () => void;
}) {
  const { book, desc, aliases } = props;
  const [sheetIndex, setSheetIndex] = useState(0);
  const sheet = book.sheets[sheetIndex]!;
  const guess = useMemo(() => guessHeaderRow(sheet, desc, aliases), [sheet, desc, aliases]);
  const [chosen, setChosen] = useState<number | null>(null);
  const headerRow = chosen ?? guess;
  const [skipUnknown, setSkipUnknown] = useState(true);
  // 見出しのある列（0 始まりの列番号と見出し）と、ターゲットの列に当たらないもの（備考など）。
  const cells = (sheet.rows[headerRow] ?? []).map((c, i) => ({ i, text: cellString(c).trim() })).filter((h) => h.text !== "");
  const head = cells.map((h) => h.text);
  const unknown = desc ? cells.filter((h) => !headerColumn(desc, h.text, aliases)) : [];
  const known = cells.length - unknown.length;
  const rows = Math.max(0, sheet.rows.length - headerRow - 1);
  const load = () => {
    const keep = skipUnknown && unknown.length > 0 ? cells.filter((h) => !unknown.includes(h)).map((h) => h.i) : undefined;
    props.onLoad(excelCells(sheet, headerRow, keep));
  };
  return (
    <div className="pt-excel" role="group" aria-label="Excel を表に入れる">
      <strong className="pt-excel-name">{book.name}</strong>
      {book.sheets.length > 1 && (
        <label className="pt-field">
          <span>シート</span>
          <select
            value={sheetIndex}
            onChange={(e) => {
              setSheetIndex(Number(e.target.value));
              setChosen(null);
            }}
          >
            {book.sheets.map((s, i) => (
              <option key={i} value={i}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="pt-field">
        <span>見出しの行</span>
        <input
          type="number"
          className="pt-excel-row"
          min={1}
          max={Math.max(1, sheet.rows.length)}
          value={headerRow + 1}
          onChange={(e) => setChosen(Math.max(0, Math.min(sheet.rows.length - 1, (Number(e.target.value) || 1) - 1)))}
        />
      </label>
      <span className="pt-excel-head" title={head.join("・")}>
        {head.length > 0 ? head.slice(0, 6).join("・") + (head.length > 6 ? "…" : "") : "（空の行）"}
        <span className="pt-muted">
          {desc ? `　列に当たる見出し ${known} 個・` : "　"}
          {rows} 行
        </span>
        {unknown.length > 0 && (
          <label className="pt-excel-skip">
            <input type="checkbox" checked={skipUnknown} onChange={(e) => setSkipUnknown(e.target.checked)} />
            列に当たらない「{unknown.map((h) => h.text).join("」「")}」の列は入れない
          </label>
        )}
      </span>
      <div className="pt-actions">
        <button type="button" className="pt-button pt-button--primary pt-button--small" disabled={head.length === 0} onClick={load}>
          表に入れる
        </button>
        <button type="button" className="pt-button pt-button--small" onClick={props.onCancel}>
          やめる
        </button>
      </div>
    </div>
  );
}

const STATUS_TEXT = { change: "変わる", same: "同じ", not_found: "キーなし" } as const;

function PrepareSummary({ result, onJump }: { result: PrepareResult; onJump: (at: { row?: number; col?: number }) => void }) {
  const errors = result.issues.filter((i) => i.severity === "error").length;
  const warnings = result.issues.length - errors;
  const d = result.diff;
  return (
    <div className="pt-summary">
      {d && (
        <div className="pt-counts">
          {(["change", "same", "not_found"] as const).map((s) => (
            <div key={s} className={`pt-count pt-count--${s}`}>
              <strong>{d.counts[s]}</strong>
              <span>{STATUS_TEXT[s]}</span>
            </div>
          ))}
        </div>
      )}
      {errors > 0 ? (
        <p className="pt-status pt-status--error">エラーが {errors} 件あるので、差分は作っていません。赤いセルを直して、もう一度押してください。</p>
      ) : d && d.counts.change === 0 ? (
        <p className="pt-status">変わる行はありません。</p>
      ) : (
        d && <p className="pt-status pt-status--ok">差分ができました。「差分」のタブが承認資料になります。</p>
      )}
      {result.issues.length > 0 && (
        <>
          <p className="pt-muted">
            エラー {errors} 件、警告 {warnings} 件
          </p>
          <ul className="pt-issues">
            {result.issues.slice(0, 200).map((i, n) => (
              <li key={n}>
                <button type="button" className={`pt-issue pt-issue--${i.severity}`} disabled={i.row === undefined} onClick={() => onJump(i)}>
                  <span className="pt-issue-place">{issuePlace(i)}</span>
                  <span>{i.message}</span>
                </button>
              </li>
            ))}
          </ul>
          {result.issues.length > 200 && <p className="pt-muted">…ほか {result.issues.length - 200} 件（CSV を見てください）</p>}
        </>
      )}
      <Readings readings={result.validation.readings} desc={result.description} onJump={onJump} />
    </div>
  );
}

/** Excel の表示の形から読み替えたセルを、列ごとに 1 行で見せる。 */
function Readings({ readings, desc, onJump }: { readings: readonly Reading[]; desc: TableDescription; onJump: (at: { row?: number; col?: number }) => void }) {
  const groups = useMemo(() => groupReadings(readings), [readings]);
  if (groups.length === 0) return null;
  return (
    <div className="pt-readings">
      <p className="pt-muted">Excel の表示から読み替えたセル: {readings.length} 個</p>
      <ul className="pt-issues">
        {groups.map((g) => (
          <li key={g.column}>
            <button type="button" className="pt-issue pt-issue--read" title={readingNote(g.first)} onClick={() => onJump(g.first)}>
              <span className="pt-issue-place">{columnTitle(desc.columns.find((c) => c.name === g.column) ?? { name: g.column })}</span>
              <span>
                {g.count} 個。例: {g.first.text} → {String(g.first.value)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="pt-muted pt-small">
        表では<span className="pt-read-sample">点線の下線</span>のセルです。表示で丸めた数や秒は丸めたまま読むので、元の桁が要るときは Excel の表示形式を変えてからコピーしてください。
      </p>
    </div>
  );
}

function ApplyCard(props: {
  rows: number;
  disabled: boolean;
  note: string;
  onNote: (s: string) => void;
  noteLabel: string;
  noteRequired: boolean;
  confirmText: string;
  applied: PatchiriApplied | null;
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
  const needNote = props.noteRequired && props.note.trim() === "";
  const [confirmHead, confirmTail] = splitRows(props.confirmText);
  return (
    <Card step="3" title="確かめて反映する">
      <label className={needNote ? "pt-note pt-note--required" : "pt-note"}>
        <span>
          {props.noteLabel}
          {props.noteRequired && <span className="pt-required">必須</span>}
        </span>
        <input type="text" value={props.note} disabled={executed} required={props.noteRequired} aria-invalid={needNote || undefined} onChange={(e) => props.onNote(e.target.value)} />
      </label>
      {!executed && (
        <div className="pt-actions">
          <button type="button" className="pt-button" disabled={props.disabled || running || needNote} onClick={props.onCheck}>
            DB で確かめる
          </button>
          <button
            type="button"
            className="pt-button pt-button--danger"
            disabled={props.disabled || running || needNote || !(checked || applied?.mode === "execute")}
            onClick={props.onAsk}
          >
            反映する
          </button>
        </div>
      )}
      {!executed && needNote && !running && <p className="pt-muted">「{props.noteLabel}」を書くと押せます。</p>}
      {!executed && !needNote && !checked && !running && applied === null && <p className="pt-muted">反映の前に「DB で確かめる」を押します（DB は変えません）。</p>}
      {props.confirming && (
        <div className="pt-confirm" role="alertdialog" aria-label="反映の確認">
          <p>
            {confirmHead}
            {confirmTail !== undefined && <strong>{props.rows} 行</strong>}
            {confirmTail}
          </p>
          <div className="pt-actions">
            <button type="button" className="pt-button pt-button--danger" onClick={props.onExecute}>
              反映する
            </button>
            <button type="button" className="pt-button" onClick={props.onCancel}>
              やめる
            </button>
          </div>
        </div>
      )}
      {running && <p className="pt-muted">{applied!.mode === "check" ? "確かめています…" : "反映しています…"}</p>}
      {applied && applied.state !== "running" && <ApplyResult applied={applied} rows={props.rows} base={props.base} />}
      <div ref={ref} />
    </Card>
  );
}

/** 確かめの文を {rows} の前と後に分ける（{rows} は太字の「n 行」にする）。{rows} が無ければ後は undefined。 */
function splitRows(text: string): [string, string | undefined] {
  const i = text.indexOf("{rows} 行");
  if (i >= 0) return [text.slice(0, i), text.slice(i + "{rows} 行".length)];
  const j = text.indexOf("{rows}");
  return j >= 0 ? [text.slice(0, j), text.slice(j + "{rows}".length)] : [text, undefined];
}

function ApplyResult({ applied, rows, base }: { applied: Exclude<PatchiriApplied, { state: "running" }>; rows: number; base: string }) {
  if (applied.state === "failed") {
    const f = applied.failure;
    return (
      <div className="pt-status pt-status--error">
        <p>止めました: {f.error.message}</p>
        {f.conflicts && f.conflicts.length > 0 && (
          <>
            <ul className="pt-plain">
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
          <ul className="pt-plain">
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
    <div className="pt-status pt-status--ok">
      {applied.mode === "execute" ? (
        <p>
          反映しました: {updated} 行（{r.appliedBy}、{new Date(r.appliedAt).toLocaleString("ja-JP")}）
        </p>
      ) : (
        <p>{rows} 行とも差分どおりで、反映できます（DB は変えていません）。</p>
      )}
      <div className="pt-actions">
        <button type="button" className="pt-button pt-button--small" onClick={() => download(sqlName, r.script, "application/sql;charset=utf-8")}>
          {applied.mode === "execute" ? "実行した SQL" : "実行する SQL"}
        </button>
        <button type="button" className="pt-button pt-button--small" onClick={() => download(`${base}-undo.sql`, r.undoScript, "application/sql;charset=utf-8")}>
          戻し SQL
        </button>
        {applied.mode === "execute" && (
          <button type="button" className="pt-button pt-button--small" onClick={() => download(`${base}-result.json`, JSON.stringify(r, null, 2) + "\n", "application/json")}>
            結果 JSON
          </button>
        )}
      </div>
    </div>
  );
}

function ConnectionScreen(props: {
  conn: ConnectionView;
  title: ReactNode;
  theme: "light" | "dark" | undefined;
  onToken: (t: string) => void;
  onRetry: () => void;
}) {
  const { conn, onToken, onRetry } = props;
  const [token, setToken] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (token.trim()) onToken(token.trim());
  };
  return (
    <div className="pt-app pt-center" data-theme={props.theme}>
      <div className="pt-card pt-connect">
        <h1>{props.title}</h1>
        {conn.state === "connecting" && <p className="pt-muted">サーバにつないでいます…</p>}
        {conn.state === "offline" && (
          <>
            <p className="pt-status pt-status--error">{conn.message}</p>
            <button type="button" className="pt-button" onClick={onRetry}>
              もう一度つなぐ
            </button>
          </>
        )}
        {conn.state === "need-token" && (
          <form onSubmit={submit}>
            <p>{conn.message ?? "patchiri サーバを起動したときに出た URL から開くと、そのまま使えます。トークンだけを貼ることもできます。"}</p>
            <label className="pt-note">
              <span>トークン</span>
              <input type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
            </label>
            <button type="submit" className="pt-button pt-button--primary">
              つなぐ
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
