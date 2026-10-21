' SQL Server の方言。SQL はここでだけ組み、値はすべて SqlParameter で渡す。
' テーブル名と列名は許可リストと DB の定義から取り、[] で囲む。Node 版の mssql.ts、C# 版の SqlServerDialect.cs と同じ SQL を流す。

Option Strict On
Option Explicit On
Option Infer On
Option Compare Binary

Imports System
Imports System.Collections.Generic
Imports System.Data
Imports System.Data.SqlClient
Imports System.Globalization
Imports System.Text
Imports System.Text.RegularExpressions
Imports Microsoft.VisualBasic
Imports Row = System.Collections.Generic.Dictionary(Of String, Object)

Namespace Global.Patchiri.Server

    Public NotInheritable Class SqlServerDialect
        Implements IPatchiriDialect

        ' text / ntext は古い長い文字列の型。varchar(max) / nvarchar(max) と同じく扱う（DB が = で比べられないので、キーにはできない）。
        Private Shared ReadOnly TypeMap As New Dictionary(Of String, String) From {
            {"char", "string"}, {"varchar", "string"}, {"nchar", "string"}, {"nvarchar", "string"},
            {"text", "string"}, {"ntext", "string"},
            {"tinyint", "integer"}, {"smallint", "integer"}, {"int", "integer"},
            {"bigint", "bigint"},
            {"decimal", "decimal"}, {"numeric", "decimal"}, {"money", "decimal"}, {"smallmoney", "decimal"},
            {"real", "float"}, {"float", "float"},
            {"bit", "boolean"},
            {"date", "date"},
            {"datetime", "datetime"}, {"datetime2", "datetime"}, {"smalldatetime", "datetime"},
            {"time", "time"}
        }

        ''' <summary>照合順序のコードページ → WHATWG の文字コード名（仕様 3「文字列の列の長さと文字コード」）。</summary>
        Private Shared ReadOnly CodePages As New Dictionary(Of Integer, String) From {
            {874, "windows-874"}, {932, "shift_jis"}, {936, "gbk"}, {949, "euc-kr"}, {950, "big5"},
            {1250, "windows-1250"}, {1251, "windows-1251"}, {1252, "windows-1252"}, {1253, "windows-1253"},
            {1254, "windows-1254"}, {1255, "windows-1255"}, {1256, "windows-1256"}, {1257, "windows-1257"},
            {1258, "windows-1258"}, {65001, "utf-8"}
        }

        Private Shared ReadOnly NumberLiteralRe As New Regex("\A-?[0-9]+(\.[0-9]+)?\z")
        Private Shared ReadOnly DateLiteralRe As New Regex("\A[0-9:T.-]+\z")
        Private Shared ReadOnly CollationRe As New Regex("\A[A-Za-z0-9_]+\z")
        Private Shared ReadOnly TablePartRe As New Regex("\G\s*(?:\[((?:[^\]]|\]\])*)\]|([^.\[\]]+))\s*(?:\.|\z)")

        Private Const LockedMessage As String = "対象の行がほかのセッションにロックされています。コミットしていない更新が残っていないか確かめてから、もう一度試してください"

        Private ReadOnly connectionString As String
        Private ReadOnly lockWaitSeconds As Integer

        ''' <param name="lockWaitSeconds">反映で行のロックを待つ秒数（SET LOCK_TIMEOUT）。過ぎたら db_error で何も変えない。</param>
        Public Sub New(connectionString As String, Optional lockWaitSeconds As Integer = 10)
            Me.connectionString = connectionString
            Me.lockWaitSeconds = lockWaitSeconds
        End Sub

        ''' <summary>SqlException を PatchiriDbException にする。ロック待ちの時間切れ（1222）には、人向けの固定の文を付ける。</summary>
        Private Shared Function DbError(e As SqlException) As PatchiriDbException
            Dim result As New PatchiriDbException(e.Message, e)
            If e.Number = 1222 Then result.PublicMessage = LockedMessage
            Return result
        End Function

        Public ReadOnly Property Name As String Implements IPatchiriDialect.Name
            Get
                Return "sqlserver"
            End Get
        End Property

        ''' <summary>名前を [] で囲む。] は ]] にする。</summary>
        Public Shared Function QuoteName(name As String) As String
            Return "[" & name.Replace("]", "]]") & "]"
        End Function

        ''' <summary>"dbo.M_Product" や "[dbo].[M_Product]" を [スキーマ, 名前] に分ける。スキーマを省くと dbo。</summary>
        Public Shared Function SplitTableName(table As String) As String()
            Dim parts As New List(Of String)()
            Dim pos = 0
            While pos < table.Length
                Dim m = TablePartRe.Match(table, pos)
                If Not m.Success OrElse m.Length = 0 Then Exit While
                parts.Add(If(m.Groups(1).Success, m.Groups(1).Value.Replace("]]", "]"), m.Groups(2).Value.Trim()))
                pos = m.Index + m.Length
            End While
            If pos < table.Length OrElse parts.Count = 0 OrElse parts.Count > 2 Then Throw New InvalidOperationException("テーブル名 " & table & " が読めません")
            Return If(parts.Count = 1, New String() {"dbo", parts(0)}, New String() {parts(0), parts(1)})
        End Function

        Public Shared Function QuoteTable(table As String) As String
            Dim p = SplitTableName(table)
            Return QuoteName(p(0)) & "." & QuoteName(p(1))
        End Function

        Public Function NormalizeTable(table As String) As String Implements IPatchiriDialect.NormalizeTable
            Dim p = SplitTableName(table)
            Return (p(0) & "." & p(1)).ToLowerInvariant()
        End Function

        Private Shared Function DbTypeText(baseType As String, bytes As Integer, precision As Integer, scale As Integer) As String
            Select Case baseType
                Case "char", "varchar", "binary", "varbinary"
                    Return baseType & "(" & If(bytes = -1, "max", bytes.ToString(CultureInfo.InvariantCulture)) & ")"
                Case "nchar", "nvarchar"
                    Return baseType & "(" & If(bytes = -1, "max", (bytes \ 2).ToString(CultureInfo.InvariantCulture)) & ")"
                Case "decimal", "numeric"
                    Return baseType & "(" & precision & "," & scale & ")"
                Case "datetime2", "time", "datetimeoffset"
                    Return baseType & "(" & scale & ")"
                Case Else
                    Return baseType
            End Select
        End Function

        ''' <summary>SELECT で値を仕様 1.3 の形で受け取るための式。</summary>
        Private Shared Function SelectExpr(col As ColumnMeta, prefix As String) As String
            Dim q = prefix & QuoteName(col.Name)
            Select Case col.BaseType
                Case "decimal", "numeric"
                    Return "CONVERT(varchar(50), " & q & ")"
                Case "money", "smallmoney"
                    Return "CONVERT(varchar(50), " & q & ", 2)"
                Case "bigint"
                    Return "CONVERT(varchar(20), " & q & ")"
                Case "date"
                    Return "CONVERT(char(10), " & q & ", 23)"
                Case "datetime", "datetime2", "smalldatetime"
                    Return "CONVERT(varchar(27), " & q & ", 126)"
                Case "time"
                    Return "CONVERT(varchar(16), " & q & ")"
                Case "binary", "varbinary"
                    Return "CONVERT(varchar(max), " & q & ", 1)"
                Case Else
                    Return If(col.Type = "other", "CONVERT(nvarchar(max), " & q & ")", q)
            End Select
        End Function

        Private Shared Function ReadValue(col As ColumnMeta, v As Object) As Object
            If v Is Nothing OrElse TypeOf v Is DBNull Then Return Nothing
            If col.Type = "datetime" OrElse col.Type = "time" Then Return PatchiriValues.CanonicalFraction(Convert.ToString(v, CultureInfo.InvariantCulture))
            If TypeOf v Is String OrElse TypeOf v Is Boolean Then Return v
            If TypeOf v Is Byte OrElse TypeOf v Is Short OrElse TypeOf v Is Integer Then Return Convert.ToInt32(v, CultureInfo.InvariantCulture)
            ' real は Single のまま Double にする（0.1 を 0.1 にすると、送り返された before が DB の値と合わなくなる）。
            If TypeOf v Is Single Then Return PatchiriJson.JsonNumber(CDbl(DirectCast(v, Single)))
            If TypeOf v Is Double Then Return PatchiriJson.JsonNumber(DirectCast(v, Double))
            Return Convert.ToString(v, CultureInfo.InvariantCulture)
        End Function

        ''' <summary>
        ''' 値を渡す式を作り、パラメータを足す。文字列は列が varchar でも nvarchar で渡す
        ''' （varchar で渡すと DB の既定の照合順序のコードページで送られ、列の照合順序が違うと
        ''' 日本語が「?」になる）。数値と日時以外は文字列で渡して DB の型へ CAST する（精度を崩さない）。
        ''' </summary>
        Private Shared Function BindValue(cmd As SqlCommand, paramName As String, col As ColumnMeta, v As Object) As String
            Dim p = cmd.Parameters.Add("@" & paramName, SqlDbType.VarChar)
            Select Case col.BaseType
                Case "char", "varchar", "nchar", "nvarchar", "text", "ntext"
                    p.SqlDbType = SqlDbType.NVarChar
                    ' SqlClient は Size より長い値を黙って切るので、列より長い値は長いまま渡して DB に弾かせる。
                    Dim s = TryCast(v, String)
                    p.Size = If(Not col.MaxLength.HasValue OrElse col.MaxLength.Value = -1, -1, Math.Max(col.MaxLength.Value, If(s IsNot Nothing, s.Length, 0)))
                    If p.Size > 4000 Then p.Size = -1
                    p.Value = If(v, DBNull.Value)
                    Return "@" & paramName
                Case "tinyint"
                    p.SqlDbType = SqlDbType.TinyInt
                    p.Value = If(v Is Nothing, DBNull.Value, CObj(CByte(Math.Truncate(PatchiriJson.ToDouble(v)))))
                    Return "@" & paramName
                Case "smallint"
                    p.SqlDbType = SqlDbType.SmallInt
                    p.Value = If(v Is Nothing, DBNull.Value, CObj(CShort(Math.Truncate(PatchiriJson.ToDouble(v)))))
                    Return "@" & paramName
                Case "int"
                    p.SqlDbType = SqlDbType.Int
                    p.Value = If(v Is Nothing, DBNull.Value, CObj(CInt(Math.Truncate(PatchiriJson.ToDouble(v)))))
                    Return "@" & paramName
                Case "real", "float"
                    p.SqlDbType = SqlDbType.Float
                    p.Value = If(v Is Nothing, DBNull.Value, CObj(PatchiriJson.ToDouble(v)))
                    Return "@" & paramName
                Case "bit"
                    p.SqlDbType = SqlDbType.Bit
                    p.Value = If(v, DBNull.Value)
                    Return "@" & paramName
                Case Else
                    ' 64 文字より長い値（先頭に 0 が並ぶ数など）も切らずに渡す。
                    Dim s = If(v Is Nothing, Nothing, Convert.ToString(v, CultureInfo.InvariantCulture))
                    p.Size = If(s IsNot Nothing AndAlso s.Length > 64, -1, 64)
                    p.Value = If(s, CObj(DBNull.Value))
                    Return "CAST(@" & paramName & " AS " & col.SqlType & ")"
            End Select
        End Function

        ''' <summary>人が読む SQL 用の値の書き方。値は CheckValue で形を確かめた後のものだけが来る。</summary>
        Public Shared Function Literal(col As ColumnMeta, v As Object) As String
            If v Is Nothing Then Return "NULL"
            Select Case col.Type
                Case "string"
                    ' varchar の列にも N'' で書く（列の照合順序で変換され、DB の既定と違っても崩れない）。
                    Return "N'" & DirectCast(v, String).Replace("'", "''") & "'"
                Case "boolean"
                    Return If(DirectCast(v, Boolean), "1", "0")
                Case "integer", "float"
                    Return PatchiriJson.FormatDouble(PatchiriJson.ToDouble(v))
                Case "bigint", "decimal"
                    Dim s = TryCast(v, String)
                    If s Is Nothing OrElse Not NumberLiteralRe.IsMatch(s) Then Throw New InvalidOperationException("数値ではない値: " & Convert.ToString(v))
                    Return s
                Case "date", "datetime", "time"
                    Dim s = TryCast(v, String)
                    If s Is Nothing OrElse Not DateLiteralRe.IsMatch(s) Then Throw New InvalidOperationException("日付ではない値: " & Convert.ToString(v))
                    Return "'" & s & "'"
                Case Else
                    Throw New InvalidOperationException("列 " & col.Name & " の型は SQL に書けません")
            End Select
        End Function

        ''' <summary>どの行か（キー）の条件。DB の照合順序で比べる。</summary>
        Private Shared Function Condition(col As ColumnMeta, expr As String) As String
            If expr Is Nothing Then Return QuoteName(col.Name) & " IS NULL"
            Return QuoteName(col.Name) & " = " & expr
        End Function

        ''' <summary>
        ''' 値が変わっていないかの条件（仕様 1.6）。文字列は照合順序を使わず 1 文字ずつ比べる
        ''' （Japanese_CI_AS は 'ボールペン' と 'ﾎﾞｰﾙﾍﾟﾝ' を同じとみなす）。varchar に直接 BIN2 を当てると
        ''' コードページが変わって '?' に崩れるので、先に nvarchar に直す。= は BIN2 でも末尾の空白を無視するので、
        ''' 固定長でない列は DATALENGTH も比べる。char / nchar の末尾の空白は詰め物なので見ない。
        ''' </summary>
        Private Shared Function StrictCondition(col As ColumnMeta, expr As String) As String
            If expr Is Nothing OrElse col.Type <> "string" Then Return Condition(col, expr)
            Dim nv = "CAST(" & QuoteName(col.Name) & " AS nvarchar(max))"
            Dim cond = nv & " COLLATE Latin1_General_BIN2 = " & expr
            If col.BaseType = "char" OrElse col.BaseType = "nchar" Then Return cond
            ' 戻し SQL の文面を Node 版とそろえるため、括弧で包む。
            Return "(" & cond & " AND DATALENGTH(" & nv & ") = DATALENGTH(" & expr & "))"
        End Function

        Private Function Open() As SqlConnection
            Dim conn As New SqlConnection(connectionString)
            Try
                conn.Open()
            Catch e As SqlException
                conn.Dispose()
                Throw DbError(e)
            End Try
            Return conn
        End Function

        Private Shared Function Query(cmd As SqlCommand) As List(Of Object())
            Dim rows As New List(Of Object())()
            Try
                Using reader = cmd.ExecuteReader()
                    While reader.Read()
                        Dim values(reader.FieldCount - 1) As Object
                        reader.GetValues(values)
                        rows.Add(values)
                    End While
                End Using
            Catch e As SqlException
                Throw DbError(e)
            End Try
            Return rows
        End Function

        Public Function DescribeTable(table As String) As TableMeta Implements IPatchiriDialect.DescribeTable
            Dim qualified = QuoteTable(table)
            Using conn = Open()
                Dim cmd As New SqlCommand(
                    "SELECT c.name, TYPE_NAME(c.system_type_id) AS base_type, c.max_length, c.precision, c.scale," &
                    " c.is_nullable, c.is_identity, c.is_computed, c.default_object_id," &
                    " CONVERT(int, COLLATIONPROPERTY(c.collation_name, 'CodePage')) AS code_page, c.collation_name," &
                    " OBJECT_SCHEMA_NAME(c.object_id) AS table_schema, OBJECT_NAME(c.object_id) AS table_name" &
                    " FROM sys.columns c WHERE c.object_id = OBJECT_ID(@name) ORDER BY c.column_id", conn)
                cmd.Parameters.Add("@name", SqlDbType.NVarChar, 512).Value = qualified
                Dim colRows = Query(cmd)
                If colRows.Count = 0 Then Throw New PatchiriDbException("テーブル " & table & " が見つかりません")
                ' 名前は DB の綴りで返す（許可リストに "Kind" や "dbo.item" と書いても "dbo.Kind"、"dbo.Item"）。
                Dim meta As New TableMeta With {.Table = Convert.ToString(colRows(0)(11), CultureInfo.InvariantCulture) & "." & Convert.ToString(colRows(0)(12), CultureInfo.InvariantCulture)}
                For Each r In colRows
                    Dim baseType = Convert.ToString(r(1), CultureInfo.InvariantCulture)
                    ' text / ntext の max_length は 16（中身を指す場所の大きさ）なので、上限なしとして扱う。
                    Dim bytes = If(baseType = "text" OrElse baseType = "ntext", -1, Convert.ToInt32(r(2), CultureInfo.InvariantCulture))
                    Dim precision = Convert.ToInt32(r(3), CultureInfo.InvariantCulture)
                    Dim scale = Convert.ToInt32(r(4), CultureInfo.InvariantCulture)
                    Dim typeName As String = Nothing
                    If Not TypeMap.TryGetValue(baseType, typeName) Then typeName = "other"
                    Dim dbTypeName = DbTypeText(baseType, bytes, precision, scale)
                    Dim col As New ColumnMeta With {
                        .Name = Convert.ToString(r(0), CultureInfo.InvariantCulture),
                        .Type = typeName,
                        .DbType = dbTypeName,
                        .Nullable = Convert.ToBoolean(r(5), CultureInfo.InvariantCulture),
                        .BaseType = baseType,
                        .SqlType = dbTypeName
                    }
                    If typeName = "string" Then
                        Dim national = baseType = "nchar" OrElse baseType = "nvarchar" OrElse baseType = "ntext"
                        col.MaxLength = If(bytes = -1, -1, If(national, bytes \ 2, bytes))
                        ' 桁はバイトで決まる。nchar / nvarchar は UTF-16、char / varchar は照合順序のコードページ。
                        If bytes <> -1 Then col.MaxBytes = bytes
                        If national Then
                            col.Encoding = "utf-16le"
                        ElseIf Not TypeOf r(9) Is DBNull Then
                            Dim codePage = Convert.ToInt32(r(9), CultureInfo.InvariantCulture)
                            Dim encodingName As String = Nothing
                            If CodePages.TryGetValue(codePage, encodingName) Then col.Encoding = encodingName
                            col.ByteEncoding = ByteEncoding(codePage)
                        End If
                        If Not national AndAlso TypeOf r(10) Is String Then col.Collation = DirectCast(r(10), String)
                    End If
                    If typeName = "decimal" Then
                        col.Precision = precision
                        col.Scale = scale
                    End If
                    If typeName = "datetime" OrElse typeName = "time" Then col.Scale = If(baseType = "datetime", 3, scale)
                    If Convert.ToBoolean(r(6), CultureInfo.InvariantCulture) Then col.Identity = True
                    If Convert.ToBoolean(r(7), CultureInfo.InvariantCulture) Then col.Computed = True
                    If Convert.ToInt32(r(8), CultureInfo.InvariantCulture) <> 0 Then col.HasDefault = True
                    meta.Columns.Add(col)
                Next

                cmd = New SqlCommand(
                    "SELECT c.name FROM sys.indexes i" &
                    " JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id" &
                    " JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id" &
                    " WHERE i.object_id = OBJECT_ID(@name) AND i.is_primary_key = 1 ORDER BY ic.key_ordinal", conn)
                cmd.Parameters.Add("@name", SqlDbType.NVarChar, 512).Value = qualified
                For Each r In Query(cmd)
                    meta.PrimaryKey.Add(Convert.ToString(r(0), CultureInfo.InvariantCulture))
                Next

                cmd = New SqlCommand(
                    "SELECT fk.name, pc.name AS col, OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS ref_schema," &
                    " OBJECT_NAME(fk.referenced_object_id) AS ref_table, rc.name AS ref_col" &
                    " FROM sys.foreign_keys fk" &
                    " JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id" &
                    " JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id" &
                    " JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id" &
                    " WHERE fk.parent_object_id = OBJECT_ID(@name) ORDER BY fk.name, fkc.constraint_column_id", conn)
                cmd.Parameters.Add("@name", SqlDbType.NVarChar, 512).Value = qualified
                Dim fks As New Dictionary(Of String, ForeignKeyMeta)()
                For Each r In Query(cmd)
                    Dim fkName = Convert.ToString(r(0), CultureInfo.InvariantCulture)
                    Dim fk As ForeignKeyMeta = Nothing
                    If Not fks.TryGetValue(fkName, fk) Then
                        fk = New ForeignKeyMeta With {
                            .Name = fkName,
                            .ReferencedTable = Convert.ToString(r(2), CultureInfo.InvariantCulture) & "." & Convert.ToString(r(3), CultureInfo.InvariantCulture)
                        }
                        fks(fkName) = fk
                        meta.ForeignKeys.Add(fk)
                    End If
                    fk.Columns.Add(Convert.ToString(r(1), CultureInfo.InvariantCulture))
                    fk.ReferencedColumns.Add(Convert.ToString(r(4), CultureInfo.InvariantCulture))
                Next
                Return meta
            End Using
        End Function

        ''' <summary>コードページの文字コード。表せない字は例外にする（近い字への置き換えをしない）。使えなければ Nothing。</summary>
        Private Shared Function ByteEncoding(codePage As Integer) As Encoding
            If codePage = 65001 Then Return New UTF8Encoding(False, True)
            Try
                Return Encoding.GetEncoding(codePage, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback)
            Catch e As ArgumentException
                Return Nothing
            Catch e As NotSupportedException
                Return Nothing
            End Try
        End Function

        Public Function FetchRows(meta As TableMeta, keyColumns As IList(Of String), columns As IList(Of String), keys As IList(Of Row)) As List(Of Row) Implements IPatchiriDialect.FetchRows
            Dim keyCols = meta.ColumnsOf(keyColumns)
            Dim outCols = meta.ColumnsOf(columns)
            Dim output As New List(Of Row)()
            For i = 0 To keys.Count - 1
                output.Add(Nothing)
            Next
            ' 1 回のパラメータは 2100 個まで、VALUES は 1000 行まで。
            Dim chunk = Math.Min(1000, 2000 \ keyCols.Count)
            Using conn = Open()
                For start = 0 To keys.Count - 1 Step chunk
                    Dim count = Math.Min(chunk, keys.Count - start)
                    Dim cmd As New SqlCommand() With {.Connection = conn}
                    Dim values As New List(Of String)()
                    For i = 0 To count - 1
                        Dim k = keys(start + i)
                        Dim exprs As New List(Of String) From {i.ToString(CultureInfo.InvariantCulture)}
                        For j = 0 To keyCols.Count - 1
                            exprs.Add(BindValue(cmd, "k" & i & "_" & j, keyCols(j), k(keyCols(j).Name)))
                        Next
                        values.Add("(" & String.Join(", ", exprs) & ")")
                    Next
                    Dim aliases As New List(Of String)()
                    Dim joins As New List(Of String)()
                    For j = 0 To keyCols.Count - 1
                        aliases.Add(QuoteName("k" & j))
                        joins.Add("t." & QuoteName(keyCols(j).Name) & " = v." & aliases(j))
                    Next
                    Dim selects As New List(Of String)()
                    For j = 0 To outCols.Count - 1
                        selects.Add(SelectExpr(outCols(j), "t.") & " AS " & QuoteName("__v" & j))
                    Next
                    cmd.CommandText = "SELECT v.[__i], " & String.Join(", ", selects) & " FROM (VALUES " & String.Join(", ", values) & ") AS v([__i], " &
                        String.Join(", ", aliases) & ") JOIN " & QuoteTable(meta.Table) & " t ON " & String.Join(" AND ", joins)
                    For Each r In Query(cmd)
                        Dim index = start + Convert.ToInt32(r(0), CultureInfo.InvariantCulture)
                        If output(index) IsNot Nothing Then Throw New PatchiriDbException("キー " & PatchiriJson.Stringify(keys(index)) & " に当たる行が複数あります（キーが一意ではありません）")
                        Dim found As New Row()
                        For j = 0 To outCols.Count - 1
                            found(outCols(j).Name) = ReadValue(outCols(j), r(j + 1))
                        Next
                        output(index) = found
                    Next
                Next
            End Using
            Return output
        End Function

        Private NotInheritable Class MsTransaction
            Implements IPatchiriTransaction

            Private ReadOnly conn As SqlConnection
            Private ReadOnly tx As SqlTransaction
            Private ReadOnly commandTimeout As Integer

            Public Sub New(conn As SqlConnection, tx As SqlTransaction, commandTimeout As Integer)
                Me.conn = conn
                Me.tx = tx
                Me.commandTimeout = commandTimeout
            End Sub

            Public Function LockAndCompare(meta As TableMeta, keyColumns As IList(Of String), key As Row, before As Row) As LockedRow Implements IPatchiriTransaction.LockAndCompare
                Dim keyCols = meta.ColumnsOf(keyColumns)
                Dim beforeCols = meta.ColumnsOf(before.Keys)
                Dim cmd As New SqlCommand() With {.Connection = conn, .Transaction = tx, .CommandTimeout = commandTimeout}
                Dim conds As New List(Of String)()
                For i = 0 To keyCols.Count - 1
                    conds.Add(Condition(keyCols(i), BindValue(cmd, "k" & i, keyCols(i), key(keyCols(i).Name))))
                Next
                Dim selects As New List(Of String)()
                Dim all As New List(Of ColumnMeta)(keyCols)
                all.AddRange(beforeCols)
                For i = 0 To all.Count - 1
                    selects.Add(SelectExpr(all(i), "") & " AS " & QuoteName("__v" & i))
                Next
                For i = 0 To beforeCols.Count - 1
                    Dim v = before(beforeCols(i).Name)
                    Dim cond = StrictCondition(beforeCols(i), If(v Is Nothing, Nothing, BindValue(cmd, "b" & i, beforeCols(i), v)))
                    selects.Add("CASE WHEN " & cond & " THEN 1 ELSE 0 END AS " & QuoteName("__m" & i))
                Next
                cmd.CommandText = "SELECT " & String.Join(", ", selects) & " FROM " & QuoteTable(meta.Table) & " WITH (UPDLOCK, HOLDLOCK) WHERE " & String.Join(" AND ", conds)
                Dim rows = Query(cmd)
                If rows.Count = 0 Then Return New LockedRow With {.Found = False}
                If rows.Count > 1 Then Throw New PatchiriDbException("キー " & PatchiriJson.Stringify(key) & " に当たる行が " & rows.Count & " 行あります（キーが一意ではありません）")
                Dim values = rows(0)
                Dim locked As New LockedRow With {.Found = True, .Current = New Row(), .Changed = New List(Of String)(), .DbKey = New Row()}
                For i = 0 To keyCols.Count - 1
                    locked.DbKey(keyCols(i).Name) = PatchiriValues.Canonical(keyCols(i).Type, ReadValue(keyCols(i), values(i)))
                Next
                For i = 0 To beforeCols.Count - 1
                    locked.Current(beforeCols(i).Name) = ReadValue(beforeCols(i), values(keyCols.Count + i))
                    If Convert.ToInt32(values(all.Count + i), CultureInfo.InvariantCulture) <> 1 Then locked.Changed.Add(beforeCols(i).Name)
                Next
                Return locked
            End Function

            Public Function Update(meta As TableMeta, keyColumns As IList(Of String), key As Row, [set] As Row) As Integer Implements IPatchiriTransaction.Update
                Dim keyCols = meta.ColumnsOf(keyColumns)
                Dim setCols = meta.ColumnsOf([set].Keys)
                Dim cmd As New SqlCommand() With {.Connection = conn, .Transaction = tx, .CommandTimeout = commandTimeout}
                Dim assigns As New List(Of String)()
                For i = 0 To setCols.Count - 1
                    assigns.Add(QuoteName(setCols(i).Name) & " = " & BindValue(cmd, "p" & i, setCols(i), [set](setCols(i).Name)))
                Next
                Dim conds As New List(Of String)()
                For i = 0 To keyCols.Count - 1
                    conds.Add(Condition(keyCols(i), BindValue(cmd, "k" & i, keyCols(i), key(keyCols(i).Name))))
                Next
                ' ExecuteNonQuery の戻り値はトリガーの中の行数も足すので、UPDATE そのものの行数を @@ROWCOUNT で読む。
                cmd.CommandText = "UPDATE " & QuoteTable(meta.Table) & " SET " & String.Join(", ", assigns) & " WHERE " & String.Join(" AND ", conds) & "; SELECT @@ROWCOUNT;"
                Return Convert.ToInt32(LastScalar(cmd), CultureInfo.InvariantCulture)
            End Function

            ''' <summary>最後の結果セットの最初の値（トリガーが結果セットを返しても、最後は SELECT @@ROWCOUNT）。</summary>
            Private Shared Function LastScalar(cmd As SqlCommand) As Object
                Dim last As Object = 0
                Try
                    Using reader = cmd.ExecuteReader()
                        Do
                            If reader.FieldCount > 0 AndAlso reader.Read() Then last = reader.GetValue(0)
                        Loop While reader.NextResult()
                    End Using
                Catch e As SqlException
                    Throw DbError(e)
                End Try
                Return last
            End Function
        End Class

        Public Sub RunTransaction(fn As Func(Of IPatchiriTransaction, Boolean)) Implements IPatchiriDialect.RunTransaction
            Using conn = Open()
                Dim tx As SqlTransaction = Nothing
                Try
                    tx = conn.BeginTransaction(IsolationLevel.ReadCommitted)
                    ' ほかのセッションが行をロックしたままでも、待ち続けずに止める（仕様 7 の手順 3、lockWaitSeconds）。
                    Execute(conn, tx, "SET LOCK_TIMEOUT " & (lockWaitSeconds * 1000L).ToString(CultureInfo.InvariantCulture) & ";")
                Catch e As SqlException
                    Throw DbError(e)
                End Try
                Try
                    ' SqlCommand の既定の 30 秒で先に切れると、ロック待ちの文（LockedMessage）にならないので、ロックを待つ秒数より長くする。
                    Dim commit = fn(New MsTransaction(conn, tx, Math.Max(30, lockWaitSeconds + 5)))
                    Try
                        If commit Then
                            tx.Commit()
                        Else
                            tx.Rollback()
                        End If
                    Catch e As SqlException
                        Throw DbError(e)
                    End Try
                Catch
                    Try
                        tx.Rollback()
                    Catch
                        ' すでにロールバックされている（XACT_ABORT やコミットの失敗など）。
                    End Try
                    Throw
                Finally
                    ' 接続はプールに戻って載せ先アプリの処理にも使われうるので、既定（待ち続ける）に戻しておく。
                    Try
                        Execute(conn, Nothing, "SET LOCK_TIMEOUT -1;")
                    Catch
                        ' 接続が切れているなら、プールにも戻らない。
                    End Try
                End Try
            End Using
        End Sub

        Private Shared Sub Execute(conn As SqlConnection, tx As SqlTransaction, text As String)
            Using cmd As New SqlCommand(text, conn, tx)
                cmd.ExecuteNonQuery()
            End Using
        End Sub

        Public Function CheckStrings(meta As TableMeta, items As IList(Of KeyValuePair(Of String, String))) As List(Of StringCheck) Implements IPatchiriDialect.CheckStrings
            Dim output As New List(Of StringCheck)()
            Dim byColumn As New Dictionary(Of String, List(Of Integer))()
            For i = 0 To items.Count - 1
                output.Add(Nothing)
                Dim col = meta.Column(items(i).Key)
                ' 照合順序の名前は DB の定義から来るが、SQL に書くので形を確かめる。
                If col.Collation Is Nothing OrElse Not CollationRe.IsMatch(col.Collation) Then Continue For
                Dim list As List(Of Integer) = Nothing
                If Not byColumn.TryGetValue(col.Name, list) Then
                    list = New List(Of Integer)()
                    byColumn(col.Name) = list
                End If
                list.Add(i)
            Next
            If byColumn.Count = 0 Then Return output
            Using conn = Open()
                For Each kv In byColumn
                    Dim col = meta.Column(kv.Key)
                    For start = 0 To kv.Value.Count - 1 Step 1000
                        Dim count = Math.Min(1000, kv.Value.Count - start)
                        Dim cmd As New SqlCommand() With {.Connection = conn}
                        Dim values As New List(Of String)()
                        For j = 0 To count - 1
                            cmd.Parameters.Add("@s" & j, SqlDbType.NVarChar, -1).Value = items(kv.Value(start + j)).Value
                            values.Add("(" & j & ", @s" & j & ")")
                        Next
                        ' 列の照合順序で varchar にして戻し、元と同じか（表せない字は「?」になる）とバイト数を見る。
                        Dim asVarchar = "CAST(v.[s] COLLATE " & col.Collation & " AS varchar(max))"
                        cmd.CommandText = "SELECT v.[j], CASE WHEN CAST(" & asVarchar & " AS nvarchar(max)) COLLATE Latin1_General_BIN2 = v.[s] COLLATE Latin1_General_BIN2 THEN 1 ELSE 0 END AS [ok], " &
                            "DATALENGTH(" & asVarchar & ") AS [bytes] FROM (VALUES " & String.Join(", ", values) & ") AS v([j], [s])"
                        For Each r In Query(cmd)
                            Dim index = kv.Value(start + Convert.ToInt32(r(0), CultureInfo.InvariantCulture))
                            output(index) = New StringCheck With {
                                .Encodable = Convert.ToInt32(r(1), CultureInfo.InvariantCulture) = 1,
                                .Bytes = If(TypeOf r(2) Is DBNull, 0, Convert.ToInt32(r(2), CultureInfo.InvariantCulture))
                            }
                        Next
                    Next
                Next
            End Using
            Return output
        End Function

        Public Function RenderScript(meta As TableMeta, head As String, updates As IList(Of ScriptUpdate), kind As String) As String Implements IPatchiriDialect.RenderScript
            Dim lines As New List(Of String) From {head}
            If kind = "apply" Then
                lines.Add("-- 1 つのトランザクションで流す。どれかの行が見つからないか値が変わっていたら、何も反映せずに止まる（エラー 50001）。")
            Else
                lines.Add("-- 今の値が patchiri で入れた値のままの行だけ戻す。0 行の UPDATE は、その後に別の更新が入った行。")
            End If
            lines.Add("SET XACT_ABORT ON;")
            lines.Add("BEGIN TRANSACTION;")
            For Each u In updates
                lines.Add(RenderUpdate(meta, u.Set, u.Key, u.Expect) & ";")
                ' 後から人が流したときに、変わっていた行だけ黙って飛ばさない。XACT_ABORT ON なので THROW で全部戻る。
                ' @@ROWCOUNT はトリガーがあっても UPDATE 文そのものの行数。
                If kind = "apply" Then
                    lines.Add("IF @@ROWCOUNT <> 1 THROW 50001, " & NString("patchiri: 行が見つからないか、値が変わっています（" & KeyText(u.Key) & "）。何も反映していません") & ", 1;")
                End If
            Next
            lines.Add("COMMIT;")
            Return String.Join(vbLf, lines) & vbLf
        End Function

        Private Shared Function NString(s As String) As String
            Return "N'" & s.Replace("'", "''") & "'"
        End Function

        ''' <summary>止めたときの文に入れるキーの値（Node 版と同じ「列=値, …」、長ければ 200 文字で切る）。</summary>
        Private Shared Function KeyText(key As Row) As String
            Dim parts As New List(Of String)()
            For Each kv In key
                Dim v = kv.Value
                Dim text As String
                If v Is Nothing Then
                    text = "null"
                ElseIf TypeOf v Is String Then
                    text = DirectCast(v, String)
                ElseIf TypeOf v Is Boolean Then
                    text = If(DirectCast(v, Boolean), "true", "false")
                ElseIf PatchiriJson.IsNumber(v) Then
                    text = PatchiriJson.FormatDouble(PatchiriJson.ToDouble(v))
                Else
                    text = Convert.ToString(v, CultureInfo.InvariantCulture)
                End If
                parts.Add(kv.Key & "=" & text)
            Next
            Dim s = String.Join(", ", parts)
            If s.Length <= 200 Then Return s
            Dim cut = If(Char.IsHighSurrogate(s(199)), 199, 200)
            Return s.Substring(0, cut) & "…"
        End Function

        Private Shared Function RenderUpdate(meta As TableMeta, setValues As Row, key As Row, expect As Row) As String
            Dim assigns As New List(Of String)()
            For Each c In meta.ColumnsOf(setValues.Keys)
                assigns.Add(QuoteName(c.Name) & " = " & Literal(c, setValues(c.Name)))
            Next
            Dim conds As New List(Of String)()
            For Each c In meta.ColumnsOf(key.Keys)
                conds.Add(Condition(c, If(key(c.Name) Is Nothing, Nothing, Literal(c, key(c.Name)))))
            Next
            For Each c In meta.ColumnsOf(expect.Keys)
                conds.Add(StrictCondition(c, If(expect(c.Name) Is Nothing, Nothing, Literal(c, expect(c.Name)))))
            Next
            Return "UPDATE " & QuoteTable(meta.Table) & " SET " & String.Join(", ", assigns) & " WHERE " & String.Join(" AND ", conds)
        End Function

    End Class

End Namespace
