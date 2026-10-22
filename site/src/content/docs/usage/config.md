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

## 表示名、自動で入れる列、範囲、権限（どれも任意）

```json
"term": {
  "table": "dbo.M_Term",
  "access": "update",
  "key": ["TermCode"],
  "readable": ["TermCode", "StartDate", "EndDate", "UnitPrice"],
  "updatable": ["StartDate", "EndDate", "UnitPrice"],
  "labels": { "UnitPrice": "単価", "StartDate": "開始日" },
  "stamp": { "UpdatedAt": "now", "UpdatedBy": "user" },
  "scope": { "CompanyCode": "001" },
  "roles": ["MasterAdmin"]
}
```

| 項目 | 意味 |
| --- | --- |
| `labels` | 列の表示名。Excel や貼り付けの見出しは、列名でも表示名でもかまいません（大文字小文字は問いません）。画面の見出しにも出ます |
| `stamp` | 反映する行ごとに、サーバが自分で入れる列。`"now"` は DB の今の時刻（日付・時刻の列だけ）、`"user"` は反映した人の名前（文字列の列だけ）。キーの列と `updatable` の列には書けません。戻し SQL は、この列も反映する前の値に戻します |
| `scope` | このターゲットで触れる行の条件（等号だけ）。例の `CompanyCode = '001'` の外の行は、キーが同じでも見えず、変えられません。会社や拠点ごとにマスタを分けているテーブル向けです |
| `roles` | このターゲットを使えるロール（どれか 1 つ）。入っていない人には一覧に出ません。ロールの判定は [WebForms 版](/servers/webforms/#誰が反映したかとロール) なら載せ先のロール、[Node 版](/servers/node/#ほかのアプリに組み込む) なら差し込む関数です |

## サーバに置く業務ルール

[業務ルール](/usage/rules/) は、許可リストの `rules` にも書けます。中身そのものか、ファイルのパス（許可リストのファイルのフォルダから）です。

```json
{
  "targets": { "...": "..." },
  "rules": "patchiri.rules.json"
}
```

- 画面と CLI は、サーバのルールを外せないルールとして使い、手元のルール（`--rules` や画面で選ぶファイル）はその上に足します。
- 反映のときも、サーバが `"error"` のルールを、反映した後の行（DB の今の値に取込の値を重ねたもの）で見直します。合わなければ何も反映しません。手元のルールを外したクライアントからでも、ルールは破れません。
- `"warning"` のルールはサーバでは見ません（差分を見て人が判断するためのものです）。

## 画面の設定

Node 版サーバと WebForms のページが配る画面は、`screen` で見た目と決まりを変えられます。どれも任意です。

```json
"screen": {
  "title": "単価の一括更新",
  "theme": "light",
  "noteRequired": "依頼番号",
  "excel": true,
  "css": "patchiri.screen.css"
}
```

| 項目 | 意味 | 既定 |
| --- | --- | --- |
| `title` | 見出しとブラウザのタブの名前 | `patchiri` |
| `theme` | `"auto"`（OS に合わせる）、`"light"`、`"dark"` | `"auto"` |
| `noteRequired` | `true` か欄の名前（`"依頼番号"` など）にすると、メモを書かないと「DB で確かめる」「反映する」を押せません | 任意 |
| `excel` | 「Excel を開く」（.xlsx を読んで表に入れる）を出すか | 出す |
| `css` | 画面に足す CSS のファイル（設定ファイルのフォルダから）。色は `.pt-app { --pt-accent: #0b7a75; }` のように変数を上書きします | なし |

## そのほか

| 項目 | 意味 | 既定 |
| --- | --- | --- |
| `listen` | 待ち受け（Node 版） | `127.0.0.1:7357` |
| `database` | つなぐ先と方言。[SQL Server](/databases/sqlserver/)、[Oracle](/databases/oracle/)、[PostgreSQL](/databases/postgresql/)、[MySQL / MariaDB](/databases/mysql/) | （必須） |
| `limits` | 1 回に読めるキーの数、反映できる行の数 | 1000、5000 |
| `logDir` | 反映ログのフォルダ | `./patchiri-log` |
| `exposeDbErrors` | エラーの文に DB の生のエラー文を出すか | `false` |
| `lockWaitSeconds` | 反映で行のロックを待つ秒数。最上位にも `database` の中にも書けます | `10` |

パスワードは設定ファイルに書かず、環境変数 `PATCHIRI_DB_PASSWORD` で渡せます。

## DB のユーザーの権限

patchiri が使うログインには、`readable` の列の SELECT と、`updatable` の列だけの UPDATE を許すのがおすすめです（例 SQL Server の `GRANT UPDATE (列, …) ON 表`）。許可リストと DB の権限の両方で、更新できる列を絞れます。
