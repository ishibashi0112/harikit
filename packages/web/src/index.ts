// ほかの React アプリに harikit の画面を埋め込むための入口。
// react と @ishibashi0112/spreadsheet-grid は使う側で入れる（peerDependencies）。
// CSS は "@ishibashi0112/spreadsheet-grid/style.css" と "@harikit/web/style.css" を読む。

export { HarikitApp, type HarikitAppHandle, type HarikitAppProps } from "./App.js";
