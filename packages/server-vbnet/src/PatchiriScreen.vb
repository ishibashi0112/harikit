' Patchiri.aspx をブラウザで開いたとき（GET）に出す画面。
' 画面の中身は patchiri-web の同梱アプリ（dist/app の main.js と main.css）で、既定ではページの隣の patchiri/ に置く。
' 画面は同じページの WebMethod を呼ぶので、載せ先のログイン（フォーム認証、Windows 認証など）のまま使え、
' web.config でこのページに掛けた権限が、画面と API の両方に効く。ページの名前と置き場所は自由（自分の URL を見る）。

Option Strict On
Option Explicit On
Option Infer On
Option Compare Binary

Imports System
Imports System.Configuration
Imports System.Globalization
Imports System.IO
Imports System.Text
Imports System.Web
Imports System.Web.Hosting
Imports Microsoft.VisualBasic

Namespace Global.Patchiri.Server

    Public NotInheritable Class PatchiriScreen

        Private Const DefaultAssets As String = "patchiri/"

        ''' <summary>画面に許すこと（Node 版と同じ）。通信は同じオリジンだけ。載せ先の自分のページの iframe には入れられる。</summary>
        Private Const Csp As String = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"

        Private Sub New()
        End Sub

        ''' <summary>
        ''' WebMethod 以外の呼び出し（ページそのもの）に答える。Patchiri.aspx の Page_Load から呼び、その後は Response.End で止める。
        ''' GET と HEAD は画面、application/json でない POST は 415（ASP.NET が WebMethod に回さない）、ほかは 404。
        ''' </summary>
        Public Shared Sub Write(ctx As HttpContext)
            Dim method = ctx.Request.HttpMethod
            Dim res = ctx.Response
            res.Clear()
            res.Cache.SetCacheability(HttpCacheability.NoCache)
            res.Cache.SetNoStore()
            res.AppendHeader("X-Content-Type-Options", "nosniff")
            If String.Equals(method, "GET", StringComparison.Ordinal) OrElse String.Equals(method, "HEAD", StringComparison.Ordinal) Then
                WritePage(ctx)
                Return
            End If
            Dim post = String.Equals(method, "POST", StringComparison.Ordinal)
            res.StatusCode = If(post, 415, 404)
            res.ContentType = "text/plain"
            res.Write(If(post, "application/json required", "not found"))
        End Sub

        Private Shared Sub WritePage(ctx As HttpContext)
            Dim res = ctx.Response
            Dim page = ctx.Request.FilePath
            Dim dir = AssetsDir(page)
            Dim css = AssetUrl(dir, "main.css")
            Dim js = AssetUrl(dir, "main.js")
            ' 載せ先が globalization の responseEncoding を Shift_JIS などにしていても、このページは UTF-8 で返す。
            res.ContentType = "text/html"
            res.ContentEncoding = New UTF8Encoding(False)
            res.Charset = "utf-8"
            res.AppendHeader("Content-Security-Policy", Csp)
            res.AppendHeader("X-Frame-Options", "SAMEORIGIN")
            res.AppendHeader("Referrer-Policy", "no-referrer")
            Dim html As New StringBuilder()
            html.Append("<!doctype html>" & vbLf & "<html lang=""ja"">" & vbLf & "<head>" & vbLf & "<meta charset=""utf-8"">" & vbLf)
            html.Append("<meta name=""viewport"" content=""width=device-width, initial-scale=1"">" & vbLf & "<title>patchiri</title>" & vbLf)
            If css Is Nothing OrElse js Is Nothing Then
                ' 画面のファイルを置き忘れたとき。真っ白なページにせず、どこに何を置くかを見せる。
                html.Append("</head>" & vbLf & "<body style=""font-family: sans-serif; margin: 2em; line-height: 1.7"">" & vbLf & "<h1>patchiri</h1>" & vbLf)
                html.Append("<p>画面のファイルがありません: ").Append(Encode(dir)).Append(If(css Is Nothing, "main.css", "main.js")).Append("</p>" & vbLf)
                html.Append("<p>patchiri-web の同梱アプリ（dist/app）の main.js、main.css、main.js.LEGAL.txt を、このフォルダに置いてください。")
                html.Append("置く場所は web.config の appSettings の patchiri:assets で変えられます。</p>" & vbLf & "</body>" & vbLf & "</html>" & vbLf)
                res.Write(html.ToString())
                Return
            End If
            html.Append("<link rel=""stylesheet"" href=""").Append(Encode(css)).Append(""">" & vbLf)
            html.Append("<script type=""module"" src=""").Append(Encode(js)).Append("""></script>" & vbLf & "</head>" & vbLf & "<body>" & vbLf)
            ' つなぐ先は同じページの WebMethod。ログイン名は見出しに出す（反映ログに残る名前）。
            html.Append("<div id=""root"" data-api=""").Append(Encode(res.ApplyAppPathModifier(page))).Append(""" data-style=""webmethod"" data-user=""")
            html.Append(Encode(PatchiriWebMethods.CurrentUser())).Append("""></div>" & vbLf)
            ' Internet Explorer（Edge の IE モードも）はモジュールの script を読まないので、画面の代わりに案内を出す。
            html.Append("<p id=""patchiri-legacy"" hidden style=""font-family: sans-serif; margin: 2em"">このブラウザでは patchiri の画面を開けません。")
            html.Append("Microsoft Edge か Google Chrome で開いてください（Internet Explorer と、Edge の IE モードでは動きません）。</p>" & vbLf)
            html.Append("<script nomodule>document.getElementById(""patchiri-legacy"").removeAttribute(""hidden"");</script>" & vbLf)
            html.Append("<noscript>JavaScript を有効にしてください。</noscript>" & vbLf & "</body>" & vbLf & "</html>" & vbLf)
            res.Write(html.ToString())
        End Sub

        ''' <summary>画面のファイルを置いたフォルダの URL（/ で終わる）。"~/" で始まればアプリの根から、ほかはページのフォルダから。</summary>
        Private Shared Function AssetsDir(page As String) As String
            Dim dir = ConfigurationManager.AppSettings("patchiri:assets")
            If String.IsNullOrEmpty(dir) Then dir = DefaultAssets
            If Not dir.EndsWith("/", StringComparison.Ordinal) Then dir &= "/"
            If dir.StartsWith("~/", StringComparison.Ordinal) Then Return VirtualPathUtility.ToAbsolute(dir)
            Return VirtualPathUtility.Combine(page, dir)
        End Function

        ''' <summary>画面のファイルの URL。置き直したらブラウザが読み直すよう、更新日時を付ける。ファイルがなければ Nothing。</summary>
        Private Shared Function AssetUrl(dir As String, name As String) As String
            Dim url = dir & name
            Dim fileName = HostingEnvironment.MapPath(url)
            If fileName Is Nothing OrElse Not File.Exists(fileName) Then Return Nothing
            Return url & "?v=" & File.GetLastWriteTimeUtc(fileName).Ticks.ToString("x", CultureInfo.InvariantCulture)
        End Function

        Private Shared Function Encode(s As String) As String
            Return HttpUtility.HtmlEncode(s)
        End Function

    End Class

End Namespace
