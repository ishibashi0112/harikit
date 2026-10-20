' JavaScriptSerializer が作る形を扱う小道具。
' 受け取る JSON は Dictionary(Of String, Object)（オブジェクト）、ArrayList か Object()（配列）、
' Integer・Long・Decimal・Double（数値）、String、Boolean、Nothing になる。"\/Date(...)\/" は DateTime になる。
' 値は JS と同じ判定になるよう、数値をすべて Double にそろえて扱う（仕様 1.3）。

Option Strict On
Option Explicit On
Option Infer On
Option Compare Binary

Imports System
Imports System.Collections
Imports System.Collections.Generic
Imports System.Globalization
Imports System.Text
Imports System.Web.Script.Serialization

Namespace Global.Patchiri.Server

    Public NotInheritable Class PatchiriJson

        Private Sub New()
        End Sub

        Public Shared Function AsObject(x As Object) As IDictionary(Of String, Object)
            Return TryCast(x, IDictionary(Of String, Object))
        End Function

        Public Shared Function AsArray(x As Object) As IList
            If TypeOf x Is String Then Return Nothing
            Return TryCast(x, IList)
        End Function

        Public Shared Function IsNumber(x As Object) As Boolean
            Return TypeOf x Is Integer OrElse TypeOf x Is Long OrElse TypeOf x Is Decimal OrElse TypeOf x Is Double OrElse TypeOf x Is Single OrElse
                TypeOf x Is Short OrElse TypeOf x Is Byte OrElse TypeOf x Is SByte OrElse TypeOf x Is UShort OrElse TypeOf x Is UInteger OrElse TypeOf x Is ULong
        End Function

        Public Shared Function ToDouble(x As Object) As Double
            ' Decimal から Double への Convert は最も近い値にならないことがある（0.10999999940395355 など）。
            ' JavaScriptSerializer は指数のない数を Decimal で返すので、文字列を通して読む（JS の読み方と同じになる）。
            If TypeOf x Is Decimal Then Return Double.Parse(DirectCast(x, Decimal).ToString(CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture)
            Return Convert.ToDouble(x, CultureInfo.InvariantCulture)
        End Function

        ''' <summary>
        ''' 読み戻すと同じ Double になる形で書く。.NET Framework の "R" は x64 で読み戻せない形を返すことがあるので、
        ''' 確かめて駄目なら 17 桁で書く。
        ''' </summary>
        Public Shared Function FormatDouble(d As Double) As String
            Dim s = d.ToString("R", CultureInfo.InvariantCulture)
            If Double.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture) <> d Then s = d.ToString("G17", CultureInfo.InvariantCulture)
            Return s
        End Function

        ''' <summary>
        ''' 返す JSON に載せる数。JavaScriptSerializer は Double を "R" で書くので（上と同じ問題）、
        ''' 読み戻せる形の Decimal にして渡す。Decimal で表せない大きさのときは Double のまま。
        ''' </summary>
        Public Shared Function JsonNumber(d As Double) As Object
            Dim m As Decimal
            If Decimal.TryParse(FormatDouble(d), NumberStyles.Float, CultureInfo.InvariantCulture, m) AndAlso ToDouble(m) = d Then Return m
            Return d
        End Function

        ''' <summary>数値を Double にそろえる。他はそのまま。</summary>
        Public Shared Function Normalize(x As Object) As Object
            If IsNumber(x) Then Return ToDouble(x)
            Return x
        End Function

        Public Shared Function [Get](o As IDictionary(Of String, Object), key As String) As Object
            Dim v As Object = Nothing
            If o IsNot Nothing AndAlso o.TryGetValue(key, v) Then Return v
            Return Nothing
        End Function

        ''' <summary>行の値（キーの組など）を、比べるための文字列にする。</summary>
        Public Shared Function Identity(values As IEnumerable(Of Object)) As String
            Dim sb As New StringBuilder()
            For Each v In values
                sb.Append("|"c)
                If v Is Nothing Then
                    sb.Append("n")
                ElseIf TypeOf v Is String Then
                    Dim s = DirectCast(v, String)
                    sb.Append("s").Append(s.Length).Append(":"c).Append(s)
                ElseIf TypeOf v Is Boolean Then
                    sb.Append(If(DirectCast(v, Boolean), "t", "f"))
                ElseIf IsNumber(v) Then
                    sb.Append("d").Append(FormatDouble(ToDouble(v)))
                Else
                    sb.Append("o").Append(Convert.ToString(v, CultureInfo.InvariantCulture))
                End If
            Next
            Return sb.ToString()
        End Function

        ''' <summary>上限なしの JavaScriptSerializer（ログやサイズの見積もり用）。</summary>
        Public Shared Function Serializer() As JavaScriptSerializer
            Return New JavaScriptSerializer() With {.MaxJsonLength = Integer.MaxValue, .RecursionLimit = 100}
        End Function

        Public Shared Function Parse(json As String) As Object
            Return Serializer().DeserializeObject(json)
        End Function

        Public Shared Function Stringify(value As Object) As String
            Return Serializer().Serialize(value)
        End Function

    End Class

End Namespace
