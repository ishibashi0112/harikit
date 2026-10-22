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
patchiri diff <file.xlsx|file.csv> --target <ターゲット> [--sheet <シート名>] [--header-row <行>] [--out <フォルダ>]
             [--encoding shift_jis] [--rules <業務ルールの JSON>] [--strict]
```

- `.xlsx` は 1 枚目のシート（`--sheet` で選べる）、CSV は UTF-8（`--encoding` で Shift_JIS なども）。
- 見出しは 1 行目。表題の行があるときは `--header-row 2` のように見出しの行を指します（Excel の行番号）。
- 業務ルールは、今のフォルダに `patchiri.rules.json` があれば読みます。別の場所は `--rules`。サーバに置いたルールがあれば、それに足して使います。
- `--strict` にすると、Excel の表示の形（`2024/4/1`、`¥1,200` など）を読み替えず、決まった形（`2024-04-01`、`1200`）だけを受けます。
- 結果は `patchiri-out/<ターゲット>-<日時>/` に出ます。

| ファイル | 中身 |
| --- | --- |
| `issues.csv` | 誤りのセルと理由（あれば） |
| `diff.csv` | 承認資料。行ごとに「変わる」「同じ」「キーなし」と、列ごとの前後の値 |
| `readings.csv` | Excel の表示の形から読み替えたセル（あれば） |
| `plan.json` | 反映計画。承認の後に `patchiri apply` に渡す。計画の指紋（`digest`）が入る |

計画の指紋は、計画の中身（`requestId` と反映する行）の SHA-256 です。出力の「指紋 …」（先頭 12 桁）を承認の記録（稟議など）に残しておくと、反映するときに同じ計画かを確かめられます。

## patchiri apply

```
patchiri apply <plan.json> [--execute] [--note <メモ>] [--digest <承認した計画の指紋>]
```

- 既定は `check`（DB は変えずに確かめる）。`--execute` で 1 トランザクションで反映します。
- 計画を作った後に `plan.json` が書き換えられていたら（指紋が合わなければ）、反映せずに止まります。`--digest` に承認の記録の指紋（先頭 8 桁以上）を渡すと、それとも突き合わせます。
- 差分を取った後に DB の値が変わっていたら、何も反映せずに止まり、変わっていた行を出します。
- `plan.json` の横に、結果（`result-check.json` か `result-execute.json`）、SQL（`check` なら実行する予定の `check.sql`、反映したら実行した `applied.sql`）、戻し SQL（`undo.sql`）が残ります。

## 共通のオプション

| オプション | 既定 |
| --- | --- |
| `--server <URL>` | `PATCHIRI_SERVER`、なければ `http://127.0.0.1:7357` |
| `--token <トークン>` | `PATCHIRI_TOKEN` |
| `--style rest\|webmethod` | `PATCHIRI_STYLE`、なければ `rest`。WebForms に載せたサーバは `webmethod`（例 `--server https://…/Admin/Patchiri.aspx --style webmethod`） |
| `--header "名前: 値"` | 呼び出しに足すヘッダ。何度でも書ける |
| `--json` | 結果を JSON で標準出力に出す（人向けの出力は標準エラーへ）。CI やほかのスクリプトから使うとき |
| `--config <ファイル>` | CLI の設定。省くと、今のフォルダの `patchiri.cli.json` があれば読む |

終了コードは、うまくいけば `0`、誤りや衝突で止めたら `1` です。

### patchiri.cli.json

毎回同じオプションを書かないための設定です。コマンドのオプションと環境変数のほうが優先します。`rules` と `out` は設定ファイルのフォルダから見た場所です。トークンは書けません（`PATCHIRI_TOKEN` で渡します）。

```json
{
  "server": "http://127.0.0.1:7357",
  "style": "rest",
  "headers": { "X-Request-From": "batch" },
  "rules": "rules/patchiri.rules.json",
  "headerRow": 1,
  "readDisplay": true,
  "out": "patchiri-out"
}
```

WebForms に載せたサーバは、載せ先のログイン（フォーム認証のクッキー、Windows 認証）を CLI から通せないので、CLI から呼べるのはログインなしで開ける開発環境だけです。業務では、載せたページを開いて出る画面を使ってください（[WebForms に載せる](/servers/webforms/)）。
