---
title: 業務ルール
description: DB の定義ではわからない決まりを patchiri.rules.json に書く
---

桁や NOT NULL、型、外部キーは DB の定義から自動で確かめるので、書かなくてかまいません。それではわからない決まりを `patchiri.rules.json` に書きます。画面では「業務ルール」の「ファイルを選ぶ」で、CLI では今のフォルダに置くか `--rules` で読みます。

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

文字列の桁は DB の定義に合わせて数えます。SQL Server の varchar は列の照合順序の文字コードでバイト数を数え、その文字コードで表せない字（Latin1 の列に日本語など）もエラーにします。
