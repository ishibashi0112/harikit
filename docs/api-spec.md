# harikit サーバ API 仕様（v1 草案）

> 2026-10-17 草案。ブラウザ側コア（取込・検証・差分）と、DB に触るサーバの境目を決める。
> 範囲は「SQL Server と Oracle、1テーブル、UPDATE だけ」。INSERT・DELETE・複数テーブルは後から足せる形にしてある（[10. 拡張の余地](#10-拡張の余地)）。

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

| 正規化した型 `type` | SQL Server の例 | Oracle の例 | JSON での値 |
| --- | --- | --- | --- |
| `string` | char, varchar, nchar, nvarchar, text | VARCHAR2, CHAR, NVARCHAR2, NCHAR | 文字列 |
| `integer` | tinyint, smallint, int | （使わない。NUMBER(p,0) は JS の数値に収まるとは限らない） | 数値 |
| `bigint` | bigint | （使わない） | **文字列**（`"9007199254740993"`） |
| `decimal` | decimal, numeric, money | NUMBER, NUMBER(p,s), INTEGER, FLOAT(p) | **文字列**（`"1234.50"`） |
| `float` | real, float | BINARY_FLOAT, BINARY_DOUBLE | 数値 |
| `boolean` | bit | BOOLEAN（23ai 以降） | `true` / `false` |
| `date` | date | （使わない。Oracle の DATE は時刻を持つ） | `"2026-10-17"` |
| `datetime` | datetime, datetime2, smalldatetime | DATE（`scale: 0`）, TIMESTAMP(n) | `"2026-10-17T09:30:00.123"`（タイムゾーンなし。秒の小数は 0〜9 桁で、上限は `scale`） |
| `time` | time | （使わない） | `"09:30:00"` |
| `other` | binary, xml, uniqueidentifier など | 負の scale の NUMBER, TIMESTAMP WITH (LOCAL) TIME ZONE, INTERVAL, RAW, CLOB / BLOB, ROWID など | v1 では更新対象外（describe には出す） |

- SQL の NULL は JSON の `null`。空文字 `""` とは区別する。ただし Oracle のように空文字を NULL として保存する DB では、describe の `emptyIsNull` で知らせる（[3](#3-describeテーブル定義)）。
- NUMBER(5,-2) のような負の scale は入れた値が丸められ、戻し SQL の条件が合わなくなるので `other` にする。
- 入力の揺れ（全角半角、前後空白）を直すかどうかはコア側の話で、サーバは受け取った値をそのまま使う。

### 1.4 認証と CSRF

- **認証と認可は載せ先のアプリに任せる。** WebForms ならフォーム認証やセッションをそのまま使い、ログインしていない・権限がないときは載せ先の流儀で 401/403 を返す。harikit 自体はユーザー管理を持たない。
- サーバは「誰が反映したか」を自分で判定して記録する（クライアントが名乗る名前は信じない）。
- CSRF 対策として、すべての呼び出しに `X-Harikit: 1` ヘッダを必須にする。`application/json` 必須と合わせ、他サイトのフォームからは呼べない。
- Node 版をローカル（`127.0.0.1`）で立てるときは、起動時に乱数トークンを表示し、`Authorization: Bearer <token>` を必須にする。同じ PC の別タブのページから叩かれないため。

### 1.5 結果とエラーの返し方

- **業務上の結果はすべて HTTP 200** で返し、本文の `ok` で成否を表す。WebMethod は例外を投げると 500 で中身が読みにくいので、例外は捕まえてこの形に直す。
- HTTP 200 以外は「届かなかった」場合だけ: 401（未ログイン、Node 版のトークン違い）、403（権限なし、`X-Harikit` ヘッダなし）、404、413（大きすぎ）、415（`Content-Type` が `application/json` でない）、5xx（サーバが落ちた）。

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
- DB の生のエラー文には接続先や SQL が混じりうるので、`db_error` の `message` に出すかはサーバ設定で切り替える（既定は出さず、サーバのログにだけ残す）。ロック待ちの時間切れのように、人が次に何をすればよいか分かるものは、生のエラー文ではなく**サーバが決めた固定の文**を `message` に出してよい（例「対象の行がほかのセッションにロックされています。コミットしていない更新が残っていないか確かめてから、もう一度試してください」）。

共通のエラーコード:

| code | 意味 |
| --- | --- |
| `bad_request` | JSON の形が違う、必須項目がない |
| `version_unsupported` | `v` が知らない版 |
| `unknown_target` | 許可リストにないターゲット |
| `column_not_allowed` | 許可されていない列を読もう・更新しようとした |
| `key_mismatch` | キーの列がターゲットのキー列と一致しない |
| `too_many_rows` | 1回の上限（`limits`）を超えた。返せる応答の大きさに上限がある実装で、それを超える場合も含む（`details` に上限と長さ） |
| `conflict` | 変更前値が変わっていたので止めた（apply のみ、[7](#7-apply反映)） |
| `db_error` | DB がエラーを返した |
| `internal_error` | それ以外のサーバ側の失敗 |

行単位の結果（`rowErrors[].code`）だけで使うコード:

| code | 意味 |
| --- | --- |
| `invalid_value` | `key` / `before` / `after` の値が列の型の形でない（`decimal` に数値でない文字列、NOT NULL に `null`、桁あふれ、`maxBytes` 超え、列の文字コードで表せない字など）。`column` で列を示す |
| `duplicate_key` | 照合順序のうえで、前の行と同じ DB 行を指している（`"a001"` と `"A001"` など） |

`column_not_allowed`、`key_mismatch`、`bad_request` も行単位で使える。

### 1.6 比べ方（行を探すときと、値が変わっていないかを確かめるとき）

比べ方は2つに分ける。

| 何を比べるか | 比べ方 | 使うところ |
| --- | --- | --- |
| どの行か（キー） | DB の比較規則（列の照合順序） | fetch のキーの引き当て、apply の行の特定と `duplicate_key`、戻し SQL のキーの条件 |
| 値が変わっていないか | **厳密に同じ値** | apply の `before` の確認（[7](#7-apply反映) の手順 3）、戻し SQL の「harikit で入れた値のままか」の条件、コアの差分 |

「厳密に同じ」とは次のとおり。

- 文字列は1文字ずつ同じであること。大文字と小文字、ひらがなとカタカナ、全角と半角、アクセント、末尾の空白を区別する。ただし固定長（`char` / `nchar`）の末尾の空白は詰め物なので、末尾の空白だけは区別しない。
- NULL は NULL とだけ同じ。
- 数値や日付などは DB の `=` で比べる（もともと厳密）。

Japanese_CI_AS などの照合順序は 'ボールペン' と 'ﾎﾞｰﾙﾍﾟﾝ' を同じとみなす。照合順序で比べると、差分を取った後や反映した後に別の人が半角に直した行を、harikit が上書きしてしまう。これは「後から入った別の更新を上書きしない」という約束に反する。入力の揺れを自動で直さず厳しく扱う方針とも合わせた。一方でキーを照合順序で探すのは、DB 自身がその規則で行の一意性を決めているから。

SQL Server での書き方（可変長の文字列の列。`@b1` は nvarchar で渡す）:
```sql
CAST([ProductName] AS nvarchar(max)) COLLATE Latin1_General_BIN2 = @b1
AND DATALENGTH(CAST([ProductName] AS nvarchar(max))) = DATALENGTH(@b1)
```
- `varchar` の列も、先に `nvarchar` に直してから BIN2 で比べる。`varchar` のままコードページの違う照合順序を当てると、Japanese_CI_AS の 'ボールペン' が '?????' に崩れる（SQL Server 2022 で確かめた）。
- `=` は BIN2 でも末尾の空白を無視するので、`DATALENGTH` も比べる。`char` / `nchar` の列には `DATALENGTH` の条件を付けない。
- 戻し SQL（人が読む用）も同じ形で、`@b1` の代わりに `N'…'` のリテラルを書く。

Oracle での書き方:
- つないだときにセッションを `NLS_COMP = 'BINARY'`、`NLS_SORT = 'BINARY'` にする（`=` はセッションの `NLS_COMP` に従うため）。キーはこれで列の照合順序のまま比べる（Oracle の既定は BINARY）。人が流す `script` / `undoScript` も、先頭で `ALTER SESSION` して同じにする（流す人のセッションが `NLS_COMP = 'LINGUISTIC'` だと、キーが大文字小文字を無視して比べられ、ほかの行にも当たりうる。Oracle 23ai Free で確かめた）。
- 値が変わっていないかは、`COLLATE` が使える DB（12.2 以降）なら `"NAME" COLLATE BINARY = :b1` と書く。列に照合順序が付いていても厳密に比べるため。使えないときはセッションの BINARY に頼る。
- `VARCHAR2` / `NVARCHAR2` の `=` はもともと末尾の空白を区別する。`CHAR` / `NCHAR` は、パラメータを列と同じ型に CAST して比べる（`CAST(:k1 AS CHAR(6 BYTE))`、`CAST(:k1 AS NCHAR(4))`）。`VARCHAR2` のパラメータのままだと詰め物の空白まで比べて当たらない。固定長どうしは末尾の空白を見ないので、上の「固定長の末尾の空白だけは区別しない」と合う。
- `NVARCHAR2` / `NCHAR` の値は `NVARCHAR2` のパラメータで渡す（`VARCHAR2` で渡すと DB の文字コードを通り、表せない字が崩れる）。
- 戻し SQL のリテラルは、`NVARCHAR2` / `NCHAR` なら `N'…'`。DB の文字コードで表せない字を含むときは `UNISTR('\D842\DFB7…')` で書く（スクリプトのファイルが DB の文字コードを通ると `N'…'` の中身も崩れるため）。

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
- `table` はその DB の書き方で読む。Oracle では `"` で囲まない名前は大文字にし（`app.m_product` は `APP.M_PRODUCT`）、囲めばそのまま使う。スキーマを省くと接続ユーザーのスキーマ。シノニムもたどる（自分のスキーマのもの、スキーマを省いたときは PUBLIC も）。DB リンク（`@`）は受けない。
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
      "maxBytes": 10,
      "encoding": "shift_jis",
      "nullable": false,
      "updatable": false
    },
    {
      "name": "ProductName",
      "type": "string",
      "dbType": "nvarchar(50)",
      "maxLength": 50,
      "maxBytes": 100,
      "encoding": "utf-16le",
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
      "maxBytes": 4,
      "encoding": "shift_jis",
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

- `dialect` は `"sqlserver"` か `"oracle"`。
- `table` は実際の名前（Oracle なら `OWNER.NAME`。シノニムで書いた場合もたどった先）。
- `columns` は `readable` に載った列だけ。並びは DB の列順。
- 列の項目: `name`, `type`（[1.3](#13-値の書き方json-と-db-型の対応)）, `dbType`（表示用の生の型）, `nullable`, `updatable` は必須。`maxLength`（文字数。`max` は `-1`）, `maxBytes`, `encoding`（この2つは [文字列の列の長さと文字コード](#文字列の列の長さと文字コード)）, `emptyIsNull`（下記）, `precision`, `scale`（`decimal` の小数桁に加え、`datetime2(3)`・`time(0)` など日時の秒の小数桁。`datetime` は `3`）, `identity`, `computed`, `hasDefault` は当てはまるときだけ。
- `emptyIsNull: true` は、空文字 `""` を NULL として保存する文字列の列に付ける（Oracle の文字列の列は全部）。コアは取込でその列の空のセルを `null` にし、`""` を値として渡されたら検証エラーにする（「この列では空文字は NULL になります。空にするなら null」）。サーバはその列に `""` が来たら `invalid_value`。
- `foreignKeys[].referencedTarget` は、参照先が許可リストに読めるターゲットとして載っていればその名前、なければ `null`。許可リストの各ターゲットを DB で解決した名前と、外部キーの参照先の名前で照らし合わせる（シノニムやスキーマ省略で書いてあっても見つかるように）。`null` のときコアは存在確認を飛ばし、「確認できない」と警告を出す。
- 業務ルール（価格は0より大きい等）は describe に含めない。コア側の設定で持つ。

### 文字列の列の長さと文字コード

SQL Server の `varchar(n)` の `n` はバイト数で、照合順序が Japanese_CI_AS（コードページ 932）なら日本語は1文字2バイトになる。`nvarchar(n)` の `n` は UTF-16 の単位で、「𠮷」のようなサロゲートペアは2と数える。さらに、列の文字コードで表せない字（Latin1 の列に日本語、cp932 の列に「𠮷」など）はエラーにならず、黙って「?」に置き換わる。文字数だけでは見逃すので、文字列（`type: "string"`）の列には当てはまるときだけ次の2つを付ける。

| 項目 | 意味 | 例 |
| --- | --- | --- |
| `encoding` | 列の文字コード。[WHATWG Encoding](https://encoding.spec.whatwg.org/) の名前 | `"shift_jis"`、`"windows-1252"`、`"utf-8"`、`"utf-16le"` |
| `maxBytes` | その文字コードでの上限バイト数。`max` の列では付けない | `varchar(10)` なら `10`、`nvarchar(10)` なら `20` |

- `maxLength` は今までどおり文字数の上限（`varchar(n)` でも `n`）。1文字は1バイト以上なので、文字数の上限としては正しい。
- コアは `encoding` で値をバイト列に直して `maxBytes` と比べ、表せない字があれば検証エラーにする。知らない `encoding` なら確かめず、「確認できない」と警告を出す。ブラウザの `TextEncoder` は UTF-8 しか扱えないので、他の文字コードの変換表はコアが持つ。
- サーバも apply の値の形の確認（`invalid_value`）で同じことをする。ブラウザは書き換えられるので、ここを省くと「?」への置き換わりを防げない。
- SQL Server ではコードページを `COLLATIONPROPERTY(collation_name, 'CodePage')` で取り、次のように直す。`nchar` / `nvarchar` は照合順序によらず `utf-16le`。

| コードページ | `encoding` |
| --- | --- |
| 932 | `shift_jis` |
| 936 | `gbk` |
| 949 | `euc-kr` |
| 950 | `big5` |
| 874 | `windows-874` |
| 1250〜1258 | `windows-1250`〜`windows-1258` |
| 65001（`_UTF8` の照合順序） | `utf-8` |

- Oracle では `maxLength` は文字数（`CHAR_LENGTH`）、`maxBytes` はバイト数（`DATA_LENGTH`）で、`VARCHAR2(10 CHAR)` でも `VARCHAR2(10 BYTE)` でも同じ取り方でよい。`dbType` には単位を出す（`VARCHAR2(10 CHAR)`）。`encoding` は `VARCHAR2` / `CHAR` なら `NLS_CHARACTERSET`、`NVARCHAR2` / `NCHAR` なら `NLS_NCHAR_CHARACTERSET` から次のように直す。表にない文字コード（`US7ASCII` など）は `encoding` を付けない。

| Oracle の文字コード | `encoding` |
| --- | --- |
| AL32UTF8, UTF8 | `utf-8` |
| AL16UTF16 | `utf-16le` |
| JA16SJIS, JA16SJISTILDE | `shift_jis` |
| JA16EUC, JA16EUCTILDE | `euc-jp` |
| ZHS16GBK | `gbk` |
| ZHT16BIG5, ZHT16MSWIN950, ZHT16HKSCS | `big5` |
| KO16MSWIN949, KO16KSC5601 | `euc-kr` |
| TH8TISASCII | `windows-874` |
| EE8MSWIN1250 など（xx8MSWIN125x） | `windows-1250`〜`windows-1258` |
| WE8ISO8859P1 | `windows-1252` |
| WE8ISO8859P15 | `iso-8859-15` |

- WHATWG の名前と DB のコードページは完全には一致しない（WHATWG の `big5` は HKSCS を含み cp950 より広い、Oracle の `UTF8` は CESU-8、`JA16SJISTILDE` の波ダッシュ、など）。コアの確認は目安で、最後に確かめるのはサーバの `invalid_value`。サーバはこの確認を DB に聞いてもよい（Oracle なら `TO_CHAR` / `TO_NCHAR` に通して元に戻るか、`LENGTHB` が `maxBytes` 以内か）。

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
- `columns` は `readable` の中から。省くと `readable` 全部。空の配列 `[]` はキー列だけを返す（外部キーの存在確認用）。省略と `[]` は区別する。キー列は常に返るので書かなくてよい。
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
- キーの照合は DB の比較規則（照合順序）に従う（[1.6](#16-比べ方行を探すときと値が変わっていないかを確かめるとき)）。大文字小文字や末尾空白の扱いは DB 次第で、サーバは揃えない。返す `values` は DB に入っている値そのままで、揃えない。
- 外部キーの存在確認は、参照先ターゲットに対してキーだけで fetch し、`found` を見る。

## 5. 差分（コアの仕事、参考）

サーバ API ではないが、apply の入力を作るところなので書いておく。

- コアは fetch の結果と取込データを比べ、行を「変わる」「同じ値」「キーが見つからない」に分ける。
- 「変わる」行の、**変わる列だけ**を apply に送る。変わらない列は送らない（他の人の更新とぶつかる範囲を最小にするため）。
- 比較は [1.3](#13-値の書き方json-と-db-型の対応) の型で行う（`decimal` は `"120"` と `"120.00"` を同じとみなす、など）。文字列は [1.6](#16-比べ方行を探すときと値が変わっていないかを確かめるとき) の「厳密に同じ」で比べるので、'ﾎﾞｰﾙﾍﾟﾝ' を 'ボールペン' にする行は「変わる」になる。固定長（`char` / `nchar`）は末尾の空白を除いて比べる。

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

- `requestId`: クライアントが作る UUID。必須。スクリプトのコメントに入るので、英数字とハイフンの 8〜64 文字に限る（違えば `bad_request`）。サーバはログに残し、同じ `requestId` で一度成功していれば再実行せず前回の結果を返してよい（二度押し・通信切れの再送対策。v1 では「してよい」）。
- `mode`:
  - `"check"`: DB は変えない。許可リストの照合と、今の値が `before` と一致するかの確認だけ行い、実行予定の SQL（人が読む用）を返す。資料の「SQL だけ出力するモード」はこれ。
  - `"execute"`: 実際に反映する。
- `note`: 任意。ログに残す人向けのメモ（依頼番号、承認番号など）。
- `changes`: v1 では**要素ちょうど1つ**（1テーブル）。複数テーブルへ広げるときの入れ物として今から配列にしてある。
- `rows[].op`: v1 は `"update"` だけ。省略時も `"update"`。
- `before` と `after` は**同じ列の集まり**で、どちらも `updatable` の列だけ。`before == after` の列が混じっていたら `bad_request`（差分を取り違えている）。
- 行数が `limits.maxApplyRows` を超えたら `too_many_rows`。1トランザクションの約束を守るため、コアは**勝手に分割しない**（分けるかは人が決める）。
- 同じキーの行が2つあったら `rowErrors` で `duplicate_key`（後の行の `index`）。JSON の文字列が違っても照合順序で同じ行を指すもの（`"a001"` と `"A001"`）も含む。サーバはロックして読んだ行の実際のキー値で確かめる。コアの差分でも同じ確認をする。

### サーバの処理（実装が守ること）

1. ターゲット・列・キーを許可リストで照合し、値が列の型の形か（`invalid_value`）も確かめる。違えばすぐ失敗（DB に触らない）。戻し SQL に値を埋め込むので、この確認は省けない。
   返せる応答の大きさに上限がある実装（C# 版の `maxJsonLength` など）は、ここで結果（`script`、`undoScript` を含む）を組み立てて長さを見積もり、超えるなら `too_many_rows` で止める。コミットした後に結果が返せないと、戻し SQL がクライアントに届かないため。fetch も同じ。
2. トランザクションを開始する。
3. 対象行を更新ロックを掛けて読む（SQL Server なら `WITH (UPDLOCK, HOLDLOCK)`、Oracle なら `SELECT … FOR UPDATE WAIT n`）。待つ秒数 `n` はサーバ設定（`lockWaitSeconds`、既定 10 秒）。待っても取れなければ全体をロールバックして `db_error`（`message` は [1.5](#15-結果とエラーの返し方) の固定の文でよい）。SQL Server も `SET LOCK_TIMEOUT` で同じ設定を使ってよい。キーごとに、
   - 行がない → 衝突（`reason: "not_found"`）
   - `before` の列のどれかが今の値と違う → 衝突（`reason: "changed"`）。比較は [1.6](#16-比べ方行を探すときと値が変わっていないかを確かめるとき) の「厳密に同じ」で行う（NULL 同士は一致）。行の特定（キー）は照合順序のまま。
4. 読んだ行の実際のキー値で、2行が同じ DB 行を指していないかを確かめる（`duplicate_key`。あればロールバックして `rowErrors` で返す）。
5. 衝突が1行でもあれば**全体をロールバック**し、衝突した行を全部返す（v1 は全部か無しか）。
6. 衝突がなければ、行ごとにパラメータ付き UPDATE を流す。
   ```sql
   UPDATE [dbo].[M_Product]
      SET [UnitPrice] = @p1
    WHERE [ProductCode] = @k1
   ```
   テーブル名と列名は許可リストの値から組み、`[]`（Oracle は `"`）で囲む（クライアントの文字列を名前に使わない）。UPDATE 文そのものの影響行数が1でなければ全体をロールバックして `db_error`。トリガーの中の行数は含めない（SQL Server では UPDATE トリガーがあると、`ExecuteNonQuery` や mssql の `rowsAffected` にトリガーの行数が混ざるので、同じバッチの `SELECT @@ROWCOUNT` で読む）。
7. コミットする。`check` のときは手順 3〜5 の後でロールバックして終わる（手順 6 は流さず、SQL を組むだけ）。
8. サーバ側のログに、誰が・いつ・`requestId`・`note`・行ごとの前後の値を残す（ファイルでよい。履歴テーブルはオプション）。

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
  "script": "-- harikit 6f1c2a8e... product (dbo.M_Product) 2行\nSET XACT_ABORT ON;\nBEGIN TRANSACTION;\nUPDATE [dbo].[M_Product] SET [UnitPrice] = 130.00 WHERE [ProductCode] = 'A001' AND [UnitPrice] = 120.00;\n...\nCOMMIT;",
  "undoScript": "-- harikit 6f1c2a8e... の戻し（0行の UPDATE は後から別の更新が入った行）\nSET XACT_ABORT ON;\nBEGIN TRANSACTION;\nUPDATE [dbo].[M_Product] SET [UnitPrice] = 120.00 WHERE [ProductCode] = 'A001' AND [UnitPrice] = 130.00;\n...\nCOMMIT;"
}
```

- `script`: 実行した（`check` なら実行する予定の）内容を、値を埋め込んだ人が読める SQL にしたもの。承認資料やエビデンスにそのまま貼れる。実際の実行はパラメータで行い、この文字列は使わない。人が流しても1トランザクションになるよう包み、**どれかの行の UPDATE が1行でなければ（行が見つからないか値が変わっていれば）全部戻して止まる**形にする（`check` で出した SQL を後から人が流したときに、変わっていた行だけ黙って飛ばさないため）。SQL Server では `SET XACT_ABORT ON; BEGIN TRANSACTION; … COMMIT;` で包み、UPDATE ごとに `IF @@ROWCOUNT <> 1 THROW 50001, N'harikit: 行が見つからないか、値が変わっています（ProductCode=A001）。何も反映していません', 1;` を続ける（トリガーがあっても `@@ROWCOUNT` は UPDATE 文そのものの行数。SQL Server 2022 で確かめた）。メッセージにキーの値を入れるときは、リテラルと同じく引用を直す。`note` は改行で SQL を壊しうるのでスクリプトには入れない（ログにだけ残す）。
- `undoScript`: 戻し用 SQL。「今の値が harikit で入れた値のままなら戻す」形（`WHERE` に `after` の値を条件として入れる）にし、後から入った別の更新は上書きしない。値の条件は [1.6](#16-比べ方行を探すときと値が変わっていないかを確かめるとき) の厳密な比べ方で書く（キーの条件は照合順序のまま）。`script` と同じくトランザクションで包むが、0行の UPDATE があっても止めずに続ける（戻さなかった行を出力に出してよい）。`check` のときも返す。
- `script` と `undoScript` は方言ごとの書き方（引用、日付リテラル、NULL 比較）を知っているサーバが作る。コアはそれをファイルに保存する。トランザクションの包み方と止め方も方言の書き方でよい。Oracle では PL/SQL の無名ブロックにし、`SET DEFINE OFF`（値の `&` を置き換えさせない）、UPDATE ごとに `IF SQL%ROWCOUNT <> 1 THEN RAISE_APPLICATION_ERROR(-20001, '…'); END IF;`、`EXCEPTION WHEN OTHERS THEN ROLLBACK; RAISE;` とする。戻し用は `SET SERVEROUTPUT ON` にして、戻さなかった行と「n / m 行を戻しました」を `DBMS_OUTPUT` に出す。
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

許可リストの照合と値の形の確認で行ごとに見つかった誤りは、まとめて返す（1件目で止めない）。DB は変えていない（`duplicate_key` だけはロックして読んだ後に分かるので、ロールバックしてから返す）。
```json
{
  "ok": false,
  "v": 1,
  "error": { "code": "bad_request", "message": "3行に誤りがあります" },
  "rowErrors": [
    { "target": "product", "index": 0, "code": "column_not_allowed", "column": "UnitPrice2" },
    { "target": "product", "index": 3, "code": "key_mismatch" },
    { "target": "product", "index": 5, "code": "invalid_value", "column": "UnitPrice" }
  ]
}
```

## 8. 実装メモ

### Node 版
- 依存は DB ドライバ（SQL Server は `mssql`、Oracle は `oracledb`）だけを目安に。HTTP は標準の `http` で足りる。
- 既定で `127.0.0.1` にだけ待ち受け、起動時にトークンを出す（[1.4](#14-認証と-csrf)）。`appliedBy` は OS のユーザー名。
- `decimal` / `bigint` はドライバから文字列で受けて文字列で返す。
- Oracle のドライバは `oracledb`（node-oracledb）の Thin モード（Oracle Client 不要、12.1 以降）。11g は Thick モード（Oracle Instant Client が要る）。
- Oracle の NUMBER は文字列で受けて文字列で返し、パラメータも文字列で渡して `TO_NUMBER(:p)`（セッションの `NLS_NUMERIC_CHARACTERS = '.,'`）。DATE / TIMESTAMP は `TO_CHAR(…, 'YYYY-MM-DD"T"HH24:MI:SS.FF9')` で読み、`TO_DATE` / `TO_TIMESTAMP` で渡す（タイムゾーンをドライバに任せない）。

### C#（.NET Framework、WebForms）版
- 1つの `.aspx`（例 `Harikit.aspx`）に `[WebMethod]` を3つ置く: `Describe`、`Fetch`、`Apply`。引数は `Dictionary<string, object> req`、戻り値は `Dictionary<string, object>`（`{"d": ...}` は ASP.NET が付ける）。
- 例外は WebMethod の中で捕まえて `ok:false` に直す（[1.5](#15-結果とエラーの返し方)）。
- WebMethod の受け取りと返しの両方に効くのは `web.config` の `system.web.extensions/scripting/webServices/jsonSerialization` の `maxJsonLength`（Mono の既定は 2097152）。超えると HTTP 500（`Maximum length exceeded`）になるので、上げる手順を README に書き、apply と fetch は DB を変える前に結果の長さを見て `too_many_rows`（`details.maxJsonLength`、`details.length`）で止める（[7](#7-apply反映) の手順 1）。
- `application/json` でない POST は WebMethod に届かずページそのものが動くので、ページ側で 415 を返す（GET は 404）。
- 日付は `DateTime` をそのまま返すと `"\/Date(...)\/"` になるので、必ず [1.3](#13-値の書き方json-と-db-型の対応) の文字列に変換して返す。`decimal` も文字列で返す。
- 実行は `SqlTransaction` と `SqlParameter`。`appliedBy` は `HttpContext.Current.User.Identity.Name`（載せ先が匿名を通す設定でログインしていないときは `"(anonymous)"`）。
- 権限チェックは載せ先の仕組み（`web.config` の `<authorization>`、ロール判定など）に任せる。
- `maxBytes` と表せない字の確認は `Encoding.GetEncoding(codePage, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback)` の `GetByteCount` でできる（[文字列の列の長さと文字コード](#文字列の列の長さと文字コード)）。
- Oracle はこれから。ODP.NET Managed Driver（`Oracle.ManagedDataAccess`、.NET Framework 4.x、Oracle Client 不要）でできる見込み（未確認）。`OracleCommand.BindByName = true`、`NVARCHAR2` は `OracleDbType.NVarchar2`、NUMBER は `OracleDecimal` か文字列で受ける。比べ方、ロック、スクリプトの書き方は Node 版の `oracle.ts` に合わせる。

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
| 値が変わっていないかの比べ方 | 厳密に同じ値（照合順序を使わない）。キーは照合順序 | 後から入った更新を上書きしない |
| SQL 出力・戻し SQL | サーバが作る | 方言の書き方をサーバが知っている |
| 人が流す SQL で行が当たらないとき | 全部戻して止まる（戻し SQL は続ける） | 変わっていた行だけ黙って飛ばさない |
| 数値の精度 | `decimal` / `bigint` は文字列 | JS と .NET の両方で崩れない |

## 10. 拡張の余地

- **INSERT / DELETE**: `rows[].op` に `"insert"`（`after` だけ）、`"delete"`（`before` だけ、全列一致で消す）を足す。許可リストに `insertable` / `deletable` を足す。
- **複数テーブル**: `changes` に複数のターゲットを並べ、まとめて1トランザクションにする。並び順＝実行順（親→子）。
- **一部だけ反映**: `onConflict: "skipRow"` を足す（既定は今のまま全部止める）。
- **PostgreSQL、MySQL など**: `dialect` を増やす。API の形は変えない（Oracle はこの形で足した）。
- **自動で入れる列**: 許可リストに `stamp`（例 `UpdatedAt = 現在時刻`、`UpdatedBy = 実行者`）を足し、サーバが UPDATE に加える。
