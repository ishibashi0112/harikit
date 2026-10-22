# patchiri サーバ（VB.NET / .NET Framework 版）

サーバ API 3 本（[docs/api-spec.md](../../docs/api-spec.md) の describe / fetch / apply）の VB.NET 参考実装。
既存の ASP.NET WebForms アプリ（VB.NET）に、ソースと `.aspx` 1 枚を足して WebMethod として載せる。DB は SQL Server と Oracle。
そのページをブラウザで開くと画面（[packages/web](../web)）が出るので、載せ先のログインのまま、貼り付けから反映までできる。

[C# 版（packages/server-dotnet）](../server-dotnet) をそのまま VB.NET に書き直したもので、手順、SQL、設定ファイル、ログの形、型とメンバーの名前は C# 版と同じ。
VB.NET の Web サイトの `App_Code` には C# のソースを混ぜられない（`codeSubDirectories` の設定が要る）ので、VB.NET のアプリにはこちらを置く。DLL にして `bin` に置くなら、C# 版と VB.NET 版のどちらでもよい。

- .NET Framework 4.5 以上を想定（使っている API は 4.5 の参照アセンブリでビルドを確かめている）。
- VB 11（Visual Studio 2012）で書いてあるので、Web サイト（プロジェクトファイルなし）の `App_Code` でも、.NET Framework 付属のコンパイラ（`vbc`）のまま通る。
- 参照するのは `System.Data`、`System.Configuration`、`System.Web`、`System.Web.Extensions`、`System.Core` だけ（WebForms のアプリなら入っている）。SQL Server なら NuGet は要らない。Oracle は ODP.NET Managed Driver（NuGet の `Oracle.ManagedDataAccess`）を載せ先に入れ、接続文字列に `providerName="Oracle.ManagedDataAccess.Client"` を書く（C# 版と同じ。[C# 版の「Oracle で使う」](../server-dotnet/README.md#oracle-で使う)）。
- 中身の手順は Node 版（[packages/server-node](../server-node)）と同じで、同じクライアント（`patchiri-core`）と同じテストで、C# 版と VB.NET 版の両方を通している。

## 載せ方

1. **ソースを置く**
   - Web サイト: `src/*.vb` を `App_Code/Patchiri/` に置く。
   - Web アプリケーションプロジェクト: `src/*.vb` をプロジェクトに足す。名前空間は `Namespace Global.Patchiri.Server` にしてあるので、プロジェクトのルート名前空間に関係なく `Patchiri.Server` になる。DLL にしたければ `build.cmd` で `bin\Patchiri.Server.dll` を作って参照に足す。
   - 各ファイルの先頭で `Option Strict On`、`Option Explicit On`、`Option Infer On`、`Option Compare Binary` を指定してあるので、プロジェクトや web.config の設定（`Option Strict Off`、`Option Compare Text` など）に左右されない。
2. **ページを置く**: `web/Patchiri.aspx` をアプリの中に置く（例 `Admin/Patchiri.aspx`）。名前と置き場所は自由で、`Admin/MasterUpdate.aspx` などにしてよい（ページは自分の URL を見て動く）。中身は `<WebMethod()>` が 3 つ（`PatchiriWebMethods.Call` を呼ぶ）と、ブラウザで開いたときに画面を返す `Page_Load`（`PatchiriScreen.Write` を呼ぶ）だけ。コードビハインドに移してもよい。
   - `Page_Load` は、`AutoEventWireup="false"` と `Handles Me.Load` でつないである（載せ先の web.config の `autoEventWireup` に左右されないように）。
3. **画面のファイルを置く**: C# 版と同じ（[C# 版の「載せ方」の 3](../server-dotnet/README.md#載せ方)）。`main.js`、`main.css`、`main.js.LEGAL.txt` をページの隣の `patchiri/` に置く。
4. **許可リストを置く**: `App_Data/patchiri.config.json`（例 [web/App_Data/patchiri.config.json](web/App_Data/patchiri.config.json)）。形は C# 版、Node 版と同じ（[C# 版の「設定」](../server-dotnet/README.md#設定patchiriconfigjson)）。
5. **web.config に足す**: C# 版と同じ（[C# 版の「載せ方」の 5](../server-dotnet/README.md#載せ方)）。接続文字列 `Patchiri`（Oracle なら `providerName` も）、ページへの `<authorization>`（画面と API の両方に効く）、`maxRequestLength`、`maxJsonLength`。
6. **開く**: ブラウザで `https://.../Admin/Patchiri.aspx` を開く。Edge か Chrome で開くことなど、C# 版と同じ（[C# 版の「載せ方」の 6](../server-dotnet/README.md#載せ方)）。

設定の項目（`targets`、`rules`、`limits`、`connectionStringName`、`logDir`、`exposeDbErrors`、`lockWaitSeconds`）、「誰が反映したか」とロールの判定の差し替え（`PatchiriWebMethods.WhoAmI` / `IsInRole`）、ページごとの許可リスト（`PatchiriWebMethods.Call` の 3 つ目）、反映ログとエラーのファイル、気をつけていること（varchar の列への日本語、char の埋め空白、照合順序と厳密な比較、止まる `script`、トリガー、`maxJsonLength`、real の値、パラメータの長さ、CSRF、画面のページ、Oracle のセッションの設定と数）は C# 版の README のとおり。

`Global.asax` での差し替えは VB.NET ではこう書く（Session を読むなら、ページの WebMethod を `<WebMethod(EnableSession:=True)>` に、`EnableSessionState` を `"ReadOnly"` にする）。

```vb
Sub Application_Start(sender As Object, e As EventArgs)
    PatchiriWebMethods.WhoAmI = Function(ctx) If(ctx.Session Is Nothing, Nothing, TryCast(ctx.Session("EmployeeCode"), String))
    PatchiriWebMethods.IsInRole = Function(ctx, role) ctx.Session IsNot Nothing AndAlso role = TryCast(ctx.Session("Role"), String)
End Sub
```

## VB.NET に書き直すときに気をつけたこと

C# 版から直すとき、または C# 版の変更をこちらに写すときに、そのまま書くと C# と違う動きになるところ。

- **大文字小文字を区別しない**: 引数や変数を `file`、`path` にすると `File`、`Path` のクラスが隠れる（`fileName`、`value` にしてある）。`Imports Row = Dictionary(Of String, Object)` があるファイルで `For Each row In rows` と書くと、新しい変数ではなく型の `Row` を指してしまう（`item` にしてある）。関数の中で関数と同じ名前の変数は作れず、クラスのメソッドと同じ名前の変数も使えない（`Allowed` と `allowed`、`DbKey` と `dbKey`。`allowedColumns`、`dbKeyId` にしてある）。
- **文字列の `=`**: `Nothing = ""` が `True` になる。`Nothing` と空文字を分けたいところや、大文字小文字の区別が要るところは `String.Equals(a, b, StringComparison.Ordinal)` にする。
- **数**: 整数の割り算は `\`（`/` は小数になる）。`CInt` などは切り捨てではなく偶数への丸めなので、整数だと確かめた値にだけ使う。
- **キーワードと同じ名前**: `Set`、`Get`、`Call`、`Error`、`Select` は `[Set]` のように角かっこで囲むか、別の名前にする（`ScriptUpdate.[Set]`、`PatchiriJson.[Get]`、`PatchiriWebMethods.[Call]`、`IPatchiriTransaction.Update` の引数 `[set]`）。公開メンバーの引数の名前も C# 版と同じにする（C# から名前付き引数で呼べるように）。
- **VB 11 にない書き方**: 複数行の文字列リテラル、`?.`、`NameOf`、`$"..."`、`TypeOf ... IsNot` は VB 14 から。SQL の文は `&` でつなぐ。暗黙の行継続の行末にコメントは書けない。
- **VB の関数**: `Left`、`Mid`、`Len`、`Format` などの `Microsoft.VisualBasic` の関数は使わず、.NET の `String` のメソッドを使う（Linux のテストでは VB のランタイムを埋め込んでビルドするので、使うとビルドが止まる）。`vbLf` などの定数はよい。`ControlChars` は埋め込みのランタイムにないので、`Char` の定数は `ChrW(13)` で作る（定数の式なので、ビルドのときに値になる）。逆に、`As` を書かない `For Each` の変数が VB の関数と同じ名前（`typeName` など）だと、新しい変数にならず関数を指してしまう（.NET Framework の `vbc` では止まるが、ランタイムを埋め込む Linux のビルドでは通ってしまう）。

## テスト

C# 版と同じテスト（[../server-dotnet/test/webmethod.integration.test.mjs](../server-dotnet/test/webmethod.integration.test.mjs)、カスタマイズの口を見る [../server-dotnet/test/customize.integration.test.mjs](../server-dotnet/test/customize.integration.test.mjs)、画面をブラウザで通す [../server-dotnet/test/screen.e2e.test.mjs](../server-dotnet/test/screen.e2e.test.mjs)、実際の Oracle で通す [../server-dotnet/test/oracle.integration.test.mjs](../server-dotnet/test/oracle.integration.test.mjs)）を、載せるパッケージを VB.NET 版に替えて流す。

```sh
PATCHIRI_TEST_DOTNET_PKG=packages/server-vbnet PATCHIRI_TEST_MSSQL='{"server":"localhost","user":"sa","password":"..."}' npm run test:dotnet
PATCHIRI_TEST_DOTNET_PKG=packages/server-vbnet PATCHIRI_TEST_ORACLE='{"connectString":"localhost:1521/FREEPDB1","user":"patchiri","password":"..."}' npm run test:dotnet
```

- Linux では Mono の ASP.NET で動かす（`mono-complete` と .NET SDK、画面のテストには Playwright の Chromium が要る）。DLL は `build.sh` が .NET SDK 付属の Roslyn の `vbc` で VB 11 に限ってビルドする。Mono には `vbnc` も `Microsoft.VisualBasic.dll` もないので、VB のページ（`Patchiri.aspx`）や `App_Code` は [../server-dotnet/test/mono-path/vbnc](../server-dotnet/test/mono-path/vbnc) が Roslyn の `vbc` に（VB 11 に限って）渡し、VB のランタイムは DLL に埋め込む。
- CI では加えて、Windows の IIS（.NET Framework 4.8）に `App_Code` の形（IIS が付属の `vbc` でビルドする）と `bin` の形（`build.cmd`）で載せ、Windows に入れた SQL Server で同じテストを通す。Oracle は Linux の Mono で、Oracle 23ai Free と 21c XE につないで通す（C# 版と同じ `dotnet-oracle` のジョブ）。
- テスト用の `Probe.aspx`、`OracleSessions.aspx`、`Global.asax`、`Login.aspx`、ページごとの許可リストを見るページは C# のまま使う（VB.NET の DLL の型を C# から使えることの確認にもなる）。

## ファイル

| ファイル | 役割 |
| --- | --- |
| `src/PatchiriService.vb` | API 3 本の中身（Node 版の `handlers.ts`、C# 版の `PatchiriService.cs` にあたる） |
| `src/SqlServerDialect.vb` | SQL Server の SQL（Node 版の `mssql.ts` にあたる） |
| `src/OracleDialect.vb` | Oracle の SQL（Node 版の `oracle.ts`、C# 版の `OracleDialect.cs` にあたる）。ODP.NET を名前で読み込む |
| `src/PatchiriDialect.vb` | DB ごとの違いを閉じ込める入口（ほかの DB はここに足す） |
| `src/PatchiriValues.vb` | 値の形の確認と比較（コアの `values.ts` と同じ判定） |
| `src/PatchiriConfig.vb` | 許可リストと設定の読み込み |
| `src/PatchiriRules.vb` | サーバに置く業務ルール（コアの `rules.ts`、C# 版の `PatchiriRules.cs` と同じ決まりと文） |
| `src/PatchiriWebMethods.vb` | WebMethod からの入口（ヘッダの確認、設定の読み込み、接続文字列の `providerName` で DB を選ぶ、ログイン名とロールの判定と差し替え） |
| `src/PatchiriScreen.vb` | ページをブラウザで開いたときの画面（HTML と、画面のファイルの場所） |
| `src/PatchiriFileLog.vb` | 反映ログとエラーのファイル出力 |
| `src/PatchiriJson.vb` | `JavaScriptSerializer` の形を扱う小道具 |
| `web/Patchiri.aspx` | 載せ先に置くページ（`Language="VB"`、名前は自由） |
| `build.cmd` | Windows で `bin\Patchiri.Server.dll` を作る（.NET Framework 付属の `vbc`） |
| `build.sh` | Linux で `bin/Patchiri.Server.dll` を作る（.NET SDK の Roslyn の `vbc`、テスト用） |

- `.vb` と `.aspx` は BOM 付きの UTF-8（BOM がないと ASP.NET が OS の既定の文字コード（日本語の Windows なら Shift_JIS）で読むことがあり、日本語のコメントで壊れうるため）。
