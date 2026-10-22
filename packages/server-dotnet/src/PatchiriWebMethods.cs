// ASP.NET WebForms の WebMethod から呼ぶ入口（webmethod スタイル、仕様 1.1）。
// Patchiri.aspx の [WebMethod] Describe / Fetch / Apply は、ここの Call を呼ぶだけにする。
//
// 設定: web.config の appSettings "patchiri:config"（既定 ~/App_Data/patchiri.config.json）に許可リストを置き、
// 接続文字列は connectionStrings の名前（既定 "Patchiri"）で指す。ページごとに別の許可リストを使うなら Call の configPath で渡す。
// 認証と権限は載せ先のアプリに任せる（仕様 1.4）。「誰が」とロールの判定は WhoAmI / IsInRole で差し替えられる。

using System;
using System.Collections.Generic;
using System.Configuration;
using System.Diagnostics;
using System.IO;
using System.Web;
using System.Web.Configuration;
using System.Web.Hosting;

namespace Patchiri.Server
{
    public static class PatchiriWebMethods
    {
        const string DefaultConfigPath = "~/App_Data/patchiri.config.json";
        const string DefaultLogDir = "~/App_Data/patchiri-log";
        /// <summary>1 回の呼び出しの中で、判定した利用者を覚えておく HttpContext.Items の名前。</summary>
        const string UserItem = "patchiri:user";

        /// <summary>
        /// 反映した人の名前を決める。null（既定）なら載せ先の認証の名前（User.Identity.Name。ログインしていなければ "(anonymous)"）。
        /// 自前のログインで Session に社員番号を置くアプリなどは、Global.asax の Application_Start で差し替える:
        /// <code>PatchiriWebMethods.WhoAmI = ctx => ctx.Session == null ? null : ctx.Session["UserId"] as string;</code>
        /// 差し替えた判定が名前を返さない（null か ""）呼び出しは、未ログインとして API も画面も HTTP 401 にする。
        /// Session を読むなら、ページの WebMethod を [WebMethod(EnableSession = true)] に、ページを EnableSessionState="ReadOnly" にする。
        /// </summary>
        public static Func<HttpContext, string> WhoAmI;

        /// <summary>
        /// ロールの判定（許可リストの roles）。null（既定）なら User.IsInRole（Windows のグループ、ロール マネージャーなど）。
        /// Session に権限を置くアプリなどは、WhoAmI と同じく Application_Start で差し替える。
        /// </summary>
        public static Func<HttpContext, string, bool> IsInRole;

        sealed class Loaded
        {
            public PatchiriService Service;
            public PatchiriConfig Config;
            public DateTime Stamp;
            public string RulesPath;
            public DateTime RulesStamp;
        }

        static readonly object sync = new object();
        /// <summary>設定ファイルのパス → 読んだサービス。</summary>
        static readonly Dictionary<string, Loaded> services = new Dictionary<string, Loaded>(StringComparer.OrdinalIgnoreCase);

        public static Dictionary<string, object> Call(string name, Dictionary<string, object> req)
        {
            return Call(name, req, null);
        }

        /// <summary>
        /// API を 1 本呼ぶ。configPath はこのページの許可リスト（"~/" で始まればアプリの中、相対ならアプリのフォルダから）。
        /// null なら appSettings の patchiri:config。
        /// </summary>
        public static Dictionary<string, object> Call(string name, Dictionary<string, object> req, string configPath)
        {
            var ctx = HttpContext.Current;
            ctx.Response.Cache.SetCacheability(HttpCacheability.NoCache);
            ctx.Response.Cache.SetNoStore();
            // CSRF 対策（仕様 1.4）。application/json でない呼び出しは ASP.NET が WebMethod に回さない。
            if (ctx.Request.Headers["X-Patchiri"] != "1")
            {
                ctx.Response.StatusCode = 403;
                return new Dictionary<string, object> { { "message", "X-Patchiri: 1 header required" } };
            }
            string user;
            try
            {
                user = CurrentUser();
            }
            catch (Exception e)
            {
                WriteError(MapPath(DefaultLogDir), e);
                return InternalError("patchiri の利用者を判定できません（詳細はサーバのログ）");
            }
            if (user == null)
            {
                // フォーム認証のログイン画面への転送にも、IIS のエラーページにもしない（画面は 401 を見てログインし直しを促す）。
                ctx.Response.SuppressFormsAuthenticationRedirect = true;
                ctx.Response.TrySkipIisCustomErrors = true;
                ctx.Response.StatusCode = 401;
                return new Dictionary<string, object> { { "message", "login required" } };
            }
            PatchiriService s;
            try
            {
                s = Service(configPath);
            }
            catch (Exception e)
            {
                WriteError(MapPath(DefaultLogDir), e);
                return InternalError("patchiri の設定を読めません（詳細はサーバのログ）");
            }
            return s.Handle(name, req);
        }

        static Dictionary<string, object> InternalError(string message)
        {
            return new Dictionary<string, object>
            {
                { "ok", false },
                { "v", 1 },
                { "error", new Dictionary<string, object> { { "code", "internal_error" }, { "message", message } } },
            };
        }

        /// <summary>同梱の画面の設定（設定ファイルの screen）。書いていなければ null。設定が読めなければ例外。</summary>
        internal static ScreenSettings Screen(string configPath)
        {
            return Load(configPath).Config.Screen;
        }

        static PatchiriService Service(string configPath)
        {
            return Load(configPath).Service;
        }

        /// <summary>設定ファイルを読んでサービスを作る。設定ファイルか rules のファイルを保存し直すと読み直す（テーブル定義の覚えも捨てる）。</summary>
        static Loaded Load(string configPath)
        {
            var path = MapPath(configPath ?? ConfigurationManager.AppSettings["patchiri:config"] ?? DefaultConfigPath);
            var stamp = File.GetLastWriteTimeUtc(path);
            lock (sync)
            {
                Loaded loaded;
                if (services.TryGetValue(path, out loaded) && loaded.Stamp == stamp
                    && (loaded.RulesPath == null || File.GetLastWriteTimeUtc(loaded.RulesPath) == loaded.RulesStamp)) return loaded;
                var config = PatchiriConfig.Load(path);
                var logDir = MapPath(config.LogDir);
                var service = new PatchiriService(new PatchiriServiceOptions
                {
                    Config = config,
                    Dialect = CreateDialect(config),
                    WhoAmI = CurrentUser,
                    IsInRole = CurrentUserInRole,
                    Log = entry => PatchiriFileLog.WriteApply(logDir, entry),
                    LogError = e => WriteError(logDir, e),
                    MaxResponseLength = MaxJsonLength(),
                });
                loaded = new Loaded { Service = service, Config = config, Stamp = stamp, RulesPath = config.RulesPath, RulesStamp = config.RulesStamp };
                services[path] = loaded;
                return loaded;
            }
        }

        /// <summary>
        /// 設定の connectionStringName が指す接続文字列の providerName で DB を選ぶ。
        /// 省くか System.Data.SqlClient なら SQL Server、Oracle.ManagedDataAccess.Client なら Oracle（ODP.NET Managed Driver）。
        /// </summary>
        public static IPatchiriDialect CreateDialect(PatchiriConfig config)
        {
            var cs = ConfigurationManager.ConnectionStrings[config.ConnectionStringName];
            if (cs == null || string.IsNullOrEmpty(cs.ConnectionString))
                throw new PatchiriConfigException("web.config の connectionStrings に " + config.ConnectionStringName + " がありません");
            var provider = cs.ProviderName;
            if (string.IsNullOrEmpty(provider) || provider == "System.Data.SqlClient") return new SqlServerDialect(cs.ConnectionString, config.LockWaitSeconds);
            if (provider == OracleDialect.ProviderName) return new OracleDialect(cs.ConnectionString, config.LockWaitSeconds);
            throw new PatchiriConfigException("connectionStrings の " + config.ConnectionStringName + " の providerName " + provider
                + " には対応していません（SQL Server は System.Data.SqlClient、Oracle は " + OracleDialect.ProviderName + "）");
        }

        /// <summary>
        /// 反映した人。WhoAmI を差し替えていればその答え（名前がなければ null）、なければ載せ先の認証が決めた名前。画面の見出しにも出す。
        /// 1 回の呼び出しの中では最初の答えを使う（反映ログと stamp の列で名前がずれないように）。
        /// </summary>
        internal static string CurrentUser()
        {
            var ctx = HttpContext.Current;
            if (ctx == null) return null;
            if (ctx.Items.Contains(UserItem)) return ctx.Items[UserItem] as string;
            string user;
            var hook = WhoAmI;
            if (hook != null)
            {
                user = hook(ctx);
                if (user == "") user = null;
            }
            else if (ctx.User != null && ctx.User.Identity != null && ctx.User.Identity.IsAuthenticated) user = ctx.User.Identity.Name;
            else user = "(anonymous)";
            ctx.Items[UserItem] = user;
            return user;
        }

        static bool CurrentUserInRole(string role)
        {
            var ctx = HttpContext.Current;
            if (ctx == null) return false;
            var hook = IsInRole;
            if (hook != null) return hook(ctx, role);
            return ctx.User != null && ctx.User.IsInRole(role);
        }

        /// <summary>WebMethod が返せる JSON の長さ（web.config の jsonSerialization maxJsonLength）。</summary>
        static int? MaxJsonLength()
        {
            var section = WebConfigurationManager.GetSection("system.web.extensions/scripting/webServices/jsonSerialization") as ScriptingJsonSerializationSection;
            return section != null ? section.MaxJsonLength : (int?)null;
        }

        /// <summary>"~/" で始まればアプリの中、相対ならアプリのフォルダから、絶対ならそのまま。</summary>
        static string MapPath(string path)
        {
            if (path.StartsWith("~/", StringComparison.Ordinal)) return HostingEnvironment.MapPath(path);
            if (Path.IsPathRooted(path)) return path;
            return Path.Combine(HostingEnvironment.ApplicationPhysicalPath, path);
        }

        static void WriteError(string dir, Exception e)
        {
            Trace.TraceError("patchiri: " + e);
            try
            {
                PatchiriFileLog.WriteError(dir, e);
            }
            catch (Exception)
            {
                // ログのフォルダに書けないときは Trace だけに残す。
            }
        }
    }
}
