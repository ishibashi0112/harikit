' サーバの設定（許可リスト、上限、ログ）。仕様 2 の許可リストを含む。
' 形は Node 版の harikit.config.json と同じ（targets と limits はそのまま写せる）。
' 接続文字列は設定ファイルに書かず、web.config の connectionStrings を名前で指す。

Option Strict On
Option Explicit On
Option Infer On
Option Compare Binary

Imports System
Imports System.Collections.Generic
Imports System.Text.RegularExpressions

Namespace Global.Harikit.Server

    Public NotInheritable Class TargetConfig
        Public Table As String
        ''' <summary>"update" か "read"。</summary>
        Public Access As String
        ''' <summary>省くと（Nothing）DB の主キー。</summary>
        Public Key As List(Of String)
        Public Readable As New List(Of String)()
        Public Updatable As New List(Of String)()
    End Class

    Public Class HarikitConfigException
        Inherits Exception

        Public Sub New(message As String)
            MyBase.New("設定の誤り: " & message)
        End Sub
    End Class

    Public NotInheritable Class HarikitConfig

        Private Shared ReadOnly TargetNameRe As New Regex("\A[A-Za-z0-9_-]+\z")

        ''' <summary>書いた順のターゲット名。</summary>
        Public TargetNames As New List(Of String)()
        Public Targets As New Dictionary(Of String, TargetConfig)(StringComparer.Ordinal)
        Public MaxFetchKeys As Integer = 1000
        Public MaxApplyRows As Integer = 5000
        ''' <summary>web.config の connectionStrings の名前。既定は "Harikit"。</summary>
        Public ConnectionStringName As String = "Harikit"
        ''' <summary>反映ログ（JSON Lines）を置くフォルダ。既定は ~/App_Data/harikit-log。</summary>
        Public LogDir As String = "~/App_Data/harikit-log"
        ''' <summary>db_error の message に DB の生のエラー文を出すか。既定は出さない。</summary>
        Public ExposeDbErrors As Boolean
        ''' <summary>反映で行のロックを待つ秒数（仕様 7 の手順 3）。既定は 10 秒。</summary>
        Public LockWaitSeconds As Integer = 10

        Private Shared Sub Fail(message As String)
            Throw New HarikitConfigException(message)
        End Sub

        Private Shared Function Names(x As Object, what As String) As List(Of String)
            Dim list = HarikitJson.AsArray(x)
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
            If Not HarikitJson.IsNumber(x) Then Fail(what & " は正の整数です")
            Dim d = HarikitJson.ToDouble(x)
            If d < 1 OrElse d > Integer.MaxValue OrElse Math.Floor(d) <> d Then Fail(what & " は正の整数です")
            Return CInt(d)
        End Function

        ''' <summary>設定の JSON を読み、形を確かめる。おかしければ HarikitConfigException。</summary>
        Public Shared Function Parse(json As String) As HarikitConfig
            Dim root As Object
            Try
                root = HarikitJson.Parse(json)
            Catch e As Exception
                Throw New HarikitConfigException("JSON として読めません（" & e.Message & "）")
            End Try
            Dim o = HarikitJson.AsObject(root)
            If o Is Nothing Then Fail("JSON のオブジェクトではありません")
            Dim config As New HarikitConfig()

            Dim targets = HarikitJson.AsObject(HarikitJson.Get(o, "targets"))
            If targets Is Nothing Then Fail("targets がありません")
            For Each kv In targets
                Dim name = kv.Key
                If Not TargetNameRe.IsMatch(name) Then Fail("ターゲット名 " & name & " に使えない文字があります")
                Dim t = HarikitJson.AsObject(kv.Value)
                If t Is Nothing Then Fail(name & " がオブジェクトではありません")
                Dim target As New TargetConfig()
                target.Table = TryCast(HarikitJson.Get(t, "table"), String)
                If String.IsNullOrEmpty(target.Table) Then Fail(name & ".table がありません")
                target.Access = TryCast(HarikitJson.Get(t, "access"), String)
                If target.Access <> "update" AndAlso target.Access <> "read" Then Fail(name & ".access は ""update"" か ""read"" です")
                target.Readable = Names(HarikitJson.Get(t, "readable"), name & ".readable")
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
                config.TargetNames.Add(name)
                config.Targets(name) = target
            Next

            Dim limits = HarikitJson.AsObject(HarikitJson.Get(o, "limits"))
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
            If o.ContainsKey("lockWaitSeconds") Then
                config.LockWaitSeconds = PositiveInt(o("lockWaitSeconds"), "lockWaitSeconds")
                ' SET LOCK_TIMEOUT はミリ秒の int。
                If config.LockWaitSeconds > Integer.MaxValue \ 1000 Then Fail("lockWaitSeconds が大きすぎます")
            End If
            If o.ContainsKey("exposeDbErrors") Then
                If Not TypeOf o("exposeDbErrors") Is Boolean Then Fail("exposeDbErrors は true か false です")
                config.ExposeDbErrors = DirectCast(o("exposeDbErrors"), Boolean)
            End If
            Return config
        End Function

    End Class

End Namespace
