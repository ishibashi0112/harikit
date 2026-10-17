// SQL Server の方言。SQL はここでだけ組み、値はすべて SqlParameter で渡す。
// テーブル名と列名は許可リストと DB の定義から取り、[] で囲む。Node 版の mssql.ts と同じ SQL を流す。

using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Row = System.Collections.Generic.Dictionary<string, object>;

namespace Harikit.Server
{
    public sealed class SqlServerDialect : IHarikitDialect
    {
        static readonly Dictionary<string, string> TypeMap = new Dictionary<string, string>
        {
            { "char", "string" }, { "varchar", "string" }, { "nchar", "string" }, { "nvarchar", "string" },
            { "tinyint", "integer" }, { "smallint", "integer" }, { "int", "integer" },
            { "bigint", "bigint" },
            { "decimal", "decimal" }, { "numeric", "decimal" }, { "money", "decimal" }, { "smallmoney", "decimal" },
            { "real", "float" }, { "float", "float" },
            { "bit", "boolean" },
            { "date", "date" },
            { "datetime", "datetime" }, { "datetime2", "datetime" }, { "smalldatetime", "datetime" },
            { "time", "time" },
        };

        /// <summary>照合順序のコードページ → WHATWG の文字コード名（仕様 3「文字列の列の長さと文字コード」）。</summary>
        static readonly Dictionary<int, string> CodePages = new Dictionary<int, string>
        {
            { 874, "windows-874" }, { 932, "shift_jis" }, { 936, "gbk" }, { 949, "euc-kr" }, { 950, "big5" },
            { 1250, "windows-1250" }, { 1251, "windows-1251" }, { 1252, "windows-1252" }, { 1253, "windows-1253" },
            { 1254, "windows-1254" }, { 1255, "windows-1255" }, { 1256, "windows-1256" }, { 1257, "windows-1257" },
            { 1258, "windows-1258" }, { 65001, "utf-8" },
        };

        static readonly Regex NumberLiteralRe = new Regex(@"\A-?[0-9]+(\.[0-9]+)?\z");
        static readonly Regex DateLiteralRe = new Regex(@"\A[0-9:T.-]+\z");
        static readonly Regex CollationRe = new Regex(@"\A[A-Za-z0-9_]+\z");
        static readonly Regex TablePartRe = new Regex(@"\G\s*(?:\[((?:[^\]]|\]\])*)\]|([^.\[\]]+))\s*(?:\.|\z)");

        const string LockedMessage = "対象の行がほかのセッションにロックされています。コミットしていない更新が残っていないか確かめてから、もう一度試してください";

        readonly string connectionString;
        readonly int lockWaitSeconds;

        /// <param name="lockWaitSeconds">反映で行のロックを待つ秒数（SET LOCK_TIMEOUT）。過ぎたら db_error で何も変えない。</param>
        public SqlServerDialect(string connectionString, int lockWaitSeconds = 10)
        {
            this.connectionString = connectionString;
            this.lockWaitSeconds = lockWaitSeconds;
        }

        /// <summary>SqlException を HarikitDbException にする。ロック待ちの時間切れ（1222）には、人向けの固定の文を付ける。</summary>
        static HarikitDbException DbError(SqlException e)
        {
            var error = new HarikitDbException(e.Message, e);
            if (e.Number == 1222) error.PublicMessage = LockedMessage;
            return error;
        }

        public string Name
        {
            get { return "sqlserver"; }
        }

        /// <summary>名前を [] で囲む。] は ]] にする。</summary>
        public static string QuoteName(string name)
        {
            return "[" + name.Replace("]", "]]") + "]";
        }

        /// <summary>"dbo.M_Product" や "[dbo].[M_Product]" を [スキーマ, 名前] に分ける。スキーマを省くと dbo。</summary>
        public static string[] SplitTableName(string table)
        {
            var parts = new List<string>();
            var pos = 0;
            while (pos < table.Length)
            {
                var m = TablePartRe.Match(table, pos);
                if (!m.Success || m.Length == 0) break;
                parts.Add(m.Groups[1].Success ? m.Groups[1].Value.Replace("]]", "]") : m.Groups[2].Value.Trim());
                pos = m.Index + m.Length;
            }
            if (pos < table.Length || parts.Count == 0 || parts.Count > 2) throw new InvalidOperationException("テーブル名 " + table + " が読めません");
            return parts.Count == 1 ? new[] { "dbo", parts[0] } : new[] { parts[0], parts[1] };
        }

        public static string QuoteTable(string table)
        {
            var p = SplitTableName(table);
            return QuoteName(p[0]) + "." + QuoteName(p[1]);
        }

        public string NormalizeTable(string table)
        {
            var p = SplitTableName(table);
            return (p[0] + "." + p[1]).ToLowerInvariant();
        }

        static string DbTypeText(string baseType, int bytes, int precision, int scale)
        {
            switch (baseType)
            {
                case "char":
                case "varchar":
                case "binary":
                case "varbinary":
                    return baseType + "(" + (bytes == -1 ? "max" : bytes.ToString(CultureInfo.InvariantCulture)) + ")";
                case "nchar":
                case "nvarchar":
                    return baseType + "(" + (bytes == -1 ? "max" : (bytes / 2).ToString(CultureInfo.InvariantCulture)) + ")";
                case "decimal":
                case "numeric":
                    return baseType + "(" + precision + "," + scale + ")";
                case "datetime2":
                case "time":
                case "datetimeoffset":
                    return baseType + "(" + scale + ")";
                default:
                    return baseType;
            }
        }

        /// <summary>SELECT で値を仕様 1.3 の形で受け取るための式。</summary>
        static string SelectExpr(ColumnMeta col, string prefix)
        {
            var q = prefix + QuoteName(col.Name);
            switch (col.BaseType)
            {
                case "decimal":
                case "numeric":
                    return "CONVERT(varchar(50), " + q + ")";
                case "money":
                case "smallmoney":
                    return "CONVERT(varchar(50), " + q + ", 2)";
                case "bigint":
                    return "CONVERT(varchar(20), " + q + ")";
                case "date":
                    return "CONVERT(char(10), " + q + ", 23)";
                case "datetime":
                case "datetime2":
                case "smalldatetime":
                    return "CONVERT(varchar(27), " + q + ", 126)";
                case "time":
                    return "CONVERT(varchar(16), " + q + ")";
                case "binary":
                case "varbinary":
                    return "CONVERT(varchar(max), " + q + ", 1)";
                default:
                    return col.Type == "other" ? "CONVERT(nvarchar(max), " + q + ")" : q;
            }
        }

        static object ReadValue(ColumnMeta col, object v)
        {
            if (v == null || v is DBNull) return null;
            if (col.Type == "datetime" || col.Type == "time") return HarikitValues.CanonicalFraction(Convert.ToString(v, CultureInfo.InvariantCulture));
            if (v is string || v is bool) return v;
            if (v is byte || v is short || v is int) return Convert.ToInt32(v, CultureInfo.InvariantCulture);
            // real は float のまま double にする（0.1 を 0.1 にすると、送り返された before が DB の値と合わなくなる）。
            if (v is float) return HarikitJson.JsonNumber((double)(float)v);
            if (v is double) return HarikitJson.JsonNumber((double)v);
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// 値を渡す式を作り、パラメータを足す。文字列は列が varchar でも nvarchar で渡す
        /// （varchar で渡すと DB の既定の照合順序のコードページで送られ、列の照合順序が違うと
        /// 日本語が「?」になる）。数値と日時以外は文字列で渡して DB の型へ CAST する（精度を崩さない）。
        /// </summary>
        static string BindValue(SqlCommand cmd, string name, ColumnMeta col, object v)
        {
            var p = cmd.Parameters.Add("@" + name, SqlDbType.VarChar);
            switch (col.BaseType)
            {
                case "char":
                case "varchar":
                case "nchar":
                case "nvarchar":
                    p.SqlDbType = SqlDbType.NVarChar;
                    // SqlClient は Size より長い値を黙って切るので、列より長い値は長いまま渡して DB に弾かせる。
                    p.Size = !col.MaxLength.HasValue || col.MaxLength.Value == -1 ? -1 : Math.Max(col.MaxLength.Value, v is string ? ((string)v).Length : 0);
                    if (p.Size > 4000) p.Size = -1;
                    p.Value = v ?? (object)DBNull.Value;
                    return "@" + name;
                case "tinyint":
                    p.SqlDbType = SqlDbType.TinyInt;
                    p.Value = v == null ? (object)DBNull.Value : (byte)HarikitJson.ToDouble(v);
                    return "@" + name;
                case "smallint":
                    p.SqlDbType = SqlDbType.SmallInt;
                    p.Value = v == null ? (object)DBNull.Value : (short)HarikitJson.ToDouble(v);
                    return "@" + name;
                case "int":
                    p.SqlDbType = SqlDbType.Int;
                    p.Value = v == null ? (object)DBNull.Value : (int)HarikitJson.ToDouble(v);
                    return "@" + name;
                case "real":
                case "float":
                    p.SqlDbType = SqlDbType.Float;
                    p.Value = v == null ? (object)DBNull.Value : HarikitJson.ToDouble(v);
                    return "@" + name;
                case "bit":
                    p.SqlDbType = SqlDbType.Bit;
                    p.Value = v ?? (object)DBNull.Value;
                    return "@" + name;
                default:
                    {
                        // 64 文字より長い値（先頭に 0 が並ぶ数など）も切らずに渡す。
                        var s = v == null ? null : Convert.ToString(v, CultureInfo.InvariantCulture);
                        p.Size = s != null && s.Length > 64 ? -1 : 64;
                        p.Value = s ?? (object)DBNull.Value;
                        return "CAST(@" + name + " AS " + col.SqlType + ")";
                    }
            }
        }

        /// <summary>人が読む SQL 用の値の書き方。値は CheckValue で形を確かめた後のものだけが来る。</summary>
        public static string Literal(ColumnMeta col, object v)
        {
            if (v == null) return "NULL";
            switch (col.Type)
            {
                case "string":
                    // varchar の列にも N'' で書く（列の照合順序で変換され、DB の既定と違っても崩れない）。
                    return "N'" + ((string)v).Replace("'", "''") + "'";
                case "boolean":
                    return (bool)v ? "1" : "0";
                case "integer":
                case "float":
                    return HarikitJson.FormatDouble(HarikitJson.ToDouble(v));
                case "bigint":
                case "decimal":
                    {
                        var s = v as string;
                        if (s == null || !NumberLiteralRe.IsMatch(s)) throw new InvalidOperationException("数値ではない値: " + v);
                        return s;
                    }
                case "date":
                case "datetime":
                case "time":
                    {
                        var s = v as string;
                        if (s == null || !DateLiteralRe.IsMatch(s)) throw new InvalidOperationException("日付ではない値: " + v);
                        return "'" + s + "'";
                    }
                default:
                    throw new InvalidOperationException("列 " + col.Name + " の型は SQL に書けません");
            }
        }

        /// <summary>どの行か（キー）の条件。DB の照合順序で比べる。</summary>
        static string Condition(ColumnMeta col, string expr)
        {
            return expr == null ? QuoteName(col.Name) + " IS NULL" : QuoteName(col.Name) + " = " + expr;
        }

        /// <summary>
        /// 値が変わっていないかの条件（仕様 1.6）。文字列は照合順序を使わず 1 文字ずつ比べる
        /// （Japanese_CI_AS は 'ボールペン' と 'ﾎﾞｰﾙﾍﾟﾝ' を同じとみなす）。varchar に直接 BIN2 を当てると
        /// コードページが変わって '?' に崩れるので、先に nvarchar に直す。= は BIN2 でも末尾の空白を無視するので、
        /// 固定長でない列は DATALENGTH も比べる。char / nchar の末尾の空白は詰め物なので見ない。
        /// </summary>
        static string StrictCondition(ColumnMeta col, string expr)
        {
            if (expr == null || col.Type != "string") return Condition(col, expr);
            var nv = "CAST(" + QuoteName(col.Name) + " AS nvarchar(max))";
            var cond = nv + " COLLATE Latin1_General_BIN2 = " + expr;
            if (col.BaseType == "char" || col.BaseType == "nchar") return cond;
            // 戻し SQL の文面を Node 版とそろえるため、括弧で包む。
            return "(" + cond + " AND DATALENGTH(" + nv + ") = DATALENGTH(" + expr + "))";
        }

        SqlConnection Open()
        {
            var conn = new SqlConnection(connectionString);
            try
            {
                conn.Open();
            }
            catch (SqlException e)
            {
                conn.Dispose();
                throw DbError(e);
            }
            return conn;
        }

        static List<object[]> Query(SqlCommand cmd)
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
            catch (SqlException e)
            {
                throw DbError(e);
            }
            return rows;
        }

        public TableMeta DescribeTable(string table)
        {
            var parts = SplitTableName(table);
            var qualified = QuoteTable(table);
            using (var conn = Open())
            {
                var cmd = new SqlCommand(@"SELECT c.name, TYPE_NAME(c.system_type_id) AS base_type, c.max_length, c.precision, c.scale,
                    c.is_nullable, c.is_identity, c.is_computed, c.default_object_id,
                    CONVERT(int, COLLATIONPROPERTY(c.collation_name, 'CodePage')) AS code_page, c.collation_name
                    FROM sys.columns c WHERE c.object_id = OBJECT_ID(@name) ORDER BY c.column_id", conn);
                cmd.Parameters.Add("@name", SqlDbType.NVarChar, 512).Value = qualified;
                var colRows = Query(cmd);
                if (colRows.Count == 0) throw new HarikitDbException("テーブル " + table + " が見つかりません");
                var meta = new TableMeta { Table = parts[0] + "." + parts[1] };
                foreach (var r in colRows)
                {
                    var baseType = Convert.ToString(r[1], CultureInfo.InvariantCulture);
                    var bytes = Convert.ToInt32(r[2], CultureInfo.InvariantCulture);
                    var precision = Convert.ToInt32(r[3], CultureInfo.InvariantCulture);
                    var scale = Convert.ToInt32(r[4], CultureInfo.InvariantCulture);
                    string type;
                    if (!TypeMap.TryGetValue(baseType, out type)) type = "other";
                    var dbType = DbTypeText(baseType, bytes, precision, scale);
                    var col = new ColumnMeta
                    {
                        Name = Convert.ToString(r[0], CultureInfo.InvariantCulture),
                        Type = type,
                        DbType = dbType,
                        Nullable = Convert.ToBoolean(r[5], CultureInfo.InvariantCulture),
                        BaseType = baseType,
                        SqlType = dbType,
                    };
                    if (type == "string")
                    {
                        var national = baseType == "nchar" || baseType == "nvarchar";
                        col.MaxLength = bytes == -1 ? -1 : national ? bytes / 2 : bytes;
                        // 桁はバイトで決まる。nchar / nvarchar は UTF-16、char / varchar は照合順序のコードページ。
                        if (bytes != -1) col.MaxBytes = bytes;
                        if (national) col.Encoding = "utf-16le";
                        else if (!(r[9] is DBNull))
                        {
                            var codePage = Convert.ToInt32(r[9], CultureInfo.InvariantCulture);
                            string name;
                            if (CodePages.TryGetValue(codePage, out name)) col.Encoding = name;
                            col.ByteEncoding = ByteEncoding(codePage);
                        }
                        if (!national && r[10] is string) col.Collation = (string)r[10];
                    }
                    if (type == "decimal")
                    {
                        col.Precision = precision;
                        col.Scale = scale;
                    }
                    if (type == "datetime" || type == "time") col.Scale = baseType == "datetime" ? 3 : scale;
                    if (Convert.ToBoolean(r[6], CultureInfo.InvariantCulture)) col.Identity = true;
                    if (Convert.ToBoolean(r[7], CultureInfo.InvariantCulture)) col.Computed = true;
                    if (Convert.ToInt32(r[8], CultureInfo.InvariantCulture) != 0) col.HasDefault = true;
                    meta.Columns.Add(col);
                }

                cmd = new SqlCommand(@"SELECT c.name FROM sys.indexes i
                    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                    WHERE i.object_id = OBJECT_ID(@name) AND i.is_primary_key = 1 ORDER BY ic.key_ordinal", conn);
                cmd.Parameters.Add("@name", SqlDbType.NVarChar, 512).Value = qualified;
                foreach (var r in Query(cmd)) meta.PrimaryKey.Add(Convert.ToString(r[0], CultureInfo.InvariantCulture));

                cmd = new SqlCommand(@"SELECT fk.name, pc.name AS col, OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS ref_schema,
                    OBJECT_NAME(fk.referenced_object_id) AS ref_table, rc.name AS ref_col
                    FROM sys.foreign_keys fk
                    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
                    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
                    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
                    WHERE fk.parent_object_id = OBJECT_ID(@name) ORDER BY fk.name, fkc.constraint_column_id", conn);
                cmd.Parameters.Add("@name", SqlDbType.NVarChar, 512).Value = qualified;
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

        /// <summary>コードページの文字コード。表せない字は例外にする（近い字への置き換えをしない）。使えなければ null。</summary>
        static Encoding ByteEncoding(int codePage)
        {
            if (codePage == 65001) return new UTF8Encoding(false, true);
            try
            {
                return Encoding.GetEncoding(codePage, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback);
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

        public List<Row> FetchRows(TableMeta meta, IList<string> keyColumns, IList<string> columns, IList<Row> keys)
        {
            var keyCols = meta.ColumnsOf(keyColumns);
            var outCols = meta.ColumnsOf(columns);
            var output = new List<Row>();
            for (var i = 0; i < keys.Count; i++) output.Add(null);
            // 1 回のパラメータは 2100 個まで、VALUES は 1000 行まで。
            var chunk = Math.Min(1000, 2000 / keyCols.Count);
            using (var conn = Open())
            {
                for (var start = 0; start < keys.Count; start += chunk)
                {
                    var count = Math.Min(chunk, keys.Count - start);
                    var cmd = new SqlCommand { Connection = conn };
                    var values = new List<string>();
                    for (var i = 0; i < count; i++)
                    {
                        var k = keys[start + i];
                        var exprs = new List<string> { i.ToString(CultureInfo.InvariantCulture) };
                        for (var j = 0; j < keyCols.Count; j++) exprs.Add(BindValue(cmd, "k" + i + "_" + j, keyCols[j], k[keyCols[j].Name]));
                        values.Add("(" + string.Join(", ", exprs) + ")");
                    }
                    var alias = new List<string>();
                    var on = new List<string>();
                    for (var j = 0; j < keyCols.Count; j++)
                    {
                        alias.Add(QuoteName("k" + j));
                        on.Add("t." + QuoteName(keyCols[j].Name) + " = v." + alias[j]);
                    }
                    var select = new List<string>();
                    for (var j = 0; j < outCols.Count; j++) select.Add(SelectExpr(outCols[j], "t.") + " AS " + QuoteName("__v" + j));
                    cmd.CommandText = "SELECT v.[__i], " + string.Join(", ", select) + " FROM (VALUES " + string.Join(", ", values) + ") AS v([__i], "
                        + string.Join(", ", alias) + ") JOIN " + QuoteTable(meta.Table) + " t ON " + string.Join(" AND ", on);
                    foreach (var r in Query(cmd))
                    {
                        var i = start + Convert.ToInt32(r[0], CultureInfo.InvariantCulture);
                        if (output[i] != null) throw new HarikitDbException("キー " + HarikitJson.Stringify(keys[i]) + " に当たる行が複数あります（キーが一意ではありません）");
                        var row = new Row();
                        for (var j = 0; j < outCols.Count; j++) row[outCols[j].Name] = ReadValue(outCols[j], r[j + 1]);
                        output[i] = row;
                    }
                }
            }
            return output;
        }

        sealed class MsTransaction : IHarikitTransaction
        {
            readonly SqlConnection conn;
            readonly SqlTransaction tx;

            public MsTransaction(SqlConnection conn, SqlTransaction tx)
            {
                this.conn = conn;
                this.tx = tx;
            }

            public LockedRow LockAndCompare(TableMeta meta, IList<string> keyColumns, Row key, Row before)
            {
                var keyCols = meta.ColumnsOf(keyColumns);
                var beforeCols = meta.ColumnsOf(before.Keys);
                var cmd = new SqlCommand { Connection = conn, Transaction = tx };
                var where = new List<string>();
                for (var i = 0; i < keyCols.Count; i++) where.Add(Condition(keyCols[i], BindValue(cmd, "k" + i, keyCols[i], key[keyCols[i].Name])));
                var select = new List<string>();
                var all = new List<ColumnMeta>(keyCols);
                all.AddRange(beforeCols);
                for (var i = 0; i < all.Count; i++) select.Add(SelectExpr(all[i], "") + " AS " + QuoteName("__v" + i));
                for (var i = 0; i < beforeCols.Count; i++)
                {
                    var v = before[beforeCols[i].Name];
                    var cond = StrictCondition(beforeCols[i], v == null ? null : BindValue(cmd, "b" + i, beforeCols[i], v));
                    select.Add("CASE WHEN " + cond + " THEN 1 ELSE 0 END AS " + QuoteName("__m" + i));
                }
                cmd.CommandText = "SELECT " + string.Join(", ", select) + " FROM " + QuoteTable(meta.Table) + " WITH (UPDLOCK, HOLDLOCK) WHERE " + string.Join(" AND ", where);
                var rows = Query(cmd);
                if (rows.Count == 0) return new LockedRow { Found = false };
                if (rows.Count > 1) throw new HarikitDbException("キー " + HarikitJson.Stringify(key) + " に当たる行が " + rows.Count + " 行あります（キーが一意ではありません）");
                var row = rows[0];
                var locked = new LockedRow { Found = true, Current = new Row(), Changed = new List<string>(), DbKey = new Row() };
                for (var i = 0; i < keyCols.Count; i++) locked.DbKey[keyCols[i].Name] = HarikitValues.Canonical(keyCols[i].Type, ReadValue(keyCols[i], row[i]));
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
                var cmd = new SqlCommand { Connection = conn, Transaction = tx };
                var assigns = new List<string>();
                for (var i = 0; i < setCols.Count; i++) assigns.Add(QuoteName(setCols[i].Name) + " = " + BindValue(cmd, "p" + i, setCols[i], set[setCols[i].Name]));
                var where = new List<string>();
                for (var i = 0; i < keyCols.Count; i++) where.Add(Condition(keyCols[i], BindValue(cmd, "k" + i, keyCols[i], key[keyCols[i].Name])));
                // ExecuteNonQuery の戻り値はトリガーの中の行数も足すので、UPDATE そのものの行数を @@ROWCOUNT で読む。
                cmd.CommandText = "UPDATE " + QuoteTable(meta.Table) + " SET " + string.Join(", ", assigns) + " WHERE " + string.Join(" AND ", where) + "; SELECT @@ROWCOUNT;";
                return Convert.ToInt32(LastScalar(cmd), CultureInfo.InvariantCulture);
            }

            /// <summary>最後の結果セットの最初の値（トリガーが結果セットを返しても、最後は SELECT @@ROWCOUNT）。</summary>
            static object LastScalar(SqlCommand cmd)
            {
                object last = 0;
                try
                {
                    using (var reader = cmd.ExecuteReader())
                    {
                        do
                        {
                            if (reader.FieldCount > 0 && reader.Read()) last = reader.GetValue(0);
                        } while (reader.NextResult());
                    }
                }
                catch (SqlException e)
                {
                    throw DbError(e);
                }
                return last;
            }
        }

        public void RunTransaction(Func<IHarikitTransaction, bool> fn)
        {
            using (var conn = Open())
            {
                SqlTransaction tx;
                try
                {
                    tx = conn.BeginTransaction(IsolationLevel.ReadCommitted);
                    // ほかのセッションが行をロックしたままでも、待ち続けずに止める（仕様 7 の手順 3、lockWaitSeconds）。
                    Execute(conn, tx, "SET LOCK_TIMEOUT " + (lockWaitSeconds * 1000L).ToString(CultureInfo.InvariantCulture) + ";");
                }
                catch (SqlException e)
                {
                    throw DbError(e);
                }
                try
                {
                    var commit = fn(new MsTransaction(conn, tx));
                    try
                    {
                        if (commit) tx.Commit();
                        else tx.Rollback();
                    }
                    catch (SqlException e)
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
                        // すでにロールバックされている（XACT_ABORT やコミットの失敗など）。
                    }
                    throw;
                }
                finally
                {
                    // 接続はプールに戻って載せ先アプリの処理にも使われうるので、既定（待ち続ける）に戻しておく。
                    try
                    {
                        Execute(conn, null, "SET LOCK_TIMEOUT -1;");
                    }
                    catch
                    {
                        // 接続が切れているなら、プールにも戻らない。
                    }
                }
            }
        }

        static void Execute(SqlConnection conn, SqlTransaction tx, string text)
        {
            using (var cmd = new SqlCommand(text, conn, tx)) cmd.ExecuteNonQuery();
        }

        public List<StringCheck> CheckStrings(TableMeta meta, IList<KeyValuePair<string, string>> items)
        {
            var output = new List<StringCheck>();
            var byColumn = new Dictionary<string, List<int>>();
            for (var i = 0; i < items.Count; i++)
            {
                output.Add(null);
                var col = meta.Column(items[i].Key);
                // 照合順序の名前は DB の定義から来るが、SQL に書くので形を確かめる。
                if (col.Collation == null || !CollationRe.IsMatch(col.Collation)) continue;
                List<int> list;
                if (!byColumn.TryGetValue(col.Name, out list)) byColumn[col.Name] = list = new List<int>();
                list.Add(i);
            }
            if (byColumn.Count == 0) return output;
            using (var conn = Open())
            {
                foreach (var kv in byColumn)
                {
                    var col = meta.Column(kv.Key);
                    for (var start = 0; start < kv.Value.Count; start += 1000)
                    {
                        var count = Math.Min(1000, kv.Value.Count - start);
                        var cmd = new SqlCommand { Connection = conn };
                        var values = new List<string>();
                        for (var j = 0; j < count; j++)
                        {
                            cmd.Parameters.Add("@s" + j, SqlDbType.NVarChar, -1).Value = items[kv.Value[start + j]].Value;
                            values.Add("(" + j + ", @s" + j + ")");
                        }
                        // 列の照合順序で varchar にして戻し、元と同じか（表せない字は「?」になる）とバイト数を見る。
                        var asVarchar = "CAST(v.[s] COLLATE " + col.Collation + " AS varchar(max))";
                        cmd.CommandText = "SELECT v.[j], CASE WHEN CAST(" + asVarchar + " AS nvarchar(max)) COLLATE Latin1_General_BIN2 = v.[s] COLLATE Latin1_General_BIN2 THEN 1 ELSE 0 END AS [ok], "
                            + "DATALENGTH(" + asVarchar + ") AS [bytes] FROM (VALUES " + string.Join(", ", values) + ") AS v([j], [s])";
                        foreach (var r in Query(cmd))
                        {
                            var i = kv.Value[start + Convert.ToInt32(r[0], CultureInfo.InvariantCulture)];
                            output[i] = new StringCheck
                            {
                                Encodable = Convert.ToInt32(r[1], CultureInfo.InvariantCulture) == 1,
                                Bytes = r[2] is DBNull ? 0 : Convert.ToInt32(r[2], CultureInfo.InvariantCulture),
                            };
                        }
                    }
                }
            }
            return output;
        }

        public string RenderScript(TableMeta meta, string head, IList<ScriptUpdate> updates, string kind)
        {
            var lines = new List<string> { head };
            if (kind == "apply") lines.Add("-- 1 つのトランザクションで流す。どれかの行が見つからないか値が変わっていたら、何も反映せずに止まる（エラー 50001）。");
            else lines.Add("-- 今の値が harikit で入れた値のままの行だけ戻す。0 行の UPDATE は、その後に別の更新が入った行。");
            lines.Add("SET XACT_ABORT ON;");
            lines.Add("BEGIN TRANSACTION;");
            foreach (var u in updates)
            {
                lines.Add(RenderUpdate(meta, u.Set, u.Key, u.Expect) + ";");
                // 後から人が流したときに、変わっていた行だけ黙って飛ばさない。XACT_ABORT ON なので THROW で全部戻る。
                // @@ROWCOUNT はトリガーがあっても UPDATE 文そのものの行数。
                if (kind == "apply")
                    lines.Add("IF @@ROWCOUNT <> 1 THROW 50001, " + NString("harikit: 行が見つからないか、値が変わっています（" + KeyText(u.Key) + "）。何も反映していません") + ", 1;");
            }
            lines.Add("COMMIT;");
            return string.Join("\n", lines) + "\n";
        }

        static string NString(string s)
        {
            return "N'" + s.Replace("'", "''") + "'";
        }

        /// <summary>止めたときの文に入れるキーの値（Node 版と同じ「列=値, …」、長ければ 200 文字で切る）。</summary>
        static string KeyText(Row key)
        {
            var parts = new List<string>();
            foreach (var kv in key)
            {
                var v = kv.Value;
                string text;
                if (v == null) text = "null";
                else if (v is string) text = (string)v;
                else if (v is bool) text = (bool)v ? "true" : "false";
                else if (HarikitJson.IsNumber(v)) text = HarikitJson.FormatDouble(HarikitJson.ToDouble(v));
                else text = Convert.ToString(v, CultureInfo.InvariantCulture);
                parts.Add(kv.Key + "=" + text);
            }
            var s = string.Join(", ", parts);
            if (s.Length <= 200) return s;
            var cut = char.IsHighSurrogate(s[199]) ? 199 : 200;
            return s.Substring(0, cut) + "…";
        }

        static string RenderUpdate(TableMeta meta, Row set, Row key, Row values)
        {
            var assigns = new List<string>();
            foreach (var c in meta.ColumnsOf(set.Keys)) assigns.Add(QuoteName(c.Name) + " = " + Literal(c, set[c.Name]));
            var conds = new List<string>();
            foreach (var c in meta.ColumnsOf(key.Keys)) conds.Add(Condition(c, key[c.Name] == null ? null : Literal(c, key[c.Name])));
            foreach (var c in meta.ColumnsOf(values.Keys)) conds.Add(StrictCondition(c, values[c.Name] == null ? null : Literal(c, values[c.Name])));
            return "UPDATE " + QuoteTable(meta.Table) + " SET " + string.Join(", ", assigns) + " WHERE " + string.Join(" AND ", conds);
        }
    }
}
