# patchiri-core

patchiri のコア。取込（Excel / CSV / 2 次元配列）、検証（DB の定義と業務ルール）、差分、反映計画、サーバ API のクライアント。ブラウザでも Node でも動く（Node の API は使わない）。画面（`patchiri-web`）と CLI（`patchiri`）はこの上に載っている。自前の画面やバッチを作るときは、ここから組み立てる。

```sh
npm install patchiri-core
```

## いちばん短い使い方

```ts
import { PatchiriClient, prepare, readXlsx, buildApplyRequest } from "patchiri-core";

const client = new PatchiriClient({ baseUrl: "/Admin/Patchiri.aspx", style: "webmethod" });
const [sheet] = await readXlsx(await file.arrayBuffer());
const result = await prepare(client, "product", sheet!, { rules });
if (!result.ok) {
  for (const i of result.issues) console.log(i.cell ?? "", i.code, i.message);
} else {
  // result.diff が承認資料。承認されたら反映する。
  const res = await client.apply(buildApplyRequest(result.diff!, { mode: "execute", note: "4 月の価格改定" }));
}
```

`prepare` は describe → 検証 → 参照先（外部キー）の確認 → fetch → 差分 を通す。1 つずつ呼びたいときは下の関数を使う。

## 取込

| 関数 | |
| --- | --- |
| `readXlsx(data)` | `.xlsx` のシートを全部読む（`Sheet[]`）。日付のセルは `{ kind: "date" }`、エラー値は `{ kind: "error" }` |
| `readCsv(data, encoding?, name?)` / `parseCsv(text, name?)` | CSV（`encoding` は `TextDecoder` の名前。`shift_jis` など） |
| `Sheet` | `{ name, cells }`。`cells` は `Cell[][]`（文字列、数、真偽、日付、エラー、null）。貼り付けた表はそのまま `cells` にすればよい |

## 検証

`validate(description, sheet, options)` は見出しの行で列を決め、全行を DB の定義（型、桁、バイト数、NOT NULL、キー）と業務ルールで見る。

| options | |
| --- | --- |
| `headerRow` | 見出しの行（0 始まり）。既定は 0 |
| `rules` | `compileRules` で作った業務ルール |
| `aliases` | 見出しの別名（`{ "単価": "UnitPrice" }`）。見出しは列名、describe の表示名（`label`）、別名の順に探す。大文字小文字は問わない |
| `readDisplay` | `false` にすると Excel の表示の形（`2024/4/1`、`¥1,200` など）を読み替えず、決まった形（`2024-04-01`、`1200`）だけを受ける。既定は `true` |
| `checkRow` | 行ごとの自前の確かめ。`({ row, key, values, columnIndex }) => [{ message, column?, severity?, code? }]` |

`prepare` の options も同じものを受ける（`rules` だけは `patchiri.rules.json` の中身をそのまま渡す）。

### 問題（Issue）

`{ severity, code, message, params?, row?, col?, cell?, column? }`。`code` で種類が分かるので、文を差し替えたり、種類ごとに扱いを変えたりできる。

| code | |
| --- | --- |
| `unknown_column` / `duplicate_column` / `column_not_updatable` / `missing_key_column` / `no_update_columns` | 見出しの誤り |
| `invalid_value` | 型・桁・バイト数・NOT NULL に合わない |
| `key_empty` / `duplicate_key` | キーが空、同じキーが 2 回（`params.firstRow`） |
| `same_db_row` | 照合順序で同じ行になるキーが 2 回（`params.otherRow`） |
| `whitespace` | 文字列の前後の空白（警告） |
| `rule_violation` / `rules_invalid` | 業務ルールに合わない、ルールの書き方の誤り |
| `reference_missing` / `reference_unchecked` | 参照先（外部キー）に無い、確かめられなかった |
| `encoding_unknown` | 文字コードのバイト数を数えられない |
| `custom` | `checkRow` が返したもの（`code` を書けばそれ） |

## 業務ルール

| 関数 | |
| --- | --- |
| `compileRules(description, rules, source?)` | ルールの配列（1 ターゲットの分）を確かめて使える形にする。誤りは `rules_invalid` の問題で返す |
| `compileTargetRules(description, rulesConfig)` | サーバに置いたルール（describe の `rules`）と、手元の `patchiri.rules.json` のこのターゲットの分を合わせる。サーバのルールが先で、外せない |
| `checkRule(rule, value, row?)` / `checkRuleRow(rule, row)` / `checkChange(rule, before, after, row?)` | 1 つの値・1 行・変更を見る。合わなければ文、合えば null |
| `isRowRule(rule)` | ほかの列も見るルール（境界の `{ column }` か `when`）か |
| `ruleColumnsToFetch(rules, validation)` | 取込に無い列を見るルールのために、fetch で読む列 |

書き方はドキュメントの「[業務ルール](https://patchiri.vercel.app/usage/rules/)」。

## 差分と反映計画

| 関数 | |
| --- | --- |
| `fetchAll(client, description, keys, columns?)` | キーを上限ごとに分けて fetch する |
| `checkReferences(client, description, validation)` | 参照先（外部キー）を fetch で確かめる |
| `diff(description, validation, fetched, { rules })` | 「変わる」「同じ」「キーが見つからない」に分ける。変動率のルールと、取込に無い列を見るルールはここで見る |
| `buildApplyRequest(diff, { mode, note?, requestId? })` | apply のリクエスト（変わる列だけ） |
| `buildPlan(diff, source, options?)` | 反映計画（`plan.json`）。指紋 `digest` を入れる |
| `planDigest(request)` / `verifyPlan(plan)` | 計画の指紋（`requestId` と `changes` の SHA-256）。`verifyPlan` は合えば true、合わなければ false、指紋の無い計画は null |
| `diffToCsv` / `issuesToCsv` / `readingsToCsv` | 差分・問題・読み替えの CSV（UTF-8 BOM 付き、Excel でそのまま開ける） |

## サーバとのつなぎ

`PatchiriApi` は API 3 本の呼び口（`targets()`、`describe(target)`、`fetch(req)`、`apply(req)`）。`prepare` などはこの形だけを使うので、HTTP を通さないつなぎ（同じプロセスの Handlers、テスト用の偽物など）も渡せる。describe と fetch は `ok: false` を例外（`PatchiriApiError`）にし、apply は `ok: false` をそのまま返す。

`PatchiriClient` は HTTP の実装。

| options | |
| --- | --- |
| `baseUrl` | rest なら `http://127.0.0.1:7357`、webmethod なら `/Admin/Patchiri.aspx` など |
| `style` | `"rest"`（既定）か `"webmethod"` |
| `token` | Node 版サーバのトークン |
| `headers` | 足すヘッダ |
| `fetch` | `fetch` の差し替え（ブラウザの中の DB につなぐデモはこれを使っている） |

HTTP のエラーと、JSON でない応答（ログインの画面に回されたときなど）は `PatchiriHttpError`。

## 値の形

DB に送る値は文字列・数・真偽・null。日付は `2024-04-01`、日時は `2024-04-01T09:30:00`、時刻は `09:30:00`、decimal は文字列（`"1200.00"`）。決まりは [docs/api-spec.md](../../docs/api-spec.md) の 1.3。`checkValue(column, value)`、`canonical(type, value)`、`sameColumnValue(column, a, b)` で確かめたり比べたりできる。
