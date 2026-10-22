// デモの DB（文房具の商品マスタ）と、patchiri の設定（許可リスト・業務ルール）、貼り付けるサンプル。
// 形は examples/ の SQL Server・Oracle の例と同じで、名前だけ PostgreSQL の流儀（小文字のスネークケース）にしてある。

import type { TargetConfig } from "patchiri-server-node";

export const SCHEMA_SQL = `
DROP TABLE IF EXISTS m_product;
DROP TABLE IF EXISTS m_category;
CREATE TABLE m_category (
  category_code varchar(4) PRIMARY KEY,
  category_name varchar(20) NOT NULL
);
CREATE TABLE m_product (
  product_code varchar(10) PRIMARY KEY,
  product_name varchar(50) NOT NULL,
  category_code varchar(4) NOT NULL CONSTRAINT fk_m_product_category REFERENCES m_category (category_code),
  unit_price numeric(9,2),
  release_date date,
  on_sale boolean NOT NULL DEFAULT true,
  updated_at timestamp(3) NOT NULL DEFAULT localtimestamp(3)
);
`;

const CATEGORIES: [string, string][] = [
  ["C01", "筆記具"],
  ["C02", "ノート"],
  ["C03", "ファイル"],
  ["C04", "のり・テープ"],
  ["C05", "はさみ・カッター"],
];

/** [コード, 名前, 分類, 価格（null は未定）, 発売日（null は不明）, 販売中] */
const PRODUCTS: [string, string, string, number | null, string | null, boolean][] = [
  ["A001", "ボールペン 黒", "C01", 120, "2024-04-01", true],
  ["A002", "ボールペン 赤", "C01", null, "2024-04-01", true],
  ["A003", "シャープペン 0.5mm", "C01", 300, null, true],
  ["A004", "シャープペン替芯 HB", "C01", 110, "2022-02-01", true],
  ["A005", "蛍光ペン 黄", "C01", 100, "2023-06-01", true],
  ["A006", "蛍光ペン 緑", "C01", 100, "2023-06-01", true],
  ["A007", "油性マーカー 黒 太字", "C01", 150, "2021-09-01", true],
  ["A008", "消しゴム", "C01", 80, "2020-04-01", true],
  ["A009", "万年筆 細字", "C01", 3500, "2019-11-01", false],
  ["B001", "大学ノート A4", "C02", 180, "2023-10-01", true],
  ["B002", "方眼ノート", "C02", 220, "2023-10-01", true],
  ["B003", "大学ノート B5 5冊パック", "C02", 650, "2024-01-15", true],
  ["B004", "ルーズリーフ A4 100枚", "C02", 400, "2022-03-01", true],
  ["B005", "メモ帳 A7", "C02", 90, "2021-05-01", true],
  ["B006", "付箋 75mm 黄", "C02", 160, "2023-04-01", true],
  ["B007", "らくがき帳", "C02", 200, "2018-07-01", false],
  ["C001", "クリアファイル A4 10枚", "C03", 280, "2022-08-01", true],
  ["C002", "リングファイル A4 2穴", "C03", 450, "2021-12-01", true],
  ["C003", "フラットファイル 青", "C03", 70, "2020-01-01", true],
  ["C004", "ドキュメントケース", "C03", 980, "2024-06-01", true],
  ["C005", "クリアブック 40ポケット", "C03", 720, "2023-02-01", true],
  ["D001", "スティックのり", "C04", 130, "2022-04-01", true],
  ["D002", "液体のり", "C04", 160, "2022-04-01", true],
  ["D003", "テープのり 詰め替え", "C04", 280, "2023-09-01", true],
  ["D004", "セロハンテープ 18mm", "C04", 120, "2019-04-01", true],
  ["D005", "マスキングテープ 3色", "C04", 380, "2024-03-01", true],
  ["E001", "はさみ 155mm", "C05", 480, "2021-03-01", true],
  ["E002", "カッターナイフ 小", "C05", 220, "2020-10-01", true],
  ["E003", "カッター替刃 10枚", "C05", 180, "2020-10-01", true],
  ["E004", "カッティングマット A4", "C05", 900, "2022-11-01", true],
];

function lit(v: string | number | boolean | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

export const DATA_SQL = [
  `INSERT INTO m_category (category_code, category_name) VALUES\n${CATEGORIES.map((c) => `  (${c.map(lit).join(", ")})`).join(",\n")};`,
  `INSERT INTO m_product (product_code, product_name, category_code, unit_price, release_date, on_sale, updated_at) VALUES\n${PRODUCTS.map(
    ([code, name, cat, price, date, onSale]) => `  (${[code, name, cat, price, date, onSale].map(lit).join(", ")}, '2026-04-01 09:00:00')`,
  ).join(",\n")};`,
].join("\n");

/** デモの DB を作り直す SQL（テーブルを消して、最初のデータを入れる）。 */
export const SEED_SQL = `${SCHEMA_SQL}\n${DATA_SQL}\n`;

/** サーバの許可リスト（patchiri.config.json の targets）。 */
export const TARGETS: Record<string, TargetConfig> = {
  product: {
    table: "public.m_product",
    access: "update",
    key: ["product_code"],
    readable: ["product_code", "product_name", "category_code", "unit_price", "release_date", "on_sale", "updated_at"],
    updatable: ["product_name", "category_code", "unit_price", "release_date", "on_sale"],
    labels: {
      product_code: "商品コード",
      product_name: "商品名",
      category_code: "分類コード",
      unit_price: "単価",
      release_date: "発売日",
      on_sale: "販売中",
      updated_at: "更新日時",
    },
    // 更新日時は、反映する行ごとにサーバが DB の時刻を入れる。
    stamp: { updated_at: "now" },
  },
  category: {
    table: "public.m_category",
    access: "read",
    key: ["category_code"],
    readable: ["category_code", "category_name"],
    labels: { category_code: "分類コード", category_name: "分類名" },
  },
};

/** 業務ルール（patchiri.rules.json）。デモでは最初から読み込んでおく。 */
export const RULES = {
  targets: {
    product: [
      { column: "unit_price", greaterThan: 0, message: "価格は 0 より大きくしてください" },
      { column: "unit_price", maxChangePercent: 50, severity: "warning" },
      { column: "product_code", pattern: "^[A-Z][0-9]{3}$", message: "商品コードは英大文字 1 字と数字 3 桁です" },
    ],
  },
};

/**
 * 「ほかの人が書き換える」で、patchiri の外から列の値を変える式（列は前のほうを優先する）。
 * 列名と式はここに書いた固定の文字列だけで、値は SQL に入れない。
 */
export const OTHER_EDITS: Record<string, string> = {
  unit_price: "COALESCE(unit_price, 0) + 7",
  product_name: "left(product_name || '（改）', 50)",
  release_date: "COALESCE(release_date, DATE '2020-01-01') + 1",
  category_code: "CASE category_code WHEN 'C01' THEN 'C02' ELSE 'C01' END",
  on_sale: "NOT on_sale",
};

export interface Sample {
  id: string;
  label: string;
  description: string;
  cells: string[][];
}

/** 表に入れるサンプル。Excel からコピーしたときと同じく、セルは表示どおりの文字列。 */
export const SAMPLES: Sample[] = [
  {
    id: "price",
    label: "価格改定（通る）",
    description: "値上げと名前の直し。見出しは表示名で、¥ や桁区切り、和暦の日付は Excel の表示のまま。同じ値の行と、DB に無いコードも混ぜてある。",
    cells: [
      ["商品コード", "商品名", "単価", "発売日"],
      ["A001", "ボールペン 黒", "¥130", "2024/4/1"],
      ["A002", "ボールペン 赤", "¥130", "2024/4/1"],
      ["A003", "シャープペン 0.5mm", "330", ""],
      ["A005", "蛍光ペン 黄", "110", "2023/6/1"],
      ["B001", "大学ノート A4", "290", "2023/10/1"],
      ["B002", "方眼ノート", "220", "2023/10/1"],
      ["C001", "クリアファイル A4 10枚入", "300", "令和4年8月1日"],
      ["C004", "ドキュメントケース", "1,080円", "2024/6/1"],
      ["E001", "はさみ 155mm", "480", "2021/3/1"],
      ["Z999", "新商品（まだ無い）", "500", "2026/4/1"],
    ],
  },
  {
    id: "errors",
    label: "誤りあり（直してみる）",
    description: "桁あふれ、必須の空、無い分類、読めない日付、業務ルール違反など。赤いセルを直して、もう一度検証する。",
    cells: [
      ["product_code", "product_name", "category_code", "unit_price", "release_date"],
      ["A001", "ボールペン 黒", "C01", "-10", "2024/4/1"],
      ["A002", "", "C01", "130", "2024/4/1"],
      ["A003", "シャープペン 0.5mm", "C09", "330", ""],
      ["A004", "シャープペン替芯 HB（0.5mm・0.7mm 兼用の大容量パック、40本入り×2個セット、詰め替えケース付き）", "C01", "110", "2022/2/1"],
      ["A005", "蛍光ペン 黄", "C01", "12.5%", "2023/6/1"],
      ["A006", "蛍光ペン 緑", "C01", "100", "6/1/2023"],
      ["a07", "油性マーカー 黒 太字", "C01", "150", "2021/9/1"],
      ["B001", " 大学ノート A4", "C02", "180", "2023/10/1"],
    ],
  },
];
