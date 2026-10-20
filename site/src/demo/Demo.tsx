// デモのページ。ブラウザの中の PostgreSQL（PGlite）に、patchiri の Handlers と PostgreSQL の方言をそのまま載せ、
// 画面（PatchiriApp）の通信をそこへつなぐ。サーバも DB も要らず、データはこのタブの外に出ない。

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PatchiriClient } from "patchiri-core";
import { PatchiriApp, type PatchiriAppHandle } from "patchiri-web";
import { Handlers, type ApplyLogEntry } from "patchiri-server-node/handlers";
import { PostgresDialect } from "patchiri-server-node/postgres";
import { DemoDb } from "./db.js";
import { DbDialog, type DbTab } from "./DbDialog.js";
import { OTHER_EDITS, RULES, SAMPLES, TARGETS, type Sample } from "./seed.js";
import { localFetch, type Exchange } from "./transport.js";
import { Mascot } from "../mascot/Mascot.js";
import logoUrl from "../assets/logo.svg?url";
import "@fontsource/zen-maru-gothic/900.css";
import "@ishibashi0112/spreadsheet-grid/style.css";
import "patchiri-web/style.css";
import "./demo.css";

type Boot = { state: "loading"; step: string } | { state: "failed"; message: string } | { state: "ready"; db: DemoDb; client: PatchiriClient };

/** 「DB で確かめる」で送った行（「ほかの人が書き換える」の相手）。 */
interface CheckedRow {
  key: Record<string, unknown>;
  before: Record<string, unknown>;
}

interface Toast {
  id: number;
  text: ReactNode;
  action?: { label: string; run: () => void };
  /** うまくいった知らせには、マスコットのウインクを添える。 */
  wink?: boolean;
}

const RULES_FILE = { name: "patchiri.rules.json（デモ）", text: JSON.stringify(RULES, null, 2) };

let toastId = 0;

function makeHandlers(db: DemoDb, onLog: (e: ApplyLogEntry) => void): Handlers {
  return new Handlers({
    // つなぎ先は PGlite なので database は使われない（形だけ）。DB のエラー文はデモでは見せる。
    config: { database: { dialect: "postgresql", host: "pglite", database: "postgres", user: "postgres" }, targets: TARGETS, exposeDbErrors: true },
    dialect: new PostgresDialect(db.connector()),
    whoAmI: () => "デモの利用者",
    log: async (e) => onLog(e),
    logError: (e) => console.error(e),
  });
}

export default function Demo() {
  const [boot, setBoot] = useState<Boot>({ state: "loading", step: "PostgreSQL（PGlite）を読み込んでいます…" });
  const [log, setLog] = useState<ApplyLogEntry[]>([]);
  const [checked, setChecked] = useState<CheckedRow[] | null>(null);
  const [undoScript, setUndoScript] = useState<string | null>(null);
  const [appliedScript, setAppliedScript] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DbTab | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // 手順の帯は、狭い画面では最初は閉じておく（表が見えなくなるため）。
  const [guide, setGuide] = useState(() => window.matchMedia("(min-width: 720px)").matches);
  /** DB を最初に戻したら増やす（DB の中身の「最初から変わったセル」の基準を取り直す）。 */
  const [generation, setGeneration] = useState(0);
  const appRef = useRef<PatchiriAppHandle>(null);
  const handlersRef = useRef<Handlers | null>(null);

  const toast = useCallback((text: ReactNode, action?: Toast["action"], wink?: boolean) => {
    const id = ++toastId;
    setToasts((t) => [...t.slice(-2), { id, text, ...(action && { action }), ...(wink && { wink }) }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 12_000);
  }, []);

  const onExchange = useCallback(
    (x: Exchange) => {
      if (x.name === "fetch" && x.request.target === "product") setChecked(null);
      if (x.name !== "apply") return;
      const change = (x.request.changes as { rows: CheckedRow[] }[] | undefined)?.[0];
      const ok = x.response.ok === true;
      if (x.request.mode === "check") setChecked(ok && change ? change.rows : null);
      if (ok) {
        setUndoScript(x.response.undoScript as string);
        setAppliedScript(x.response.script as string);
      }
      if (ok && x.request.mode === "execute") {
        setChecked(null);
        toast(<>反映しました。「DB の中身」で変わった値を確かめて、戻し SQL を流すと元に戻せます。</>, { label: "DB の中身を開く", run: () => setDialog("product") }, true);
      }
    },
    [toast],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (typeof WebAssembly !== "object") throw new Error("このブラウザは WebAssembly に対応していません");
        const db = await DemoDb.open();
        if (!alive) return;
        setBoot({ state: "loading", step: "patchiri をつないでいます…" });
        handlersRef.current = makeHandlers(db, (e) => setLog((l) => [e, ...l]));
        const fetch = localFetch({ handle: (name, body) => handlersRef.current!.handle(name, body) }, onExchange);
        const client = new PatchiriClient({ baseUrl: "https://demo.patchiri.invalid", fetch });
        setBoot({ state: "ready", db, client });
      } catch (e) {
        console.error(e);
        if (alive) setBoot({ state: "failed", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [onExchange]);

  if (boot.state === "loading") return <Loading step={boot.step} />;
  if (boot.state === "failed") return <Failed message={boot.message} />;
  const { db, client } = boot;

  const loadSample = (s: Sample) => {
    appRef.current?.loadCells(s.cells);
    toast(<>「{s.label}」を表に入れました。右の「検証して差分を見る」を押してください。</>);
  };

  const otherUserEdit = async () => {
    const row = checked?.find((r) => Object.keys(r.before).some((c) => c in OTHER_EDITS));
    if (!row) return;
    const column = Object.keys(OTHER_EDITS).find((c) => c in row.before)!;
    const code = String(row.key.product_code);
    try {
      const [r] = await db.query(
        `WITH old AS (SELECT ${column}::text AS v FROM m_product WHERE product_code = $1)
         UPDATE m_product p SET ${column} = ${OTHER_EDITS[column]}, updated_at = localtimestamp(3) FROM old
         WHERE p.product_code = $1 RETURNING old.v AS before, p.${column}::text AS after`,
        [code],
      );
      if (!r) return toast(<>{code} の行が DB にありません。</>);
      toast(
        <>
          ほかの人が {code} の {column} を <b>{r.before ?? "（空）"}</b> から <b>{r.after ?? "（空）"}</b> に変えました。このまま「反映する」を押すと、差分を取った後に変わった行として、何も反映せずに止まります。
        </>,
      );
    } catch (e) {
      toast(<>書き換えられませんでした: {e instanceof Error ? e.message : String(e)}</>);
    }
  };

  const resetDb = async () => {
    await db.reset();
    // 二度押し対策の記録や定義の覚えも捨てる（最初からやり直す）。
    handlersRef.current = makeHandlers(db, (e) => setLog((l) => [e, ...l]));
    setChecked(null);
    setUndoScript(null);
    setAppliedScript(null);
    setLog([]);
    setGeneration((g) => g + 1);
    toast(<>DB を最初の状態に戻しました。表の差分は古くなったので、もう一度「検証して差分を見る」を押してください。</>);
  };

  const tools = (
    <div className="demo-tools">
      {!guide && (
        <button type="button" className="pt-link" onClick={() => setGuide(true)}>
          手順
        </button>
      )}
      <SampleMenu onPick={loadSample} />
      <button type="button" className="pt-button pt-button--small" onClick={() => setDialog("product")}>
        DB の中身
      </button>
      <button
        type="button"
        className="pt-button pt-button--small"
        disabled={!checked}
        title={checked ? "patchiri の外で、差分に入っている行の値を 1 つ変えます" : "「DB で確かめる」の後に押せます"}
        onClick={() => void otherUserEdit()}
      >
        ほかの人が書き換える
      </button>
      <button type="button" className="pt-button pt-button--small" onClick={() => void resetDb()}>
        DB を最初に戻す
      </button>
      <DbDialog
        db={db}
        tab={dialog}
        onTab={setDialog}
        generation={generation}
        log={log}
        undoScript={undoScript}
        appliedScript={appliedScript}
      />
      <div className="demo-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="demo-toast">
            {t.wink && <Mascot face="wink" size={40} className="demo-toast-face" />}
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="pt-link"
                onClick={() => {
                  t.action!.run();
                  setToasts((all) => all.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="demo-toast-close" aria-label="閉じる" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="demo-page" style={{ "--demo-logo": `url("${logoUrl}")` } as CSSProperties}>
      {guide && <Guide onClose={() => setGuide(false)} />}
      <div className="demo-app">
        <PatchiriApp ref={appRef} client={client} serverLabel="ブラウザの中の PostgreSQL（PGlite）" initialRules={RULES_FILE} headerExtra={tools} />
      </div>
    </div>
  );
}

function Guide({ onClose }: { onClose: () => void }) {
  return (
    <div className="demo-guide" role="note">
      <strong className="demo-badge">デモ</strong>
      <ol>
        <li>「サンプル」で表に値を入れる（Excel からコピーして A1 に貼っても同じ）</li>
        <li>「検証して差分を見る」</li>
        <li>「DB で確かめる」→「反映する」</li>
        <li>「DB の中身」で結果を見て、戻し SQL を流す</li>
      </ol>
      <span className="demo-guide-note">
        DB はこのタブの中で動く PostgreSQL で、閉じると消えます。<a href="/guide/demo/">デモの説明</a>
      </span>
      <button type="button" className="demo-guide-close" aria-label="手順を閉じる" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

function SampleMenu({ onPick }: { onPick: (s: Sample) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="demo-menu" ref={ref}>
      <button type="button" className="pt-button pt-button--small pt-button--primary" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        サンプル ▾
      </button>
      {open && (
        <ul className="demo-menu-list" role="menu">
          {SAMPLES.map((s) => (
            <li key={s.id} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onPick(s);
                }}
              >
                <strong>{s.label}</strong>
                <span>{s.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Loading({ step }: { step: string }) {
  return (
    <div className="demo-center">
      <div className="demo-boot">
        <Mascot size={96} />
        <div className="demo-spinner" aria-hidden="true" />
        <p>{step}</p>
        <p className="demo-muted">ブラウザの中で PostgreSQL を動かすので、最初だけ数 MB を読み込みます。データはこのタブの外に出ません。</p>
      </div>
    </div>
  );
}

function Failed({ message }: { message: string }) {
  return (
    <div className="demo-center">
      <div className="demo-boot">
        <p className="demo-error">デモを始められませんでした: {message}</p>
        <p className="demo-muted">
          新しめの Chrome、Edge、Firefox、Safari で開き直してください。<a href="/">ドキュメントに戻る</a>
        </p>
      </div>
    </div>
  );
}
