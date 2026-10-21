# patchiri-web

patchiri の画面。[spreadsheet-grid](https://www.npmjs.com/package/@ishibashi0112/spreadsheet-grid) に貼り付けて、検証・差分・反映をブラウザで行う。

使い方は 2 つある。

- **同梱アプリ**（`dist/app`）: React も spreadsheet-grid も中に入った静的ファイル。Node 版サーバ（`patchiri-server-node`）が起動時に読んで `/` で配る。サーバだけを入れる人は React などを入れなくてよい。
  - WebForms に載せた C# 版・VB.NET 版では、`main.js`、`main.css`、`main.js.LEGAL.txt` をページ（`Patchiri.aspx`）の隣の `patchiri/` に置くと、ページを開いたときに画面が出る（[packages/server-dotnet](../server-dotnet) の「載せ方」）。ページは `<div id="root" data-api="/Admin/Patchiri.aspx" data-style="webmethod" data-user="…">` を書き、画面はその WebMethod に同じオリジンでつなぐ（載せ先のログインのまま）。
- **React の部品**（`PatchiriApp`）: ほかの React アプリに画面を埋め込む。

## ほかの React アプリに埋め込む

`react`（19）と `@ishibashi0112/spreadsheet-grid` は使う側で入れる（peerDependencies）。同梱アプリだけを使う人に React を入れさせないよう、どちらも optional にしてある。

```sh
npm install patchiri-web patchiri-core react react-dom @ishibashi0112/spreadsheet-grid
```

```tsx
import { useRef } from "react";
import { PatchiriClient } from "patchiri-core";
import { PatchiriApp, type PatchiriAppHandle } from "patchiri-web";
import "@ishibashi0112/spreadsheet-grid/style.css";
import "patchiri-web/style.css";

// 描くたびに作り直すとつなぎ直すので、コンポーネントの外か useMemo で作る。
const client = new PatchiriClient({ baseUrl: "/patchiri", token });

export function MasterUpdate() {
  const ref = useRef<PatchiriAppHandle>(null);
  return (
    <div style={{ height: "100vh" }}>
      <PatchiriApp
        ref={ref}
        client={client}
        serverLabel="本番 DB"
        headerExtra={<button onClick={() => ref.current?.loadCells([["ProductCode", "UnitPrice"], ["A001", "130"]])}>例を入れる</button>}
      />
    </div>
  );
}
```

| props | 意味 |
| --- | --- |
| `client` | つなぐ先（`patchiri-core` の `PatchiriClient`）。WebForms の WebMethod なら `style: "webmethod"`、ほかのつなぎ方は `fetch` を差し替える。渡さなければ、画面を配ったサーバ（同じオリジン）に URL の `#token=` でつなぐ |
| `serverLabel` | 見出しの右に「… につながっています」と出す名前。`client` を渡したときの既定は出さない |
| `headerExtra` | 見出しの右端に置くもの（ボタンなど） |
| `initialRules` | 最初に読み込んでおく業務ルール（`{ name, text }`、`patchiri.rules.json` の名前と中身）。このブラウザが覚えたものより優先する。最初に描いたときだけ読む |
| `ref` | `loadCells(cells)` で表を入れ替える。`cells` は文字列の 2 次元配列で、1 行目が見出し（列名） |

- 高さは親いっぱい（`height: 100%`）。親の高さは使う側で決める。
- CSS は `.pt-app` の中だけに効く（`body` などには触らない）。ダークは OS の設定に合わせる。
- 部品の先頭には `"use client"` を付けてある（Next.js の App Router 向け）。つなぐまでは `location` や spreadsheet-grid に触らない。
