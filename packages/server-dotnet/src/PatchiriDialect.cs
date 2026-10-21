// DB ごとの違いを閉じ込める入口。PatchiriService はこの形だけを使う。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using Row = System.Collections.Generic.Dictionary<string, object>;

namespace Patchiri.Server
{
    /// <summary>DB から読んだ列の定義。updatable は許可リストと合わせて PatchiriService が決める。</summary>
    public sealed class ColumnMeta
    {
        public string Name;
        /// <summary>正規化した型（仕様 1.3）: string, integer, bigint, decimal, float, boolean, date, datetime, time, other。</summary>
        public string Type;
        public string DbType;
        public bool Nullable;
        /// <summary>文字数。max は -1。</summary>
        public int? MaxLength;
        /// <summary>列の文字コードでの上限バイト数。max の列では null。</summary>
        public int? MaxBytes;
        /// <summary>列の文字コードの WHATWG 名（"shift_jis"、"utf-16le" など）。わからなければ null。</summary>
        public string Encoding;
        /// <summary>空文字 "" を NULL として保存する文字列の列（Oracle の文字列の列は全部）。</summary>
        public bool EmptyIsNull;
        public int? Precision;
        public int? Scale;
        public bool Identity;
        public bool Computed;
        public bool HasDefault;

        /// <summary>
        /// 値をバイト列に直して上限と表せない字を確かめるための文字コード。
        /// null なら UTF-16（nchar / nvarchar）か、確かめられない文字コード。
        /// </summary>
        public System.Text.Encoding ByteEncoding;
        /// <summary>方言の内部用。char / varchar の列の照合順序（DB で文字コードを確かめるのに使う）。</summary>
        public string Collation;
        /// <summary>方言の内部用。SQL Server なら TYPE_NAME の結果（"varchar" など）、Oracle なら精度を外した DATA_TYPE（"VARCHAR2" など）。</summary>
        public string BaseType;
        /// <summary>方言の内部用。CAST に使う型（SQL Server の "decimal(9,2)" など、Oracle の CHAR / NCHAR の "CHAR(6 BYTE)" など）。</summary>
        public string SqlType;
    }

    public sealed class ForeignKeyMeta
    {
        public string Name;
        public List<string> Columns = new List<string>();
        /// <summary>スキーマ付きの名前（"dbo.M_Category"）。</summary>
        public string ReferencedTable;
        public List<string> ReferencedColumns = new List<string>();
    }

    public sealed class TableMeta
    {
        /// <summary>スキーマ付きの名前（"dbo.M_Product"）。</summary>
        public string Table;
        /// <summary>DB の列順。</summary>
        public List<ColumnMeta> Columns = new List<ColumnMeta>();
        public List<string> PrimaryKey = new List<string>();
        public List<ForeignKeyMeta> ForeignKeys = new List<ForeignKeyMeta>();
        /// <summary>方言の内部用（Oracle なら OWNER と NAME を分けたもの、DB の版と文字コード）。</summary>
        public object DialectInfo;

        public ColumnMeta Column(string name)
        {
            foreach (var c in Columns) if (c.Name == name) return c;
            throw new InvalidOperationException("列 " + name + " が " + Table + " にありません");
        }

        public List<ColumnMeta> ColumnsOf(IEnumerable<string> names)
        {
            var list = new List<ColumnMeta>();
            foreach (var n in names) list.Add(Column(n));
            return list;
        }
    }

    public sealed class LockedRow
    {
        public bool Found;
        /// <summary>before に書かれた列の今の値。</summary>
        public Row Current;
        /// <summary>before と今の値が違う列。</summary>
        public List<string> Changed;
        /// <summary>DB にあるキーの値（照合順序で同じ行を指す 2 行を見分けるため）。</summary>
        public Row DbKey;
    }

    /// <summary>文字列を列の文字コードで書いた結果（DB 自身に確かめたもの）。</summary>
    public sealed class StringCheck
    {
        /// <summary>列の文字コードで表せるか（表せない字は DB が「?」に置き換える）。</summary>
        public bool Encodable;
        public int Bytes;
    }

    public interface IPatchiriTransaction
    {
        /// <summary>更新ロックを掛けて 1 行読み、before と DB の比較規則で比べる。</summary>
        LockedRow LockAndCompare(TableMeta meta, IList<string> keyColumns, Row key, Row before);
        /// <summary>パラメータ付き UPDATE を 1 行流し、UPDATE そのものの影響行数を返す（トリガーの行数は含めない）。</summary>
        int Update(TableMeta meta, IList<string> keyColumns, Row key, Row set);
    }

    /// <summary>DB がエラーを返したとき。Message は生のエラー文。</summary>
    public class PatchiriDbException : Exception
    {
        /// <summary>
        /// 人が次に何をすればよいか分かるエラー（ロック待ちの時間切れなど）に、DB の生の文の代わりに返す固定の文（仕様 1.5）。
        /// </summary>
        public string PublicMessage;

        public PatchiriDbException(string message) : base(message) { }
        public PatchiriDbException(string message, Exception inner) : base(message, inner) { }
    }

    /// <summary>人が読む SQL の UPDATE 1 本分。Key で行を探し（照合順序）、Expect は「この値のときだけ」の条件（厳密に比べる）。</summary>
    public sealed class ScriptUpdate
    {
        public Row Set;
        public Row Key;
        public Row Expect;
    }

    /// <summary>人が読む SQL を作るときの小道具（方言に依らないもの）。</summary>
    public static class PatchiriScript
    {
        static readonly Regex NewlinesRe = new Regex(@"[\r\n]+");

        /// <summary>
        /// 止めたときの文に入れるキーの値（Node 版と同じ「列=値, …」）。改行は空白にし（SQL*Plus は行ごとに読むため）、
        /// 長ければ 200 文字で切る。引用はしないので、呼ぶ側で直す。
        /// </summary>
        public static string KeyText(Row key)
        {
            var parts = new List<string>();
            foreach (var kv in key)
            {
                var v = kv.Value;
                string text;
                if (v == null) text = "null";
                else if (v is string) text = (string)v;
                else if (v is bool) text = (bool)v ? "true" : "false";
                else if (PatchiriJson.IsNumber(v)) text = PatchiriJson.FormatDouble(PatchiriJson.ToDouble(v));
                else text = Convert.ToString(v, CultureInfo.InvariantCulture);
                parts.Add(kv.Key + "=" + NewlinesRe.Replace(text, " "));
            }
            var s = string.Join(", ", parts);
            if (s.Length <= 200) return s;
            var cut = char.IsHighSurrogate(s[199]) ? 199 : 200;
            return s.Substring(0, cut) + "…";
        }
    }

    public interface IPatchiriDialect
    {
        string Name { get; }
        /// <summary>テーブル名をこの DB の正規の形（比較用）にする。</summary>
        string NormalizeTable(string table);
        TableMeta DescribeTable(string table);
        /// <summary>keys と同じ順で、見つかった行（キー列と columns）か null を返す。</summary>
        List<Row> FetchRows(TableMeta meta, IList<string> keyColumns, IList<string> columns, IList<Row> keys);
        /// <summary>fn の後、fn が true を返せばコミット、false ならロールバックする。例外でもロールバック。</summary>
        void RunTransaction(Func<IPatchiriTransaction, bool> fn);
        /// <summary>
        /// 文字列の値（列名と値の組）が列の文字コードで表せるか、何バイトになるかを DB 自身に確かめる。
        /// PatchiriValues の確認（.NET の文字コード）は DB のコードページと完全には一致しないので、これが最後の確認。
        /// 確かめない列（nvarchar など）の値には null を返す。
        /// </summary>
        List<StringCheck> CheckStrings(TableMeta meta, IList<KeyValuePair<string, string>> items);
        /// <summary>
        /// 人が流せる SQL（値を埋め込んだもの）を作る。head は先頭のコメント行。人が流しても 1 トランザクションになる形に包む。
        /// kind が "apply" なら反映する SQL（どれかの行が 1 行でなければ全部戻して止まる）、
        /// "undo" なら戻し SQL（今の値が Expect のままの行だけ戻し、ほかは飛ばして続ける）。
        /// </summary>
        string RenderScript(TableMeta meta, string head, IList<ScriptUpdate> updates, string kind);
    }
}
