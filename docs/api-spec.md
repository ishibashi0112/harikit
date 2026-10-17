# harikit サーバ API 仕様（v1 草案）

> 2026-10-17 草案。ブラウザ側コア（取込・検証・差分）と、DB に触るサーバの境目を決める。
> 範囲は「SQL Server、1テーブル、UPDATE だけ」。INSERT・DELETE・複数テーブルは後から足せる形にしてある（[10. 拡張の余地](#10-拡張の余地)）。

## 1. 全体の約束

- API は3本: **describe**（テーブル定義）、**fetch**（現在値）、**apply**（反映）。
- どれも `POST`、本文は JSON（`Content-Type: application/json; charset=utf-8`）。
- サーバは**許可リスト**（設定）に載ったテーブルと列しか扱わない。クライアントはテーブルを生の名前ではなく、許可リストの**ターゲット名**で指す。
- クライアントから SQL は一切送らない。SQL を組むのはサーバだけで、値は必ずパラメータで渡す。
- 変更前値の確認はサーバが反映のトランザクション内で行う。クライアントの差分は「承認資料」であって、安全の根拠ではない。
- データはクライアントとそのサーバの間だけを行き来する。外部送信はしない。

### 1.1 呼び出し方（2つのスタイル）

Node 版と WebForms の WebMethod 版で同じクライアントが使えるよう、包み方だけ2通り許す。クライアントは設定で切り替える。

| スタイル | URL の例 | 送る本文 | 返る本文 |
| --- | --- | --- | --- |
| `rest`（Node 版など） | `{baseUrl}/describe` | リクエスト JSON そのまま | レスポンス JSON そのまま |
| `webmethod`（ASP.NET） | `{baseUrl}/Describe`（例 `Harikit.aspx/Describe`） | `{"req": リクエスト}` | `{"d": レスポンス}` |

- WebMethod の引数名は `req` に固定する（`public static object Describe(Dictionary<string, object> req)` など）。
- クライアント設定の例: `{ baseUrl: "/Admin/Harikit.aspx", style: "webmethod" }`

### 1.2 バージョン

- すべてのリクエストに `"v": 1` を付ける。サーバは知らない版なら `version_unsupported` を返す。
- 項目の追加は版を上げずに行う。クライアントもサーバも**知らない項目は無視する**。

### 1.3 値の書き方（JSON と DB 型の対応）

.NET Framework の `JavaScriptSerializer` と JS の数値で精度や日付が崩れないよう、迷う型は文字列で送る。

| 正規化した型 `type` | SQL Server の例 | JSON での値 |
| --- | --- | --- |
| `string` | char, varchar, nchar, nvarchar, text | 文字列 |
| `integer` | tinyint, smallint, int | 数値 |
| `bigint` | bigint | **文字列**（`"9007199254740993"`） |
| `decimal` | decimal, numeric, money | **文字列**（`"1234.50"`） |
| `float` | real, float | 数値 |
| `boolean` | bit | `true` / `false` |
| `date` | date | `"2026-10-17"` |
| `datetime` | datetime, datetime2, smalldatetime | `"2026-10-17T09:30:00.123"`（タイムゾーンなし） |
| `time` | time | `"09:30:00"` |
| `other` | binary, xml, uniqueidentifier など | v1 では更新対象外（describe には出す） |

- SQL の NULL は JSON の `null`。空文字 `""` とは区別する。
- 入力の揺れ（全角半角、前後空白）を直すかどうかはコア側の話で、サーバは受け取った値をそのまま使う。

### 1.4 認証と CSRF

- **認証と認可は載せ先のアプリに任せる。** WebForms ならフォーム認証やセッションをそのまま使い、ログインしていない・権限がないときは載せ先の流儀で 401/403 を返す。harikit 自体はユーザー管理を持たない。
- サーバは「誰が反映したか」を自分で判定して記録する（クライアントが名乗る名前は信じない）。
- CSRF 対策として、すべての呼び出しに `X-Harikit: 1` ヘッダを必須にする。`application/json` 必須と合わせ、他サイトのフォームからは呼べない。
- Node 版をローカル（`127.0.0.1`）で立てるときは、起動時に乱数トークンを表示し、`Authorization: Bearer <token>` を必須にする。同じ PC の別タブのページから叩かれないため。

### 1.5 結果とエラーの返し方

- **業務上の結果はすべて HTTP 200** で返し、本文の `ok` で成否を表す。WebMethod は例外を投げると 500 で中身が読みにくいので、例外は捕まえてこの形に直す。
- HTTP 200 以外は「届かなかった」場合だけ: 401/403（載せ先の認証）、404、413（大きすぎ）、5xx（サーバが落ちた）。

成功:
```json
{ "ok": true, "v": 1, ... }
```

失敗:
```json
{
  "ok": false,
  "v": 1,
  "error": {
    "code": "column_not_allowed",
    "message": "列 UnitPrice2 は更新が許可されていません",
    "details": { "column": "UnitPrice2" }
  }
}
```

- `code` はクライアントが分岐に使う固定の文字列。`message` は人向けで、日本語でよい。
- 行ごとの問題は `error` ではなく、各 API の行単位の結果（`rowErrors`、`conflicts`）で返す。
- DB の生のエラー文には接続先や SQL が混じりうるので、`db_error` の `message` に出すかはサーバ設定で切り替える（既定は出さず、サーバのログにだけ残す）。

共通のエラーコード:

| code | 意味 |
| --- | --- |
| `bad_request` | JSON の形が違う、必須項目がない |
| `version_unsupported` | `v` が知らない版 |
| `unknown_target` | 許可リストにないターゲット |
| `column_not_allowed` | 許可されていない列を読もう・更新しようとした |
| `key_mismatch` | キーの列がターゲットのキー列と一致しない |
| `too_many_rows` | 1回の上限（`limits`）を超えた |
| `conflict` | 変更前値が変わっていたので止めた（apply のみ、[7](#7-apply反映)） |
| `db_error` | DB がエラーを返した |
| `internal_error` | それ以外のサーバ側の失敗 |

## 2. 許可リスト（サーバ側の設定）

サーバだけが持つ設定。クライアントからは変えられない。形は実装ごとに自由（JSON、web.config など）だが、持つ情報は次のとおり。

```json
{
  "targets": {
    "product": {
      "table": "dbo.M_Product",
      "access": "update",
      "key": ["ProductCode"],
      "readable": ["ProductCode", "ProductName", "CategoryCode", "UnitPrice", "UpdatedAt"],
      "updatable": ["ProductName", "CategoryCode", "UnitPrice"]
    },
    "category": {
      "table": "dbo.M_Category",
      "access": "read",
      "key": ["CategoryCode"],
      "readable": ["CategoryCode", "CategoryName"]
    }
  },
  "limits": { "maxFetchKeys": 1000, "maxApplyRows": 5000 }
}
```

- `access: "read"` は外部キーの存在確認用など、読むだけのターゲット。
- `key` は主キー（または一意キー）の列。指定がなければ DB の主キーを使う。
- `updatable` は `readable` の部分集合。キー列は更新できない（v1）。
- 「更新日時」や「更新者」を自動で入れたい場合のために、将来 `stamp` 設定を足す余地を残す（v1 では持たない）。

## 3. describe（テーブル定義）

### リクエスト
```json
{ "v": 1, "target": "product" }
```
- `target` を省くと、使えるターゲットの一覧だけを返す（UI のテーブル選択用）。

### レスポンス（target 指定）
```json
{
  "ok": true,
  "v": 1,
  "target": "product",
  "table": "dbo.M_Product",
  "access": "update",
  "dialect": "sqlserver",
  "key": ["ProductCode"],
  "columns": [
    {
      "name": "ProductCode",
      "type": "string",
      "dbType": "varchar(10)",
      "maxLength": 10,
      "nullable": false,
      "updatable": false
    },
    {
      "name": "ProductName",
      "type": "string",
      "dbType": "nvarchar(50)",
      "maxLength": 50,
      "nullable": false,
      "updatable": true
    },
    {
      "name": "UnitPrice",
      "type": "decimal",
      "dbType": "decimal(9,2)",
      "precision": 9,
      "scale": 2,
      "nullable": true,
      "updatable": true
    },
    {
      "name": "CategoryCode",
      "type": "string",
      "dbType": "varchar(4)",
      "maxLength": 4,
      "nullable": false,
      "updatable": true
    }
  ],
  "foreignKeys": [
    {
      "name": "FK_M_Product_Category",
      "columns": ["CategoryCode"],
      "referencedTable": "dbo.M_Category",
      "referencedColumns": ["CategoryCode"],
      "referencedTarget": "category"
    }
  ],
  "limits": { "maxFetchKeys": 1000, "maxApplyRows": 5000 }
}
```

- `columns` は `readable` に載った列だけ。並びは DB の列順。
- 列の項目: `name`, `type`（[1.3](#13-値の書き方json-と-db-型の対応)）, `dbType`（表示用の生の型）, `nullable`, `updatable` は必須。`maxLength`（文字数。`max` は `-1`）, `precision`, `scale`, `identity`, `computed`, `hasDefault` は当てはまるときだけ。
- `foreignKeys[].referencedTarget` は、参照先が許可リストに読めるターゲットとして載っていればその名前、なければ `null`。`null` のときコアは存在確認を飛ばし、「確認できない」と警告を出す。
- 業務ルール（価格は0より大きい等）は describe に含めない。コア側の設定で持つ。

### レスポンス（target 省略）
```json
{
  "ok": true,
  "v": 1,
  "targets": [
    { "target": "product", "table": "dbo.M_Product", "access": "update" },
    { "target": "category", "table": "dbo.M_Category", "access": "read" }
  ]
}
```

## 4. fetch（現在値）

差分づくりと、外部キーの存在確認の両方に使う。

### リクエスト
```json
{
  "v": 1,
  "target": "product",
  "keys": [
    { "ProductCode": "A001" },
    { "ProductCode": "A002" },
    { "ProductCode": "Z999" }
  ],
  "columns": ["ProductName", "UnitPrice", "CategoryCode"]
}
```
- `keys` の各要素は、キー列ちょうどを持つオブジェクト（複合キーにもそのまま対応）。足りない・余計な列は `key_mismatch`。
- `columns` は `readable` の中から。省くと `readable` 全部。キー列は常に返るので書かなくてよい。
- `keys` が `limits.maxFetchKeys` を超えたら `too_many_rows`。コアが分けて呼ぶ。
- 同じキーが2回あっても受け付け、両方に同じ結果を返す（重複の指摘はコアの検証の仕事）。

### レスポンス
```json
{
  "ok": true,
  "v": 1,
  "target": "product",
  "rows": [
    { "index": 0, "found": true,  "values": { "ProductCode": "A001", "ProductName": "ボールペン黒", "UnitPrice": "120.00", "CategoryCode": "C01" } },
    { "index": 1, "found": true,  "values": { "ProductCode": "A002", "ProductName": "ボールペン赤", "UnitPrice": null,     "CategoryCode": "C01" } },
    { "index": 2, "found": false }
  ]
}
```
- `rows` はリクエストの `keys` と同じ順・同じ数。`index` はその位置。
- キーの照合は DB の比較規則（照合順序）に従う。大文字小文字や末尾空白の扱いは DB 次第で、サーバは揃えない。
- 外部キーの存在確認は、参照先ターゲットに対してキーだけで fetch し、`found` を見る。

## 5. 差分（コアの仕事、参考）

サーバ API ではないが、apply の入力を作るところなので書いておく。

- コアは fetch の結果と取込データを比べ、行を「変わる」「同じ値」「キーが見つからない」に分ける。
- 「変わる」行の、**変わる列だけ**を apply に送る。変わらない列は送らない（他の人の更新とぶつかる範囲を最小にするため）。
- 比較は [1.3](#13-値の書き方json-と-db-型の対応) の型で行う（`decimal` は `"120"` と `"120.00"` を同じとみなす、など）。

## 6. 承認との関係

- サーバは承認を管理しない（ツールの外でよい、の前提）。
- コアは apply の前に、送る内容の要約（行数、列、差分ファイルの指紋）を作れる。将来、承認者のサインや承認番号を `apply` の `note` に載せて記録に残す使い方を想定する。

## 7. apply（反映）

### リクエスト
```json
{
  "v": 1,
  "requestId": "6f1c2a8e-3b0d-4e7a-9c55-1d2e3f4a5b6c",
  "mode": "execute",
  "note": "依頼 2026-10-17 価格改定（承認 #123）",
  "changes": [
    {
      "target": "product",
      "rows": [
        {
          "op": "update",
          "key": { "ProductCode": "A001" },
          "before": { "UnitPrice": "120.00" },
          "after":  { "UnitPrice": "130.00" }
        },
        {
          "op": "update",
          "key": { "ProductCode": "A002" },
          "before": { "UnitPrice": null, "ProductName": "ボールペン赤" },
          "after":  { "UnitPrice": "130.00", "ProductName": "ボールペン（赤）" }
        }
      ]
    }
  ]
}
```

- `requestId`: クライアントが作る UUID。必須。サーバはログに残し、同じ `requestId` で一度成功していれば再実行せず前回の結果を返してよい（二度押し・通信切れの再送対策。v1 では「してよい」）。
- `mode`:
  - `"check"`: DB は変えない。許可リストの照合と、今の値が `before` と一致するかの確認だけ行い、実行予定の SQL（人が読む用）を返す。資料の「SQL だけ出力するモード」はこれ。
  - `"execute"`: 実際に反映する。
- `note`: 任意。ログに残す人向けのメモ（依頼番号、承認番号など）。
- `changes`: v1 では**要素ちょうど1つ**（1テーブル）。複数テーブルへ広げるときの入れ物として今から配列にしてある。
- `rows[].op`: v1 は `"update"` だけ。省略時も `"update"`。
- `before` と `after` は**同じ列の集まり**で、どちらも `updatable` の列だけ。`before == after` の列が混じっていたら `bad_request`（差分を取り違えている）。
- 行数が `limits.maxApplyRows` を超えたら `too_many_rows`。1トランザクションの約束を守るため、コアは**勝手に分割しない**（分けるかは人が決める）。
- 同じキーの行が2つあったら `bad_request`。

### サーバの処理（実装が守ること）

1. ターゲット・列・キーを許可リストで照合する。違えばすぐ失敗（DB に触らない）。
2. トランザクションを開始する。
3. 対象行を更新ロックを掛けて読む（SQL Server なら `WITH (UPDLOCK, HOLDLOCK)`）。キーごとに、
   - 行がない → 衝突（`reason: "not_found"`）
   - `before` の列のどれかが今の値と違う → 衝突（`reason: "changed"`）。比較は NULL 同士を一致とみなし、それ以外は DB の比較規則で行う。
4. 衝突が1行でもあれば**全体をロールバック**し、衝突した行を全部返す（v1 は全部か無しか）。
5. 衝突がなければ、行ごとにパラメータ付き UPDATE を流す。
   ```sql
   UPDATE [dbo].[M_Product]
      SET [UnitPrice] = @p1
    WHERE [ProductCode] = @k1
   ```
   テーブル名と列名は許可リストの値から組み、`[]` で囲む（クライアントの文字列を名前に使わない）。影響行数が1でなければ全体をロールバックして `db_error`。
6. コミットする。`check` のときは手順 3〜4 の後でロールバックして終わる（手順 5 は流さず、SQL を組むだけ）。
7. サーバ側のログに、誰が・いつ・`requestId`・`note`・行ごとの前後の値を残す（ファイルでよい。履歴テーブルはオプション）。

### レスポンス（成功）
```json
{
  "ok": true,
  "v": 1,
  "requestId": "6f1c2a8e-3b0d-4e7a-9c55-1d2e3f4a5b6c",
  "mode": "execute",
  "appliedAt": "2026-10-17T10:15:02.481",
  "appliedBy": "CONTOSO\\sakakibara",
  "results": [
    { "target": "product", "updated": 2 }
  ],
  "script": "-- harikit 6f1c2a8e... product 2行\nUPDATE [dbo].[M_Product] SET [UnitPrice] = 130.00 WHERE [ProductCode] = 'A001' AND [UnitPrice] = 120.00;\n...",
  "undoScript": "-- harikit 6f1c2a8e... の戻し\nUPDATE [dbo].[M_Product] SET [UnitPrice] = 120.00 WHERE [ProductCode] = 'A001' AND [UnitPrice] = 130.00;\n..."
}
```

- `script`: 実行した（`check` なら実行する予定の）内容を、値を埋め込んだ人が読める SQL にしたもの。承認資料やエビデンスにそのまま貼れる。実際の実行はパラメータで行い、この文字列は使わない。
- `undoScript`: 戻し用 SQL。「今の値が harikit で入れた値のままなら戻す」形（`WHERE` に `after` の値を条件として入れる）にし、後から入った別の更新は上書きしない。`check` のときも返す。
- `script` と `undoScript` は方言ごとの書き方（引用、日付リテラル、NULL 比較）を知っているサーバが作る。コアはそれをファイルに保存する。
- `appliedBy` はサーバが認証から判定した名前。

### レスポンス（衝突で止めた）
```json
{
  "ok": false,
  "v": 1,
  "requestId": "6f1c2a8e-3b0d-4e7a-9c55-1d2e3f4a5b6c",
  "mode": "execute",
  "error": { "code": "conflict", "message": "1行が差分を取った後に変わっていたため、何も反映していません" },
  "conflicts": [
    {
      "target": "product",
      "index": 1,
      "key": { "ProductCode": "A002" },
      "reason": "changed",
      "columns": ["UnitPrice"],
      "current": { "UnitPrice": "125.00", "ProductName": "ボールペン赤" }
    }
  ]
}
```
- `index` は `rows` の中の位置。`current` は `before` に書かれた列の今の値（`not_found` のときは無し）。
- コアはこれを見て差分を取り直し、もう一度承認に回す。

### 行単位の形の誤り

許可リストの照合で行ごとに見つかった誤りは、まとめて返す（1件目で止めない）。DB には触っていない。
```json
{
  "ok": false,
  "v": 1,
  "error": { "code": "bad_request", "message": "2行に誤りがあります" },
  "rowErrors": [
    { "target": "product", "index": 0, "code": "column_not_allowed", "column": "UnitPrice2" },
    { "target": "product", "index": 3, "code": "key_mismatch" }
  ]
}
```

## 8. 実装メモ

### Node 版
- 依存は DB ドライバ（SQL Server は `mssql`）だけを目安に。HTTP は標準の `http` で足りる。
- 既定で `127.0.0.1` にだけ待ち受け、起動時にトークンを出す（[1.4](#14-認証と-csrf)）。`appliedBy` は OS のユーザー名。
- `decimal` / `bigint` はドライバから文字列で受けて文字列で返す。

### C#（.NET Framework、WebForms）版
- 1つの `.aspx`（例 `Harikit.aspx`）に `[WebMethod]` を3つ置く: `Describe`、`Fetch`、`Apply`。引数は `Dictionary<string, object> req`、戻り値は `Dictionary<string, object>`（`{"d": ...}` は ASP.NET が付ける）。
- 例外は WebMethod の中で捕まえて `ok:false` に直す（[1.5](#15-結果とエラーの返し方)）。
- `JavaScriptSerializer` の既定の上限（約 2MB）では足りないことがあるので、`web.config` の `jsonSerialization maxJsonLength` を上げる手順を README に書く。
- 日付は `DateTime` をそのまま返すと `"\/Date(...)\/"` になるので、必ず [1.3](#13-値の書き方json-と-db-型の対応) の文字列に変換して返す。`decimal` も文字列で返す。
- 実行は `SqlTransaction` と `SqlParameter`。`appliedBy` は `HttpContext.Current.User.Identity.Name`。
- 権限チェックは載せ先の仕組み（`web.config` の `<authorization>`、ロール判定など）に任せる。

### 適合テスト
- 仕様どおりかを確かめるテスト一式（リクエストと期待するレスポンスの JSON の組）をリポジトリに置き、Node 版・C# 版の両方に同じものを流す。他の言語で作る人もこれで確かめられる。

## 9. この草案で選んだ既定（変えたければここ）

| 項目 | 選んだもの | 理由 |
| --- | --- | --- |
| テーブルの指し方 | 許可リストのターゲット名 | 生のテーブル名を受けないほうが安全 |
| エラー | 業務の結果は HTTP 200 + `ok` | WebMethod の例外の扱いにくさを避ける |
| 認証 | 載せ先アプリに任せる（ローカル Node 版だけトークン） | 既存の権限の仕組みをそのまま使える |
| 衝突時 | 全部ロールバック | 「1トランザクション」の約束どおり |
| 送る列 | 変わる列だけ | 他の更新とぶつかる範囲を最小に |
| SQL 出力・戻し SQL | サーバが作る | 方言の書き方をサーバが知っている |
| 数値の精度 | `decimal` / `bigint` は文字列 | JS と .NET の両方で崩れない |

## 10. 拡張の余地

- **INSERT / DELETE**: `rows[].op` に `"insert"`（`after` だけ）、`"delete"`（`before` だけ、全列一致で消す）を足す。許可リストに `insertable` / `deletable` を足す。
- **複数テーブル**: `changes` に複数のターゲットを並べ、まとめて1トランザクションにする。並び順＝実行順（親→子）。
- **一部だけ反映**: `onConflict: "skipRow"` を足す（既定は今のまま全部止める）。
- **Oracle など**: `dialect` を増やす。API の形は変えない。
- **自動で入れる列**: 許可リストに `stamp`（例 `UpdatedAt = 現在時刻`、`UpdatedBy = 実行者`）を足し、サーバが UPDATE に加える。
