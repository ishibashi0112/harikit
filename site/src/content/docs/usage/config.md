---
title: 許可リストと設定
description: サーバがどのテーブルのどの列を読み書きしてよいか（patchiri.config.json）
---

サーバは、許可リストに載ったテーブルと列しか扱いません。画面や CLI は、テーブルを生の名前ではなく**ターゲット名**で指します。

```json
{
  "listen": { "host": "127.0.0.1", "port": 7357 },
  "database": {
    "dialect": "sqlserver",
    "server": "localhost",
    "database": "PatchiriSample",
    "user": "sa",
    "options": { "encrypt": false, "trustServerCertificate": true }
  },
  "targets": {
    "product": {
      "table": "dbo.M_Product",
      "access": "update",
      "key": ["ProductCode"],
      "readable": ["ProductCode", "ProductName", "CategoryCode", "UnitPrice", "ReleaseDate", "UpdatedAt"],
      "updatable": ["ProductName", "CategoryCode", "UnitPrice", "ReleaseDate"]
    },
    "category": {
      "table": "dbo.M_Category",
      "access": "read",
      "key": ["CategoryCode"],
      "readable": ["CategoryCode", "CategoryName"]
    }
  },
  "limits": { "maxFetchKeys": 1000, "maxApplyRows": 5000 },
  "logDir": "patchiri-log"
}
```

## targets

| 項目 | 意味 |
| --- | --- |
| `table` | テーブル名（スキーマ付きでよい） |
| `access` | `"update"`（更新できる）か `"read"`（読むだけ。外部キーの参照先など） |
| `key` | 行を探す列。省くと DB の主キー |
| `readable` | 読める列。キーの列も入れる |
| `updatable` | 更新できる列。`readable` の中から。キーの列、ID 列、計算列は更新できない |

外部キーの参照先も、読むだけのターゲットとして載せておくと、検証で「参照先にあるか」を確かめます。載っていなければ「参照先を確認できません」の警告になります。

## そのほか

| 項目 | 意味 | 既定 |
| --- | --- | --- |
| `listen` | 待ち受け（Node 版） | `127.0.0.1:7357` |
| `database` | つなぐ先と方言。[SQL Server](/databases/sqlserver/)、[Oracle](/databases/oracle/)、[PostgreSQL](/databases/postgresql/)、[MySQL / MariaDB](/databases/mysql/) | （必須） |
| `limits` | 1 回に読めるキーの数、反映できる行の数 | 1000、5000 |
| `logDir` | 反映ログのフォルダ | `./patchiri-log` |
| `exposeDbErrors` | エラーの文に DB の生のエラー文を出すか | `false` |

パスワードは設定ファイルに書かず、環境変数 `PATCHIRI_DB_PASSWORD` で渡せます。

## DB のユーザーの権限

patchiri が使うログインには、`readable` の列の SELECT と、`updatable` の列だけの UPDATE を許すのがおすすめです（例 SQL Server の `GRANT UPDATE (列, …) ON 表`）。許可リストと DB の権限の両方で、更新できる列を絞れます。
