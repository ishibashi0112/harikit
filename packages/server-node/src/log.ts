// 反映ログ。1 行 1 件の JSON（JSON Lines）を日付ごとのファイルに足していく。

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ApplyLogEntry } from "./handlers.js";

export function fileLogger(dir: string): (entry: ApplyLogEntry) => Promise<void> {
  let ready: Promise<unknown> | undefined;
  return async (entry) => {
    ready ??= mkdir(dir, { recursive: true });
    await ready;
    const file = join(dir, `apply-${entry.appliedAt.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  };
}
