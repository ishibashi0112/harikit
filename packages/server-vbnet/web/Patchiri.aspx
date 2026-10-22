<%@ Page Language="VB" AutoEventWireup="false" EnableSessionState="False" EnableViewState="False" %>
<%@ Import Namespace="System.Collections.Generic" %>
<%@ Import Namespace="System.Web.Services" %>
<%@ Import Namespace="Patchiri.Server" %>
<script runat="server">
    ' patchiri のサーバ API 3 本（docs/api-spec.md、webmethod スタイル）と、それを使う画面。
    ' ブラウザでこのページを開くと画面が出る（画面のファイルは隣の patchiri/ に置く。PatchiriScreen.vb）。ページの名前と置き場所は自由。
    ' 認証と権限はこのページに掛ける（web.config の <location path="Admin/Patchiri.aspx"> と <authorization> など）。画面と API の両方に効く。
    ' ページごとに別の許可リストを使うなら、Call の 3 つ目に設定ファイルを渡す（PatchiriWebMethods.Call("describe", req, "~/App_Data/sales.config.json")）。
    ' 「誰が」を Session から取るアプリは、Global.asax で PatchiriWebMethods.WhoAmI を差し替え、
    ' <WebMethod(EnableSession:=True)> と、ページの EnableSessionState="ReadOnly" にする（README の「誰が反映したか」）。

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

    ' WebMethod 以外の呼び出し（ページそのもの）: GET は画面、application/json でない POST は 415、ほかは 404。
    ' 載せ先の web.config が autoEventWireup をどちらにしていても動くよう、Page の指定で false にして Handles でつなぐ。
    Private Sub Page_Load(sender As Object, e As EventArgs) Handles Me.Load
        PatchiriScreen.Write(Context)
        Response.End()
    End Sub
</script>
