// ほかの React アプリに patchiri の画面を埋め込むための入口。
// react と @ishibashi0112/spreadsheet-grid は使う側で入れる（peerDependencies）。
// CSS は "@ishibashi0112/spreadsheet-grid/style.css" と "patchiri-web/style.css" を読む。
// 画面ごと使うなら PatchiriApp、見た目を自前で作るなら usePatchiri（流れ）と DiffGrid（差分の表）、sheet の関数（表と取込データの行き来、セルの印）。

export { PatchiriApp, DEFAULT_MESSAGES, type PatchiriAppHandle, type PatchiriAppProps, type PatchiriMessages } from "./App.js";
export { DiffGrid, type DiffGridProps } from "./DiffGrid.js";
export {
  usePatchiri,
  errorText,
  type BeforeApplyVerdict,
  type PatchiriApplied,
  type PatchiriConnection,
  type PatchiriController,
  type PatchiriPrepared,
  type UsePatchiriOptions,
} from "./usePatchiri.js";
export * from "./sheet.js";
