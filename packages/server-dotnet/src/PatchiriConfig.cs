// サーバの設定（許可リスト、上限、ログ）。仕様 2 の許可リストを含む。
// 形は Node 版の patchiri.config.json と同じ（targets と limits はそのまま写せる）。
// 接続文字列は設定ファイルに書かず、web.config の connectionStrings を名前で指す。

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
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
        /// <summary>列の表示名（列名 → 表示名）。取込の見出しは列名でもこれでもよい。</summary>
        public Dictionary<string, string> Labels = new Dictionary<string, string>();
        /// <summary>反映する行ごとにサーバが入れる列（列名 → "now" か "user"）。書いた順。</summary>
        public List<KeyValuePair<string, string>> Stamp = new List<KeyValuePair<string, string>>();
        /// <summary>このターゲットで触れる行の固定の条件（列名 → 値。等号だけ）。外の行は見えない。</summary>
        public Dictionary<string, object> Scope = new Dictionary<string, object>();
        /// <summary>このターゲットを使えるロール（どれか 1 つ）。null なら誰でも。</summary>
        public List<string> Roles;
    }

    public class PatchiriConfigException : Exception
    {
        public PatchiriConfigException(string message) : base("設定の誤り: " + message) { }
    }

    /// <summary>同梱の画面の設定（設定ファイルの screen。Node 版と同じ）。</summary>
    public sealed class ScreenSettings
    {
        /// <summary>見出しとブラウザのタブの名前。null なら「patchiri」。</summary>
        public string Title;
        /// <summary>"light" か "dark"。null なら OS の設定に合わせる。</summary>
        public string Theme;
        /// <summary>メモを必須にするなら "true" か欄の名前。null なら任意。</summary>
        public string NoteRequired;
        /// <summary>「Excel を開く」を出すか。既定は出す。</summary>
        public bool Excel = true;
        /// <summary>画面に足す CSS のファイル（フルパス）。null なら足さない。</summary>
        public string CssPath;
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
        /// <summary>反映で行のロックを待つ秒数（仕様 7 の手順 3）。既定は 10 秒。最上位にも database の中にも書ける。</summary>
        public int LockWaitSeconds = 10;
        /// <summary>サーバに置く業務ルール（ターゲット名 → ルールの配列）。rules を書いていなければ null。</summary>
        public Dictionary<string, object> Rules;
        /// <summary>rules をファイルで書いたときの、そのファイルのパス（書き直したら読み直すため）。</summary>
        public string RulesPath;
        /// <summary>rules のファイルの、読む前の更新日時（UTC）。</summary>
        public DateTime RulesStamp;
        /// <summary>同梱の画面の設定。screen を書いていなければ null。</summary>
        public ScreenSettings Screen;

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

        /// <summary>設定の JSON を読み、形を確かめる。おかしければ PatchiriConfigException。rules をファイルで書くなら Load を使う。</summary>
        public static PatchiriConfig Parse(string json)
        {
            return Parse(json, null);
        }

        /// <summary>設定ファイルを読む。rules にファイルのパスを書いたら、設定ファイルのフォルダから読む。</summary>
        public static PatchiriConfig Load(string path)
        {
            return Parse(File.ReadAllText(path, Encoding.UTF8), Path.GetDirectoryName(Path.GetFullPath(path)));
        }

        static object ReadRulesFile(string baseDir, string rel, out string full, out DateTime stamp)
        {
            full = Path.GetFullPath(Path.Combine(baseDir, rel));
            string text;
            try
            {
                stamp = File.GetLastWriteTimeUtc(full);
                text = File.ReadAllText(full, Encoding.UTF8);
            }
            catch (Exception e)
            {
                throw new PatchiriConfigException("rules のファイル " + full + " が読めません（" + e.Message + "）");
            }
            try
            {
                return PatchiriJson.Parse(text);
            }
            catch (Exception e)
            {
                throw new PatchiriConfigException("rules のファイル " + full + " が JSON として読めません（" + e.Message + "）");
            }
        }

        static void ParseTargetExtras(string name, IDictionary<string, object> t, TargetConfig target)
        {
            if (t.ContainsKey("labels"))
            {
                var labels = PatchiriJson.AsObject(t["labels"]);
                if (labels == null) Fail(name + ".labels は { \"列名\": \"表示名\" } の形です");
                var seen = new Dictionary<string, string>();
                foreach (var c in target.Readable) seen[c.ToLowerInvariant()] = c;
                foreach (var kv in labels)
                {
                    if (!ContainsIgnoreCase(target.Readable, kv.Key)) Fail(name + ".labels の " + kv.Key + " が readable にありません");
                    var label = kv.Value as string;
                    if (label == null || label.Trim().Length == 0) Fail(name + ".labels." + kv.Key + " は文字列です");
                    var k = label.Trim().ToLowerInvariant();
                    string other;
                    if (seen.TryGetValue(k, out other) && !string.Equals(other, kv.Key, StringComparison.OrdinalIgnoreCase))
                        Fail(name + ".labels の " + label + " が " + other + " とぶつかります");
                    seen[k] = kv.Key;
                    target.Labels[kv.Key] = label.Trim();
                }
            }
            if (t.ContainsKey("stamp"))
            {
                var stamp = PatchiriJson.AsObject(t["stamp"]);
                if (stamp == null) Fail(name + ".stamp は { \"列名\": \"now\" か \"user\" } の形です");
                if (target.Access != "update") Fail(name + " は read なので stamp を持てません");
                foreach (var kv in stamp)
                {
                    var v = kv.Value as string;
                    if (v != "now" && v != "user") Fail(name + ".stamp." + kv.Key + " は \"now\" か \"user\" です");
                    if (target.Key != null && ContainsIgnoreCase(target.Key, kv.Key)) Fail(name + " のキー列 " + kv.Key + " は stamp にできません");
                    if (ContainsIgnoreCase(target.Updatable, kv.Key)) Fail(name + ".stamp の " + kv.Key + " は updatable にもあります（どちらか一方にしてください）");
                    target.Stamp.Add(new KeyValuePair<string, string>(kv.Key, v));
                }
            }
            if (t.ContainsKey("scope"))
            {
                var scope = PatchiriJson.AsObject(t["scope"]);
                if (scope == null || scope.Count == 0) Fail(name + ".scope は { \"列名\": 値 } の形です");
                foreach (var kv in scope)
                {
                    var v = PatchiriJson.Normalize(kv.Value);
                    if (!(v is string) && !(v is double) && !(v is bool)) Fail(name + ".scope." + kv.Key + " は文字列、数、true / false のどれかです");
                    if (ContainsIgnoreCase(target.Updatable, kv.Key)) Fail(name + ".scope の " + kv.Key + " は updatable にもあります（範囲の列は変えられません）");
                    foreach (var st in target.Stamp)
                        if (string.Equals(st.Key, kv.Key, StringComparison.OrdinalIgnoreCase)) Fail(name + ".scope の " + kv.Key + " は stamp にもあります");
                    target.Scope[kv.Key] = v;
                }
            }
            if (t.ContainsKey("roles"))
            {
                var roles = PatchiriJson.AsArray(t["roles"]);
                if (roles == null || roles.Count == 0) Fail(name + ".roles はロールの名前の配列です");
                target.Roles = new List<string>();
                foreach (var role in roles)
                {
                    var s = role as string;
                    if (string.IsNullOrEmpty(s)) Fail(name + ".roles はロールの名前の配列です");
                    target.Roles.Add(s);
                }
            }
        }

        /// <summary>設定の JSON を読み、形を確かめる。rulesBaseDir は rules にファイルのパスを書いたときに読むフォルダ（null ならパスは書けない）。</summary>
        public static PatchiriConfig Parse(string json, string rulesBaseDir)
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
                ParseTargetExtras(name, t, target);
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
            // Node 版と同じく database.lockWaitSeconds にも書ける（接続先は web.config なので、database の中はこれだけを読む）。
            var database = PatchiriJson.AsObject(PatchiriJson.Get(o, "database"));
            int? top = null, inner = null;
            if (o.ContainsKey("lockWaitSeconds")) top = PositiveInt(o["lockWaitSeconds"], "lockWaitSeconds");
            if (database != null && database.ContainsKey("lockWaitSeconds")) inner = PositiveInt(database["lockWaitSeconds"], "database.lockWaitSeconds");
            if (top.HasValue && inner.HasValue && top.Value != inner.Value) Fail("lockWaitSeconds と database.lockWaitSeconds が違います（どちらか一方に書いてください）");
            if (top.HasValue || inner.HasValue)
            {
                config.LockWaitSeconds = top ?? inner.Value;
                // SET LOCK_TIMEOUT はミリ秒の int。
                if (config.LockWaitSeconds > int.MaxValue / 1000) Fail("lockWaitSeconds が大きすぎます");
            }
            if (o.ContainsKey("rules"))
            {
                var rules = o["rules"];
                var path = rules as string;
                if (path != null)
                {
                    if (rulesBaseDir == null) Fail("rules にファイルのパスを書くときは PatchiriConfig.Load で読んでください");
                    string full;
                    DateTime stamp;
                    rules = ReadRulesFile(rulesBaseDir, path, out full, out stamp);
                    config.RulesPath = full;
                    config.RulesStamp = stamp;
                }
                var ro = PatchiriJson.AsObject(rules);
                if (ro == null) Fail("rules は { \"targets\": { … } } の形です");
                config.Rules = new Dictionary<string, object>(StringComparer.Ordinal);
                if (ro.ContainsKey("targets"))
                {
                    var rt = PatchiriJson.AsObject(ro["targets"]);
                    if (rt == null) Fail("rules は { \"targets\": { … } } の形です");
                    foreach (var kv in rt)
                    {
                        if (!config.Targets.ContainsKey(kv.Key)) Fail("rules.targets の " + kv.Key + " は targets にありません");
                        if (PatchiriJson.AsArray(kv.Value) == null) Fail("rules.targets." + kv.Key + " はルールの配列です");
                        config.Rules[kv.Key] = kv.Value;
                    }
                }
            }
            if (o.ContainsKey("exposeDbErrors"))
            {
                if (!(o["exposeDbErrors"] is bool)) Fail("exposeDbErrors は true か false です");
                config.ExposeDbErrors = (bool)o["exposeDbErrors"];
            }
            if (o.ContainsKey("screen")) config.Screen = ParseScreen(o["screen"], rulesBaseDir);
            return config;
        }

        static ScreenSettings ParseScreen(object x, string baseDir)
        {
            var s = PatchiriJson.AsObject(x);
            if (s == null) Fail("screen は { \"title\": … } の形です");
            var screen = new ScreenSettings();
            foreach (var kv in s)
            {
                var text = kv.Value as string;
                switch (kv.Key)
                {
                    case "title":
                        if (text == null || text.Trim().Length == 0) Fail("screen.title は空でない文字列です");
                        screen.Title = text;
                        break;
                    case "theme":
                        if (text != "auto" && text != "light" && text != "dark") Fail("screen.theme は \"auto\"、\"light\"、\"dark\" のどれかです");
                        screen.Theme = text == "auto" ? null : text;
                        break;
                    case "noteRequired":
                        if (kv.Value is bool) screen.NoteRequired = (bool)kv.Value ? "true" : null;
                        else if (text != null && text.Trim().Length > 0) screen.NoteRequired = text;
                        else Fail("screen.noteRequired は true / false か、欄の名前（空でない文字列）です");
                        break;
                    case "excel":
                        if (!(kv.Value is bool)) Fail("screen.excel は true / false です");
                        screen.Excel = (bool)kv.Value;
                        break;
                    case "css":
                        if (string.IsNullOrEmpty(text)) Fail("screen.css は CSS のファイルのパスです");
                        if (baseDir == null) Fail("screen.css を書くときは PatchiriConfig.Load で読んでください");
                        screen.CssPath = Path.GetFullPath(Path.Combine(baseDir, text));
                        break;
                    default:
                        Fail("screen." + kv.Key + " という項目はありません");
                        break;
                }
            }
            return screen;
        }
    }
}
