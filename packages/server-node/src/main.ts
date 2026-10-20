#!/usr/bin/env node
// patchiri-server --config patchiri.config.json

import { parseArgs } from "node:util";
import { loadConfig } from "./load-config.js";
import { startServer } from "./start.js";

const { values } = parseArgs({ options: { config: { type: "string", short: "c", default: "patchiri.config.json" } } });
const config = await loadConfig(values.config!);
const running = await startServer(config, { token: process.env.PATCHIRI_TOKEN || undefined });
console.log(`patchiri サーバを起動しました: ${running.url}`);
console.log(running.webUrl ? `画面: ${running.webUrl}` : "画面はありません（npm run build で packages/web を作ると / で配ります）");
console.log(`トークン: ${running.token}`);
console.log("（CLI には PATCHIRI_TOKEN として渡してください。止めるときは Ctrl+C）");
const stop = () => void running.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
