---
title: PostgreSQL
description: PostgreSQL につなぐときの設定と、patchiri が合わせていること
---

今は Node 版サーバだけが対応しています（C# 版と VB.NET 版は SQL Server だけ）。PostgreSQL 14 以降で動きます。

:::tip[デモも PostgreSQL]
[デモ](/demo/)は、このページの PostgreSQL の方言を、ブラウザの中で動く PostgreSQL（PGlite）にそのまま載せたものです。出力する SQL の形や、衝突したときの止まり方はデモで確かめられます。
:::

## 試す

手元で試すなら、コンテナが手軽です。

```sh
docker run -d -p 5432:5432 -e POSTGRES_USER=patchiri -e POSTGRES_PASSWORD=... -e POSTGRES_DB=patchiri postgres:18

# 例のテーブルを作る（public スキーマに m_product と m_category）
psql -h localhost -U patchiri -d patchiri -f examples/postgres/setup.sql

cd examples/postgres
PATCHIRI_DB_PASSWORD=... node ../../packages/server-node/dist/src/main.js -c patchiri.config.json
```

画面と CLI の使い方は SQL Server と同じです。Excel の見本も SQL Server の例のものがそのまま使えます（`patchiri diff ../sqlserver/price-update.xlsx -t product`）。

## つなぐ先

```json
{ "dialect": "postgresql", "host": "dbhost", "port": 5432, "database": "app", "user": "app", "ssl": true }
```

- `ssl`: `true` で TLS でつなぎます（証明書を確かめない自己署名の DB なら `{ "rejectUnauthorized": false }`）。省くと TLS なしです。
- `lockWaitSeconds`: 反映のとき、ほかのセッションがロックしている行を待つ秒数（既定 10）。
- パスワードは設定ファイルに書かず、環境変数 `PATCHIRI_DB_PASSWORD` で渡せます。

## patchiri が合わせていること

- **テーブル名と列名**: `"` で囲まない名前は小文字として探します（PostgreSQL と同じ）。スキーマを省くと `search_path` で探します。列名は大文字小文字を区別しないので、Excel の見出しは `ProductCode` でも `productcode` でもかまいません（差分には DB の名前で出ます）。
- **値が変わっていないか**: 列に大文字小文字を区別しない照合順序（ICU の nondeterministic）が付いていても、値は 1 字ずつ比べます。キーは列の照合順序で探します。
- **char(n) のキー**: 末尾の空白を詰めずに書けば当たります。
- **enum**: 文字列として更新できます。ラベルにない値は DB のエラーになります。
- **出力する SQL**: DO ブロック 1 つで、psql、pgAdmin、DBeaver などで流せます。反映 SQL は 1 行でも合わなければ全部取り消して止まり（`patchiri:` で始まるエラー）、戻し SQL は合わない行を飛ばして NOTICE に出します。自動コミットを切ったツールでは、流した後に COMMIT してください。

## 扱えない型

timestamptz（タイムゾーンつき）、uuid、json / jsonb、bytea、money、配列などは読めますが、更新できません。
