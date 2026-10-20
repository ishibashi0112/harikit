// 「DB の中身」の窓。patchiri を通さずに DB を直接見て、SQL（戻し SQL など）を流せる。デモだけの道具。

import { useEffect, useMemo, useRef, useState } from "react";
import { SpreadsheetGrid, type GridColumn } from "@ishibashi0112/spreadsheet-grid";
import type { ApplyLogEntry } from "patchiri-server-node/handlers";
import type { DemoDb, RunResult } from "./db.js";

export type DbTab = "product" | "category" | "sql" | "log";

const TABLES = {
  product: {
    name: "m_product",
    key: "product_code",
    // boolean は t / f ではなく true / false で見せる。
    sql: "SELECT product_code, product_name, category_code, unit_price, release_date, on_sale::text AS on_sale, updated_at FROM m_product ORDER BY product_code",
  },
  category: { name: "m_category", key: "category_code", sql: "SELECT * FROM m_category ORDER BY category_code" },
} as const;

type TableRow = { id: string; [col: string]: unknown };

interface Props {
  db: DemoDb;
  tab: DbTab | null;
  onTab: (tab: DbTab | null) => void;
  /** DB を最初に戻すたびに増える。 */
  generation: number;
  log: readonly ApplyLogEntry[];
  undoScript: string | null;
  appliedScript: string | null;
}

export function DbDialog({ db, tab, onTab, generation, log, undoScript, appliedScript }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<{ ok: true; value: RunResult } | { ok: false; message: string } | null>(null);
  const [running, setRunning] = useState(false);
  /** 流した SQL で DB が変わったら増やして、表を読み直させる。 */
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (tab && !d.open) d.showModal();
    if (!tab && d.open) d.close();
  }, [tab]);

  const run = async () => {
    setRunning(true);
    try {
      setResult({ ok: true, value: await db.run(sql) });
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
      setVersion((v) => v + 1);
    }
  };

  return (
    <dialog ref={ref} className="demo-dialog" aria-label="DB の中身" onClose={() => onTab(null)}>
      <header className="demo-dialog-head">
        <h2>DB の中身</h2>
        <div className="pt-tabs" role="tablist">
          {(
            [
              ["product", "m_product（商品）"],
              ["category", "m_category（分類）"],
              ["sql", "SQL を流す"],
              ["log", `反映ログ（${log.length}）`],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="demo-dialog-close" aria-label="閉じる" onClick={() => onTab(null)}>
          ×
        </button>
      </header>
      <div className="demo-dialog-body">
        {(tab === "product" || tab === "category") && <TableView db={db} table={tab} generation={generation} version={version} />}
        {tab === "sql" && (
          <div className="demo-sql">
            <p className="pt-muted">
              patchiri を通さず、この DB に SQL を直接流します。patchiri が返した戻し SQL を流すと、反映した行が元に戻ります（今の値が patchiri で入れた値のままの行だけ）。
            </p>
            <div className="pt-actions">
              <button type="button" className="pt-button pt-button--small" disabled={!undoScript} onClick={() => undoScript && setSql(undoScript)}>
                直近の戻し SQL を入れる
              </button>
              <button type="button" className="pt-button pt-button--small" disabled={!appliedScript} onClick={() => appliedScript && setSql(appliedScript)}>
                直近の反映 SQL を入れる
              </button>
              <button type="button" className="pt-button pt-button--small" onClick={() => setSql(TABLES.product.sql + ";")}>
                商品を見る SELECT
              </button>
            </div>
            <textarea className="demo-sql-input" value={sql} spellCheck={false} onChange={(e) => setSql(e.target.value)} placeholder="SQL を書くか、上のボタンで入れてください" />
            <div className="pt-actions">
              <button type="button" className="pt-button pt-button--primary" disabled={running || sql.trim() === ""} onClick={() => void run()}>
                {running ? "流しています…" : "流す"}
              </button>
            </div>
            {result && <RunResultView result={result} />}
          </div>
        )}
        {tab === "log" && <LogView log={log} />}
      </div>
    </dialog>
  );
}

/** テーブルの中身。DB を作ったときから変わったセルに色を付ける。 */
function TableView({ db, table, generation, version }: { db: DemoDb; table: "product" | "category"; generation: number; version: number }) {
  const t = TABLES[table];
  const [rows, setRows] = useState<Record<string, string | null>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = rows ? db.initial.get(t.name) : undefined;

  useEffect(() => {
    let alive = true;
    db.query(t.sql).then(
      (r) => {
        if (!alive) return;
        setRows(r);
        setError(null);
      },
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [db, t, generation, version]);

  const columns = useMemo<GridColumn<TableRow>[]>(() => {
    const names = rows?.[0] ? Object.keys(rows[0]) : [];
    return names.map((c) => ({
      key: c,
      title: c,
      width: c === "product_name" ? 240 : c === "updated_at" ? 190 : 130,
      ...(c === t.key && { pinned: "left" as const }),
      valueFormatter: ({ value }: { value: unknown }) => (value === null || value === undefined ? "（NULL）" : String(value)),
      cellClassName: ({ row }: { row: TableRow }) => {
        if (!first || c === "updated_at") return undefined;
        const k = `${row.id}\u0000${c}`;
        return first.has(k) && first.get(k) !== (row[c] ?? null) ? "demo-changed" : undefined;
      },
    }));
  }, [rows, first, t]);

  const gridRows = useMemo<TableRow[]>(() => (rows ?? []).map((r) => ({ ...r, id: String(r[t.key]) })), [rows, t]);
  const changed = useMemo(() => {
    if (!first || !rows) return 0;
    let n = 0;
    for (const r of rows) for (const [c, v] of Object.entries(r)) if (c !== "updated_at" && first.has(`${r[t.key]}\u0000${c}`) && first.get(`${r[t.key]}\u0000${c}`) !== v) n++;
    return n;
  }, [rows, first, t]);

  if (error) return <p className="pt-status pt-status--error">{error}</p>;
  if (!rows) return <p className="pt-muted">読んでいます…</p>;
  return (
    <div className="demo-table">
      <p className="pt-muted">
        {t.name} の今の中身（{rows.length} 行）。{changed > 0 ? <span className="demo-changed-sample">色の付いたセル</span> : "色の付いたセル"}は、DB を作ったときから変わった値です（今 {changed} 個）。
        {table === "product" && " updated_at は patchiri の外で書き換えたときだけ変わります。"}
      </p>
      <div className="demo-table-grid">
        <SpreadsheetGrid<TableRow>
          rows={gridRows}
          columns={columns}
          rowKeyGetter={(r) => r.id}
          readOnly
          height="100%"
          density="compact"
          theme="auto"
          enableColumnMenu={false}
          showTopBar={false}
          showBottomBarCounts={false}
          ariaLabel={t.name}
        />
      </div>
    </div>
  );
}

function RunResultView({ result }: { result: { ok: true; value: RunResult } | { ok: false; message: string } }) {
  if (!result.ok) return <p className="pt-status pt-status--error">エラー: {result.message}（何も変えずに戻しました）</p>;
  const { statements, notices } = result.value;
  const select = [...statements].reverse().find((s) => s.columns.length > 0);
  return (
    <div className="demo-run">
      {notices.length > 0 && (
        <ul className="demo-notices">
          {notices.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <p className="pt-status pt-status--ok">
        流しました: {statements.map((s) => `${s.command}${s.rowCount !== null && s.command !== "SET" ? ` ${s.rowCount}` : ""}`).join("、") || "（文なし）"}
      </p>
      {select && (
        <div className="demo-run-table">
          <table>
            <thead>
              <tr>
                {select.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {select.rows.slice(0, 200).map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className={v === null ? "pt-muted" : undefined}>
                      {v ?? "NULL"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const OUTCOME: Record<ApplyLogEntry["outcome"], string> = { applied: "反映した", checked: "確かめた", conflict: "衝突で止めた", error: "エラー" };

function LogView({ log }: { log: readonly ApplyLogEntry[] }) {
  if (log.length === 0) return <p className="pt-muted">まだありません。「DB で確かめる」や「反映する」を押すと、サーバが残す反映ログ（本物のサーバではファイル）がここに出ます。</p>;
  return (
    <ul className="demo-log">
      {log.map((e, i) => (
        <li key={i}>
          <details>
            <summary>
              <span className={`demo-log-outcome demo-log-outcome--${e.outcome}`}>{OUTCOME[e.outcome]}</span>
              <span>{e.appliedAt.replace("T", " ").slice(0, 19)}</span>
              <span>
                {e.target}・{e.rows.length} 行
              </span>
              {e.note && <span className="pt-muted">{e.note}</span>}
            </summary>
            <pre>{JSON.stringify(e, null, 2)}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}
