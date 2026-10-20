// サーバの設定（許可リスト、上限、ログ）。仕様 2 の許可リストを含む。
// 形は Node 版の patchiri.config.json と同じ（targets と limits はそのまま写せる）。
// 接続文字列は設定ファイルに書かず、web.config の connectionStrings を名前で指す。

using System;
using System.Collections;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Patchiri.Server
{
    public sealed class TargetConfig
    {
        public string Table;
        /// <summary>"update" か "read"。</summary>
        public string Access;
        /// <summary>省くと（null）DB の主キー。</summary>
        public List<string> Key;
        public List<string> Readable = new List<string>();
        public List<string> Updatable = new List<string>();
    }

    public class PatchiriConfigException : Exception
    {
        public PatchiriConfigException(string message) : base("設定の誤り: " + message) { }
    }

    public sealed class PatchiriConfig
    {
        static readonly Regex TargetNameRe = new Regex(@"\A[A-Za-z0-9_-]+\z");

        /// <summary>書いた順のターゲット名。</summary>
        public List<string> TargetNames = new List<string>();
        public Dictionary<string, TargetConfig> Targets = new Dictionary<string, TargetConfig>(StringComparer.Ordinal);
        public int MaxFetchKeys = 1000;
        public int MaxApplyRows = 5000;
        /// <summary>web.config の connectionStrings の名前。既定は "Patchiri"。</summary>
        public string ConnectionStringName = "Patchiri";
        /// <summary>反映ログ（JSON Lines）を置くフォルダ。既定は ~/App_Data/patchiri-log。</summary>
        public string LogDir = "~/App_Data/patchiri-log";
        /// <summary>db_error の message に DB の生のエラー文を出すか。既定は出さない。</summary>
        public bool ExposeDbErrors;
        /// <summary>反映で行のロックを待つ秒数（仕様 7 の手順 3）。既定は 10 秒。</summary>
        public int LockWaitSeconds = 10;

        static void Fail(string message)
        {
            throw new PatchiriConfigException(message);
        }

        static List<string> Names(object x, string what)
        {
            var list = PatchiriJson.AsArray(x);
            if (list == null) Fail(what + " は列名の配列です");
            var names = new List<string>();
            foreach (var item in list)
            {
                var s = item as string;
                if (string.IsNullOrEmpty(s)) Fail(what + " は列名の配列です");
                names.Add(s);
            }
            return names;
        }

        static bool ContainsIgnoreCase(IEnumerable<string> list, string name)
        {
            foreach (var s in list) if (string.Equals(s, name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        static int PositiveInt(object x, string what)
        {
            if (!PatchiriJson.IsNumber(x)) Fail(what + " は正の整数です");
            var d = PatchiriJson.ToDouble(x);
            if (d < 1 || d > int.MaxValue || Math.Floor(d) != d) Fail(what + " は正の整数です");
            return (int)d;
        }

        /// <summary>設定の JSON を読み、形を確かめる。おかしければ PatchiriConfigException。</summary>
        public static PatchiriConfig Parse(string json)
        {
            object root;
            try
            {
                root = PatchiriJson.Parse(json);
            }
            catch (Exception e)
            {
                throw new PatchiriConfigException("JSON として読めません（" + e.Message + "）");
            }
            var o = PatchiriJson.AsObject(root);
            if (o == null) Fail("JSON のオブジェクトではありません");
            var config = new PatchiriConfig();

            var targets = PatchiriJson.AsObject(PatchiriJson.Get(o, "targets"));
            if (targets == null) Fail("targets がありません");
            foreach (var kv in targets)
            {
                var name = kv.Key;
                if (!TargetNameRe.IsMatch(name)) Fail("ターゲット名 " + name + " に使えない文字があります");
                var t = PatchiriJson.AsObject(kv.Value);
                if (t == null) Fail(name + " がオブジェクトではありません");
                var target = new TargetConfig();
                target.Table = PatchiriJson.Get(t, "table") as string;
                if (string.IsNullOrEmpty(target.Table)) Fail(name + ".table がありません");
                target.Access = PatchiriJson.Get(t, "access") as string;
                if (target.Access != "update" && target.Access != "read") Fail(name + ".access は \"update\" か \"read\" です");
                target.Readable = Names(PatchiriJson.Get(t, "readable"), name + ".readable");
                if (t.ContainsKey("key"))
                {
                    target.Key = Names(t["key"], name + ".key");
                    if (target.Key.Count == 0) Fail(name + ".key は列名の配列です");
                    foreach (var k in target.Key) if (!ContainsIgnoreCase(target.Readable, k)) Fail(name + ".key の " + k + " が readable にありません");
                }
                if (t.ContainsKey("updatable"))
                {
                    target.Updatable = Names(t["updatable"], name + ".updatable");
                    if (target.Access != "update" && target.Updatable.Count > 0) Fail(name + " は read なので updatable を持てません");
                    foreach (var c in target.Updatable)
                    {
                        if (!ContainsIgnoreCase(target.Readable, c)) Fail(name + ".updatable の " + c + " が readable にありません");
                        if (target.Key != null && ContainsIgnoreCase(target.Key, c)) Fail(name + " のキー列 " + c + " は更新できません");
                    }
                }
                config.TargetNames.Add(name);
                config.Targets[name] = target;
            }

            var limits = PatchiriJson.AsObject(PatchiriJson.Get(o, "limits"));
            if (limits != null)
            {
                if (limits.ContainsKey("maxFetchKeys")) config.MaxFetchKeys = PositiveInt(limits["maxFetchKeys"], "limits.maxFetchKeys");
                if (limits.ContainsKey("maxApplyRows")) config.MaxApplyRows = PositiveInt(limits["maxApplyRows"], "limits.maxApplyRows");
            }
            if (o.ContainsKey("connectionStringName"))
            {
                config.ConnectionStringName = o["connectionStringName"] as string;
                if (string.IsNullOrEmpty(config.ConnectionStringName)) Fail("connectionStringName は文字列です");
            }
            if (o.ContainsKey("logDir"))
            {
                config.LogDir = o["logDir"] as string;
                if (string.IsNullOrEmpty(config.LogDir)) Fail("logDir は文字列です");
            }
            if (o.ContainsKey("lockWaitSeconds"))
            {
                config.LockWaitSeconds = PositiveInt(o["lockWaitSeconds"], "lockWaitSeconds");
                // SET LOCK_TIMEOUT はミリ秒の int。
                if (config.LockWaitSeconds > int.MaxValue / 1000) Fail("lockWaitSeconds が大きすぎます");
            }
            if (o.ContainsKey("exposeDbErrors"))
            {
                if (!(o["exposeDbErrors"] is bool)) Fail("exposeDbErrors は true か false です");
                config.ExposeDbErrors = (bool)o["exposeDbErrors"];
            }
            return config;
        }
    }
}
