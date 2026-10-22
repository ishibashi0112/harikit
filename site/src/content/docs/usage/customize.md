---
title: システムに合わせる
description: 表示名、自動で入れる列、権限、画面、コアの部品など、書けば変わるところの一覧
---

patchiri は、流れ（取込・検証・差分）を持つ**コア**と、DB に触る **API 3 本の仕様**が芯で、画面と CLI はその上に載せたものです。載せ先のシステムに合わせるところは、設定か部品の口で足します。どれも書かなければ今までどおりに動きます。

## 何をどこで変えるか

| したいこと | どこで | 詳しく |
| --- | --- | --- |
| 見出しを日本語（`単価` など）で貼りたい | 許可リストの `labels`。部署ごとに呼び方が違うなら、画面とコアの `aliases` も | [許可リストと設定](/usage/config/) |
| 更新日時・更新者を自動で入れたい | 許可リストの `stamp`（`"now"` は DB の時刻、`"user"` は反映した人） | [許可リストと設定](/usage/config/) |
| 会社や拠点ごとの行だけを触らせたい | 許可リストの `scope`。部署ごとに分けるなら、ページごとの許可リスト | [許可リストと設定](/usage/config/)、[ページごとに許可リストを分ける](/servers/webforms/#ページごとに許可リストを分ける) |
| 人によって使えるテーブルを絞りたい | 許可リストの `roles` | [許可リストと設定](/usage/config/) |
| 業務ルールを利用者に外させたくない | 許可リストの `rules`（反映のときもサーバが見直す） | [サーバに置く業務ルール](/usage/config/#サーバに置く業務ルール) |
| 自前のログイン（Session）の社員番号を「誰が」にしたい | WebForms は `Global.asax` の `PatchiriWebMethods.WhoAmI` / `IsInRole`、Node 版は `startServer` の `whoAmI` / `isInRole` | [WebForms](/servers/webforms/#誰が反映したかとロール)、[Node 版](/servers/node/#ほかのアプリに組み込む) |
| 画面のタイトル、色、依頼番号の必須を決めたい | サーバの設定の `screen`。部品なら `PatchiriApp` の props | [画面の設定](/usage/config/#画面の設定) |
| 反映の前に、外の承認（稟議番号など）を確かめたい | `PatchiriApp` の `onBeforeApply`（止めた理由を画面に出せる） | 下の「画面を埋め込む」 |
| 承認した計画と同じものを反映したい | `plan.json` の指紋と、CLI の `--digest` | [CLI](/usage/cli/#patchiri-apply) |
| 表示の形（`2024/4/1`、`¥1,200`）を読み替えたくない | CLI の `--strict`、部品とコアの `readDisplay: false` | [Excel の表示のままの値](/usage/excel/) |
| 自社の決まりで行を確かめたい（ルールの形で書けないもの） | コアと部品の `checkRow` | 下の「コアで組み立てる」 |
| 誤りの文を自社の言い方にしたい | 部品の `formatIssue`（問題の `code` を見る）と `messages` | 下の「画面を埋め込む」 |
| バッチやスクリプトから流したい | CLI の `--json`、`--header`、`patchiri.cli.json` | [CLI](/usage/cli/) |
| 画面を自前で作りたい | `usePatchiri`（流れだけのフック）、`DiffGrid`、コアの関数 | 下の「画面を自前で作る」 |

## 画面を埋め込む

`patchiri-web` の `PatchiriApp` は、ほかの React アプリに置ける画面の部品です。props はどれも任意です。

```tsx
import { PatchiriClient } from "patchiri-core";
import { PatchiriApp } from "patchiri-web";

const client = new PatchiriClient({ baseUrl: "/Admin/Patchiri.aspx", style: "webmethod" });

<PatchiriApp
  client={client}
  title="単価の一括更新"
  target="product"
  theme="light"
  noteRequired="稟議番号"
  excel
  aliases={{ 品名: "ProductName" }}
  onBeforeApply={async (req, mode) => (mode === "check" || (await approved(req.note)) ? true : "この稟議番号は承認されていません")}
/>
```

- `target` を渡すと対象が決まり、「対象」を選ぶ欄は出ません。`targets` なら選べる対象を絞ります。
- `onBeforeApply` が `false` か文字列を返すと、サーバに送りません（文字列は画面に出ます）。承認を patchiri の中で持つかは決めていないので、口だけを用意しています。
- props の一覧は [packages/web の README](https://github.com/ishibashi0112/patchiri/tree/main/packages/web) にあります。

## 画面を自前で作る

見た目を自前で作るときは、流れ（つなぐ、定義を読む、検証と差分、確かめと反映）だけを持つ `usePatchiri` を使います。`PatchiriApp` もこのフックで動いています。

```tsx
import { usePatchiri, DiffGrid } from "patchiri-web";

function MyScreen({ client, sheet }) {
  const p = usePatchiri({ client, target: "product" });
  const diff = p.prepared?.result.diff;
  return (
    <>
      <button onClick={() => p.prepare(sheet)}>検証</button>
      {diff && <DiffGrid diff={diff} desc={p.description} />}
      {diff && <button onClick={() => p.apply("execute", "REQ-1234")}>反映</button>}
    </>
  );
}
```

表のセルと取込データの行き来や、検証の結果をセルの印にする関数（`toSheet`、`buildMarks`、`excelCells` など）も公開しています。

## コアで組み立てる

React を使わない画面やバッチは、`patchiri-core` から組み立てます。ブラウザでも Node でも動きます。

```ts
import { PatchiriClient, prepare, readXlsx } from "patchiri-core";

const client = new PatchiriClient({ baseUrl: "http://127.0.0.1:7357", token });
const [sheet] = await readXlsx(data);
const result = await prepare(client, "product", sheet!, {
  aliases: { 品名: "ProductName" },
  checkRow: ({ values }) => (Number(values.UnitPrice) === 0 ? [{ column: "UnitPrice", message: "0 円の商品は登録しない決まりです" }] : []),
});
for (const issue of result.issues) console.log(issue.cell, issue.code, issue.message);
```

- 問題（`issues`）には種類の `code`（`invalid_value`、`rule_violation`、`reference_missing` など）が付くので、種類ごとに扱いを変えられます。
- つなぐ先は `PatchiriApi` の形（`targets`、`describe`、`fetch`、`apply`）なら何でもかまいません。HTTP の `PatchiriClient` のほか、同じプロセスの Node 版 `Handlers` やテストの偽物も渡せます。[デモ](/guide/demo/)は、ブラウザの中の DB につないだ `fetch` を `PatchiriClient` に渡しています。
- 関数の一覧は [packages/core の README](https://github.com/ishibashi0112/patchiri/tree/main/packages/core) にあります。

## サーバを自前で作る

サーバに求めるのは [API 3 本の仕様](/reference/api-spec/)だけです。Node 版、C# 版、VB.NET 版は参考実装で、ほかの言語で作ってもかまいません。許可リストの任意の項目（`labels`、`stamp`、`scope`、`roles`、`rules`）も仕様に書いてあり、持たないサーバは返さなければよい作りです。
