// サーバに置く業務ルール（patchiri.rules.json と同じ形、許可リストの rules）。コアの rules.ts と同じ決まりで見る。
// apply は severity が error のルールだけを、反映した後の行（ロックして読んだ値に after を重ねたもの）に当てる。
// pattern は ECMAScript 互換の指定で読む（\p{…} は使えない。$ は末尾の改行の前にも当たる）。

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using Row = System.Collections.Generic.Dictionary<string, object>;

namespace Patchiri.Server
{
    /// <summary>使える形にした業務ルール 1 つ。境界の値は列の型の値にそろえてある。</summary>
    public sealed class PatchiriRule
    {
        public string Column;
        public ColumnMeta Col;
        public bool Required;
        /// <summary>min、max、greaterThan、lessThan の固定の値。</summary>
        public Dictionary<string, object> Bounds = new Dictionary<string, object>();
        /// <summary>境界にほかの列を書いたもの（{ "column": … }）。</summary>
        public Dictionary<string, ColumnMeta> BoundColumns = new Dictionary<string, ColumnMeta>();
        public string Pattern;
        public Regex Regex;
        public List<object> OneOf;
        public double? MaxChangePercent;
        /// <summary>"error"（既定）か "warning"。</summary>
        public string Severity = "error";
        public string Message;
        public ColumnMeta WhenCol;
        /// <summary>when の equals / oneOf を列の型の値にしたもの。</summary>
        public List<object> WhenValues;
        public bool? WhenEmpty;
        /// <summary>このルールが見る列（自分、境界の列、when の列）。2 つ以上なら行のルール。</summary>
        public List<string> Columns = new List<string>();
    }

    public static class PatchiriRules
    {
        static readonly HashSet<string> RuleKeys = new HashSet<string>
        {
            "column", "required", "min", "max", "greaterThan", "lessThan", "pattern", "oneOf", "maxChangePercent", "severity", "message", "when",
        };
        static readonly HashSet<string> WhenKeys = new HashSet<string> { "column", "equals", "oneOf", "empty" };
        static readonly string[] BoundKeys = { "min", "max", "greaterThan", "lessThan" };
        static readonly HashSet<string> OrderedTypes = new HashSet<string> { "integer", "bigint", "decimal", "float", "date", "datetime", "time" };
        static readonly HashSet<string> NumericTypes = new HashSet<string> { "integer", "bigint", "decimal", "float" };
        static readonly Regex DateRe = new Regex(@"\A[0-9]{4}-[0-9]{2}-[0-9]{2}\z");

        /// <summary>ルールの配列（1 ターゲットの分）を、列の定義と照らして使える形にする。誤りは errors に入れる（source は文の頭に付ける名前）。</summary>
        public static List<PatchiriRule> Compile(string target, IList<ColumnMeta> columns, object rules, string source, List<string> errors)
        {
            var output = new List<PatchiriRule>();
            if (rules == null) return output;
            var list = PatchiriJson.AsArray(rules);
            if (list == null)
            {
                errors.Add(source + ": " + target + " はルールの配列にしてください");
                return output;
            }
            var byName = new Dictionary<string, ColumnMeta>();
            foreach (var c in columns) byName[c.Name.ToLowerInvariant()] = c;
            for (var i = 0; i < list.Count; i++)
            {
                string error;
                var rule = CompileOne(target, byName, list[i], out error);
                if (error != null) errors.Add(source + " " + (i + 1) + " 番目: " + error);
                else output.Add(rule);
            }
            return output;
        }

        static ColumnMeta Find(Dictionary<string, ColumnMeta> byName, object name)
        {
            var s = name as string;
            ColumnMeta c;
            return s != null && byName.TryGetValue(s.ToLowerInvariant(), out c) ? c : null;
        }

        static PatchiriRule CompileOne(string target, Dictionary<string, ColumnMeta> byName, object raw, out string error)
        {
            error = null;
            var r = PatchiriJson.AsObject(raw);
            if (r == null)
            {
                error = "オブジェクトではありません";
                return null;
            }
            var unknown = new List<string>();
            foreach (var k in r.Keys) if (!RuleKeys.Contains(k)) unknown.Add(k);
            if (unknown.Count > 0)
            {
                error = "知らない項目 " + string.Join(", ", unknown) + " があります";
                return null;
            }
            var col = Find(byName, PatchiriJson.Get(r, "column"));
            if (col == null)
            {
                error = "列 " + Text(PatchiriJson.Get(r, "column")) + " は " + target + " にありません";
                return null;
            }
            var rule = new PatchiriRule { Column = col.Name, Col = col };
            rule.Columns.Add(col.Name);
            if (r.ContainsKey("severity"))
            {
                var sev = r["severity"] as string;
                if (sev != "error" && sev != "warning")
                {
                    error = "severity は error か warning です";
                    return null;
                }
                rule.Severity = sev;
            }
            if (r.ContainsKey("message"))
            {
                rule.Message = r["message"] as string;
                if (rule.Message == null)
                {
                    error = "message は文字列です";
                    return null;
                }
            }
            if (r.ContainsKey("required"))
            {
                if (!(r["required"] is bool))
                {
                    error = "required は true / false です";
                    return null;
                }
                rule.Required = (bool)r["required"];
            }
            foreach (var k in BoundKeys)
            {
                if (!r.ContainsKey(k)) continue;
                if (!OrderedTypes.Contains(col.Type))
                {
                    error = k + " は数値か日付の列だけに使えます";
                    return null;
                }
                var refObj = PatchiriJson.AsObject(r[k]);
                if (refObj != null)
                {
                    var other = refObj.Count == 1 ? Find(byName, PatchiriJson.Get(refObj, "column")) : null;
                    if (other == null)
                    {
                        error = k + " の列 " + PatchiriJson.Stringify(PatchiriJson.Get(refObj, "column")) + " は " + target + " にありません";
                        return null;
                    }
                    if (!SameKind(col, other))
                    {
                        error = k + " の列 " + other.Name + " は " + col.Name + " と比べられる型ではありません";
                        return null;
                    }
                    rule.BoundColumns[k] = other;
                    Use(rule, other);
                    continue;
                }
                var v = ToColumnValue(col, r[k]);
                if (v == null)
                {
                    error = k + " の値 " + PatchiriJson.Stringify(r[k]) + " が列の型として読めません";
                    return null;
                }
                rule.Bounds[k] = v;
            }
            if (r.ContainsKey("pattern"))
            {
                var p = r["pattern"] as string;
                if (col.Type != "string" || p == null)
                {
                    error = "pattern は文字列の列に、正規表現の文字列で書きます";
                    return null;
                }
                try
                {
                    rule.Regex = new Regex(p, RegexOptions.ECMAScript);
                }
                catch (ArgumentException)
                {
                    error = "pattern " + p + " は正規表現として読めません";
                    return null;
                }
                rule.Pattern = p;
            }
            if (r.ContainsKey("oneOf"))
            {
                var values = ColumnValues(col, r["oneOf"]);
                if (values == null)
                {
                    error = PatchiriJson.AsArray(r["oneOf"]) == null || PatchiriJson.AsArray(r["oneOf"]).Count == 0 ? "oneOf は値の配列です" : "oneOf に列の型として読めない値があります";
                    return null;
                }
                rule.OneOf = values;
            }
            if (r.ContainsKey("maxChangePercent"))
            {
                if (!NumericTypes.Contains(col.Type))
                {
                    error = "maxChangePercent は数値の列だけに使えます";
                    return null;
                }
                var m = r["maxChangePercent"];
                if (!PatchiriJson.IsNumber(m) || !(PatchiriJson.ToDouble(m) >= 0))
                {
                    error = "maxChangePercent は 0 以上の数です";
                    return null;
                }
                rule.MaxChangePercent = PatchiriJson.ToDouble(m);
            }
            if (r.ContainsKey("when"))
            {
                var w = PatchiriJson.AsObject(r["when"]);
                if (w == null)
                {
                    error = "when は { column, equals } の形です";
                    return null;
                }
                var unknownWhen = new List<string>();
                foreach (var k in w.Keys) if (!WhenKeys.Contains(k)) unknownWhen.Add(k);
                if (unknownWhen.Count > 0)
                {
                    error = "when に知らない項目 " + string.Join(", ", unknownWhen) + " があります";
                    return null;
                }
                var wc = Find(byName, PatchiriJson.Get(w, "column"));
                if (wc == null)
                {
                    error = "when の列 " + Text(PatchiriJson.Get(w, "column")) + " は " + target + " にありません";
                    return null;
                }
                var kinds = 0;
                foreach (var k in new[] { "equals", "oneOf", "empty" }) if (w.ContainsKey(k)) kinds++;
                if (kinds != 1)
                {
                    error = "when には equals、oneOf、empty のどれか 1 つを書きます";
                    return null;
                }
                if (w.ContainsKey("empty"))
                {
                    if (!(w["empty"] is bool))
                    {
                        error = "when.empty は true / false です";
                        return null;
                    }
                    rule.WhenEmpty = (bool)w["empty"];
                }
                else if (w.ContainsKey("oneOf"))
                {
                    var arr = PatchiriJson.AsArray(w["oneOf"]);
                    if (arr == null || arr.Count == 0)
                    {
                        error = "when.oneOf は値の配列です";
                        return null;
                    }
                    rule.WhenValues = ColumnValues(wc, w["oneOf"]);
                }
                else rule.WhenValues = ColumnValues(wc, new ArrayList { w["equals"] });
                if (rule.WhenEmpty == null && rule.WhenValues == null)
                {
                    error = "when の値が列 " + wc.Name + " の型として読めません";
                    return null;
                }
                rule.WhenCol = wc;
                Use(rule, wc);
            }
            return rule;
        }

        static void Use(PatchiriRule rule, ColumnMeta c)
        {
            if (!rule.Columns.Contains(c.Name)) rule.Columns.Add(c.Name);
        }

        static string Text(object v)
        {
            return v as string ?? (v == null ? "undefined" : PatchiriJson.Stringify(v));
        }

        /// <summary>値の配列を列の型の値にする。空か、読めない値があれば null。</summary>
        static List<object> ColumnValues(ColumnMeta col, object raw)
        {
            var arr = PatchiriJson.AsArray(raw);
            if (arr == null || arr.Count == 0) return null;
            var values = new List<object>();
            foreach (var v in arr)
            {
                var cv = ToColumnValue(col, v);
                if (cv == null) return null;
                values.Add(cv);
            }
            return values;
        }

        /// <summary>境界に書いたほかの列と比べられるか（数どうし、または同じ日付・時刻の型）。</summary>
        static bool SameKind(ColumnMeta a, ColumnMeta b)
        {
            if (NumericTypes.Contains(a.Type)) return NumericTypes.Contains(b.Type);
            return a.Type == b.Type;
        }

        /// <summary>ルールの値（0、"2026-04-01" など）を列の型の値にする。読めなければ null。</summary>
        static object ToColumnValue(ColumnMeta col, object raw)
        {
            object v = PatchiriJson.Normalize(raw);
            if (!(v is double) && !(v is string) && !(v is bool)) return null;
            if (v is double && (col.Type == "decimal" || col.Type == "bigint")) v = PatchiriJson.FormatDouble((double)v);
            if (col.Type == "datetime" && v is string && DateRe.IsMatch((string)v)) v = (string)v + "T00:00:00";
            // 桁の上限はルールの値には当てない（「100 万以下」などは列の桁より小さいとは限らない）。
            var loose = new ColumnMeta { Name = col.Name, Type = col.Type, DbType = col.DbType, Nullable = true, Scale = col.Scale };
            return PatchiriValues.CheckValue(loose, v, true) == null ? v : null;
        }

        static string Show(object v)
        {
            var s = v as string;
            if (s != null) return s;
            if (v is bool) return (bool)v ? "true" : "false";
            if (PatchiriJson.IsNumber(v)) return PatchiriJson.FormatDouble(PatchiriJson.ToDouble(v));
            return PatchiriJson.Stringify(v);
        }

        static bool IsEmpty(object v)
        {
            return v == null || (v is string && ((string)v).Length == 0);
        }

        /// <summary>数の値（数値か 10 進の文字列）を 10 進の文字列にする。</summary>
        static string DecimalText(object v)
        {
            if (!PatchiriJson.IsNumber(v)) return Convert.ToString(v, CultureInfo.InvariantCulture);
            var d = PatchiriJson.ToDouble(v);
            if (Math.Floor(d) == d && Math.Abs(d) < 1e15) return ((long)d).ToString(CultureInfo.InvariantCulture);
            // decimal は double を 15 桁で丸めて受け取る（JS の toPrecision(15) と同じ）。
            if (Math.Abs(d) < 1e28) return ((decimal)d).ToString(CultureInfo.InvariantCulture);
            return PatchiriJson.FormatDouble(d);
        }

        static int CompareDecimal(string a, string b)
        {
            var ca = (string)PatchiriValues.Canonical("decimal", a);
            var cb = (string)PatchiriValues.Canonical("decimal", b);
            var na = ca.StartsWith("-", StringComparison.Ordinal);
            var nb = cb.StartsWith("-", StringComparison.Ordinal);
            if (na != nb) return na ? -1 : 1;
            var sign = na ? -1 : 1;
            var pa = ca.TrimStart('-').Split('.');
            var pb = cb.TrimStart('-').Split('.');
            string ai = pa[0], af = pa.Length > 1 ? pa[1] : "", bi = pb[0], bf = pb.Length > 1 ? pb[1] : "";
            if (ai.Length != bi.Length) return (ai.Length < bi.Length ? -1 : 1) * sign;
            var len = Math.Max(af.Length, bf.Length);
            var x = ai + af.PadRight(len, '0');
            var y = bi + bf.PadRight(len, '0');
            var c = string.CompareOrdinal(x, y);
            return c == 0 ? 0 : (c < 0 ? -1 : 1) * sign;
        }

        /// <summary>型に沿って大小を比べる。</summary>
        static int CompareValues(ColumnMeta col, object a, object b)
        {
            switch (col.Type)
            {
                case "integer":
                case "float":
                    return Math.Sign(PatchiriJson.ToDouble(a) - PatchiriJson.ToDouble(b));
                case "bigint":
                case "decimal":
                    return CompareDecimal(DecimalText(a), DecimalText(b));
                default:
                    {
                        var x = Convert.ToString(PatchiriValues.Canonical(col.Type, a), CultureInfo.InvariantCulture);
                        var y = Convert.ToString(PatchiriValues.Canonical(col.Type, b), CultureInfo.InvariantCulture);
                        var c = string.CompareOrdinal(x, y);
                        return c == 0 ? 0 : c < 0 ? -1 : 1;
                    }
            }
        }

        static bool CompareEqual(ColumnMeta col, object a, object b)
        {
            if (OrderedTypes.Contains(col.Type)) return CompareValues(col, a, b) == 0;
            if (a is string && b is string) return string.Equals((string)a, (string)b, StringComparison.Ordinal);
            if (a is bool && b is bool) return (bool)a == (bool)b;
            return false;
        }

        /// <summary>行の値で、when の条件に合うか。条件の列が行に無ければ null（見られない）。</summary>
        static bool? WhenHolds(PatchiriRule rule, Row row)
        {
            if (rule.WhenCol == null) return true;
            object v;
            if (!row.TryGetValue(rule.WhenCol.Name, out v)) return null;
            if (rule.WhenEmpty.HasValue) return IsEmpty(v) == rule.WhenEmpty.Value;
            if (IsEmpty(v)) return false;
            foreach (var w in rule.WhenValues) if (CompareEqual(rule.WhenCol, w, v)) return true;
            return false;
        }

        /// <summary>
        /// 1 つの値をルールで見る（row は同じ行のほかの列の値）。合わなければ理由を返す。変動率はここでは見ない（CheckChange）。
        /// ルールの列が row に無ければ見ない。
        /// </summary>
        public static string Check(PatchiriRule rule, object v, Row row)
        {
            foreach (var c in rule.Columns) if (c != rule.Column && !row.ContainsKey(c)) return null;
            if (WhenHolds(rule, row) != true) return null;
            v = PatchiriJson.Normalize(v);
            if (IsEmpty(v)) return rule.Required ? (rule.Message ?? "必須です（業務ルール）") : null;
            var texts = new[] { " 以上にしてください", " 以下にしてください", " より大きくしてください", " より小さくしてください" };
            for (var i = 0; i < BoundKeys.Length; i++)
            {
                var k = BoundKeys[i];
                object bound;
                string text;
                if (rule.Bounds.TryGetValue(k, out bound)) text = Show(bound);
                else
                {
                    ColumnMeta other;
                    if (!rule.BoundColumns.TryGetValue(k, out other)) continue;
                    bound = PatchiriJson.Normalize(row[other.Name]);
                    // 比べる相手の列が空なら、その境界は見ない。
                    if (IsEmpty(bound)) continue;
                    text = other.Name + "（" + Show(bound) + "）";
                }
                // ほかの列の値は型が違いうる（int と decimal など）ので、数は 10 進の文字列にして比べる。
                var cmp = NumericTypes.Contains(rule.Col.Type) && (v is double) != (bound is double)
                    ? CompareDecimal(DecimalText(v), DecimalText(bound))
                    : CompareValues(rule.Col, v, bound);
                var broken = (k == "min" && cmp < 0) || (k == "max" && cmp > 0) || (k == "greaterThan" && cmp <= 0) || (k == "lessThan" && cmp >= 0);
                if (broken) return rule.Message ?? text + texts[i];
            }
            var s = v as string;
            if (rule.Regex != null && s != null && !rule.Regex.IsMatch(s)) return rule.Message ?? "決まった形（" + rule.Pattern + "）になっていません";
            if (rule.OneOf != null)
            {
                foreach (var o in rule.OneOf) if (CompareEqual(rule.Col, o, v)) return null;
                var shown = new List<string>();
                foreach (var o in rule.OneOf) shown.Add(Show(o));
                return rule.Message ?? "使える値は " + string.Join(", ", shown) + " です";
            }
            return null;
        }

        /// <summary>
        /// ルールの列とは別の列に付ける文（行のルールで、ルールの列をその行で変えていないとき）。コアの ruleMessageAt と同じ。
        /// ルールの文はルールの列についてのものなので、頭にその列と今の値を付ける。message を書いたルールはそのまま。
        /// </summary>
        public static string MessageAt(PatchiriRule rule, string message, string column, Row row)
        {
            if (column == rule.Column || rule.Message != null) return message;
            object v;
            row.TryGetValue(rule.Column, out v);
            v = PatchiriJson.Normalize(v);
            var head = IsEmpty(v) ? rule.Column + " は" : rule.Column + "（" + Show(v) + "）は";
            return message.Length > 0 && message[0] >= '!' && message[0] <= '~' ? head + " " + message : head + message;
        }

        /// <summary>今の値から新しい値への変動がルールの上限を超えていれば理由を返す。when は row で見る。</summary>
        public static string CheckChange(PatchiriRule rule, object before, object after, Row row)
        {
            if (!rule.MaxChangePercent.HasValue || before == null || after == null) return null;
            if (WhenHolds(rule, row) != true) return null;
            double b, a;
            if (!TryNumber(before, out b) || !TryNumber(after, out a)) return null;
            if (b == 0) return a == 0 ? null : (rule.Message ?? "今の値が 0 なので変動率を出せません（" + Show(after) + " にします）");
            var pct = Math.Abs(a - b) / Math.Abs(b) * 100;
            if (pct <= rule.MaxChangePercent.Value + 1e-9) return null;
            var rounded = Math.Round(pct * 10, MidpointRounding.AwayFromZero) / 10;
            return rule.Message ?? "今の値 " + Show(before) + " から " + PatchiriJson.FormatDouble(rounded) + "% 変わります（±" + PatchiriJson.FormatDouble(rule.MaxChangePercent.Value) + "% まで）";
        }

        static bool TryNumber(object v, out double d)
        {
            if (PatchiriJson.IsNumber(v))
            {
                d = PatchiriJson.ToDouble(v);
                return !double.IsNaN(d) && !double.IsInfinity(d);
            }
            var s = v as string;
            if (s != null && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return true;
            d = 0;
            return false;
        }
    }
}
