---
title: デモについて
description: デモで何が動いているか、何を試せるか
---

[デモ](/demo/)は、patchiri の画面を、**ブラウザの中で動く PostgreSQL**（[PGlite](https://pglite.dev/)）につないだものです。サーバも DB も要らず、データはそのタブの外に出ません。タブを閉じるか再読み込みすると、DB は最初の状態に戻ります。

## 何が本物か

画面（`patchiri-web`）、コア（`patchiri-core`）、サーバ API の中身（Node 版の `Handlers`）、PostgreSQL の方言は、本物のサーバと同じコードです。違うのは、画面とサーバの間が HTTP ではなく、同じタブの中の関数呼び出しになっているところだけです。

```
画面 ─ PatchiriClient ─(fetch を差し替え)─ Handlers ─ PostgreSQL の方言 ─ PGlite（WASM の PostgreSQL）
```

なので、検証で出るエラー、差分、反映で掛けるロックと値の確かめ方、返ってくる SQL と戻し SQL は、本物の [PostgreSQL](/databases/postgresql/) につないだときと同じです。

## 触り方

1. 見出しの「サンプル」で、表に値を入れます。Excel からコピーして表の A1 に貼っても同じです。
   - **価格改定（通る）**: 見出しは表示名（`商品コード`、`単価` など）です。`¥130`、`1,280`、`令和4年8月1日` のような Excel の表示のままの値、同じ値の行、DB に無いコードが混ざっています。
   - 手元の `.xlsx` は「Excel を開く」で入れられます（ファイルはブラウザの中で読みます）。
   - **誤りあり（直してみる）**: 桁あふれ、必須の空、無い分類コード、読めない日付、業務ルール違反などが混ざっています。赤いセルを直して、もう一度検証してみてください。
2. 右の「検証して差分を見る」を押します。誤りがなければ「差分」のタブが開きます。
3. 「DB で確かめる」を押してから、「反映する」を押します。
4. 見出しの「DB の中身」で、反映した値（色の付いたセル）を確かめます。更新日時（`updated_at`）は、サーバが反映した時刻を入れています。「SQL を流す」のタブで「直近の戻し SQL を入れる」→「流す」と、反映した行が元に戻ります。

## 試すとよいこと

- **反映を止める安全装置**: 「DB で確かめる」の後に、見出しの「ほかの人が書き換える」を押してから「反映する」を押してください。patchiri の外で差分の行の値が変わったので、何も反映せずに止まり、表のキーのセルに印が付きます。
- **戻し SQL が上書きしないこと**: 反映した後に「ほかの人が書き換える」と同じことを SQL のタブで行い（例 `UPDATE m_product SET unit_price = 999 WHERE product_code = 'A001';`）、それから戻し SQL を流すと、その行だけ飛ばして知らせが出ます。
- **業務ルール**: デモでは `patchiri.rules.json` を最初から読み込んであります（価格は 0 より大きい、変動は 50% まで（警告）、商品コードの形）。

## 本物と違うところ

- ロック待ちは試せません（PGlite はつなぎが 1 本なので、ほかのセッションがありません）。
- 反映ログはファイルではなく、「DB の中身」の「反映ログ」のタブに出ます。
- 反映した人は「デモの利用者」になります（Node 版サーバは OS のユーザー名、WebForms 版はログインしている人）。

## デモの DB

```sql
CREATE TABLE m_category (
  category_code varchar(4) PRIMARY KEY,
  category_name varchar(20) NOT NULL
);
CREATE TABLE m_product (
  product_code varchar(10) PRIMARY KEY,
  product_name varchar(50) NOT NULL,
  category_code varchar(4) NOT NULL REFERENCES m_category (category_code),
  unit_price numeric(9,2),
  release_date date,
  on_sale boolean NOT NULL DEFAULT true,
  updated_at timestamp(3) NOT NULL DEFAULT localtimestamp(3)
);
```

許可リストでは、`m_product` の `product_name`、`category_code`、`unit_price`、`release_date`、`on_sale` を更新でき、`updated_at` は反映する行ごとにサーバが DB の時刻を入れます（`stamp`）。列には表示名（`labels`）を付けてあります。`m_category` は外部キーの参照先として読むだけです。

```json
"product": {
  "table": "public.m_product",
  "access": "update",
  "key": ["product_code"],
  "readable": ["product_code", "product_name", "category_code", "unit_price", "release_date", "on_sale", "updated_at"],
  "updatable": ["product_name", "category_code", "unit_price", "release_date", "on_sale"],
  "labels": { "product_code": "商品コード", "unit_price": "単価", "…": "…" },
  "stamp": { "updated_at": "now" }
}
```
