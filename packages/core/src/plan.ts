// 反映計画（plan.json）。差分から作って承認に回し、承認後に CLI（harikit apply）や画面で反映する。

import { buildApplyRequest, type DiffResult, type DiffStatus } from "./diff.js";
import type { ApplyRequest } from "./types.js";

export interface ApplyPlan {
  harikitPlan: 1;
  createdAt: string;
  /** 取込元（ファイル名、画面の貼り付けなら "grid"）。 */
  source: string;
  target: string;
  counts: Record<DiffStatus, number>;
  /** mode は "check"。反映するときに "execute" に替えて送る。 */
  request: ApplyRequest;
}

export function buildPlan(d: DiffResult, source: string, options: { requestId?: string; note?: string } = {}): ApplyPlan {
  return {
    harikitPlan: 1,
    createdAt: new Date().toISOString(),
    source,
    target: d.target,
    counts: d.counts,
    request: buildApplyRequest(d, { mode: "check", ...options }),
  };
}
