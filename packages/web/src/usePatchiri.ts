"use client";

// 検証から反映までの流れ（つなぐ、対象の定義を読む、検証と差分、確かめと反映）を、画面の見た目に依らずに持つ React のフック。
// 同梱の画面（PatchiriApp）もこれで動く。自前の画面を作るときは、表の値を Sheet（patchiri-core）にして prepare に渡す。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildApplyRequest,
  PatchiriApiError,
  PatchiriHttpError,
  prepare as prepareSheet,
  type ApplyMode,
  type ApplyRequest,
  type ApplyResponse,
  type Failure,
  type Issue,
  type PatchiriApi,
  type PrepareResult,
  type RulesConfig,
  type Sheet,
  type TableDescription,
  type TargetSummary,
  type ValidateOptions,
} from "patchiri-core";

export type PatchiriConnection =
  /** client が無い（トークンを待っているなど）。 */
  | { state: "idle" }
  | { state: "connecting" }
  /** targets は更新できるターゲットだけ（options の target・targets で絞ったもの）。 */
  | { state: "ready"; targets: TargetSummary[] }
  | { state: "failed"; error: unknown; message: string };

export interface PatchiriPrepared {
  result: PrepareResult;
  target: string;
  /** 確かめるときと反映するときで同じものを使う（二度押しでも一度だけ反映される）。 */
  requestId: string;
  at: Date;
}

export type PatchiriApplied =
  | { mode: ApplyMode; requestId: string; state: "running" }
  | { mode: ApplyMode; requestId: string; state: "ok"; response: ApplyResponse }
  | { mode: ApplyMode; requestId: string; state: "failed"; failure: Failure };

/** onBeforeApply の答え。false か文字列（止めた理由）なら送らない。 */
export type BeforeApplyVerdict = boolean | string | void;

export interface UsePatchiriOptions {
  /** つなぐ先。null か undefined の間はつながない。描くたびに作り直すとつなぎ直すので、外か useMemo で作っておく。 */
  client: PatchiriApi | null | undefined;
  /** 対象を決めておく（許可リストのターゲット名）。setTarget では変わらない。 */
  target?: string;
  /** 選べるターゲットを絞る。 */
  targets?: readonly string[];
  /** 最初に選ぶ対象（前に選んだものなど）。選べるものになければ使わない。 */
  initialTarget?: string;
  /** 手元の業務ルール（patchiri.rules.json の中身）。サーバに置いたルール（describe の rules）はいつも使う。 */
  rules?: RulesConfig | null;
  aliases?: Record<string, string>;
  readDisplay?: boolean;
  checkRow?: ValidateOptions["checkRow"];
  /** 問題の文を言い換える。undefined を返せば元の文。 */
  formatIssue?: (issue: Issue) => string | undefined;
  onPrepared?: (result: PrepareResult, target: string) => void;
  /** サーバに送る直前。false か文字列（止めた理由）を返すか、例外を投げると送らない。 */
  onBeforeApply?: (request: Omit<ApplyRequest, "v">, mode: ApplyMode) => BeforeApplyVerdict | Promise<BeforeApplyVerdict>;
  onApplied?: (response: ApplyResponse, mode: ApplyMode) => void;
}

export interface PatchiriController {
  connection: PatchiriConnection;
  /** つなぎ直す（ターゲットの一覧を読み直す）。 */
  reconnect(): void;
  /** 選んでいる対象。まだなら ""。 */
  target: string;
  setTarget(target: string): void;
  /** 対象の定義（describe）。読んでいる間は null。 */
  description: TableDescription | null;
  /** 検証して差分を取る。取れなければ（サーバに届かないなど）null を返し、error に文を置く。検証のエラーは result.issues。 */
  prepare(sheet: Sheet): Promise<PatchiriPrepared | null>;
  preparing: boolean;
  /** 最後に検証した結果。対象を変えると捨てる。 */
  prepared: PatchiriPrepared | null;
  /** prepared の差分を、確かめる（check）か反映する（execute）。 */
  apply(mode: ApplyMode, note?: string): Promise<PatchiriApplied | null>;
  /** prepared に対して最後に送った結果。 */
  applied: PatchiriApplied | null;
  /** 定義が読めない、検証に失敗した、などの文。 */
  error: string | null;
  clearError(): void;
}

/** ログインが切れたか、権限がないときの応答（載せ先のアプリの 401 / 403、ログインの画面への転送）。 */
export const deniedHttp = (e: unknown): e is PatchiriHttpError => e instanceof PatchiriHttpError && (e.status === 401 || e.status === 403 || e.notJson);

/** 呼び出しの失敗を、画面に出す文にする。 */
export function errorText(e: unknown): string {
  if (e instanceof PatchiriApiError) return `${e.failure.error.message}（${e.failure.error.code}）`;
  if (deniedHttp(e)) {
    const why = e.notJson ? "ログインの画面などに回されました" : `HTTP ${e.status}`;
    // 開き直すと貼った表が消えるので、別のタブでログインし直してもらう（クッキーはタブをまたいで効く）。
    return `ログインが切れたか、このページを使う権限がありません。別のタブでこのページを開いてログインし直してから、もう一度押してください（${why}）`;
  }
  if (e instanceof TypeError) return "サーバに届きません。patchiri サーバが動いているか確かめてください";
  return e instanceof Error ? e.message : String(e);
}

export function usePatchiri(options: UsePatchiriOptions): PatchiriController {
  const { client, target: fixedTarget } = options;
  // 渡された関数やルールは、描き直すたびに変わっても読み直さないよう ref で持つ（使うときに今の値を読む）。
  const latest = useRef(options);
  latest.current = options;
  const allowed = options.targets?.join("\u0000");

  const [connection, setConnection] = useState<PatchiriConnection>(client ? { state: "connecting" } : { state: "idle" });
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState("");
  const [description, setDescription] = useState<TableDescription | null>(null);
  const [prepared, setPrepared] = useState<PatchiriPrepared | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [applied, setApplied] = useState<PatchiriApplied | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) {
      setConnection({ state: "idle" });
      return;
    }
    let alive = true;
    setConnection({ state: "connecting" });
    client.targets().then(
      (res) => {
        if (!alive) return;
        const only = allowed === undefined ? null : new Set(allowed.split("\u0000"));
        const targets = res.targets.filter((t) => t.access === "update" && (!only || only.has(t.target)) && (fixedTarget === undefined || t.target === fixedTarget));
        if (fixedTarget !== undefined && targets.length === 0) {
          const message = `ターゲット ${fixedTarget} がサーバにないか、更新できないか、使う権限がありません`;
          setConnection({ state: "failed", error: new Error(message), message });
          return;
        }
        setConnection({ state: "ready", targets });
        const initial = latest.current.initialTarget;
        setChosen((cur) => cur || (initial && targets.some((t) => t.target === initial) ? initial : targets.length === 1 ? targets[0]!.target : ""));
      },
      (e: unknown) => alive && setConnection({ state: "failed", error: e, message: errorText(e) }),
    );
    return () => {
      alive = false;
    };
  }, [client, fixedTarget, allowed, attempt]);

  const target = fixedTarget ?? chosen;

  useEffect(() => {
    setDescription(null);
    setPrepared(null);
    setApplied(null);
    if (!client || connection.state !== "ready" || !target) return;
    let alive = true;
    client.describe(target).then(
      (d) => alive && setDescription(d),
      (e: unknown) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [client, connection, target]);

  const prepare = useCallback(
    async (sheet: Sheet): Promise<PatchiriPrepared | null> => {
      if (!client || !target) return null;
      setPreparing(true);
      setApplied(null);
      setError(null);
      try {
        const { rules, aliases, readDisplay, checkRow, formatIssue } = latest.current;
        let result = await prepareSheet(client, target, sheet, {
          ...(rules && { rules }),
          ...(aliases && { aliases }),
          ...(readDisplay !== undefined && { readDisplay }),
          ...(checkRow && { checkRow }),
        });
        if (formatIssue) result = { ...result, issues: result.issues.map((i) => ({ ...i, message: formatIssue(i) ?? i.message })) };
        const p: PatchiriPrepared = { result, target, requestId: crypto.randomUUID(), at: new Date() };
        setPrepared(p);
        latest.current.onPrepared?.(result, target);
        return p;
      } catch (e) {
        setPrepared(null);
        setError(errorText(e));
        return null;
      } finally {
        setPreparing(false);
      }
    },
    [client, target],
  );

  const apply = useCallback(
    async (mode: ApplyMode, note?: string): Promise<PatchiriApplied | null> => {
      const p = prepared;
      if (!client || !p?.result.diff) return null;
      const done = (a: PatchiriApplied) => {
        setApplied(a);
        return a;
      };
      setApplied({ mode, requestId: p.requestId, state: "running" });
      const trimmed = note?.trim();
      const { v: _, ...req } = buildApplyRequest(p.result.diff, { mode, requestId: p.requestId, ...(trimmed && { note: trimmed }) });
      const before = latest.current.onBeforeApply;
      if (before) {
        let verdict: BeforeApplyVerdict;
        try {
          verdict = await before(req, mode);
        } catch (e) {
          verdict = errorText(e);
        }
        if (verdict === false || typeof verdict === "string") {
          const message = `${typeof verdict === "string" && verdict ? verdict : "送る前の確かめで止めました"}。何も反映していません`;
          return done({ mode, requestId: p.requestId, state: "failed", failure: { ok: false, v: 1, error: { code: "cancelled", message } } });
        }
      }
      try {
        const res = await client.apply(req);
        if (!res.ok) return done({ mode, requestId: p.requestId, state: "failed", failure: res });
        const a = done({ mode, requestId: p.requestId, state: "ok", response: res });
        latest.current.onApplied?.(res, mode);
        return a;
      } catch (e) {
        // 認証で断られた呼び出しは、サーバの反映の手前で止まっている。
        const message = deniedHttp(e) ? `${errorText(e)}。何も反映していません` : errorText(e);
        return done({ mode, requestId: p.requestId, state: "failed", failure: { ok: false, v: 1, error: { code: "network", message } } });
      }
    },
    [client, prepared],
  );

  return {
    connection,
    reconnect: useCallback(() => setAttempt((n) => n + 1), []),
    target,
    setTarget: setChosen,
    description,
    prepare,
    preparing,
    prepared,
    apply,
    applied,
    error,
    clearError: useCallback(() => setError(null), []),
  };
}
