---
title: SQL Server
description: SQL Server につなぐときの設定と、patchiri が合わせていること
---

Node 版、C# 版、VB.NET 版のどのサーバでも使えます。

## 試す

Node.js 22 以上が要ります。

```sh
npm install
npm run build

# 例のテーブルを作る（PatchiriSample データベースに M_Product と M_Category）
sqlcmd -S localhost -U sa -i examples/sqlserver/setup.sql

# サーバを起動する（127.0.0.1:7357。起動時に画面の URL とトークンが出る）
cd examples/sqlserver
PATCHIRI_DB_PASSWORD=... node ../../packages/server-node/dist/src/main.js -c patchiri.config.json
```

`examples/sqlserver` には、差分が出る Excel（`price-update.xlsx`）と、誤りの混ざった Excel（`with-errors.xlsx`）があります。

## つなぐ先（Node 版）

```json
{
  "dialect": "sqlserver",
  "server": "localhost",
  "port": 1433,
  "database": "PatchiriSample",
  "user": "patchiri",
  "options": { "encrypt": true, "trustServerCertificate": false, "instanceName": "SQLEXPRESS" },
  "lockWaitSeconds": 10
}
```

C# 版と VB.NET 版は、web.config の接続文字列（既定の名前は `Patchiri`）を使います（[WebForms に載せる](/servers/webforms/)）。

## patchiri が合わせていること

- **照合順序**: どの行か（キー）は列の照合順序で探し、値が変わっていないかは厳密に比べます。`Japanese_CI_AS` の `=` は「ボールペン」と「ﾎﾞｰﾙﾍﾟﾝ」を同じとみなすので、そのままだと後から別の人が直した行を上書きするためです。
- **varchar のバイト数**: varchar の桁は、列の照合順序の文字コード（Shift_JIS など）でバイト数を数えます。その文字コードで表せない字はエラーにします（SQL Server は黙って「?」に置き換えるため）。
- **日本語**: 文字列は varchar の列でも nvarchar のパラメータで渡し、出力する SQL も `N'…'` で書きます。
- **char / nchar**: DB が末尾を空白で埋めるので、末尾の空白だけの違いは同じ値とみなします。
- **text / ntext**: 古い型ですが、varchar(max) / nvarchar(max) と同じ文字列として更新できます（キーには使えません）。
- **トリガー**: 監査トリガーなどがあるテーブルでも、UPDATE そのものの行数で確かめます。
- **ロック**: ほかのセッションがロックしている行は `lockWaitSeconds`（既定 10 秒）待ってから、「ほかのセッションにロックされています」と出して止めます。
- **出力する SQL**: 反映 SQL は UPDATE ごとに `IF @@ROWCOUNT <> 1 THROW 50001, …` を続け、1 行でも見つからないか値が変わっていれば全部取り消して止まります。SSMS などで後から流しても同じです。

## 扱えない型

`image`、`xml`、`varbinary`、`uniqueidentifier`、`datetimeoffset` などは読めますが、更新できません。
