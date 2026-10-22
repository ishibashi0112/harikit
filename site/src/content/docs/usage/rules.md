---
title: 業務ルール
description: DB の定義ではわからない決まりを patchiri.rules.json に書く
---

桁や NOT NULL、型、外部キーは DB の定義から自動で確かめるので、書かなくてかまいません。それではわからない決まりを `patchiri.rules.json` に書きます。画面では「業務ルール」の「ファイルを選ぶ」で、CLI では今のフォルダに置くか `--rules` で読みます。

同じ形のルールは、サーバの許可リストにも置けます。そのときは画面でも CLI でも外せず、反映のときにもサーバが見直します（[サーバに置く業務ルール](/usage/config/#サーバに置く業務ルール)）。

```json
{
  "targets": {
    "product": [
      { "column": "UnitPrice", "greaterThan": 0, "message": "価格は 0 より大きくしてください" },
      { "column": "UnitPrice", "maxChangePercent": 50, "severity": "warning" },
      { "column": "ProductCode", "pattern": "^[A-Z][0-9]{3}$" }
    ]
  }
}
```

`targets` の下に、許可リストのターゲット名ごとにルールを並べます。

| 項目 | 意味 |
| --- | --- |
| `column` | 列名 |
| `required` | 空を許さない（DB では NULL を許す列でも） |
| `min` / `max` | 以上 / 以下（数値と日付の列） |
| `greaterThan` / `lessThan` | より大きい / より小さい（数値と日付の列） |
| `pattern` | 文字列が合うべき正規表現 |
| `oneOf` | 使ってよい値の一覧 |
| `maxChangePercent` | DB の今の値からの変動の上限（%、数値の列） |
| `severity` | `"error"`（既定。差分を作らない）か `"warning"`（差分は作り、問題の一覧に残す） |
| `message` | 合わないときに出す文 |
| `when` | この条件に合う行だけに当てる（下の「行のルール」） |

## 行のルール

ほかの列の値も見る決まりは、境界に `{ "column": "列名" }` を書くか、`when` を付けます。

```json
{
  "targets": {
    "term": [
      { "column": "EndDate", "min": { "column": "StartDate" }, "message": "終了日は開始日より後にしてください" },
      { "column": "UnitPrice", "max": 0, "when": { "column": "Kind", "equals": "9" } },
      { "column": "Qty", "required": true, "when": { "column": "Kind", "oneOf": ["1", "2"] } }
    ]
  }
}
```

- 境界の `{ "column": … }` は、同じ行のその列の値と比べます。比べられるのは数どうしか、同じ型の日付・時刻の列です。相手の列が空なら、その境界は見ません。
- `when` は `column` と、`equals`（その値のとき）、`oneOf`（どれかのとき）、`empty`（`true` なら空のとき、`false` なら空でないとき）のどれか 1 つ。
- 取込にない列を見るルールは、差分を作るときに DB の今の値で見ます（開始日だけを貼ったら、DB の終了日と比べる）。貼った列にかかわらないルールは見ません。

文字列の桁は DB の定義に合わせて数えます。SQL Server の varchar は列の照合順序の文字コードでバイト数を数え、その文字コードで表せない字（Latin1 の列に日本語など）もエラーにします。
