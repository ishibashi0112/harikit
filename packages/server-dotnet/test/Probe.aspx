<%@ Page Language="C#" EnableSessionState="False" %>
<%@ Import Namespace="System.Collections.Generic" %>
<%@ Import Namespace="System.IO" %>
<%@ Import Namespace="System.Web.Hosting" %>
<%@ Import Namespace="System.Web.Services" %>
<%@ Import Namespace="Patchiri.Server" %>
<script runat="server">
    // テスト用のページ。.NET の文字コードでの確認を外した方言で apply を流し、
    // DB での最後の確認（CheckStrings）だけで止まるかを見る。

    sealed class DbOnlyCheckDialect : IPatchiriDialect
    {
        readonly IPatchiriDialect inner;

        public DbOnlyCheckDialect(IPatchiriDialect inner)
        {
            this.inner = inner;
        }

        public string Name { get { return inner.Name; } }
        public string NormalizeTable(string table) { return inner.NormalizeTable(table); }

        public TableMeta DescribeTable(string table)
        {
            var meta = inner.DescribeTable(table);
            foreach (var c in meta.Columns) c.ByteEncoding = null;
            return meta;
        }

        public List<Dictionary<string, object>> FetchRows(TableMeta meta, IList<string> keyColumns, IList<string> columns, IList<Dictionary<string, object>> keys) { return inner.FetchRows(meta, keyColumns, columns, keys); }
        public void RunTransaction(Func<IPatchiriTransaction, bool> fn) { inner.RunTransaction(fn); }
        public List<StringCheck> CheckStrings(TableMeta meta, IList<KeyValuePair<string, string>> items) { return inner.CheckStrings(meta, items); }
        public string RenderScript(TableMeta meta, string head, IList<ScriptUpdate> updates, string kind) { return inner.RenderScript(meta, head, updates, kind); }
    }

    [WebMethod]
    public static Dictionary<string, object> Apply(Dictionary<string, object> req)
    {
        var config = PatchiriConfig.Parse(File.ReadAllText(HostingEnvironment.MapPath("~/App_Data/patchiri.config.json")));
        var service = new PatchiriService(new PatchiriServiceOptions
        {
            Config = config,
            Dialect = new DbOnlyCheckDialect(PatchiriWebMethods.CreateDialect(config)),
            WhoAmI = () => "probe",
        });
        return service.Handle("apply", req);
    }
</script>
