// テスト用の ASP.NET ホスト。Mono の System.Web で .aspx を動かし、HttpListener で受ける。
// （Ubuntu の xsp4 は今の Mono では起動しないので、ApplicationHost で同じことをする）
//   mono Patchiri.TestHost.exe <Web のフォルダ> <ポート>
// Web のフォルダの bin にこの exe を置くこと（ApplicationHost が AspHost を読み込むため）。

using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Threading;
using System.Web;
using System.Web.Hosting;

[Serializable]
public class HostResponse
{
    public int Status = 200;
    public List<string> HeaderNames = new List<string>();
    public List<string> HeaderValues = new List<string>();
    public byte[] Body;
}

/// <summary>アプリの AppDomain の中で 1 件の要求を流す。</summary>
public class AspHost : MarshalByRefObject
{
    public override object InitializeLifetimeService()
    {
        return null;
    }

    public HostResponse Process(string verb, string path, string query, string[] names, string[] values, byte[] body)
    {
        var wr = new Worker(verb, path, query, names, values, body);
        HttpRuntime.ProcessRequest(wr);
        wr.Done.WaitOne();
        return wr.Result;
    }
}

class Worker : SimpleWorkerRequest
{
    readonly string verb;
    readonly string path;
    readonly string query;
    readonly string[] names;
    readonly string[] values;
    readonly byte[] body;
    readonly MemoryStream output = new MemoryStream();
    public readonly ManualResetEvent Done = new ManualResetEvent(false);
    public readonly HostResponse Result = new HostResponse();

    public Worker(string verb, string path, string query, string[] names, string[] values, byte[] body)
        : base(path.TrimStart('/'), query, new StringWriter())
    {
        this.verb = verb;
        this.path = path;
        this.query = query;
        this.names = names;
        this.values = values;
        this.body = body;
    }

    string Header(string name)
    {
        for (var i = 0; i < names.Length; i++) if (string.Equals(names[i], name, StringComparison.OrdinalIgnoreCase)) return values[i];
        return null;
    }

    public override string GetHttpVerbName() { return verb; }
    public override string GetUriPath() { return path; }
    public override string GetRawUrl() { return string.IsNullOrEmpty(query) ? path : path + "?" + query; }
    public override string GetKnownRequestHeader(int index) { return Header(GetKnownRequestHeaderName(index)); }
    public override string GetUnknownRequestHeader(string name) { return Header(name); }

    public override string[][] GetUnknownRequestHeaders()
    {
        var list = new List<string[]>();
        for (var i = 0; i < names.Length; i++) if (GetKnownRequestHeaderIndex(names[i]) < 0) list.Add(new[] { names[i], values[i] });
        return list.ToArray();
    }

    public override byte[] GetPreloadedEntityBody() { return body; }
    public override int GetPreloadedEntityBodyLength() { return body == null ? 0 : body.Length; }
    public override bool IsEntireEntityBodyIsPreloaded() { return true; }
    public override int ReadEntityBody(byte[] buffer, int size) { return 0; }
    public override void SendStatus(int statusCode, string statusDescription) { Result.Status = statusCode; }

    public override void SendKnownResponseHeader(int index, string value)
    {
        Result.HeaderNames.Add(GetKnownResponseHeaderName(index));
        Result.HeaderValues.Add(value);
    }

    public override void SendUnknownResponseHeader(string name, string value)
    {
        Result.HeaderNames.Add(name);
        Result.HeaderValues.Add(value);
    }

    public override void SendResponseFromMemory(byte[] data, int length) { output.Write(data, 0, length); }
    public override void FlushResponse(bool finalFlush) { }

    public override void EndOfRequest()
    {
        Result.Body = output.ToArray();
        Done.Set();
    }
}

public static class Program
{
    public static void Main(string[] args)
    {
        var root = Path.GetFullPath(args[0]);
        var port = int.Parse(args[1]);
        var host = (AspHost)ApplicationHost.CreateApplicationHost(typeof(AspHost), "/", root);
        var listener = new HttpListener();
        listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
        listener.Start();
        Console.WriteLine("listening http://127.0.0.1:" + port + "/");
        while (true)
        {
            var ctx = listener.GetContext();
            ThreadPool.QueueUserWorkItem(_ => Serve(host, ctx));
        }
    }

    static void Serve(AspHost host, HttpListenerContext ctx)
    {
        try
        {
            var req = ctx.Request;
            var ms = new MemoryStream();
            req.InputStream.CopyTo(ms);
            var names = req.Headers.AllKeys;
            var values = new string[names.Length];
            for (var i = 0; i < names.Length; i++) values[i] = req.Headers[names[i]];
            var r = host.Process(req.HttpMethod, req.Url.AbsolutePath, req.Url.Query.TrimStart('?'), names, values, ms.ToArray());
            ctx.Response.StatusCode = r.Status;
            for (var i = 0; i < r.HeaderNames.Count; i++)
            {
                var name = r.HeaderNames[i];
                if (string.Equals(name, "Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(name, "Content-Type", StringComparison.OrdinalIgnoreCase)) ctx.Response.ContentType = r.HeaderValues[i];
                else ctx.Response.Headers[name] = r.HeaderValues[i];
            }
            var b = r.Body ?? new byte[0];
            ctx.Response.ContentLength64 = b.Length;
            ctx.Response.OutputStream.Write(b, 0, b.Length);
            ctx.Response.Close();
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e);
            try
            {
                ctx.Response.StatusCode = 500;
                ctx.Response.Close();
            }
            catch (Exception)
            {
                // 相手が切った。
            }
        }
    }
}
