---
title: MySQL / MariaDB
description: MySQL と MariaDB につなぐときの設定と、patchiri が合わせていること
---

今は Node 版サーバだけが対応しています（C# 版と VB.NET 版は SQL Server と Oracle）。MySQL 8.0 以降と MariaDB 10.11 以降で動きます。MariaDB も方言は `mysql` です。

## 試す

手元で試すなら、コンテナが手軽です（MariaDB なら `mariadb:11.4`、環境変数の名前は同じ）。

```sh
docker run -d -p 3306:3306 -e MYSQL_ROOT_PASSWORD=... -e MYSQL_DATABASE=patchiri -e MYSQL_USER=patchiri -e MYSQL_PASSWORD=... mysql:8.4

# 例のテーブルを作る（patchiri データベースに M_Product と M_Category）
mysql -h 127.0.0.1 -u patchiri -p --default-character-set=utf8mb4 patchiri < examples/mysql/setup.sql

cd examples/mysql
PATCHIRI_DB_PASSWORD=... node ../../packages/server-node/dist/src/main.js -c patchiri.config.json
```

画面と CLI の使い方は SQL Server と同じです。

## つなぐ先

```json
{ "dialect": "mysql", "host": "dbhost", "port": 3306, "database": "app", "user": "app" }
```

- `ssl` と `lockWaitSeconds` は [PostgreSQL](/databases/postgresql/#つなぐ先) と同じです。
- パスワードは設定ファイルに書かず、環境変数 `PATCHIRI_DB_PASSWORD` で渡せます。

## patchiri が合わせていること

- **テーブル名**: `` ` `` で囲んでも囲まなくてもかまいません。データベースを省くと `database` のものです。大文字小文字を区別するかは DB の設定（`lower_case_table_names`）次第です。
- **値が変わっていないか**: 既定の照合順序（utf8mb4_0900_ai_ci など）は「ボールペン」と「ﾎﾞｰﾙﾍﾟﾝ」、「ボ」と「ホ」も同じとみなします。patchiri は値をバイト列で比べるので、差分を取った後に半角に直された行や、濁点だけ直された行も「変わっていた」として止まります。キーは列の照合順序で探すので、`a001` でも `A001` の行に当たります。
- **桁と文字コード**: varchar(n) は文字数で数えます。cp932、sjis、utf8mb3 などの列は、その文字コードで表せない字（utf8mb3 に絵文字など）をエラーにします。反映は厳格な sql_mode で流すので、黙って切り詰められることはありません。
- **整数**: tinyint は -128〜127、unsigned は 0 からです。tinyint(1)（BOOLEAN）は整数のまま扱い、bit(1) を真偽にします。
- **出力する SQL**: mysql コマンド、MySQL Workbench、DBeaver、HeidiSQL などで流せる素の SQL です。先に全部の行をロックして確かめ、1 行でも合わなければどの行も変えません。結果は最後の行に出ます。途中でエラーが出たら、そこで止めて流し直してください（エラーを飛ばして続けると、COMMIT で一部の行だけ反映されます）。

## 扱えない型

timestamp（タイムゾーンで値が変わる）、year、set、json、binary / blob などは読めますが、更新できません。
