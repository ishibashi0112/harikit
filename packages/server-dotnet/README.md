# harikit サーバ（C# / .NET Framework 版）

サーバ API 3 本（[docs/api-spec.md](../../docs/api-spec.md) の describe / fetch / apply）の C# 参考実装。
既存の ASP.NET WebForms アプリに、ソースと `.aspx` 1 枚を足して WebMethod として載せる。今は SQL Server だけ。

- .NET Framework 4.5 以上を想定（使っている API は 4.0 からあるものだけ）。CI では Windows の IIS と .NET Framework 4.8 に載せ、実際の SQL Server で通している（下の「テスト」）。
- C# 5 で書いてあるので、Web サイト（プロジェクトファイルなし）の `App_Code` でも、.NET Framework 付属のコンパイラのまま通る。
- 参照するのは `System.Data`、`System.Configuration`、`System.Web`、`System.Web.Extensions` だけ（WebForms のアプリなら入っている）。NuGet は要らない。
- 中身の手順は Node 版（[packages/server-node](../server-node)）と同じで、同じクライアント（`@harikit/core`）で両方を通すテストがある。

## 載せ方

1. **ソースを置く**
   - Web サイト: `src/*.cs` を `App_Code/Harikit/` に置く。
   - Web アプリケーションプロジェクト: `src/*.cs` をプロジェクトに足す。DLL にしたければ `build.cmd` で `bin\Harikit.Server.dll` を作って参照に足す。
2. **ページを置く**: `web/Harikit.aspx` をアプリの中に置く（例 `Admin/Harikit.aspx`）。中身は `[WebMethod]` が 3 つで、`HarikitWebMethods.Call` を呼ぶだけ。コードビハインドに移してもよい。
3. **許可リストを置く**: `App_Data/harikit.config.json`（例 [web/App_Data/harikit.config.json](web/App_Data/harikit.config.json)）。形は Node 版の `harikit.config.json` と同じ（下の「設定」）。
4. **web.config に足す**

```xml
<configuration>
  <connectionStrings>
    <!-- harikit 用のログイン。readable の列の SELECT と、updatable の列だけの UPDATE を許す（GRANT UPDATE (列, ...) ON 表）。 -->
    <add name="Harikit" connectionString="Server=...;Database=...;Integrated Security=SSPI" />
  </connectionStrings>

  <!-- 認証と権限はこのページに掛ける（harikit 自体はユーザー管理を持たない）。 -->
  <location path="Admin/Harikit.aspx">
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

5. **呼ぶ**: クライアントの設定は `{ baseUrl: "/Admin/Harikit.aspx", style: "webmethod" }`。CLI なら `--server https://.../Admin/Harikit.aspx --style webmethod`。
   - CLI は載せ先のログイン（フォーム認証のクッキー、Windows 認証）を通せないので、今のところ CLI から呼べるのはログインなしで開ける開発環境だけ。ブラウザ側の UI ができれば、同じアプリのログインのまま使える。

## 設定（harikit.config.json）

| 項目 | 意味 | 既定 |
| --- | --- | --- |
| `targets` | 許可リスト（仕様 2）。Node 版とそのまま写せる | （必須） |
| `limits` | `maxFetchKeys`、`maxApplyRows` | 1000、5000 |
| `connectionStringName` | web.config の `connectionStrings` の名前。接続文字列はこのファイルに書かない | `Harikit` |
| `logDir` | 反映ログのフォルダ。`~/` はアプリの中、相対ならアプリのフォルダから | `~/App_Data/harikit-log` |
| `exposeDbErrors` | `db_error` の `message` に DB の生のエラー文を出すか | `false` |
| `lockWaitSeconds` | 反映で行のロックを待つ秒数（`SET LOCK_TIMEOUT`）。ほかのセッションがロックしたままなら、待つのをやめて何も変えず `db_error`（「対象の行がほかのセッションにロックされています…」）で返す | `10` |

- 置き場所を変えるときは web.config の `appSettings` に `<add key="harikit:config" value="~/App_Data/harikit.config.json" />`。
- このファイルを保存し直すと、次の呼び出しで読み直す（覚えていたテーブル定義も捨てる）。テーブルの定義を変えたときも、保存し直すかアプリを再起動する。

## 記録

- 反映ログ: `App_Data/harikit-log/apply-YYYY-MM-DD.jsonl`。1 行 1 件で、形は Node 版と同じ（誰が・いつ・`requestId`・`note`・行ごとの前後の値）。
- サーバのエラー: 同じフォルダの `error-YYYY-MM-DD.log`（`db_error`、`internal_error` の中身）と `System.Diagnostics.Trace`。
- アプリプールのユーザーに `App_Data/harikit-log` への書き込み権限が要る。書けなくても反映の結果（戻し SQL）は返す。
- `appliedBy` は載せ先の認証が決めた名前（`HttpContext.Current.User.Identity.Name`）。ログインしていなければ `(anonymous)`。

## Node 版と同じく気をつけていること

- 文字列は varchar の列でも nvarchar のパラメータで渡し、出力する SQL も `N'...'` で書く（列と DB の既定の照合順序が違うと日本語が「?」になるため）。
- `char` / `nchar` の列は DB が末尾を空白で埋めるので、末尾の空白だけの違いは「同じ値」とみなす。
- どの行か（キー）は列の照合順序で探し、値が変わっていないか（apply の `before`、戻し SQL と反映 SQL の値の条件）は厳密に比べる（仕様 1.6）。`CAST([列] AS nvarchar(max)) COLLATE Latin1_General_BIN2 = 値` に、固定長でない列は `DATALENGTH` の一致も付ける。Japanese_CI_AS の `=` は 'ボールペン' と 'ﾎﾞｰﾙﾍﾟﾝ' を同じとみなすので、そのままだと後から別の人が直した行を上書きする。varchar の列に直接 BIN2 を当てると日本語が「?」に崩れるので、先に nvarchar に直す。
- SQL の文面と戻し SQL はトランザクションの前に作り、コミットした後にログが書けなくても結果を返す。
- `script` は UPDATE ごとに `IF @@ROWCOUNT <> 1 THROW 50001, …` を続け、`check` で出した SQL を後から人が流したときに、行が見つからないか値が変わっていれば全部戻して止まる（メッセージにキーの値）。`undoScript` は止めずに、今の値が harikit で入れた値のままの行だけ戻す。
- `real` の列は float のまま double にして返す（0.1 に丸めると、送り返された `before` が DB の値と合わず衝突になる）。
- 文字列の列のバイト数（`maxBytes`）と、列の文字コードで表せない字は、反映の前にサーバが `invalid_value` で止める（SQL Server は黙って「?」に置き換えるため）。まず .NET の文字コードで書いて読み戻して確かめ（どの字かを示せる）、最後に DB 自身に列の照合順序で varchar にして戻させて確かめる（.NET の表と DB のコードページは完全には一致しないため）。

## C# 版で足した注意

- **トリガーのあるテーブル**: `ExecuteNonQuery` の戻り値はトリガーの中の行数も足すので、UPDATE そのものの行数を同じバッチの `SELECT @@ROWCOUNT` で読む（監査トリガーがあるテーブルで「影響行数が 1 でない」と止まらないように）。
- **返せる JSON の長さ**: 結果が `maxJsonLength` を超えると ASP.NET は HTTP 500 を返し、反映した後なら戻し SQL が届かない。apply は DB を変える前に結果の長さを見積もり、超えるなら `too_many_rows`（`details.maxJsonLength`）で止める。fetch も同じ。
- **数値と日付**: カルチャに依らない書き方（`InvariantCulture`）で読み書きする。正規表現は `\d`（全角数字にも当たる）と `$`（末尾の改行の前にも当たる）を使わない。`requestId` に改行が入るとスクリプトのコメントを抜けられるため。
- **real / float の値**: `JavaScriptSerializer` は指数のない数を decimal で読むが、`Convert.ToDouble(decimal)` は最も近い double にならないことがある（real の 0.11 である 0.10999999940395355 など）。送り返された `before` が DB の値とずれて毎回衝突するので、文字列を通して読む。返すときも、.NET Framework の `"R"` が x64 で読み戻せない形を返すことがあるため、読み戻せることを確かめた decimal にして渡す。
- **パラメータの長さ**: SqlClient は `Size` より長い値を黙って切る（先頭に 0 が並ぶ長い数の文字列が 0 になる、など）。列や既定の長さより長い値は長いまま渡し、DB に読ませるか弾かせる。
- **CSRF**: `X-Harikit: 1` がなければ 403。`application/json` でない呼び出しは WebMethod に届かず、ページが 415 を返す（GET は 404）。
- **ソースの文字コード**: `.cs` と `.aspx` は BOM 付きの UTF-8 にしてある。BOM がないと ASP.NET が OS の既定の文字コード（日本語の Windows なら Shift_JIS）で読むことがあり、日本語のコメントで壊れうるため。

## テスト

Linux でも、Mono の ASP.NET で `Harikit.aspx` を動かして、実際の SQL Server で通せる（`mono-complete` が要る）。

```sh
HARIKIT_TEST_MSSQL='{"server":"localhost","user":"sa","password":"..."}' npm run test:dotnet
```

- [test/webmethod.integration.test.mjs](test/webmethod.integration.test.mjs): Node 版の結合テストと同じ場面（取込から反映、衝突、戻し、照合順序、char の空白）に、値の厳密な比べ方（全角半角・かな・末尾の空白）、止まる `script`、ロック待ちの打ち切り、監査トリガー、real の値の読み戻し、64 文字より長い数の文字列、文字コードとバイト数（DB での最後の確認は [test/Probe.aspx](test/Probe.aspx) で .NET 側の確認を外して見る）、`duplicate_key`、HTTP の 403 / 404 / 415、`maxJsonLength` の手前で止めることを足したもの。
- [test/host.mjs](test/host.mjs): ページを載せる Web のフォルダを作り、ASP.NET で動かす。環境変数で選ぶ。
  - `HARIKIT_TEST_DOTNET_HOST`: `mono`（既定。[test/TestHost.cs](test/TestHost.cs) の小さなホストで動かす。Ubuntu の `xsp4` は今の Mono では起動しないため）か `iis`（Windows の IIS に、テストごとにアプリプールとアプリを作って載せる。管理者で動かす）。
  - `HARIKIT_TEST_DOTNET_LAYOUT`: `bin`（既定。`build.cmd` か `build.sh` で作った DLL を置く）か `app_code`（`src/*.cs` を `App_Code/Harikit/` に置き、ASP.NET にビルドさせる）。
  - `HARIKIT_TEST_DOTNET_PKG`: 載せるパッケージ（既定 `packages/server-dotnet`）。
- CI では加えて、Windows のランナーに SQL Server Express（今は 2025）と IIS（ASP.NET 4.8）を入れ、IIS に `app_code` と `bin` の両方の形で載せて同じテストを流す（[.github/workflows/ci.yml](../../.github/workflows/ci.yml) の `iis`）。`app_code` の形では、IIS が .NET Framework 付属のコンパイラ（C# 5）でビルドするので、`App_Code` に置いたまま通るかも確かめられる。

## ファイル

| ファイル | 役割 |
| --- | --- |
| `src/HarikitService.cs` | API 3 本の中身（Node 版の `handlers.ts` にあたる） |
| `src/SqlServerDialect.cs` | SQL Server の SQL（Node 版の `mssql.ts` にあたる） |
| `src/HarikitDialect.cs` | DB ごとの違いを閉じ込める入口（Oracle などはここに足す） |
| `src/HarikitValues.cs` | 値の形の確認と比較（コアの `values.ts` と同じ判定） |
| `src/HarikitConfig.cs` | 許可リストと設定の読み込み |
| `src/HarikitWebMethods.cs` | WebMethod からの入口（ヘッダの確認、設定の読み込み、ログイン名） |
| `src/HarikitFileLog.cs` | 反映ログとエラーのファイル出力 |
| `src/HarikitJson.cs` | `JavaScriptSerializer` の形を扱う小道具 |
| `web/Harikit.aspx` | 載せ先に置くページ |
