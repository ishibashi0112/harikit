// Oracle の方言。SQL はここでだけ組み、値はすべてパラメータで渡す。
// テーブル名と列名は DB の定義から取り、"" で囲む。Node 版の oracle.ts と同じ SQL を流す。
//
// ドライバは ODP.NET Managed Driver（Oracle.ManagedDataAccess.dll。Oracle Client を入れなくてよい）。
// コンパイル時には参照せず、web.config の providerName で名前から読み込む（SQL Server だけの載せ先に DLL を要らせず、
// 載せ先が NuGet で入れた版をそのまま使うため）。ADO.NET の共通の型（DbConnection など）で使い、
// ODP.NET にしかない設定（OracleCommand.BindByName と OracleParameter.OracleDbType）だけリフレクションで触る。
//
// Oracle で気をつけること（Oracle 23ai Free と 21c XE で確かめた。詳しくは oracle.ts の先頭）:
// - CHAR / NCHAR の列は、パラメータを列と同じ型に CAST して比べる（VARCHAR2 のままだと末尾の空白を詰めずに比べ、当たらない）。
// - NVARCHAR2 / NCHAR の値は NVARCHAR2 で渡す（VARCHAR2 で渡すと DB の文字コードを通り、表せない字が崩れる）。
// - 空文字は NULL になる。文字列の列に emptyIsNull を付け、コアが空文字を NULL として扱う。
// - = はセッションの NLS_COMP に従うので、つないだら BINARY にする。値が変わっていないかは 12.2 以降なら COLLATE BINARY も付ける。
// - NUMBER は .NET の decimal（28 桁）に収まらないことがあるので（NUMBER(38) を読むと OverflowException）、TO_CHAR で文字列にして読む。
//   TO_CHAR と TO_NUMBER はセッションの NLS_NUMERIC_CHARACTERS に従い、ODP.NET はこれを .NET のカルチャから決める（de-DE なら ","）ので、
//   つないだら '.,' にする。変えたセッションの設定は、接続をプールに返す前に元に戻す（載せ先のアプリと同じプールを使いうるため）。

using System;
using System.Collections.Generic;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using Row = System.Collections.Generic.Dictionary<string, object>;

namespace Patchiri.Server
{
    public sealed class OracleDialect : IPatchiriDialect
    {
        /// <summary>web.config の providerName。ODP.NET Managed Driver だけを扱う。</summary>
        public const string ProviderName = "Oracle.ManagedDataAccess.Client";

        /// <summary>DB の文字コード（NLS_CHARACTERSET / NLS_NCHAR_CHARACTERSET）→ WHATWG の文字コード名（仕様 3）。</summary>
        static readonly Dictionary<string, string> Charsets = new Dictionary<string, string>
        {
            { "AL32UTF8", "utf-8" },
            // CESU-8。補助面の字は 6 バイトになるので、バイト数の最後の確認は DB で行う。
            { "UTF8", "utf-8" },
            // 中身は UTF-16BE だが、バイト数は同じ。
            { "AL16UTF16", "utf-16le" },
            { "JA16SJIS", "shift_jis" }, { "JA16SJISTILDE", "shift_jis" },
            { "JA16EUC", "euc-jp" }, { "JA16EUCTILDE", "euc-jp" },
            { "ZHS16GBK", "gbk" },
            { "ZHT16BIG5", "big5" }, { "ZHT16MSWIN950", "big5" }, { "ZHT16HKSCS", "big5" },
            { "KO16MSWIN949", "euc-kr" }, { "KO16KSC5601", "euc-kr" },
            { "TH8TISASCII", "windows-874" },
            { "EE8MSWIN1250", "windows-1250" }, { "CL8MSWIN1251", "windows-1251" }, { "WE8MSWIN1252", "windows-1252" },
            // WHATWG には ISO-8859-1 がなく windows-1252 として読む。違う字（0x80〜0x9F）は DB で確かめる。
            { "WE8ISO8859P1", "windows-1252" },
            { "WE8ISO8859P15", "iso-8859-15" },
            { "EL8MSWIN1253", "windows-1253" }, { "TR8MSWIN1254", "windows-1254" }, { "IW8MSWIN1255", "windows-1255" },
            { "AR8MSWIN1256", "windows-1256" }, { "BLT8MSWIN1257", "windows-1257" }, { "VN8MSWIN1258", "windows-1258" },
        };

        /// <summary>比べ方をそろえる。人が流すスクリプトの先頭にも入れる（数値はリテラルで書くので NLS_NUMERIC_CHARACTERS は要らない）。</summary>
        const string SessionSqlCompare = "ALTER SESSION SET NLS_COMP = 'BINARY' NLS_SORT = 'BINARY'";
        /// <summary>そろえるセッションの設定と値（この順で読み、変え、戻す）。</summary>
        static readonly string[] SessionParams = { "NLS_COMP", "NLS_SORT", "NLS_NUMERIC_CHARACTERS" };
        static readonly string[] SessionValues = { "BINARY", "BINARY", ".," };

        static readonly Regex TablePartRe = new Regex(@"\G\s*(?:""([^""]+)""|([^.""\s@]+))\s*(?:\.|\z)");
        static readonly Regex TypeLengthRe = new Regex(@"\([0-9]+\)");

        /// <summary>
        /// 人が流す SQL で、1 つのリテラルに書く長さ（文字数）。SQL*Plus は 1 行が 2499 文字（23ai は 4999）を超えると読まないので、
        /// 長い値は分けて || でつなぐ。UNISTR の \XXXX は 1 字が 10 文字まで膨らむ。
        /// </summary>
        const int LiteralChunk = 100;

        const string LockedMessage = "対象の行がほかのセッションにロックされています。コミットしていない更新が残っていないか確かめてから、もう一度試してください";

        sealed class OraTable
        {
            public string Owner;
            public string Name;
            /// <summary>値の厳密な比べ方に COLLATE BINARY を使えるか（12.2 以降）。</summary>
            public bool Collate;
            /// <summary>DB の文字コード（WHATWG の名前）。戻し SQL で N'' に書けない字を見分ける。</summary>
            public string DbEncoding;
            public Encoding DbByteEncoding;
        }

        sealed class DbInfo
        {
            /// <summary>版（23.4 なら 2304）。</summary>
            public int Version;
            public string Charset;
            public string NcharCharset;
        }

        readonly string connectionString;
        readonly int lockWaitSeconds;
        readonly OracleDriver driver;
        readonly object sync = new object();
        DbInfo info;

        /// <param name="lockWaitSeconds">反映で行のロックを待つ秒数（SELECT … FOR UPDATE WAIT n）。過ぎたら db_error で何も変えない。</param>
        public OracleDialect(string connectionString, int lockWaitSeconds = 10)
        {
            this.connectionString = connectionString;
            this.lockWaitSeconds = lockWaitSeconds;
            driver = new OracleDriver();
        }

        public string Name
        {
            get { return "oracle"; }
        }

        /// <summary>
        /// ODP.NET を名前で読み込み、Oracle にしかない設定（BindByName、OracleDbType）を触る小道具。
        /// 載せ先に登録があれば DbProviderFactories から、なければ bin の Oracle.ManagedDataAccess.dll から読む。
        /// </summary>
        sealed class OracleDriver
        {
            public readonly DbProviderFactory Factory;
            readonly PropertyInfo bindByName;
            readonly PropertyInfo longFetchSize;
            readonly PropertyInfo oracleDbType;
            readonly Dictionary<string, object> dbTypes = new Dictionary<string, object>();

            public OracleDriver()
            {
                try
                {
                    Factory = DbProviderFactories.GetFactory(ProviderName);
                }
                catch (Exception)
                {
                    var type = Type.GetType("Oracle.ManagedDataAccess.Client.OracleClientFactory, Oracle.ManagedDataAccess", false);
                    var field = type == null ? null : type.GetField("Instance", BindingFlags.Public | BindingFlags.Static);
                    if (field == null)
                        throw new PatchiriConfigException("Oracle につなぐ ODP.NET（Oracle.ManagedDataAccess.dll）が見つかりません。NuGet で Oracle.ManagedDataAccess を入れるか、bin に置いてください");
                    Factory = (DbProviderFactory)field.GetValue(null);
                }
                var commandType = Factory.CreateCommand().GetType();
                bindByName = commandType.GetProperty("BindByName");
                longFetchSize = commandType.GetProperty("InitialLONGFetchSize");
                oracleDbType = Factory.CreateParameter().GetType().GetProperty("OracleDbType");
                if (bindByName == null || oracleDbType == null) throw new PatchiriConfigException(ProviderName + " が ODP.NET ではありません");
                foreach (var name in new[] { "Varchar2", "NVarchar2", "BinaryDouble", "Int32" }) dbTypes[name] = Enum.Parse(oracleDbType.PropertyType, name);
            }

            public DbCommand Command(DbConnection conn, DbTransaction tx, string sql)
            {
                var cmd = conn.CreateCommand();
                cmd.Transaction = tx;
                cmd.CommandText = sql;
                // :名前 のパラメータを名前で結ぶ（ODP.NET の既定は書いた順）。
                bindByName.SetValue(cmd, true, null);
                // LONG の列も全部読む（既定の 0 では中身を読まない）。
                if (longFetchSize != null) longFetchSize.SetValue(cmd, -1, null);
                return cmd;
            }

            /// <summary>パラメータを足す。type は OracleDbType の名前（"Varchar2"、"NVarchar2" など）。</summary>
            public DbParameter Add(DbCommand cmd, string name, string type, object value, ParameterDirection direction = ParameterDirection.Input)
            {
                var p = cmd.CreateParameter();
                p.ParameterName = name;
                oracleDbType.SetValue(p, dbTypes[type], null);
                p.Direction = direction;
                if (direction == ParameterDirection.Input) p.Value = value ?? DBNull.Value;
                cmd.Parameters.Add(p);
                return p;
            }
        }

        /// <summary>ドライバのエラーを PatchiriDbException にする。ロック待ちの時間切れには、人向けの固定の文を付ける。</summary>
        static PatchiriDbException DbError(DbException e)
        {
            var error = new PatchiriDbException(e.Message, e);
            var number = e.GetType().GetProperty("Number");
            var n = number == null ? 0 : Convert.ToInt32(number.GetValue(e, null), CultureInfo.InvariantCulture);
            // 23ai は ORA-00054、それより前は ORA-30006 を返す。
            if (n == 54 || n == 30006) error.PublicMessage = LockedMessage;
            return error;
        }

        /// <summary>名前を "" で囲む。</summary>
        public static string QuoteName(string name)
        {
            return "\"" + name.Replace("\"", "\"\"") + "\"";
        }

        /// <summary>
        /// "PATCHIRI.M_PRODUCT"、"m_product"、"\"Mixed\".\"Name\"" を [スキーマ, 名前] に分ける。
        /// "" で囲まない名前は大文字にする（Oracle と同じ）。スキーマを省くと null。DB リンク（@）は受けない。
        /// </summary>
        public static string[] SplitTableName(string table)
        {
            var parts = new List<string>();
            var pos = 0;
            while (pos < table.Length)
            {
                var m = TablePartRe.Match(table, pos);
                if (!m.Success || m.Length == 0) break;
                parts.Add(m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value.ToUpperInvariant());
                pos = m.Index + m.Length;
            }
            if (pos < table.Length || parts.Count == 0 || parts.Count > 2) throw new InvalidOperationException("テーブル名 " + table + " が読めません");
            return parts.Count == 1 ? new[] { null, parts[0] } : new[] { parts[0], parts[1] };
        }

        public string NormalizeTable(string table)
        {
            // 比べるのは DB で引いた名前（DescribeTable の Table と外部キーの参照先）どうしなので、そのまま比べる。
            return table;
        }

        /// <summary>WHATWG の名前の文字コード。表せない字は例外にする。使えなければ null（utf-16le も、バイト数は文字数から出すので null）。</summary>
        static Encoding WebEncoding(string name)
        {
            if (name == null || name == "utf-16le") return null;
            if (name == "utf-8") return new UTF8Encoding(false, true);
            try
            {
                return Encoding.GetEncoding(name, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback);
            }
            catch (ArgumentException)
            {
                return null;
            }
            catch (NotSupportedException)
            {
                return null;
            }
        }

        static int? NullableInt(object v)
        {
            return v == null || v is DBNull ? (int?)null : Convert.ToInt32(v, CultureInfo.InvariantCulture);
        }

        /// <summary>ALL_TAB_COLS の 1 行を列の定義にする（oracle.ts の oracleColumn と同じ）。</summary>
        static ColumnMeta Column(object[] r, DbInfo info)
        {
            var name = Convert.ToString(r[0], CultureInfo.InvariantCulture);
            var dataType = Convert.ToString(r[1], CultureInfo.InvariantCulture);
            var dataLength = Convert.ToInt32(r[2], CultureInfo.InvariantCulture);
            var charLength = Convert.ToInt32(r[3], CultureInfo.InvariantCulture);
            var charUsed = r[4] as string;
            var precision = NullableInt(r[5]);
            var scale = NullableInt(r[6]);
            var baseType = TypeLengthRe.Replace(dataType, "").Trim();
            var col = new ColumnMeta { Name = name, Type = "other", DbType = dataType, Nullable = (string)r[7] == "Y", BaseType = baseType };
            switch (baseType)
            {
                case "VARCHAR2":
                case "CHAR":
                    {
                        // 桁の単位は列ごと（VARCHAR2(10 BYTE) / VARCHAR2(10 CHAR)）。どちらでもバイトの上限は DATA_LENGTH。
                        var spec = charLength.ToString(CultureInfo.InvariantCulture) + (charUsed == "C" ? " CHAR" : " BYTE");
                        col.Type = "string";
                        col.DbType = baseType + "(" + spec + ")";
                        if (baseType == "CHAR") col.SqlType = "CHAR(" + spec + ")";
                        string encoding;
                        if (info.Charset != null && Charsets.TryGetValue(info.Charset, out encoding)) col.Encoding = encoding;
                        break;
                    }
                case "NVARCHAR2":
                case "NCHAR":
                    {
                        var spec = charLength.ToString(CultureInfo.InvariantCulture);
                        col.Type = "string";
                        col.DbType = baseType + "(" + spec + ")";
                        if (baseType == "NCHAR") col.SqlType = "NCHAR(" + spec + ")";
                        string encoding;
                        if (info.NcharCharset != null && Charsets.TryGetValue(info.NcharCharset, out encoding)) col.Encoding = encoding;
                        break;
                    }
                case "NUMBER":
                    // 負の scale（NUMBER(5,-2)）は入れた値が丸められ、戻し SQL の条件が合わなくなるので扱わない。
                    if (scale.HasValue && scale.Value < 0) break;
                    col.Type = "decimal";
                    // INTEGER は NUMBER(*,0)。精度のない NUMBER は桁を見ない。
                    if (!precision.HasValue && !scale.HasValue) col.DbType = "NUMBER";
                    else
                    {
                        col.DbType = precision.HasValue
                            ? "NUMBER(" + precision.Value + "," + (scale ?? 0) + ")"
                            : "NUMBER(*," + scale.Value + ")";
                        col.Precision = precision ?? 38;
                        col.Scale = scale ?? 0;
                    }
                    break;
                case "FLOAT":
                    col.Type = "decimal";
                    col.DbType = precision.HasValue ? "FLOAT(" + precision.Value + ")" : "FLOAT";
                    break;
                case "BINARY_FLOAT":
                case "BINARY_DOUBLE":
                    col.Type = "float";
                    col.DbType = baseType;
                    break;
                case "DATE":
                    // Oracle の DATE は時刻（秒まで）を持つ。
                    col.Type = "datetime";
                    col.DbType = "DATE";
                    col.Scale = 0;
                    break;
                case "TIMESTAMP":
                    col.Type = "datetime";
                    col.DbType = "TIMESTAMP(" + (scale ?? 6) + ")";
                    col.Scale = scale ?? 6;
                    break;
                case "BOOLEAN":
                    col.Type = "boolean";
                    col.DbType = "BOOLEAN";
                    break;
                case "RAW":
                    col.DbType = "RAW(" + dataLength + ")";
                    break;
            }
            if (col.Type == "string")
            {
                col.MaxLength = charLength;
                col.MaxBytes = dataLength;
                col.EmptyIsNull = true;
                col.ByteEncoding = WebEncoding(col.Encoding);
            }
            var defaultLength = NullableInt(r[8]);
            var isVirtual = (string)r[9] == "YES";
            var identity = r.Length > 10 && r[10] as string == "YES";
            if (identity) col.Identity = true;
            if (isVirtual) col.Computed = true;
            if (!identity && !isVirtual && (defaultLength ?? 0) > 0) col.HasDefault = true;
            return col;
        }

        /// <summary>SELECT で値を仕様 1.3 の形で受け取るための式。NUMBER は文字列で受ける。</summary>
        static string SelectExpr(ColumnMeta col, string prefix)
        {
            var q = prefix + QuoteName(col.Name);
            switch (col.BaseType)
            {
                case "NUMBER":
                case "FLOAT":
                    return "TO_CHAR(" + q + ")";
                case "DATE":
                    return "TO_CHAR(" + q + ", 'YYYY-MM-DD\"T\"HH24:MI:SS')";
                case "TIMESTAMP":
                    return "TO_CHAR(" + q + ", 'YYYY-MM-DD\"T\"HH24:MI:SS.FF9')";
                case "TIMESTAMP WITH TIME ZONE":
                case "TIMESTAMP WITH LOCAL TIME ZONE":
                    return "TO_CHAR(" + q + ", 'YYYY-MM-DD\"T\"HH24:MI:SS.FF9TZH:TZM')";
                case "INTERVAL YEAR TO MONTH":
                case "INTERVAL DAY TO SECOND":
                    return "TO_CHAR(" + q + ")";
                case "BOOLEAN":
                    // BOOLEAN（23ai）を読めない ODP.NET（19c まで）でも読めるよう、数にする。
                    return "CASE WHEN " + q + " THEN 1 WHEN NOT " + q + " THEN 0 END";
                case "RAW":
                    return "RAWTOHEX(" + q + ")";
                case "ROWID":
                case "UROWID":
                    return "ROWIDTOCHAR(" + q + ")";
                default:
                    return q;
            }
        }

        /// <summary>Oracle の数値の文字列（".5"、"-.5"）を仕様の形にし、scale の桁まで 0 を足す（NUMBER(9,2) の 120 → "120.00"）。</summary>
        public static string DecimalText(string s, int? scale)
        {
            var t = s.StartsWith(".", StringComparison.Ordinal) ? "0" + s : s.StartsWith("-.", StringComparison.Ordinal) ? "-0" + s.Substring(1) : s;
            if (scale.HasValue && scale.Value > 0 && PatchiriValues.DecimalRe.IsMatch(t))
            {
                var dot = t.IndexOf('.');
                var frac = dot < 0 ? 0 : t.Length - dot - 1;
                if (frac < scale.Value) t = (dot < 0 ? t + "." : t) + new string('0', scale.Value - frac);
            }
            return t;
        }

        static object ReadValue(ColumnMeta col, object v)
        {
            if (v == null || v is DBNull) return null;
            switch (col.Type)
            {
                case "decimal":
                    return DecimalText(Convert.ToString(v, CultureInfo.InvariantCulture), col.Scale);
                case "datetime":
                    return PatchiriValues.CanonicalFraction(Convert.ToString(v, CultureInfo.InvariantCulture));
                case "float":
                    // BINARY_FLOAT は float のまま double にする（0.1 にすると、送り返された before が DB の値と合わなくなる）。
                    return PatchiriJson.JsonNumber(v is float ? (double)(float)v : Convert.ToDouble(v, CultureInfo.InvariantCulture));
                case "boolean":
                    return Convert.ToInt32(v, CultureInfo.InvariantCulture) == 1;
            }
            var bytes = v as byte[];
            if (bytes != null)
            {
                var sb = new StringBuilder(bytes.Length * 2);
                foreach (var b in bytes) sb.Append(b.ToString("X2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
            if (v is string) return v;
            if (PatchiriJson.IsNumber(v)) return PatchiriJson.JsonNumber(PatchiriJson.ToDouble(v));
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        /// <summary>日時の値（"2024-04-01T10:00:00"）を TO_DATE / TO_TIMESTAMP に渡す形にする。TIMESTAMP は小数を 9 桁にそろえる。</summary>
        static string DateTimeText(ColumnMeta col, object v)
        {
            var s = PatchiriValues.CanonicalFraction(Convert.ToString(v, CultureInfo.InvariantCulture));
            var t = s.IndexOf('T');
            if (t < 0) throw new InvalidOperationException("日時ではない値: " + s);
            var date = s.Substring(0, t);
            var time = s.Substring(t + 1);
            if (col.BaseType == "DATE") return date + " " + time;
            var dot = time.IndexOf('.');
            var hms = dot < 0 ? time : time.Substring(0, dot);
            var frac = dot < 0 ? "" : time.Substring(dot + 1);
            return date + " " + hms + "." + frac.PadRight(9, '0');
        }

        /// <summary>値を渡す式を作り、パラメータを足す。数値と日時は文字列で渡して DB で読む（精度を崩さない）。</summary>
        string BindValue(DbCommand cmd, string name, ColumnMeta col, object v)
        {
            if (v == null) return "NULL";
            var p = ":" + name;
            switch (col.BaseType)
            {
                case "VARCHAR2":
                    driver.Add(cmd, name, "Varchar2", (string)v);
                    return p;
                case "CHAR":
                    driver.Add(cmd, name, "Varchar2", (string)v);
                    return "CAST(" + p + " AS " + col.SqlType + ")";
                case "NVARCHAR2":
                    driver.Add(cmd, name, "NVarchar2", (string)v);
                    return p;
                case "NCHAR":
                    driver.Add(cmd, name, "NVarchar2", (string)v);
                    return "CAST(" + p + " AS " + col.SqlType + ")";
                case "NUMBER":
                case "FLOAT":
                    driver.Add(cmd, name, "Varchar2", Convert.ToString(v, CultureInfo.InvariantCulture));
                    return "TO_NUMBER(" + p + ")";
                case "BINARY_FLOAT":
                case "BINARY_DOUBLE":
                    driver.Add(cmd, name, "BinaryDouble", PatchiriJson.ToDouble(v));
                    return p;
                case "BOOLEAN":
                    // BOOLEAN のパラメータを渡せない ODP.NET（19c まで）でも渡せるよう、文字列にして DB で読む。
                    driver.Add(cmd, name, "Varchar2", (bool)v ? "TRUE" : "FALSE");
                    return "TO_BOOLEAN(" + p + ")";
                case "DATE":
                    driver.Add(cmd, name, "Varchar2", DateTimeText(col, v));
                    return "TO_DATE(" + p + ", 'YYYY-MM-DD HH24:MI:SS')";
                case "TIMESTAMP":
                    driver.Add(cmd, name, "Varchar2", DateTimeText(col, v));
                    return "TO_TIMESTAMP(" + p + ", 'YYYY-MM-DD HH24:MI:SS.FF9')";
                default:
                    throw new InvalidOperationException("列 " + col.Name + " の型 " + col.DbType + " は扱えません");
            }
        }

        static string QuoteString(string s)
        {
            return "'" + s.Replace("'", "''") + "'";
        }

        /// <summary>コードポイントごとに分ける（サロゲートペアを 1 つにする）。</summary>
        static List<string> CodePoints(string s)
        {
            var list = new List<string>();
            for (var i = 0; i < s.Length; i++)
            {
                var n = char.IsHighSurrogate(s[i]) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]) ? 2 : 1;
                list.Add(s.Substring(i, n));
                i += n - 1;
            }
            return list;
        }

        static string Hex4(int code)
        {
            return code.ToString("X4", CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// NVARCHAR2 / NCHAR のリテラル（改行を含まない一続き）。N'' の中身は DB の文字コードを通るので、DB の文字コードで表せない字があれば
        /// UNISTR の \XXXX で書く（表せる字はそのまま残して読めるようにする）。UNISTR は NVARCHAR2 を返す。literal は '' / N'' のリテラルか。
        /// </summary>
        static string NationalPiece(List<string> chars, OraTable t, out bool literal)
        {
            Func<string, bool> plain = ch =>
            {
                if (char.ConvertToUtf32(ch, 0) < 0x80) return true;
                if (t.DbEncoding == "utf-8") return true;
                return t.DbByteEncoding != null && PatchiriValues.CanEncode(t.DbByteEncoding, ch);
            };
            literal = chars.TrueForAll(ch => plain(ch));
            if (literal) return "N" + QuoteString(string.Concat(chars));
            var body = new StringBuilder();
            foreach (var ch in chars)
            {
                if (ch == "\\") body.Append("\\005C");
                else if (ch == "'") body.Append("''");
                else if (plain(ch)) body.Append(ch);
                else foreach (var c in ch) body.Append('\\').Append(Hex4(c));
            }
            return "UNISTR('" + body + "')";
        }

        /// <summary>
        /// 文字列の列のリテラル。改行は値の中に書かず CHR(10) / UNISTR('\000A') にする。SQL*Plus は文字列の中でも、
        /// / や . だけの行を文の終わりとして、# で始まる行を SQL*Plus のコマンドとして読んでしまうため。
        /// 分けてつないだ値は VARCHAR2 / NVARCHAR2 になるので、CHAR / NCHAR の列では列の型に CAST する（末尾の空白を見ない比べ方のまま）。
        /// </summary>
        static string StringLiteral(ColumnMeta col, string s, OraTable t)
        {
            var national = col.BaseType == "NVARCHAR2" || col.BaseType == "NCHAR";
            var pieces = new List<string>();
            var literals = new List<bool>();
            var token = new StringBuilder();
            Action flush = () =>
            {
                if (token.Length == 0) return;
                var chars = CodePoints(token.ToString());
                token.Length = 0;
                for (var i = 0; i < chars.Count; i += LiteralChunk)
                {
                    var part = chars.GetRange(i, Math.Min(LiteralChunk, chars.Count - i));
                    var literal = true;
                    pieces.Add(national ? NationalPiece(part, t, out literal) : QuoteString(string.Concat(part)));
                    literals.Add(literal);
                }
            };
            foreach (var c in s)
            {
                if (c != '\r' && c != '\n')
                {
                    token.Append(c);
                    continue;
                }
                flush();
                var code = c == '\n' ? 10 : 13;
                pieces.Add(national ? "UNISTR('\\" + Hex4(code) + "')" : "CHR(" + code + ")");
                literals.Add(false);
            }
            flush();
            // 文字列のリテラル（'' と N''）はそのままで CHAR / NCHAR の列と末尾の空白を見ずに比べられる。
            if (pieces.Count == 0) return QuoteString(s);
            if (pieces.Count == 1 && literals[0]) return pieces[0];
            var joined = string.Join("\n      || ", pieces);
            return col.SqlType != null ? "CAST(" + joined + " AS " + col.SqlType + ")" : joined;
        }

        /// <summary>人が読む SQL 用の値の書き方。値は CheckValue で形を確かめた後のものだけが来る。</summary>
        static string Literal(ColumnMeta col, object v, OraTable t)
        {
            if (v == null) return "NULL";
            switch (col.BaseType)
            {
                case "VARCHAR2":
                case "CHAR":
                case "NVARCHAR2":
                case "NCHAR":
                    // 文字列のリテラルは CHAR 扱いなので、CHAR の列とは末尾の空白を見ずに比べ、VARCHAR2 の列とは厳密に比べる。
                    return StringLiteral(col, (string)v, t);
                case "NUMBER":
                case "FLOAT":
                    {
                        var s = v as string;
                        if (s == null || !PatchiriValues.DecimalRe.IsMatch(s)) throw new InvalidOperationException("数値ではない値: " + v);
                        return s;
                    }
                case "BINARY_FLOAT":
                case "BINARY_DOUBLE":
                    {
                        var d = PatchiriJson.ToDouble(v);
                        if (double.IsNaN(d) || double.IsInfinity(d)) throw new InvalidOperationException("数値ではない値: " + v);
                        return PatchiriJson.FormatDouble(d);
                    }
                case "BOOLEAN":
                    return (bool)v ? "TRUE" : "FALSE";
                case "DATE":
                    return "TO_DATE('" + DateTimeText(col, v) + "', 'YYYY-MM-DD HH24:MI:SS')";
                case "TIMESTAMP":
                    return "TIMESTAMP '" + PatchiriValues.CanonicalFraction((string)v).Replace("T", " ") + "'";
                default:
                    throw new InvalidOperationException("列 " + col.Name + " の型 " + col.DbType + " は SQL に書けません");
            }
        }

        static string KeyCondition(ColumnMeta col, string expr)
        {
            return QuoteName(col.Name) + " = " + expr;
        }

        /// <summary>値が厳密に同じかの条件（仕様 1.6）。NULL は NULL とだけ同じ。</summary>
        static string SameCondition(ColumnMeta col, string expr, bool collate)
        {
            if (expr == null) return QuoteName(col.Name) + " IS NULL";
            return col.Type == "string" && collate ? QuoteName(col.Name) + " COLLATE BINARY = " + expr : QuoteName(col.Name) + " = " + expr;
        }

        static OraTable Table(TableMeta meta)
        {
            return (OraTable)meta.DialectInfo;
        }

        static string QuoteTable(TableMeta meta)
        {
            var t = Table(meta);
            return QuoteName(t.Owner) + "." + QuoteName(t.Name);
        }

        /// <summary>つないだ接続。閉じるときに、変えたセッションの設定を元に戻す（接続はプールに戻り、載せ先のアプリにも使われうる）。</summary>
        sealed class Session : IDisposable
        {
            public readonly DbConnection Conn;
            readonly OracleDriver driver;
            string restore;

            public Session(OracleDriver driver, DbConnection conn)
            {
                this.driver = driver;
                Conn = conn;
            }

            /// <summary>比べ方と数値の書き方をそろえる（違うときだけ変え、戻す文を覚える）。</summary>
            public void Prepare()
            {
                var current = new Dictionary<string, string>();
                var cmd = driver.Command(Conn, null, "SELECT parameter, value FROM nls_session_parameters WHERE parameter IN ('NLS_COMP', 'NLS_SORT', 'NLS_NUMERIC_CHARACTERS')");
                foreach (var r in Query(cmd)) current[Convert.ToString(r[0], CultureInfo.InvariantCulture)] = r[1] as string;
                var set = new List<string>();
                var back = new List<string>();
                for (var i = 0; i < SessionParams.Length; i++)
                {
                    string now;
                    current.TryGetValue(SessionParams[i], out now);
                    if (now == SessionValues[i]) continue;
                    set.Add(SessionParams[i] + " = " + QuoteString(SessionValues[i]));
                    if (now != null) back.Add(SessionParams[i] + " = " + QuoteString(now));
                }
                if (set.Count == 0) return;
                Execute(driver.Command(Conn, null, "ALTER SESSION SET " + string.Join(" ", set)));
                if (back.Count > 0) restore = "ALTER SESSION SET " + string.Join(" ", back);
            }

            public void Dispose()
            {
                try
                {
                    if (restore != null && Conn.State == ConnectionState.Open) Execute(driver.Command(Conn, null, restore));
                }
                catch (Exception)
                {
                    // 接続が切れているなら、プールにも戻らない。
                }
                Conn.Dispose();
            }
        }

        Session Open()
        {
            var conn = driver.Factory.CreateConnection();
            conn.ConnectionString = connectionString;
            var session = new Session(driver, conn);
            try
            {
                conn.Open();
                session.Prepare();
            }
            catch (DbException e)
            {
                session.Dispose();
                throw DbError(e);
            }
            catch
            {
                session.Dispose();
                throw;
            }
            return session;
        }

        static List<object[]> Query(DbCommand cmd)
        {
            var rows = new List<object[]>();
            try
            {
                using (var reader = cmd.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var values = new object[reader.FieldCount];
                        reader.GetValues(values);
                        rows.Add(values);
                    }
                }
            }
            catch (DbException e)
            {
                throw DbError(e);
            }
            return rows;
        }

        static int Execute(DbCommand cmd)
        {
            try
            {
                return cmd.ExecuteNonQuery();
            }
            catch (DbException e)
            {
                throw DbError(e);
            }
        }

        /// <summary>DB の版と文字コード（最初につないだときに 1 度だけ読む）。</summary>
        DbInfo Info(DbConnection conn)
        {
            lock (sync)
            {
                if (info != null) return info;
            }
            var parts = conn.ServerVersion.Split('.');
            var version = int.Parse(parts[0], CultureInfo.InvariantCulture) * 100 + (parts.Length > 1 ? int.Parse(parts[1], CultureInfo.InvariantCulture) : 0);
            var x = new DbInfo { Version = version };
            var cmd = driver.Command(conn, null, "SELECT parameter, value FROM nls_database_parameters WHERE parameter IN ('NLS_CHARACTERSET', 'NLS_NCHAR_CHARACTERSET')");
            foreach (var r in Query(cmd))
            {
                if ((string)r[0] == "NLS_CHARACTERSET") x.Charset = r[1] as string;
                else x.NcharCharset = r[1] as string;
            }
            lock (sync) info = x;
            return x;
        }

        /// <summary>許可リストのテーブル名を、実際のスキーマと名前にする。シノニム（自分のスキーマ、PUBLIC）もたどる。</summary>
        string[] ResolveTable(DbConnection conn, string table)
        {
            var given = SplitTableName(table);
            var owner = given[0];
            if (owner == null) owner = Convert.ToString(Query(driver.Command(conn, null, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual"))[0][0], CultureInfo.InvariantCulture);
            var name = given[1];
            var allowPublic = given[0] == null;
            for (var depth = 0; depth < 8; depth++)
            {
                var cmd = driver.Command(conn, null, "SELECT 1 FROM all_tab_cols WHERE owner = :o AND table_name = :t AND ROWNUM = 1");
                driver.Add(cmd, "o", "Varchar2", owner);
                driver.Add(cmd, "t", "Varchar2", name);
                if (Query(cmd).Count > 0) return new[] { owner, name };
                cmd = driver.Command(conn, null, @"SELECT table_owner, table_name FROM all_synonyms
                    WHERE synonym_name = :t AND db_link IS NULL AND (owner = :o OR (owner = 'PUBLIC' AND :pub = 1))
                    ORDER BY CASE owner WHEN 'PUBLIC' THEN 1 ELSE 0 END");
                driver.Add(cmd, "t", "Varchar2", name);
                driver.Add(cmd, "o", "Varchar2", owner);
                driver.Add(cmd, "pub", "Int32", allowPublic ? 1 : 0);
                var syn = Query(cmd);
                if (syn.Count == 0) break;
                owner = Convert.ToString(syn[0][0], CultureInfo.InvariantCulture);
                name = Convert.ToString(syn[0][1], CultureInfo.InvariantCulture);
                allowPublic = false;
            }
            throw new PatchiriDbException("テーブル " + table + " が見つかりません");
        }

        public TableMeta DescribeTable(string table)
        {
            using (var s = Open())
            {
                var conn = s.Conn;
                var dbInfo = Info(conn);
                var resolved = ResolveTable(conn, table);
                var identity = dbInfo.Version >= 1201 ? ", identity_column" : "";
                var cmd = driver.Command(conn, null, @"SELECT column_name, data_type, data_length, char_length, char_used, data_precision, data_scale,
                    nullable, default_length, virtual_column" + identity + @"
                    FROM all_tab_cols WHERE owner = :o AND table_name = :t AND hidden_column = 'NO' ORDER BY column_id");
                driver.Add(cmd, "o", "Varchar2", resolved[0]);
                driver.Add(cmd, "t", "Varchar2", resolved[1]);
                string dbEncoding;
                if (dbInfo.Charset == null || !Charsets.TryGetValue(dbInfo.Charset, out dbEncoding)) dbEncoding = null;
                var meta = new TableMeta
                {
                    Table = resolved[0] + "." + resolved[1],
                    DialectInfo = new OraTable
                    {
                        Owner = resolved[0],
                        Name = resolved[1],
                        Collate = dbInfo.Version >= 1202,
                        DbEncoding = dbEncoding,
                        DbByteEncoding = WebEncoding(dbEncoding),
                    },
                };
                foreach (var r in Query(cmd)) meta.Columns.Add(Column(r, dbInfo));

                cmd = driver.Command(conn, null, @"SELECT cc.column_name FROM all_constraints k
                    JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name
                    WHERE k.owner = :o AND k.table_name = :t AND k.constraint_type = 'P' ORDER BY cc.position");
                driver.Add(cmd, "o", "Varchar2", resolved[0]);
                driver.Add(cmd, "t", "Varchar2", resolved[1]);
                foreach (var r in Query(cmd)) meta.PrimaryKey.Add(Convert.ToString(r[0], CultureInfo.InvariantCulture));

                cmd = driver.Command(conn, null, @"SELECT k.constraint_name, cc.column_name, r.owner, r.table_name, rc.column_name
                    FROM all_constraints k
                    JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name
                    JOIN all_constraints r ON r.owner = k.r_owner AND r.constraint_name = k.r_constraint_name
                    JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position
                    WHERE k.owner = :o AND k.table_name = :t AND k.constraint_type = 'R' ORDER BY k.constraint_name, cc.position");
                driver.Add(cmd, "o", "Varchar2", resolved[0]);
                driver.Add(cmd, "t", "Varchar2", resolved[1]);
                var fks = new Dictionary<string, ForeignKeyMeta>();
                foreach (var r in Query(cmd))
                {
                    var name = Convert.ToString(r[0], CultureInfo.InvariantCulture);
                    ForeignKeyMeta fk;
                    if (!fks.TryGetValue(name, out fk))
                    {
                        fk = new ForeignKeyMeta { Name = name, ReferencedTable = r[2] + "." + r[3] };
                        fks[name] = fk;
                        meta.ForeignKeys.Add(fk);
                    }
                    fk.Columns.Add(Convert.ToString(r[1], CultureInfo.InvariantCulture));
                    fk.ReferencedColumns.Add(Convert.ToString(r[4], CultureInfo.InvariantCulture));
                }
                return meta;
            }
        }

        public List<Row> FetchRows(TableMeta meta, IList<string> keyColumns, IList<string> columns, IList<Row> keys)
        {
            var keyCols = meta.ColumnsOf(keyColumns);
            var outCols = meta.ColumnsOf(columns);
            var output = new List<Row>();
            for (var i = 0; i < keys.Count; i++) output.Add(null);
            // キーは DUAL の UNION ALL で表にして結び、どのキーに当たったかを __i で戻す（照合順序で当たるので .NET では突き合わせない）。
            var chunk = Math.Max(1, Math.Min(500, 30000 / keyCols.Count));
            using (var s = Open())
            {
                for (var start = 0; start < keys.Count; start += chunk)
                {
                    var count = Math.Min(chunk, keys.Count - start);
                    var cmd = driver.Command(s.Conn, null, "");
                    var values = new List<string>();
                    for (var i = 0; i < count; i++)
                    {
                        var k = keys[start + i];
                        var items = new List<string>();
                        for (var j = 0; j < keyCols.Count; j++)
                            items.Add(BindValue(cmd, "k" + i + "_" + j, keyCols[j], k[keyCols[j].Name]) + (i == 0 ? " AS " + QuoteName("k" + j) : ""));
                        values.Add("SELECT " + i + (i == 0 ? " AS \"__i\"" : "") + ", " + string.Join(", ", items) + " FROM dual");
                    }
                    var on = new List<string>();
                    for (var j = 0; j < keyCols.Count; j++) on.Add("t." + QuoteName(keyCols[j].Name) + " = v." + QuoteName("k" + j));
                    var select = new List<string>();
                    for (var j = 0; j < outCols.Count; j++) select.Add(SelectExpr(outCols[j], "t.") + " AS " + QuoteName("__v" + j));
                    cmd.CommandText = "SELECT v.\"__i\", " + string.Join(", ", select) + " FROM " + QuoteTable(meta) + " t JOIN ("
                        + string.Join(" UNION ALL ", values) + ") v ON " + string.Join(" AND ", on);
                    foreach (var r in Query(cmd))
                    {
                        var i = start + Convert.ToInt32(r[0], CultureInfo.InvariantCulture);
                        if (output[i] != null) throw new PatchiriDbException("キー " + PatchiriJson.Stringify(keys[i]) + " に当たる行が複数あります（キーが一意ではありません）");
                        var row = new Row();
                        for (var j = 0; j < outCols.Count; j++) row[outCols[j].Name] = ReadValue(outCols[j], r[j + 1]);
                        output[i] = row;
                    }
                }
            }
            return output;
        }

        sealed class OraTransaction : IPatchiriTransaction
        {
            readonly OracleDialect d;
            readonly DbConnection conn;
            readonly DbTransaction tx;

            public OraTransaction(OracleDialect d, DbConnection conn, DbTransaction tx)
            {
                this.d = d;
                this.conn = conn;
                this.tx = tx;
            }

            public LockedRow LockAndCompare(TableMeta meta, IList<string> keyColumns, Row key, Row before)
            {
                var keyCols = meta.ColumnsOf(keyColumns);
                var beforeCols = meta.ColumnsOf(before.Keys);
                var cmd = d.driver.Command(conn, tx, "");
                var where = new List<string>();
                for (var i = 0; i < keyCols.Count; i++) where.Add(KeyCondition(keyCols[i], d.BindValue(cmd, "k" + i, keyCols[i], key[keyCols[i].Name])));
                var select = new List<string>();
                var all = new List<ColumnMeta>(keyCols);
                all.AddRange(beforeCols);
                for (var i = 0; i < all.Count; i++) select.Add(SelectExpr(all[i], "") + " AS " + QuoteName("__v" + i));
                for (var i = 0; i < beforeCols.Count; i++)
                {
                    var v = before[beforeCols[i].Name];
                    var cond = SameCondition(beforeCols[i], v == null ? null : d.BindValue(cmd, "b" + i, beforeCols[i], v), Table(meta).Collate);
                    select.Add("CASE WHEN " + cond + " THEN 1 ELSE 0 END AS " + QuoteName("__m" + i));
                }
                cmd.CommandText = "SELECT " + string.Join(", ", select) + " FROM " + QuoteTable(meta) + " WHERE " + string.Join(" AND ", where)
                    + " FOR UPDATE WAIT " + d.lockWaitSeconds.ToString(CultureInfo.InvariantCulture);
                var rows = Query(cmd);
                if (rows.Count == 0) return new LockedRow { Found = false };
                if (rows.Count > 1) throw new PatchiriDbException("キー " + PatchiriJson.Stringify(key) + " に当たる行が " + rows.Count + " 行あります（キーが一意ではありません）");
                var row = rows[0];
                var locked = new LockedRow { Found = true, Current = new Row(), Changed = new List<string>(), DbKey = new Row() };
                for (var i = 0; i < keyCols.Count; i++) locked.DbKey[keyCols[i].Name] = PatchiriValues.Canonical(keyCols[i].Type, ReadValue(keyCols[i], row[i]));
                for (var i = 0; i < beforeCols.Count; i++)
                {
                    locked.Current[beforeCols[i].Name] = ReadValue(beforeCols[i], row[keyCols.Count + i]);
                    if (Convert.ToInt32(row[all.Count + i], CultureInfo.InvariantCulture) != 1) locked.Changed.Add(beforeCols[i].Name);
                }
                return locked;
            }

            public int Update(TableMeta meta, IList<string> keyColumns, Row key, Row set)
            {
                var keyCols = meta.ColumnsOf(keyColumns);
                var setCols = meta.ColumnsOf(set.Keys);
                var cmd = d.driver.Command(conn, tx, "");
                var assigns = new List<string>();
                for (var i = 0; i < setCols.Count; i++) assigns.Add(QuoteName(setCols[i].Name) + " = " + d.BindValue(cmd, "p" + i, setCols[i], set[setCols[i].Name]));
                var where = new List<string>();
                for (var i = 0; i < keyCols.Count; i++) where.Add(KeyCondition(keyCols[i], d.BindValue(cmd, "k" + i, keyCols[i], key[keyCols[i].Name])));
                cmd.CommandText = "UPDATE " + QuoteTable(meta) + " SET " + string.Join(", ", assigns) + " WHERE " + string.Join(" AND ", where);
                // UPDATE 文そのものの行数で、トリガーの中の行数は入らない。
                return Execute(cmd);
            }
        }

        public void RunTransaction(Func<IPatchiriTransaction, bool> fn)
        {
            using (var s = Open())
            {
                DbTransaction tx;
                try
                {
                    tx = s.Conn.BeginTransaction(IsolationLevel.ReadCommitted);
                }
                catch (DbException e)
                {
                    throw DbError(e);
                }
                try
                {
                    var commit = fn(new OraTransaction(this, s.Conn, tx));
                    try
                    {
                        if (commit) tx.Commit();
                        else tx.Rollback();
                    }
                    catch (DbException e)
                    {
                        throw DbError(e);
                    }
                }
                catch
                {
                    try
                    {
                        tx.Rollback();
                    }
                    catch
                    {
                        // つながりが切れていれば、DB 側で取り消される。
                    }
                    throw;
                }
            }
        }

        public List<StringCheck> CheckStrings(TableMeta meta, IList<KeyValuePair<string, string>> items)
        {
            var output = new List<StringCheck>();
            // NVARCHAR2 / NCHAR は Unicode なので見ない。VARCHAR2 / CHAR は DB の文字コードにして戻し、元と同じか（表せない字は置き換わる）とバイト数を見る。
            var targets = new List<int>();
            for (var i = 0; i < items.Count; i++)
            {
                output.Add(null);
                var bt = meta.Column(items[i].Key).BaseType;
                if (bt == "VARCHAR2" || bt == "CHAR") targets.Add(i);
            }
            if (targets.Count == 0) return output;
            using (var s = Open())
            {
                for (var start = 0; start < targets.Count; start += 100)
                {
                    var count = Math.Min(100, targets.Count - start);
                    var cmd = driver.Command(s.Conn, null, "");
                    var calls = new StringBuilder();
                    var outs = new List<DbParameter[]>();
                    for (var j = 0; j < count; j++)
                    {
                        driver.Add(cmd, "s" + j, "NVarchar2", items[targets[start + j]].Value);
                        outs.Add(new[] { driver.Add(cmd, "o" + j, "Int32", null, ParameterDirection.Output), driver.Add(cmd, "b" + j, "Int32", null, ParameterDirection.Output) });
                        calls.Append("  c(:s" + j + ", :o" + j + ", :b" + j + ");\n");
                    }
                    // PL/SQL の中なら VARCHAR2 は 32767 バイトまで（SQL の 4000 バイトの制限を受けない）。
                    cmd.CommandText = "DECLARE\n  PROCEDURE c(s NVARCHAR2, ok OUT PLS_INTEGER, b OUT PLS_INTEGER) IS v VARCHAR2(32767);\n"
                        + "  BEGIN v := TO_CHAR(s); ok := CASE WHEN TO_NCHAR(v) = s THEN 1 ELSE 0 END; b := NVL(LENGTHB(v), 0); END;\nBEGIN\n"
                        + calls + "END;";
                    Execute(cmd);
                    for (var j = 0; j < count; j++)
                    {
                        output[targets[start + j]] = new StringCheck
                        {
                            Encodable = OutInt(outs[j][0]) == 1,
                            Bytes = OutInt(outs[j][1]),
                        };
                    }
                }
            }
            return output;
        }

        /// <summary>出力パラメータの数（ODP.NET は OracleDecimal で返すことがあるので、文字列を通して読む）。</summary>
        static int OutInt(DbParameter p)
        {
            return int.Parse(Convert.ToString(p.Value, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
        }

        string RenderUpdate(TableMeta meta, ScriptUpdate u)
        {
            var t = Table(meta);
            var assigns = new List<string>();
            foreach (var c in meta.ColumnsOf(u.Set.Keys)) assigns.Add(QuoteName(c.Name) + " = " + Literal(c, u.Set[c.Name], t));
            var conds = new List<string>();
            foreach (var c in meta.ColumnsOf(u.Key.Keys)) conds.Add(KeyCondition(c, Literal(c, u.Key[c.Name], t)));
            foreach (var c in meta.ColumnsOf(u.Expect.Keys)) conds.Add(SameCondition(c, u.Expect[c.Name] == null ? null : Literal(c, u.Expect[c.Name], t), t.Collate));
            var one = "UPDATE " + QuoteTable(meta) + " SET " + string.Join(", ", assigns) + " WHERE " + string.Join(" AND ", conds);
            // SQL*Plus の 1 行の上限より十分短く。長い文や、分けてつないだ値を含む文は、列と条件ごとに行を分ける。
            if (one.Length <= 1000 && one.IndexOf('\n') < 0) return one;
            return "UPDATE " + QuoteTable(meta) + "\n     SET " + string.Join(",\n         ", assigns) + "\n   WHERE " + string.Join("\n     AND ", conds);
        }

        /// <summary>
        /// PL/SQL のブロックにして、人が流しても 1 トランザクションになるようにする（SQL*Plus は文ごとにエラーを飛ばして進むため）。
        /// 反映は 1 行でも当たらなければ全部取り消して止まる。戻しは当たらなかった行を飛ばし、DBMS_OUTPUT に出す。
        /// </summary>
        public string RenderScript(TableMeta meta, string head, IList<ScriptUpdate> updates, string kind)
        {
            var lines = new List<string> { head };
            if (kind == "apply") lines.Add("-- 1 つのトランザクションで流す。どれかの行が見つからないか値が変わっていたら、何も反映せずに止まる（ORA-20001）。");
            else lines.Add("-- 今の値が patchiri で入れた値のままの行だけ戻す。その後に別の更新が入った行は戻さず、DBMS_OUTPUT に出す。");
            lines.Add("-- SQL*Plus、SQLcl、SQL Developer で流せる形（値の & を置き換えないよう SET DEFINE OFF にしてある）。");
            lines.Add("-- キーを大文字小文字を区別して比べるよう、このセッションの NLS_COMP / NLS_SORT を BINARY にする（流した後もこのセッションに残る）。");
            lines.Add("SET DEFINE OFF");
            lines.Add(SessionSqlCompare + ";");
            if (kind == "undo")
            {
                lines.Add("SET SERVEROUTPUT ON");
                lines.Add("DECLARE");
                lines.Add("  n PLS_INTEGER := 0;");
            }
            lines.Add("BEGIN");
            foreach (var u in updates)
            {
                lines.Add("  " + RenderUpdate(meta, u) + ";");
                if (kind == "apply")
                {
                    var msg = QuoteString("patchiri: 行が見つからないか、値が変わっています（" + PatchiriScript.KeyText(u.Key) + "）。何も反映していません");
                    lines.Add("  IF SQL%ROWCOUNT <> 1 THEN RAISE_APPLICATION_ERROR(-20001, " + msg + "); END IF;");
                }
                else
                {
                    var msg = QuoteString("patchiri: 戻していない行（後から別の更新が入った）: " + PatchiriScript.KeyText(u.Key));
                    lines.Add("  IF SQL%ROWCOUNT = 1 THEN n := n + 1; ELSE DBMS_OUTPUT.PUT_LINE(" + msg + "); END IF;");
                }
            }
            lines.Add("  COMMIT;");
            if (kind == "undo") lines.Add("  DBMS_OUTPUT.PUT_LINE('patchiri: ' || n || ' / " + updates.Count + " 行を戻しました');");
            lines.Add("EXCEPTION");
            lines.Add("  WHEN OTHERS THEN");
            lines.Add("    ROLLBACK;");
            lines.Add("    RAISE;");
            lines.Add("END;");
            lines.Add("/");
            return string.Join("\n", lines) + "\n";
        }
    }
}
