' サーバの設定（許可リスト、上限、ログ）。仕様 2 の許可リストを含む。
' 形は Node 版の patchiri.config.json と同じ（targets と limits はそのまま写せる）。
' 接続文字列は設定ファイルに書かず、web.config の connectionStrings を名前で指す。

Option Strict On
Option Explicit On
Option Infer On
Option Compare Binary

Imports System
Imports System.Collections.Generic
Imports System.IO
Imports System.Text
Imports System.Text.RegularExpressions

Namespace Global.Patchiri.Server

    Public NotInheritable Class TargetConfig
        Public Table As String
        ''' <summary>"update" か "read"。</summary>
        Public Access As String
        ''' <summary>省くと（Nothing）DB の主キー。</summary>
        Public Key As List(Of String)
        Public Readable As New List(Of String)()
        Public Updatable As New List(Of String)()
        ''' <summary>列の表示名（列名 → 表示名）。取込の見出しは列名でもこれでもよい。</summary>
        Public Labels As New Dictionary(Of String, String)()
        ''' <summary>反映する行ごとにサーバが入れる列（列名 → "now" か "user"）。書いた順。</summary>
        Public Stamp As New List(Of KeyValuePair(Of String, String))()
        ''' <summary>このターゲットで触れる行の固定の条件（列名 → 値。等号だけ）。外の行は見えない。</summary>
        Public Scope As New Dictionary(Of String, Object)()
        ''' <summary>このターゲットを使えるロール（どれか 1 つ）。Nothing なら誰でも。</summary>
        Public Roles As List(Of String)
    End Class

    Public Class PatchiriConfigException
        Inherits Exception

        Public Sub New(message As String)
            MyBase.New("設定の誤り: " & message)
        End Sub
    End Class

    ''' <summary>同梱の画面の設定（設定ファイルの screen。Node 版と同じ）。</summary>
    Public NotInheritable Class ScreenSettings
        ''' <summary>見出しとブラウザのタブの名前。Nothing なら「patchiri」。</summary>
        Public Title As String
        ''' <summary>"light" か "dark"。Nothing なら OS の設定に合わせる。</summary>
        Public Theme As String
        ''' <summary>メモを必須にするなら "true" か欄の名前。Nothing なら任意。</summary>
        Public NoteRequired As String
        ''' <summary>「Excel を開く」を出すか。既定は出す。</summary>
        Public Excel As Boolean = True
        ''' <summary>画面に足す CSS のファイル（フルパス）。Nothing なら足さない。</summary>
        Public CssPath As String
    End Class

    Public NotInheritable Class PatchiriConfig

        Private Shared ReadOnly TargetNameRe As New Regex("\A[A-Za-z0-9_-]+\z")

        ''' <summary>書いた順のターゲット名。</summary>
        Public TargetNames As New List(Of String)()
        Public Targets As New Dictionary(Of String, TargetConfig)(StringComparer.Ordinal)
        Public MaxFetchKeys As Integer = 1000
        Public MaxApplyRows As Integer = 5000
        ''' <summary>web.config の connectionStrings の名前。既定は "Patchiri"。</summary>
        Public ConnectionStringName As String = "Patchiri"
        ''' <summary>反映ログ（JSON Lines）を置くフォルダ。既定は ~/App_Data/patchiri-log。</summary>
        Public LogDir As String = "~/App_Data/patchiri-log"
        ''' <summary>db_error の message に DB の生のエラー文を出すか。既定は出さない。</summary>
        Public ExposeDbErrors As Boolean
        ''' <summary>反映で行のロックを待つ秒数（仕様 7 の手順 3）。既定は 10 秒。最上位にも database の中にも書ける。</summary>
        Public LockWaitSeconds As Integer = 10
        ''' <summary>サーバに置く業務ルール（ターゲット名 → ルールの配列）。rules を書いていなければ Nothing。</summary>
        Public Rules As Dictionary(Of String, Object)
        ''' <summary>rules をファイルで書いたときの、そのファイルのパス（書き直したら読み直すため）。</summary>
        Public RulesPath As String
        ''' <summary>rules のファイルの、読む前の更新日時（UTC）。</summary>
        Public RulesStamp As DateTime
        ''' <summary>同梱の画面の設定。screen を書いていなければ Nothing。</summary>
        Public Screen As ScreenSettings

        Private Shared Sub Fail(message As String)
            Throw New PatchiriConfigException(message)
        End Sub

        Private Shared Function Names(x As Object, what As String) As List(Of String)
            Dim list = PatchiriJson.AsArray(x)
            If list Is Nothing Then Fail(what & " は列名の配列です")
            Dim result As New List(Of String)()
            For Each item In list
                Dim s = TryCast(item, String)
                If String.IsNullOrEmpty(s) Then Fail(what & " は列名の配列です")
                result.Add(s)
            Next
            Return result
        End Function

        Private Shared Function ContainsIgnoreCase(list As IEnumerable(Of String), name As String) As Boolean
            For Each s In list
                If String.Equals(s, name, StringComparison.OrdinalIgnoreCase) Then Return True
            Next
            Return False
        End Function

        Private Shared Function PositiveInt(x As Object, what As String) As Integer
            If Not PatchiriJson.IsNumber(x) Then Fail(what & " は正の整数です")
            Dim d = PatchiriJson.ToDouble(x)
            If d < 1 OrElse d > Integer.MaxValue OrElse Math.Floor(d) <> d Then Fail(what & " は正の整数です")
            Return CInt(d)
        End Function

        ''' <summary>設定の JSON を読み、形を確かめる。おかしければ PatchiriConfigException。rules をファイルで書くなら Load を使う。</summary>
        Public Shared Function Parse(json As String) As PatchiriConfig
            Return Parse(json, Nothing)
        End Function

        ''' <summary>設定ファイルを読む。rules にファイルのパスを書いたら、設定ファイルのフォルダから読む。</summary>
        Public Shared Function Load(path As String) As PatchiriConfig
            Return Parse(File.ReadAllText(path, Encoding.UTF8), IO.Path.GetDirectoryName(IO.Path.GetFullPath(path)))
        End Function

        Private Shared Function ReadRulesFile(baseDir As String, rel As String, ByRef full As String, ByRef stamp As DateTime) As Object
            full = IO.Path.GetFullPath(IO.Path.Combine(baseDir, rel))
            Dim text As String
            Try
                stamp = File.GetLastWriteTimeUtc(full)
                text = File.ReadAllText(full, Encoding.UTF8)
            Catch e As Exception
                Throw New PatchiriConfigException("rules のファイル " & full & " が読めません（" & e.Message & "）")
            End Try
            Try
                Return PatchiriJson.Parse(text)
            Catch e As Exception
                Throw New PatchiriConfigException("rules のファイル " & full & " が JSON として読めません（" & e.Message & "）")
            End Try
        End Function

        Private Shared Sub ParseTargetExtras(name As String, t As IDictionary(Of String, Object), target As TargetConfig)
            If t.ContainsKey("labels") Then
                Dim labels = PatchiriJson.AsObject(t("labels"))
                If labels Is Nothing Then Fail(name & ".labels は { ""列名"": ""表示名"" } の形です")
                Dim seen As New Dictionary(Of String, String)()
                For Each c In target.Readable
                    seen(c.ToLowerInvariant()) = c
                Next
                For Each kv In labels
                    If Not ContainsIgnoreCase(target.Readable, kv.Key) Then Fail(name & ".labels の " & kv.Key & " が readable にありません")
                    Dim label = TryCast(kv.Value, String)
                    If label Is Nothing OrElse label.Trim().Length = 0 Then Fail(name & ".labels." & kv.Key & " は文字列です")
                    Dim k = label.Trim().ToLowerInvariant()
                    Dim other As String = Nothing
                    If seen.TryGetValue(k, other) AndAlso Not String.Equals(other, kv.Key, StringComparison.OrdinalIgnoreCase) Then
                        Fail(name & ".labels の " & label & " が " & other & " とぶつかります")
                    End If
                    seen(k) = kv.Key
                    target.Labels(kv.Key) = label.Trim()
                Next
            End If
            If t.ContainsKey("stamp") Then
                Dim stamp = PatchiriJson.AsObject(t("stamp"))
                If stamp Is Nothing Then Fail(name & ".stamp は { ""列名"": ""now"" か ""user"" } の形です")
                If target.Access <> "update" Then Fail(name & " は read なので stamp を持てません")
                For Each kv In stamp
                    Dim v = TryCast(kv.Value, String)
                    If v <> "now" AndAlso v <> "user" Then Fail(name & ".stamp." & kv.Key & " は ""now"" か ""user"" です")
                    If target.Key IsNot Nothing AndAlso ContainsIgnoreCase(target.Key, kv.Key) Then Fail(name & " のキー列 " & kv.Key & " は stamp にできません")
                    If ContainsIgnoreCase(target.Updatable, kv.Key) Then Fail(name & ".stamp の " & kv.Key & " は updatable にもあります（どちらか一方にしてください）")
                    target.Stamp.Add(New KeyValuePair(Of String, String)(kv.Key, v))
                Next
            End If
            If t.ContainsKey("scope") Then
                Dim scope = PatchiriJson.AsObject(t("scope"))
                If scope Is Nothing OrElse scope.Count = 0 Then Fail(name & ".scope は { ""列名"": 値 } の形です")
                For Each kv In scope
                    Dim v = PatchiriJson.Normalize(kv.Value)
                    If Not TypeOf v Is String AndAlso Not TypeOf v Is Double AndAlso Not TypeOf v Is Boolean Then Fail(name & ".scope." & kv.Key & " は文字列、数、true / false のどれかです")
                    If ContainsIgnoreCase(target.Updatable, kv.Key) Then Fail(name & ".scope の " & kv.Key & " は updatable にもあります（範囲の列は変えられません）")
                    For Each st In target.Stamp
                        If String.Equals(st.Key, kv.Key, StringComparison.OrdinalIgnoreCase) Then Fail(name & ".scope の " & kv.Key & " は stamp にもあります")
                    Next
                    target.Scope(kv.Key) = v
                Next
            End If
            If t.ContainsKey("roles") Then
                Dim roles = PatchiriJson.AsArray(t("roles"))
                If roles Is Nothing OrElse roles.Count = 0 Then Fail(name & ".roles はロールの名前の配列です")
                target.Roles = New List(Of String)()
                For Each role In roles
                    Dim r = TryCast(role, String)
                    If String.IsNullOrEmpty(r) Then Fail(name & ".roles はロールの名前の配列です")
                    target.Roles.Add(r)
                Next
            End If
        End Sub

        ''' <summary>設定の JSON を読み、形を確かめる。rulesBaseDir は rules にファイルのパスを書いたときに読むフォルダ（Nothing ならパスは書けない）。</summary>
        Public Shared Function Parse(json As String, rulesBaseDir As String) As PatchiriConfig
            Dim root As Object
            Try
                root = PatchiriJson.Parse(json)
            Catch e As Exception
                Throw New PatchiriConfigException("JSON として読めません（" & e.Message & "）")
            End Try
            Dim o = PatchiriJson.AsObject(root)
            If o Is Nothing Then Fail("JSON のオブジェクトではありません")
            Dim config As New PatchiriConfig()

            Dim targets = PatchiriJson.AsObject(PatchiriJson.Get(o, "targets"))
            If targets Is Nothing Then Fail("targets がありません")
            For Each kv In targets
                Dim name = kv.Key
                If Not TargetNameRe.IsMatch(name) Then Fail("ターゲット名 " & name & " に使えない文字があります")
                Dim t = PatchiriJson.AsObject(kv.Value)
                If t Is Nothing Then Fail(name & " がオブジェクトではありません")
                Dim target As New TargetConfig()
                target.Table = TryCast(PatchiriJson.Get(t, "table"), String)
                If String.IsNullOrEmpty(target.Table) Then Fail(name & ".table がありません")
                target.Access = TryCast(PatchiriJson.Get(t, "access"), String)
                If target.Access <> "update" AndAlso target.Access <> "read" Then Fail(name & ".access は ""update"" か ""read"" です")
                target.Readable = Names(PatchiriJson.Get(t, "readable"), name & ".readable")
                If t.ContainsKey("key") Then
                    target.Key = Names(t("key"), name & ".key")
                    If target.Key.Count = 0 Then Fail(name & ".key は列名の配列です")
                    For Each k In target.Key
                        If Not ContainsIgnoreCase(target.Readable, k) Then Fail(name & ".key の " & k & " が readable にありません")
                    Next
                End If
                If t.ContainsKey("updatable") Then
                    target.Updatable = Names(t("updatable"), name & ".updatable")
                    If target.Access <> "update" AndAlso target.Updatable.Count > 0 Then Fail(name & " は read なので updatable を持てません")
                    For Each c In target.Updatable
                        If Not ContainsIgnoreCase(target.Readable, c) Then Fail(name & ".updatable の " & c & " が readable にありません")
                        If target.Key IsNot Nothing AndAlso ContainsIgnoreCase(target.Key, c) Then Fail(name & " のキー列 " & c & " は更新できません")
                    Next
                End If
                ParseTargetExtras(name, t, target)
                config.TargetNames.Add(name)
                config.Targets(name) = target
            Next

            Dim limits = PatchiriJson.AsObject(PatchiriJson.Get(o, "limits"))
            If limits IsNot Nothing Then
                If limits.ContainsKey("maxFetchKeys") Then config.MaxFetchKeys = PositiveInt(limits("maxFetchKeys"), "limits.maxFetchKeys")
                If limits.ContainsKey("maxApplyRows") Then config.MaxApplyRows = PositiveInt(limits("maxApplyRows"), "limits.maxApplyRows")
            End If
            If o.ContainsKey("connectionStringName") Then
                config.ConnectionStringName = TryCast(o("connectionStringName"), String)
                If String.IsNullOrEmpty(config.ConnectionStringName) Then Fail("connectionStringName は文字列です")
            End If
            If o.ContainsKey("logDir") Then
                config.LogDir = TryCast(o("logDir"), String)
                If String.IsNullOrEmpty(config.LogDir) Then Fail("logDir は文字列です")
            End If
            ' Node 版と同じく database.lockWaitSeconds にも書ける（接続先は web.config なので、database の中はこれだけを読む）。
            Dim database = PatchiriJson.AsObject(PatchiriJson.Get(o, "database"))
            Dim top As Integer? = Nothing
            Dim inner As Integer? = Nothing
            If o.ContainsKey("lockWaitSeconds") Then top = PositiveInt(o("lockWaitSeconds"), "lockWaitSeconds")
            If database IsNot Nothing AndAlso database.ContainsKey("lockWaitSeconds") Then inner = PositiveInt(database("lockWaitSeconds"), "database.lockWaitSeconds")
            If top.HasValue AndAlso inner.HasValue AndAlso top.Value <> inner.Value Then Fail("lockWaitSeconds と database.lockWaitSeconds が違います（どちらか一方に書いてください）")
            If top.HasValue OrElse inner.HasValue Then
                config.LockWaitSeconds = If(top.HasValue, top.Value, inner.Value)
                ' SET LOCK_TIMEOUT はミリ秒の int。
                If config.LockWaitSeconds > Integer.MaxValue \ 1000 Then Fail("lockWaitSeconds が大きすぎます")
            End If
            If o.ContainsKey("rules") Then
                Dim rules = o("rules")
                Dim rulesFile = TryCast(rules, String)
                If rulesFile IsNot Nothing Then
                    If rulesBaseDir Is Nothing Then Fail("rules にファイルのパスを書くときは PatchiriConfig.Load で読んでください")
                    Dim full As String = Nothing
                    Dim stamp As DateTime
                    rules = ReadRulesFile(rulesBaseDir, rulesFile, full, stamp)
                    config.RulesPath = full
                    config.RulesStamp = stamp
                End If
                Dim ro = PatchiriJson.AsObject(rules)
                If ro Is Nothing Then Fail("rules は { ""targets"": { … } } の形です")
                config.Rules = New Dictionary(Of String, Object)(StringComparer.Ordinal)
                If ro.ContainsKey("targets") Then
                    Dim rt = PatchiriJson.AsObject(ro("targets"))
                    If rt Is Nothing Then Fail("rules は { ""targets"": { … } } の形です")
                    For Each kv In rt
                        If Not config.Targets.ContainsKey(kv.Key) Then Fail("rules.targets の " & kv.Key & " は targets にありません")
                        If PatchiriJson.AsArray(kv.Value) Is Nothing Then Fail("rules.targets." & kv.Key & " はルールの配列です")
                        config.Rules(kv.Key) = kv.Value
                    Next
                End If
            End If
            If o.ContainsKey("exposeDbErrors") Then
                If Not TypeOf o("exposeDbErrors") Is Boolean Then Fail("exposeDbErrors は true か false です")
                config.ExposeDbErrors = DirectCast(o("exposeDbErrors"), Boolean)
            End If
            If o.ContainsKey("screen") Then config.Screen = ParseScreen(o("screen"), rulesBaseDir)
            Return config
        End Function

        Private Shared Function ParseScreen(x As Object, baseDir As String) As ScreenSettings
            Dim s = PatchiriJson.AsObject(x)
            If s Is Nothing Then Fail("screen は { ""title"": … } の形です")
            Dim settings As New ScreenSettings()
            For Each kv In s
                Dim text = TryCast(kv.Value, String)
                Select Case kv.Key
                    Case "title"
                        If text Is Nothing OrElse text.Trim().Length = 0 Then Fail("screen.title は空でない文字列です")
                        settings.Title = text
                    Case "theme"
                        If text <> "auto" AndAlso text <> "light" AndAlso text <> "dark" Then Fail("screen.theme は ""auto""、""light""、""dark"" のどれかです")
                        settings.Theme = If(text = "auto", Nothing, text)
                    Case "noteRequired"
                        If TypeOf kv.Value Is Boolean Then
                            settings.NoteRequired = If(DirectCast(kv.Value, Boolean), "true", Nothing)
                        ElseIf text IsNot Nothing AndAlso text.Trim().Length > 0 Then
                            settings.NoteRequired = text
                        Else
                            Fail("screen.noteRequired は true / false か、欄の名前（空でない文字列）です")
                        End If
                    Case "excel"
                        If Not TypeOf kv.Value Is Boolean Then Fail("screen.excel は true / false です")
                        settings.Excel = DirectCast(kv.Value, Boolean)
                    Case "css"
                        If String.IsNullOrEmpty(text) Then Fail("screen.css は CSS のファイルのパスです")
                        If baseDir Is Nothing Then Fail("screen.css を書くときは PatchiriConfig.Load で読んでください")
                        settings.CssPath = IO.Path.GetFullPath(IO.Path.Combine(baseDir, text))
                    Case Else
                        Fail("screen." & kv.Key & " という項目はありません")
                End Select
            Next
            Return settings
        End Function

    End Class

End Namespace
