# CLAUDE.md

patchiri（パッチリ）は「Excel やグリッドの値を検証して、DB のテーブルにぱっちりパッチを当てる道具」。旧名 harikit。名前は常に小文字で書く。自社開発の業務システム向けのマスタ一括更新ツール。

## まず読むもの

- [docs/concept.md](docs/concept.md): 困りごと、流れ、構成、決まったことと未決事項
- [docs/api-spec.md](docs/api-spec.md): サーバ API 3 本（describe / fetch / apply）の仕様

## 現状

「SQL Server、Oracle、PostgreSQL、MySQL / MariaDB の 1 テーブル、UPDATE だけ」の細い道が、CLI（Excel / CSV 取込）と画面（表への貼り付け）で通ったところ。SQL Server 以外は Node 版サーバだけ。

- `packages/core`: 取込（`xlsx.ts`、`table.ts`）、検証（`validate.ts`、`values.ts`、Excel の表示の形（2024/4/1、¥1,200 など）の読み替えは `display.ts`、文字コードのバイト数は `encoding.ts`）、業務ルール（`rules.ts`）、差分（`diff.ts`）、API クライアント（`client.ts`）、まとめ（`prepare.ts`）。Node の API を使わない（ブラウザで動かすため）。
- `packages/server-node`: API 3 本の中身（`handlers.ts`）、DB ごとの違い（`dialect.ts` と `mssql.ts`、`oracle.ts`、`postgres.ts`、`mysql.ts`）、HTTP（`http.ts`）。Oracle は node-oracledb の Thin モード。`postgres.ts` は pg を import しない（つなぎは `pg-pool.ts`。`PgConnector` を差し替えればブラウザの PGlite でも動く）。MySQL と MariaDB は同じ `mysql.ts`（mysql2）。
- `packages/server-dotnet`: API 3 本の C# 版（`src/PatchiriService.cs`、`src/SqlServerDialect.cs`）と WebForms のページ（`web/Patchiri.aspx`）。C# 5 で書く（App_Code で通るように）。`npm run test:dotnet` で Mono の ASP.NET と実際の SQL Server で通す。CI では同じテストを Windows の IIS でも流す（`test/host.mjs` の `PATCHIRI_TEST_DOTNET_HOST=iis`）。
- `packages/server-vbnet`: C# 版を VB.NET に書き直したもの（`src/*.vb`、`web/Patchiri.aspx`）。VB 11 で書き、型とメンバーの名前は C# 版と同じにする。C# 版を直したらこちらも直す。テストは C# 版と同じもので、`PATCHIRI_TEST_DOTNET_PKG=packages/server-vbnet npm run test:dotnet`（.NET SDK の Roslyn の vbc でビルドする）。
- `packages/cli`: `patchiri targets / diff / apply`。
- `packages/web`: 画面（React と `@ishibashi0112/spreadsheet-grid`）。表の 1 行目が列名で、Excel 取込と同じ `prepare` に通す。セルの印は `sheet.ts`（React に依存しない、テストあり）。esbuild で `dist/app` にまとめ、Node 版サーバが起動時に読んで `/` で配る（トークンは URL の `#token=`）。ほかの React アプリ向けに `PatchiriApp`（`index.ts`、`client` を渡せる）と `style.css` も出す。react と spreadsheet-grid は optional な peerDependencies（同梱アプリには丸ごと入るので、サーバだけ入れる人には要らない）。CSS は `.pt-app` の中に閉じ、ページ全体の指定は同梱アプリだけの `page.css`。
- `npm test` でビルドとテスト。`PATCHIRI_TEST_MSSQL` を渡すと実際の SQL Server でも、`PATCHIRI_TEST_ORACLE` を渡すと実際の Oracle でも、`PATCHIRI_TEST_POSTGRES` / `PATCHIRI_TEST_MYSQL` を渡すと実際の PostgreSQL / MySQL・MariaDB でも通す（`packages/server-node/test/*.integration.test.ts`。CI は PostgreSQL 14 / 18、MySQL 8.0 / 8.4、MariaDB 10.11 / 11.4）。

## 構成の決まりごと

- コア（取込・検証・差分）は TypeScript で、ブラウザ側で動く Headless パッケージ。UI（Excel 取込、spreadsheet-grid 貼付、CLI）はその上に載せる。
- サーバは DB に触る API 3 本だけ。仕様を決めて中身は任意言語。参考実装は Node 版と C#（.NET Framework）版。
- C# 版と VB.NET 版は ASP.NET WebForms の WebMethod に足せることを前提にする（.NET Framework、`JavaScriptSerializer`）。

## 守ること

- 反映 API に SQL を渡す形にしない。サーバが許可リストと照合し、パラメータ付きの SQL を自分で組み立てる。値を SQL に文字列連結しない。
- 「変更前の値から変わっていないか」の確認はサーバ側でトランザクション内に行う。クライアントの差分は承認資料であって安全の根拠にしない。
- データを外部に送らない。テレメトリや外部 API 呼び出しを足さない。
- 戻し用 SQL は「今の値がこのツールで入れた値のままなら戻す」形にする。
- 未決事項（concept.md の 9 章）に関わる実装は、勝手に決めずに確認する。

## 書き方

- ドキュメントとコメントは日本語。コード上の識別子、コミットメッセージは英語。
