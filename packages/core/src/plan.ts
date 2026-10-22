// 反映計画（plan.json）。差分から作って承認に回し、承認後に CLI（patchiri apply）や画面で反映する。

import { canonicalJson, sha256Hex } from "./digest.js";
import { buildApplyRequest, type DiffResult, type DiffStatus } from "./diff.js";
import type { ApplyRequest } from "./types.js";

export interface ApplyPlan {
  patchiriPlan: 1;
  createdAt: string;
  /** 取込元（ファイル名、画面の貼り付けなら "grid"）。 */
  source: string;
  target: string;
  counts: Record<DiffStatus, number>;
  /** mode は "check"。反映するときに "execute" に替えて送る。 */
  request: ApplyRequest;
  /**
   * 計画の指紋（request の requestId と changes の SHA-256、16 進 64 桁）。承認の記録に残しておけば、反映するときに同じ計画かを確かめられる。
   * mode と note は含めない（反映するときに替えるため）。
   */
  digest?: string;
}

/** 反映のリクエストの指紋。requestId と changes だけから作る。 */
export function planDigest(request: Pick<ApplyRequest, "requestId" | "changes">): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson({ requestId: request.requestId, changes: request.changes })));
}

export function buildPlan(d: DiffResult, source: string, options: { requestId?: string; note?: string } = {}): ApplyPlan {
  const request = buildApplyRequest(d, { mode: "check", ...options });
  return {
    patchiriPlan: 1,
    createdAt: new Date().toISOString(),
    source,
    target: d.target,
    counts: d.counts,
    request,
    digest: planDigest(request),
  };
}

/** 計画の指紋を確かめる。digest が無い計画（前の版で作ったもの）は null、合えば true。 */
export function verifyPlan(plan: Pick<ApplyPlan, "request" | "digest">): boolean | null {
  if (plan.digest === undefined) return null;
  return plan.digest.toLowerCase() === planDigest(plan.request);
}
