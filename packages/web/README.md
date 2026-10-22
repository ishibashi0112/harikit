# patchiri-web

patchiri の画面。[spreadsheet-grid](https://www.npmjs.com/package/@ishibashi0112/spreadsheet-grid) に貼り付けて、検証・差分・反映をブラウザで行う。

使い方は 2 つある。

- **同梱アプリ**（`dist/app`）: React も spreadsheet-grid も中に入った静的ファイル。Node 版サーバ（`patchiri-server-node`）が起動時に読んで `/` で配る。サーバだけを入れる人は React などを入れなくてよい。
  - WebForms に載せた C# 版・VB.NET 版では、`main.js`、`main.css`、`main.js.LEGAL.txt` をページ（`Patchiri.aspx`）の隣の `patchiri/` に置くと、ページを開いたときに画面が出る（[packages/server-dotnet](../server-dotnet) の「載せ方」）。ページは `<div id="root" data-api="/Admin/Patchiri.aspx" data-style="webmethod" data-user="…">` を書き、画面はその WebMethod に同じオリジンでつなぐ（載せ先のログインのまま）。
  - タイトル、色、メモの必須、「Excel を開く」、足す CSS は、サーバの設定ファイルの `screen` で決める（下の「同梱アプリの設定」）。
- **React の部品**（`PatchiriApp`）: ほかの React アプリに画面を埋め込む。
- **フックと部品**（`usePatchiri`、`DiffGrid`、`sheet` の関数）: 見た目を自前で作る。

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
| `ref` | `loadCells(cells)` で表を入れ替える。`cells` は文字列の 2 次元配列で、1 行目が見出し（列名か表示名） |

ここから下はどれも任意で、渡さなければ今までと同じ。

| props | 意味 |
| --- | --- |
| `title` | 見出しの左の名前。既定は「patchiri」 |
| `target` | 対象を決めておく（許可リストのターゲット名）。「対象」を選ぶ欄を出さない |
| `targets` | 「対象」で選べるターゲットを絞る |
| `theme` | `"auto"`（既定。OS に合わせる）、`"light"`、`"dark"` |
| `storageKey` | このブラウザに覚えるもの（選んだ対象、業務ルールのファイル）のキーの頭。既定は `"patchiri"`。`null` なら何も覚えない。1 つのオリジンに画面を 2 つ置くときは分ける |
| `rulesFile` | `false` なら手元の業務ルールのファイルを選ばせない（サーバに置いたルールと `initialRules` だけ） |
| `excel` | `true` で「Excel を開く」を出す（.xlsx をブラウザの中で読み、シートと見出しの行を選んで表に入れる。見出しの行は当てる。ターゲットの列に当たらない列は外せる）。既定は出さない |
| `aliases` | 見出しの別名（`{ "品名": "ProductName" }`）。サーバの表示名（`labels`）に加えて使う |
| `readDisplay` | `false` で Excel の表示の形（2024/4/1、¥1,200）を読み替えない |
| `checkRow` | 行ごとの自前の確かめ（`patchiri-core` の `validate` と同じ）。返した問題はセルに印が付く |
| `formatIssue` | 問題の文を言い換える（`Issue` の `code` と `params` を見る）。`undefined` を返せば元の文 |
| `noteRequired` | メモを書かないと「DB で確かめる」「反映する」を押せない。文字列なら欄の名前（`"依頼番号"`） |
| `messages` | 文言の差し替え（`pasteHelp`、`pasteHint`、`noteLabel`、`confirmApply`。`confirmApply` の `{rows}` は行数） |
| `onPrepared` | 検証したとき（`(result, target)`） |
| `onBeforeApply` | 「DB で確かめる」「反映する」でサーバに送る直前（`(request, mode)`）。`false` か文字列（止めた理由。画面に出す）を返すと送らない。外の承認の確かめなどに使う |
| `onApplied` | サーバが確かめた、または反映したとき（`(response, mode)`） |

- 高さは親いっぱい（`height: 100%`）。親の高さは使う側で決める。
- CSS は `.pt-app` の中だけに効く（`body` などには触らない）。色は `.pt-app` の変数（`--pt-accent` など）を上書きする。ダークは OS の設定に合わせるか、`theme` で決める（`.pt-app[data-theme="dark"]`）。
- 部品の先頭には `"use client"` を付けてある（Next.js の App Router 向け）。つなぐまでは `location` や spreadsheet-grid に触らない。
- 許可リストに表示名（`labels`）があれば、右の欄と差分の見出しに出し、見出しにも使える。自動で入る列（`stamp`）と触れる行の範囲（`scope`）は右の欄に、サーバに置いた業務ルールは「業務ルール」に外せないものとして出る。

## 見た目を自前で作る

流れ（つなぐ、対象の定義を読む、検証と差分、確かめと反映）は `usePatchiri` が持つ。表の値を `patchiri-core` の `Sheet`（1 行目が見出し）にして `prepare` に渡す。

```tsx
import { usePatchiri, DiffGrid } from "patchiri-web";

function MyScreen({ client, sheet }) {
  const p = usePatchiri({ client, target: "product", onBeforeApply: (req) => (req.note ? true : "依頼番号を書いてください") });
  if (p.connection.state !== "ready" || !p.description) return <p>つないでいます…</p>;
  const diff = p.prepared?.result.diff;
  return (
    <>
      <button onClick={() => p.prepare(sheet)} disabled={p.preparing}>検証</button>
      {p.prepared?.result.issues.map((i, n) => <p key={n}>{i.message}</p>)}
      {diff && <div style={{ height: 400 }}><DiffGrid diff={diff} desc={p.description} /></div>}
      {diff && <button onClick={() => p.apply("execute", "REQ-1234")}>反映</button>}
      {p.applied?.state === "failed" && <p>{p.applied.failure.error.message}</p>}
      {p.error && <p>{p.error}</p>}
    </>
  );
}
```

| 返すもの | 意味 |
| --- | --- |
| `connection` | `idle`（`client` がない）、`connecting`、`ready`（`targets` は更新できるターゲット）、`failed`（`error`、`message`） |
| `target`、`setTarget` | 選んでいる対象（`target` を渡したときは変わらない） |
| `description` | 対象の定義（describe）。読んでいる間は `null` |
| `prepare(sheet)` | 検証して差分を取る。結果は `prepared`（`result`、`requestId`、`at`）。対象を変えると捨てる |
| `apply(mode, note?)` | `prepared` の差分を確かめる（`"check"`）か反映する（`"execute"`）。結果は `applied`。確かめと反映は同じ `requestId` |
| `error`、`clearError` | 定義が読めない、検証に失敗した、などの文 |

- オプションは `PatchiriApp` の同じ名前の props と同じ（`target`、`targets`、`rules`、`aliases`、`readDisplay`、`checkRow`、`formatIssue`、`onPrepared`、`onBeforeApply`、`onApplied`）。ほかに `initialTarget`（最初に選ぶ対象）。
- `DiffGrid` は差分を前後に並べた読むだけの表（spreadsheet-grid の CSS が要る）。`desc` を渡すと見出しが表示名になる。
- `sheet` の関数（`toSheet`、`rowsFromCells`、`buildMarks`、`liveMark`、`headerInfo`、`diffGridRows`、`cellString`、`excelCells`、`guessHeaderRow` など）は React に依らない。表のセルと取込データの行き来、検証の結果をセルの印にするのに使う。
- `errorText(e)` は呼び出しの失敗を画面に出す文にする（ログインが切れた、サーバに届かない、など）。

## 同梱アプリの設定

Node 版サーバと C#・VB.NET 版のページが配る画面は、サーバの設定ファイル（`patchiri.config.json`）の `screen` で決める。ページは `#root` の `data-title`、`data-theme`、`data-note-required`、`data-excel` で渡す。

```json
"screen": { "title": "単価の一括更新", "theme": "light", "noteRequired": "依頼番号", "excel": true, "css": "patchiri.screen.css" }
```

| 項目 | 意味 | 既定 |
| --- | --- | --- |
| `title` | 見出しとブラウザのタブの名前 | `patchiri` |
| `theme` | `"auto"`、`"light"`、`"dark"` | `"auto"` |
| `noteRequired` | `true` か欄の名前で、メモを書かないと反映できない | 任意 |
| `excel` | 「Excel を開く」を出すか | 出す |
| `css` | 画面に足す CSS のファイル（設定ファイルのフォルダから）。色の変数の上書きに使う（`.pt-app { --pt-accent: #0b7a75; }`） | なし |
