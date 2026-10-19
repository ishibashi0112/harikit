' 反映ログ。1 行 1 件の JSON（JSON Lines）を日付ごとのファイルに足していく。形は Node 版と同じ。
' サーバ側のエラー（db_error、internal_error の中身）も同じフォルダに残す。

Option Strict On
Option Explicit On
Option Infer On
Option Compare Binary

Imports System
Imports System.Collections.Generic
Imports System.Globalization
Imports System.IO
Imports System.Text
Imports Microsoft.VisualBasic

Namespace Global.Harikit.Server

    Public NotInheritable Class HarikitFileLog

        Private Shared ReadOnly sync As New Object()
        Private Shared ReadOnly Utf8NoBom As Encoding = New UTF8Encoding(False)

        Private Sub New()
        End Sub

        Public Shared Sub WriteApply(dir As String, entry As Dictionary(Of String, Object))
            Dim appliedAt = If(TryCast(entry("appliedAt"), String), DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))
            Append(dir, "apply-" & appliedAt.Substring(0, 10) & ".jsonl", HarikitJson.Stringify(entry) & vbLf)
        End Sub

        Public Shared Sub WriteError(dir As String, e As Exception)
            Dim now = DateTime.Now
            Dim text = now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture) & " " & Convert.ToString(e) & vbLf
            Append(dir, "error-" & now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) & ".log", text)
        End Sub

        ' 引数の名前を file や path にしない（VB は大文字小文字を区別しないので、File や Path のクラスが隠れる）。
        Private Shared Sub Append(dir As String, fileName As String, text As String)
            SyncLock sync
                Directory.CreateDirectory(dir)
                File.AppendAllText(Path.Combine(dir, fileName), text, Utf8NoBom)
            End SyncLock
        End Sub

    End Class

End Namespace
