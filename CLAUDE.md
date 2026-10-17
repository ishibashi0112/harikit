# CLAUDE.md

harikit は「Excel やグリッドの値を、検証してから DB に貼り替える道具」。自社開発の業務システム向けのマスタ一括更新ツール。

## まず読むもの

- [docs/concept.md](docs/concept.md): 困りごと、流れ、構成、決まったことと未決事項
- [docs/api-spec.md](docs/api-spec.md): サーバ API 3 本（describe / fetch / apply）の仕様

## 現状

「SQL Server、1 テーブル、UPDATE だけ」の細い道が、CLI（Excel / CSV 取込）と画面（表への貼り付け）で通ったところ。

- `packages/core`: 取込（`xlsx.ts`、`table.ts`）、検証（`validate.ts`、`values.ts`、文字コードのバイト数は `encoding.ts`）、業務ルール（`rules.ts`）、差分（`diff.ts`）、API クライアント（`client.ts`）、まとめ（`prepare.ts`）。Node の API を使わない（ブラウザで動かすため）。
- `packages/server-node`: API 3 本の中身（`handlers.ts`）、DB ごとの違い（`dialect.ts` と `mssql.ts`）、HTTP（`http.ts`）。
- `packages/server-dotnet`: API 3 本の C# 版（`src/HarikitService.cs`、`src/SqlServerDialect.cs`）と WebForms のページ（`web/Harikit.aspx`）。C# 5 で書く（App_Code で通るように）。`npm run test:dotnet` で Mono の ASP.NET と実際の SQL Server で通す。
- `packages/cli`: `harikit targets / diff / apply`。
- `packages/web`: 画面（React と `@ishibashi0112/spreadsheet-grid`）。表の 1 行目が列名で、Excel 取込と同じ `prepare` に通す。セルの印は `sheet.ts`（React に依存しない、テストあり）。esbuild で `dist/app` にまとめ、Node 版サーバが起動時に読んで `/` で配る（トークンは URL の `#token=`）。
- `npm test` でビルドとテスト。`HARIKIT_TEST_MSSQL` を渡すと実際の SQL Server でも通す（`packages/server-node/test/mssql.integration.test.ts`）。

## 構成の決まりごと

- コア（取込・検証・差分）は TypeScript で、ブラウザ側で動く Headless パッケージ。UI（Excel 取込、spreadsheet-grid 貼付、CLI）はその上に載せる。
- サーバは DB に触る API 3 本だけ。仕様を決めて中身は任意言語。参考実装は Node 版と C#（.NET Framework）版。
- C# 版は ASP.NET WebForms の WebMethod に足せることを前提にする（.NET Framework、`JavaScriptSerializer`）。

## 守ること

- 反映 API に SQL を渡す形にしない。サーバが許可リストと照合し、パラメータ付きの SQL を自分で組み立てる。値を SQL に文字列連結しない。
- 「変更前の値から変わっていないか」の確認はサーバ側でトランザクション内に行う。クライアントの差分は承認資料であって安全の根拠にしない。
- データを外部に送らない。テレメトリや外部 API 呼び出しを足さない。
- 戻し用 SQL は「今の値がこのツールで入れた値のままなら戻す」形にする。
- 未決事項（concept.md の 9 章）に関わる実装は、勝手に決めずに確認する。

## 書き方

- ドキュメントとコメントは日本語。コード上の識別子、コミットメッセージは英語。
