<%@ Page Language="C#" EnableSessionState="False" %>
<%@ Import Namespace="System.Collections.Generic" %>
<%@ Import Namespace="System.Configuration" %>
<%@ Import Namespace="System.Data.Common" %>
<%@ Import Namespace="System.Web.Services" %>
<script runat="server">
    // テスト用のページ。patchiri と同じ接続文字列でプールから接続を 4 本取り、セッションの NLS の設定を返す。
    // patchiri がそろえたセッションの設定（NLS_COMP など）を、接続をプールに返す前に戻したかを見る（載せ先のアプリと同じプールを使いうるため）。

    [WebMethod]
    public static List<string> Sessions()
    {
        var cs = ConfigurationManager.ConnectionStrings["Patchiri"].ConnectionString;
        var factory = (DbProviderFactory)Type.GetType("Oracle.ManagedDataAccess.Client.OracleClientFactory, Oracle.ManagedDataAccess", true).GetField("Instance").GetValue(null);
        var conns = new List<DbConnection>();
        var output = new List<string>();
        try
        {
            for (var i = 0; i < 4; i++)
            {
                var c = factory.CreateConnection();
                c.ConnectionString = cs;
                c.Open();
                conns.Add(c);
            }
            foreach (var c in conns)
            {
                var cmd = c.CreateCommand();
                cmd.CommandText = "SELECT LISTAGG(parameter || '=' || value, ';') WITHIN GROUP (ORDER BY parameter) FROM nls_session_parameters WHERE parameter IN ('NLS_COMP', 'NLS_SORT', 'NLS_NUMERIC_CHARACTERS')";
                output.Add((string)cmd.ExecuteScalar());
            }
        }
        finally
        {
            foreach (var c in conns) c.Dispose();
        }
        return output;
    }
</script>
