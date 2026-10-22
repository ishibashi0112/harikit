// Patchiri.aspx をブラウザで開いたとき（GET）に出す画面。
// 画面の中身は patchiri-web の同梱アプリ（dist/app の main.js と main.css）で、既定ではページの隣の patchiri/ に置く。
// 画面は同じページの WebMethod を呼ぶので、載せ先のログイン（フォーム認証、Windows 認証など）のまま使え、
// web.config でこのページに掛けた権限が、画面と API の両方に効く。

using System;
using System.Configuration;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web;
using System.Web.Hosting;

namespace Patchiri.Server
{
    public static class PatchiriScreen
    {
        const string DefaultAssets = "patchiri/";

        /// <summary>画面に許すこと（Node 版と同じ）。通信は同じオリジンだけ。載せ先の自分のページの iframe には入れられる。</summary>
        const string Csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

        /// <summary>
        /// WebMethod 以外の呼び出し（ページそのもの）に答える。Patchiri.aspx の Page_Load から呼び、その後は Response.End で止める。
        /// GET と HEAD は画面、application/json でない POST は 415（ASP.NET が WebMethod に回さない）、ほかは 404。
        /// </summary>
        public static void Write(HttpContext ctx)
        {
            Write(ctx, null);
        }

        /// <summary>Write と同じ。configPath は画面の設定（screen）を読む設定ファイルで、WebMethod の PatchiriWebMethods.Call に渡すものと同じにする。</summary>
        public static void Write(HttpContext ctx, string configPath)
        {
            var method = ctx.Request.HttpMethod;
            var res = ctx.Response;
            res.Clear();
            res.Cache.SetCacheability(HttpCacheability.NoCache);
            res.Cache.SetNoStore();
            res.AppendHeader("X-Content-Type-Options", "nosniff");
            if (method == "GET" || method == "HEAD")
            {
                var user = PatchiriWebMethods.CurrentUser();
                if (user == null)
                {
                    // 差し替えた WhoAmI が名前を返さない（未ログイン）。フォーム認証ならログイン画面に回る。
                    res.StatusCode = 401;
                    res.ContentType = "text/plain";
                    res.Write("login required");
                    return;
                }
                WritePage(ctx, user, ScreenOrNull(configPath));
                return;
            }
            res.StatusCode = method == "POST" ? 415 : 404;
            res.ContentType = "text/plain";
            res.Write(method == "POST" ? "application/json required" : "not found");
        }

        /// <summary>画面の設定。設定ファイルが読めなければ設定なしで出す（API を呼んだときに internal_error になり、中身はサーバのログに残る）。</summary>
        static ScreenSettings ScreenOrNull(string configPath)
        {
            try
            {
                return PatchiriWebMethods.Screen(configPath);
            }
            catch (Exception)
            {
                return null;
            }
        }

        static void WritePage(HttpContext ctx, string user, ScreenSettings screen)
        {
            var res = ctx.Response;
            var page = ctx.Request.FilePath;
            var dir = AssetsDir(page);
            var css = AssetUrl(dir, "main.css");
            var js = AssetUrl(dir, "main.js");
            // 載せ先が globalization の responseEncoding を Shift_JIS などにしていても、このページは UTF-8 で返す。
            res.ContentType = "text/html";
            res.ContentEncoding = new UTF8Encoding(false);
            res.Charset = "utf-8";
            res.AppendHeader("Content-Security-Policy", Csp);
            res.AppendHeader("X-Frame-Options", "SAMEORIGIN");
            res.AppendHeader("Referrer-Policy", "no-referrer");
            var html = new StringBuilder();
            html.Append("<!doctype html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n");
            var title = screen != null && screen.Title != null ? screen.Title : "patchiri";
            html.Append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>").Append(Encode(title)).Append("</title>\n");
            if (css == null || js == null)
            {
                // 画面のファイルを置き忘れたとき。真っ白なページにせず、どこに何を置くかを見せる。
                html.Append("</head>\n<body style=\"font-family: sans-serif; margin: 2em; line-height: 1.7\">\n<h1>patchiri</h1>\n");
                html.Append("<p>画面のファイルがありません: ").Append(Encode(dir)).Append(css == null ? "main.css" : "main.js").Append("</p>\n");
                html.Append("<p>patchiri-web の同梱アプリ（dist/app）の main.js、main.css、main.js.LEGAL.txt を、このフォルダに置いてください。");
                html.Append("置く場所は web.config の appSettings の patchiri:assets で変えられます。</p>\n</body>\n</html>\n");
                res.Write(html.ToString());
                return;
            }
            html.Append("<link rel=\"stylesheet\" href=\"").Append(Encode(css)).Append("\">\n");
            html.Append("<script type=\"module\" src=\"").Append(Encode(js)).Append("\"></script>\n");
            var extraCss = screen != null && screen.CssPath != null ? ReadCss(screen.CssPath) : null;
            // </style> で閉じられないように、</ を CSS のエスケープにする。
            if (extraCss != null) html.Append("<style>\n").Append(extraCss.Replace("</", "<\\/")).Append("\n</style>\n");
            html.Append("</head>\n<body>\n");
            // つなぐ先は同じページの WebMethod。ログイン名は見出しに出す（反映ログに残る名前）。画面の設定は Node 版と同じ data- 属性で渡す。
            html.Append("<div id=\"root\" data-api=\"").Append(Encode(res.ApplyAppPathModifier(page))).Append("\" data-style=\"webmethod\" data-user=\"");
            html.Append(Encode(user)).Append("\"");
            if (screen != null)
            {
                if (screen.Title != null) html.Append(" data-title=\"").Append(Encode(screen.Title)).Append("\"");
                if (screen.Theme != null) html.Append(" data-theme=\"").Append(Encode(screen.Theme)).Append("\"");
                if (screen.NoteRequired != null) html.Append(" data-note-required=\"").Append(Encode(screen.NoteRequired)).Append("\"");
                if (!screen.Excel) html.Append(" data-excel=\"false\"");
            }
            html.Append("></div>\n");
            // Internet Explorer（Edge の IE モードも）はモジュールの script を読まないので、画面の代わりに案内を出す。
            html.Append("<p id=\"patchiri-legacy\" hidden style=\"font-family: sans-serif; margin: 2em\">このブラウザでは patchiri の画面を開けません。");
            html.Append("Microsoft Edge か Google Chrome で開いてください（Internet Explorer と、Edge の IE モードでは動きません）。</p>\n");
            html.Append("<script nomodule>document.getElementById(\"patchiri-legacy\").removeAttribute(\"hidden\");</script>\n");
            html.Append("<noscript>JavaScript を有効にしてください。</noscript>\n</body>\n</html>\n");
            res.Write(html.ToString());
        }

        /// <summary>画面のファイルを置いたフォルダの URL（/ で終わる）。"~/" で始まればアプリの根から、ほかはページのフォルダから。</summary>
        static string AssetsDir(string page)
        {
            var dir = ConfigurationManager.AppSettings["patchiri:assets"];
            if (string.IsNullOrEmpty(dir)) dir = DefaultAssets;
            if (!dir.EndsWith("/", StringComparison.Ordinal)) dir += "/";
            return dir.StartsWith("~/", StringComparison.Ordinal) ? VirtualPathUtility.ToAbsolute(dir) : VirtualPathUtility.Combine(page, dir);
        }

        /// <summary>画面のファイルの URL。置き直したらブラウザが読み直すよう、更新日時を付ける。ファイルがなければ null。</summary>
        static string AssetUrl(string dir, string name)
        {
            var url = dir + name;
            var path = HostingEnvironment.MapPath(url);
            if (path == null || !File.Exists(path)) return null;
            return url + "?v=" + File.GetLastWriteTimeUtc(path).Ticks.ToString("x", CultureInfo.InvariantCulture);
        }

        /// <summary>画面に足す CSS。読めなければ足さない（画面はそのまま使える）。</summary>
        static string ReadCss(string path)
        {
            try
            {
                return File.ReadAllText(path, Encoding.UTF8);
            }
            catch (Exception)
            {
                return null;
            }
        }

        static string Encode(string s)
        {
            return HttpUtility.HtmlEncode(s);
        }
    }
}
