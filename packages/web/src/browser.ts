// ブラウザまわり（トークン、業務ルールの置き場所、ファイルの保存）。
// 画面は Node 版サーバ（127.0.0.1）から配られ、同じオリジンの API を呼ぶ。

import { PatchiriClient, type RulesConfig } from "patchiri-core";

const TOKEN_KEY = "patchiri.token";
const RULES_KEY = "patchiri.rules";

/**
 * サーバが起動時に出す URL（http://127.0.0.1:7357/#token=…）からトークンを受け取る。
 * アドレス欄からは消し、このタブのあいだだけ覚えておく（再読み込みしても使えるように）。
 */
export function takeToken(): string | null {
  const m = /[#&]token=([^&]+)/.exec(location.hash);
  if (m) {
    const token = decodeURIComponent(m[1]!);
    saveToken(token);
    history.replaceState(null, "", location.pathname + location.search);
    return token;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // 覚えられなくても、このページを開いているあいだは使える。
  }
}

export function makeClient(token: string): PatchiriClient {
  return new PatchiriClient({ baseUrl: location.origin, token });
}

export interface RulesFile {
  name: string;
  config: RulesConfig;
}

/** 業務ルールのファイル（patchiri.rules.json）を読む。形が違えば投げる。 */
export function parseRules(name: string, text: string): RulesFile {
  const config = JSON.parse(text) as RulesConfig;
  if (typeof config !== "object" || config === null || typeof config.targets !== "object" || config.targets === null) {
    throw new Error(`${name} は業務ルールのファイルではありません（"targets" がありません）`);
  }
  return { name, config };
}

/** 前に選んだ業務ルールのファイル。毎回選ばなくて済むよう、このブラウザに覚えておく。 */
export function loadRules(): RulesFile | null {
  try {
    const saved = localStorage.getItem(RULES_KEY);
    if (!saved) return null;
    const { name, text } = JSON.parse(saved) as { name: string; text: string };
    return parseRules(name, text);
  } catch {
    return null;
  }
}

export function storeRules(file: { name: string; text: string } | null): void {
  try {
    if (file) localStorage.setItem(RULES_KEY, JSON.stringify(file));
    else localStorage.removeItem(RULES_KEY);
  } catch {
    // 覚えられなければ、次に開いたときにもう一度選んでもらう。
  }
}

/** 文字列をファイルとして保存させる。 */
export function download(name: string, text: string, type = "text/plain;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
