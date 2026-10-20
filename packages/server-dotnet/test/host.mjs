// .NET 版サーバの結合テストで、ページを載せる Web のフォルダを作り、ASP.NET で動かす。
//
// 動かす場所（HARIKIT_TEST_DOTNET_HOST）:
//   mono（既定）: Mono の ASP.NET（test/TestHost.cs）。Linux の CI とクラウドのコンテナ向け。mono と mcs が要る。
//         VB.NET 版（packages/server-vbnet）は .NET SDK も要る（build.sh と mono-path/vbnc が Roslyn の vbc でビルドする）。
//   iis: Windows の IIS に .NET Framework 4.x のアプリとして載せる。IIS と ASP.NET 4.x を入れ、管理者で動かすこと。
//        既定の Web サイト（Default Web Site、80 番）の下に、テストごとにアプリとアプリプールを作って消す。
// 載せ方（HARIKIT_TEST_DOTNET_LAYOUT）:
//   bin（既定）: build.cmd（Windows）か build.sh で作った bin の DLL を置く（Web アプリケーションプロジェクトの形）。
//   app_code: src のソースを App_Code/Harikit/ に置き、ASP.NET にビルドさせる（Web サイトの形。IIS なら .NET Framework 付属のコンパイラ）。
// 載せるサーバ（HARIKIT_TEST_DOTNET_PKG）: リポジトリの中のパッケージのフォルダ。既定は packages/server-dotnet。
//   パッケージには src/（ソース）、web/Harikit.aspx、build.cmd と build.sh（bin/ に DLL を作る）を置く。
//   公開する型が C# 版と同じなら、C# のページ（test/Probe.aspx など）をその DLL の上でも使える。
//   Ubuntu の Mono には VB のコンパイラ（vbnc）がないので、Mono のホストには mono-path/vbnc（Roslyn の vbc に渡す）を使わせる。

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");

export const hostKind = process.env.HARIKIT_TEST_DOTNET_HOST || "mono";
export const layout = process.env.HARIKIT_TEST_DOTNET_LAYOUT || "bin";
export const serverPkg = resolve(repo, process.env.HARIKIT_TEST_DOTNET_PKG || "packages/server-dotnet");
/** パッケージごとに分けたテスト用の DB の名前（C# 版と VB 版を同じ SQL Server で並べて流しても当たらないように）。 */
export const testDatabase = `HarikitTest_${basename(serverPkg).replace(/[^A-Za-z0-9]/g, "_")}`;
const csharpPkg = join(here, "..");

const appcmd = join(process.env.windir ?? "C:\\Windows", "System32", "inetsrv", "appcmd.exe");
const IIS_SITE = "Default Web Site";
const IIS_URL = "http://127.0.0.1";

const works = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** テストを飛ばす理由（動かせるなら false）。 */
export function hostUnavailable() {
  if (!["mono", "iis"].includes(hostKind)) throw new Error(`HARIKIT_TEST_DOTNET_HOST は mono か iis です（${hostKind}）`);
  if (!["bin", "app_code"].includes(layout)) throw new Error(`HARIKIT_TEST_DOTNET_LAYOUT は bin か app_code です（${layout}）`);
  if (hostKind === "mono") return works("mono", ["--version"]) && works("mcs", ["--version"]) ? false : "mono / mcs がないので飛ばす";
  return process.platform === "win32" && existsSync(appcmd) ? false : "IIS（appcmd.exe）がないので飛ばす";
}

/** 載せるサーバのファイル。パッケージになければ C# 版（packages/server-dotnet）のものを使う（テスト用のページなど）。 */
export function serverFile(rel) {
  const own = join(serverPkg, rel);
  return existsSync(own) ? own : join(csharpPkg, rel);
}

/** サーバを置いた Web のフォルダを作る（Web.config などはテストが足す）。 */
export async function createSite() {
  let root;
  if (hostKind === "iis") {
    // アプリプールのユーザーが読めるよう、ユーザーのプロファイル（%TEMP%）の外に置く。
    const base = `${process.env.SystemDrive ?? "C:"}\\harikit-test`;
    await mkdir(base, { recursive: true });
    root = await mkdtemp(join(base, "site-"));
  } else {
    root = await mkdtemp(join(tmpdir(), "harikit-dotnet-"));
  }
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "App_Data"));
  if (layout === "bin") {
    if (process.platform === "win32") execFileSync("cmd.exe", ["/d", "/c", join(serverPkg, "build.cmd")], { stdio: "inherit" });
    else execFileSync(join(serverPkg, "build.sh"), { stdio: "inherit" });
    for (const f of await readdir(join(serverPkg, "bin"))) if (f.endsWith(".dll")) await copyFile(join(serverPkg, "bin", f), join(root, "bin", f));
  } else {
    const dir = join(root, "App_Code", "Harikit");
    await mkdir(dir, { recursive: true });
    for (const f of await readdir(join(serverPkg, "src"))) await copyFile(join(serverPkg, "src", f), join(dir, f));
  }
  await copyFile(join(serverPkg, "web", "Harikit.aspx"), join(root, "Harikit.aspx"));
  if (hostKind === "mono") {
    // ApplicationHost は bin の中から AspHost を読み込むので、テスト用のホストも bin に置く。
    execFileSync("mcs", ["-nologo", "-warnaserror", `-out:${join(root, "bin", "Harikit.TestHost.exe")}`, "-r:System.Web.dll", join(here, "TestHost.cs")], { stdio: "inherit" });
  }
  return root;
}

/** Web のフォルダを ASP.NET で動かす。url はアプリの根（`${url}/Harikit.aspx` がページ）。 */
export async function startSite(root) {
  const site = hostKind === "iis" ? await startIis(root) : await startMono(root);
  try {
    await waitReady(site.url);
  } catch (e) {
    await site.stop();
    throw e;
  }
  return site;
}

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

async function startMono(root) {
  const port = await freePort();
  // VB のページと App_Code は、mono-path/vbnc（Roslyn の vbc に渡す）でコンパイルさせる。
  const env = { ...process.env, PATH: `${join(here, "mono-path")}${delimiter}${process.env.PATH ?? ""}` };
  const host = spawn("mono", [join(root, "bin", "Harikit.TestHost.exe"), root, String(port)], { stdio: ["ignore", "pipe", "inherit"], env });
  await new Promise((resolve, reject) => {
    host.once("exit", (code) => reject(new Error(`テスト用ホストが止まりました（${code}）`)));
    host.stdout.on("data", (d) => String(d).includes("listening") && resolve());
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      host.kill();
    },
  };
}

async function startIis(root) {
  const name = basename(root);
  const run = (...args) => execFileSync(appcmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  // フォルダは残す（App_Data/harikit-log の error-*.log を、落ちたときに CI で見るため）。
  const stop = async () => {
    for (const args of [["delete", "app", `${IIS_SITE}/${name}`], ["delete", "apppool", name]]) {
      try {
        run(...args);
      } catch {
        // 消せなくても続ける。
      }
    }
  };
  try {
    run("add", "apppool", `/name:${name}`, "/managedRuntimeVersion:v4.0", "/managedPipelineMode:Integrated");
    // README の「載せ方」どおり、アプリプールのユーザーには読み取りと、App_Data（反映ログ）への書き込みだけを許す。
    // 匿名認証の要求は IUSR でファイルを読むので、IUSR にも読み取りを許す。
    execFileSync("icacls", [root, "/grant", `IIS AppPool\\${name}:(OI)(CI)RX`, "IUSR:(OI)(CI)RX", "/T", "/Q"], { stdio: "inherit" });
    execFileSync("icacls", [join(root, "App_Data"), "/grant", `IIS AppPool\\${name}:(OI)(CI)M`, "/T", "/Q"], { stdio: "inherit" });
    run("add", "app", `/site.name:${IIS_SITE}`, `/path:/${name}`, `/physicalPath:${root}`, `/applicationPool:${name}`);
  } catch (e) {
    await stop();
    throw new Error(`IIS にアプリを作れませんでした: ${e.stderr ?? ""}${e.stdout ?? ""}${e.message}`);
  }
  return { url: `${IIS_URL}/${name}`, stop };
}

/**
 * ページが WebMethod に答えるまで待つ。IIS はアプリを作った直後に 404 / 503 を返すことがあり、
 * App_Code の形では最初の呼び出しでビルドが走る。ビルドの誤りなどはその応答（ASP.NET のエラーページ）を出して止める。
 */
async function waitReady(url) {
  const deadline = Date.now() + 120_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/Harikit.aspx/Describe`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", "X-Harikit": "1" },
        body: JSON.stringify({ req: { v: 1 } }),
      });
      const text = await res.text();
      if (res.status === 200) return;
      last = `HTTP ${res.status}\n${text}`;
      if (res.status !== 404 && res.status !== 503) break;
    } catch (e) {
      last = String(e);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${url}/Harikit.aspx が応答しません（${hostKind}, ${layout}）\n${last.slice(0, 8000)}`);
}
