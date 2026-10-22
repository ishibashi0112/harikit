# patchiri サーバ（C# / .NET Framework 版）

サーバ API 3 本（[docs/api-spec.md](../../docs/api-spec.md) の describe / fetch / apply）の C# 参考実装。
既存の ASP.NET WebForms アプリに、ソースと `.aspx` 1 枚を足して WebMethod として載せる。DB は SQL Server と Oracle（[下の「Oracle で使う」](#oracle-で使う)）。
そのページをブラウザで開くと画面（[packages/web](../web)）が出るので、載せ先のログインのまま、貼り付けから反映までできる。
VB.NET のアプリ（Web サイトの `App_Code` など）には、同じものを VB.NET で書いた [packages/server-vbnet](../server-vbnet) を置く。こちらを直したら VB.NET 版も同じように直す（同じテストで両方を通している）。

- .NET Framework 4.5 以上を想定（使っている API は 4.0 からあるものだけ）。CI では Windows の IIS と .NET Framework 4.8 に載せ、実際の SQL Server で通している。Oracle は Mono の ASP.NET で、実際の Oracle 23ai と 21c で通している（下の「テスト」）。
- C# 5 で書いてあるので、Web サイト（プロジェクトファイルなし）の `App_Code` でも、.NET Framework 付属のコンパイラのまま通る。
- 参照するのは `System.Data`、`System.Configuration`、`System.Web`、`System.Web.Extensions` だけ（WebForms のアプリなら入っている）。SQL Server なら NuGet は要らない。Oracle は ODP.NET Managed Driver（NuGet の `Oracle.ManagedDataAccess`）を載せ先に入れる（コンパイル時には参照せず、web.config の `providerName` で名前から読み込む）。
- 中身の手順は Node 版（[packages/server-node](../server-node)）と同じで、同じクライアント（`patchiri-core`）で両方を通すテストがある。

## 載せ方

1. **ソースを置く**
   - Web サイト: `src/*.cs` を `App_Code/Patchiri/` に置く。
   - Web アプリケーションプロジェクト: `src/*.cs` をプロジェクトに足す。DLL にしたければ `build.cmd` で `bin\Patchiri.Server.dll` を作って参照に足す。
2. **ページを置く**: `web/Patchiri.aspx` をアプリの中に置く（例 `Admin/Patchiri.aspx`）。名前と置き場所は自由で、`Admin/MasterUpdate.aspx` などにしてよい（ページは自分の URL を見て動く）。中身は `[WebMethod]` が 3 つ（`PatchiriWebMethods.Call` を呼ぶ）と、ブラウザで開いたときに画面を返す `Page_Load`（`PatchiriScreen.Write` を呼ぶ）だけ。コードビハインドに移してもよい。
3. **画面のファイルを置く**: 画面（patchiri-web の同梱アプリ `dist/app`）の `main.js`、`main.css`、`main.js.LEGAL.txt`（中に入れたライブラリのライセンス）を、ページの隣の `patchiri/` に置く（例 `Admin/patchiri/main.js`）。このリポジトリなら `npm ci && npm run build` で `packages/web/dist/app` にできる。
   - 置き場所を変えるときは web.config の `appSettings` に `<add key="patchiri:assets" value="~/Scripts/patchiri/" />`（`~/` はアプリの根から、ほかはページのフォルダから）。
   - 置き忘れると、ページを開いたときに足りないファイルの場所が出る。入れ替えたら、ブラウザは次に開いたときに読み直す（URL にファイルの更新日時を付けている）。
   - 中身はプログラムだけなので、このフォルダに権限を掛ける必要はない。
4. **許可リストを置く**: `App_Data/patchiri.config.json`（例 [web/App_Data/patchiri.config.json](web/App_Data/patchiri.config.json)）。形は Node 版の `patchiri.config.json` と同じ（下の「設定」）。
5. **web.config に足す**

```xml
<configuration>
  <connectionStrings>
    <!-- patchiri 用のログイン。readable の列の SELECT と、updatable の列だけの UPDATE を許す（GRANT UPDATE (列, ...) ON 表）。 -->
    <add name="Patchiri" connectionString="Server=...;Database=...;Integrated Security=SSPI" />
  </connectionStrings>

  <!-- 認証と権限はこのページに掛ける（patchiri 自体はユーザー管理を持たない）。画面と API の両方に効く。 -->
  <location path="Admin/Patchiri.aspx">
    <system.web>
      <authorization>
        <allow roles="MasterAdmin" />
        <deny users="*" />
      </authorization>
      <!-- 1 回の反映で送る JSON の大きさ（KB）。既定は 4096。 -->
      <httpRuntime maxRequestLength="51200" />
    </system.web>
  </location>

  <!-- WebMethod が受け取り・返せる JSON の長さ（文字数）。既定のままだと大きな反映の結果を返せない。 -->
  <system.web.extensions>
    <scripting>
      <webServices>
        <jsonSerialization maxJsonLength="52428800" />
      </webServices>
    </scripting>
  </system.web.extensions>
</configuration>
```

6. **開く**: ブラウザで `https://.../Admin/Patchiri.aspx` を開く。載せ先にログインしていれば、そのまま画面が出る（使い方は [サイトの「画面で使う」](https://patchiri.vercel.app/usage/web/)）。見出しの右に、反映ログに残るログイン名が出る。
   - Edge か Chrome で開く。Internet Explorer と Edge の IE モードでは動かない（その旨の案内が出る）。載せ先のアプリが IE モードのサイト一覧に入っているときは、このページを外す。
   - ログインが切れたら（フォーム認証のタイムアウトなど）、画面は貼った表を残したまま「別のタブでログインし直してから、もう一度押してください」と出す。ログインし直せば、元のタブでそのまま続けられる。
   - ほかのクライアントから呼ぶときの設定は `{ baseUrl: "/Admin/Patchiri.aspx", style: "webmethod" }`。CLI なら `--server https://.../Admin/Patchiri.aspx --style webmethod`。ただし CLI は載せ先のログイン（フォーム認証のクッキー、Windows 認証）を通せないので、CLI から呼べるのはログインなしで開ける開発環境だけ。

## Oracle で使う

ドライバは ODP.NET Managed Driver（`Oracle.ManagedDataAccess.dll`）。無償のライセンス（Oracle Free Distribution, Hosting, and Use Terms and Conditions）で、DLL を `bin` に置くだけで動き、Oracle Client（Instant Client）は要らない。patchiri は ODP.NET を参照せずに名前で読み込むので、載せ先がすでに使っている版をそのまま使う。

1. **ODP.NET を入れる**: Visual Studio の NuGet で `Oracle.ManagedDataAccess` を入れる（Web サイトでも Web アプリケーションプロジェクトでもよい）。`bin` に `Oracle.ManagedDataAccess.dll` と、版によっては依存する DLL（`System.Text.Json.dll`、`System.Memory.dll` など）が入る。依存する DLL には web.config のバインドのリダイレクト（`<runtime>` の `<bindingRedirect>`）が要る（NuGet が足す。足りないと、つなぐときに「ファイルまたはアセンブリ … を読み込めません」となる）。
   - 版は載せ先の .NET Framework に合わせる（今の 23.x は 4.7.2 以上、19.x と 21.x の今の版は 4.6.2 以上。もっと古い .NET Framework なら、NuGet のページで対応する古い版を選ぶ）。テストは 23.x と 19.x で通している。
   - 入っていなければ、ページを開いたときに「Oracle につなぐ ODP.NET（Oracle.ManagedDataAccess.dll）が見つかりません」と出る。
   - Oracle Client を使う ODP.NET（Unmanaged、`Oracle.DataAccess.dll`）には対応しない。
2. **接続文字列に `providerName` を書く**: `providerName` を省くか `System.Data.SqlClient` なら SQL Server、`Oracle.ManagedDataAccess.Client` なら Oracle につなぐ。

```xml
<connectionStrings>
  <!-- patchiri 用のユーザー。readable の列の SELECT と、updatable の列だけの UPDATE を許す（GRANT UPDATE (列, ...) ON 表）。 -->
  <add name="Patchiri" providerName="Oracle.ManagedDataAccess.Client"
       connectionString="User Id=patchiri_app;Password=...;Data Source=dbhost:1521/ORCLPDB1" />
</connectionStrings>
```

- `Data Source` は `ホスト:ポート/サービス名` か、tnsnames.ora の別名（ODP.NET が tnsnames.ora を探す場所は ODP.NET の設定に従う）。
- 許可リストの `table` は Node 版と同じ書き方（`"PATCHIRI.M_PRODUCT"`、`"M_PRODUCT"`）。`"` で囲まない名前は大文字として探し、スキーマを省くとつないだユーザーのスキーマで探して、なければシノニムをたどる。
- `lockWaitSeconds` は `SELECT … FOR UPDATE WAIT n` の秒数になる。
- 気をつけていることは Node 版と同じ（[サイトの「Oracle」](https://patchiri.vercel.app/databases/oracle/)）。空文字は NULL として扱う（`describe` の列に `emptyIsNull`）。`CHAR` のキーは末尾の空白を詰めずに書いても当たる。値が変わっていないかは 12.2 以降なら `COLLATE BINARY` で比べる。`script` と `undoScript` は SQL*Plus、SQLcl、SQL Developer で流せる PL/SQL のブロック。
- **セッションの設定**: つないだら `NLS_COMP` と `NLS_SORT` を `BINARY` に、`NLS_NUMERIC_CHARACTERS` を `'.,'` にそろえ（違うときだけ）、接続をプールに返す前に元に戻す。ODP.NET は載せ先のカルチャ（`<globalization culture>` など）からセッションの設定を決めるので（ドイツ語なら小数点が `,`、並べ方が `GERMAN`）、そのままだと数の読み書きとキーの比べ方が載せ先に左右されるため。戻すのは、載せ先のアプリが同じ接続文字列でプールを共有しうるため。

## 設定（patchiri.config.json）

| 項目 | 意味 | 既定 |
| --- | --- | --- |
| `targets` | 許可リスト（仕様 2）。Node 版とそのまま写せる。表示名（`labels`）、自動で入れる列（`stamp`）、触れる行の条件（`scope`）、使えるロール（`roles`）も書ける | （必須） |
| `rules` | サーバに置く業務ルール（`patchiri.rules.json` と同じ形）。中身か、このファイルのフォルダからのパス。describe で画面に渡し、apply で `error` のルールを見直す | なし |
| `limits` | `maxFetchKeys`、`maxApplyRows` | 1000、5000 |
| `connectionStringName` | web.config の `connectionStrings` の名前。接続文字列はこのファイルに書かない | `Patchiri` |
| `logDir` | 反映ログのフォルダ。`~/` はアプリの中、相対ならアプリのフォルダから | `~/App_Data/patchiri-log` |
| `exposeDbErrors` | `db_error` の `message` に DB の生のエラー文を出すか | `false` |
| `lockWaitSeconds` | 反映で行のロックを待つ秒数（SQL Server は `SET LOCK_TIMEOUT`、Oracle は `FOR UPDATE WAIT`）。ほかのセッションがロックしたままなら、待つのをやめて何も変えず `db_error`（「対象の行がほかのセッションにロックされています…」）で返す。Node 版と同じく `database.lockWaitSeconds` にも書ける | `10` |

- 置き場所を変えるときは web.config の `appSettings` に `<add key="patchiri:config" value="~/App_Data/patchiri.config.json" />`。ページごとに別のファイルを使うなら、下の「ページごとの許可リスト」。
- このファイルか `rules` のファイルを保存し直すと、次の呼び出しで読み直す（覚えていたテーブル定義も捨てる）。テーブルの定義を変えたときも、保存し直すかアプリを再起動する。

## 誰が反映したかとロール

- 反映した人（`appliedBy`。反映ログと、`stamp` の `"user"` の列に入る）は、既定では載せ先の認証が決めた名前（`HttpContext.Current.User.Identity.Name`。ログインしていなければ `(anonymous)`）。
- 許可リストの `roles` は、既定では `User.IsInRole` で判定する（Windows 認証のグループ、ロール マネージャーなど）。入っていない人には、ターゲットの一覧に出さず、指しても `forbidden`。
- 自前のログインで Session に社員番号や権限を置くアプリは、`Global.asax` の `Application_Start` で差し替える。

```csharp
void Application_Start(object sender, EventArgs e)
{
    PatchiriWebMethods.WhoAmI = ctx => ctx.Session == null ? null : ctx.Session["EmployeeCode"] as string;
    PatchiriWebMethods.IsInRole = (ctx, role) => ctx.Session != null && role.Equals(ctx.Session["Role"] as string);
}
```

- 差し替えた `WhoAmI` が名前を返さない（`null` か `""`）呼び出しは、未ログインとして API も画面も HTTP 401（API はフォーム認証のログイン画面への転送にしない。画面はフォーム認証が効いていればログイン画面に回る）。1 回の呼び出しの中では最初の答えを使う。
- Session を読むなら、ページの 3 つの WebMethod を `[WebMethod(EnableSession = true)]` に、ページの `EnableSessionState` を `"ReadOnly"` にする（既定のページは Session を使わない）。
- 判定が例外を投げたら `internal_error`（中身は `error-*.log`）。

## ページごとの許可リスト

部署ごとに触れる行（`scope`）やテーブルを分けたいときは、ページを分け、`PatchiriWebMethods.Call` の 3 つ目に許可リストのファイルを渡す（`~/` はアプリの中、相対ならアプリのフォルダから）。読んだ許可リストはファイルごとに覚える。

```csharp
[WebMethod]
public static Dictionary<string, object> Describe(Dictionary<string, object> req)
{
    return PatchiriWebMethods.Call("describe", req, "~/App_Data/sales.config.json");
}
```

## 記録

- 反映ログ: `App_Data/patchiri-log/apply-YYYY-MM-DD.jsonl`。1 行 1 件で、形は Node 版と同じ（誰が・いつ・`requestId`・`note`・行ごとの前後の値。`stamp` があれば、その列の前の値 `stampBefore` も）。
- サーバのエラー: 同じフォルダの `error-YYYY-MM-DD.log`（`db_error`、`internal_error` の中身）と `System.Diagnostics.Trace`。
- アプリプールのユーザーに `App_Data/patchiri-log` への書き込み権限が要る。書けなくても反映の結果（戻し SQL）は返す。
- `appliedBy` は「誰が反映したかとロール」のとおり。

## Node 版と同じく気をつけていること

- 文字列は varchar の列でも nvarchar のパラメータで渡し、出力する SQL も `N'...'` で書く（列と DB の既定の照合順序が違うと日本語が「?」になるため）。
- `char` / `nchar` の列は DB が末尾を空白で埋めるので、末尾の空白だけの違いは「同じ値」とみなす。
- どの行か（キー）は列の照合順序で探し、値が変わっていないか（apply の `before`、戻し SQL と反映 SQL の値の条件）は厳密に比べる（仕様 1.6）。`CAST([列] AS nvarchar(max)) COLLATE Latin1_General_BIN2 = 値` に、固定長でない列は `DATALENGTH` の一致も付ける。Japanese_CI_AS の `=` は 'ボールペン' と 'ﾎﾞｰﾙﾍﾟﾝ' を同じとみなすので、そのままだと後から別の人が直した行を上書きする。varchar の列に直接 BIN2 を当てると日本語が「?」に崩れるので、先に nvarchar に直す。
- SQL の文面と戻し SQL はコミットの前に作り、コミットした後にログが書けなくても結果を返す（`stamp` があれば、戻し SQL はロックして読んだ stamp の列の値で作り直す）。
- サーバに置いた業務ルール（`rules`）は、ロックして読んだ値に `after` を重ねた行で見る（ルールが見るほかの列も同じ読み取りで読む）。正規表現は `RegexOptions.ECMAScript` で読むので、`\p{…}` は使えず、`$` は末尾の改行の前にも当たる（[src/PatchiriRules.cs](src/PatchiriRules.cs)）。
- `script` は UPDATE ごとに `IF @@ROWCOUNT <> 1 THROW 50001, …` を続け、`check` で出した SQL を後から人が流したときに、行が見つからないか値が変わっていれば全部戻して止まる（メッセージにキーの値）。`undoScript` は止めずに、今の値が patchiri で入れた値のままの行だけ戻す。
- `real` の列は float のまま double にして返す（0.1 に丸めると、送り返された `before` が DB の値と合わず衝突になる）。
- 文字列の列のバイト数（`maxBytes`）と、列の文字コードで表せない字は、反映の前にサーバが `invalid_value` で止める（SQL Server は黙って「?」に置き換えるため）。まず .NET の文字コードで書いて読み戻して確かめ（どの字かを示せる）、最後に DB 自身に列の照合順序で varchar にして戻させて確かめる（.NET の表と DB のコードページは完全には一致しないため）。

## C# 版で足した注意

- **トリガーのあるテーブル**: `ExecuteNonQuery` の戻り値はトリガーの中の行数も足すので、UPDATE そのものの行数を同じバッチの `SELECT @@ROWCOUNT` で読む（監査トリガーがあるテーブルで「影響行数が 1 でない」と止まらないように）。
- **返せる JSON の長さ**: 結果が `maxJsonLength` を超えると ASP.NET は HTTP 500 を返し、反映した後なら戻し SQL が届かない。apply は DB を変える前に結果の長さを見積もり、超えるなら `too_many_rows`（`details.maxJsonLength`）で止める。fetch も同じ。
- **数値と日付**: カルチャに依らない書き方（`InvariantCulture`）で読み書きする。正規表現は `\d`（全角数字にも当たる）と `$`（末尾の改行の前にも当たる）を使わない。`requestId` に改行が入るとスクリプトのコメントを抜けられるため。
- **real / float の値**: `JavaScriptSerializer` は指数のない数を decimal で読むが、`Convert.ToDouble(decimal)` は最も近い double にならないことがある（real の 0.11 である 0.10999999940395355 など）。送り返された `before` が DB の値とずれて毎回衝突するので、文字列を通して読む。返すときも、.NET Framework の `"R"` が x64 で読み戻せない形を返すことがあるため、読み戻せることを確かめた decimal にして渡す。
- **パラメータの長さ**: SqlClient は `Size` より長い値を黙って切る（先頭に 0 が並ぶ長い数の文字列が 0 になる、など）。列や既定の長さより長い値は長いまま渡し、DB に読ませるか弾かせる。
- **CSRF**: `X-Patchiri: 1` がなければ 403。`application/json` でない呼び出しは WebMethod に届かず、ページが 415 を返す（GET は画面）。
- **画面のページ**: HTML はサーバで書き（`PatchiriScreen`）、ログイン名などは HTML に入れるときにエスケープする。Content-Security-Policy（スクリプトと通信は同じオリジンだけ）と `X-Frame-Options: SAMEORIGIN` を付ける。載せ先が `globalization` の `responseEncoding` を Shift_JIS などにしていても UTF-8 で返す。
- **Oracle の数**: `NUMBER` は .NET の `decimal`（28 桁）に収まらないことがある（`NUMBER(38)` を読むと `OverflowException`）ので、`TO_CHAR` で文字列にして読み、`TO_NUMBER` で渡す。日時も `TO_CHAR` / `TO_TIMESTAMP` で文字列を通す（秒の小数 9 桁まで）。`BOOLEAN`（23ai）は 19.x の ODP.NET でも扱えるよう、`CASE` と `TO_BOOLEAN` で数と文字列を通す。
- **Oracle の文字コード**: `VARCHAR2` / `CHAR` の値が DB の文字コードで表せるかとバイト数の最後の確認は、PL/SQL のブロックで DB に `TO_CHAR` させて確かめる（SQL の中だと 4000 バイトで切れるため）。
- **ソースの文字コード**: `.cs` と `.aspx` は BOM 付きの UTF-8 にしてある。BOM がないと ASP.NET が OS の既定の文字コード（日本語の Windows なら Shift_JIS）で読むことがあり、日本語のコメントで壊れうるため。

## テスト

Linux でも、Mono の ASP.NET で `Patchiri.aspx` を動かして、実際の SQL Server で通せる（`mono-complete` と、画面のテストには Playwright の Chromium が要る）。

```sh
PATCHIRI_TEST_MSSQL='{"server":"localhost","user":"sa","password":"..."}' npm run test:dotnet
PATCHIRI_TEST_ORACLE='{"connectString":"localhost:1521/FREEPDB1","user":"patchiri","password":"..."}' npm run test:dotnet
```

- [test/screen.e2e.test.mjs](test/screen.e2e.test.mjs): 画面を本物のブラウザで通す。載せ先によくある形（フォーム認証、ページは `Admin/MasterUpdate.aspx` に名前を変えて置き、特定のユーザーだけに許す）で、ログイン → 貼り付け → 検証 → DB で確かめる → 反映、反映ログの「誰が」、権限のない人は画面も API も使えないこと、ログインが切れたときの案内と別のタブでログインし直して続けられることを見る。ブラウザは Playwright の Chromium（`npx playwright install chromium`）。入っているブラウザを使うなら `PATCHIRI_TEST_BROWSER_CHANNEL=msedge` など、途中の画面を残すなら `PATCHIRI_TEST_SCREENSHOTS` にフォルダを渡す。
- [test/webmethod.integration.test.mjs](test/webmethod.integration.test.mjs): Node 版の結合テストと同じ場面（取込から反映、衝突、戻し、照合順序、char の空白）に、値の厳密な比べ方（全角半角・かな・末尾の空白）、止まる `script`、ロック待ちの打ち切り、監査トリガー、real の値の読み戻し、64 文字より長い数の文字列、文字コードとバイト数（DB での最後の確認は [test/Probe.aspx](test/Probe.aspx) で .NET 側の確認を外して見る）、`duplicate_key`、HTTP の 403 / 415、ページを開いたときの画面の HTML、`maxJsonLength` の手前で止めることを足したもの。
- [test/customize.integration.test.mjs](test/customize.integration.test.mjs): 許可リストの `labels`・`stamp`・`scope`・`roles`、ファイルに置いた `rules`（書き直したら読み直す）、`Global.asax` で差し替えた `WhoAmI` / `IsInRole`（名前がなければ 401）、ページごとの許可リスト（`Call` の `configPath`）、設定の誤り。既定の `User.IsInRole` での `roles` は webmethod.integration.test.mjs で見る。
- [test/oracle.integration.test.mjs](test/oracle.integration.test.mjs): 実際の Oracle で、Node 版の Oracle のテストと同じ場面（CHAR のキーとシノニム、取込から反映・衝突・戻し、空文字、BYTE / CHAR の長さと DB での最後の確認、厳密な比べ方、`NUMBER(38)`、`BINARY_FLOAT`、ロック待ち、`BOOLEAN`、出力した SQL を大文字小文字を無視するセッションや改行を含む値で流す）を通す。載せ先のカルチャを `de-DE` にして、数の読み書きがカルチャに依らないことと、セッションの設定を戻してから接続をプールに返すこと（[test/OracleSessions.aspx](test/OracleSessions.aspx)）も見る。ODP.NET は .NET SDK（`dotnet`）で NuGet から集めて `bin` に置く（[test/odpnet](test/odpnet)。版は `PATCHIRI_TEST_ODPNET_VERSION`、既定は 23.x）。
- [test/host.mjs](test/host.mjs): ページを載せる Web のフォルダを作り、ASP.NET で動かす。環境変数で選ぶ。
  - `PATCHIRI_TEST_DOTNET_HOST`: `mono`（既定。[test/TestHost.cs](test/TestHost.cs) の小さなホストで動かす。Ubuntu の `xsp4` は今の Mono では起動しないため）か `iis`（Windows の IIS に、テストごとにアプリプールとアプリを作って載せる。管理者で動かす）。
  - `PATCHIRI_TEST_DOTNET_LAYOUT`: `bin`（既定。`build.cmd` か `build.sh` で作った DLL を置く）か `app_code`（`src/*.cs` を `App_Code/Patchiri/` に置き、ASP.NET にビルドさせる）。
  - `PATCHIRI_TEST_DOTNET_PKG`: 載せるパッケージ（既定 `packages/server-dotnet`）。
- CI では加えて、Windows のランナーに SQL Server Express（今は 2025）と IIS（ASP.NET 4.8）を入れ、IIS に `app_code` と `bin` の両方の形で載せて同じテストを流す（画面のテストは Windows の Edge で、途中の画面は artifacts の `screens-*` に残す）（[.github/workflows/ci.yml](../../.github/workflows/ci.yml) の `iis`）。`app_code` の形では、IIS が .NET Framework 付属のコンパイラ（C# 5）でビルドするので、`App_Code` に置いたまま通るかも確かめられる。
- Oracle は Windows のランナーでは動かせない（Linux のコンテナが動かない）ので、Linux の Mono で、Oracle 23ai Free と 21c XE につないで `bin` と `app_code` の両方の形で流す（`dotnet-oracle`。23ai には ODP.NET 23.x、21c には 19.x）。

## ファイル

| ファイル | 役割 |
| --- | --- |
| `src/PatchiriService.cs` | API 3 本の中身（Node 版の `handlers.ts` にあたる） |
| `src/SqlServerDialect.cs` | SQL Server の SQL（Node 版の `mssql.ts` にあたる） |
| `src/OracleDialect.cs` | Oracle の SQL（Node 版の `oracle.ts` にあたる）。ODP.NET を名前で読み込む |
| `src/PatchiriDialect.cs` | DB ごとの違いを閉じ込める入口（ほかの DB はここに足す） |
| `src/PatchiriValues.cs` | 値の形の確認と比較（コアの `values.ts` と同じ判定） |
| `src/PatchiriConfig.cs` | 許可リストと設定の読み込み |
| `src/PatchiriRules.cs` | サーバに置く業務ルール（コアの `rules.ts` と同じ決まりと文） |
| `src/PatchiriWebMethods.cs` | WebMethod からの入口（ヘッダの確認、設定の読み込み、接続文字列の `providerName` で DB を選ぶ、ログイン名とロールの判定と差し替え） |
| `src/PatchiriScreen.cs` | ページをブラウザで開いたときの画面（HTML と、画面のファイルの場所） |
| `src/PatchiriFileLog.cs` | 反映ログとエラーのファイル出力 |
| `src/PatchiriJson.cs` | `JavaScriptSerializer` の形を扱う小道具 |
| `web/Patchiri.aspx` | 載せ先に置くページ（名前は自由） |
