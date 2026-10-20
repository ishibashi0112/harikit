---
title: Node 版サーバ
description: 手元や社内のサーバで、API 3 本と画面を配る
---

Node 版サーバは、API 3 本（describe / fetch / apply）と画面を 1 つのプロセスで配ります。手元だけで使うときは `127.0.0.1` で立てます。

## 起動

Node.js 22 以上が要ります。

```sh
npm install
npm run build
node packages/server-node/dist/src/main.js -c patchiri.config.json
```

```
patchiri サーバを起動しました: http://127.0.0.1:7357
画面: http://127.0.0.1:7357/#token=…
トークン: …
```

- 設定ファイルは `-c`（既定は今のフォルダの `patchiri.config.json`）。中身は [許可リストと設定](/usage/config/)。
- DB のパスワードは環境変数 `PATCHIRI_DB_PASSWORD` で渡せます。
- トークンは起動のたびに乱数で作ります。決めたいときは `PATCHIRI_TOKEN` で渡します。CLI には同じ値を `PATCHIRI_TOKEN` で渡します。

## 守っていること

- API は `Authorization: Bearer <トークン>` と `X-Patchiri: 1` のヘッダがなければ受け付けません（ほかのサイトからの呼び出し対策）。
- 画面は同じオリジンの API だけにつなぐよう、Content-Security-Policy で外への通信を止めています。
- 反映ログは `logDir`（既定 `./patchiri-log`）に、日ごとの `apply-YYYY-MM-DD.jsonl` で残します。1 行 1 件で、誰が（OS のユーザー名）・いつ・`requestId`・メモ・行ごとの前後の値が入ります。

## 社内のサーバに置くとき

Node 版の認証はトークンだけです。複数の人で使うなら、載せ先のアプリの認証の中に置ける [WebForms 版](/servers/webforms/)にするか、認証付きのリバースプロキシの後ろに置いてください。
