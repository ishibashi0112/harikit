' サーバに置く業務ルール（patchiri.rules.json と同じ形、許可リストの rules）。コアの rules.ts、C# 版の PatchiriRules.cs と同じ決まりで見る。
' apply は severity が error のルールだけを、反映した後の行（ロックして読んだ値に after を重ねたもの）に当てる。
' pattern は ECMAScript 互換の指定で読む（\p{…} は使えない。$ は末尾の改行の前にも当たる）。

Option Strict On
Option Explicit On
Option Infer On
Option Compare Binary

Imports System
Imports System.Collections
Imports System.Collections.Generic
Imports System.Globalization
Imports System.Text.RegularExpressions
Imports Row = System.Collections.Generic.Dictionary(Of String, Object)

Namespace Global.Patchiri.Server

    ''' <summary>使える形にした業務ルール 1 つ。境界の値は列の型の値にそろえてある。</summary>
    Public NotInheritable Class PatchiriRule
        Public Column As String
        Public Col As ColumnMeta
        Public Required As Boolean
        ''' <summary>min、max、greaterThan、lessThan の固定の値。</summary>
        Public Bounds As New Dictionary(Of String, Object)()
        ''' <summary>境界にほかの列を書いたもの（{ "column": … }）。</summary>
        Public BoundColumns As New Dictionary(Of String, ColumnMeta)()
        Public Pattern As String
        Public Regex As System.Text.RegularExpressions.Regex
        Public OneOf As List(Of Object)
        Public MaxChangePercent As Double?
        ''' <summary>"error"（既定）か "warning"。</summary>
        Public Severity As String = "error"
        Public Message As String
        Public WhenCol As ColumnMeta
        ''' <summary>when の equals / oneOf を列の型の値にしたもの。</summary>
        Public WhenValues As List(Of Object)
        Public WhenEmpty As Boolean?
        ''' <summary>このルールが見る列（自分、境界の列、when の列）。2 つ以上なら行のルール。</summary>
        Public Columns As New List(Of String)()
    End Class

    Public NotInheritable Class PatchiriRules
        Private Shared ReadOnly RuleKeys As New HashSet(Of String) From {
            "column", "required", "min", "max", "greaterThan", "lessThan", "pattern", "oneOf", "maxChangePercent", "severity", "message", "when"
        }
        Private Shared ReadOnly WhenKeys As New HashSet(Of String) From {"column", "equals", "oneOf", "empty"}
        Private Shared ReadOnly BoundKeys As String() = {"min", "max", "greaterThan", "lessThan"}
        Private Shared ReadOnly OrderedTypes As New HashSet(Of String) From {"integer", "bigint", "decimal", "float", "date", "datetime", "time"}
        Private Shared ReadOnly NumericTypes As New HashSet(Of String) From {"integer", "bigint", "decimal", "float"}
        Private Shared ReadOnly DateRe As New Regex("\A[0-9]{4}-[0-9]{2}-[0-9]{2}\z")

        Private Sub New()
        End Sub

        ''' <summary>ルールの配列（1 ターゲットの分）を、列の定義と照らして使える形にする。誤りは errors に入れる（source は文の頭に付ける名前）。</summary>
        Public Shared Function Compile(target As String, columns As IList(Of ColumnMeta), rules As Object, source As String, errors As List(Of String)) As List(Of PatchiriRule)
            Dim output As New List(Of PatchiriRule)()
            If rules Is Nothing Then Return output
            Dim list = PatchiriJson.AsArray(rules)
            If list Is Nothing Then
                errors.Add(source & ": " & target & " はルールの配列にしてください")
                Return output
            End If
            Dim byName As New Dictionary(Of String, ColumnMeta)()
            For Each c In columns
                byName(c.Name.ToLowerInvariant()) = c
            Next
            For i = 0 To list.Count - 1
                Dim problem As String = Nothing
                Dim rule = CompileOne(target, byName, list(i), problem)
                If problem IsNot Nothing Then
                    errors.Add(source & " " & (i + 1) & " 番目: " & problem)
                Else
                    output.Add(rule)
                End If
            Next
            Return output
        End Function

        Private Shared Function Find(byName As Dictionary(Of String, ColumnMeta), name As Object) As ColumnMeta
            Dim s = TryCast(name, String)
            Dim c As ColumnMeta = Nothing
            Return If(s IsNot Nothing AndAlso byName.TryGetValue(s.ToLowerInvariant(), c), c, Nothing)
        End Function

        Private Shared Function CompileOne(target As String, byName As Dictionary(Of String, ColumnMeta), raw As Object, ByRef problem As String) As PatchiriRule
            problem = Nothing
            Dim r = PatchiriJson.AsObject(raw)
            If r Is Nothing Then
                problem = "オブジェクトではありません"
                Return Nothing
            End If
            Dim unknown As New List(Of String)()
            For Each k In r.Keys
                If Not RuleKeys.Contains(k) Then unknown.Add(k)
            Next
            If unknown.Count > 0 Then
                problem = "知らない項目 " & String.Join(", ", unknown) & " があります"
                Return Nothing
            End If
            Dim col = Find(byName, PatchiriJson.Get(r, "column"))
            If col Is Nothing Then
                problem = "列 " & Text(PatchiriJson.Get(r, "column")) & " は " & target & " にありません"
                Return Nothing
            End If
            Dim rule As New PatchiriRule With {.Column = col.Name, .Col = col}
            rule.Columns.Add(col.Name)
            If r.ContainsKey("severity") Then
                Dim sev = TryCast(r("severity"), String)
                If sev <> "error" AndAlso sev <> "warning" Then
                    problem = "severity は error か warning です"
                    Return Nothing
                End If
                rule.Severity = sev
            End If
            If r.ContainsKey("message") Then
                rule.Message = TryCast(r("message"), String)
                If rule.Message Is Nothing Then
                    problem = "message は文字列です"
                    Return Nothing
                End If
            End If
            If r.ContainsKey("required") Then
                If Not TypeOf r("required") Is Boolean Then
                    problem = "required は true / false です"
                    Return Nothing
                End If
                rule.Required = DirectCast(r("required"), Boolean)
            End If
            For Each k In BoundKeys
                If Not r.ContainsKey(k) Then Continue For
                If Not OrderedTypes.Contains(col.Type) Then
                    problem = k & " は数値か日付の列だけに使えます"
                    Return Nothing
                End If
                Dim refObj = PatchiriJson.AsObject(r(k))
                If refObj IsNot Nothing Then
                    Dim other = If(refObj.Count = 1, Find(byName, PatchiriJson.Get(refObj, "column")), Nothing)
                    If other Is Nothing Then
                        problem = k & " の列 " & PatchiriJson.Stringify(PatchiriJson.Get(refObj, "column")) & " は " & target & " にありません"
                        Return Nothing
                    End If
                    If Not SameKind(col, other) Then
                        problem = k & " の列 " & other.Name & " は " & col.Name & " と比べられる型ではありません"
                        Return Nothing
                    End If
                    rule.BoundColumns(k) = other
                    Use(rule, other)
                    Continue For
                End If
                Dim v = ToColumnValue(col, r(k))
                If v Is Nothing Then
                    problem = k & " の値 " & PatchiriJson.Stringify(r(k)) & " が列の型として読めません"
                    Return Nothing
                End If
                rule.Bounds(k) = v
            Next
            If r.ContainsKey("pattern") Then
                Dim p = TryCast(r("pattern"), String)
                If col.Type <> "string" OrElse p Is Nothing Then
                    problem = "pattern は文字列の列に、正規表現の文字列で書きます"
                    Return Nothing
                End If
                Try
                    rule.Regex = New Regex(p, RegexOptions.ECMAScript)
                Catch e As ArgumentException
                    problem = "pattern " & p & " は正規表現として読めません"
                    Return Nothing
                End Try
                rule.Pattern = p
            End If
            If r.ContainsKey("oneOf") Then
                Dim values = ColumnValues(col, r("oneOf"))
                If values Is Nothing Then
                    Dim arr = PatchiriJson.AsArray(r("oneOf"))
                    problem = If(arr Is Nothing OrElse arr.Count = 0, "oneOf は値の配列です", "oneOf に列の型として読めない値があります")
                    Return Nothing
                End If
                rule.OneOf = values
            End If
            If r.ContainsKey("maxChangePercent") Then
                If Not NumericTypes.Contains(col.Type) Then
                    problem = "maxChangePercent は数値の列だけに使えます"
                    Return Nothing
                End If
                Dim m = r("maxChangePercent")
                If Not PatchiriJson.IsNumber(m) OrElse Not (PatchiriJson.ToDouble(m) >= 0) Then
                    problem = "maxChangePercent は 0 以上の数です"
                    Return Nothing
                End If
                rule.MaxChangePercent = PatchiriJson.ToDouble(m)
            End If
            If r.ContainsKey("when") Then
                Dim w = PatchiriJson.AsObject(r("when"))
                If w Is Nothing Then
                    problem = "when は { column, equals } の形です"
                    Return Nothing
                End If
                Dim unknownWhen As New List(Of String)()
                For Each k In w.Keys
                    If Not WhenKeys.Contains(k) Then unknownWhen.Add(k)
                Next
                If unknownWhen.Count > 0 Then
                    problem = "when に知らない項目 " & String.Join(", ", unknownWhen) & " があります"
                    Return Nothing
                End If
                Dim wc = Find(byName, PatchiriJson.Get(w, "column"))
                If wc Is Nothing Then
                    problem = "when の列 " & Text(PatchiriJson.Get(w, "column")) & " は " & target & " にありません"
                    Return Nothing
                End If
                Dim kinds = 0
                For Each k In New String() {"equals", "oneOf", "empty"}
                    If w.ContainsKey(k) Then kinds += 1
                Next
                If kinds <> 1 Then
                    problem = "when には equals、oneOf、empty のどれか 1 つを書きます"
                    Return Nothing
                End If
                If w.ContainsKey("empty") Then
                    If Not TypeOf w("empty") Is Boolean Then
                        problem = "when.empty は true / false です"
                        Return Nothing
                    End If
                    rule.WhenEmpty = DirectCast(w("empty"), Boolean)
                ElseIf w.ContainsKey("oneOf") Then
                    Dim arr = PatchiriJson.AsArray(w("oneOf"))
                    If arr Is Nothing OrElse arr.Count = 0 Then
                        problem = "when.oneOf は値の配列です"
                        Return Nothing
                    End If
                    rule.WhenValues = ColumnValues(wc, w("oneOf"))
                Else
                    Dim one As New ArrayList()
                    one.Add(w("equals"))
                    rule.WhenValues = ColumnValues(wc, one)
                End If
                If Not rule.WhenEmpty.HasValue AndAlso rule.WhenValues Is Nothing Then
                    problem = "when の値が列 " & wc.Name & " の型として読めません"
                    Return Nothing
                End If
                rule.WhenCol = wc
                Use(rule, wc)
            End If
            Return rule
        End Function

        Private Shared Sub Use(rule As PatchiriRule, c As ColumnMeta)
            If Not rule.Columns.Contains(c.Name) Then rule.Columns.Add(c.Name)
        End Sub

        Private Shared Function Text(v As Object) As String
            Dim s = TryCast(v, String)
            If s IsNot Nothing Then Return s
            Return If(v Is Nothing, "undefined", PatchiriJson.Stringify(v))
        End Function

        ''' <summary>値の配列を列の型の値にする。空か、読めない値があれば Nothing。</summary>
        Private Shared Function ColumnValues(col As ColumnMeta, raw As Object) As List(Of Object)
            Dim arr = PatchiriJson.AsArray(raw)
            If arr Is Nothing OrElse arr.Count = 0 Then Return Nothing
            Dim values As New List(Of Object)()
            For Each v In arr
                Dim cv = ToColumnValue(col, v)
                If cv Is Nothing Then Return Nothing
                values.Add(cv)
            Next
            Return values
        End Function

        ''' <summary>境界に書いたほかの列と比べられるか（数どうし、または同じ日付・時刻の型）。</summary>
        Private Shared Function SameKind(a As ColumnMeta, b As ColumnMeta) As Boolean
            If NumericTypes.Contains(a.Type) Then Return NumericTypes.Contains(b.Type)
            Return a.Type = b.Type
        End Function

        ''' <summary>ルールの値（0、"2026-04-01" など）を列の型の値にする。読めなければ Nothing。</summary>
        Private Shared Function ToColumnValue(col As ColumnMeta, raw As Object) As Object
            Dim v As Object = PatchiriJson.Normalize(raw)
            If Not TypeOf v Is Double AndAlso Not TypeOf v Is String AndAlso Not TypeOf v Is Boolean Then Return Nothing
            If TypeOf v Is Double AndAlso (col.Type = "decimal" OrElse col.Type = "bigint") Then v = PatchiriJson.FormatDouble(DirectCast(v, Double))
            If col.Type = "datetime" AndAlso TypeOf v Is String AndAlso DateRe.IsMatch(DirectCast(v, String)) Then v = DirectCast(v, String) & "T00:00:00"
            ' 桁の上限はルールの値には当てない（「100 万以下」などは列の桁より小さいとは限らない）。
            Dim loose As New ColumnMeta With {.Name = col.Name, .Type = col.Type, .DbType = col.DbType, .Nullable = True, .Scale = col.Scale}
            Return If(PatchiriValues.CheckValue(loose, v, True) Is Nothing, v, Nothing)
        End Function

        Private Shared Function Show(v As Object) As String
            Dim s = TryCast(v, String)
            If s IsNot Nothing Then Return s
            If TypeOf v Is Boolean Then Return If(DirectCast(v, Boolean), "true", "false")
            If PatchiriJson.IsNumber(v) Then Return PatchiriJson.FormatDouble(PatchiriJson.ToDouble(v))
            Return PatchiriJson.Stringify(v)
        End Function

        Private Shared Function IsEmpty(v As Object) As Boolean
            Return v Is Nothing OrElse (TypeOf v Is String AndAlso DirectCast(v, String).Length = 0)
        End Function

        ''' <summary>数の値（数値か 10 進の文字列）を 10 進の文字列にする。</summary>
        Private Shared Function DecimalText(v As Object) As String
            If Not PatchiriJson.IsNumber(v) Then Return Convert.ToString(v, CultureInfo.InvariantCulture)
            Dim d = PatchiriJson.ToDouble(v)
            If Math.Floor(d) = d AndAlso Math.Abs(d) < 1.0E+15 Then Return CLng(d).ToString(CultureInfo.InvariantCulture)
            ' decimal は double を 15 桁で丸めて受け取る（JS の toPrecision(15) と同じ）。
            If Math.Abs(d) < 1.0E+28 Then Return New Decimal(d).ToString(CultureInfo.InvariantCulture)
            Return PatchiriJson.FormatDouble(d)
        End Function

        Private Shared Function CompareDecimal(a As String, b As String) As Integer
            Dim ca = DirectCast(PatchiriValues.Canonical("decimal", a), String)
            Dim cb = DirectCast(PatchiriValues.Canonical("decimal", b), String)
            Dim na = ca.StartsWith("-", StringComparison.Ordinal)
            Dim nb = cb.StartsWith("-", StringComparison.Ordinal)
            If na <> nb Then Return If(na, -1, 1)
            Dim sign = If(na, -1, 1)
            Dim pa = ca.TrimStart("-"c).Split("."c)
            Dim pb = cb.TrimStart("-"c).Split("."c)
            Dim ai = pa(0)
            Dim af = If(pa.Length > 1, pa(1), "")
            Dim bi = pb(0)
            Dim bf = If(pb.Length > 1, pb(1), "")
            If ai.Length <> bi.Length Then Return If(ai.Length < bi.Length, -1, 1) * sign
            Dim len = Math.Max(af.Length, bf.Length)
            Dim x = ai & af.PadRight(len, "0"c)
            Dim y = bi & bf.PadRight(len, "0"c)
            Dim c = String.CompareOrdinal(x, y)
            Return If(c = 0, 0, If(c < 0, -1, 1) * sign)
        End Function

        ''' <summary>型に沿って大小を比べる。</summary>
        Private Shared Function CompareValues(col As ColumnMeta, a As Object, b As Object) As Integer
            Select Case col.Type
                Case "integer", "float"
                    Return Math.Sign(PatchiriJson.ToDouble(a) - PatchiriJson.ToDouble(b))
                Case "bigint", "decimal"
                    Return CompareDecimal(DecimalText(a), DecimalText(b))
                Case Else
                    Dim x = Convert.ToString(PatchiriValues.Canonical(col.Type, a), CultureInfo.InvariantCulture)
                    Dim y = Convert.ToString(PatchiriValues.Canonical(col.Type, b), CultureInfo.InvariantCulture)
                    Dim c = String.CompareOrdinal(x, y)
                    Return If(c = 0, 0, If(c < 0, -1, 1))
            End Select
        End Function

        Private Shared Function CompareEqual(col As ColumnMeta, a As Object, b As Object) As Boolean
            If OrderedTypes.Contains(col.Type) Then Return CompareValues(col, a, b) = 0
            If TypeOf a Is String AndAlso TypeOf b Is String Then Return String.Equals(DirectCast(a, String), DirectCast(b, String), StringComparison.Ordinal)
            If TypeOf a Is Boolean AndAlso TypeOf b Is Boolean Then Return DirectCast(a, Boolean) = DirectCast(b, Boolean)
            Return False
        End Function

        ''' <summary>行の値で、when の条件に合うか。条件の列が行に無ければ Nothing（見られない）。</summary>
        Private Shared Function WhenHolds(rule As PatchiriRule, row As Row) As Boolean?
            If rule.WhenCol Is Nothing Then Return True
            Dim v As Object = Nothing
            If Not row.TryGetValue(rule.WhenCol.Name, v) Then Return Nothing
            If rule.WhenEmpty.HasValue Then Return IsEmpty(v) = rule.WhenEmpty.Value
            If IsEmpty(v) Then Return False
            For Each w In rule.WhenValues
                If CompareEqual(rule.WhenCol, w, v) Then Return True
            Next
            Return False
        End Function

        ''' <summary>
        ''' 1 つの値をルールで見る（row は同じ行のほかの列の値）。合わなければ理由を返す。変動率はここでは見ない（CheckChange）。
        ''' ルールの列が row に無ければ見ない。
        ''' </summary>
        Public Shared Function Check(rule As PatchiriRule, v As Object, row As Row) As String
            For Each c In rule.Columns
                If c <> rule.Column AndAlso Not row.ContainsKey(c) Then Return Nothing
            Next
            If Not WhenHolds(rule, row).GetValueOrDefault() Then Return Nothing
            v = PatchiriJson.Normalize(v)
            If IsEmpty(v) Then Return If(rule.Required, If(rule.Message, "必須です（業務ルール）"), Nothing)
            Dim texts = New String() {" 以上にしてください", " 以下にしてください", " より大きくしてください", " より小さくしてください"}
            For i = 0 To BoundKeys.Length - 1
                Dim k = BoundKeys(i)
                Dim bound As Object = Nothing
                Dim label As String
                If rule.Bounds.TryGetValue(k, bound) Then
                    label = Show(bound)
                Else
                    Dim other As ColumnMeta = Nothing
                    If Not rule.BoundColumns.TryGetValue(k, other) Then Continue For
                    bound = PatchiriJson.Normalize(row(other.Name))
                    ' 比べる相手の列が空なら、その境界は見ない。
                    If IsEmpty(bound) Then Continue For
                    label = other.Name & "（" & Show(bound) & "）"
                End If
                ' ほかの列の値は型が違いうる（int と decimal など）ので、数は 10 進の文字列にして比べる。
                Dim cmp = If(NumericTypes.Contains(rule.Col.Type) AndAlso (TypeOf v Is Double) <> (TypeOf bound Is Double),
                    CompareDecimal(DecimalText(v), DecimalText(bound)),
                    CompareValues(rule.Col, v, bound))
                Dim broken = (k = "min" AndAlso cmp < 0) OrElse (k = "max" AndAlso cmp > 0) OrElse (k = "greaterThan" AndAlso cmp <= 0) OrElse (k = "lessThan" AndAlso cmp >= 0)
                If broken Then Return If(rule.Message, label & texts(i))
            Next
            Dim s = TryCast(v, String)
            If rule.Regex IsNot Nothing AndAlso s IsNot Nothing AndAlso Not rule.Regex.IsMatch(s) Then Return If(rule.Message, "決まった形（" & rule.Pattern & "）になっていません")
            If rule.OneOf IsNot Nothing Then
                For Each o In rule.OneOf
                    If CompareEqual(rule.Col, o, v) Then Return Nothing
                Next
                Dim shown As New List(Of String)()
                For Each o In rule.OneOf
                    shown.Add(Show(o))
                Next
                Return If(rule.Message, "使える値は " & String.Join(", ", shown) & " です")
            End If
            Return Nothing
        End Function

        ''' <summary>
        ''' ルールの列とは別の列に付ける文（行のルールで、ルールの列をその行で変えていないとき）。コアの ruleMessageAt と同じ。
        ''' ルールの文はルールの列についてのものなので、頭にその列と今の値を付ける。message を書いたルールはそのまま。
        ''' </summary>
        Public Shared Function MessageAt(rule As PatchiriRule, message As String, column As String, row As Row) As String
            If column = rule.Column OrElse rule.Message IsNot Nothing Then Return message
            Dim v As Object = Nothing
            row.TryGetValue(rule.Column, v)
            v = PatchiriJson.Normalize(v)
            Dim head = If(IsEmpty(v), rule.Column & " は", rule.Column & "（" & Show(v) & "）は")
            If message.Length > 0 AndAlso message(0) >= "!"c AndAlso message(0) <= "~"c Then Return head & " " & message
            Return head & message
        End Function

        ''' <summary>今の値から新しい値への変動がルールの上限を超えていれば理由を返す。when は row で見る。</summary>
        Public Shared Function CheckChange(rule As PatchiriRule, before As Object, after As Object, row As Row) As String
            If Not rule.MaxChangePercent.HasValue OrElse before Is Nothing OrElse after Is Nothing Then Return Nothing
            If Not WhenHolds(rule, row).GetValueOrDefault() Then Return Nothing
            Dim b, a As Double
            If Not TryNumber(before, b) OrElse Not TryNumber(after, a) Then Return Nothing
            If b = 0 Then Return If(a = 0, Nothing, If(rule.Message, "今の値が 0 なので変動率を出せません（" & Show(after) & " にします）"))
            Dim pct = Math.Abs(a - b) / Math.Abs(b) * 100
            If pct <= rule.MaxChangePercent.Value + 0.000000001 Then Return Nothing
            Dim rounded = Math.Round(pct * 10, MidpointRounding.AwayFromZero) / 10
            Return If(rule.Message, "今の値 " & Show(before) & " から " & PatchiriJson.FormatDouble(rounded) & "% 変わります（±" & PatchiriJson.FormatDouble(rule.MaxChangePercent.Value) & "% まで）")
        End Function

        Private Shared Function TryNumber(v As Object, ByRef d As Double) As Boolean
            If PatchiriJson.IsNumber(v) Then
                d = PatchiriJson.ToDouble(v)
                Return Not Double.IsNaN(d) AndAlso Not Double.IsInfinity(d)
            End If
            Dim s = TryCast(v, String)
            If s IsNot Nothing AndAlso Double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, d) Then Return True
            d = 0
            Return False
        End Function

    End Class

End Namespace
