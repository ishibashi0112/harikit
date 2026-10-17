# harikit

Excel やグリッドの値を、検証してから DB に貼り替える道具。

> 作りはじめの段階です。今動くのは「SQL Server と Oracle、1 テーブル、UPDATE だけ」の細い道で、入口は表への貼り付け（画面）と Excel / CSV 取込（CLI）です。考え方は [docs/concept.md](docs/concept.md)、サーバ API の仕様は [docs/api-spec.md](docs/api-spec.md)（作成中）にあります。

## 何をするものか

自社開発の業務システムでは、マスタの一括更新を次のように手作業でやっていることがよくあります。

1. 依頼者から更新内容の Excel を受け取る
2. 型・桁・存在しないコードなどを目で精査する
3. UPDATE 文を手で書く
4. 変更前後のエビデンスを取って承認をもらう
5. SQL を流す

パッケージ製品には一括取込機能があっても、自社開発のシステムにはないことが多いです。harikit はこの流れを一つの道具にします。

- **取込**: Excel、CSV、グリッドへの貼付で受け取る
- **検証**: DB のテーブル定義（型、桁、NOT NULL、主キー、外部キー）と設定した業務ルールで全行チェックし、エラーのセルを示す
- **差分**: 今の DB の値と並べ、「変わる」「同じ」「キーが見つからない」に分ける。これがそのまま承認資料になる
- **反映**: 1 トランザクションで実行。差分を取った後で値が変わっていたら止める。SQL だけ出力するモードもある
- **記録**: 変更前後のデータと戻し用 SQL をファイルに残す

## 構成

- コア（取込・検証・差分）は TypeScript で、ブラウザ側で動く Headless なパッケージ。UI は Excel 取込、[spreadsheet-grid](https://github.com/ishibashi0112/spreadsheet-grid) への貼付、CLI を載せる予定。
- サーバに求めるのは DB に触る API 3 本（テーブル定義、現在値、反映）だけ。既存アプリ（ASP.NET WebForms の WebMethod など）にメニューとして足せる。
- 参考実装として Node 版と C#（.NET Framework）版のサーバを用意する。手元だけで使うときは Node 版を 127.0.0.1 で立てる。

## 安全のための約束

- 反映 API に SQL は渡さない。サーバが許可リストのテーブル・列と照合し、パラメータ付き UPDATE を自分で組み立てる。
- 「変更前の値から変わっていないか」の確認はサーバ側でトランザクション内に行う。
- データはブラウザとそのサーバの間だけを行き来し、外部に送らない。

## 最初に通す道

SQL Server と Oracle で「1 テーブル、UPDATE だけ、Excel 取込」。PostgreSQL、MySQL はその後。Oracle は今のところ Node 版サーバだけ（C# 版は SQL Server だけ）。

## 試し方（SQL Server）

Node.js 22 以上が要ります。

```sh
npm install
npm run build

# 例のテーブルを作る（HarikitSample データベースに M_Product と M_Category）
sqlcmd -S localhost -U sa -i examples/sqlserver/setup.sql

# サーバを起動する（127.0.0.1:7357。起動時に画面の URL とトークンが出る）
cd examples/sqlserver
HARIKIT_DB_PASSWORD=... node ../../packages/server-node/dist/src/main.js -c harikit.config.json
```

### 画面で使う

起動時に出る `画面: http://127.0.0.1:7357/#token=…` をブラウザで開く。

1. 「対象」でテーブルを選ぶ。業務ルール（`harikit.rules.json`）は「ファイルを選ぶ」で読む（このブラウザが覚えておく）。
2. Excel で見出しの行ごとコピーし、表の A1 を選んで貼り付ける。1 行目が列名で、キーの列と変える列だけでよい（貼っていない列は変わらない）。右の一覧の「＋見出し」で列名を入れることもできる。
3. 「検証して差分を見る」。誤りのセルは赤くなり、直すと印が消える。通れば「差分」のタブが承認資料になる（差分 CSV と、CLI でも使える反映計画 plan.json を保存できる）。
4. 「DB で確かめる」で DB を変えずに確かめ、「反映する」で 1 トランザクションで反映する。実行した SQL と戻し SQL を保存できる。

貼り付けた値は文字列のまま検証する。Excel の表示が `2024/04/01` の日付や `1,200` の数値はエラーになるので、セルの書式を `2024-04-01` や桁区切りなしにしてからコピーする。

### CLI で使う

別の端末で:

```sh
cd examples/sqlserver
export HARIKIT_TOKEN=<起動時に出たトークン>
H=../../packages/cli/dist/src/main.js

node $H diff with-errors.xlsx -t product    # 誤りのセルを一覧にする（issues.csv）
node $H diff price-update.xlsx -t product   # 差分（diff.csv）と反映計画（plan.json）を作る
node $H apply harikit-out/product-.../plan.json            # DB は変えずに確かめる（check）
node $H apply harikit-out/product-.../plan.json --execute  # 反映する
```

- `diff.csv` は承認資料。行ごとに「変わる」「同じ」「キーなし」と、列ごとの前後の値が並ぶ。
- `apply` は 1 トランザクションで、差分を取った後に DB の値が変わっていたら何も反映せずに止まる。
- 反映すると、実行した SQL（`applied.sql`）と戻し用 SQL（`undo.sql`）がファイルに残る。戻し SQL は「今の値が harikit で入れた値のままの行だけ戻す」形。サーバ側にも反映ログ（`harikit-log/`）が残る。
- `check` で出した SQL（`check.sql`）を後から人が SSMS などで流すときも、1 行でも見つからないか値が変わっていれば、全部取り消して止まる（エラー 50001）。
- 許可リスト（どのテーブルのどの列を読めて、どの列を更新できるか）は `harikit.config.json` の `targets` に書く。
- ほかのセッションがロックしている行は、`database.lockWaitSeconds`（既定 10 秒）待ってから「ほかのセッションにロックされています」と出して止まる。

### 業務ルール

DB の定義ではわからない決まりは、`harikit.rules.json` に書く（`diff` は今のフォルダにあれば読む。別の場所は `--rules`）。

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

| 項目 | 意味 |
| --- | --- |
| `required` | 空を許さない（DB では NULL を許す列でも） |
| `min` / `max` | 以上 / 以下（数値と日付の列） |
| `greaterThan` / `lessThan` | より大きい / より小さい（数値と日付の列） |
| `pattern` | 文字列が合うべき正規表現 |
| `oneOf` | 使ってよい値の一覧 |
| `maxChangePercent` | DB の今の値からの変動の上限（%、数値の列） |
| `severity` | `"error"`（既定。差分を作らない）か `"warning"`（差分は作り、`issues.csv` に残す） |
| `message` | 合わないときに出す文 |

桁や NOT NULL、型、外部キーは DB の定義から自動で確かめるので、ここには書かない。varchar の桁は列の照合順序の文字コードでバイト数を数え、その文字コードで表せない字（Latin1 の列に日本語など）もエラーにする。

## 試し方（Oracle）

Oracle 12c 以降なら、Oracle Client（Instant Client）は要らない（node-oracledb の Thin モード）。手元で試すなら、コンテナの Oracle Free が手軽。

```sh
docker run -d -p 1521:1521 -e ORACLE_PASSWORD=... -e APP_USER=harikit -e APP_USER_PASSWORD=... gvenzl/oracle-free:23-slim

# 例のテーブルを作る（harikit のスキーマに M_PRODUCT と M_CATEGORY）
sqlplus harikit/...@localhost:1521/FREEPDB1 @examples/oracle/setup.sql

cd examples/oracle
HARIKIT_DB_PASSWORD=... node ../../packages/server-node/dist/src/main.js -c harikit.config.json
```

画面と CLI の使い方は SQL Server と同じ。Excel の見本は SQL Server の例のものがそのまま使える（`node $H diff ../sqlserver/price-update.xlsx -t product`）。

接続先は `harikit.config.json` の `database` に書く。

```json
{ "dialect": "oracle", "connectString": "dbhost:1521/ORCLPDB1", "user": "app" }
```

- `connectString` は `ホスト:ポート/サービス名` か、tnsnames.ora の別名（そのときは `configDir` に tnsnames.ora のフォルダ）。
- Thin モードでつながらない古い DB（11g など）は、Instant Client を入れて `"thick": true`（Windows と macOS は `"thick": { "libDir": "C:\\oracle\\instantclient_19_25" }`）。
- `lockWaitSeconds`: 反映のとき、ほかのセッションがロックしている行を待つ秒数（既定 10）。

### Oracle で気をつけること

harikit が合わせているところ:

- **テーブル名と列名**: `"` で囲まない名前は大文字として探す（Oracle と同じ）。スキーマを省くとつないだユーザーのスキーマで、なければシノニムをたどる。列名は大文字小文字を区別しないので、Excel の見出しは `ProductCode` でも `PRODUCTCODE` でもよい。
- **空文字は NULL**: Oracle では空文字を入れると NULL になる。取込の空文字（CSV の `""` など）は NULL として扱うので、NOT NULL の列では「必須です」のエラーになる。
- **DATE は時刻つき**: 差分には `2024-04-01T00:00:00` のように出る。秒の小数は入れられない。
- **桁**: `NUMBER(9,2)` は整数部 7 桁・小数 2 桁で確かめる。`VARCHAR2(10 BYTE)` はバイト、`VARCHAR2(10 CHAR)` は文字数で数える。
- **CHAR のキー**: `CHAR(6)` のコードも、末尾の空白を詰めずに `A001` と書けば当たる。
- **ロック**: SQL Developer などで COMMIT していない更新が対象の行に残っていると、反映は `lockWaitSeconds` 待って止まる（画面には「ほかのセッションにロックされています」と出る）。
- **出力する SQL**: PL/SQL のブロックで、SQL*Plus、SQLcl、SQL Developer で流せる。反映 SQL は 1 行でも合わなければ全部取り消して止まり、戻し SQL は合わない行（後から別の更新が入った行）を飛ばして、DBMS_OUTPUT にその行を出す。先頭で `ALTER SESSION SET NLS_COMP = 'BINARY' NLS_SORT = 'BINARY'` をする（キーを大文字小文字を区別して比べるため。流したセッションはその後もこの設定のまま）。
- **扱えない型**: CLOB、BLOB、RAW、TIMESTAMP WITH TIME ZONE などは読めるが更新できない。

## 中身

| パッケージ | 役割 |
| --- | --- |
| [packages/core](packages/core) | コア。Excel / CSV の読み込み、DB 定義での検証、差分、API クライアント。依存なしで、ブラウザでも Node でも動く |
| [packages/server-node](packages/server-node) | サーバ API 3 本の Node 版参考実装（SQL Server は `mssql`、Oracle は `oracledb` を使う） |
| [packages/server-dotnet](packages/server-dotnet) | サーバ API 3 本の C#（.NET Framework）版参考実装。ASP.NET WebForms のアプリに WebMethod として載せる（SQL Server） |
| [packages/cli](packages/cli) | CLI（`targets`、`diff`、`apply`） |
| [packages/web](packages/web) | 画面。[spreadsheet-grid](https://www.npmjs.com/package/@ishibashi0112/spreadsheet-grid) に貼り付けて、検証・差分・反映をする（React）。Node 版サーバが `/` で配る |

テスト: `npm test`。実際の SQL Server でも通すときは `HARIKIT_TEST_MSSQL='{"server":"localhost","user":"sa","password":"..."}' npm test`、Oracle は `HARIKIT_TEST_ORACLE='{"connectString":"localhost:1521/FREEPDB1","user":"harikit","password":"..."}' npm test`（そのユーザーのスキーマにテスト用のテーブルを作り直す）。
C# 版は `HARIKIT_TEST_MSSQL=... npm run test:dotnet`（Mono が要る。詳しくは [packages/server-dotnet](packages/server-dotnet)）。

## ライセンス

MIT
