// 値の形の確認と比較。仕様 1.3 の「JSON での値」を扱う。
// コアの values.ts と同じ判定にする（クライアントとサーバでずれないように）。
// 正規表現は \d と $ を使わない（.NET の \d は全角数字にも当たり、$ は末尾の改行の前にも当たる）。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Patchiri.Server
{
    public static class PatchiriValues
    {
        public static readonly Regex DecimalRe = new Regex(@"\A-?[0-9]+(\.[0-9]+)?\z");
        public static readonly Regex BigintRe = new Regex(@"\A-?[0-9]+\z");
        static readonly Regex DateRe = new Regex(@"\A([0-9]{4})-([0-9]{2})-([0-9]{2})\z");
        // 秒の小数は Oracle の TIMESTAMP(9) まで。桁の上限は列の scale で見る。
        static readonly Regex DateTimeRe = new Regex(@"\A([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,9})?\z");
        static readonly Regex TimeRe = new Regex(@"\A([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,7})?\z");

        /// <summary>dbType の先頭の型名（"decimal(9,2)" → "decimal"）。</summary>
        public static string BaseDbType(string dbType)
        {
            var s = dbType.ToLowerInvariant();
            var i = s.IndexOf('(');
            return (i >= 0 ? s.Substring(0, i) : s).Trim();
        }

        static bool ValidDate(int y, int m, int d)
        {
            if (y < 1 || m < 1 || m > 12 || d < 1) return false;
            return d <= DateTime.DaysInMonth(2000, m) - (m == 2 && !IsLeap(y) ? 1 : 0);
        }

        static bool IsLeap(int y)
        {
            return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        }

        static bool ValidTime(int h, int mi, int s)
        {
            return h < 24 && mi < 60 && s < 60;
        }

        static int G(Match m, int i)
        {
            return int.Parse(m.Groups[i].Value, CultureInfo.InvariantCulture);
        }

        /// <summary>コードポイントの数（JS の [...s].length と同じ）。</summary>
        public static int CodePoints(string s)
        {
            var n = 0;
            for (var i = 0; i < s.Length; i++)
            {
                if (char.IsHighSurrogate(s[i]) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) i++;
                n++;
            }
            return n;
        }

        /// <summary>
        /// 値が列の型として正しい形かを見る。正しければ null、違えば理由を返す。
        /// 桁数、バイト数、文字コード、NOT NULL も見る（DB 定義でわかる範囲）。
        /// </summary>
        public static string CheckValue(ColumnMeta col, object v, bool nullable)
        {
            if (v == null) return nullable ? null : "必須です（NOT NULL）";
            switch (col.Type)
            {
                case "string":
                    {
                        var s = v as string;
                        if (s == null) return "文字列ではありません";
                        if (s.Length == 0 && col.EmptyIsNull) return "この列では空文字は NULL になります（空にするなら null）";
                        if (col.MaxLength.HasValue && col.MaxLength.Value >= 0)
                        {
                            var len = CodePoints(s);
                            if (len > col.MaxLength.Value) return col.MaxLength.Value + " 文字を超えています（" + len + " 文字）";
                        }
                        return CheckBytes(col, s);
                    }
                case "integer":
                    {
                        if (!PatchiriJson.IsNumber(v)) return "整数ではありません";
                        var d = PatchiriJson.ToDouble(v);
                        if (double.IsNaN(d) || double.IsInfinity(d) || Math.Floor(d) != d) return "整数ではありません";
                        long min, max;
                        switch (BaseDbType(col.DbType))
                        {
                            case "tinyint": min = 0; max = 255; break;
                            case "smallint": min = -32768; max = 32767; break;
                            default: min = int.MinValue; max = int.MaxValue; break;
                        }
                        if (d < min || d > max) return "範囲外です（" + min + "〜" + max + "）";
                        return null;
                    }
                case "bigint":
                    {
                        var s = v as string;
                        if (s == null || !BigintRe.IsMatch(s)) return "整数ではありません";
                        long n;
                        if (!long.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out n)) return "範囲外です（bigint）";
                        return null;
                    }
                case "decimal":
                    {
                        var s = v as string;
                        if (s == null || !DecimalRe.IsMatch(s)) return "数値ではありません";
                        if (col.Precision.HasValue)
                        {
                            var scale = col.Scale ?? 0;
                            var parts = s.TrimStart('-').Split('.');
                            var intDigits = parts[0].TrimStart('0').Length;
                            var fracDigits = parts.Length > 1 ? parts[1].TrimEnd('0').Length : 0;
                            if (fracDigits > scale) return "小数は " + scale + " 桁までです";
                            if (intDigits > col.Precision.Value - scale) return "整数部は " + (col.Precision.Value - scale) + " 桁までです";
                        }
                        return null;
                    }
                case "float":
                    {
                        if (!PatchiriJson.IsNumber(v)) return "数値ではありません";
                        var d = PatchiriJson.ToDouble(v);
                        return double.IsNaN(d) || double.IsInfinity(d) ? "数値ではありません" : null;
                    }
                case "boolean":
                    return v is bool ? null : "true / false ではありません";
                case "date":
                    {
                        var s = v as string;
                        var m = s == null ? null : DateRe.Match(s);
                        if (m == null || !m.Success || !ValidDate(G(m, 1), G(m, 2), G(m, 3))) return "日付（YYYY-MM-DD）ではありません";
                        return null;
                    }
                case "datetime":
                    {
                        var s = v as string;
                        var m = s == null ? null : DateTimeRe.Match(s);
                        if (m == null || !m.Success || !ValidDate(G(m, 1), G(m, 2), G(m, 3)) || !ValidTime(G(m, 4), G(m, 5), G(m, 6)))
                            return "日時（YYYY-MM-DDTHH:mm:ss）ではありません";
                        return CheckFraction(col, m.Groups[7].Value);
                    }
                case "time":
                    {
                        var s = v as string;
                        var m = s == null ? null : TimeRe.Match(s);
                        if (m == null || !m.Success || !ValidTime(G(m, 1), G(m, 2), G(m, 3))) return "時刻（HH:mm:ss）ではありません";
                        return CheckFraction(col, m.Groups[4].Value);
                    }
                default:
                    return "この型の列は扱えません";
            }
        }

        /// <summary>秒の小数の桁数を、列の scale（datetime2(3) なら 3）と比べる。</summary>
        static string CheckFraction(ColumnMeta col, string fraction)
        {
            if (!col.Scale.HasValue || string.IsNullOrEmpty(fraction)) return null;
            var digits = fraction.Substring(1).TrimEnd('0').Length;
            return digits > col.Scale.Value ? "秒の小数は " + col.Scale.Value + " 桁までです" : null;
        }

        /// <summary>
        /// 列の文字コードでのバイト数と、表せない字を確かめる（仕様 3「文字列の列の長さと文字コード」）。
        /// SQL Server は表せない字をエラーにせず「?」に置き換えるので、ここで止める。
        /// 文字コードの変換は、書いて読み戻して同じになるかで見る（置き換えや近い字への読み替えも弾く）。
        /// </summary>
        static string CheckBytes(ColumnMeta col, string s)
        {
            int bytes;
            if (col.Encoding == "utf-16le") bytes = s.Length * 2;
            else if (col.ByteEncoding != null)
            {
                string bad;
                if (!TryEncode(col.ByteEncoding, s, out bytes, out bad))
                    return "「" + bad + "」は列の文字コード（" + (col.Encoding ?? col.ByteEncoding.WebName) + "）で表せません";
            }
            else return null;
            if (col.MaxBytes.HasValue && bytes > col.MaxBytes.Value) return col.MaxBytes.Value + " バイトを超えています（" + bytes + " バイト）";
            return null;
        }

        /// <summary>文字コードで書いて読み戻すと同じになるか（表せない字や、近い字への置き換えがないか）。</summary>
        public static bool CanEncode(Encoding enc, string s)
        {
            int bytes;
            return RoundTrips(enc, s, out bytes);
        }

        static bool RoundTrips(Encoding enc, string s, out int bytes)
        {
            bytes = 0;
            try
            {
                var b = enc.GetBytes(s);
                bytes = b.Length;
                return enc.GetString(b) == s;
            }
            catch (EncoderFallbackException)
            {
                return false;
            }
            catch (DecoderFallbackException)
            {
                return false;
            }
        }

        static bool TryEncode(Encoding enc, string s, out int bytes, out string bad)
        {
            bad = null;
            if (RoundTrips(enc, s, out bytes)) return true;
            for (var i = 0; i < s.Length; i++)
            {
                var n = char.IsHighSurrogate(s[i]) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]) ? 2 : 1;
                var ch = s.Substring(i, n);
                int ignored;
                if (!RoundTrips(enc, ch, out ignored))
                {
                    bad = ch;
                    return false;
                }
                i += n - 1;
            }
            // 1 字ずつなら表せるが、続けると変わる（シフト状態を持つ文字コードなど）。
            bad = s;
            return false;
        }

        static string CanonicalDecimal(string v)
        {
            var neg = v.StartsWith("-", StringComparison.Ordinal);
            var parts = v.TrimStart('-').Split('.');
            var integer = parts[0].TrimStart('0');
            if (integer.Length == 0) integer = "0";
            var frac = parts.Length > 1 ? parts[1].TrimEnd('0') : "";
            if (integer == "0" && frac.Length == 0) neg = false;
            return (neg ? "-" : "") + integer + (frac.Length > 0 ? "." + frac : "");
        }

        static string CanonicalBigint(string v)
        {
            var neg = v.StartsWith("-", StringComparison.Ordinal);
            var digits = v.TrimStart('-').TrimStart('0');
            if (digits.Length == 0) return "0";
            return (neg ? "-" : "") + digits;
        }

        /// <summary>秒の小数の末尾の 0 を落とす（"09:30:00.120" → "09:30:00.12"、".000" は消す）。</summary>
        public static string CanonicalFraction(string v)
        {
            var dot = v.LastIndexOf('.');
            if (dot < 0) return v;
            for (var i = dot + 1; i < v.Length; i++) if (v[i] < '0' || v[i] > '9') return v;
            var frac = v.Substring(dot + 1).TrimEnd('0');
            if (frac.Length == v.Length - dot - 1) return v;
            return frac.Length == 0 ? v.Substring(0, dot) : v.Substring(0, dot + 1) + frac;
        }

        /// <summary>比較用に値をそろえる（"120" と "120.00" を同じにする、など）。数値は double にする。</summary>
        public static object Canonical(string type, object v)
        {
            if (PatchiriJson.IsNumber(v)) return PatchiriJson.ToDouble(v);
            var s = v as string;
            if (s == null) return v;
            switch (type)
            {
                case "decimal":
                    return DecimalRe.IsMatch(s) ? CanonicalDecimal(s) : s;
                case "bigint":
                    return BigintRe.IsMatch(s) ? CanonicalBigint(s) : s;
                case "datetime":
                case "time":
                    return CanonicalFraction(s);
                default:
                    return s;
            }
        }

        static bool Same(object a, object b)
        {
            if (a == null || b == null) return a == null && b == null;
            if (a is string && b is string) return string.Equals((string)a, (string)b, StringComparison.Ordinal);
            if (a is bool && b is bool) return (bool)a == (bool)b;
            if (a is double && b is double) return (double)a == (double)b;
            return false;
        }

        /// <summary>型に沿って 2 つの値が同じかを見る。NULL 同士は同じ。</summary>
        public static bool SameValue(string type, object a, object b)
        {
            return Same(Canonical(type, a), Canonical(type, b));
        }

        /// <summary>列の定義に沿って比べる。固定長の char / nchar は DB が末尾を空白で埋めるので、末尾の空白は見ない。</summary>
        public static bool SameColumnValue(ColumnMeta col, object a, object b)
        {
            var sa = a as string;
            var sb = b as string;
            if (col.Type == "string" && sa != null && sb != null)
            {
                var bt = BaseDbType(col.DbType);
                if (bt == "char" || bt == "nchar") return sa.TrimEnd(' ') == sb.TrimEnd(' ');
            }
            return SameValue(col.Type, a, b);
        }

        /// <summary>キーの組を、比べるための文字列にする。</summary>
        public static string KeyIdentity(IList<ColumnMeta> keyCols, IDictionary<string, object> key)
        {
            var list = new List<object>();
            foreach (var c in keyCols)
            {
                object v;
                key.TryGetValue(c.Name, out v);
                list.Add(Canonical(c.Type, v));
            }
            return PatchiriJson.Identity(list);
        }
    }
}
