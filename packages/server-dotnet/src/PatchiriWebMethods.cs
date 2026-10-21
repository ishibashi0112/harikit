// ASP.NET WebForms の WebMethod から呼ぶ入口（webmethod スタイル、仕様 1.1）。
// Patchiri.aspx の [WebMethod] Describe / Fetch / Apply は、ここの Call を呼ぶだけにする。
//
// 設定: web.config の appSettings "patchiri:config"（既定 ~/App_Data/patchiri.config.json）に許可リストを置き、
// 接続文字列は connectionStrings の名前（既定 "Patchiri"）で指す。認証と権限は載せ先のアプリに任せる（仕様 1.4）。

using System;
using System.Collections.Generic;
using System.Configuration;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web;
using System.Web.Configuration;
using System.Web.Hosting;

namespace Patchiri.Server
{
    public static class PatchiriWebMethods
    {
        const string DefaultConfigPath = "~/App_Data/patchiri.config.json";
        const string DefaultLogDir = "~/App_Data/patchiri-log";

        static readonly object sync = new object();
        static PatchiriService service;
        static string servicePath;
        static DateTime serviceStamp;

        public static Dictionary<string, object> Call(string name, Dictionary<string, object> req)
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
            PatchiriService s;
            try
            {
                s = Service();
            }
            catch (Exception e)
            {
                WriteError(MapPath(DefaultLogDir), e);
                return new Dictionary<string, object>
                {
                    { "ok", false },
                    { "v", 1 },
                    { "error", new Dictionary<string, object> { { "code", "internal_error" }, { "message", "patchiri の設定を読めません（詳細はサーバのログ）" } } },
                };
            }
            return s.Handle(name, req);
        }

        /// <summary>設定ファイルを読んでサービスを作る。設定ファイルを保存し直すと読み直す（テーブル定義の覚えも捨てる）。</summary>
        static PatchiriService Service()
        {
            var path = MapPath(ConfigurationManager.AppSettings["patchiri:config"] ?? DefaultConfigPath);
            var stamp = File.GetLastWriteTimeUtc(path);
            lock (sync)
            {
                if (service != null && path == servicePath && stamp == serviceStamp) return service;
                var config = PatchiriConfig.Parse(File.ReadAllText(path, Encoding.UTF8));
                var cs = ConfigurationManager.ConnectionStrings[config.ConnectionStringName];
                if (cs == null || string.IsNullOrEmpty(cs.ConnectionString))
                    throw new PatchiriConfigException("web.config の connectionStrings に " + config.ConnectionStringName + " がありません");
                var logDir = MapPath(config.LogDir);
                service = new PatchiriService(new PatchiriServiceOptions
                {
                    Config = config,
                    Dialect = new SqlServerDialect(cs.ConnectionString, config.LockWaitSeconds),
                    WhoAmI = CurrentUser,
                    Log = entry => PatchiriFileLog.WriteApply(logDir, entry),
                    LogError = e => WriteError(logDir, e),
                    MaxResponseLength = MaxJsonLength(),
                });
                servicePath = path;
                serviceStamp = stamp;
                return service;
            }
        }

        /// <summary>反映した人。載せ先の認証（フォーム認証、Windows 認証など）が決めた名前を使う。画面の見出しにも出す。</summary>
        internal static string CurrentUser()
        {
            var ctx = HttpContext.Current;
            if (ctx != null && ctx.User != null && ctx.User.Identity != null && ctx.User.Identity.IsAuthenticated) return ctx.User.Identity.Name;
            return "(anonymous)";
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
