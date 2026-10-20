// 画面を dist/app にまとめる（index.html、main.js、main.css）。Node 版サーバがこのフォルダを配る。
// ほかのアプリに埋め込むときの CSS（@harikit/web/style.css）も dist に置く。JS は tsc が dist/src に出す。

import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist", "app");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyFile(join(here, "src", "index.html"), join(out, "index.html"));
await copyFile(join(here, "src", "style.css"), join(here, "dist", "style.css"));
await esbuild.build({
  entryPoints: { main: join(here, "src", "main.tsx") },
  outdir: out,
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  legalComments: "linked",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
