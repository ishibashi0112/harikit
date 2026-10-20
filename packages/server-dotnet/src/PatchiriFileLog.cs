// 反映ログ。1 行 1 件の JSON（JSON Lines）を日付ごとのファイルに足していく。形は Node 版と同じ。
// サーバ側のエラー（db_error、internal_error の中身）も同じフォルダに残す。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace Patchiri.Server
{
    public static class PatchiriFileLog
    {
        static readonly object sync = new object();
        static readonly Encoding Utf8 = new UTF8Encoding(false);

        public static void WriteApply(string dir, Dictionary<string, object> entry)
        {
            var appliedAt = entry["appliedAt"] as string ?? DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            Append(dir, "apply-" + appliedAt.Substring(0, 10) + ".jsonl", PatchiriJson.Stringify(entry) + "\n");
        }

        public static void WriteError(string dir, Exception e)
        {
            var now = DateTime.Now;
            var text = now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + e + "\n";
            Append(dir, "error-" + now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".log", text);
        }

        static void Append(string dir, string file, string text)
        {
            lock (sync)
            {
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, file), text, Utf8);
            }
        }
    }
}
