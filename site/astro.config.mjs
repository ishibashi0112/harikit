// patchiri のドキュメントとデモ。全部静的なファイルになり、Vercel などにそのまま置ける。
// デモ（/demo/）はブラウザの中の PostgreSQL（PGlite）で動き、サーバも DB も要らない。

import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";

export default defineConfig({
  // 公開先。正規の URL とサイトマップに使う。
  site: "https://patchiri.vercel.app",
  integrations: [
    starlight({
      title: "patchiri",
      description: "Excel やグリッドの値を検証して、DB のテーブルにぱっちりパッチを当てる道具",
      defaultLocale: "root",
      locales: { root: { label: "日本語", lang: "ja" } },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/ishibashi0112/patchiri" }],
      editLink: { baseUrl: "https://github.com/ishibashi0112/patchiri/edit/main/site/" },
      lastUpdated: false,
      logo: { src: "./src/assets/logo.svg" },
      favicon: "/favicon.svg",
      // 見出しの丸文字は手元に置く（Google Fonts などの外部には読みに行かない）。
      customCss: ["@fontsource/zen-maru-gothic/700.css", "@fontsource/zen-maru-gothic/900.css", "./src/styles/theme.css"],
      components: { Hero: "./src/components/Hero.astro" },
      expressiveCode: { styleOverrides: { borderRadius: "12px" } },
      sidebar: [
        { label: "デモを触る", link: "/demo/" },
        { label: "はじめに", items: ["guide/what", "guide/flow", "guide/demo"] },
        { label: "使い方", items: ["usage/web", "usage/cli", "usage/excel", "usage/rules", "usage/config"] },
        { label: "DB", items: ["databases/sqlserver", "databases/oracle", "databases/postgresql", "databases/mysql"] },
        { label: "サーバ", items: ["servers/node", "servers/webforms"] },
        { label: "仕様", items: ["reference/api-spec", "reference/concept"] },
      ],
    }),
    react(),
  ],
  vite: {
    // PGlite は WASM とデータのファイルを自分で読むので、Vite の事前バンドルに通さない。
    optimizeDeps: { exclude: ["@electric-sql/pglite"] },
  },
});
