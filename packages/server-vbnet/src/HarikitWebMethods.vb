' ASP.NET WebForms の WebMethod から呼ぶ入口（webmethod スタイル、仕様 1.1）。
' Harikit.aspx の <WebMethod()> Describe / Fetch / Apply は、ここの Call を呼ぶだけにする。
'
' 設定: web.config の appSettings "harikit:config"（既定 ~/App_Data/harikit.config.json）に許可リストを置き、
' 接続文字列は connectionStrings の名前（既定 "Harikit"）で指す。認証と権限は載せ先のアプリに任せる（仕様 1.4）。

Option Strict On
Option Explicit On
Option Infer On
Option Compare Binary

Imports System
Imports System.Collections.Generic
Imports System.Configuration
Imports System.Diagnostics
Imports System.IO
Imports System.Text
Imports System.Web
Imports System.Web.Configuration
Imports System.Web.Hosting

Namespace Global.Harikit.Server

    Public NotInheritable Class HarikitWebMethods

        Private Const DefaultConfigPath As String = "~/App_Data/harikit.config.json"
        Private Const DefaultLogDir As String = "~/App_Data/harikit-log"

        Private Shared ReadOnly sync As New Object()
        Private Shared cachedService As HarikitService
        Private Shared cachedPath As String
        Private Shared cachedStamp As DateTime

        Private Sub New()
        End Sub

        Public Shared Function [Call](name As String, req As Dictionary(Of String, Object)) As Dictionary(Of String, Object)
            Dim ctx = HttpContext.Current
            ctx.Response.Cache.SetCacheability(HttpCacheability.NoCache)
            ctx.Response.Cache.SetNoStore()
            ' CSRF 対策（仕様 1.4）。application/json でない呼び出しは ASP.NET が WebMethod に回さない。
            If Not String.Equals(ctx.Request.Headers("X-Harikit"), "1", StringComparison.Ordinal) Then
                ctx.Response.StatusCode = 403
                Return New Dictionary(Of String, Object) From {{"message", "X-Harikit: 1 header required"}}
            End If
            Dim s As HarikitService
            Try
                s = Service()
            Catch e As Exception
                WriteError(MapPath(DefaultLogDir), e)
                Return New Dictionary(Of String, Object) From {
                    {"ok", False},
                    {"v", 1},
                    {"error", New Dictionary(Of String, Object) From {{"code", "internal_error"}, {"message", "harikit の設定を読めません（詳細はサーバのログ）"}}}
                }
            End Try
            Return s.Handle(name, req)
        End Function

        ''' <summary>設定ファイルを読んでサービスを作る。設定ファイルを保存し直すと読み直す（テーブル定義の覚えも捨てる）。</summary>
        Private Shared Function Service() As HarikitService
            Dim configPath = MapPath(If(ConfigurationManager.AppSettings("harikit:config"), DefaultConfigPath))
            Dim stamp = File.GetLastWriteTimeUtc(configPath)
            SyncLock sync
                If cachedService IsNot Nothing AndAlso configPath = cachedPath AndAlso stamp = cachedStamp Then Return cachedService
                Dim config = HarikitConfig.Parse(File.ReadAllText(configPath, Encoding.UTF8))
                Dim cs = ConfigurationManager.ConnectionStrings(config.ConnectionStringName)
                If cs Is Nothing OrElse String.IsNullOrEmpty(cs.ConnectionString) Then
                    Throw New HarikitConfigException("web.config の connectionStrings に " & config.ConnectionStringName & " がありません")
                End If
                Dim logDir = MapPath(config.LogDir)
                cachedService = New HarikitService(New HarikitServiceOptions With {
                    .Config = config,
                    .Dialect = New SqlServerDialect(cs.ConnectionString, config.LockWaitSeconds),
                    .WhoAmI = AddressOf CurrentUser,
                    .Log = Sub(entry) HarikitFileLog.WriteApply(logDir, entry),
                    .LogError = Sub(e) WriteError(logDir, e),
                    .MaxResponseLength = MaxJsonLength()
                })
                cachedPath = configPath
                cachedStamp = stamp
                Return cachedService
            End SyncLock
        End Function

        ''' <summary>反映した人。載せ先の認証（フォーム認証、Windows 認証など）が決めた名前を使う。</summary>
        Private Shared Function CurrentUser() As String
            Dim ctx = HttpContext.Current
            If ctx IsNot Nothing AndAlso ctx.User IsNot Nothing AndAlso ctx.User.Identity IsNot Nothing AndAlso ctx.User.Identity.IsAuthenticated Then Return ctx.User.Identity.Name
            Return "(anonymous)"
        End Function

        ''' <summary>WebMethod が返せる JSON の長さ（web.config の jsonSerialization maxJsonLength）。</summary>
        Private Shared Function MaxJsonLength() As Integer?
            Dim section = TryCast(WebConfigurationManager.GetSection("system.web.extensions/scripting/webServices/jsonSerialization"), ScriptingJsonSerializationSection)
            If section IsNot Nothing Then Return section.MaxJsonLength
            Return Nothing
        End Function

        ''' <summary>"~/" で始まればアプリの中、相対ならアプリのフォルダから、絶対ならそのまま。</summary>
        Private Shared Function MapPath(value As String) As String
            If value.StartsWith("~/", StringComparison.Ordinal) Then Return HostingEnvironment.MapPath(value)
            If Path.IsPathRooted(value) Then Return value
            Return Path.Combine(HostingEnvironment.ApplicationPhysicalPath, value)
        End Function

        Private Shared Sub WriteError(dir As String, e As Exception)
            Trace.TraceError("harikit: " & e.ToString())
            Try
                HarikitFileLog.WriteError(dir, e)
            Catch ex As Exception
                ' ログのフォルダに書けないときは Trace だけに残す。
            End Try
        End Sub

    End Class

End Namespace
