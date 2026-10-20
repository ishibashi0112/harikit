<%@ Page Language="C#" EnableSessionState="False" EnableViewState="False" %>
<%@ Import Namespace="System.Collections.Generic" %>
<%@ Import Namespace="System.Web.Services" %>
<%@ Import Namespace="Patchiri.Server" %>
<script runat="server">
    // patchiri のサーバ API 3 本（docs/api-spec.md、webmethod スタイル）。
    // クライアント設定の例: { baseUrl: "/Admin/Patchiri.aspx", style: "webmethod" }
    // 認証と権限はこのページに掛ける（web.config の <location path="Admin/Patchiri.aspx"> と <authorization> など）。

    [WebMethod]
    public static Dictionary<string, object> Describe(Dictionary<string, object> req)
    {
        return PatchiriWebMethods.Call("describe", req);
    }

    [WebMethod]
    public static Dictionary<string, object> Fetch(Dictionary<string, object> req)
    {
        return PatchiriWebMethods.Call("fetch", req);
    }

    [WebMethod]
    public static Dictionary<string, object> Apply(Dictionary<string, object> req)
    {
        return PatchiriWebMethods.Call("apply", req);
    }

    // WebMethod 以外の呼び出し（ページそのもの）には何も見せない。
    protected void Page_Load(object sender, EventArgs e)
    {
        Response.Clear();
        Response.StatusCode = Request.HttpMethod == "POST" ? 415 : 404;
        Response.ContentType = "text/plain";
        Response.Write(Request.HttpMethod == "POST" ? "application/json required" : "not found");
        Response.End();
    }
</script>
