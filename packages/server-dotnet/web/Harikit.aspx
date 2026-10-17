<%@ Page Language="C#" EnableSessionState="False" EnableViewState="False" %>
<%@ Import Namespace="System.Collections.Generic" %>
<%@ Import Namespace="System.Web.Services" %>
<%@ Import Namespace="Harikit.Server" %>
<script runat="server">
    // harikit のサーバ API 3 本（docs/api-spec.md、webmethod スタイル）。
    // クライアント設定の例: { baseUrl: "/Admin/Harikit.aspx", style: "webmethod" }
    // 認証と権限はこのページに掛ける（web.config の <location path="Admin/Harikit.aspx"> と <authorization> など）。

    [WebMethod]
    public static Dictionary<string, object> Describe(Dictionary<string, object> req)
    {
        return HarikitWebMethods.Call("describe", req);
    }

    [WebMethod]
    public static Dictionary<string, object> Fetch(Dictionary<string, object> req)
    {
        return HarikitWebMethods.Call("fetch", req);
    }

    [WebMethod]
    public static Dictionary<string, object> Apply(Dictionary<string, object> req)
    {
        return HarikitWebMethods.Call("apply", req);
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
