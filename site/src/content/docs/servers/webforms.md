---
title: WebForms に載せる（C#・VB.NET）
description: 既存の ASP.NET WebForms のアプリに、API 3 本と画面を足す
---

既存の ASP.NET WebForms のアプリに、ソースと `.aspx` 1 枚を足して、API 3 本を WebMethod として載せます。そのページをブラウザで開くと画面が出るので、載せ先のアプリにログインしたまま、貼り付けから反映までできます。認証と権限は載せ先のアプリのものをそのまま使うので、patchiri 自体はユーザー管理を持ちません。今は SQL Server だけです。

| | C# 版 | VB.NET 版 |
| --- | --- | --- |
| ソース | `packages/server-dotnet/src/*.cs` | `packages/server-vbnet/src/*.vb` |
| 言語 | C# 5 | VB 11 |
| 向いているアプリ | C# のアプリ | VB.NET のアプリ（Web サイトの `App_Code` には C# を混ぜられないため） |

- .NET Framework 4.5 以上。参照するのは `System.Data`、`System.Configuration`、`System.Web`、`System.Web.Extensions`（VB.NET 版は `System.Core` も）だけで、NuGet は要りません。
- Web サイト（プロジェクトファイルなし）の `App_Code` でも、.NET Framework 付属のコンパイラのまま通ります。
- CI では Windows の IIS と .NET Framework 4.8 に、`App_Code` と `bin`（DLL）の両方の形で載せ、実際の SQL Server でテストしています。画面も Edge でログインから反映まで通しています。

## 載せ方

1. **ソースを置く**: Web サイトなら `App_Code/Patchiri/` に、Web アプリケーションプロジェクトならプロジェクトに足します。DLL にしたければ `build.cmd` で `bin\Patchiri.Server.dll` を作ります。
2. **ページを置く**: `web/Patchiri.aspx` をアプリの中に置きます（例 `Admin/Patchiri.aspx`）。名前と置き場所は自由で、`Admin/MasterUpdate.aspx` などにしてもかまいません。
3. **画面のファイルを置く**: 画面（`patchiri-web` の `dist/app`）の `main.js`、`main.css`、`main.js.LEGAL.txt` を、ページの隣の `patchiri/` に置きます（例 `Admin/patchiri/main.js`）。置き場所は web.config の `appSettings` の `patchiri:assets`（例 `~/Scripts/patchiri/`）で変えられます。
4. **許可リストを置く**: `App_Data/patchiri.config.json`。`targets` と `limits` の形は Node 版と同じです（[許可リストと設定](/usage/config/)）。
5. **web.config に足す**:

```xml
<configuration>
  <connectionStrings>
    <!-- patchiri 用のログイン。readable の列の SELECT と、updatable の列だけの UPDATE を許す。 -->
    <add name="Patchiri" connectionString="Server=...;Database=...;Integrated Security=SSPI" />
  </connectionStrings>

  <!-- 認証と権限はこのページに掛ける。画面と API の両方に効く。 -->
  <location path="Admin/Patchiri.aspx">
    <system.web>
      <authorization>
        <allow roles="MasterAdmin" />
        <deny users="*" />
      </authorization>
      <httpRuntime maxRequestLength="51200" />
    </system.web>
  </location>

  <!-- WebMethod が受け取り・返せる JSON の長さ。既定のままだと大きな反映の結果を返せない。 -->
  <system.web.extensions>
    <scripting>
      <webServices>
        <jsonSerialization maxJsonLength="52428800" />
      </webServices>
    </scripting>
  </system.web.extensions>
</configuration>
```

6. **開く**: ブラウザで `https://…/Admin/Patchiri.aspx` を開きます。載せ先にログインしていれば、そのまま画面が出ます（使い方は [画面で使う](/usage/web/)）。見出しの右には、反映ログに残るログイン名が出ます。

## 設定（App_Data/patchiri.config.json）

| 項目 | 意味 | 既定 |
| --- | --- | --- |
| `targets` | 許可リスト。Node 版とそのまま写せる | （必須） |
| `limits` | `maxFetchKeys`、`maxApplyRows` | 1000、5000 |
| `connectionStringName` | web.config の `connectionStrings` の名前 | `Patchiri` |
| `logDir` | 反映ログのフォルダ | `~/App_Data/patchiri-log` |
| `exposeDbErrors` | エラーの文に DB の生のエラー文を出すか | `false` |
| `lockWaitSeconds` | 反映で行のロックを待つ秒数 | `10` |

反映した人（`appliedBy`）は、載せ先の認証が決めた名前（`HttpContext.Current.User.Identity.Name`）になります。

## 画面について

- Edge か Chrome で開いてください。Internet Explorer と Edge の IE モードでは動きません（その旨の案内が出ます）。載せ先のアプリが IE モードのサイト一覧に入っているときは、このページを外してください。
- ログインが切れたら（フォーム認証のタイムアウトなど）、画面は貼った表を残したまま案内を出します。別のタブでログインし直せば、元のタブでそのまま続けられます。
- 画面は同じページの WebMethod を呼ぶので、ほかから呼ぶときの設定も同じです（`{ baseUrl: "/Admin/Patchiri.aspx", style: "webmethod" }`）。CLI は載せ先のログインを通せないので、業務では画面を使ってください。

詳しくは [C# 版の README](https://github.com/ishibashi0112/patchiri/tree/main/packages/server-dotnet) と [VB.NET 版の README](https://github.com/ishibashi0112/patchiri/tree/main/packages/server-vbnet) を見てください。
