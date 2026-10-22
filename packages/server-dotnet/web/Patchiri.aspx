<%@ Page Language="C#" EnableSessionState="False" EnableViewState="False" %>
<%@ Import Namespace="System.Collections.Generic" %>
<%@ Import Namespace="System.Web.Services" %>
<%@ Import Namespace="Patchiri.Server" %>
<script runat="server">
    // patchiri のサーバ API 3 本（docs/api-spec.md、webmethod スタイル）と、それを使う画面。
    // ブラウザでこのページを開くと画面が出る（画面のファイルは隣の patchiri/ に置く。PatchiriScreen.cs）。
    // 認証と権限はこのページに掛ける（web.config の <location path="Admin/Patchiri.aspx"> と <authorization> など）。画面と API の両方に効く。
    // ページごとに別の許可リストを使うなら、Call の 3 つ目に設定ファイルを渡す（PatchiriWebMethods.Call("describe", req, "~/App_Data/sales.config.json")）。
    // 「誰が」を Session から取るアプリは、Global.asax で PatchiriWebMethods.WhoAmI を差し替え、
    // [WebMethod(EnableSession = true)] と、ページの EnableSessionState="ReadOnly" にする（README の「誰が反映したか」）。

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

    // WebMethod 以外の呼び出し（ページそのもの）: GET は画面、application/json でない POST は 415、ほかは 404。
    protected void Page_Load(object sender, EventArgs e)
    {
        PatchiriScreen.Write(Context);
        Response.End();
    }
</script>
