' 値の形の確認と比較。仕様 1.3 の「JSON での値」を扱う。
' コアの values.ts と同じ判定にする（クライアントとサーバでずれないように）。
' 正規表現は \d と $ を使わない（.NET の \d は全角数字にも当たり、$ は末尾の改行の前にも当たる）。

Option Strict On
Option Explicit On
Option Infer On
Option Compare Binary

Imports System
Imports System.Collections.Generic
Imports System.Globalization
Imports System.Text
Imports System.Text.RegularExpressions

Namespace Global.Harikit.Server

    Public NotInheritable Class HarikitValues

        Public Shared ReadOnly DecimalRe As New Regex("\A-?[0-9]+(\.[0-9]+)?\z")
        Public Shared ReadOnly BigintRe As New Regex("\A-?[0-9]+\z")
        Private Shared ReadOnly DateRe As New Regex("\A([0-9]{4})-([0-9]{2})-([0-9]{2})\z")
        Private Shared ReadOnly DateTimeRe As New Regex("\A([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,7})?\z")
        Private Shared ReadOnly TimeRe As New Regex("\A([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,7})?\z")

        Private Sub New()
        End Sub

        ''' <summary>dbType の先頭の型名（"decimal(9,2)" → "decimal"）。</summary>
        Public Shared Function BaseDbType(dbType As String) As String
            Dim s = dbType.ToLowerInvariant()
            Dim i = s.IndexOf("("c)
            Return If(i >= 0, s.Substring(0, i), s).Trim()
        End Function

        Private Shared Function ValidDate(y As Integer, m As Integer, d As Integer) As Boolean
            If y < 1 OrElse m < 1 OrElse m > 12 OrElse d < 1 Then Return False
            Return d <= DateTime.DaysInMonth(2000, m) - If(m = 2 AndAlso Not IsLeap(y), 1, 0)
        End Function

        Private Shared Function IsLeap(y As Integer) As Boolean
            Return (y Mod 4 = 0 AndAlso y Mod 100 <> 0) OrElse y Mod 400 = 0
        End Function

        Private Shared Function ValidTime(h As Integer, mi As Integer, s As Integer) As Boolean
            Return h < 24 AndAlso mi < 60 AndAlso s < 60
        End Function

        Private Shared Function G(m As Match, i As Integer) As Integer
            Return Integer.Parse(m.Groups(i).Value, CultureInfo.InvariantCulture)
        End Function

        ''' <summary>コードポイントの数（JS の [...s].length と同じ）。</summary>
        Public Shared Function CodePoints(s As String) As Integer
            Dim n = 0
            Dim i = 0
            While i < s.Length
                If Char.IsHighSurrogate(s(i)) AndAlso i + 1 < s.Length AndAlso Char.IsLowSurrogate(s(i + 1)) Then i += 1
                n += 1
                i += 1
            End While
            Return n
        End Function

        ''' <summary>
        ''' 値が列の型として正しい形かを見る。正しければ Nothing、違えば理由を返す。
        ''' 桁数、バイト数、文字コード、NOT NULL も見る（DB 定義でわかる範囲）。
        ''' </summary>
        Public Shared Function CheckValue(col As ColumnMeta, v As Object, nullable As Boolean) As String
            If v Is Nothing Then Return If(nullable, Nothing, "必須です（NOT NULL）")
            Select Case col.Type
                Case "string"
                    Dim s = TryCast(v, String)
                    If s Is Nothing Then Return "文字列ではありません"
                    If col.MaxLength.HasValue AndAlso col.MaxLength.Value >= 0 Then
                        Dim len = CodePoints(s)
                        If len > col.MaxLength.Value Then Return col.MaxLength.Value & " 文字を超えています（" & len & " 文字）"
                    End If
                    Return CheckBytes(col, s)
                Case "integer"
                    If Not HarikitJson.IsNumber(v) Then Return "整数ではありません"
                    Dim d = HarikitJson.ToDouble(v)
                    If Double.IsNaN(d) OrElse Double.IsInfinity(d) OrElse Math.Floor(d) <> d Then Return "整数ではありません"
                    Dim min, max As Long
                    Select Case BaseDbType(col.DbType)
                        Case "tinyint"
                            min = 0
                            max = 255
                        Case "smallint"
                            min = -32768
                            max = 32767
                        Case Else
                            min = Integer.MinValue
                            max = Integer.MaxValue
                    End Select
                    If d < min OrElse d > max Then Return "範囲外です（" & min & "〜" & max & "）"
                    Return Nothing
                Case "bigint"
                    Dim s = TryCast(v, String)
                    If s Is Nothing OrElse Not BigintRe.IsMatch(s) Then Return "整数ではありません"
                    Dim n As Long
                    If Not Long.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, n) Then Return "範囲外です（bigint）"
                    Return Nothing
                Case "decimal"
                    Dim s = TryCast(v, String)
                    If s Is Nothing OrElse Not DecimalRe.IsMatch(s) Then Return "数値ではありません"
                    If col.Precision.HasValue Then
                        Dim scale = If(col.Scale, 0)
                        Dim parts = s.TrimStart("-"c).Split("."c)
                        Dim intDigits = parts(0).TrimStart("0"c).Length
                        Dim fracDigits = If(parts.Length > 1, parts(1).TrimEnd("0"c).Length, 0)
                        If fracDigits > scale Then Return "小数は " & scale & " 桁までです"
                        If intDigits > col.Precision.Value - scale Then Return "整数部は " & (col.Precision.Value - scale) & " 桁までです"
                    End If
                    Return Nothing
                Case "float"
                    If Not HarikitJson.IsNumber(v) Then Return "数値ではありません"
                    Dim d = HarikitJson.ToDouble(v)
                    If Double.IsNaN(d) OrElse Double.IsInfinity(d) Then Return "数値ではありません"
                    Return Nothing
                Case "boolean"
                    If TypeOf v Is Boolean Then Return Nothing
                    Return "true / false ではありません"
                Case "date"
                    Dim s = TryCast(v, String)
                    Dim m = If(s Is Nothing, Nothing, DateRe.Match(s))
                    If m Is Nothing OrElse Not m.Success OrElse Not ValidDate(G(m, 1), G(m, 2), G(m, 3)) Then Return "日付（YYYY-MM-DD）ではありません"
                    Return Nothing
                Case "datetime"
                    Dim s = TryCast(v, String)
                    Dim m = If(s Is Nothing, Nothing, DateTimeRe.Match(s))
                    If m Is Nothing OrElse Not m.Success OrElse Not ValidDate(G(m, 1), G(m, 2), G(m, 3)) OrElse Not ValidTime(G(m, 4), G(m, 5), G(m, 6)) Then
                        Return "日時（YYYY-MM-DDTHH:mm:ss）ではありません"
                    End If
                    Return CheckFraction(col, m.Groups(7).Value)
                Case "time"
                    Dim s = TryCast(v, String)
                    Dim m = If(s Is Nothing, Nothing, TimeRe.Match(s))
                    If m Is Nothing OrElse Not m.Success OrElse Not ValidTime(G(m, 1), G(m, 2), G(m, 3)) Then Return "時刻（HH:mm:ss）ではありません"
                    Return CheckFraction(col, m.Groups(4).Value)
                Case Else
                    Return "この型の列は扱えません"
            End Select
        End Function

        ''' <summary>秒の小数の桁数を、列の scale（datetime2(3) なら 3）と比べる。</summary>
        Private Shared Function CheckFraction(col As ColumnMeta, fraction As String) As String
            If Not col.Scale.HasValue OrElse String.IsNullOrEmpty(fraction) Then Return Nothing
            Dim digits = fraction.Substring(1).TrimEnd("0"c).Length
            If digits > col.Scale.Value Then Return "秒の小数は " & col.Scale.Value & " 桁までです"
            Return Nothing
        End Function

        ''' <summary>
        ''' 列の文字コードでのバイト数と、表せない字を確かめる（仕様 3「文字列の列の長さと文字コード」）。
        ''' SQL Server は表せない字をエラーにせず「?」に置き換えるので、ここで止める。
        ''' 文字コードの変換は、書いて読み戻して同じになるかで見る（置き換えや近い字への読み替えも弾く）。
        ''' </summary>
        Private Shared Function CheckBytes(col As ColumnMeta, s As String) As String
            Dim bytes As Integer
            If String.Equals(col.Encoding, "utf-16le", StringComparison.Ordinal) Then
                bytes = s.Length * 2
            ElseIf col.ByteEncoding IsNot Nothing Then
                Dim bad As String = Nothing
                If Not TryEncode(col.ByteEncoding, s, bytes, bad) Then
                    Return "「" & bad & "」は列の文字コード（" & If(col.Encoding, col.ByteEncoding.WebName) & "）で表せません"
                End If
            Else
                Return Nothing
            End If
            If col.MaxBytes.HasValue AndAlso bytes > col.MaxBytes.Value Then Return col.MaxBytes.Value & " バイトを超えています（" & bytes & " バイト）"
            Return Nothing
        End Function

        Private Shared Function RoundTrips(enc As Encoding, s As String, ByRef bytes As Integer) As Boolean
            bytes = 0
            Try
                Dim b = enc.GetBytes(s)
                bytes = b.Length
                Return String.Equals(enc.GetString(b), s, StringComparison.Ordinal)
            Catch e As EncoderFallbackException
                Return False
            Catch e As DecoderFallbackException
                Return False
            End Try
        End Function

        Private Shared Function TryEncode(enc As Encoding, s As String, ByRef bytes As Integer, ByRef bad As String) As Boolean
            bad = Nothing
            If RoundTrips(enc, s, bytes) Then Return True
            Dim i = 0
            While i < s.Length
                Dim n = If(Char.IsHighSurrogate(s(i)) AndAlso i + 1 < s.Length AndAlso Char.IsLowSurrogate(s(i + 1)), 2, 1)
                Dim ch = s.Substring(i, n)
                Dim ignored As Integer
                If Not RoundTrips(enc, ch, ignored) Then
                    bad = ch
                    Return False
                End If
                i += n
            End While
            ' 1 字ずつなら表せるが、続けると変わる（シフト状態を持つ文字コードなど）。
            bad = s
            Return False
        End Function

        Private Shared Function CanonicalDecimal(v As String) As String
            Dim neg = v.StartsWith("-", StringComparison.Ordinal)
            Dim parts = v.TrimStart("-"c).Split("."c)
            Dim integerPart = parts(0).TrimStart("0"c)
            If integerPart.Length = 0 Then integerPart = "0"
            Dim frac = If(parts.Length > 1, parts(1).TrimEnd("0"c), "")
            If integerPart = "0" AndAlso frac.Length = 0 Then neg = False
            Return If(neg, "-", "") & integerPart & If(frac.Length > 0, "." & frac, "")
        End Function

        Private Shared Function CanonicalBigint(v As String) As String
            Dim neg = v.StartsWith("-", StringComparison.Ordinal)
            Dim digits = v.TrimStart("-"c).TrimStart("0"c)
            If digits.Length = 0 Then Return "0"
            Return If(neg, "-", "") & digits
        End Function

        ''' <summary>秒の小数の末尾の 0 を落とす（"09:30:00.120" → "09:30:00.12"、".000" は消す）。</summary>
        Public Shared Function CanonicalFraction(v As String) As String
            Dim dot = v.LastIndexOf("."c)
            If dot < 0 Then Return v
            For i = dot + 1 To v.Length - 1
                If v(i) < "0"c OrElse v(i) > "9"c Then Return v
            Next
            Dim frac = v.Substring(dot + 1).TrimEnd("0"c)
            If frac.Length = v.Length - dot - 1 Then Return v
            Return If(frac.Length = 0, v.Substring(0, dot), v.Substring(0, dot + 1) & frac)
        End Function

        ''' <summary>比較用に値をそろえる（"120" と "120.00" を同じにする、など）。数値は Double にする。</summary>
        Public Shared Function Canonical(typeName As String, v As Object) As Object
            If HarikitJson.IsNumber(v) Then Return HarikitJson.ToDouble(v)
            Dim s = TryCast(v, String)
            If s Is Nothing Then Return v
            Select Case typeName
                Case "decimal"
                    Return If(DecimalRe.IsMatch(s), CanonicalDecimal(s), s)
                Case "bigint"
                    Return If(BigintRe.IsMatch(s), CanonicalBigint(s), s)
                Case "datetime", "time"
                    Return CanonicalFraction(s)
                Case Else
                    Return s
            End Select
        End Function

        Private Shared Function Same(a As Object, b As Object) As Boolean
            If a Is Nothing OrElse b Is Nothing Then Return a Is Nothing AndAlso b Is Nothing
            If TypeOf a Is String AndAlso TypeOf b Is String Then Return String.Equals(DirectCast(a, String), DirectCast(b, String), StringComparison.Ordinal)
            If TypeOf a Is Boolean AndAlso TypeOf b Is Boolean Then Return DirectCast(a, Boolean) = DirectCast(b, Boolean)
            If TypeOf a Is Double AndAlso TypeOf b Is Double Then Return DirectCast(a, Double) = DirectCast(b, Double)
            Return False
        End Function

        ''' <summary>型に沿って 2 つの値が同じかを見る。NULL 同士は同じ。</summary>
        Public Shared Function SameValue(typeName As String, a As Object, b As Object) As Boolean
            Return Same(Canonical(typeName, a), Canonical(typeName, b))
        End Function

        ''' <summary>列の定義に沿って比べる。固定長の char / nchar は DB が末尾を空白で埋めるので、末尾の空白は見ない。</summary>
        Public Shared Function SameColumnValue(col As ColumnMeta, a As Object, b As Object) As Boolean
            Dim sa = TryCast(a, String)
            Dim sb = TryCast(b, String)
            If col.Type = "string" AndAlso sa IsNot Nothing AndAlso sb IsNot Nothing Then
                Dim bt = BaseDbType(col.DbType)
                If bt = "char" OrElse bt = "nchar" Then Return String.Equals(sa.TrimEnd(" "c), sb.TrimEnd(" "c), StringComparison.Ordinal)
            End If
            Return SameValue(col.Type, a, b)
        End Function

        ''' <summary>キーの組を、比べるための文字列にする。</summary>
        Public Shared Function KeyIdentity(keyCols As IList(Of ColumnMeta), key As IDictionary(Of String, Object)) As String
            Dim list As New List(Of Object)()
            For Each c In keyCols
                Dim v As Object = Nothing
                key.TryGetValue(c.Name, v)
                list.Add(Canonical(c.Type, v))
            Next
            Return HarikitJson.Identity(list)
        End Function

    End Class

End Namespace
