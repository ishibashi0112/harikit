// 画面（PatchiriClient）の HTTP を、同じタブの中の Handlers につなぐ。
// 画面・コア・Handlers・PostgreSQL の方言は本物のサーバと同じコードで、変わるのは「HTTP の代わりに関数を呼ぶ」ところだけ。
// 行き来する値は一度 JSON にして、HTTP を通したときと同じ形にそろえる。

import type { Handlers } from "patchiri-server-node/handlers";

export type ApiName = "describe" | "fetch" | "apply";

/** 1 回の呼び出し（デモの「ほかの人が書き換える」や「戻し SQL」が使う）。 */
export interface Exchange {
  name: ApiName;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

const NAMES = new Set<string>(["describe", "fetch", "apply"]);

export function localFetch(handlers: Pick<Handlers, "handle">, onExchange?: (x: Exchange) => void): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const name = url.replace(/^.*\//, "");
    if (!NAMES.has(name)) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    const request = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
    const response = JSON.parse(JSON.stringify(await handlers.handle(name as ApiName, request))) as Record<string, unknown>;
    onExchange?.({ name: name as ApiName, request, response });
    return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  };
}
