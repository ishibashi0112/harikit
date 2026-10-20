// JavaScriptSerializer が作る形を扱う小道具。
// 受け取る JSON は Dictionary<string, object>（オブジェクト）、ArrayList か object[]（配列）、
// int・long・decimal・double（数値）、string、bool、null になる。"\/Date(...)\/" は DateTime になる。
// 値は JS と同じ判定になるよう、数値をすべて double にそろえて扱う（仕様 1.3）。

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Web.Script.Serialization;

namespace Patchiri.Server
{
    public static class PatchiriJson
    {
        public static IDictionary<string, object> AsObject(object x)
        {
            return x as IDictionary<string, object>;
        }

        public static IList AsArray(object x)
        {
            return x is string ? null : x as IList;
        }

        public static bool IsNumber(object x)
        {
            return x is int || x is long || x is decimal || x is double || x is float
                || x is short || x is byte || x is sbyte || x is ushort || x is uint || x is ulong;
        }

        public static double ToDouble(object x)
        {
            // decimal から double への Convert は最も近い値にならないことがある（0.10999999940395355 など）。
            // JavaScriptSerializer は指数のない数を decimal で返すので、文字列を通して読む（JS の読み方と同じになる）。
            if (x is decimal) return double.Parse(((decimal)x).ToString(CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture);
            return Convert.ToDouble(x, CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// 読み戻すと同じ double になる形で書く。.NET Framework の "R" は x64 で読み戻せない形を返すことがあるので、
        /// 確かめて駄目なら 17 桁で書く。
        /// </summary>
        public static string FormatDouble(double d)
        {
            var s = d.ToString("R", CultureInfo.InvariantCulture);
            if (double.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture) != d) s = d.ToString("G17", CultureInfo.InvariantCulture);
            return s;
        }

        /// <summary>
        /// 返す JSON に載せる数。JavaScriptSerializer は double を "R" で書くので（上と同じ問題）、
        /// 読み戻せる形の decimal にして渡す。decimal で表せない大きさのときは double のまま。
        /// </summary>
        public static object JsonNumber(double d)
        {
            decimal m;
            if (decimal.TryParse(FormatDouble(d), NumberStyles.Float, CultureInfo.InvariantCulture, out m)
                && ToDouble(m) == d) return m;
            return d;
        }

        /// <summary>数値を double にそろえる。他はそのまま。</summary>
        public static object Normalize(object x)
        {
            return IsNumber(x) ? (object)ToDouble(x) : x;
        }

        public static object Get(IDictionary<string, object> o, string key)
        {
            object v;
            return o != null && o.TryGetValue(key, out v) ? v : null;
        }

        /// <summary>行の値（キーの組など）を、比べるための文字列にする。</summary>
        public static string Identity(IEnumerable<object> values)
        {
            var sb = new StringBuilder();
            foreach (var v in values)
            {
                sb.Append('|');
                if (v == null) sb.Append("n");
                else if (v is string) sb.Append("s").Append(((string)v).Length).Append(':').Append((string)v);
                else if (v is bool) sb.Append((bool)v ? "t" : "f");
                else if (IsNumber(v)) sb.Append("d").Append(FormatDouble(ToDouble(v)));
                else sb.Append("o").Append(Convert.ToString(v, CultureInfo.InvariantCulture));
            }
            return sb.ToString();
        }

        /// <summary>上限なしの JavaScriptSerializer（ログやサイズの見積もり用）。</summary>
        public static JavaScriptSerializer Serializer()
        {
            return new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 100 };
        }

        public static object Parse(string json)
        {
            return Serializer().DeserializeObject(json);
        }

        public static string Stringify(object value)
        {
            return Serializer().Serialize(value);
        }
    }
}
