' API 3 本（describe / fetch / apply）の中身。Node 版の handlers.ts、C# 版の PatchiriService.cs と同じ手順で動く。
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

Namespace Global.Patchiri.Server

    ''' <summary>業務上の失敗。HTTP 200 の ok:false で返す（仕様 1.5）。</summary>
    Public Class PatchiriFailure
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

    Public NotInheritable Class PatchiriServiceOptions
        Public Config As PatchiriConfig
        Public Dialect As IPatchiriDialect
        ''' <summary>反映した人。WebForms では PatchiriWebMethods.WhoAmI（既定は HttpContext.Current.User.Identity.Name）。</summary>
        Public WhoAmI As Func(Of String)
        ''' <summary>ロールの判定（許可リストの roles）。Nothing なら、roles を書いたターゲットは誰も使えない（閉じる側に倒す）。</summary>
        Public IsInRole As Func(Of String, Boolean)
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

    Public NotInheritable Class PatchiriService

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
            ''' <summary>列名（DB の綴り）→ 表示名。</summary>
            Public Labels As Dictionary(Of String, String)
            ''' <summary>stamp の列（DB の綴り）と "now" / "user"。</summary>
            Public Stamp As List(Of KeyValuePair(Of ColumnMeta, String))
            ''' <summary>scope（DB の綴り）。</summary>
            Public Scope As Row
            ''' <summary>scope のうちキーでない列。DB で行を探すときはキーに足す。</summary>
            Public ScopeColumns As List(Of String)
            ''' <summary>サーバに置いた業務ルール（rules にこのターゲットが無ければ Nothing）。</summary>
            Public RawRules As Object
            Public Rules As List(Of PatchiriRule)

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
            ''' <summary>stamp の列の、反映する前の値（ロックして読んだもの。stamp を書いたターゲットだけ）。</summary>
            Public StampBefore As Row
        End Class

        Private ReadOnly o As PatchiriServiceOptions
        Private ReadOnly sync As New Object()
        Private ReadOnly metaCache As New Dictionary(Of String, TableMeta)(StringComparer.Ordinal)
        Private ReadOnly applied As New Dictionary(Of String, Dictionary(Of String, Object))(StringComparer.Ordinal)
        Private ReadOnly appliedOrder As New Queue(Of String)()
        ''' <summary>ターゲットごとの、使える形にした業務ルール（テーブル定義の覚えと同じく、設定を読み直すまで持つ）。</summary>
        Private ReadOnly rulesCache As New Dictionary(Of String, List(Of PatchiriRule))(StringComparer.Ordinal)

        Public Sub New(options As PatchiriServiceOptions)
            If options.Config Is Nothing OrElse options.Dialect Is Nothing Then Throw New ArgumentException("Config と Dialect は必須です")
            o = options
        End Sub

        Public Function Handle(name As String, body As Object) As Dictionary(Of String, Object)
            Try
                Dim b = PatchiriJson.AsObject(body)
                If b Is Nothing Then Throw New PatchiriFailure("bad_request", "リクエストが JSON のオブジェクトではありません")
                Dim v = PatchiriJson.Get(b, "v")
                If Not PatchiriJson.IsNumber(v) OrElse PatchiriJson.ToDouble(v) <> 1 Then
                    Throw New PatchiriFailure("version_unsupported", "v=" & Show(v) & " には対応していません（1 だけ）")
                End If
                If name = "describe" Then Return Describe(b)
                If name = "fetch" Then Return Fetch(b)
                If name = "apply" Then Return Apply(b)
                Throw New PatchiriFailure("bad_request", "API " & name & " はありません")
            Catch e As Exception
                Return Failure(e, body)
            End Try
        End Function

        Private Shared Function Show(v As Object) As String
            If v Is Nothing Then Return "null"
            If TypeOf v Is String Then Return PatchiriJson.Stringify(v)
            If TypeOf v Is Boolean Then Return If(DirectCast(v, Boolean), "true", "false")
            If PatchiriJson.IsNumber(v) Then Return PatchiriJson.FormatDouble(PatchiriJson.ToDouble(v))
            Return PatchiriJson.Stringify(v)
        End Function

        Private Shared Function Ok() As Dictionary(Of String, Object)
            Return New Dictionary(Of String, Object) From {{"ok", True}, {"v", 1}}
        End Function

        Private Function Failure(e As Exception, body As Object) As Dictionary(Of String, Object)
            Dim errorInfo As New Dictionary(Of String, Object)()
            Dim f = TryCast(e, PatchiriFailure)
            If f IsNot Nothing Then
                errorInfo("code") = f.Code
                errorInfo("message") = f.Message
                If f.Details IsNot Nothing Then errorInfo("details") = f.Details
            ElseIf TypeOf e Is PatchiriDbException Then
                LogError(e)
                errorInfo("code") = "db_error"
                errorInfo("message") = If(o.Config.ExposeDbErrors, e.Message, If(DirectCast(e, PatchiriDbException).PublicMessage, "DB がエラーを返しました（詳細はサーバのログ）"))
            Else
                LogError(e)
                errorInfo("code") = "internal_error"
                errorInfo("message") = "サーバでエラーが起きました（詳細はサーバのログ）"
            End If
            Dim res As New Dictionary(Of String, Object) From {{"ok", False}, {"v", 1}}
            Dim b = PatchiriJson.AsObject(body)
            Dim requestId = TryCast(PatchiriJson.Get(b, "requestId"), String)
            If requestId IsNot Nothing Then res("requestId") = requestId
            Dim mode = TryCast(PatchiriJson.Get(b, "mode"), String)
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

        ''' <summary>ターゲットを使えるか（roles）。roles を書いていなければ誰でも。判定の手段がなければ使えない。</summary>
        Private Function Allowed(target As TargetConfig) As Boolean
            If target.Roles Is Nothing Then Return True
            If o.IsInRole Is Nothing Then Return False
            For Each role In target.Roles
                If o.IsInRole.Invoke(role) Then Return True
            Next
            Return False
        End Function

        Private Function Resolve(nameObj As Object) As Resolved
            Dim name = TryCast(nameObj, String)
            If name Is Nothing OrElse Not o.Config.Targets.ContainsKey(name) Then
                Throw New PatchiriFailure("unknown_target", "ターゲット " & If(name, Show(nameObj)) & " はありません") With {
                    .Details = New Dictionary(Of String, Object) From {{"target", nameObj}}
                }
            End If
            Dim target = o.Config.Targets(name)
            If Not Allowed(target) Then
                Throw New PatchiriFailure("forbidden", "ターゲット " & name & " を使う権限がありません") With {
                    .Details = New Dictionary(Of String, Object) From {{"target", name}}
                }
            End If
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
            Dim allowedColumns As New HashSet(Of String)(If(target.Access = "update", pick(target.Updatable), New List(Of String)()))
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
                If allowedColumns.Contains(c.Name) AndAlso Not key.Contains(c.Name) AndAlso c.Type <> "other" AndAlso Not c.Identity AndAlso Not c.Computed Then r.Updatable.Add(c.Name)
            Next
            r.Labels = New Dictionary(Of String, String)()
            For Each kv In target.Labels
                r.Labels(pick(New List(Of String) From {kv.Key})(0)) = kv.Value
            Next
            r.Stamp = New List(Of KeyValuePair(Of ColumnMeta, String))()
            For Each kv In target.Stamp
                Dim col As ColumnMeta = Nothing
                If Not dbCols.TryGetValue(kv.Key.ToLowerInvariant(), col) Then
                    Throw New InvalidOperationException("許可リストの列 " & name & ".stamp." & kv.Key & " が " & meta.Table & " にありません")
                End If
                If key.Contains(col.Name) Then Throw New InvalidOperationException(name & " のキー列 " & col.Name & " は stamp にできません")
                If col.Identity OrElse col.Computed Then Throw New InvalidOperationException(name & ".stamp の " & col.Name & " は自動で入る列（IDENTITY や計算列）です")
                If kv.Value = "now" AndAlso o.Dialect.NowExpression(col) Is Nothing Then
                    Throw New InvalidOperationException(name & ".stamp の " & col.Name & " は日付・時刻の列ではありません（""now"" は日付・時刻の列だけ）")
                End If
                If kv.Value = "user" AndAlso col.Type <> "string" Then
                    Throw New InvalidOperationException(name & ".stamp の " & col.Name & " は文字列の列ではありません（""user"" は文字列の列だけ）")
                End If
                r.Stamp.Add(New KeyValuePair(Of ColumnMeta, String)(col, kv.Value))
            Next
            r.Scope = New Row()
            r.ScopeColumns = New List(Of String)()
            For Each kv In target.Scope
                Dim col As ColumnMeta = Nothing
                If Not dbCols.TryGetValue(kv.Key.ToLowerInvariant(), col) Then
                    Throw New InvalidOperationException("許可リストの列 " & name & ".scope." & kv.Key & " が " & meta.Table & " にありません")
                End If
                Dim msg = PatchiriValues.CheckValue(col, kv.Value, False)
                If msg IsNot Nothing Then Throw New InvalidOperationException(name & ".scope." & col.Name & " の値が列に合いません（" & msg & "）")
                r.Scope(col.Name) = kv.Value
                If Not key.Contains(col.Name) Then r.ScopeColumns.Add(col.Name)
            Next
            If o.Config.Rules IsNot Nothing AndAlso o.Config.Rules.ContainsKey(name) Then
                r.RawRules = o.Config.Rules(name)
                SyncLock sync
                    Dim cached As List(Of PatchiriRule) = Nothing
                    If rulesCache.TryGetValue(name, cached) Then r.Rules = cached
                End SyncLock
                If r.Rules Is Nothing Then
                    Dim errors As New List(Of String)()
                    Dim compiled = PatchiriRules.Compile(name, r.Columns, r.RawRules, "サーバの業務ルール", errors)
                    If errors.Count > 0 Then Throw New InvalidOperationException("rules.targets." & name & " の誤り: " & String.Join(" / ", errors))
                    SyncLock sync
                        rulesCache(name) = compiled
                    End SyncLock
                    r.Rules = compiled
                End If
            End If
            Return r
        End Function

        ''' <summary>キーが scope の中か（scope に書いたキー列は、その値と厳密に同じでなければ外）。</summary>
        Private Shared Function InScope(r As Resolved, key As Row) As Boolean
            For Each k In r.Key
                If Not r.Scope.ContainsKey(k) Then Continue For
                If Not PatchiriValues.SameColumnValue(r.Meta.Column(k), key(k), r.Scope(k)) Then Return False
            Next
            Return True
        End Function

        ''' <summary>DB で行を探すときのキーの列（キーに scope の列を足したもの）。</summary>
        Private Shared Function DbKeyColumns(r As Resolved) As List(Of String)
            Dim list As New List(Of String)(r.Key)
            list.AddRange(r.ScopeColumns)
            Return list
        End Function

        ''' <summary>DB で行を探すときのキー（scope の値を足したもの）。</summary>
        Private Shared Function DbKey(r As Resolved, key As Row) As Row
            Dim output As New Row(key)
            For Each c In r.ScopeColumns
                output(c) = r.Scope(c)
            Next
            Return output
        End Function

        Private Function Limits() As Dictionary(Of String, Object)
            Return New Dictionary(Of String, Object) From {{"maxFetchKeys", o.Config.MaxFetchKeys}, {"maxApplyRows", o.Config.MaxApplyRows}}
        End Function

        Private Function Describe(body As IDictionary(Of String, Object)) As Dictionary(Of String, Object)
            If Not body.ContainsKey("target") Then
                Dim targets As New List(Of Object)()
                For Each targetName In o.Config.TargetNames
                    Dim t = o.Config.Targets(targetName)
                    ' 使えないターゲットは一覧に出さない（roles）。
                    If Not Allowed(t) Then Continue For
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
                If c.EmptyIsNull Then col("emptyIsNull") = True
                If c.Precision.HasValue Then col("precision") = c.Precision.Value
                If c.Scale.HasValue Then col("scale") = c.Scale.Value
                If c.Identity Then col("identity") = True
                If c.Computed Then col("computed") = True
                If c.HasDefault Then col("hasDefault") = True
                Dim label As String = Nothing
                If r.Labels.TryGetValue(c.Name, label) Then col("label") = label
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
            res("table") = r.Meta.Table
            res("access") = r.Target.Access
            res("dialect") = o.Dialect.Name
            res("key") = New List(Of String)(r.Key)
            res("columns") = columns
            res("foreignKeys") = foreignKeys
            res("limits") = Limits()
            If r.RawRules IsNot Nothing Then res("rules") = r.RawRules
            If r.Stamp.Count > 0 Then
                Dim stamp As New List(Of Object)()
                For Each kv In r.Stamp
                    stamp.Add(New Dictionary(Of String, Object) From {{"column", kv.Key.Name}, {"value", kv.Value}})
                Next
                res("stamp") = stamp
            End If
            If r.Scope.Count > 0 Then
                Dim scope As New Dictionary(Of String, Object)()
                For Each kv In r.Scope
                    scope(kv.Key) = If(TypeOf kv.Value Is Double, PatchiriJson.JsonNumber(DirectCast(kv.Value, Double)), kv.Value)
                Next
                res("scope") = scope
            End If
            Return res
        End Function

        ''' <summary>
        ''' 参照先テーブルを、キーがちょうど参照先の列になっている読めるターゲットから探す。
        ''' テーブルは DB で引いた名前で比べる（Oracle のシノニムや既定のスキーマで書いたターゲットも当たるように）。
        ''' </summary>
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
                    ' 使えないターゲット（roles）も「確認できない」扱いになる。
                    Dim r = Resolve(targetName)
                    If Not String.Equals(o.Dialect.NormalizeTable(r.Meta.Table), want, StringComparison.Ordinal) Then Continue For
                    If r.Key.Count = cols.Count AndAlso r.Key.TrueForAll(Function(k) cols.Contains(k.ToLowerInvariant())) Then Return targetName
                Catch e As Exception
                    ' 参照先の設定がおかしいときは「確認できない」扱いにする。
                End Try
            Next
            Return Nothing
        End Function

        ''' <summary>キーのオブジェクトを確かめ、列名を DB の綴りにそろえる。</summary>
        Private Shared Function NormalizeKey(r As Resolved, keyObj As Object) As KeyResult
            Dim key = PatchiriJson.AsObject(keyObj)
            If key Is Nothing Then Return New KeyResult With {.ErrorCode = "key_mismatch", .ErrorMessage = "キーがオブジェクトではありません"}
            Dim output As New Row()
            For Each kv In key
                Dim given = kv.Key
                Dim name = r.Key.Find(Function(x) String.Equals(x, given, StringComparison.OrdinalIgnoreCase))
                If name Is Nothing OrElse output.ContainsKey(name) Then
                    Return New KeyResult With {.ErrorCode = "key_mismatch", .ErrorColumn = given, .ErrorMessage = "キーに列 " & given & " は使えません"}
                End If
                Dim col = r.Meta.Column(name)
                Dim msg = If(kv.Value Is Nothing, "キーが null です", PatchiriValues.CheckValue(col, kv.Value, True))
                If msg IsNot Nothing Then Return New KeyResult With {.ErrorCode = "invalid_value", .ErrorColumn = name, .ErrorMessage = msg}
                output(name) = PatchiriJson.Normalize(kv.Value)
            Next
            If output.Count <> r.Key.Count Then
                Return New KeyResult With {.ErrorCode = "key_mismatch", .ErrorMessage = "キーの列は " & String.Join(", ", r.Key) & " です"}
            End If
            Return New KeyResult With {.Key = output}
        End Function

        Private Function Fetch(body As IDictionary(Of String, Object)) As Dictionary(Of String, Object)
            Dim r = Resolve(PatchiriJson.Get(body, "target"))
            Dim rawKeys = PatchiriJson.AsArray(PatchiriJson.Get(body, "keys"))
            If rawKeys Is Nothing Then Throw New PatchiriFailure("bad_request", "keys がありません")
            If rawKeys.Count > o.Config.MaxFetchKeys Then
                Throw New PatchiriFailure("too_many_rows", "keys は " & o.Config.MaxFetchKeys & " 件までです") With {
                    .Details = New Dictionary(Of String, Object) From {{"limit", o.Config.MaxFetchKeys}}
                }
            End If
            Dim columns As New List(Of String)()
            If Not body.ContainsKey("columns") Then
                For Each c In r.Columns
                    columns.Add(c.Name)
                Next
            Else
                Dim raw = PatchiriJson.AsArray(body("columns"))
                If raw Is Nothing Then Throw New PatchiriFailure("bad_request", "columns は列名の配列です")
                For Each c In raw
                    Dim col = r.Find(TryCast(c, String))
                    If col Is Nothing Then
                        Throw New PatchiriFailure("column_not_allowed", "列 " & If(TryCast(c, String), Show(c)) & " は読めません") With {
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
                    Throw New PatchiriFailure(If(n.ErrorCode = "invalid_value", "bad_request", n.ErrorCode), "keys[" & i & "]: " & n.ErrorMessage) With {
                        .Details = New Dictionary(Of String, Object) From {{"index", i}}
                    }
                End If
                keys.Add(n.Key)
            Next
            Dim all As New List(Of String)(r.Key)
            For Each c In columns
                If Not r.Key.Contains(c) Then all.Add(c)
            Next
            ' scope の外のキーは DB に聞かずに「見つからない」。値にはキーと頼んだ列だけを返す（scope の列は出さない）。
            Dim asked As New List(Of Integer)()
            Dim askedKeys As New List(Of Row)()
            For i = 0 To keys.Count - 1
                If Not InScope(r, keys(i)) Then Continue For
                asked.Add(i)
                askedKeys.Add(DbKey(r, keys(i)))
            Next
            Dim found = If(askedKeys.Count = 0, New List(Of Row)(), o.Dialect.FetchRows(r.Meta, DbKeyColumns(r), all, askedKeys))
            Dim rows As New List(Of Row)()
            For i = 0 To keys.Count - 1
                rows.Add(Nothing)
            Next
            For j = 0 To asked.Count - 1
                If found(j) Is Nothing Then Continue For
                Dim values As New Row()
                For Each c In all
                    Dim v As Object = Nothing
                    found(j).TryGetValue(c, v)
                    values(c) = v
                Next
                rows(asked(j)) = values
            Next
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

        Private Const ApplyTooLarge As String = "反映の結果（SQL と戻し SQL）が大きすぎて返せないので、何も反映していません。行を分けるか、web.config の maxJsonLength を上げてください"

        ''' <summary>WebMethod で返せる長さか（WebMethod は {"d": 結果} で返す）。</summary>
        Private Shared Function ResponseLength(result As Dictionary(Of String, Object)) As Integer
            Return PatchiriJson.Stringify(New Dictionary(Of String, Object) From {{"d", result}}).Length
        End Function

        Private Function Fits(result As Dictionary(Of String, Object)) As Boolean
            Return Not o.MaxResponseLength.HasValue OrElse ResponseLength(result) <= o.MaxResponseLength.Value
        End Function

        Private Sub EnsureFits(result As Dictionary(Of String, Object), message As String)
            If Not o.MaxResponseLength.HasValue Then Return
            Dim length = ResponseLength(result)
            If length <= o.MaxResponseLength.Value Then Return
            Throw New PatchiriFailure("too_many_rows", message) With {
                .Details = New Dictionary(Of String, Object) From {{"maxJsonLength", o.MaxResponseLength.Value}, {"length", length}}
            }
        End Sub

        Private Shared Function LocalIso(d As DateTime) As String
            Return d.ToString("yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture)
        End Function

        Private Function Apply(body As IDictionary(Of String, Object)) As Dictionary(Of String, Object)
            Dim requestId = TryCast(PatchiriJson.Get(body, "requestId"), String)
            If requestId Is Nothing OrElse Not RequestIdRe.IsMatch(requestId) Then Throw New PatchiriFailure("bad_request", "requestId がないか、形が違います")
            Dim mode = TryCast(PatchiriJson.Get(body, "mode"), String)
            If mode <> "check" AndAlso mode <> "execute" Then Throw New PatchiriFailure("bad_request", "mode は ""check"" か ""execute"" です")
            Dim note As String = Nothing
            If body.ContainsKey("note") Then
                note = TryCast(body("note"), String)
                If note Is Nothing Then Throw New PatchiriFailure("bad_request", "note は文字列です")
            End If
            If mode = "execute" Then
                SyncLock sync
                    Dim done As Dictionary(Of String, Object) = Nothing
                    If applied.TryGetValue(requestId, done) Then Return done
                End SyncLock
            End If
            Dim changes = PatchiriJson.AsArray(PatchiriJson.Get(body, "changes"))
            If changes Is Nothing OrElse changes.Count <> 1 OrElse PatchiriJson.AsObject(changes(0)) Is Nothing Then
                Throw New PatchiriFailure("bad_request", "changes は要素 1 つの配列です（v1 は 1 テーブルだけ）")
            End If
            Dim change = PatchiriJson.AsObject(changes(0))
            Dim r = Resolve(PatchiriJson.Get(change, "target"))
            If r.Target.Access <> "update" Then Throw New PatchiriFailure("bad_request", r.Name & " は読むだけのターゲットです")
            Dim rawRows = PatchiriJson.AsArray(PatchiriJson.Get(change, "rows"))
            If rawRows Is Nothing OrElse rawRows.Count = 0 Then Throw New PatchiriFailure("bad_request", "rows がありません")
            If rawRows.Count > o.Config.MaxApplyRows Then
                Throw New PatchiriFailure("too_many_rows", "rows は " & o.Config.MaxApplyRows & " 行までです") With {
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
                Dim raw = PatchiriJson.AsObject(rawRows(index))
                If raw Is Nothing Then
                    rowErr("bad_request", "行がオブジェクトではありません", Nothing)
                    Continue For
                End If
                If raw.ContainsKey("op") AndAlso Not "update".Equals(raw("op")) Then
                    rowErr("bad_request", "op " & If(TryCast(raw("op"), String), Show(raw("op"))) & " には対応していません（update だけ）", Nothing)
                    Continue For
                End If
                Dim k = NormalizeKey(r, PatchiriJson.Get(raw, "key"))
                If k.ErrorCode IsNot Nothing Then
                    rowErr(k.ErrorCode, k.ErrorMessage, k.ErrorColumn)
                    Continue For
                End If
                Dim rawBefore = PatchiriJson.AsObject(PatchiriJson.Get(raw, "before"))
                Dim rawAfter = PatchiriJson.AsObject(PatchiriJson.Get(raw, "after"))
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
                    Dim bMsg = PatchiriValues.CheckValue(col, bv, True)
                    Dim aMsg = PatchiriValues.CheckValue(col, av, col.Nullable)
                    If bMsg IsNot Nothing OrElse aMsg IsNot Nothing Then
                        rowErr("invalid_value", If(bMsg IsNot Nothing, "before: " & bMsg, "after: " & aMsg), col.Name)
                        bad = True
                        Continue For
                    End If
                    bv = PatchiriJson.Normalize(bv)
                    av = PatchiriJson.Normalize(av)
                    If PatchiriValues.SameColumnValue(col, bv, av) Then
                        rowErr("bad_request", "before と after が同じです", col.Name)
                        bad = True
                        Continue For
                    End If
                    before(col.Name) = bv
                    after(col.Name) = av
                Next
                If bad Then Continue For
                Dim id = PatchiriValues.KeyIdentity(r.KeyColumns, k.Key)
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
                Throw New PatchiriFailure("bad_request", indexes.Count & " 行に誤りがあります") With {.RowErrors = rowErrors}
            End If

            Dim appliedBy = If(o.WhoAmI IsNot Nothing, o.WhoAmI.Invoke(), "")
            CheckStampUser(r, appliedBy)
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
                        Dim logRow As New Dictionary(Of String, Object) From {{"key", item.Key}, {"before", item.Before}, {"after", item.After}}
                        If item.StampBefore IsNot Nothing Then logRow("stampBefore") = item.StampBefore
                        list.Add(logRow)
                    Next
                    entry("rows") = list
                    Return entry
                End Function

            ' 反映する SQL の文面は先に作る。戻し SQL は stamp の列の今の値を使うので、ロックして読んだ後（コミットの前）に作る。
            Dim script = RenderApplyScript(r, requestId, mode, rows, appliedBy)
            Dim result = Ok()
            result("requestId") = requestId
            result("mode") = mode
            result("appliedAt") = appliedAt
            result("appliedBy") = appliedBy
            Dim targetResult As New Dictionary(Of String, Object) From {{"target", r.Name}, {"updated", If(mode = "execute", rows.Count, 0)}}
            result("results") = New List(Of Object) From {targetResult}
            result("script") = script
            ' 返せない大きさなら、DB に触る前に止める（コミットした後に戻し SQL が返らない、を避ける）。
            ' stamp があれば戻し SQL はロックして読んだ値で作り直し、もう一度確かめる。
            result("undoScript") = RenderUndoScript(r, requestId, rows)
            EnsureFits(result, ApplyTooLarge)
            Dim userStamp As New Row()
            Dim nowStamp As New List(Of String)()
            For Each kv In r.Stamp
                If kv.Value = "user" Then
                    userStamp(kv.Key.Name) = appliedBy
                Else
                    nowStamp.Add(kv.Key.Name)
                End If
            Next
            ' ロックした行から読む列: stamp の列（戻し SQL のため）と、サーバの業務ルールが見るほかの列。
            Dim dbKeyCols = DbKeyColumns(r)
            Dim readBase As New List(Of String)()
            For Each kv In r.Stamp
                If Not readBase.Contains(kv.Key.Name) Then readBase.Add(kv.Key.Name)
            Next
            For Each rule In ErrorRules(r)
                For Each c In rule.Columns
                    If Not readBase.Contains(c) Then readBase.Add(c)
                Next
            Next

            ' 2〜6. トランザクションの中で、ロックを掛けて今の値を確かめてから流す。
            Dim conflicts As New List(Of Object)()
            Dim ruleErrors As List(Of Object) = Nothing
            Dim tooLarge = False
            Dim updated = 0
            Dim duplicate As Integer() = Nothing
            Try
                o.Dialect.RunTransaction(
                    Function(tx)
                        Dim dbKeys As New Dictionary(Of String, Integer)(StringComparer.Ordinal)
                        Dim readValues As New List(Of Row)()
                        For index = 0 To rows.Count - 1
                            Dim item = rows(index)
                            If Not InScope(r, item.Key) Then
                                conflicts.Add(New Dictionary(Of String, Object) From {{"target", r.Name}, {"index", index}, {"key", item.Key}, {"reason", "not_found"}})
                                readValues.Add(New Row())
                                Continue For
                            End If
                            Dim read As New List(Of String)()
                            For Each c In readBase
                                If Not dbKeyCols.Contains(c) AndAlso Not item.Before.ContainsKey(c) Then read.Add(c)
                            Next
                            Dim locked = tx.LockAndCompare(r.Meta, dbKeyCols, DbKey(r, item.Key), item.Before, read)
                            readValues.Add(If(locked.Read, New Row()))
                            If Not locked.Found Then
                                conflicts.Add(New Dictionary(Of String, Object) From {{"target", r.Name}, {"index", index}, {"key", item.Key}, {"reason", "not_found"}})
                                Continue For
                            End If
                            Dim dbKeyId = PatchiriValues.KeyIdentity(r.KeyColumns, locked.DbKey)
                            Dim other As Integer
                            If dbKeys.TryGetValue(dbKeyId, other) Then
                                duplicate = New Integer() {other, index}
                                Return False
                            End If
                            dbKeys(dbKeyId) = index
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
                        If conflicts.Count > 0 Then Return False
                        Dim broken = CheckServerRules(r, rows, readValues)
                        If broken.Count > 0 Then
                            ruleErrors = broken
                            Return False
                        End If
                        If r.Stamp.Count > 0 Then
                            For i = 0 To rows.Count - 1
                                Dim stampBefore As New Row()
                                For Each kv In r.Stamp
                                    Dim v As Object = Nothing
                                    readValues(i).TryGetValue(kv.Key.Name, v)
                                    stampBefore(kv.Key.Name) = v
                                Next
                                rows(i).StampBefore = stampBefore
                            Next
                            result("undoScript") = RenderUndoScript(r, requestId, rows)
                            If Not Fits(result) Then
                                tooLarge = True
                                Return False
                            End If
                        End If
                        If mode = "check" Then Return False
                        For Each item In rows
                            Dim values As New Row(item.After)
                            For Each kv In userStamp
                                values(kv.Key) = kv.Value
                            Next
                            Dim n = tx.Update(r.Meta, dbKeyCols, DbKey(r, item.Key), values, nowStamp)
                            If n <> 1 Then Throw New PatchiriDbException("UPDATE の影響行数が " & n & " でした（1 のはず）: " & PatchiriJson.Stringify(item.Key))
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
                Throw New PatchiriFailure("bad_request", "1 行に誤りがあります") With {
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
            If ruleErrors IsNot Nothing Then
                Dim indexes As New HashSet(Of Integer)()
                For Each e As Dictionary(Of String, Object) In ruleErrors
                    indexes.Add(CInt(e("index")))
                Next
                Throw New PatchiriFailure("bad_request", indexes.Count & " 行がサーバの業務ルールに合いません") With {.RowErrors = ruleErrors}
            End If
            If conflicts.Count > 0 Then
                Dim entry = logEntry("conflict")
                entry("conflicts") = conflicts
                SafeLog(entry)
                Throw New PatchiriFailure("conflict", conflicts.Count & " 行が差分を取った後に変わっていたため、何も反映していません") With {.Conflicts = conflicts}
            End If

            If tooLarge Then EnsureFits(result, ApplyTooLarge)
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
        ''' PatchiriValues の確認（.NET の文字コード）は DB のコードページと完全には一致しないので、最後はここで見る。
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

        ''' <summary>サーバの業務ルールのうち error のもの。</summary>
        Private Shared Function ErrorRules(r As Resolved) As List(Of PatchiriRule)
            Dim list As New List(Of PatchiriRule)()
            If r.Rules Is Nothing Then Return list
            For Each rule In r.Rules
                If rule.Severity = "error" Then list.Add(rule)
            Next
            Return list
        End Function

        ''' <summary>stamp の "user" の列に、反映した人の名前が入るか。入らなければ DB に触る前に止める。</summary>
        Private Sub CheckStampUser(r As Resolved, user As String)
            For Each kv In r.Stamp
                If kv.Value <> "user" Then Continue For
                Dim col = kv.Key
                Dim bad = PatchiriValues.CheckValue(col, user, False)
                If bad Is Nothing Then
                    Dim res = o.Dialect.CheckStrings(r.Meta, New List(Of KeyValuePair(Of String, String)) From {New KeyValuePair(Of String, String)(col.Name, user)})(0)
                    If res IsNot Nothing AndAlso Not res.Encodable Then
                        bad = "列の文字コードで表せない字があります"
                    ElseIf res IsNot Nothing AndAlso col.MaxBytes.HasValue AndAlso res.Bytes > col.MaxBytes.Value Then
                        bad = col.MaxBytes.Value & " バイトを超えています（" & res.Bytes & " バイト）"
                    End If
                End If
                If bad IsNot Nothing Then
                    Throw New PatchiriFailure("bad_request", "反映した人の名前（" & user & "）が stamp の列 " & col.Name & " に入りません（" & bad & "）") With {
                        .Details = New Dictionary(Of String, Object) From {{"column", col.Name}}
                    }
                End If
            Next
        End Sub

        ''' <summary>
        ''' サーバに置いた業務ルールのうち error のものを、反映した後の行（ロックして読んだ値に after を重ねたもの）で見る。
        ''' 行が変える列にかかわるルールだけを見る（変えない列のルールは見ない）。
        ''' </summary>
        Private Function CheckServerRules(r As Resolved, rows As List(Of ApplyRow), readValues As List(Of Row)) As List(Of Object)
            Dim errors As New List(Of Object)()
            Dim rules = ErrorRules(r)
            If rules.Count = 0 Then Return errors
            For i = 0 To rows.Count - 1
                Dim item = rows(i)
                Dim merged As New Row(readValues(i))
                For Each kv In r.Scope
                    merged(kv.Key) = kv.Value
                Next
                For Each kv In item.Key
                    merged(kv.Key) = kv.Value
                Next
                For Each kv In item.After
                    merged(kv.Key) = kv.Value
                Next
                For Each rule In rules
                    Dim touched As String = Nothing
                    For Each c In rule.Columns
                        If item.After.ContainsKey(c) Then
                            touched = c
                            Exit For
                        End If
                    Next
                    If touched Is Nothing Then Continue For
                    Dim changesColumn = item.After.ContainsKey(rule.Column)
                    Dim column = If(changesColumn, rule.Column, touched)
                    Dim v As Object = Nothing
                    merged.TryGetValue(rule.Column, v)
                    Dim broken = PatchiriRules.Check(rule, v, merged)
                    If broken Is Nothing AndAlso changesColumn Then broken = PatchiriRules.CheckChange(rule, item.Before(rule.Column), item.After(rule.Column), merged)
                    If broken Is Nothing Then Continue For
                    errors.Add(New Dictionary(Of String, Object) From {
                        {"target", r.Name},
                        {"index", i},
                        {"code", "rule_violation"},
                        {"column", column},
                        {"message", PatchiriRules.MessageAt(rule, broken, column, merged)}
                    })
                Next
            Next
            Return errors
        End Function

        Private Shared Function ScriptHead(r As Resolved, requestId As String, rows As List(Of ApplyRow)) As String
            Return "-- patchiri " & requestId & " " & r.Name & " (" & r.Meta.Table & ") " & rows.Count & "行"
        End Function

        Private Function RenderApplyScript(r As Resolved, requestId As String, mode As String, rows As List(Of ApplyRow), user As String) As String
            Dim now As New List(Of String)()
            For Each kv In r.Stamp
                If kv.Value = "now" Then now.Add(kv.Key.Name)
            Next
            Dim updates As New List(Of ScriptUpdate)()
            For Each item In rows
                Dim values As New Row(item.After)
                For Each kv In r.Stamp
                    If kv.Value = "user" Then values(kv.Key.Name) = user
                Next
                updates.Add(New ScriptUpdate With {.Set = values, .Key = DbKey(r, item.Key), .Expect = item.Before, .Now = If(now.Count > 0, now, Nothing)})
            Next
            Return o.Dialect.RenderScript(r.Meta, ScriptHead(r, requestId, rows) & " " & If(mode = "check", "実行予定", "実行済み"), updates, "apply")
        End Function

        ''' <summary>戻し SQL。stamp の列は反映する前の値（ロックして読んだ値）に戻す。戻す条件はデータの列が after のままか。</summary>
        Private Function RenderUndoScript(r As Resolved, requestId As String, rows As List(Of ApplyRow)) As String
            Dim updates As New List(Of ScriptUpdate)()
            For Each item In rows
                Dim values As New Row(item.Before)
                If item.StampBefore IsNot Nothing Then
                    For Each kv In item.StampBefore
                        values(kv.Key) = kv.Value
                    Next
                End If
                updates.Add(New ScriptUpdate With {.Set = values, .Key = DbKey(r, item.Key), .Expect = item.After})
            Next
            Return o.Dialect.RenderScript(r.Meta, ScriptHead(r, requestId, rows) & " の戻し", updates, "undo")
        End Function

    End Class

End Namespace
