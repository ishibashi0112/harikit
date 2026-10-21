import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ishibashi0112/spreadsheet-grid/style.css";
import "./style.css";
import "./page.css";
import { PatchiriClient } from "patchiri-core";
import { PatchiriApp } from "./App.js";

const root = document.getElementById("root")!;

// .NET 版の Patchiri.aspx が配るときは、つなぐ先（同じページの WebMethod）とログイン名を data- 属性で渡す。
// 載せ先のアプリと同じオリジンなので、ログイン（フォーム認証のクッキー、Windows 認証）はブラウザがそのまま付ける。
// 属性がなければ Node 版サーバが配ったもので、URL の #token= でつなぐ。
const { api, style, user } = root.dataset;
const client = api ? new PatchiriClient({ baseUrl: api, style: style === "webmethod" ? "webmethod" : "rest" }) : undefined;

createRoot(root).render(
  <StrictMode>
    {client ? (
      <PatchiriApp
        client={client}
        serverLabel={location.host}
        headerExtra={
          user && (
            <span className="pt-server" title="反映ログに残る名前です">
              {user} でログインしています
            </span>
          )
        }
      />
    ) : (
      <PatchiriApp />
    )}
  </StrictMode>,
);
