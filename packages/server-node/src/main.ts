#!/usr/bin/env node
// harikit-server --config harikit.config.json

import { parseArgs } from "node:util";
import { loadConfig } from "./load-config.js";
import { startServer } from "./start.js";

const { values } = parseArgs({ options: { config: { type: "string", short: "c", default: "harikit.config.json" } } });
const config = await loadConfig(values.config!);
const running = await startServer(config, { token: process.env.HARIKIT_TOKEN || undefined });
console.log(`harikit サーバを起動しました: ${running.url}`);
console.log(running.webUrl ? `画面: ${running.webUrl}` : "画面はありません（npm run build で packages/web を作ると / で配ります）");
console.log(`トークン: ${running.token}`);
console.log("（CLI には HARIKIT_TOKEN として渡してください。止めるときは Ctrl+C）");
const stop = () => void running.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
