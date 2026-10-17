// DB ごとの違いを閉じ込める入口。HarikitService はこの形だけを使う。

using System;
using System.Collections.Generic;
using Row = System.Collections.Generic.Dictionary<string, object>;

namespace Harikit.Server
{
    /// <summary>DB から読んだ列の定義。updatable は許可リストと合わせて HarikitService が決める。</summary>
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
        /// <summary>方言の内部用。SQL Server なら TYPE_NAME の結果（"varchar" など）。</summary>
        public string BaseType;
        /// <summary>方言の内部用。CAST に使う型（"decimal(9,2)" など）。</summary>
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

    public interface IHarikitTransaction
    {
        /// <summary>更新ロックを掛けて 1 行読み、before と DB の比較規則で比べる。</summary>
        LockedRow LockAndCompare(TableMeta meta, IList<string> keyColumns, Row key, Row before);
        /// <summary>パラメータ付き UPDATE を 1 行流し、UPDATE そのものの影響行数を返す（トリガーの行数は含めない）。</summary>
        int Update(TableMeta meta, IList<string> keyColumns, Row key, Row set);
    }

    /// <summary>DB がエラーを返したとき。Message は生のエラー文。</summary>
    public class HarikitDbException : Exception
    {
        public HarikitDbException(string message) : base(message) { }
        public HarikitDbException(string message, Exception inner) : base(message, inner) { }
    }

    public interface IHarikitDialect
    {
        string Name { get; }
        /// <summary>テーブル名をこの DB の正規の形（比較用）にする。</summary>
        string NormalizeTable(string table);
        TableMeta DescribeTable(string table);
        /// <summary>keys と同じ順で、見つかった行（キー列と columns）か null を返す。</summary>
        List<Row> FetchRows(TableMeta meta, IList<string> keyColumns, IList<string> columns, IList<Row> keys);
        /// <summary>fn の後、fn が true を返せばコミット、false ならロールバックする。例外でもロールバック。</summary>
        void RunTransaction(Func<IHarikitTransaction, bool> fn);
        /// <summary>人が読む UPDATE 文を 1 本作る。where は「この値のときだけ」の条件。</summary>
        string RenderUpdate(TableMeta meta, Row set, Row where);
    }
}
