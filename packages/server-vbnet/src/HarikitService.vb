' API 3 本（describe / fetch / apply）の中身。Node 版の handlers.ts、C# 版の HarikitService.cs と同じ手順で動く。
' HTTP（WebMethod）と DB の違いはここの外に置く。

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

Namespace Global.Harikit.Server

    ''' <summary>業務上の失敗。HTTP 200 の ok:false で返す（仕様 1.5）。</summary>
    Public Class HarikitFailure
        Inherits Exception

        Public ReadOnly Code As String
        Public Details As Dictionary(Of String, Object)
        Public RowErrors As List(Of Object)
        Public Conflicts As List(Of Object)

        Public Sub New(code As String, message As String)
            MyBase.New(message)
            Me.Code = code
        End Sub
    End Class

    Public NotInheritable Class HarikitServiceOptions
        Public Config As HarikitConfig
        Public Dialect As IHarikitDialect
        ''' <summary>反映した人。WebForms では HttpContext.Current.User.Identity.Name。</summary>
        Public WhoAmI As Func(Of String)
        ''' <summary>反映ログを 1 件書く。</summary>
        Public Log As Action(Of Dictionary(Of String, Object))
        ''' <summary>サーバ側のエラーを残す。</summary>
        Public LogError As Action(Of Exception)
        Public Now As Func(Of DateTime)
        ''' <summary>
        ''' 返せる JSON の長さ（文字数）。WebMethod の maxJsonLength。超える結果は ASP.NET が返せず HTTP 500 になるので、
        ''' apply は DB を変える前に確かめて止める（コミットした後に戻し SQL が返らない、を避ける）。Nothing なら見ない。
        ''' </summary>
        Public MaxResponseLength As Integer?
    End Class

    Public NotInheritable Class HarikitService

        Private Shared ReadOnly RequestIdRe As New Regex("\A[0-9A-Za-z][0-9A-Za-z-]{7,63}\z")
        ''' <summary>二度押し・再送対策に覚えておく execute の結果の数。</summary>
        Private Const AppliedKeep As Integer = 100

        Private NotInheritable Class Resolved
            Public Name As String
            Public Target As TargetConfig
            Public Meta As TableMeta
            Public Key As List(Of String)
            Public KeyColumns As List(Of ColumnMeta)
            ''' <summary>readable の列（DB の列順）。</summary>
            Public Columns As List(Of ColumnMeta)
            Public Updatable As HashSet(Of String)
            ''' <summary>小文字の列名 → 列。</summary>
            Public ByName As Dictionary(Of String, ColumnMeta)

            Public Function Find(columnName As String) As ColumnMeta
                Dim c As ColumnMeta = Nothing
                If columnName IsNot Nothing AndAlso ByName.TryGetValue(columnName.ToLowerInvariant(), c) Then Return c
                Return Nothing
            End Function
        End Class

        Private NotInheritable Class KeyResult
            Public Key As Row
            Public ErrorCode As String
            Public ErrorColumn As String
            Public ErrorMessage As String
        End Class

        Private NotInheritable Class ApplyRow
            Public Key As Row
            Public Before As Row
            Public After As Row
        End Class

        Private ReadOnly o As HarikitServiceOptions
        Private ReadOnly sync As New Object()
        Private ReadOnly metaCache As New Dictionary(Of String, TableMeta)(StringComparer.Ordinal)
        Private ReadOnly applied As New Dictionary(Of String, Dictionary(Of String, Object))(StringComparer.Ordinal)
        Private ReadOnly appliedOrder As New Queue(Of String)()

        Public Sub New(options As HarikitServiceOptions)
            If options.Config Is Nothing OrElse options.Dialect Is Nothing Then Throw New ArgumentException("Config と Dialect は必須です")
            o = options
        End Sub

        Public Function Handle(name As String, body As Object) As Dictionary(Of String, Object)
            Try
                Dim b = HarikitJson.AsObject(body)
                If b Is Nothing Then Throw New HarikitFailure("bad_request", "リクエストが JSON のオブジェクトではありません")
                Dim v = HarikitJson.Get(b, "v")
                If Not HarikitJson.IsNumber(v) OrElse HarikitJson.ToDouble(v) <> 1 Then
                    Throw New HarikitFailure("version_unsupported", "v=" & Show(v) & " には対応していません（1 だけ）")
                End If
                If name = "describe" Then Return Describe(b)
                If name = "fetch" Then Return Fetch(b)
                If name = "apply" Then Return Apply(b)
                Throw New HarikitFailure("bad_request", "API " & name & " はありません")
            Catch e As Exception
                Return Failure(e, body)
            End Try
        End Function

        Private Shared Function Show(v As Object) As String
            If v Is Nothing Then Return "null"
            If TypeOf v Is String Then Return HarikitJson.Stringify(v)
            If TypeOf v Is Boolean Then Return If(DirectCast(v, Boolean), "true", "false")
            If HarikitJson.IsNumber(v) Then Return HarikitJson.FormatDouble(HarikitJson.ToDouble(v))
            Return HarikitJson.Stringify(v)
        End Function

        Private Shared Function Ok() As Dictionary(Of String, Object)
            Return New Dictionary(Of String, Object) From {{"ok", True}, {"v", 1}}
        End Function

        Private Function Failure(e As Exception, body As Object) As Dictionary(Of String, Object)
            Dim errorInfo As New Dictionary(Of String, Object)()
            Dim f = TryCast(e, HarikitFailure)
            If f IsNot Nothing Then
                errorInfo("code") = f.Code
                errorInfo("message") = f.Message
                If f.Details IsNot Nothing Then errorInfo("details") = f.Details
            ElseIf TypeOf e Is HarikitDbException Then
                LogError(e)
                errorInfo("code") = "db_error"
                errorInfo("message") = If(o.Config.ExposeDbErrors, e.Message, If(DirectCast(e, HarikitDbException).PublicMessage, "DB がエラーを返しました（詳細はサーバのログ）"))
            Else
                LogError(e)
                errorInfo("code") = "internal_error"
                errorInfo("message") = "サーバでエラーが起きました（詳細はサーバのログ）"
            End If
            Dim res As New Dictionary(Of String, Object) From {{"ok", False}, {"v", 1}}
            Dim b = HarikitJson.AsObject(body)
            Dim requestId = TryCast(HarikitJson.Get(b, "requestId"), String)
            If requestId IsNot Nothing Then res("requestId") = requestId
            Dim mode = TryCast(HarikitJson.Get(b, "mode"), String)
            If mode = "check" OrElse mode = "execute" Then res("mode") = mode
            res("error") = errorInfo
            If f IsNot Nothing AndAlso f.RowErrors IsNot Nothing Then res("rowErrors") = f.RowErrors
            If f IsNot Nothing AndAlso f.Conflicts IsNot Nothing Then res("conflicts") = f.Conflicts
            Return res
        End Function

        Private Sub LogError(e As Exception)
            If o.LogError Is Nothing Then Return
            Try
                o.LogError.Invoke(e)
            Catch
                ' エラーの記録に失敗しても、返す結果は変えない。
            End Try
        End Sub

        Private Function GetMeta(table As String) As TableMeta
            SyncLock sync
                Dim cached As TableMeta = Nothing
                If metaCache.TryGetValue(table, cached) Then Return cached
            End SyncLock
            Dim meta = o.Dialect.DescribeTable(table)
            SyncLock sync
                metaCache(table) = meta
            End SyncLock
            Return meta
        End Function

        Private Function Resolve(nameObj As Object) As Resolved
            Dim name = TryCast(nameObj, String)
            If name Is Nothing OrElse Not o.Config.Targets.ContainsKey(name) Then
                Throw New HarikitFailure("unknown_target", "ターゲット " & If(name, Show(nameObj)) & " はありません") With {
                    .Details = New Dictionary(Of String, Object) From {{"target", nameObj}}
                }
            End If
            Dim target = o.Config.Targets(name)
            Dim meta = GetMeta(target.Table)
            Dim dbCols As New Dictionary(Of String, ColumnMeta)()
            For Each c In meta.Columns
                dbCols(c.Name.ToLowerInvariant()) = c
            Next
            Dim pick As Func(Of List(Of String), List(Of String)) =
                Function(list)
                    Dim names As New List(Of String)()
                    For Each c In list
                        Dim col As ColumnMeta = Nothing
                        If Not dbCols.TryGetValue(c.ToLowerInvariant(), col) Then
                            Throw New InvalidOperationException("許可リストの列 " & name & "." & c & " が " & meta.Table & " にありません")
                        End If
                        names.Add(col.Name)
                    Next
                    Return names
                End Function
            Dim readable As New HashSet(Of String)(pick(target.Readable))
            Dim key = If(target.Key IsNot Nothing, pick(target.Key), New List(Of String)(meta.PrimaryKey))
            If key.Count = 0 Then Throw New InvalidOperationException(name & " のキーがわかりません（主キーがないので key を設定してください）")
            For Each k In key
                If Not readable.Contains(k) Then Throw New InvalidOperationException(name & " のキー列 " & k & " が readable にありません")
            Next
            Dim allowed As New HashSet(Of String)(If(target.Access = "update", pick(target.Updatable), New List(Of String)()))
            Dim r As New Resolved With {
                .Name = name,
                .Target = target,
                .Meta = meta,
                .Key = key,
                .KeyColumns = meta.ColumnsOf(key),
                .Columns = New List(Of ColumnMeta)(),
                .Updatable = New HashSet(Of String)(),
                .ByName = New Dictionary(Of String, ColumnMeta)()
            }
            For Each c In meta.Columns
                If Not readable.Contains(c.Name) Then Continue For
                r.Columns.Add(c)
                r.ByName(c.Name.ToLowerInvariant()) = c
                If allowed.Contains(c.Name) AndAlso Not key.Contains(c.Name) AndAlso c.Type <> "other" AndAlso Not c.Identity AndAlso Not c.Computed Then r.Updatable.Add(c.Name)
            Next
            Return r
        End Function

        Private Function Limits() As Dictionary(Of String, Object)
            Return New Dictionary(Of String, Object) From {{"maxFetchKeys", o.Config.MaxFetchKeys}, {"maxApplyRows", o.Config.MaxApplyRows}}
        End Function

        Private Function Describe(body As IDictionary(Of String, Object)) As Dictionary(Of String, Object)
            If Not body.ContainsKey("target") Then
                Dim targets As New List(Of Object)()
                For Each targetName In o.Config.TargetNames
                    Dim t = o.Config.Targets(targetName)
                    targets.Add(New Dictionary(Of String, Object) From {{"target", targetName}, {"table", t.Table}, {"access", t.Access}})
                Next
                Dim list = Ok()
                list("targets") = targets
                Return list
            End If
            Dim r = Resolve(body("target"))
            Dim columns As New List(Of Object)()
            Dim readableNames As New HashSet(Of String)()
            For Each c In r.Columns
                readableNames.Add(c.Name)
                ' 方言が内部用に持つ項目は出さない。
                Dim col As New Dictionary(Of String, Object) From {
                    {"name", c.Name},
                    {"type", c.Type},
                    {"dbType", c.DbType},
                    {"nullable", c.Nullable},
                    {"updatable", r.Updatable.Contains(c.Name)}
                }
                If c.MaxLength.HasValue Then col("maxLength") = c.MaxLength.Value
                If c.MaxBytes.HasValue Then col("maxBytes") = c.MaxBytes.Value
                If c.Encoding IsNot Nothing Then col("encoding") = c.Encoding
                If c.Precision.HasValue Then col("precision") = c.Precision.Value
                If c.Scale.HasValue Then col("scale") = c.Scale.Value
                If c.Identity Then col("identity") = True
                If c.Computed Then col("computed") = True
                If c.HasDefault Then col("hasDefault") = True
                columns.Add(col)
            Next
            Dim foreignKeys As New List(Of Object)()
            For Each fk In r.Meta.ForeignKeys
                If Not fk.Columns.TrueForAll(AddressOf readableNames.Contains) Then Continue For
                foreignKeys.Add(New Dictionary(Of String, Object) From {
                    {"name", fk.Name},
                    {"columns", New List(Of String)(fk.Columns)},
                    {"referencedTable", fk.ReferencedTable},
                    {"referencedColumns", New List(Of String)(fk.ReferencedColumns)},
                    {"referencedTarget", FindReferenceTarget(fk.ReferencedTable, fk.ReferencedColumns)}
                })
            Next
            Dim res = Ok()
            res("target") = r.Name
            res("table") = r.Target.Table
            res("access") = r.Target.Access
            res("dialect") = o.Dialect.Name
            res("key") = New List(Of String)(r.Key)
            res("columns") = columns
            res("foreignKeys") = foreignKeys
            res("limits") = Limits()
            Return res
        End Function

        ''' <summary>参照先テーブルを、キーがちょうど参照先の列になっている読めるターゲットから探す。</summary>
        Private Function FindReferenceTarget(table As String, columns As List(Of String)) As String
            Dim want As String
            Try
                want = o.Dialect.NormalizeTable(table)
            Catch e As Exception
                ' 参照先の名前が読めない（参照先に権限がないなど）ときは「確認できない」扱いにする。
                Return Nothing
            End Try
            Dim cols As New HashSet(Of String)()
            For Each c In columns
                cols.Add(c.ToLowerInvariant())
            Next
            For Each targetName In o.Config.TargetNames
                Try
                    If o.Dialect.NormalizeTable(o.Config.Targets(targetName).Table) <> want Then Continue For
                    Dim r = Resolve(targetName)
                    If r.Key.Count = cols.Count AndAlso r.Key.TrueForAll(Function(k) cols.Contains(k.ToLowerInvariant())) Then Return targetName
                Catch e As Exception
                    ' 参照先の設定がおかしいときは「確認できない」扱いにする。
                End Try
            Next
            Return Nothing
        End Function

        ''' <summary>キーのオブジェクトを確かめ、列名を DB の綴りにそろえる。</summary>
        Private Shared Function NormalizeKey(r As Resolved, keyObj As Object) As KeyResult
            Dim key = HarikitJson.AsObject(keyObj)
            If key Is Nothing Then Return New KeyResult With {.ErrorCode = "key_mismatch", .ErrorMessage = "キーがオブジェクトではありません"}
            Dim output As New Row()
            For Each kv In key
                Dim given = kv.Key
                Dim name = r.Key.Find(Function(x) String.Equals(x, given, StringComparison.OrdinalIgnoreCase))
                If name Is Nothing OrElse output.ContainsKey(name) Then
                    Return New KeyResult With {.ErrorCode = "key_mismatch", .ErrorColumn = given, .ErrorMessage = "キーに列 " & given & " は使えません"}
                End If
                Dim col = r.Meta.Column(name)
                Dim msg = If(kv.Value Is Nothing, "キーが null です", HarikitValues.CheckValue(col, kv.Value, True))
                If msg IsNot Nothing Then Return New KeyResult With {.ErrorCode = "invalid_value", .ErrorColumn = name, .ErrorMessage = msg}
                output(name) = HarikitJson.Normalize(kv.Value)
            Next
            If output.Count <> r.Key.Count Then
                Return New KeyResult With {.ErrorCode = "key_mismatch", .ErrorMessage = "キーの列は " & String.Join(", ", r.Key) & " です"}
            End If
            Return New KeyResult With {.Key = output}
        End Function

        Private Function Fetch(body As IDictionary(Of String, Object)) As Dictionary(Of String, Object)
            Dim r = Resolve(HarikitJson.Get(body, "target"))
            Dim rawKeys = HarikitJson.AsArray(HarikitJson.Get(body, "keys"))
            If rawKeys Is Nothing Then Throw New HarikitFailure("bad_request", "keys がありません")
            If rawKeys.Count > o.Config.MaxFetchKeys Then
                Throw New HarikitFailure("too_many_rows", "keys は " & o.Config.MaxFetchKeys & " 件までです") With {
                    .Details = New Dictionary(Of String, Object) From {{"limit", o.Config.MaxFetchKeys}}
                }
            End If
            Dim columns As New List(Of String)()
            If Not body.ContainsKey("columns") Then
                For Each c In r.Columns
                    columns.Add(c.Name)
                Next
            Else
                Dim raw = HarikitJson.AsArray(body("columns"))
                If raw Is Nothing Then Throw New HarikitFailure("bad_request", "columns は列名の配列です")
                For Each c In raw
                    Dim col = r.Find(TryCast(c, String))
                    If col Is Nothing Then
                        Throw New HarikitFailure("column_not_allowed", "列 " & If(TryCast(c, String), Show(c)) & " は読めません") With {
                            .Details = New Dictionary(Of String, Object) From {{"column", c}}
                        }
                    End If
                    columns.Add(col.Name)
                Next
            End If
            Dim keys As New List(Of Row)()
            For i = 0 To rawKeys.Count - 1
                Dim n = NormalizeKey(r, rawKeys(i))
                If n.ErrorCode IsNot Nothing Then
                    Throw New HarikitFailure(If(n.ErrorCode = "invalid_value", "bad_request", n.ErrorCode), "keys[" & i & "]: " & n.ErrorMessage) With {
                        .Details = New Dictionary(Of String, Object) From {{"index", i}}
                    }
                End If
                keys.Add(n.Key)
            Next
            Dim all As New List(Of String)(r.Key)
            For Each c In columns
                If Not r.Key.Contains(c) Then all.Add(c)
            Next
            Dim rows = If(keys.Count = 0, New List(Of Row)(), o.Dialect.FetchRows(r.Meta, r.Key, all, keys))
            Dim outRows As New List(Of Object)()
            For i = 0 To rows.Count - 1
                Dim item As New Dictionary(Of String, Object) From {{"index", i}, {"found", rows(i) IsNot Nothing}}
                If rows(i) IsNot Nothing Then item("values") = rows(i)
                outRows.Add(item)
            Next
            Dim res = Ok()
            res("target") = r.Name
            res("rows") = outRows
            EnsureFits(res, "fetch の結果が大きすぎて返せません。keys を減らすか、web.config の maxJsonLength を上げてください")
            Return res
        End Function

        Private Sub EnsureFits(result As Dictionary(Of String, Object), message As String)
            If Not o.MaxResponseLength.HasValue Then Return
            ' WebMethod は {"d": 結果} で返す。
            Dim length = HarikitJson.Stringify(New Dictionary(Of String, Object) From {{"d", result}}).Length
            If length <= o.MaxResponseLength.Value Then Return
            Throw New HarikitFailure("too_many_rows", message) With {
                .Details = New Dictionary(Of String, Object) From {{"maxJsonLength", o.MaxResponseLength.Value}, {"length", length}}
            }
        End Sub

        Private Shared Function LocalIso(d As DateTime) As String
            Return d.ToString("yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture)
        End Function

        Private Function Apply(body As IDictionary(Of String, Object)) As Dictionary(Of String, Object)
            Dim requestId = TryCast(HarikitJson.Get(body, "requestId"), String)
            If requestId Is Nothing OrElse Not RequestIdRe.IsMatch(requestId) Then Throw New HarikitFailure("bad_request", "requestId がないか、形が違います")
            Dim mode = TryCast(HarikitJson.Get(body, "mode"), String)
            If mode <> "check" AndAlso mode <> "execute" Then Throw New HarikitFailure("bad_request", "mode は ""check"" か ""execute"" です")
            Dim note As String = Nothing
            If body.ContainsKey("note") Then
                note = TryCast(body("note"), String)
                If note Is Nothing Then Throw New HarikitFailure("bad_request", "note は文字列です")
            End If
            If mode = "execute" Then
                SyncLock sync
                    Dim done As Dictionary(Of String, Object) = Nothing
                    If applied.TryGetValue(requestId, done) Then Return done
                End SyncLock
            End If
            Dim changes = HarikitJson.AsArray(HarikitJson.Get(body, "changes"))
            If changes Is Nothing OrElse changes.Count <> 1 OrElse HarikitJson.AsObject(changes(0)) Is Nothing Then
                Throw New HarikitFailure("bad_request", "changes は要素 1 つの配列です（v1 は 1 テーブルだけ）")
            End If
            Dim change = HarikitJson.AsObject(changes(0))
            Dim r = Resolve(HarikitJson.Get(change, "target"))
            If r.Target.Access <> "update" Then Throw New HarikitFailure("bad_request", r.Name & " は読むだけのターゲットです")
            Dim rawRows = HarikitJson.AsArray(HarikitJson.Get(change, "rows"))
            If rawRows Is Nothing OrElse rawRows.Count = 0 Then Throw New HarikitFailure("bad_request", "rows がありません")
            If rawRows.Count > o.Config.MaxApplyRows Then
                Throw New HarikitFailure("too_many_rows", "rows は " & o.Config.MaxApplyRows & " 行までです") With {
                    .Details = New Dictionary(Of String, Object) From {{"limit", o.Config.MaxApplyRows}}
                }
            End If

            ' 1. 許可リストとの照合。行ごとの誤りはまとめて返す。
            Dim rowErrors As New List(Of Object)()
            Dim rows As New List(Of ApplyRow)()
            Dim rowIndexes As New List(Of Integer)()
            Dim seenKeys As New Dictionary(Of String, Integer)(StringComparer.Ordinal)
            For index = 0 To rawRows.Count - 1
                Dim i = index
                Dim rowErr As Action(Of String, String, String) =
                    Sub(code, message, column)
                        Dim e As New Dictionary(Of String, Object) From {{"target", r.Name}, {"index", i}, {"code", code}}
                        If column IsNot Nothing Then e("column") = column
                        e("message") = message
                        rowErrors.Add(e)
                    End Sub
                Dim raw = HarikitJson.AsObject(rawRows(index))
                If raw Is Nothing Then
                    rowErr("bad_request", "行がオブジェクトではありません", Nothing)
                    Continue For
                End If
                If raw.ContainsKey("op") AndAlso Not "update".Equals(raw("op")) Then
                    rowErr("bad_request", "op " & If(TryCast(raw("op"), String), Show(raw("op"))) & " には対応していません（update だけ）", Nothing)
                    Continue For
                End If
                Dim k = NormalizeKey(r, HarikitJson.Get(raw, "key"))
                If k.ErrorCode IsNot Nothing Then
                    rowErr(k.ErrorCode, k.ErrorMessage, k.ErrorColumn)
                    Continue For
                End If
                Dim rawBefore = HarikitJson.AsObject(HarikitJson.Get(raw, "before"))
                Dim rawAfter = HarikitJson.AsObject(HarikitJson.Get(raw, "after"))
                If rawBefore Is Nothing OrElse rawAfter Is Nothing Then
                    rowErr("bad_request", "before と after がありません", Nothing)
                    Continue For
                End If
                Dim afterNames As New Dictionary(Of String, String)()
                For Each c In rawAfter.Keys
                    afterNames(c.ToLowerInvariant()) = c
                Next
                If afterNames.Count = 0 Then
                    rowErr("bad_request", "更新する列がありません", Nothing)
                    Continue For
                End If
                If rawBefore.Count <> afterNames.Count Then
                    rowErr("bad_request", "before と after の列が違います", Nothing)
                    Continue For
                End If
                Dim before As New Row()
                Dim after As New Row()
                Dim bad = False
                For Each kv In rawBefore
                    Dim col = r.Find(kv.Key)
                    If col Is Nothing OrElse Not r.Updatable.Contains(col.Name) Then
                        rowErr("column_not_allowed", "列 " & kv.Key & " は更新が許可されていません", kv.Key)
                        bad = True
                        Continue For
                    End If
                    Dim ac As String = Nothing
                    If Not afterNames.TryGetValue(kv.Key.ToLowerInvariant(), ac) OrElse before.ContainsKey(col.Name) Then
                        rowErr("bad_request", "before と after の列が違います", col.Name)
                        bad = True
                        Continue For
                    End If
                    Dim bv = kv.Value
                    Dim av = rawAfter(ac)
                    Dim bMsg = HarikitValues.CheckValue(col, bv, True)
                    Dim aMsg = HarikitValues.CheckValue(col, av, col.Nullable)
                    If bMsg IsNot Nothing OrElse aMsg IsNot Nothing Then
                        rowErr("invalid_value", If(bMsg IsNot Nothing, "before: " & bMsg, "after: " & aMsg), col.Name)
                        bad = True
                        Continue For
                    End If
                    bv = HarikitJson.Normalize(bv)
                    av = HarikitJson.Normalize(av)
                    If HarikitValues.SameColumnValue(col, bv, av) Then
                        rowErr("bad_request", "before と after が同じです", col.Name)
                        bad = True
                        Continue For
                    End If
                    before(col.Name) = bv
                    after(col.Name) = av
                Next
                If bad Then Continue For
                Dim id = HarikitValues.KeyIdentity(r.KeyColumns, k.Key)
                Dim seen As Integer
                If seenKeys.TryGetValue(id, seen) Then
                    rowErr("duplicate_key", seen & " 番目の行とキーが同じです", Nothing)
                    Continue For
                End If
                seenKeys(id) = index
                rows.Add(New ApplyRow With {.Key = k.Key, .Before = before, .After = after})
                rowIndexes.Add(index)
            Next
            If rowErrors.Count = 0 Then rowErrors.AddRange(CheckStrings(r, rows, rowIndexes))
            If rowErrors.Count > 0 Then
                Dim indexes As New HashSet(Of Integer)()
                For Each e As Dictionary(Of String, Object) In rowErrors
                    indexes.Add(CInt(e("index")))
                Next
                Throw New HarikitFailure("bad_request", indexes.Count & " 行に誤りがあります") With {.RowErrors = rowErrors}
            End If

            Dim appliedBy = If(o.WhoAmI IsNot Nothing, o.WhoAmI.Invoke(), "")
            Dim appliedAt = LocalIso(If(o.Now IsNot Nothing, o.Now.Invoke(), DateTime.Now))
            Dim logEntry As Func(Of String, Dictionary(Of String, Object)) =
                Function(outcome)
                    Dim entry As New Dictionary(Of String, Object) From {{"requestId", requestId}, {"mode", mode}}
                    If note IsNot Nothing Then entry("note") = note
                    entry("appliedBy") = appliedBy
                    entry("appliedAt") = appliedAt
                    entry("target") = r.Name
                    entry("table") = r.Meta.Table
                    entry("outcome") = outcome
                    Dim list As New List(Of Object)()
                    For Each item In rows
                        list.Add(New Dictionary(Of String, Object) From {{"key", item.Key}, {"before", item.Before}, {"after", item.After}})
                    Next
                    entry("rows") = list
                    Return entry
                End Function

            ' SQL の文面と返す結果は先に作る（コミットした後に失敗して戻し SQL が返らない、を避ける）。
            Dim script As String = Nothing
            Dim undoScript As String = Nothing
            RenderScripts(r, requestId, mode, rows, script, undoScript)
            Dim result = Ok()
            result("requestId") = requestId
            result("mode") = mode
            result("appliedAt") = appliedAt
            result("appliedBy") = appliedBy
            Dim targetResult As New Dictionary(Of String, Object) From {{"target", r.Name}, {"updated", If(mode = "execute", rows.Count, 0)}}
            result("results") = New List(Of Object) From {targetResult}
            result("script") = script
            result("undoScript") = undoScript
            EnsureFits(result, "反映の結果（SQL と戻し SQL）が大きすぎて返せないので、何も反映していません。行を分けるか、web.config の maxJsonLength を上げてください")

            ' 2〜6. トランザクションの中で、ロックを掛けて今の値を確かめてから流す。
            Dim conflicts As New List(Of Object)()
            Dim updated = 0
            Dim duplicate As Integer() = Nothing
            Try
                o.Dialect.RunTransaction(
                    Function(tx)
                        Dim dbKeys As New Dictionary(Of String, Integer)(StringComparer.Ordinal)
                        For index = 0 To rows.Count - 1
                            Dim item = rows(index)
                            Dim locked = tx.LockAndCompare(r.Meta, r.Key, item.Key, item.Before)
                            If Not locked.Found Then
                                conflicts.Add(New Dictionary(Of String, Object) From {{"target", r.Name}, {"index", index}, {"key", item.Key}, {"reason", "not_found"}})
                                Continue For
                            End If
                            Dim dbKey = HarikitValues.KeyIdentity(r.KeyColumns, locked.DbKey)
                            Dim other As Integer
                            If dbKeys.TryGetValue(dbKey, other) Then
                                duplicate = New Integer() {other, index}
                                Return False
                            End If
                            dbKeys(dbKey) = index
                            If locked.Changed IsNot Nothing AndAlso locked.Changed.Count > 0 Then
                                conflicts.Add(New Dictionary(Of String, Object) From {
                                    {"target", r.Name},
                                    {"index", index},
                                    {"key", item.Key},
                                    {"reason", "changed"},
                                    {"columns", locked.Changed},
                                    {"current", locked.Current}
                                })
                            End If
                        Next
                        If conflicts.Count > 0 OrElse mode = "check" Then Return False
                        For Each item In rows
                            Dim n = tx.Update(r.Meta, r.Key, item.Key, item.After)
                            If n <> 1 Then Throw New HarikitDbException("UPDATE の影響行数が " & n & " でした（1 のはず）: " & HarikitJson.Stringify(item.Key))
                            updated += n
                        Next
                        Return True
                    End Function)
            Catch e As Exception
                Dim entry = logEntry("error")
                entry("error") = e.Message
                SafeLog(entry)
                Throw
            End Try

            If duplicate IsNot Nothing Then
                Throw New HarikitFailure("bad_request", "1 行に誤りがあります") With {
                    .RowErrors = New List(Of Object) From {
                        New Dictionary(Of String, Object) From {
                            {"target", r.Name},
                            {"index", duplicate(1)},
                            {"code", "duplicate_key"},
                            {"message", duplicate(0) & " 番目の行と DB 上で同じ行を指しています"}
                        }
                    }
                }
            End If
            If conflicts.Count > 0 Then
                Dim entry = logEntry("conflict")
                entry("conflicts") = conflicts
                SafeLog(entry)
                Throw New HarikitFailure("conflict", conflicts.Count & " 行が差分を取った後に変わっていたため、何も反映していません") With {.Conflicts = conflicts}
            End If

            targetResult("updated") = updated
            If mode = "execute" Then
                SyncLock sync
                    If Not applied.ContainsKey(requestId) Then
                        applied(requestId) = result
                        appliedOrder.Enqueue(requestId)
                        While appliedOrder.Count > AppliedKeep
                            applied.Remove(appliedOrder.Dequeue())
                        End While
                    End If
                End SyncLock
            End If
            ' コミットした後なので、ログが書けなくても結果（戻し SQL）は返す。
            SafeLog(logEntry(If(mode = "execute", "applied", "checked")))
            Return result
        End Function

        ''' <summary>
        ''' 書き込む文字列が列の文字コードで表せるか、バイト数に収まるかを DB で確かめる。
        ''' HarikitValues の確認（.NET の文字コード）は DB のコードページと完全には一致しないので、最後はここで見る。
        ''' </summary>
        Private Function CheckStrings(r As Resolved, rows As List(Of ApplyRow), rowIndexes As List(Of Integer)) As List(Of Object)
            Dim errors As New List(Of Object)()
            Dim items As New List(Of KeyValuePair(Of String, String))()
            Dim itemRows As New List(Of Integer)()
            For i = 0 To rows.Count - 1
                For Each kv In rows(i).After
                    Dim s = TryCast(kv.Value, String)
                    If s Is Nothing OrElse r.Meta.Column(kv.Key).Type <> "string" Then Continue For
                    items.Add(New KeyValuePair(Of String, String)(kv.Key, s))
                    itemRows.Add(rowIndexes(i))
                Next
            Next
            If items.Count = 0 Then Return errors
            Dim results = o.Dialect.CheckStrings(r.Meta, items)
            For i = 0 To items.Count - 1
                Dim res = results(i)
                If res Is Nothing Then Continue For
                Dim col = r.Meta.Column(items(i).Key)
                Dim message As String = Nothing
                If Not res.Encodable Then
                    message = "after: 列の文字コード" & If(col.Encoding IsNot Nothing, "（" & col.Encoding & "）", "") & "で表せない字があります"
                ElseIf col.MaxBytes.HasValue AndAlso res.Bytes > col.MaxBytes.Value Then
                    message = "after: " & col.MaxBytes.Value & " バイトを超えています（" & res.Bytes & " バイト）"
                End If
                If message Is Nothing Then Continue For
                errors.Add(New Dictionary(Of String, Object) From {
                    {"target", r.Name},
                    {"index", itemRows(i)},
                    {"code", "invalid_value"},
                    {"column", col.Name},
                    {"message", message}
                })
            Next
            Return errors
        End Function

        Private Sub SafeLog(entry As Dictionary(Of String, Object))
            If o.Log Is Nothing Then Return
            Try
                o.Log.Invoke(entry)
            Catch e As Exception
                LogError(e)
            End Try
        End Sub

        Private Sub RenderScripts(r As Resolved, requestId As String, mode As String, rows As List(Of ApplyRow), ByRef script As String, ByRef undoScript As String)
            Dim d = o.Dialect
            Dim head = "-- harikit " & requestId & " " & r.Name & " (" & r.Meta.Table & ") " & rows.Count & "行"
            Dim updates As New List(Of ScriptUpdate)()
            Dim undoUpdates As New List(Of ScriptUpdate)()
            For Each item In rows
                updates.Add(New ScriptUpdate With {.Set = item.After, .Key = item.Key, .Expect = item.Before})
                undoUpdates.Add(New ScriptUpdate With {.Set = item.Before, .Key = item.Key, .Expect = item.After})
            Next
            script = d.RenderScript(r.Meta, head & " " & If(mode = "check", "実行予定", "実行済み"), updates, "apply")
            undoScript = d.RenderScript(r.Meta, head & " の戻し", undoUpdates, "undo")
        End Sub

    End Class

End Namespace
