<%@ Page Language="VB" AutoEventWireup="false" EnableSessionState="False" EnableViewState="False" %>
<%@ Import Namespace="System.Collections.Generic" %>
<%@ Import Namespace="System.Web.Services" %>
<%@ Import Namespace="Patchiri.Server" %>
<script runat="server">
    ' patchiri のサーバ API 3 本（docs/api-spec.md、webmethod スタイル）。
    ' クライアント設定の例: { baseUrl: "/Admin/Patchiri.aspx", style: "webmethod" }
    ' 認証と権限はこのページに掛ける（web.config の <location path="Admin/Patchiri.aspx"> と <authorization> など）。

    <WebMethod()>
    Public Shared Function Describe(req As Dictionary(Of String, Object)) As Dictionary(Of String, Object)
        Return PatchiriWebMethods.Call("describe", req)
    End Function

    <WebMethod()>
    Public Shared Function Fetch(req As Dictionary(Of String, Object)) As Dictionary(Of String, Object)
        Return PatchiriWebMethods.Call("fetch", req)
    End Function

    <WebMethod()>
    Public Shared Function Apply(req As Dictionary(Of String, Object)) As Dictionary(Of String, Object)
        Return PatchiriWebMethods.Call("apply", req)
    End Function

    ' WebMethod 以外の呼び出し（ページそのもの）には何も見せない。
    ' 載せ先の web.config が autoEventWireup をどちらにしていても動くよう、Page の指定で false にして Handles でつなぐ。
    Private Sub Page_Load(sender As Object, e As EventArgs) Handles Me.Load
        Dim post = String.Equals(Request.HttpMethod, "POST", StringComparison.Ordinal)
        Response.Clear()
        Response.StatusCode = If(post, 415, 404)
        Response.ContentType = "text/plain"
        Response.Write(If(post, "application/json required", "not found"))
        Response.End()
    End Sub
</script>
