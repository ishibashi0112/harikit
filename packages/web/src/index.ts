// ほかの React アプリに patchiri の画面を埋め込むための入口。
// react と @ishibashi0112/spreadsheet-grid は使う側で入れる（peerDependencies）。
// CSS は "@ishibashi0112/spreadsheet-grid/style.css" と "patchiri-web/style.css" を読む。

export { PatchiriApp, type PatchiriAppHandle, type PatchiriAppProps } from "./App.js";
