import { test } from "node:test";
import assert from "node:assert/strict";
import { PatchiriClient, PatchiriHttpError } from "../src/index.js";

/** 決まった応答を返す fetch。呼ばれた URL と本文を覚える。 */
function fakeFetch(res: () => Response) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return res();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test("webmethod スタイルは {req} で送り、{d} から取り出す", async () => {
  const { fetch, calls } = fakeFetch(() => Response.json({ d: { ok: true, v: 1, targets: [] } }));
  const client = new PatchiriClient({ baseUrl: "/Admin/MasterUpdate.aspx/", style: "webmethod", fetch });
  assert.deepEqual(await client.targets(), { ok: true, v: 1, targets: [] });
  assert.deepEqual(calls, [{ url: "/Admin/MasterUpdate.aspx/Describe", body: { req: { v: 1 } } }]);
});

test("401 などは PatchiriHttpError", async () => {
  const { fetch } = fakeFetch(() => new Response('{"Message":"Authentication failed."}', { status: 401 }));
  const client = new PatchiriClient({ baseUrl: "/p.aspx", style: "webmethod", fetch });
  await assert.rejects(client.targets(), (e) => e instanceof PatchiriHttpError && e.status === 401 && !e.notJson);
});

test("載せ先のログインの画面に回されて HTML が返ったら、JSON でないことを知らせる", async () => {
  const { fetch } = fakeFetch(() => new Response("<!doctype html><title>ログイン</title>", { status: 200, headers: { "Content-Type": "text/html" } }));
  const client = new PatchiriClient({ baseUrl: "/p.aspx", style: "webmethod", fetch });
  await assert.rejects(client.apply({ requestId: "r", mode: "execute", changes: [] }), (e) => e instanceof PatchiriHttpError && e.status === 200 && e.notJson);
});
