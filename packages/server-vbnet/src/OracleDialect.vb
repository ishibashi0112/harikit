' Oracle の方言。SQL はここでだけ組み、値はすべてパラメータで渡す。
' テーブル名と列名は DB の定義から取り、"" で囲む。Node 版の oracle.ts、C# 版の OracleDialect.cs と同じ SQL を流す。
'
' ドライバは ODP.NET Managed Driver（Oracle.ManagedDataAccess.dll。Oracle Client を入れなくてよい）。
' コンパイル時には参照せず、web.config の providerName で名前から読み込む（SQL Server だけの載せ先に DLL を要らせず、
' 載せ先が NuGet で入れた版をそのまま使うため）。ADO.NET の共通の型（DbConnection など）で使い、
' ODP.NET にしかない設定（OracleCommand.BindByName と OracleParameter.OracleDbType）だけリフレクションで触る。
'
' Oracle で気をつけること（Oracle 23ai Free と 21c XE で確かめた。詳しくは oracle.ts の先頭）:
' - CHAR / NCHAR の列は、パラメータを列と同じ型に CAST して比べる（VARCHAR2 のままだと末尾の空白を詰めずに比べ、当たらない）。
' - NVARCHAR2 / NCHAR の値は NVARCHAR2 で渡す（VARCHAR2 で渡すと DB の文字コードを通り、表せない字が崩れる）。
' - 空文字は NULL になる。文字列の列に emptyIsNull を付け、コアが空文字を NULL として扱う。
' - = はセッションの NLS_COMP に従うので、つないだら BINARY にする。値が変わっていないかは 12.2 以降なら COLLATE BINARY も付ける。
' - NUMBER は .NET の Decimal（28 桁）に収まらないことがあるので（NUMBER(38) を読むと OverflowException）、TO_CHAR で文字列にして読む。
'   TO_CHAR と TO_NUMBER はセッションの NLS_NUMERIC_CHARACTERS に従い、ODP.NET はこれを .NET のカルチャから決める（de-DE なら ","）ので、
'   つないだら '.,' にする。変えたセッションの設定は、接続をプールに返す前に元に戻す（載せ先のアプリと同じプールを使いうるため）。

Option Strict On
Option Explicit On
Option Infer On
Option Compare Binary

Imports System
Imports System.Collections.Generic
Imports System.Data
Imports System.Data.Common
Imports System.Globalization
Imports System.Reflection
Imports System.Text
Imports System.Text.RegularExpressions
Imports Microsoft.VisualBasic
Imports Row = System.Collections.Generic.Dictionary(Of String, Object)

Namespace Global.Patchiri.Server

    Public NotInheritable Class OracleDialect
        Implements IPatchiriDialect

        ''' <summary>web.config の providerName。ODP.NET Managed Driver だけを扱う。</summary>
        Public Const ProviderName As String = "Oracle.ManagedDataAccess.Client"

        ' UTF8 は CESU-8。補助面の字は 6 バイトになるので、バイト数の最後の確認は DB で行う。
        ' AL16UTF16 の中身は UTF-16BE だが、バイト数は同じ。
        ' WHATWG には ISO-8859-1 がなく windows-1252 として読む。違う字（0x80〜0x9F）は DB で確かめる。
        ''' <summary>DB の文字コード（NLS_CHARACTERSET / NLS_NCHAR_CHARACTERSET）→ WHATWG の文字コード名（仕様 3）。</summary>
        Private Shared ReadOnly Charsets As New Dictionary(Of String, String) From {
            {"AL32UTF8", "utf-8"},
            {"UTF8", "utf-8"},
            {"AL16UTF16", "utf-16le"},
            {"JA16SJIS", "shift_jis"}, {"JA16SJISTILDE", "shift_jis"},
            {"JA16EUC", "euc-jp"}, {"JA16EUCTILDE", "euc-jp"},
            {"ZHS16GBK", "gbk"},
            {"ZHT16BIG5", "big5"}, {"ZHT16MSWIN950", "big5"}, {"ZHT16HKSCS", "big5"},
            {"KO16MSWIN949", "euc-kr"}, {"KO16KSC5601", "euc-kr"},
            {"TH8TISASCII", "windows-874"},
            {"EE8MSWIN1250", "windows-1250"}, {"CL8MSWIN1251", "windows-1251"}, {"WE8MSWIN1252", "windows-1252"},
            {"WE8ISO8859P1", "windows-1252"},
            {"WE8ISO8859P15", "iso-8859-15"},
            {"EL8MSWIN1253", "windows-1253"}, {"TR8MSWIN1254", "windows-1254"}, {"IW8MSWIN1255", "windows-1255"},
            {"AR8MSWIN1256", "windows-1256"}, {"BLT8MSWIN1257", "windows-1257"}, {"VN8MSWIN1258", "windows-1258"}
        }

        ''' <summary>比べ方をそろえる。人が流すスクリプトの先頭にも入れる（数値はリテラルで書くので NLS_NUMERIC_CHARACTERS は要らない）。</summary>
        Private Const SessionSqlCompare As String = "ALTER SESSION SET NLS_COMP = 'BINARY' NLS_SORT = 'BINARY'"
        ''' <summary>そろえるセッションの設定と値（この順で読み、変え、戻す）。</summary>
        Private Shared ReadOnly SessionParams As String() = {"NLS_COMP", "NLS_SORT", "NLS_NUMERIC_CHARACTERS"}
        Private Shared ReadOnly SessionValues As String() = {"BINARY", "BINARY", ".,"}

        Private Shared ReadOnly TablePartRe As New Regex("\G\s*(?:""([^""]+)""|([^.""\s@]+))\s*(?:\.|\z)")
        Private Shared ReadOnly TypeLengthRe As New Regex("\([0-9]+\)")

        ''' <summary>
        ''' 人が流す SQL で、1 つのリテラルに書く長さ（文字数）。SQL*Plus は 1 行が 2499 文字（23ai は 4999）を超えると読まないので、
        ''' 長い値は分けて || でつなぐ。UNISTR の \XXXX は 1 字が 10 文字まで膨らむ。
        ''' </summary>
        Private Const LiteralChunk As Integer = 100

        Private Const CrChar As Char = ChrW(13)
        Private Const LfChar As Char = ChrW(10)

        Private Const LockedMessage As String = "対象の行がほかのセッションにロックされています。コミットしていない更新が残っていないか確かめてから、もう一度試してください"

        Private NotInheritable Class OraTable
            Public Owner As String
            Public Name As String
            ''' <summary>値の厳密な比べ方に COLLATE BINARY を使えるか（12.2 以降）。</summary>
            Public Collate As Boolean
            ''' <summary>DB の文字コード（WHATWG の名前）。戻し SQL で N'' に書けない字を見分ける。</summary>
            Public DbEncoding As String
            Public DbByteEncoding As Encoding
        End Class

        Private NotInheritable Class DbInfo
            ''' <summary>版（23.4 なら 2304）。</summary>
            Public Version As Integer
            Public Charset As String
            Public NcharCharset As String
        End Class

        Private ReadOnly connectionString As String
        Private ReadOnly lockWaitSeconds As Integer
        Private ReadOnly driver As OracleDriver
        Private ReadOnly sync As New Object()
        Private cachedInfo As DbInfo

        ''' <param name="lockWaitSeconds">反映で行のロックを待つ秒数（SELECT … FOR UPDATE WAIT n）。過ぎたら db_error で何も変えない。</param>
        Public Sub New(connectionString As String, Optional lockWaitSeconds As Integer = 10)
            Me.connectionString = connectionString
            Me.lockWaitSeconds = lockWaitSeconds
            driver = New OracleDriver()
        End Sub

        Public ReadOnly Property Name As String Implements IPatchiriDialect.Name
            Get
                Return "oracle"
            End Get
        End Property

        ''' <summary>
        ''' ODP.NET を名前で読み込み、Oracle にしかない設定（BindByName、OracleDbType）を触る小道具。
        ''' 載せ先に登録があれば DbProviderFactories から、なければ bin の Oracle.ManagedDataAccess.dll から読む。
        ''' </summary>
        Private NotInheritable Class OracleDriver
            Public ReadOnly Factory As DbProviderFactory
            Private ReadOnly bindByName As PropertyInfo
            Private ReadOnly longFetchSize As PropertyInfo
            Private ReadOnly oracleDbType As PropertyInfo
            Private ReadOnly dbTypes As New Dictionary(Of String, Object)()

            Public Sub New()
                Try
                    Factory = DbProviderFactories.GetFactory(ProviderName)
                Catch e As Exception
                    Dim factoryType = System.Type.GetType("Oracle.ManagedDataAccess.Client.OracleClientFactory, Oracle.ManagedDataAccess", False)
                    Dim field = If(factoryType Is Nothing, Nothing, factoryType.GetField("Instance", BindingFlags.Public Or BindingFlags.Static))
                    If field Is Nothing Then
                        Throw New PatchiriConfigException("Oracle につなぐ ODP.NET（Oracle.ManagedDataAccess.dll）が見つかりません。NuGet で Oracle.ManagedDataAccess を入れるか、bin に置いてください")
                    End If
                    Factory = DirectCast(field.GetValue(Nothing), DbProviderFactory)
                End Try
                Dim commandType = Factory.CreateCommand().GetType()
                bindByName = commandType.GetProperty("BindByName")
                longFetchSize = commandType.GetProperty("InitialLONGFetchSize")
                oracleDbType = Factory.CreateParameter().GetType().GetProperty("OracleDbType")
                If bindByName Is Nothing OrElse oracleDbType Is Nothing Then Throw New PatchiriConfigException(ProviderName & " が ODP.NET ではありません")
                For Each oracleTypeName In New String() {"Varchar2", "NVarchar2", "BinaryDouble", "Int32"}
                    dbTypes(oracleTypeName) = [Enum].Parse(oracleDbType.PropertyType, oracleTypeName)
                Next
            End Sub

            Public Function Command(conn As DbConnection, tx As DbTransaction, sql As String) As DbCommand
                Dim cmd = conn.CreateCommand()
                cmd.Transaction = tx
                cmd.CommandText = sql
                ' :名前 のパラメータを名前で結ぶ（ODP.NET の既定は書いた順）。
                bindByName.SetValue(cmd, True, Nothing)
                ' LONG の列も全部読む（既定の 0 では中身を読まない）。
                If longFetchSize IsNot Nothing Then longFetchSize.SetValue(cmd, -1, Nothing)
                Return cmd
            End Function

            ''' <summary>パラメータを足す。typeName は OracleDbType の名前（"Varchar2"、"NVarchar2" など）。</summary>
            Public Function Add(cmd As DbCommand, paramName As String, typeName As String, value As Object, Optional direction As ParameterDirection = ParameterDirection.Input) As DbParameter
                Dim p = cmd.CreateParameter()
                p.ParameterName = paramName
                oracleDbType.SetValue(p, dbTypes(typeName), Nothing)
                p.Direction = direction
                If direction = ParameterDirection.Input Then p.Value = If(value, DBNull.Value)
                cmd.Parameters.Add(p)
                Return p
            End Function
        End Class

        ''' <summary>ドライバのエラーを PatchiriDbException にする。ロック待ちの時間切れには、人向けの固定の文を付ける。</summary>
        Private Shared Function DbError(e As DbException) As PatchiriDbException
            Dim result As New PatchiriDbException(e.Message, e)
            Dim number = e.GetType().GetProperty("Number")
            Dim n = If(number Is Nothing, 0, Convert.ToInt32(number.GetValue(e, Nothing), CultureInfo.InvariantCulture))
            ' 23ai は ORA-00054、それより前は ORA-30006 を返す。
            If n = 54 OrElse n = 30006 Then result.PublicMessage = LockedMessage
            Return result
        End Function

        ''' <summary>名前を "" で囲む。</summary>
        Public Shared Function QuoteName(name As String) As String
            Return """" & name.Replace("""", """""") & """"
        End Function

        ''' <summary>
        ''' "PATCHIRI.M_PRODUCT"、"m_product"、"""Mixed"".""Name""" を [スキーマ, 名前] に分ける。
        ''' "" で囲まない名前は大文字にする（Oracle と同じ）。スキーマを省くと Nothing。DB リンク（@）は受けない。
        ''' </summary>
        Public Shared Function SplitTableName(table As String) As String()
            Dim parts As New List(Of String)()
            Dim pos = 0
            While pos < table.Length
                Dim m = TablePartRe.Match(table, pos)
                If Not m.Success OrElse m.Length = 0 Then Exit While
                parts.Add(If(m.Groups(1).Success, m.Groups(1).Value, m.Groups(2).Value.ToUpperInvariant()))
                pos = m.Index + m.Length
            End While
            If pos < table.Length OrElse parts.Count = 0 OrElse parts.Count > 2 Then Throw New InvalidOperationException("テーブル名 " & table & " が読めません")
            Return If(parts.Count = 1, New String() {Nothing, parts(0)}, New String() {parts(0), parts(1)})
        End Function

        Public Function NormalizeTable(table As String) As String Implements IPatchiriDialect.NormalizeTable
            ' 比べるのは DB で引いた名前（DescribeTable の Table と外部キーの参照先）どうしなので、そのまま比べる。
            Return table
        End Function

        ''' <summary>WHATWG の名前の文字コード。表せない字は例外にする。使えなければ Nothing（utf-16le も、バイト数は文字数から出すので Nothing）。</summary>
        Private Shared Function WebEncoding(encodingName As String) As Encoding
            If encodingName Is Nothing OrElse String.Equals(encodingName, "utf-16le", StringComparison.Ordinal) Then Return Nothing
            If String.Equals(encodingName, "utf-8", StringComparison.Ordinal) Then Return New UTF8Encoding(False, True)
            Try
                Return Encoding.GetEncoding(encodingName, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback)
            Catch e As ArgumentException
                Return Nothing
            Catch e As NotSupportedException
                Return Nothing
            End Try
        End Function

        Private Shared Function NullableInt(v As Object) As Integer?
            If v Is Nothing OrElse TypeOf v Is DBNull Then Return Nothing
            Return Convert.ToInt32(v, CultureInfo.InvariantCulture)
        End Function

        Private Shared Function IsText(v As Object, text As String) As Boolean
            Return String.Equals(TryCast(v, String), text, StringComparison.Ordinal)
        End Function

        ''' <summary>ALL_TAB_COLS の 1 行を列の定義にする（oracle.ts の oracleColumn と同じ）。</summary>
        Private Shared Function Column(r As Object(), server As DbInfo) As ColumnMeta
            Dim columnName = Convert.ToString(r(0), CultureInfo.InvariantCulture)
            Dim dataType = Convert.ToString(r(1), CultureInfo.InvariantCulture)
            Dim dataLength = Convert.ToInt32(r(2), CultureInfo.InvariantCulture)
            Dim charLength = Convert.ToInt32(r(3), CultureInfo.InvariantCulture)
            Dim precision = NullableInt(r(5))
            Dim scale = NullableInt(r(6))
            Dim baseType = TypeLengthRe.Replace(dataType, "").Trim()
            Dim col As New ColumnMeta With {.Name = columnName, .Type = "other", .DbType = dataType, .Nullable = IsText(r(7), "Y"), .BaseType = baseType}
            Dim encodingName As String = Nothing
            Select Case baseType
                Case "VARCHAR2", "CHAR"
                    ' 桁の単位は列ごと（VARCHAR2(10 BYTE) / VARCHAR2(10 CHAR)）。どちらでもバイトの上限は DATA_LENGTH。
                    Dim spec = charLength.ToString(CultureInfo.InvariantCulture) & If(IsText(r(4), "C"), " CHAR", " BYTE")
                    col.Type = "string"
                    col.DbType = baseType & "(" & spec & ")"
                    If baseType = "CHAR" Then col.SqlType = "CHAR(" & spec & ")"
                    If server.Charset IsNot Nothing AndAlso Charsets.TryGetValue(server.Charset, encodingName) Then col.Encoding = encodingName
                Case "NVARCHAR2", "NCHAR"
                    Dim spec = charLength.ToString(CultureInfo.InvariantCulture)
                    col.Type = "string"
                    col.DbType = baseType & "(" & spec & ")"
                    If baseType = "NCHAR" Then col.SqlType = "NCHAR(" & spec & ")"
                    If server.NcharCharset IsNot Nothing AndAlso Charsets.TryGetValue(server.NcharCharset, encodingName) Then col.Encoding = encodingName
                Case "NUMBER"
                    ' 負の scale（NUMBER(5,-2)）は入れた値が丸められ、戻し SQL の条件が合わなくなるので扱わない。
                    If Not (scale.HasValue AndAlso scale.Value < 0) Then
                        col.Type = "decimal"
                        ' INTEGER は NUMBER(*,0)。精度のない NUMBER は桁を見ない。
                        If Not precision.HasValue AndAlso Not scale.HasValue Then
                            col.DbType = "NUMBER"
                        Else
                            col.DbType = If(precision.HasValue,
                                "NUMBER(" & precision.Value.ToString(CultureInfo.InvariantCulture) & "," & If(scale, 0).ToString(CultureInfo.InvariantCulture) & ")",
                                "NUMBER(*," & scale.Value.ToString(CultureInfo.InvariantCulture) & ")")
                            col.Precision = If(precision, 38)
                            col.Scale = If(scale, 0)
                        End If
                    End If
                Case "FLOAT"
                    col.Type = "decimal"
                    col.DbType = If(precision.HasValue, "FLOAT(" & precision.Value.ToString(CultureInfo.InvariantCulture) & ")", "FLOAT")
                Case "BINARY_FLOAT", "BINARY_DOUBLE"
                    col.Type = "float"
                    col.DbType = baseType
                Case "DATE"
                    ' Oracle の DATE は時刻（秒まで）を持つ。
                    col.Type = "datetime"
                    col.DbType = "DATE"
                    col.Scale = 0
                Case "TIMESTAMP"
                    col.Type = "datetime"
                    col.DbType = "TIMESTAMP(" & If(scale, 6).ToString(CultureInfo.InvariantCulture) & ")"
                    col.Scale = If(scale, 6)
                Case "BOOLEAN"
                    col.Type = "boolean"
                    col.DbType = "BOOLEAN"
                Case "RAW"
                    col.DbType = "RAW(" & dataLength.ToString(CultureInfo.InvariantCulture) & ")"
            End Select
            If col.Type = "string" Then
                col.MaxLength = charLength
                col.MaxBytes = dataLength
                col.EmptyIsNull = True
                col.ByteEncoding = WebEncoding(col.Encoding)
            End If
            Dim defaultLength = NullableInt(r(8))
            Dim isVirtual = IsText(r(9), "YES")
            Dim isIdentity = r.Length > 10 AndAlso IsText(r(10), "YES")
            If isIdentity Then col.Identity = True
            If isVirtual Then col.Computed = True
            If Not isIdentity AndAlso Not isVirtual AndAlso If(defaultLength, 0) > 0 Then col.HasDefault = True
            Return col
        End Function

        ''' <summary>SELECT で値を仕様 1.3 の形で受け取るための式。NUMBER は文字列で受ける。</summary>
        Private Shared Function SelectExpr(col As ColumnMeta, prefix As String) As String
            Dim q = prefix & QuoteName(col.Name)
            Select Case col.BaseType
                Case "NUMBER", "FLOAT"
                    Return "TO_CHAR(" & q & ")"
                Case "DATE"
                    Return "TO_CHAR(" & q & ", 'YYYY-MM-DD""T""HH24:MI:SS')"
                Case "TIMESTAMP"
                    Return "TO_CHAR(" & q & ", 'YYYY-MM-DD""T""HH24:MI:SS.FF9')"
                Case "TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITH LOCAL TIME ZONE"
                    Return "TO_CHAR(" & q & ", 'YYYY-MM-DD""T""HH24:MI:SS.FF9TZH:TZM')"
                Case "INTERVAL YEAR TO MONTH", "INTERVAL DAY TO SECOND"
                    Return "TO_CHAR(" & q & ")"
                Case "BOOLEAN"
                    ' BOOLEAN（23ai）を読めない ODP.NET（19c まで）でも読めるよう、数にする。
                    Return "CASE WHEN " & q & " THEN 1 WHEN NOT " & q & " THEN 0 END"
                Case "RAW"
                    Return "RAWTOHEX(" & q & ")"
                Case "ROWID", "UROWID"
                    Return "ROWIDTOCHAR(" & q & ")"
                Case Else
                    Return q
            End Select
        End Function

        ''' <summary>Oracle の数値の文字列（".5"、"-.5"）を仕様の形にし、scale の桁まで 0 を足す（NUMBER(9,2) の 120 → "120.00"）。</summary>
        Public Shared Function DecimalText(s As String, scale As Integer?) As String
            Dim t = s
            If s.StartsWith(".", StringComparison.Ordinal) Then
                t = "0" & s
            ElseIf s.StartsWith("-.", StringComparison.Ordinal) Then
                t = "-0" & s.Substring(1)
            End If
            If scale.HasValue AndAlso scale.Value > 0 AndAlso PatchiriValues.DecimalRe.IsMatch(t) Then
                Dim dot = t.IndexOf("."c)
                Dim frac = If(dot < 0, 0, t.Length - dot - 1)
                If frac < scale.Value Then t = If(dot < 0, t & ".", t) & New String("0"c, scale.Value - frac)
            End If
            Return t
        End Function

        Private Shared Function ReadValue(col As ColumnMeta, v As Object) As Object
            If v Is Nothing OrElse TypeOf v Is DBNull Then Return Nothing
            Select Case col.Type
                Case "decimal"
                    Return DecimalText(Convert.ToString(v, CultureInfo.InvariantCulture), col.Scale)
                Case "datetime"
                    Return PatchiriValues.CanonicalFraction(Convert.ToString(v, CultureInfo.InvariantCulture))
                Case "float"
                    ' BINARY_FLOAT は Single のまま Double にする（0.1 にすると、送り返された before が DB の値と合わなくなる）。
                    Return PatchiriJson.JsonNumber(If(TypeOf v Is Single, CDbl(DirectCast(v, Single)), Convert.ToDouble(v, CultureInfo.InvariantCulture)))
                Case "boolean"
                    Return Convert.ToInt32(v, CultureInfo.InvariantCulture) = 1
            End Select
            Dim bytes = TryCast(v, Byte())
            If bytes IsNot Nothing Then
                Dim sb As New StringBuilder(bytes.Length * 2)
                For Each b In bytes
                    sb.Append(b.ToString("X2", CultureInfo.InvariantCulture))
                Next
                Return sb.ToString()
            End If
            If TypeOf v Is String Then Return v
            If PatchiriJson.IsNumber(v) Then Return PatchiriJson.JsonNumber(PatchiriJson.ToDouble(v))
            Return Convert.ToString(v, CultureInfo.InvariantCulture)
        End Function

        ''' <summary>日時の値（"2024-04-01T10:00:00"）を TO_DATE / TO_TIMESTAMP に渡す形にする。TIMESTAMP は小数を 9 桁にそろえる。</summary>
        Private Shared Function DateTimeText(col As ColumnMeta, v As Object) As String
            Dim s = PatchiriValues.CanonicalFraction(Convert.ToString(v, CultureInfo.InvariantCulture))
            Dim t = s.IndexOf("T"c)
            If t < 0 Then Throw New InvalidOperationException("日時ではない値: " & s)
            Dim datePart = s.Substring(0, t)
            Dim timePart = s.Substring(t + 1)
            If col.BaseType = "DATE" Then Return datePart & " " & timePart
            Dim dot = timePart.IndexOf("."c)
            Dim hms = If(dot < 0, timePart, timePart.Substring(0, dot))
            Dim frac = If(dot < 0, "", timePart.Substring(dot + 1))
            Return datePart & " " & hms & "." & frac.PadRight(9, "0"c)
        End Function

        ''' <summary>値を渡す式を作り、パラメータを足す。数値と日時は文字列で渡して DB で読む（精度を崩さない）。</summary>
        Private Function BindValue(cmd As DbCommand, paramName As String, col As ColumnMeta, v As Object) As String
            If v Is Nothing Then Return "NULL"
            Dim p = ":" & paramName
            Select Case col.BaseType
                Case "VARCHAR2"
                    driver.Add(cmd, paramName, "Varchar2", DirectCast(v, String))
                    Return p
                Case "CHAR"
                    driver.Add(cmd, paramName, "Varchar2", DirectCast(v, String))
                    Return "CAST(" & p & " AS " & col.SqlType & ")"
                Case "NVARCHAR2"
                    driver.Add(cmd, paramName, "NVarchar2", DirectCast(v, String))
                    Return p
                Case "NCHAR"
                    driver.Add(cmd, paramName, "NVarchar2", DirectCast(v, String))
                    Return "CAST(" & p & " AS " & col.SqlType & ")"
                Case "NUMBER", "FLOAT"
                    driver.Add(cmd, paramName, "Varchar2", Convert.ToString(v, CultureInfo.InvariantCulture))
                    Return "TO_NUMBER(" & p & ")"
                Case "BINARY_FLOAT", "BINARY_DOUBLE"
                    driver.Add(cmd, paramName, "BinaryDouble", PatchiriJson.ToDouble(v))
                    Return p
                Case "BOOLEAN"
                    ' BOOLEAN のパラメータを渡せない ODP.NET（19c まで）でも渡せるよう、文字列にして DB で読む。
                    driver.Add(cmd, paramName, "Varchar2", If(DirectCast(v, Boolean), "TRUE", "FALSE"))
                    Return "TO_BOOLEAN(" & p & ")"
                Case "DATE"
                    driver.Add(cmd, paramName, "Varchar2", DateTimeText(col, v))
                    Return "TO_DATE(" & p & ", 'YYYY-MM-DD HH24:MI:SS')"
                Case "TIMESTAMP"
                    driver.Add(cmd, paramName, "Varchar2", DateTimeText(col, v))
                    Return "TO_TIMESTAMP(" & p & ", 'YYYY-MM-DD HH24:MI:SS.FF9')"
                Case Else
                    Throw New InvalidOperationException("列 " & col.Name & " の型 " & col.DbType & " は扱えません")
            End Select
        End Function

        Private Shared Function QuoteString(s As String) As String
            Return "'" & s.Replace("'", "''") & "'"
        End Function

        ''' <summary>コードポイントごとに分ける（サロゲートペアを 1 つにする）。</summary>
        Private Shared Function CodePoints(s As String) As List(Of String)
            Dim list As New List(Of String)()
            Dim i = 0
            While i < s.Length
                Dim n = If(Char.IsHighSurrogate(s(i)) AndAlso i + 1 < s.Length AndAlso Char.IsLowSurrogate(s(i + 1)), 2, 1)
                list.Add(s.Substring(i, n))
                i += n
            End While
            Return list
        End Function

        Private Shared Function Hex4(code As Integer) As String
            Return code.ToString("X4", CultureInfo.InvariantCulture)
        End Function

        ''' <summary>
        ''' NVARCHAR2 / NCHAR のリテラル（改行を含まない一続き）。N'' の中身は DB の文字コードを通るので、DB の文字コードで表せない字があれば
        ''' UNISTR の \XXXX で書く（表せる字はそのまま残して読めるようにする）。UNISTR は NVARCHAR2 を返す。literal は '' / N'' のリテラルか。
        ''' </summary>
        Private Shared Function NationalPiece(chars As List(Of String), t As OraTable, ByRef literal As Boolean) As String
            Dim plain As Func(Of String, Boolean) =
                Function(ch)
                    If Char.ConvertToUtf32(ch, 0) < &H80 Then Return True
                    If String.Equals(t.DbEncoding, "utf-8", StringComparison.Ordinal) Then Return True
                    Return t.DbByteEncoding IsNot Nothing AndAlso PatchiriValues.CanEncode(t.DbByteEncoding, ch)
                End Function
            literal = chars.TrueForAll(Function(ch) plain(ch))
            If literal Then Return "N" & QuoteString(String.Concat(chars))
            Dim body As New StringBuilder()
            For Each ch In chars
                If ch = "\" Then
                    body.Append("\005C")
                ElseIf ch = "'" Then
                    body.Append("''")
                ElseIf plain(ch) Then
                    body.Append(ch)
                Else
                    For Each c In ch
                        body.Append("\"c).Append(Hex4(Convert.ToInt32(c)))
                    Next
                End If
            Next
            Return "UNISTR('" & body.ToString() & "')"
        End Function

        ''' <summary>
        ''' 文字列の列のリテラル。改行は値の中に書かず CHR(10) / UNISTR('\000A') にする。SQL*Plus は文字列の中でも、
        ''' / や . だけの行を文の終わりとして、# で始まる行を SQL*Plus のコマンドとして読んでしまうため。
        ''' 分けてつないだ値は VARCHAR2 / NVARCHAR2 になるので、CHAR / NCHAR の列では列の型に CAST する（末尾の空白を見ない比べ方のまま）。
        ''' </summary>
        Private Shared Function StringLiteral(col As ColumnMeta, s As String, t As OraTable) As String
            Dim national = col.BaseType = "NVARCHAR2" OrElse col.BaseType = "NCHAR"
            Dim pieces As New List(Of String)()
            Dim literals As New List(Of Boolean)()
            Dim token As New StringBuilder()
            Dim flush As Action =
                Sub()
                    If token.Length = 0 Then Return
                    Dim chars = CodePoints(token.ToString())
                    token.Length = 0
                    For i = 0 To chars.Count - 1 Step LiteralChunk
                        Dim part = chars.GetRange(i, Math.Min(LiteralChunk, chars.Count - i))
                        Dim literal = True
                        pieces.Add(If(national, NationalPiece(part, t, literal), QuoteString(String.Concat(part))))
                        literals.Add(literal)
                    Next
                End Sub
            For Each c In s
                If c <> CrChar AndAlso c <> LfChar Then
                    token.Append(c)
                    Continue For
                End If
                flush()
                Dim code = If(c = LfChar, 10, 13)
                pieces.Add(If(national, "UNISTR('\" & Hex4(code) & "')", "CHR(" & code.ToString(CultureInfo.InvariantCulture) & ")"))
                literals.Add(False)
            Next
            flush()
            ' 文字列のリテラル（'' と N''）はそのままで CHAR / NCHAR の列と末尾の空白を見ずに比べられる。
            If pieces.Count = 0 Then Return QuoteString(s)
            If pieces.Count = 1 AndAlso literals(0) Then Return pieces(0)
            Dim joined = String.Join(vbLf & "      || ", pieces)
            Return If(col.SqlType IsNot Nothing, "CAST(" & joined & " AS " & col.SqlType & ")", joined)
        End Function

        ''' <summary>人が読む SQL 用の値の書き方。値は CheckValue で形を確かめた後のものだけが来る。</summary>
        Private Shared Function Literal(col As ColumnMeta, v As Object, t As OraTable) As String
            If v Is Nothing Then Return "NULL"
            Select Case col.BaseType
                Case "VARCHAR2", "CHAR", "NVARCHAR2", "NCHAR"
                    ' 文字列のリテラルは CHAR 扱いなので、CHAR の列とは末尾の空白を見ずに比べ、VARCHAR2 の列とは厳密に比べる。
                    Return StringLiteral(col, DirectCast(v, String), t)
                Case "NUMBER", "FLOAT"
                    Dim s = TryCast(v, String)
                    If s Is Nothing OrElse Not PatchiriValues.DecimalRe.IsMatch(s) Then Throw New InvalidOperationException("数値ではない値: " & Convert.ToString(v, CultureInfo.InvariantCulture))
                    Return s
                Case "BINARY_FLOAT", "BINARY_DOUBLE"
                    Dim d = PatchiriJson.ToDouble(v)
                    If Double.IsNaN(d) OrElse Double.IsInfinity(d) Then Throw New InvalidOperationException("数値ではない値: " & Convert.ToString(v, CultureInfo.InvariantCulture))
                    Return PatchiriJson.FormatDouble(d)
                Case "BOOLEAN"
                    Return If(DirectCast(v, Boolean), "TRUE", "FALSE")
                Case "DATE"
                    Return "TO_DATE('" & DateTimeText(col, v) & "', 'YYYY-MM-DD HH24:MI:SS')"
                Case "TIMESTAMP"
                    Return "TIMESTAMP '" & PatchiriValues.CanonicalFraction(DirectCast(v, String)).Replace("T", " ") & "'"
                Case Else
                    Throw New InvalidOperationException("列 " & col.Name & " の型 " & col.DbType & " は SQL に書けません")
            End Select
        End Function

        Private Shared Function KeyCondition(col As ColumnMeta, expr As String) As String
            Return QuoteName(col.Name) & " = " & expr
        End Function

        ''' <summary>値が厳密に同じかの条件（仕様 1.6）。NULL は NULL とだけ同じ。</summary>
        Private Shared Function SameCondition(col As ColumnMeta, expr As String, collate As Boolean) As String
            If expr Is Nothing Then Return QuoteName(col.Name) & " IS NULL"
            Return If(col.Type = "string" AndAlso collate, QuoteName(col.Name) & " COLLATE BINARY = " & expr, QuoteName(col.Name) & " = " & expr)
        End Function

        Private Shared Function Table(meta As TableMeta) As OraTable
            Return DirectCast(meta.DialectInfo, OraTable)
        End Function

        Private Shared Function QuoteTable(meta As TableMeta) As String
            Dim t = Table(meta)
            Return QuoteName(t.Owner) & "." & QuoteName(t.Name)
        End Function

        ''' <summary>つないだ接続。閉じるときに、変えたセッションの設定を元に戻す（接続はプールに戻り、載せ先のアプリにも使われうる）。</summary>
        Private NotInheritable Class Session
            Implements IDisposable

            Public ReadOnly Conn As DbConnection
            Private ReadOnly driver As OracleDriver
            Private restore As String

            Public Sub New(driver As OracleDriver, conn As DbConnection)
                Me.driver = driver
                Me.Conn = conn
            End Sub

            ''' <summary>比べ方と数値の書き方をそろえる（違うときだけ変え、戻す文を覚える）。</summary>
            Public Sub Prepare()
                Dim current As New Dictionary(Of String, String)()
                Dim cmd = driver.Command(Conn, Nothing, "SELECT parameter, value FROM nls_session_parameters WHERE parameter IN ('NLS_COMP', 'NLS_SORT', 'NLS_NUMERIC_CHARACTERS')")
                For Each r In Query(cmd)
                    current(Convert.ToString(r(0), CultureInfo.InvariantCulture)) = TryCast(r(1), String)
                Next
                Dim changes As New List(Of String)()
                Dim back As New List(Of String)()
                For i = 0 To SessionParams.Length - 1
                    Dim currentValue As String = Nothing
                    current.TryGetValue(SessionParams(i), currentValue)
                    If String.Equals(currentValue, SessionValues(i), StringComparison.Ordinal) Then Continue For
                    changes.Add(SessionParams(i) & " = " & QuoteString(SessionValues(i)))
                    If currentValue IsNot Nothing Then back.Add(SessionParams(i) & " = " & QuoteString(currentValue))
                Next
                If changes.Count = 0 Then Return
                Execute(driver.Command(Conn, Nothing, "ALTER SESSION SET " & String.Join(" ", changes)))
                If back.Count > 0 Then restore = "ALTER SESSION SET " & String.Join(" ", back)
            End Sub

            Public Sub Dispose() Implements IDisposable.Dispose
                Try
                    If restore IsNot Nothing AndAlso Conn.State = ConnectionState.Open Then Execute(driver.Command(Conn, Nothing, restore))
                Catch e As Exception
                    ' 接続が切れているなら、プールにも戻らない。
                End Try
                Conn.Dispose()
            End Sub
        End Class

        Private Function Open() As Session
            Dim conn = driver.Factory.CreateConnection()
            conn.ConnectionString = connectionString
            Dim opened As New Session(driver, conn)
            Try
                conn.Open()
                opened.Prepare()
            Catch e As DbException
                opened.Dispose()
                Throw DbError(e)
            Catch
                opened.Dispose()
                Throw
            End Try
            Return opened
        End Function

        Private Shared Function Query(cmd As DbCommand) As List(Of Object())
            Dim rows As New List(Of Object())()
            Try
                Using reader = cmd.ExecuteReader()
                    While reader.Read()
                        Dim values(reader.FieldCount - 1) As Object
                        reader.GetValues(values)
                        rows.Add(values)
                    End While
                End Using
            Catch e As DbException
                Throw DbError(e)
            End Try
            Return rows
        End Function

        Private Shared Function Execute(cmd As DbCommand) As Integer
            Try
                Return cmd.ExecuteNonQuery()
            Catch e As DbException
                Throw DbError(e)
            End Try
        End Function

        ''' <summary>DB の版と文字コード（最初につないだときに 1 度だけ読む）。</summary>
        Private Function Info(conn As DbConnection) As DbInfo
            SyncLock sync
                If cachedInfo IsNot Nothing Then Return cachedInfo
            End SyncLock
            Dim parts = conn.ServerVersion.Split("."c)
            Dim version = Integer.Parse(parts(0), CultureInfo.InvariantCulture) * 100 + If(parts.Length > 1, Integer.Parse(parts(1), CultureInfo.InvariantCulture), 0)
            Dim x As New DbInfo With {.Version = version}
            Dim cmd = driver.Command(conn, Nothing, "SELECT parameter, value FROM nls_database_parameters WHERE parameter IN ('NLS_CHARACTERSET', 'NLS_NCHAR_CHARACTERSET')")
            For Each r In Query(cmd)
                If IsText(r(0), "NLS_CHARACTERSET") Then
                    x.Charset = TryCast(r(1), String)
                Else
                    x.NcharCharset = TryCast(r(1), String)
                End If
            Next
            SyncLock sync
                cachedInfo = x
            End SyncLock
            Return x
        End Function

        ''' <summary>許可リストのテーブル名を、実際のスキーマと名前にする。シノニム（自分のスキーマ、PUBLIC）もたどる。</summary>
        Private Function ResolveTable(conn As DbConnection, table As String) As String()
            Dim given = SplitTableName(table)
            Dim owner = given(0)
            If owner Is Nothing Then owner = Convert.ToString(Query(driver.Command(conn, Nothing, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual"))(0)(0), CultureInfo.InvariantCulture)
            Dim tableName = given(1)
            Dim allowPublic = given(0) Is Nothing
            For depth = 0 To 7
                Dim cmd = driver.Command(conn, Nothing, "SELECT 1 FROM all_tab_cols WHERE owner = :o AND table_name = :t AND ROWNUM = 1")
                driver.Add(cmd, "o", "Varchar2", owner)
                driver.Add(cmd, "t", "Varchar2", tableName)
                If Query(cmd).Count > 0 Then Return New String() {owner, tableName}
                cmd = driver.Command(conn, Nothing, "SELECT table_owner, table_name FROM all_synonyms" &
                    " WHERE synonym_name = :t AND db_link IS NULL AND (owner = :o OR (owner = 'PUBLIC' AND :pub = 1))" &
                    " ORDER BY CASE owner WHEN 'PUBLIC' THEN 1 ELSE 0 END")
                driver.Add(cmd, "t", "Varchar2", tableName)
                driver.Add(cmd, "o", "Varchar2", owner)
                driver.Add(cmd, "pub", "Int32", If(allowPublic, 1, 0))
                Dim syn = Query(cmd)
                If syn.Count = 0 Then Exit For
                owner = Convert.ToString(syn(0)(0), CultureInfo.InvariantCulture)
                tableName = Convert.ToString(syn(0)(1), CultureInfo.InvariantCulture)
                allowPublic = False
            Next
            Throw New PatchiriDbException("テーブル " & table & " が見つかりません")
        End Function

        Public Function DescribeTable(table As String) As TableMeta Implements IPatchiriDialect.DescribeTable
            Using s = Open()
                Dim conn = s.Conn
                Dim server = Info(conn)
                Dim resolved = ResolveTable(conn, table)
                Dim identityColumn = If(server.Version >= 1201, ", identity_column", "")
                Dim cmd = driver.Command(conn, Nothing, "SELECT column_name, data_type, data_length, char_length, char_used, data_precision, data_scale," &
                    " nullable, default_length, virtual_column" & identityColumn &
                    " FROM all_tab_cols WHERE owner = :o AND table_name = :t AND hidden_column = 'NO' ORDER BY column_id")
                driver.Add(cmd, "o", "Varchar2", resolved(0))
                driver.Add(cmd, "t", "Varchar2", resolved(1))
                Dim dbEncoding As String = Nothing
                If server.Charset Is Nothing OrElse Not Charsets.TryGetValue(server.Charset, dbEncoding) Then dbEncoding = Nothing
                Dim meta As New TableMeta With {
                    .Table = resolved(0) & "." & resolved(1),
                    .DialectInfo = New OraTable With {
                        .Owner = resolved(0),
                        .Name = resolved(1),
                        .Collate = server.Version >= 1202,
                        .DbEncoding = dbEncoding,
                        .DbByteEncoding = WebEncoding(dbEncoding)
                    }
                }
                For Each r In Query(cmd)
                    meta.Columns.Add(Column(r, server))
                Next

                cmd = driver.Command(conn, Nothing, "SELECT cc.column_name FROM all_constraints k" &
                    " JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name" &
                    " WHERE k.owner = :o AND k.table_name = :t AND k.constraint_type = 'P' ORDER BY cc.position")
                driver.Add(cmd, "o", "Varchar2", resolved(0))
                driver.Add(cmd, "t", "Varchar2", resolved(1))
                For Each r In Query(cmd)
                    meta.PrimaryKey.Add(Convert.ToString(r(0), CultureInfo.InvariantCulture))
                Next

                cmd = driver.Command(conn, Nothing, "SELECT k.constraint_name, cc.column_name, r.owner, r.table_name, rc.column_name" &
                    " FROM all_constraints k" &
                    " JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name" &
                    " JOIN all_constraints r ON r.owner = k.r_owner AND r.constraint_name = k.r_constraint_name" &
                    " JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position" &
                    " WHERE k.owner = :o AND k.table_name = :t AND k.constraint_type = 'R' ORDER BY k.constraint_name, cc.position")
                driver.Add(cmd, "o", "Varchar2", resolved(0))
                driver.Add(cmd, "t", "Varchar2", resolved(1))
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

        Public Function FetchRows(meta As TableMeta, keyColumns As IList(Of String), columns As IList(Of String), keys As IList(Of Row)) As List(Of Row) Implements IPatchiriDialect.FetchRows
            Dim keyCols = meta.ColumnsOf(keyColumns)
            Dim outCols = meta.ColumnsOf(columns)
            Dim output As New List(Of Row)()
            For i = 0 To keys.Count - 1
                output.Add(Nothing)
            Next
            ' キーは DUAL の UNION ALL で表にして結び、どのキーに当たったかを __i で戻す（照合順序で当たるので .NET では突き合わせない）。
            Dim chunk = Math.Max(1, Math.Min(500, 30000 \ keyCols.Count))
            Using s = Open()
                For start = 0 To keys.Count - 1 Step chunk
                    Dim count = Math.Min(chunk, keys.Count - start)
                    Dim cmd = driver.Command(s.Conn, Nothing, "")
                    Dim values As New List(Of String)()
                    For i = 0 To count - 1
                        Dim k = keys(start + i)
                        Dim items As New List(Of String)()
                        For j = 0 To keyCols.Count - 1
                            items.Add(BindValue(cmd, "k" & i & "_" & j, keyCols(j), k(keyCols(j).Name)) & If(i = 0, " AS " & QuoteName("k" & j), ""))
                        Next
                        values.Add("SELECT " & i & If(i = 0, " AS ""__i""", "") & ", " & String.Join(", ", items) & " FROM dual")
                    Next
                    Dim joins As New List(Of String)()
                    For j = 0 To keyCols.Count - 1
                        joins.Add("t." & QuoteName(keyCols(j).Name) & " = v." & QuoteName("k" & j))
                    Next
                    Dim selects As New List(Of String)()
                    For j = 0 To outCols.Count - 1
                        selects.Add(SelectExpr(outCols(j), "t.") & " AS " & QuoteName("__v" & j))
                    Next
                    cmd.CommandText = "SELECT v.""__i"", " & String.Join(", ", selects) & " FROM " & QuoteTable(meta) & " t JOIN (" &
                        String.Join(" UNION ALL ", values) & ") v ON " & String.Join(" AND ", joins)
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

        Private NotInheritable Class OraTransaction
            Implements IPatchiriTransaction

            Private ReadOnly d As OracleDialect
            Private ReadOnly conn As DbConnection
            Private ReadOnly tx As DbTransaction

            Public Sub New(d As OracleDialect, conn As DbConnection, tx As DbTransaction)
                Me.d = d
                Me.conn = conn
                Me.tx = tx
            End Sub

            Public Function LockAndCompare(meta As TableMeta, keyColumns As IList(Of String), key As Row, before As Row, read As IList(Of String)) As LockedRow Implements IPatchiriTransaction.LockAndCompare
                Dim keyCols = meta.ColumnsOf(keyColumns)
                Dim beforeCols = meta.ColumnsOf(before.Keys)
                Dim readCols = meta.ColumnsOf(If(read, New String() {}))
                Dim cmd = d.driver.Command(conn, tx, "")
                Dim conds As New List(Of String)()
                For i = 0 To keyCols.Count - 1
                    conds.Add(KeyCondition(keyCols(i), d.BindValue(cmd, "k" & i, keyCols(i), key(keyCols(i).Name))))
                Next
                Dim selects As New List(Of String)()
                Dim all As New List(Of ColumnMeta)(keyCols)
                all.AddRange(beforeCols)
                all.AddRange(readCols)
                For i = 0 To all.Count - 1
                    selects.Add(SelectExpr(all(i), "") & " AS " & QuoteName("__v" & i))
                Next
                For i = 0 To beforeCols.Count - 1
                    Dim v = before(beforeCols(i).Name)
                    Dim cond = SameCondition(beforeCols(i), If(v Is Nothing, Nothing, d.BindValue(cmd, "b" & i, beforeCols(i), v)), Table(meta).Collate)
                    selects.Add("CASE WHEN " & cond & " THEN 1 ELSE 0 END AS " & QuoteName("__m" & i))
                Next
                cmd.CommandText = "SELECT " & String.Join(", ", selects) & " FROM " & QuoteTable(meta) & " WHERE " & String.Join(" AND ", conds) &
                    " FOR UPDATE WAIT " & d.lockWaitSeconds.ToString(CultureInfo.InvariantCulture)
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
                locked.Read = New Row()
                For i = 0 To readCols.Count - 1
                    locked.Read(readCols(i).Name) = ReadValue(readCols(i), values(keyCols.Count + beforeCols.Count + i))
                Next
                Return locked
            End Function

            Public Function Update(meta As TableMeta, keyColumns As IList(Of String), key As Row, [set] As Row, now As IList(Of String)) As Integer Implements IPatchiriTransaction.Update
                Dim keyCols = meta.ColumnsOf(keyColumns)
                Dim setCols = meta.ColumnsOf([set].Keys)
                Dim cmd = d.driver.Command(conn, tx, "")
                Dim assigns As New List(Of String)()
                For i = 0 To setCols.Count - 1
                    assigns.Add(QuoteName(setCols(i).Name) & " = " & d.BindValue(cmd, "p" & i, setCols(i), [set](setCols(i).Name)))
                Next
                assigns.AddRange(NowAssigns(meta, now))
                Dim conds As New List(Of String)()
                For i = 0 To keyCols.Count - 1
                    conds.Add(KeyCondition(keyCols(i), d.BindValue(cmd, "k" & i, keyCols(i), key(keyCols(i).Name))))
                Next
                cmd.CommandText = "UPDATE " & QuoteTable(meta) & " SET " & String.Join(", ", assigns) & " WHERE " & String.Join(" AND ", conds)
                ' UPDATE 文そのものの行数で、トリガーの中の行数は入らない。
                Return Execute(cmd)
            End Function
        End Class

        Public Sub RunTransaction(fn As Func(Of IPatchiriTransaction, Boolean)) Implements IPatchiriDialect.RunTransaction
            Using s = Open()
                Dim tx As DbTransaction = Nothing
                Try
                    tx = s.Conn.BeginTransaction(IsolationLevel.ReadCommitted)
                Catch e As DbException
                    Throw DbError(e)
                End Try
                Try
                    Dim commit = fn(New OraTransaction(Me, s.Conn, tx))
                    Try
                        If commit Then
                            tx.Commit()
                        Else
                            tx.Rollback()
                        End If
                    Catch e As DbException
                        Throw DbError(e)
                    End Try
                Catch
                    Try
                        tx.Rollback()
                    Catch
                        ' つながりが切れていれば、DB 側で取り消される。
                    End Try
                    Throw
                End Try
            End Using
        End Sub

        Public Function CheckStrings(meta As TableMeta, items As IList(Of KeyValuePair(Of String, String))) As List(Of StringCheck) Implements IPatchiriDialect.CheckStrings
            Dim output As New List(Of StringCheck)()
            ' NVARCHAR2 / NCHAR は Unicode なので見ない。VARCHAR2 / CHAR は DB の文字コードにして戻し、元と同じか（表せない字は置き換わる）とバイト数を見る。
            Dim targets As New List(Of Integer)()
            For i = 0 To items.Count - 1
                output.Add(Nothing)
                Dim bt = meta.Column(items(i).Key).BaseType
                If bt = "VARCHAR2" OrElse bt = "CHAR" Then targets.Add(i)
            Next
            If targets.Count = 0 Then Return output
            Using s = Open()
                For start = 0 To targets.Count - 1 Step 100
                    Dim count = Math.Min(100, targets.Count - start)
                    Dim cmd = driver.Command(s.Conn, Nothing, "")
                    Dim calls As New StringBuilder()
                    Dim outs As New List(Of DbParameter())()
                    For j = 0 To count - 1
                        driver.Add(cmd, "s" & j, "NVarchar2", items(targets(start + j)).Value)
                        outs.Add(New DbParameter() {driver.Add(cmd, "o" & j, "Int32", Nothing, ParameterDirection.Output), driver.Add(cmd, "b" & j, "Int32", Nothing, ParameterDirection.Output)})
                        calls.Append("  c(:s" & j & ", :o" & j & ", :b" & j & ");" & vbLf)
                    Next
                    ' PL/SQL の中なら VARCHAR2 は 32767 バイトまで（SQL の 4000 バイトの制限を受けない）。
                    cmd.CommandText = "DECLARE" & vbLf & "  PROCEDURE c(s NVARCHAR2, ok OUT PLS_INTEGER, b OUT PLS_INTEGER) IS v VARCHAR2(32767);" & vbLf &
                        "  BEGIN v := TO_CHAR(s); ok := CASE WHEN TO_NCHAR(v) = s THEN 1 ELSE 0 END; b := NVL(LENGTHB(v), 0); END;" & vbLf & "BEGIN" & vbLf &
                        calls.ToString() & "END;"
                    Execute(cmd)
                    For j = 0 To count - 1
                        output(targets(start + j)) = New StringCheck With {
                            .Encodable = OutInt(outs(j)(0)) = 1,
                            .Bytes = OutInt(outs(j)(1))
                        }
                    Next
                Next
            End Using
            Return output
        End Function

        ''' <summary>出力パラメータの数（ODP.NET は OracleDecimal で返すことがあるので、文字列を通して読む）。</summary>
        Private Shared Function OutInt(p As DbParameter) As Integer
            Return Integer.Parse(Convert.ToString(p.Value, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture)
        End Function

        ''' <summary>列に DB の今の時刻を入れる式（stamp の "now"）。DATE は SYSDATE、TIMESTAMP は DB のサーバの時刻（SYSTIMESTAMP）からタイムゾーンを外したもの。</summary>
        Public Function NowExpression(col As ColumnMeta) As String Implements IPatchiriDialect.NowExpression
            If col.Type <> "date" AndAlso col.Type <> "datetime" Then Return Nothing
            Return If(col.DbType = "DATE", "SYSDATE", "CAST(SYSTIMESTAMP AS TIMESTAMP)")
        End Function

        Private Shared Function NowAssigns(meta As TableMeta, now As IList(Of String)) As List(Of String)
            Dim assigns As New List(Of String)()
            If now Is Nothing Then Return assigns
            For Each c In meta.ColumnsOf(now)
                If c.Type <> "date" AndAlso c.Type <> "datetime" Then Throw New InvalidOperationException("列 " & c.Name & " は日付・時刻の列ではありません")
                assigns.Add(QuoteName(c.Name) & " = " & If(c.DbType = "DATE", "SYSDATE", "CAST(SYSTIMESTAMP AS TIMESTAMP)"))
            Next
            Return assigns
        End Function

        Private Shared Function RenderUpdate(meta As TableMeta, u As ScriptUpdate) As String
            Dim t = Table(meta)
            Dim assigns As New List(Of String)()
            For Each c In meta.ColumnsOf(u.Set.Keys)
                assigns.Add(QuoteName(c.Name) & " = " & Literal(c, u.Set(c.Name), t))
            Next
            assigns.AddRange(NowAssigns(meta, u.Now))
            Dim conds As New List(Of String)()
            For Each c In meta.ColumnsOf(u.Key.Keys)
                conds.Add(KeyCondition(c, Literal(c, u.Key(c.Name), t)))
            Next
            For Each c In meta.ColumnsOf(u.Expect.Keys)
                conds.Add(SameCondition(c, If(u.Expect(c.Name) Is Nothing, Nothing, Literal(c, u.Expect(c.Name), t)), t.Collate))
            Next
            Dim one = "UPDATE " & QuoteTable(meta) & " SET " & String.Join(", ", assigns) & " WHERE " & String.Join(" AND ", conds)
            ' SQL*Plus の 1 行の上限より十分短く。長い文や、分けてつないだ値を含む文は、列と条件ごとに行を分ける。
            If one.Length <= 1000 AndAlso one.IndexOf(LfChar) < 0 Then Return one
            Return "UPDATE " & QuoteTable(meta) & vbLf & "     SET " & String.Join("," & vbLf & "         ", assigns) & vbLf & "   WHERE " & String.Join(vbLf & "     AND ", conds)
        End Function

        ''' <summary>
        ''' PL/SQL のブロックにして、人が流しても 1 トランザクションになるようにする（SQL*Plus は文ごとにエラーを飛ばして進むため）。
        ''' 反映は 1 行でも当たらなければ全部取り消して止まる。戻しは当たらなかった行を飛ばし、DBMS_OUTPUT に出す。
        ''' </summary>
        Public Function RenderScript(meta As TableMeta, head As String, updates As IList(Of ScriptUpdate), kind As String) As String Implements IPatchiriDialect.RenderScript
            Dim lines As New List(Of String) From {head}
            If kind = "apply" Then
                lines.Add("-- 1 つのトランザクションで流す。どれかの行が見つからないか値が変わっていたら、何も反映せずに止まる（ORA-20001）。")
            Else
                lines.Add("-- 今の値が patchiri で入れた値のままの行だけ戻す。その後に別の更新が入った行は戻さず、DBMS_OUTPUT に出す。")
            End If
            lines.Add("-- SQL*Plus、SQLcl、SQL Developer で流せる形（値の & を置き換えないよう SET DEFINE OFF にしてある）。")
            lines.Add("-- キーを大文字小文字を区別して比べるよう、このセッションの NLS_COMP / NLS_SORT を BINARY にする（流した後もこのセッションに残る）。")
            lines.Add("SET DEFINE OFF")
            lines.Add(SessionSqlCompare & ";")
            If kind = "undo" Then
                lines.Add("SET SERVEROUTPUT ON")
                lines.Add("DECLARE")
                lines.Add("  n PLS_INTEGER := 0;")
            End If
            lines.Add("BEGIN")
            For Each u In updates
                lines.Add("  " & RenderUpdate(meta, u) & ";")
                If kind = "apply" Then
                    Dim msg = QuoteString("patchiri: 行が見つからないか、値が変わっています（" & PatchiriScript.KeyText(u.Key) & "）。何も反映していません")
                    lines.Add("  IF SQL%ROWCOUNT <> 1 THEN RAISE_APPLICATION_ERROR(-20001, " & msg & "); END IF;")
                Else
                    Dim msg = QuoteString("patchiri: 戻していない行（後から別の更新が入った）: " & PatchiriScript.KeyText(u.Key))
                    lines.Add("  IF SQL%ROWCOUNT = 1 THEN n := n + 1; ELSE DBMS_OUTPUT.PUT_LINE(" & msg & "); END IF;")
                End If
            Next
            lines.Add("  COMMIT;")
            If kind = "undo" Then lines.Add("  DBMS_OUTPUT.PUT_LINE('patchiri: ' || n || ' / " & updates.Count.ToString(CultureInfo.InvariantCulture) & " 行を戻しました');")
            lines.Add("EXCEPTION")
            lines.Add("  WHEN OTHERS THEN")
            lines.Add("    ROLLBACK;")
            lines.Add("    RAISE;")
            lines.Add("END;")
            lines.Add("/")
            Return String.Join(vbLf, lines) & vbLf
        End Function

    End Class

End Namespace
