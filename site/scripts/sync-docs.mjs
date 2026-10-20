// リポジトリの docs/*.md（仕様と構想）を、サイトのページとして写す。正本は docs/ のほうで、写しは git に入れない。
// 先頭の見出しを title にし、docs/ どうしのリンクをサイトの URL に直す。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docs = join(here, "..", "..", "docs");
const out = join(here, "..", "src", "content", "docs", "reference");

const PAGES = [
  { file: "api-spec.md", slug: "api-spec", description: "サーバ API 3 本（describe / fetch / apply）の仕様" },
  { file: "concept.md", slug: "concept", description: "困りごと、流れ、構成、決まったことと未決事項" },
];

const SITE_LINKS = new Map(PAGES.map((p) => [p.file, `/reference/${p.slug}/`]));
const REPO = "https://github.com/ishibashi0112/harikit/blob/main/";

/** docs/ どうしのリンクはサイトの URL、それ以外の相対リンクは GitHub の URL にする。 */
function rewriteLinks(text) {
  return text.replace(/\]\((?!https?:|#|mailto:)([^)#\s]+)(#[^)\s]*)?\)/g, (_, path, hash = "") => {
    const site = SITE_LINKS.get(path);
    return site ? `](${site}${hash})` : `](${new URL(path, REPO + "docs/").href}${hash})`;
  });
}

await mkdir(out, { recursive: true });
for (const page of PAGES) {
  const text = await readFile(join(docs, page.file), "utf8");
  const m = /^# (.+)\r?\n/.exec(text);
  if (!m) throw new Error(`${page.file} の先頭に見出しがありません`);
  const title = m[1].trim();
  const body = rewriteLinks(text.slice(m[0].length));
  const head = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(page.description)}`,
    `editUrl: ${JSON.stringify(`https://github.com/ishibashi0112/harikit/edit/main/docs/${page.file}`)}`,
    "---",
    "",
    `<!-- docs/${page.file} の写し（scripts/sync-docs.mjs）。直すときは docs/ のほうを直す。 -->`,
    "",
  ].join("\n");
  await writeFile(join(out, `${page.slug}.md`), head + body);
}
