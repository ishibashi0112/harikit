# harikit

Excel やグリッドの値を、検証してから DB に貼り替える道具。

> 作りはじめの段階です。今動くのは「SQL Server、1 テーブル、UPDATE だけ」の細い道で、入口は表への貼り付け（画面）と Excel / CSV 取込（CLI）です。考え方は [docs/concept.md](docs/concept.md)、サーバ API の仕様は [docs/api-spec.md](docs/api-spec.md)（作成中）にあります。

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

SQL Server で「1 テーブル、UPDATE だけ、Excel 取込」。Oracle、PostgreSQL、MySQL はその後。

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

### Excel の表示のままの値

表への貼り付けや Excel が保存した CSV は、セルの値ではなく表示された文字列で届く。そこで数・日付・時刻・真偽の列は、表示の形も読む（`.xlsx` の取込でも、文字列のセルは同じ読み方）。

| 列 | 読むもの | 読まないもの（理由つきのエラー） |
| --- | --- | --- |
| 数 | `1,200`、`¥1,200`、`$1,234.50`、`1,200円`、`-1,200`、`▲1,200`、`(1,200)`、全角の数字 | `12.5%`（0.125 か 12.5 か決まらない）、`1.2E+05`（丸められていることがある）、`###`、`1,2`、会計表示の `-` |
| 日付・日時 | `2024/4/1`、`2024.4.1`、`2024年4月1日`、`令和6年4月1日`、`R6.4.1`、`2024/4/1(月)`、`2024/4/1 9:30` | `4/1/2024`・`24/4/1`（年月日の順が決まらない）、`4/1`（年がない）、曜日が合わないもの |
| 時刻 | `9:30`、`午後1:30`、`1:30 PM`、`9時30分` | `13:30 PM` など |

- 読み替えたセルは画面の表で点線の下線になり、マウスを乗せると読んだ値が出る。差分のタブでは、貼った値をセルのメモで見られる。CLI は読み替えたセルの一覧を `readings.csv` に残す。
- 文字列の列は書かれたとおりに使う（全角半角も前後の空白も直さない。前後の空白は警告）。
- Excel のエラー値（`#N/A` など）は、文字列の列でもエラーにする。
- 表示で丸めた数や秒は丸めたまま読む。元の桁が要るときは、Excel の表示形式を変えてからコピーする。

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
- Excel の表示の形（`2024/4/1`、`¥1,200` など）から読み替えたセルがあれば、`readings.csv` に取り込んだ値と読んだ値が並ぶ。
- `apply` は 1 トランザクションで、差分を取った後に DB の値が変わっていたら何も反映せずに止まる。
- 反映すると、実行した SQL（`applied.sql`）と戻し用 SQL（`undo.sql`）がファイルに残る。戻し SQL は「今の値が harikit で入れた値のままの行だけ戻す」形。サーバ側にも反映ログ（`harikit-log/`）が残る。
- 許可リスト（どのテーブルのどの列を読めて、どの列を更新できるか）は `harikit.config.json` の `targets` に書く。

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

## 中身

| パッケージ | 役割 |
| --- | --- |
| [packages/core](packages/core) | コア。Excel / CSV の読み込み、DB 定義での検証、差分、API クライアント。依存なしで、ブラウザでも Node でも動く |
| [packages/server-node](packages/server-node) | サーバ API 3 本の Node 版参考実装（SQL Server、`mssql` を使う） |
| [packages/server-dotnet](packages/server-dotnet) | サーバ API 3 本の C#（.NET Framework）版参考実装。ASP.NET WebForms のアプリに WebMethod として載せる（SQL Server） |
| [packages/cli](packages/cli) | CLI（`targets`、`diff`、`apply`） |
| [packages/web](packages/web) | 画面。[spreadsheet-grid](https://www.npmjs.com/package/@ishibashi0112/spreadsheet-grid) に貼り付けて、検証・差分・反映をする（React）。Node 版サーバが `/` で配る |

テスト: `npm test`。実際の SQL Server でも通すときは `HARIKIT_TEST_MSSQL='{"server":"localhost","user":"sa","password":"..."}' npm test`。
C# 版は `HARIKIT_TEST_MSSQL=... npm run test:dotnet`（Mono が要る。詳しくは [packages/server-dotnet](packages/server-dotnet)）。

## ライセンス

MIT
