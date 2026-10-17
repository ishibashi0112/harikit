// API 3 本（describe / fetch / apply）の中身。Node 版の handlers.ts と同じ手順で動く。
// HTTP（WebMethod）と DB の違いはここの外に置く。

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using Row = System.Collections.Generic.Dictionary<string, object>;

namespace Harikit.Server
{
    /// <summary>業務上の失敗。HTTP 200 の ok:false で返す（仕様 1.5）。</summary>
    public class HarikitFailure : Exception
    {
        public readonly string Code;
        public Dictionary<string, object> Details;
        public List<object> RowErrors;
        public List<object> Conflicts;

        public HarikitFailure(string code, string message) : base(message)
        {
            Code = code;
        }
    }

    public sealed class HarikitServiceOptions
    {
        public HarikitConfig Config;
        public IHarikitDialect Dialect;
        /// <summary>反映した人。WebForms では HttpContext.Current.User.Identity.Name。</summary>
        public Func<string> WhoAmI;
        /// <summary>反映ログを 1 件書く。</summary>
        public Action<Dictionary<string, object>> Log;
        /// <summary>サーバ側のエラーを残す。</summary>
        public Action<Exception> LogError;
        public Func<DateTime> Now;
        /// <summary>
        /// 返せる JSON の長さ（文字数）。WebMethod の maxJsonLength。超える結果は ASP.NET が返せず HTTP 500 になるので、
        /// apply は DB を変える前に確かめて止める（コミットした後に戻し SQL が返らない、を避ける）。null なら見ない。
        /// </summary>
        public int? MaxResponseLength;
    }

    public sealed class HarikitService
    {
        static readonly Regex RequestIdRe = new Regex(@"\A[0-9A-Za-z][0-9A-Za-z-]{7,63}\z");
        /// <summary>二度押し・再送対策に覚えておく execute の結果の数。</summary>
        const int AppliedKeep = 100;

        sealed class Resolved
        {
            public string Name;
            public TargetConfig Target;
            public TableMeta Meta;
            public List<string> Key;
            public List<ColumnMeta> KeyColumns;
            /// <summary>readable の列（DB の列順）。</summary>
            public List<ColumnMeta> Columns;
            public HashSet<string> Updatable;
            /// <summary>小文字の列名 → 列。</summary>
            public Dictionary<string, ColumnMeta> ByName;

            public ColumnMeta Find(string name)
            {
                ColumnMeta c;
                return name != null && ByName.TryGetValue(name.ToLowerInvariant(), out c) ? c : null;
            }
        }

        sealed class KeyResult
        {
            public Row Key;
            public string ErrorCode;
            public string ErrorColumn;
            public string ErrorMessage;
        }

        sealed class ApplyRow
        {
            public Row Key;
            public Row Before;
            public Row After;
        }

        readonly HarikitServiceOptions o;
        readonly object sync = new object();
        readonly Dictionary<string, TableMeta> metaCache = new Dictionary<string, TableMeta>(StringComparer.Ordinal);
        readonly Dictionary<string, Dictionary<string, object>> applied = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
        readonly Queue<string> appliedOrder = new Queue<string>();

        public HarikitService(HarikitServiceOptions options)
        {
            if (options.Config == null || options.Dialect == null) throw new ArgumentException("Config と Dialect は必須です");
            o = options;
        }

        public Dictionary<string, object> Handle(string name, object body)
        {
            try
            {
                var b = HarikitJson.AsObject(body);
                if (b == null) throw new HarikitFailure("bad_request", "リクエストが JSON のオブジェクトではありません");
                var v = HarikitJson.Get(b, "v");
                if (!HarikitJson.IsNumber(v) || HarikitJson.ToDouble(v) != 1)
                    throw new HarikitFailure("version_unsupported", "v=" + Show(v) + " には対応していません（1 だけ）");
                if (name == "describe") return Describe(b);
                if (name == "fetch") return Fetch(b);
                if (name == "apply") return Apply(b);
                throw new HarikitFailure("bad_request", "API " + name + " はありません");
            }
            catch (Exception e)
            {
                return Failure(e, body);
            }
        }

        static string Show(object v)
        {
            if (v == null) return "null";
            if (v is string) return HarikitJson.Stringify(v);
            if (v is bool) return (bool)v ? "true" : "false";
            if (HarikitJson.IsNumber(v)) return HarikitJson.ToDouble(v).ToString("R", CultureInfo.InvariantCulture);
            return HarikitJson.Stringify(v);
        }

        static Dictionary<string, object> Ok()
        {
            return new Dictionary<string, object> { { "ok", true }, { "v", 1 } };
        }

        Dictionary<string, object> Failure(Exception e, object body)
        {
            var error = new Dictionary<string, object>();
            var f = e as HarikitFailure;
            if (f != null)
            {
                error["code"] = f.Code;
                error["message"] = f.Message;
                if (f.Details != null) error["details"] = f.Details;
            }
            else if (e is HarikitDbException)
            {
                LogError(e);
                error["code"] = "db_error";
                error["message"] = o.Config.ExposeDbErrors ? e.Message : "DB がエラーを返しました（詳細はサーバのログ）";
            }
            else
            {
                LogError(e);
                error["code"] = "internal_error";
                error["message"] = "サーバでエラーが起きました（詳細はサーバのログ）";
            }
            var res = new Dictionary<string, object> { { "ok", false }, { "v", 1 } };
            var b = HarikitJson.AsObject(body);
            var requestId = HarikitJson.Get(b, "requestId") as string;
            if (requestId != null) res["requestId"] = requestId;
            var mode = HarikitJson.Get(b, "mode") as string;
            if (mode == "check" || mode == "execute") res["mode"] = mode;
            res["error"] = error;
            if (f != null && f.RowErrors != null) res["rowErrors"] = f.RowErrors;
            if (f != null && f.Conflicts != null) res["conflicts"] = f.Conflicts;
            return res;
        }

        void LogError(Exception e)
        {
            if (o.LogError == null) return;
            try
            {
                o.LogError(e);
            }
            catch
            {
                // エラーの記録に失敗しても、返す結果は変えない。
            }
        }

        TableMeta GetMeta(string table)
        {
            lock (sync)
            {
                TableMeta m;
                if (metaCache.TryGetValue(table, out m)) return m;
            }
            var meta = o.Dialect.DescribeTable(table);
            lock (sync) metaCache[table] = meta;
            return meta;
        }

        Resolved Resolve(object nameObj)
        {
            var name = nameObj as string;
            if (name == null || !o.Config.Targets.ContainsKey(name))
            {
                throw new HarikitFailure("unknown_target", "ターゲット " + (name ?? Show(nameObj)) + " はありません")
                {
                    Details = new Dictionary<string, object> { { "target", nameObj } },
                };
            }
            var target = o.Config.Targets[name];
            var meta = GetMeta(target.Table);
            var dbCols = new Dictionary<string, ColumnMeta>();
            foreach (var c in meta.Columns) dbCols[c.Name.ToLowerInvariant()] = c;
            Func<List<string>, List<string>> pick = list =>
            {
                var names = new List<string>();
                foreach (var c in list)
                {
                    ColumnMeta col;
                    if (!dbCols.TryGetValue(c.ToLowerInvariant(), out col))
                        throw new InvalidOperationException("許可リストの列 " + name + "." + c + " が " + meta.Table + " にありません");
                    names.Add(col.Name);
                }
                return names;
            };
            var readable = new HashSet<string>(pick(target.Readable));
            var key = target.Key != null ? pick(target.Key) : new List<string>(meta.PrimaryKey);
            if (key.Count == 0) throw new InvalidOperationException(name + " のキーがわかりません（主キーがないので key を設定してください）");
            foreach (var k in key) if (!readable.Contains(k)) throw new InvalidOperationException(name + " のキー列 " + k + " が readable にありません");
            var allowed = new HashSet<string>(target.Access == "update" ? pick(target.Updatable) : new List<string>());
            var r = new Resolved
            {
                Name = name,
                Target = target,
                Meta = meta,
                Key = key,
                KeyColumns = meta.ColumnsOf(key),
                Columns = new List<ColumnMeta>(),
                Updatable = new HashSet<string>(),
                ByName = new Dictionary<string, ColumnMeta>(),
            };
            foreach (var c in meta.Columns)
            {
                if (!readable.Contains(c.Name)) continue;
                r.Columns.Add(c);
                r.ByName[c.Name.ToLowerInvariant()] = c;
                if (allowed.Contains(c.Name) && !key.Contains(c.Name) && c.Type != "other" && !c.Identity && !c.Computed) r.Updatable.Add(c.Name);
            }
            return r;
        }

        Dictionary<string, object> Limits()
        {
            return new Dictionary<string, object> { { "maxFetchKeys", o.Config.MaxFetchKeys }, { "maxApplyRows", o.Config.MaxApplyRows } };
        }

        Dictionary<string, object> Describe(IDictionary<string, object> body)
        {
            if (!body.ContainsKey("target"))
            {
                var targets = new List<object>();
                foreach (var name in o.Config.TargetNames)
                {
                    var t = o.Config.Targets[name];
                    targets.Add(new Dictionary<string, object> { { "target", name }, { "table", t.Table }, { "access", t.Access } });
                }
                var list = Ok();
                list["targets"] = targets;
                return list;
            }
            var r = Resolve(body["target"]);
            var columns = new List<object>();
            var readableNames = new HashSet<string>();
            foreach (var c in r.Columns)
            {
                readableNames.Add(c.Name);
                // 方言が内部用に持つ項目は出さない。
                var col = new Dictionary<string, object>
                {
                    { "name", c.Name },
                    { "type", c.Type },
                    { "dbType", c.DbType },
                    { "nullable", c.Nullable },
                    { "updatable", r.Updatable.Contains(c.Name) },
                };
                if (c.MaxLength.HasValue) col["maxLength"] = c.MaxLength.Value;
                if (c.MaxBytes.HasValue) col["maxBytes"] = c.MaxBytes.Value;
                if (c.Encoding != null) col["encoding"] = c.Encoding;
                if (c.Precision.HasValue) col["precision"] = c.Precision.Value;
                if (c.Scale.HasValue) col["scale"] = c.Scale.Value;
                if (c.Identity) col["identity"] = true;
                if (c.Computed) col["computed"] = true;
                if (c.HasDefault) col["hasDefault"] = true;
                columns.Add(col);
            }
            var foreignKeys = new List<object>();
            foreach (var fk in r.Meta.ForeignKeys)
            {
                if (!fk.Columns.TrueForAll(readableNames.Contains)) continue;
                foreignKeys.Add(new Dictionary<string, object>
                {
                    { "name", fk.Name },
                    { "columns", new List<string>(fk.Columns) },
                    { "referencedTable", fk.ReferencedTable },
                    { "referencedColumns", new List<string>(fk.ReferencedColumns) },
                    { "referencedTarget", FindReferenceTarget(fk.ReferencedTable, fk.ReferencedColumns) },
                });
            }
            var res = Ok();
            res["target"] = r.Name;
            res["table"] = r.Target.Table;
            res["access"] = r.Target.Access;
            res["dialect"] = o.Dialect.Name;
            res["key"] = new List<string>(r.Key);
            res["columns"] = columns;
            res["foreignKeys"] = foreignKeys;
            res["limits"] = Limits();
            return res;
        }

        /// <summary>参照先テーブルを、キーがちょうど参照先の列になっている読めるターゲットから探す。</summary>
        string FindReferenceTarget(string table, List<string> columns)
        {
            string want;
            try
            {
                want = o.Dialect.NormalizeTable(table);
            }
            catch (Exception)
            {
                // 参照先の名前が読めない（参照先に権限がないなど）ときは「確認できない」扱いにする。
                return null;
            }
            var cols = new HashSet<string>();
            foreach (var c in columns) cols.Add(c.ToLowerInvariant());
            foreach (var name in o.Config.TargetNames)
            {
                try
                {
                    if (o.Dialect.NormalizeTable(o.Config.Targets[name].Table) != want) continue;
                    var r = Resolve(name);
                    if (r.Key.Count == cols.Count && r.Key.TrueForAll(k => cols.Contains(k.ToLowerInvariant()))) return name;
                }
                catch (Exception)
                {
                    // 参照先の設定がおかしいときは「確認できない」扱いにする。
                }
            }
            return null;
        }

        /// <summary>キーのオブジェクトを確かめ、列名を DB の綴りにそろえる。</summary>
        static KeyResult NormalizeKey(Resolved r, object keyObj)
        {
            var key = HarikitJson.AsObject(keyObj);
            if (key == null) return new KeyResult { ErrorCode = "key_mismatch", ErrorMessage = "キーがオブジェクトではありません" };
            var output = new Row();
            foreach (var kv in key)
            {
                var name = r.Key.Find(x => string.Equals(x, kv.Key, StringComparison.OrdinalIgnoreCase));
                if (name == null || output.ContainsKey(name))
                    return new KeyResult { ErrorCode = "key_mismatch", ErrorColumn = kv.Key, ErrorMessage = "キーに列 " + kv.Key + " は使えません" };
                var col = r.Meta.Column(name);
                var msg = kv.Value == null ? "キーが null です" : HarikitValues.CheckValue(col, kv.Value, true);
                if (msg != null) return new KeyResult { ErrorCode = "invalid_value", ErrorColumn = name, ErrorMessage = msg };
                output[name] = HarikitJson.Normalize(kv.Value);
            }
            if (output.Count != r.Key.Count)
                return new KeyResult { ErrorCode = "key_mismatch", ErrorMessage = "キーの列は " + string.Join(", ", r.Key) + " です" };
            return new KeyResult { Key = output };
        }

        Dictionary<string, object> Fetch(IDictionary<string, object> body)
        {
            var r = Resolve(HarikitJson.Get(body, "target"));
            var rawKeys = HarikitJson.AsArray(HarikitJson.Get(body, "keys"));
            if (rawKeys == null) throw new HarikitFailure("bad_request", "keys がありません");
            if (rawKeys.Count > o.Config.MaxFetchKeys)
            {
                throw new HarikitFailure("too_many_rows", "keys は " + o.Config.MaxFetchKeys + " 件までです")
                {
                    Details = new Dictionary<string, object> { { "limit", o.Config.MaxFetchKeys } },
                };
            }
            var columns = new List<string>();
            if (!body.ContainsKey("columns"))
            {
                foreach (var c in r.Columns) columns.Add(c.Name);
            }
            else
            {
                var raw = HarikitJson.AsArray(body["columns"]);
                if (raw == null) throw new HarikitFailure("bad_request", "columns は列名の配列です");
                foreach (var c in raw)
                {
                    var col = r.Find(c as string);
                    if (col == null)
                    {
                        throw new HarikitFailure("column_not_allowed", "列 " + (c as string ?? Show(c)) + " は読めません")
                        {
                            Details = new Dictionary<string, object> { { "column", c } },
                        };
                    }
                    columns.Add(col.Name);
                }
            }
            var keys = new List<Row>();
            for (var i = 0; i < rawKeys.Count; i++)
            {
                var n = NormalizeKey(r, rawKeys[i]);
                if (n.ErrorCode != null)
                {
                    throw new HarikitFailure(n.ErrorCode == "invalid_value" ? "bad_request" : n.ErrorCode, "keys[" + i + "]: " + n.ErrorMessage)
                    {
                        Details = new Dictionary<string, object> { { "index", i } },
                    };
                }
                keys.Add(n.Key);
            }
            var all = new List<string>(r.Key);
            foreach (var c in columns) if (!r.Key.Contains(c)) all.Add(c);
            var rows = keys.Count == 0 ? new List<Row>() : o.Dialect.FetchRows(r.Meta, r.Key, all, keys);
            var outRows = new List<object>();
            for (var i = 0; i < rows.Count; i++)
            {
                var row = new Dictionary<string, object> { { "index", i }, { "found", rows[i] != null } };
                if (rows[i] != null) row["values"] = rows[i];
                outRows.Add(row);
            }
            var res = Ok();
            res["target"] = r.Name;
            res["rows"] = outRows;
            EnsureFits(res, "fetch の結果が大きすぎて返せません。keys を減らすか、web.config の maxJsonLength を上げてください");
            return res;
        }

        void EnsureFits(Dictionary<string, object> result, string message)
        {
            if (!o.MaxResponseLength.HasValue) return;
            // WebMethod は {"d": 結果} で返す。
            var length = HarikitJson.Stringify(new Dictionary<string, object> { { "d", result } }).Length;
            if (length <= o.MaxResponseLength.Value) return;
            throw new HarikitFailure("too_many_rows", message)
            {
                Details = new Dictionary<string, object> { { "maxJsonLength", o.MaxResponseLength.Value }, { "length", length } },
            };
        }

        static string LocalIso(DateTime d)
        {
            return d.ToString("yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture);
        }

        Dictionary<string, object> Apply(IDictionary<string, object> body)
        {
            var requestId = HarikitJson.Get(body, "requestId") as string;
            if (requestId == null || !RequestIdRe.IsMatch(requestId)) throw new HarikitFailure("bad_request", "requestId がないか、形が違います");
            var mode = HarikitJson.Get(body, "mode") as string;
            if (mode != "check" && mode != "execute") throw new HarikitFailure("bad_request", "mode は \"check\" か \"execute\" です");
            string note = null;
            if (body.ContainsKey("note"))
            {
                note = body["note"] as string;
                if (note == null) throw new HarikitFailure("bad_request", "note は文字列です");
            }
            if (mode == "execute")
            {
                lock (sync)
                {
                    Dictionary<string, object> done;
                    if (applied.TryGetValue(requestId, out done)) return done;
                }
            }
            var changes = HarikitJson.AsArray(HarikitJson.Get(body, "changes"));
            if (changes == null || changes.Count != 1 || HarikitJson.AsObject(changes[0]) == null)
                throw new HarikitFailure("bad_request", "changes は要素 1 つの配列です（v1 は 1 テーブルだけ）");
            var change = HarikitJson.AsObject(changes[0]);
            var r = Resolve(HarikitJson.Get(change, "target"));
            if (r.Target.Access != "update") throw new HarikitFailure("bad_request", r.Name + " は読むだけのターゲットです");
            var rawRows = HarikitJson.AsArray(HarikitJson.Get(change, "rows"));
            if (rawRows == null || rawRows.Count == 0) throw new HarikitFailure("bad_request", "rows がありません");
            if (rawRows.Count > o.Config.MaxApplyRows)
            {
                throw new HarikitFailure("too_many_rows", "rows は " + o.Config.MaxApplyRows + " 行までです")
                {
                    Details = new Dictionary<string, object> { { "limit", o.Config.MaxApplyRows } },
                };
            }

            // 1. 許可リストとの照合。行ごとの誤りはまとめて返す。
            var rowErrors = new List<object>();
            var rows = new List<ApplyRow>();
            var seenKeys = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var index = 0; index < rawRows.Count; index++)
            {
                var i = index;
                Action<string, string, string> rowErr = (code, message, column) =>
                {
                    var e = new Dictionary<string, object> { { "target", r.Name }, { "index", i }, { "code", code } };
                    if (column != null) e["column"] = column;
                    e["message"] = message;
                    rowErrors.Add(e);
                };
                var raw = HarikitJson.AsObject(rawRows[index]);
                if (raw == null)
                {
                    rowErr("bad_request", "行がオブジェクトではありません", null);
                    continue;
                }
                if (raw.ContainsKey("op") && !"update".Equals(raw["op"]))
                {
                    rowErr("bad_request", "op " + (raw["op"] as string ?? Show(raw["op"])) + " には対応していません（update だけ）", null);
                    continue;
                }
                var k = NormalizeKey(r, HarikitJson.Get(raw, "key"));
                if (k.ErrorCode != null)
                {
                    rowErr(k.ErrorCode, k.ErrorMessage, k.ErrorColumn);
                    continue;
                }
                var rawBefore = HarikitJson.AsObject(HarikitJson.Get(raw, "before"));
                var rawAfter = HarikitJson.AsObject(HarikitJson.Get(raw, "after"));
                if (rawBefore == null || rawAfter == null)
                {
                    rowErr("bad_request", "before と after がありません", null);
                    continue;
                }
                var afterNames = new Dictionary<string, string>();
                foreach (var c in rawAfter.Keys) afterNames[c.ToLowerInvariant()] = c;
                if (afterNames.Count == 0)
                {
                    rowErr("bad_request", "更新する列がありません", null);
                    continue;
                }
                if (rawBefore.Count != afterNames.Count)
                {
                    rowErr("bad_request", "before と after の列が違います", null);
                    continue;
                }
                var before = new Row();
                var after = new Row();
                var bad = false;
                foreach (var kv in rawBefore)
                {
                    var col = r.Find(kv.Key);
                    if (col == null || !r.Updatable.Contains(col.Name))
                    {
                        rowErr("column_not_allowed", "列 " + kv.Key + " は更新が許可されていません", kv.Key);
                        bad = true;
                        continue;
                    }
                    string ac;
                    if (!afterNames.TryGetValue(kv.Key.ToLowerInvariant(), out ac) || before.ContainsKey(col.Name))
                    {
                        rowErr("bad_request", "before と after の列が違います", col.Name);
                        bad = true;
                        continue;
                    }
                    var bv = kv.Value;
                    var av = rawAfter[ac];
                    var bMsg = HarikitValues.CheckValue(col, bv, true);
                    var aMsg = HarikitValues.CheckValue(col, av, col.Nullable);
                    if (bMsg != null || aMsg != null)
                    {
                        rowErr("invalid_value", (bMsg != null ? "before: " + bMsg : "after: " + aMsg), col.Name);
                        bad = true;
                        continue;
                    }
                    bv = HarikitJson.Normalize(bv);
                    av = HarikitJson.Normalize(av);
                    if (HarikitValues.SameColumnValue(col, bv, av))
                    {
                        rowErr("bad_request", "before と after が同じです", col.Name);
                        bad = true;
                        continue;
                    }
                    before[col.Name] = bv;
                    after[col.Name] = av;
                }
                if (bad) continue;
                var id = HarikitValues.KeyIdentity(r.KeyColumns, k.Key);
                int seen;
                if (seenKeys.TryGetValue(id, out seen))
                {
                    rowErr("duplicate_key", seen + " 番目の行とキーが同じです", null);
                    continue;
                }
                seenKeys[id] = index;
                rows.Add(new ApplyRow { Key = k.Key, Before = before, After = after });
            }
            if (rowErrors.Count > 0)
            {
                var indexes = new HashSet<int>();
                foreach (Dictionary<string, object> e in rowErrors) indexes.Add((int)e["index"]);
                throw new HarikitFailure("bad_request", indexes.Count + " 行に誤りがあります") { RowErrors = rowErrors };
            }

            var appliedBy = o.WhoAmI != null ? o.WhoAmI() : "";
            var appliedAt = LocalIso(o.Now != null ? o.Now() : DateTime.Now);
            Func<string, Dictionary<string, object>> logEntry = outcome =>
            {
                var entry = new Dictionary<string, object> { { "requestId", requestId }, { "mode", mode } };
                if (note != null) entry["note"] = note;
                entry["appliedBy"] = appliedBy;
                entry["appliedAt"] = appliedAt;
                entry["target"] = r.Name;
                entry["table"] = r.Meta.Table;
                entry["outcome"] = outcome;
                var list = new List<object>();
                foreach (var row in rows) list.Add(new Dictionary<string, object> { { "key", row.Key }, { "before", row.Before }, { "after", row.After } });
                entry["rows"] = list;
                return entry;
            };

            // SQL の文面と返す結果は先に作る（コミットした後に失敗して戻し SQL が返らない、を避ける）。
            string script, undoScript;
            RenderScripts(r, requestId, mode, rows, out script, out undoScript);
            var result = Ok();
            result["requestId"] = requestId;
            result["mode"] = mode;
            result["appliedAt"] = appliedAt;
            result["appliedBy"] = appliedBy;
            var targetResult = new Dictionary<string, object> { { "target", r.Name }, { "updated", mode == "execute" ? rows.Count : 0 } };
            result["results"] = new List<object> { targetResult };
            result["script"] = script;
            result["undoScript"] = undoScript;
            EnsureFits(result, "反映の結果（SQL と戻し SQL）が大きすぎて返せないので、何も反映していません。行を分けるか、web.config の maxJsonLength を上げてください");

            // 2〜6. トランザクションの中で、ロックを掛けて今の値を確かめてから流す。
            var conflicts = new List<object>();
            var updated = 0;
            int[] duplicate = null;
            try
            {
                o.Dialect.RunTransaction(tx =>
                {
                    var dbKeys = new Dictionary<string, int>(StringComparer.Ordinal);
                    for (var index = 0; index < rows.Count; index++)
                    {
                        var row = rows[index];
                        var locked = tx.LockAndCompare(r.Meta, r.Key, row.Key, row.Before);
                        if (!locked.Found)
                        {
                            conflicts.Add(new Dictionary<string, object> { { "target", r.Name }, { "index", index }, { "key", row.Key }, { "reason", "not_found" } });
                            continue;
                        }
                        var dbKey = HarikitValues.KeyIdentity(r.KeyColumns, locked.DbKey);
                        int other;
                        if (dbKeys.TryGetValue(dbKey, out other))
                        {
                            duplicate = new[] { other, index };
                            return false;
                        }
                        dbKeys[dbKey] = index;
                        if (locked.Changed != null && locked.Changed.Count > 0)
                        {
                            conflicts.Add(new Dictionary<string, object>
                            {
                                { "target", r.Name },
                                { "index", index },
                                { "key", row.Key },
                                { "reason", "changed" },
                                { "columns", locked.Changed },
                                { "current", locked.Current },
                            });
                        }
                    }
                    if (conflicts.Count > 0 || mode == "check") return false;
                    foreach (var row in rows)
                    {
                        var n = tx.Update(r.Meta, r.Key, row.Key, row.After);
                        if (n != 1) throw new HarikitDbException("UPDATE の影響行数が " + n + " でした（1 のはず）: " + HarikitJson.Stringify(row.Key));
                        updated += n;
                    }
                    return true;
                });
            }
            catch (Exception e)
            {
                var entry = logEntry("error");
                entry["error"] = e.Message;
                SafeLog(entry);
                throw;
            }

            if (duplicate != null)
            {
                throw new HarikitFailure("bad_request", "1 行に誤りがあります")
                {
                    RowErrors = new List<object>
                    {
                        new Dictionary<string, object>
                        {
                            { "target", r.Name },
                            { "index", duplicate[1] },
                            { "code", "duplicate_key" },
                            { "message", duplicate[0] + " 番目の行と DB 上で同じ行を指しています" },
                        },
                    },
                };
            }
            if (conflicts.Count > 0)
            {
                var entry = logEntry("conflict");
                entry["conflicts"] = conflicts;
                SafeLog(entry);
                throw new HarikitFailure("conflict", conflicts.Count + " 行が差分を取った後に変わっていたため、何も反映していません") { Conflicts = conflicts };
            }

            targetResult["updated"] = updated;
            if (mode == "execute")
            {
                lock (sync)
                {
                    if (!applied.ContainsKey(requestId))
                    {
                        applied[requestId] = result;
                        appliedOrder.Enqueue(requestId);
                        while (appliedOrder.Count > AppliedKeep) applied.Remove(appliedOrder.Dequeue());
                    }
                }
            }
            // コミットした後なので、ログが書けなくても結果（戻し SQL）は返す。
            SafeLog(logEntry(mode == "execute" ? "applied" : "checked"));
            return result;
        }

        void SafeLog(Dictionary<string, object> entry)
        {
            if (o.Log == null) return;
            try
            {
                o.Log(entry);
            }
            catch (Exception e)
            {
                LogError(e);
            }
        }

        void RenderScripts(Resolved r, string requestId, string mode, List<ApplyRow> rows, out string script, out string undoScript)
        {
            var d = o.Dialect;
            var head = "-- harikit " + requestId + " " + r.Name + " (" + r.Meta.Table + ") " + rows.Count + "行";
            var lines = new List<string>();
            var undoLines = new List<string>();
            foreach (var row in rows)
            {
                lines.Add(d.RenderUpdate(r.Meta, row.After, Merge(row.Key, row.Before)) + ";");
                undoLines.Add(d.RenderUpdate(r.Meta, row.Before, Merge(row.Key, row.After)) + ";");
            }
            script = head + " " + (mode == "check" ? "実行予定" : "実行済み") + "\n" + Wrap(lines);
            undoScript = head + " の戻し\n-- 今の値が harikit で入れた値のままの行だけ戻す。0 行の UPDATE は、その後に別の更新が入った行。\n" + Wrap(undoLines);
        }

        static string Wrap(List<string> lines)
        {
            var all = new List<string> { "SET XACT_ABORT ON;", "BEGIN TRANSACTION;" };
            all.AddRange(lines);
            all.Add("COMMIT;");
            return string.Join("\n", all) + "\n";
        }

        static Row Merge(Row a, Row b)
        {
            var m = new Row(a);
            foreach (var kv in b) m[kv.Key] = kv.Value;
            return m;
        }
    }
}
