' ASP.NET WebForms の WebMethod から呼ぶ入口（webmethod スタイル、仕様 1.1）。
' Patchiri.aspx の <WebMethod()> Describe / Fetch / Apply は、ここの Call を呼ぶだけにする。
'
' 設定: web.config の appSettings "patchiri:config"（既定 ~/App_Data/patchiri.config.json）に許可リストを置き、
' 接続文字列は connectionStrings の名前（既定 "Patchiri"）で指す。ページごとに別の許可リストを使うなら Call の configPath で渡す。
' 認証と権限は載せ先のアプリに任せる（仕様 1.4）。「誰が」とロールの判定は WhoAmI / IsInRole で差し替えられる。

Option Strict On
Option Explicit On
Option Infer On
Option Compare Binary

Imports System
Imports System.Collections.Generic
Imports System.Configuration
Imports System.Diagnostics
Imports System.IO
Imports System.Web
Imports System.Web.Configuration
Imports System.Web.Hosting

Namespace Global.Patchiri.Server

    Public NotInheritable Class PatchiriWebMethods

        Private Const DefaultConfigPath As String = "~/App_Data/patchiri.config.json"
        Private Const DefaultLogDir As String = "~/App_Data/patchiri-log"
        ''' <summary>1 回の呼び出しの中で、判定した利用者を覚えておく HttpContext.Items の名前。</summary>
        Private Const UserItem As String = "patchiri:user"

        ''' <summary>
        ''' 反映した人の名前を決める。Nothing（既定）なら載せ先の認証の名前（User.Identity.Name。ログインしていなければ "(anonymous)"）。
        ''' 自前のログインで Session に社員番号を置くアプリなどは、Global.asax の Application_Start で差し替える:
        ''' <code>PatchiriWebMethods.WhoAmI = Function(ctx) If(ctx.Session Is Nothing, Nothing, TryCast(ctx.Session("UserId"), String))</code>
        ''' 差し替えた判定が名前を返さない（Nothing か ""）呼び出しは、未ログインとして API も画面も HTTP 401 にする。
        ''' Session を読むなら、ページの WebMethod を &lt;WebMethod(EnableSession:=True)&gt; に、ページを EnableSessionState="ReadOnly" にする。
        ''' </summary>
        Public Shared WhoAmI As Func(Of HttpContext, String)

        ''' <summary>
        ''' ロールの判定（許可リストの roles）。Nothing（既定）なら User.IsInRole（Windows のグループ、ロール マネージャーなど）。
        ''' Session に権限を置くアプリなどは、WhoAmI と同じく Application_Start で差し替える。
        ''' </summary>
        Public Shared IsInRole As Func(Of HttpContext, String, Boolean)

        Private NotInheritable Class Loaded
            Public Service As PatchiriService
            Public Config As PatchiriConfig
            Public Stamp As DateTime
            Public RulesPath As String
            Public RulesStamp As DateTime
        End Class

        Private Shared ReadOnly sync As New Object()
        ''' <summary>設定ファイルのパス → 読んだサービス。</summary>
        Private Shared ReadOnly services As New Dictionary(Of String, Loaded)(StringComparer.OrdinalIgnoreCase)

        Private Sub New()
        End Sub

        Public Shared Function [Call](name As String, req As Dictionary(Of String, Object)) As Dictionary(Of String, Object)
            Return [Call](name, req, Nothing)
        End Function

        ''' <summary>
        ''' API を 1 本呼ぶ。configPath はこのページの許可リスト（"~/" で始まればアプリの中、相対ならアプリのフォルダから）。
        ''' Nothing なら appSettings の patchiri:config。
        ''' </summary>
        Public Shared Function [Call](name As String, req As Dictionary(Of String, Object), configPath As String) As Dictionary(Of String, Object)
            Dim ctx = HttpContext.Current
            ctx.Response.Cache.SetCacheability(HttpCacheability.NoCache)
            ctx.Response.Cache.SetNoStore()
            ' CSRF 対策（仕様 1.4）。application/json でない呼び出しは ASP.NET が WebMethod に回さない。
            If Not String.Equals(ctx.Request.Headers("X-Patchiri"), "1", StringComparison.Ordinal) Then
                ctx.Response.StatusCode = 403
                Return New Dictionary(Of String, Object) From {{"message", "X-Patchiri: 1 header required"}}
            End If
            Dim user As String
            Try
                user = CurrentUser()
            Catch e As Exception
                WriteError(MapPath(DefaultLogDir), e)
                Return InternalError("patchiri の利用者を判定できません（詳細はサーバのログ）")
            End Try
            If user Is Nothing Then
                ' フォーム認証のログイン画面への転送にも、IIS のエラーページにもしない（画面は 401 を見てログインし直しを促す）。
                ctx.Response.SuppressFormsAuthenticationRedirect = True
                ctx.Response.TrySkipIisCustomErrors = True
                ctx.Response.StatusCode = 401
                Return New Dictionary(Of String, Object) From {{"message", "login required"}}
            End If
            Dim s As PatchiriService
            Try
                s = Service(configPath)
            Catch e As Exception
                WriteError(MapPath(DefaultLogDir), e)
                Return InternalError("patchiri の設定を読めません（詳細はサーバのログ）")
            End Try
            Return s.Handle(name, req)
        End Function

        Private Shared Function InternalError(message As String) As Dictionary(Of String, Object)
            Return New Dictionary(Of String, Object) From {
                {"ok", False},
                {"v", 1},
                {"error", New Dictionary(Of String, Object) From {{"code", "internal_error"}, {"message", message}}}
            }
        End Function

        ''' <summary>同梱の画面の設定（設定ファイルの screen）。書いていなければ Nothing。設定が読めなければ例外。</summary>
        Friend Shared Function Screen(configPath As String) As ScreenSettings
            Return Load(configPath).Config.Screen
        End Function

        Private Shared Function Service(configPath As String) As PatchiriService
            Return Load(configPath).Service
        End Function

        ''' <summary>設定ファイルを読んでサービスを作る。設定ファイルか rules のファイルを保存し直すと読み直す（テーブル定義の覚えも捨てる）。</summary>
        Private Shared Function Load(configPath As String) As Loaded
            Dim configFile = MapPath(If(configPath, If(ConfigurationManager.AppSettings("patchiri:config"), DefaultConfigPath)))
            Dim stamp = File.GetLastWriteTimeUtc(configFile)
            SyncLock sync
                Dim cached As Loaded = Nothing
                If services.TryGetValue(configFile, cached) AndAlso cached.Stamp = stamp AndAlso
                    (cached.RulesPath Is Nothing OrElse File.GetLastWriteTimeUtc(cached.RulesPath) = cached.RulesStamp) Then Return cached
                Dim config = PatchiriConfig.Load(configFile)
                Dim logDir = MapPath(config.LogDir)
                Dim created = New PatchiriService(New PatchiriServiceOptions With {
                    .Config = config,
                    .Dialect = CreateDialect(config),
                    .WhoAmI = AddressOf CurrentUser,
                    .IsInRole = AddressOf CurrentUserInRole,
                    .Log = Sub(entry) PatchiriFileLog.WriteApply(logDir, entry),
                    .LogError = Sub(e) WriteError(logDir, e),
                    .MaxResponseLength = MaxJsonLength()
                })
                Dim fresh = New Loaded With {.Service = created, .Config = config, .Stamp = stamp, .RulesPath = config.RulesPath, .RulesStamp = config.RulesStamp}
                services(configFile) = fresh
                Return fresh
            End SyncLock
        End Function

        ''' <summary>
        ''' 設定の connectionStringName が指す接続文字列の providerName で DB を選ぶ。
        ''' 省くか System.Data.SqlClient なら SQL Server、Oracle.ManagedDataAccess.Client なら Oracle（ODP.NET Managed Driver）。
        ''' </summary>
        Public Shared Function CreateDialect(config As PatchiriConfig) As IPatchiriDialect
            Dim cs = ConfigurationManager.ConnectionStrings(config.ConnectionStringName)
            If cs Is Nothing OrElse String.IsNullOrEmpty(cs.ConnectionString) Then
                Throw New PatchiriConfigException("web.config の connectionStrings に " & config.ConnectionStringName & " がありません")
            End If
            Dim provider = cs.ProviderName
            If String.IsNullOrEmpty(provider) OrElse String.Equals(provider, "System.Data.SqlClient", StringComparison.Ordinal) Then Return New SqlServerDialect(cs.ConnectionString, config.LockWaitSeconds)
            If String.Equals(provider, OracleDialect.ProviderName, StringComparison.Ordinal) Then Return New OracleDialect(cs.ConnectionString, config.LockWaitSeconds)
            Throw New PatchiriConfigException("connectionStrings の " & config.ConnectionStringName & " の providerName " & provider &
                " には対応していません（SQL Server は System.Data.SqlClient、Oracle は " & OracleDialect.ProviderName & "）")
        End Function

        ''' <summary>
        ''' 反映した人。WhoAmI を差し替えていればその答え（名前がなければ Nothing）、なければ載せ先の認証が決めた名前。画面の見出しにも出す。
        ''' 1 回の呼び出しの中では最初の答えを使う（反映ログと stamp の列で名前がずれないように）。
        ''' </summary>
        Friend Shared Function CurrentUser() As String
            Dim ctx = HttpContext.Current
            If ctx Is Nothing Then Return Nothing
            If ctx.Items.Contains(UserItem) Then Return TryCast(ctx.Items(UserItem), String)
            Dim user As String
            Dim hook = WhoAmI
            If hook IsNot Nothing Then
                user = hook.Invoke(ctx)
                If user = "" Then user = Nothing
            ElseIf ctx.User IsNot Nothing AndAlso ctx.User.Identity IsNot Nothing AndAlso ctx.User.Identity.IsAuthenticated Then
                user = ctx.User.Identity.Name
            Else
                user = "(anonymous)"
            End If
            ctx.Items(UserItem) = user
            Return user
        End Function

        Private Shared Function CurrentUserInRole(role As String) As Boolean
            Dim ctx = HttpContext.Current
            If ctx Is Nothing Then Return False
            Dim hook = IsInRole
            If hook IsNot Nothing Then Return hook.Invoke(ctx, role)
            Return ctx.User IsNot Nothing AndAlso ctx.User.IsInRole(role)
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
            Trace.TraceError("patchiri: " & e.ToString())
            Try
                PatchiriFileLog.WriteError(dir, e)
            Catch ex As Exception
                ' ログのフォルダに書けないときは Trace だけに残す。
            End Try
        End Sub

    End Class

End Namespace
