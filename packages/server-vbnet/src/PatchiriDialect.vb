' DB ごとの違いを閉じ込める入口。PatchiriService はこの形だけを使う。

Option Strict On
Option Explicit On
Option Infer On
Option Compare Binary

Imports System
Imports System.Collections.Generic
Imports Row = System.Collections.Generic.Dictionary(Of String, Object)

Namespace Global.Patchiri.Server

    ''' <summary>DB から読んだ列の定義。updatable は許可リストと合わせて PatchiriService が決める。</summary>
    Public NotInheritable Class ColumnMeta
        Public Name As String
        ''' <summary>正規化した型（仕様 1.3）: string, integer, bigint, decimal, float, boolean, date, datetime, time, other。</summary>
        Public [Type] As String
        Public DbType As String
        Public Nullable As Boolean
        ''' <summary>文字数。max は -1。</summary>
        Public MaxLength As Integer?
        ''' <summary>列の文字コードでの上限バイト数。max の列では Nothing。</summary>
        Public MaxBytes As Integer?
        ''' <summary>列の文字コードの WHATWG 名（"shift_jis"、"utf-16le" など）。わからなければ Nothing。</summary>
        Public Encoding As String
        Public Precision As Integer?
        Public Scale As Integer?
        Public Identity As Boolean
        Public Computed As Boolean
        Public HasDefault As Boolean

        ''' <summary>
        ''' 値をバイト列に直して上限と表せない字を確かめるための文字コード。
        ''' Nothing なら UTF-16（nchar / nvarchar）か、確かめられない文字コード。
        ''' </summary>
        Public ByteEncoding As System.Text.Encoding
        ''' <summary>方言の内部用。char / varchar の列の照合順序（DB で文字コードを確かめるのに使う）。</summary>
        Public Collation As String
        ''' <summary>方言の内部用。SQL Server なら TYPE_NAME の結果（"varchar" など）。</summary>
        Public BaseType As String
        ''' <summary>方言の内部用。CAST に使う型（"decimal(9,2)" など）。</summary>
        Public SqlType As String
    End Class

    Public NotInheritable Class ForeignKeyMeta
        Public Name As String
        Public Columns As New List(Of String)()
        ''' <summary>スキーマ付きの名前（"dbo.M_Category"）。</summary>
        Public ReferencedTable As String
        Public ReferencedColumns As New List(Of String)()
    End Class

    Public NotInheritable Class TableMeta
        ''' <summary>スキーマ付きの名前（"dbo.M_Product"）。</summary>
        Public Table As String
        ''' <summary>DB の列順。</summary>
        Public Columns As New List(Of ColumnMeta)()
        Public PrimaryKey As New List(Of String)()
        Public ForeignKeys As New List(Of ForeignKeyMeta)()

        Public Function Column(name As String) As ColumnMeta
            For Each c In Columns
                If String.Equals(c.Name, name, StringComparison.Ordinal) Then Return c
            Next
            Throw New InvalidOperationException("列 " & name & " が " & Table & " にありません")
        End Function

        Public Function ColumnsOf(names As IEnumerable(Of String)) As List(Of ColumnMeta)
            Dim list As New List(Of ColumnMeta)()
            For Each n In names
                list.Add(Column(n))
            Next
            Return list
        End Function
    End Class

    Public NotInheritable Class LockedRow
        Public Found As Boolean
        ''' <summary>before に書かれた列の今の値。</summary>
        Public Current As Row
        ''' <summary>before と今の値が違う列。</summary>
        Public Changed As List(Of String)
        ''' <summary>DB にあるキーの値（照合順序で同じ行を指す 2 行を見分けるため）。</summary>
        Public DbKey As Row
    End Class

    ''' <summary>文字列を列の文字コードで書いた結果（DB 自身に確かめたもの）。</summary>
    Public NotInheritable Class StringCheck
        ''' <summary>列の文字コードで表せるか（表せない字は DB が「?」に置き換える）。</summary>
        Public Encodable As Boolean
        Public Bytes As Integer
    End Class

    Public Interface IPatchiriTransaction
        ''' <summary>更新ロックを掛けて 1 行読み、before と DB の比較規則で比べる。</summary>
        Function LockAndCompare(meta As TableMeta, keyColumns As IList(Of String), key As Row, before As Row) As LockedRow
        ''' <summary>パラメータ付き UPDATE を 1 行流し、UPDATE そのものの影響行数を返す（トリガーの行数は含めない）。</summary>
        Function Update(meta As TableMeta, keyColumns As IList(Of String), key As Row, [set] As Row) As Integer
    End Interface

    ''' <summary>DB がエラーを返したとき。Message は生のエラー文。</summary>
    Public Class PatchiriDbException
        Inherits Exception

        ''' <summary>
        ''' 人が次に何をすればよいか分かるエラー（ロック待ちの時間切れなど）に、DB の生の文の代わりに返す固定の文（仕様 1.5）。
        ''' </summary>
        Public PublicMessage As String

        Public Sub New(message As String)
            MyBase.New(message)
        End Sub

        Public Sub New(message As String, inner As Exception)
            MyBase.New(message, inner)
        End Sub
    End Class

    ''' <summary>人が読む SQL の UPDATE 1 本分。Key で行を探し（照合順序）、Expect は「この値のときだけ」の条件（厳密に比べる）。</summary>
    Public NotInheritable Class ScriptUpdate
        Public [Set] As Row
        Public Key As Row
        Public Expect As Row
    End Class

    Public Interface IPatchiriDialect
        ReadOnly Property Name As String
        ''' <summary>テーブル名をこの DB の正規の形（比較用）にする。</summary>
        Function NormalizeTable(table As String) As String
        Function DescribeTable(table As String) As TableMeta
        ''' <summary>keys と同じ順で、見つかった行（キー列と columns）か Nothing を返す。</summary>
        Function FetchRows(meta As TableMeta, keyColumns As IList(Of String), columns As IList(Of String), keys As IList(Of Row)) As List(Of Row)
        ''' <summary>fn の後、fn が True を返せばコミット、False ならロールバックする。例外でもロールバック。</summary>
        Sub RunTransaction(fn As Func(Of IPatchiriTransaction, Boolean))
        ''' <summary>
        ''' 文字列の値（列名と値の組）が列の文字コードで表せるか、何バイトになるかを DB 自身に確かめる。
        ''' PatchiriValues の確認（.NET の文字コード）は DB のコードページと完全には一致しないので、これが最後の確認。
        ''' 確かめない列（nvarchar など）の値には Nothing を返す。
        ''' </summary>
        Function CheckStrings(meta As TableMeta, items As IList(Of KeyValuePair(Of String, String))) As List(Of StringCheck)
        ''' <summary>
        ''' 人が流せる SQL（値を埋め込んだもの）を作る。head は先頭のコメント行。人が流しても 1 トランザクションになる形に包む。
        ''' kind が "apply" なら反映する SQL（どれかの行が 1 行でなければ全部戻して止まる）、
        ''' "undo" なら戻し SQL（今の値が Expect のままの行だけ戻し、ほかは飛ばして続ける）。
        ''' </summary>
        Function RenderScript(meta As TableMeta, head As String, updates As IList(Of ScriptUpdate), kind As String) As String
    End Interface

End Namespace
