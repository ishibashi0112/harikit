---
title: CLI で使う
description: Excel や CSV を取り込んで、差分と反映計画を作り、反映する
---

CLI はサーバの API を呼ぶ道具です。サーバ（Node 版など）を先に起動しておきます。

```sh
export PATCHIRI_TOKEN=<サーバの起動時に出たトークン>
H=packages/cli/dist/src/main.js

node $H targets                                  # 使えるターゲットの一覧
node $H diff price-update.xlsx -t product        # 検証して、差分と反映計画を作る
node $H apply patchiri-out/product-…/plan.json            # DB は変えずに確かめる（check）
node $H apply patchiri-out/product-…/plan.json --execute  # 反映する
```

## patchiri diff

```
patchiri diff <file.xlsx|file.csv> --target <ターゲット> [--sheet <シート名>] [--out <フォルダ>]
             [--encoding shift_jis] [--rules <業務ルールの JSON>]
```

- `.xlsx` は 1 枚目のシート（`--sheet` で選べる）、CSV は UTF-8（`--encoding` で Shift_JIS なども）。
- 業務ルールは、今のフォルダに `patchiri.rules.json` があれば読みます。別の場所は `--rules`。
- 結果は `patchiri-out/<ターゲット>-<日時>/` に出ます。

| ファイル | 中身 |
| --- | --- |
| `issues.csv` | 誤りのセルと理由（あれば） |
| `diff.csv` | 承認資料。行ごとに「変わる」「同じ」「キーなし」と、列ごとの前後の値 |
| `readings.csv` | Excel の表示の形から読み替えたセル（あれば） |
| `plan.json` | 反映計画。承認の後に `patchiri apply` に渡す |

## patchiri apply

```
patchiri apply <plan.json> [--execute] [--note <メモ>]
```

- 既定は `check`（DB は変えずに確かめる）。`--execute` で 1 トランザクションで反映します。
- 差分を取った後に DB の値が変わっていたら、何も反映せずに止まり、変わっていた行を出します。
- `plan.json` の横に、結果（`result-check.json` か `result-execute.json`）、SQL（`check` なら実行する予定の `check.sql`、反映したら実行した `applied.sql`）、戻し SQL（`undo.sql`）が残ります。

## 共通のオプション

| オプション | 既定 |
| --- | --- |
| `--server <URL>` | `PATCHIRI_SERVER`、なければ `http://127.0.0.1:7357` |
| `--token <トークン>` | `PATCHIRI_TOKEN` |
| `--style rest\|webmethod` | `rest`。WebForms に載せたサーバは `webmethod`（例 `--server https://…/Admin/Patchiri.aspx --style webmethod`） |

WebForms に載せたサーバは、載せ先のログイン（フォーム認証のクッキー、Windows 認証）を CLI から通せないので、CLI から呼べるのはログインなしで開ける開発環境だけです。業務では、載せたページを開いて出る画面を使ってください（[WebForms に載せる](/servers/webforms/)）。
