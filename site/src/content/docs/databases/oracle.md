---
title: Oracle
description: Oracle につなぐときの設定と、patchiri が合わせていること
---

Node 版、C# 版、VB.NET 版のどのサーバでも使えます。どれも Oracle Client（Instant Client）は要りません（Node 版は node-oracledb の Thin モードで Oracle 12c 以降、C# 版と VB.NET 版は ODP.NET Managed Driver）。

## 試す

手元で試すなら、コンテナの Oracle Free が手軽です。

```sh
docker run -d -p 1521:1521 -e ORACLE_PASSWORD=... -e APP_USER=patchiri -e APP_USER_PASSWORD=... gvenzl/oracle-free:23-slim

# 例のテーブルを作る（patchiri のスキーマに M_PRODUCT と M_CATEGORY）
sqlplus patchiri/...@localhost:1521/FREEPDB1 @examples/oracle/setup.sql

cd examples/oracle
PATCHIRI_DB_PASSWORD=... node ../../packages/server-node/dist/src/main.js -c patchiri.config.json
```

画面と CLI の使い方は SQL Server と同じです。Excel の見本も SQL Server の例のものがそのまま使えます。

## つなぐ先

```json
{ "dialect": "oracle", "connectString": "dbhost:1521/ORCLPDB1", "user": "app", "lockWaitSeconds": 10 }
```

- `connectString` は `ホスト:ポート/サービス名` か、tnsnames.ora の別名（そのときは `configDir` に tnsnames.ora のフォルダ）。
- Thin モードでつながらない古い DB（11g など）は、Instant Client を入れて `"thick": true`（Windows と macOS は `"thick": { "libDir": "C:\\oracle\\instantclient_19_25" }`）。

C# 版と VB.NET 版は、NuGet の `Oracle.ManagedDataAccess`（ODP.NET Managed Driver）を載せ先に入れ、web.config の接続文字列に `providerName` を書きます（[WebForms に載せる](/servers/webforms/#oracle-につなぐ)）。

```xml
<add name="Patchiri" providerName="Oracle.ManagedDataAccess.Client"
     connectionString="User Id=app;Password=...;Data Source=dbhost:1521/ORCLPDB1" />
```

## patchiri が合わせていること

- **テーブル名と列名**: `"` で囲まない名前は大文字として探します（Oracle と同じ）。スキーマを省くとつないだユーザーのスキーマで、なければシノニムをたどります。列名は大文字小文字を区別しないので、Excel の見出しは `ProductCode` でも `PRODUCTCODE` でもかまいません。
- **空文字は NULL**: Oracle では空文字を入れると NULL になります。取込の空文字は NULL として扱うので、NOT NULL の列では「必須です」のエラーになります。
- **DATE は時刻つき**: 差分には `2024-04-01T00:00:00` のように出ます。秒の小数は入れられません。
- **桁**: `NUMBER(9,2)` は整数部 7 桁・小数 2 桁で確かめます。`VARCHAR2(10 BYTE)` はバイト、`VARCHAR2(10 CHAR)` は文字数で数えます。
- **CHAR のキー**: `CHAR(6)` のコードも、末尾の空白を詰めずに `A001` と書けば当たります。
- **ロック**: SQL Developer などで COMMIT していない更新が対象の行に残っていると、反映は `lockWaitSeconds` 待って止まります。
- **出力する SQL**: PL/SQL のブロックで、SQL*Plus、SQLcl、SQL Developer で流せます。反映 SQL は 1 行でも合わなければ全部取り消して止まり、戻し SQL は合わない行を飛ばして DBMS_OUTPUT にその行を出します。先頭で `ALTER SESSION SET NLS_COMP = 'BINARY' NLS_SORT = 'BINARY'` をします（流したセッションはその後もこの設定のままです）。

## 扱えない型

CLOB、BLOB、RAW、TIMESTAMP WITH TIME ZONE などは読めますが、更新できません。
