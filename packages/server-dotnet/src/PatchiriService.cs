// API 3 本（describe / fetch / apply）の中身。Node 版の handlers.ts と同じ手順で動く。
// HTTP（WebMethod）と DB の違いはここの外に置く。

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using Row = System.Collections.Generic.Dictionary<string, object>;

namespace Patchiri.Server
{
    /// <summary>業務上の失敗。HTTP 200 の ok:false で返す（仕様 1.5）。</summary>
    public class PatchiriFailure : Exception
    {
        public readonly string Code;
        public Dictionary<string, object> Details;
        public List<object> RowErrors;
        public List<object> Conflicts;

        public PatchiriFailure(string code, string message) : base(message)
        {
            Code = code;
        }
    }

    public sealed class PatchiriServiceOptions
    {
        public PatchiriConfig Config;
        public IPatchiriDialect Dialect;
        /// <summary>反映した人。WebForms では PatchiriWebMethods.WhoAmI（既定は HttpContext.Current.User.Identity.Name）。</summary>
        public Func<string> WhoAmI;
        /// <summary>ロールの判定（許可リストの roles）。null なら、roles を書いたターゲットは誰も使えない（閉じる側に倒す）。</summary>
        public Func<string, bool> IsInRole;
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

    public sealed class PatchiriService
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
            /// <summary>列名（DB の綴り）→ 表示名。</summary>
            public Dictionary<string, string> Labels;
            /// <summary>stamp の列（DB の綴り）と "now" / "user"。</summary>
            public List<KeyValuePair<ColumnMeta, string>> Stamp;
            /// <summary>scope（DB の綴り）。</summary>
            public Row Scope;
            /// <summary>scope のうちキーでない列。DB で行を探すときはキーに足す。</summary>
            public List<string> ScopeColumns;
            /// <summary>サーバに置いた業務ルール（rules にこのターゲットが無ければ null）。</summary>
            public object RawRules;
            public List<PatchiriRule> Rules;

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
            /// <summary>stamp の列の、反映する前の値（ロックして読んだもの。stamp を書いたターゲットだけ）。</summary>
            public Row StampBefore;
        }

        readonly PatchiriServiceOptions o;
        readonly object sync = new object();
        readonly Dictionary<string, TableMeta> metaCache = new Dictionary<string, TableMeta>(StringComparer.Ordinal);
        readonly Dictionary<string, Dictionary<string, object>> applied = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
        readonly Queue<string> appliedOrder = new Queue<string>();
        /// <summary>ターゲットごとの、使える形にした業務ルール（テーブル定義の覚えと同じく、設定を読み直すまで持つ）。</summary>
        readonly Dictionary<string, List<PatchiriRule>> rulesCache = new Dictionary<string, List<PatchiriRule>>(StringComparer.Ordinal);

        public PatchiriService(PatchiriServiceOptions options)
        {
            if (options.Config == null || options.Dialect == null) throw new ArgumentException("Config と Dialect は必須です");
            o = options;
        }

        public Dictionary<string, object> Handle(string name, object body)
        {
            try
            {
                var b = PatchiriJson.AsObject(body);
                if (b == null) throw new PatchiriFailure("bad_request", "リクエストが JSON のオブジェクトではありません");
                var v = PatchiriJson.Get(b, "v");
                if (!PatchiriJson.IsNumber(v) || PatchiriJson.ToDouble(v) != 1)
                    throw new PatchiriFailure("version_unsupported", "v=" + Show(v) + " には対応していません（1 だけ）");
                if (name == "describe") return Describe(b);
                if (name == "fetch") return Fetch(b);
                if (name == "apply") return Apply(b);
                throw new PatchiriFailure("bad_request", "API " + name + " はありません");
            }
            catch (Exception e)
            {
                return Failure(e, body);
            }
        }

        static string Show(object v)
        {
            if (v == null) return "null";
            if (v is string) return PatchiriJson.Stringify(v);
            if (v is bool) return (bool)v ? "true" : "false";
            if (PatchiriJson.IsNumber(v)) return PatchiriJson.FormatDouble(PatchiriJson.ToDouble(v));
            return PatchiriJson.Stringify(v);
        }

        static Dictionary<string, object> Ok()
        {
            return new Dictionary<string, object> { { "ok", true }, { "v", 1 } };
        }

        Dictionary<string, object> Failure(Exception e, object body)
        {
            var error = new Dictionary<string, object>();
            var f = e as PatchiriFailure;
            if (f != null)
            {
                error["code"] = f.Code;
                error["message"] = f.Message;
                if (f.Details != null) error["details"] = f.Details;
            }
            else if (e is PatchiriDbException)
            {
                LogError(e);
                error["code"] = "db_error";
                error["message"] = o.Config.ExposeDbErrors ? e.Message : (((PatchiriDbException)e).PublicMessage ?? "DB がエラーを返しました（詳細はサーバのログ）");
            }
            else
            {
                LogError(e);
                error["code"] = "internal_error";
                error["message"] = "サーバでエラーが起きました（詳細はサーバのログ）";
            }
            var res = new Dictionary<string, object> { { "ok", false }, { "v", 1 } };
            var b = PatchiriJson.AsObject(body);
            var requestId = PatchiriJson.Get(b, "requestId") as string;
            if (requestId != null) res["requestId"] = requestId;
            var mode = PatchiriJson.Get(b, "mode") as string;
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

        /// <summary>ターゲットを使えるか（roles）。roles を書いていなければ誰でも。判定の手段がなければ使えない。</summary>
        bool Allowed(TargetConfig target)
        {
            if (target.Roles == null) return true;
            if (o.IsInRole == null) return false;
            foreach (var role in target.Roles) if (o.IsInRole(role)) return true;
            return false;
        }

        Resolved Resolve(object nameObj)
        {
            var name = nameObj as string;
            if (name == null || !o.Config.Targets.ContainsKey(name))
            {
                throw new PatchiriFailure("unknown_target", "ターゲット " + (name ?? Show(nameObj)) + " はありません")
                {
                    Details = new Dictionary<string, object> { { "target", nameObj } },
                };
            }
            var target = o.Config.Targets[name];
            if (!Allowed(target))
            {
                throw new PatchiriFailure("forbidden", "ターゲット " + name + " を使う権限がありません")
                {
                    Details = new Dictionary<string, object> { { "target", name } },
                };
            }
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
            r.Labels = new Dictionary<string, string>();
            foreach (var kv in target.Labels) r.Labels[pick(new List<string> { kv.Key })[0]] = kv.Value;
            r.Stamp = new List<KeyValuePair<ColumnMeta, string>>();
            foreach (var kv in target.Stamp)
            {
                ColumnMeta col;
                if (!dbCols.TryGetValue(kv.Key.ToLowerInvariant(), out col))
                    throw new InvalidOperationException("許可リストの列 " + name + ".stamp." + kv.Key + " が " + meta.Table + " にありません");
                if (key.Contains(col.Name)) throw new InvalidOperationException(name + " のキー列 " + col.Name + " は stamp にできません");
                if (col.Identity || col.Computed) throw new InvalidOperationException(name + ".stamp の " + col.Name + " は自動で入る列（IDENTITY や計算列）です");
                if (kv.Value == "now" && o.Dialect.NowExpression(col) == null)
                    throw new InvalidOperationException(name + ".stamp の " + col.Name + " は日付・時刻の列ではありません（\"now\" は日付・時刻の列だけ）");
                if (kv.Value == "user" && col.Type != "string")
                    throw new InvalidOperationException(name + ".stamp の " + col.Name + " は文字列の列ではありません（\"user\" は文字列の列だけ）");
                r.Stamp.Add(new KeyValuePair<ColumnMeta, string>(col, kv.Value));
            }
            r.Scope = new Row();
            r.ScopeColumns = new List<string>();
            foreach (var kv in target.Scope)
            {
                ColumnMeta col;
                if (!dbCols.TryGetValue(kv.Key.ToLowerInvariant(), out col))
                    throw new InvalidOperationException("許可リストの列 " + name + ".scope." + kv.Key + " が " + meta.Table + " にありません");
                var msg = PatchiriValues.CheckValue(col, kv.Value, false);
                if (msg != null) throw new InvalidOperationException(name + ".scope." + col.Name + " の値が列に合いません（" + msg + "）");
                r.Scope[col.Name] = kv.Value;
                if (!key.Contains(col.Name)) r.ScopeColumns.Add(col.Name);
            }
            if (o.Config.Rules != null && o.Config.Rules.ContainsKey(name))
            {
                r.RawRules = o.Config.Rules[name];
                lock (sync)
                {
                    List<PatchiriRule> cached;
                    if (rulesCache.TryGetValue(name, out cached)) r.Rules = cached;
                }
                if (r.Rules == null)
                {
                    var errors = new List<string>();
                    var compiled = PatchiriRules.Compile(name, r.Columns, r.RawRules, "サーバの業務ルール", errors);
                    if (errors.Count > 0) throw new InvalidOperationException("rules.targets." + name + " の誤り: " + string.Join(" / ", errors));
                    lock (sync) rulesCache[name] = compiled;
                    r.Rules = compiled;
                }
            }
            return r;
        }

        /// <summary>キーが scope の中か（scope に書いたキー列は、その値と厳密に同じでなければ外）。</summary>
        static bool InScope(Resolved r, Row key)
        {
            foreach (var k in r.Key)
            {
                if (!r.Scope.ContainsKey(k)) continue;
                if (!PatchiriValues.SameColumnValue(r.Meta.Column(k), key[k], r.Scope[k])) return false;
            }
            return true;
        }

        /// <summary>DB で行を探すときのキーの列（キーに scope の列を足したもの）。</summary>
        static List<string> DbKeyColumns(Resolved r)
        {
            var list = new List<string>(r.Key);
            list.AddRange(r.ScopeColumns);
            return list;
        }

        /// <summary>DB で行を探すときのキー（scope の値を足したもの）。</summary>
        static Row DbKey(Resolved r, Row key)
        {
            var output = new Row(key);
            foreach (var c in r.ScopeColumns) output[c] = r.Scope[c];
            return output;
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
                    // 使えないターゲットは一覧に出さない（roles）。
                    if (!Allowed(t)) continue;
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
                if (c.EmptyIsNull) col["emptyIsNull"] = true;
                if (c.Precision.HasValue) col["precision"] = c.Precision.Value;
                if (c.Scale.HasValue) col["scale"] = c.Scale.Value;
                if (c.Identity) col["identity"] = true;
                if (c.Computed) col["computed"] = true;
                if (c.HasDefault) col["hasDefault"] = true;
                string label;
                if (r.Labels.TryGetValue(c.Name, out label)) col["label"] = label;
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
            res["table"] = r.Meta.Table;
            res["access"] = r.Target.Access;
            res["dialect"] = o.Dialect.Name;
            res["key"] = new List<string>(r.Key);
            res["columns"] = columns;
            res["foreignKeys"] = foreignKeys;
            res["limits"] = Limits();
            if (r.RawRules != null) res["rules"] = r.RawRules;
            if (r.Stamp.Count > 0)
            {
                var stamp = new List<object>();
                foreach (var kv in r.Stamp) stamp.Add(new Dictionary<string, object> { { "column", kv.Key.Name }, { "value", kv.Value } });
                res["stamp"] = stamp;
            }
            if (r.Scope.Count > 0)
            {
                var scope = new Dictionary<string, object>();
                foreach (var kv in r.Scope) scope[kv.Key] = kv.Value is double ? PatchiriJson.JsonNumber((double)kv.Value) : kv.Value;
                res["scope"] = scope;
            }
            return res;
        }

        /// <summary>
        /// 参照先テーブルを、キーがちょうど参照先の列になっている読めるターゲットから探す。
        /// テーブルは DB で引いた名前で比べる（Oracle のシノニムや既定のスキーマで書いたターゲットも当たるように）。
        /// </summary>
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
                    // 使えないターゲット（roles）も「確認できない」扱いになる。
                    var r = Resolve(name);
                    if (o.Dialect.NormalizeTable(r.Meta.Table) != want) continue;
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
            var key = PatchiriJson.AsObject(keyObj);
            if (key == null) return new KeyResult { ErrorCode = "key_mismatch", ErrorMessage = "キーがオブジェクトではありません" };
            var output = new Row();
            foreach (var kv in key)
            {
                var name = r.Key.Find(x => string.Equals(x, kv.Key, StringComparison.OrdinalIgnoreCase));
                if (name == null || output.ContainsKey(name))
                    return new KeyResult { ErrorCode = "key_mismatch", ErrorColumn = kv.Key, ErrorMessage = "キーに列 " + kv.Key + " は使えません" };
                var col = r.Meta.Column(name);
                var msg = kv.Value == null ? "キーが null です" : PatchiriValues.CheckValue(col, kv.Value, true);
                if (msg != null) return new KeyResult { ErrorCode = "invalid_value", ErrorColumn = name, ErrorMessage = msg };
                output[name] = PatchiriJson.Normalize(kv.Value);
            }
            if (output.Count != r.Key.Count)
                return new KeyResult { ErrorCode = "key_mismatch", ErrorMessage = "キーの列は " + string.Join(", ", r.Key) + " です" };
            return new KeyResult { Key = output };
        }

        Dictionary<string, object> Fetch(IDictionary<string, object> body)
        {
            var r = Resolve(PatchiriJson.Get(body, "target"));
            var rawKeys = PatchiriJson.AsArray(PatchiriJson.Get(body, "keys"));
            if (rawKeys == null) throw new PatchiriFailure("bad_request", "keys がありません");
            if (rawKeys.Count > o.Config.MaxFetchKeys)
            {
                throw new PatchiriFailure("too_many_rows", "keys は " + o.Config.MaxFetchKeys + " 件までです")
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
                var raw = PatchiriJson.AsArray(body["columns"]);
                if (raw == null) throw new PatchiriFailure("bad_request", "columns は列名の配列です");
                foreach (var c in raw)
                {
                    var col = r.Find(c as string);
                    if (col == null)
                    {
                        throw new PatchiriFailure("column_not_allowed", "列 " + (c as string ?? Show(c)) + " は読めません")
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
                    throw new PatchiriFailure(n.ErrorCode == "invalid_value" ? "bad_request" : n.ErrorCode, "keys[" + i + "]: " + n.ErrorMessage)
                    {
                        Details = new Dictionary<string, object> { { "index", i } },
                    };
                }
                keys.Add(n.Key);
            }
            var all = new List<string>(r.Key);
            foreach (var c in columns) if (!r.Key.Contains(c)) all.Add(c);
            // scope の外のキーは DB に聞かずに「見つからない」。値にはキーと頼んだ列だけを返す（scope の列は出さない）。
            var asked = new List<int>();
            var askedKeys = new List<Row>();
            for (var i = 0; i < keys.Count; i++)
            {
                if (!InScope(r, keys[i])) continue;
                asked.Add(i);
                askedKeys.Add(DbKey(r, keys[i]));
            }
            var found = askedKeys.Count == 0 ? new List<Row>() : o.Dialect.FetchRows(r.Meta, DbKeyColumns(r), all, askedKeys);
            var rows = new List<Row>();
            for (var i = 0; i < keys.Count; i++) rows.Add(null);
            for (var j = 0; j < asked.Count; j++)
            {
                if (found[j] == null) continue;
                var values = new Row();
                foreach (var c in all)
                {
                    object v;
                    found[j].TryGetValue(c, out v);
                    values[c] = v;
                }
                rows[asked[j]] = values;
            }
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

        const string ApplyTooLarge = "反映の結果（SQL と戻し SQL）が大きすぎて返せないので、何も反映していません。行を分けるか、web.config の maxJsonLength を上げてください";

        /// <summary>WebMethod で返せる長さか（WebMethod は {"d": 結果} で返す）。</summary>
        int ResponseLength(Dictionary<string, object> result)
        {
            return PatchiriJson.Stringify(new Dictionary<string, object> { { "d", result } }).Length;
        }

        bool Fits(Dictionary<string, object> result)
        {
            return !o.MaxResponseLength.HasValue || ResponseLength(result) <= o.MaxResponseLength.Value;
        }

        void EnsureFits(Dictionary<string, object> result, string message)
        {
            if (!o.MaxResponseLength.HasValue) return;
            var length = ResponseLength(result);
            if (length <= o.MaxResponseLength.Value) return;
            throw new PatchiriFailure("too_many_rows", message)
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
            var requestId = PatchiriJson.Get(body, "requestId") as string;
            if (requestId == null || !RequestIdRe.IsMatch(requestId)) throw new PatchiriFailure("bad_request", "requestId がないか、形が違います");
            var mode = PatchiriJson.Get(body, "mode") as string;
            if (mode != "check" && mode != "execute") throw new PatchiriFailure("bad_request", "mode は \"check\" か \"execute\" です");
            string note = null;
            if (body.ContainsKey("note"))
            {
                note = body["note"] as string;
                if (note == null) throw new PatchiriFailure("bad_request", "note は文字列です");
            }
            if (mode == "execute")
            {
                lock (sync)
                {
                    Dictionary<string, object> done;
                    if (applied.TryGetValue(requestId, out done)) return done;
                }
            }
            var changes = PatchiriJson.AsArray(PatchiriJson.Get(body, "changes"));
            if (changes == null || changes.Count != 1 || PatchiriJson.AsObject(changes[0]) == null)
                throw new PatchiriFailure("bad_request", "changes は要素 1 つの配列です（v1 は 1 テーブルだけ）");
            var change = PatchiriJson.AsObject(changes[0]);
            var r = Resolve(PatchiriJson.Get(change, "target"));
            if (r.Target.Access != "update") throw new PatchiriFailure("bad_request", r.Name + " は読むだけのターゲットです");
            var rawRows = PatchiriJson.AsArray(PatchiriJson.Get(change, "rows"));
            if (rawRows == null || rawRows.Count == 0) throw new PatchiriFailure("bad_request", "rows がありません");
            if (rawRows.Count > o.Config.MaxApplyRows)
            {
                throw new PatchiriFailure("too_many_rows", "rows は " + o.Config.MaxApplyRows + " 行までです")
                {
                    Details = new Dictionary<string, object> { { "limit", o.Config.MaxApplyRows } },
                };
            }

            // 1. 許可リストとの照合。行ごとの誤りはまとめて返す。
            var rowErrors = new List<object>();
            var rows = new List<ApplyRow>();
            var rowIndexes = new List<int>();
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
                var raw = PatchiriJson.AsObject(rawRows[index]);
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
                var k = NormalizeKey(r, PatchiriJson.Get(raw, "key"));
                if (k.ErrorCode != null)
                {
                    rowErr(k.ErrorCode, k.ErrorMessage, k.ErrorColumn);
                    continue;
                }
                var rawBefore = PatchiriJson.AsObject(PatchiriJson.Get(raw, "before"));
                var rawAfter = PatchiriJson.AsObject(PatchiriJson.Get(raw, "after"));
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
                    var bMsg = PatchiriValues.CheckValue(col, bv, true);
                    var aMsg = PatchiriValues.CheckValue(col, av, col.Nullable);
                    if (bMsg != null || aMsg != null)
                    {
                        rowErr("invalid_value", (bMsg != null ? "before: " + bMsg : "after: " + aMsg), col.Name);
                        bad = true;
                        continue;
                    }
                    bv = PatchiriJson.Normalize(bv);
                    av = PatchiriJson.Normalize(av);
                    if (PatchiriValues.SameColumnValue(col, bv, av))
                    {
                        rowErr("bad_request", "before と after が同じです", col.Name);
                        bad = true;
                        continue;
                    }
                    before[col.Name] = bv;
                    after[col.Name] = av;
                }
                if (bad) continue;
                var id = PatchiriValues.KeyIdentity(r.KeyColumns, k.Key);
                int seen;
                if (seenKeys.TryGetValue(id, out seen))
                {
                    rowErr("duplicate_key", seen + " 番目の行とキーが同じです", null);
                    continue;
                }
                seenKeys[id] = index;
                rows.Add(new ApplyRow { Key = k.Key, Before = before, After = after });
                rowIndexes.Add(index);
            }
            if (rowErrors.Count == 0) rowErrors.AddRange(CheckStrings(r, rows, rowIndexes));
            if (rowErrors.Count > 0)
            {
                var indexes = new HashSet<int>();
                foreach (Dictionary<string, object> e in rowErrors) indexes.Add((int)e["index"]);
                throw new PatchiriFailure("bad_request", indexes.Count + " 行に誤りがあります") { RowErrors = rowErrors };
            }

            var appliedBy = o.WhoAmI != null ? o.WhoAmI() : "";
            CheckStampUser(r, appliedBy);
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
                foreach (var row in rows)
                {
                    var item = new Dictionary<string, object> { { "key", row.Key }, { "before", row.Before }, { "after", row.After } };
                    if (row.StampBefore != null) item["stampBefore"] = row.StampBefore;
                    list.Add(item);
                }
                entry["rows"] = list;
                return entry;
            };

            // 反映する SQL の文面は先に作る。戻し SQL は stamp の列の今の値を使うので、ロックして読んだ後（コミットの前）に作る。
            var script = RenderApplyScript(r, requestId, mode, rows, appliedBy);
            var result = Ok();
            result["requestId"] = requestId;
            result["mode"] = mode;
            result["appliedAt"] = appliedAt;
            result["appliedBy"] = appliedBy;
            var targetResult = new Dictionary<string, object> { { "target", r.Name }, { "updated", mode == "execute" ? rows.Count : 0 } };
            result["results"] = new List<object> { targetResult };
            result["script"] = script;
            // 返せない大きさなら、DB に触る前に止める（コミットした後に戻し SQL が返らない、を避ける）。
            // stamp があれば戻し SQL はロックして読んだ値で作り直し、もう一度確かめる。
            result["undoScript"] = RenderUndoScript(r, requestId, rows);
            EnsureFits(result, ApplyTooLarge);
            var userStamp = new Row();
            var nowStamp = new List<string>();
            foreach (var kv in r.Stamp)
            {
                if (kv.Value == "user") userStamp[kv.Key.Name] = appliedBy;
                else nowStamp.Add(kv.Key.Name);
            }
            // ロックした行から読む列: stamp の列（戻し SQL のため）と、サーバの業務ルールが見るほかの列。
            var dbKeyCols = DbKeyColumns(r);
            var readBase = new List<string>();
            foreach (var kv in r.Stamp) if (!readBase.Contains(kv.Key.Name)) readBase.Add(kv.Key.Name);
            foreach (var rule in ErrorRules(r))
                foreach (var c in rule.Columns)
                    if (!readBase.Contains(c)) readBase.Add(c);

            // 2〜6. トランザクションの中で、ロックを掛けて今の値を確かめてから流す。
            var conflicts = new List<object>();
            List<object> ruleErrors = null;
            var tooLarge = false;
            var updated = 0;
            int[] duplicate = null;
            try
            {
                o.Dialect.RunTransaction(tx =>
                {
                    var dbKeys = new Dictionary<string, int>(StringComparer.Ordinal);
                    var readValues = new List<Row>();
                    for (var index = 0; index < rows.Count; index++)
                    {
                        var row = rows[index];
                        if (!InScope(r, row.Key))
                        {
                            conflicts.Add(new Dictionary<string, object> { { "target", r.Name }, { "index", index }, { "key", row.Key }, { "reason", "not_found" } });
                            readValues.Add(new Row());
                            continue;
                        }
                        var read = new List<string>();
                        foreach (var c in readBase) if (!dbKeyCols.Contains(c) && !row.Before.ContainsKey(c)) read.Add(c);
                        var locked = tx.LockAndCompare(r.Meta, dbKeyCols, DbKey(r, row.Key), row.Before, read);
                        readValues.Add(locked.Read ?? new Row());
                        if (!locked.Found)
                        {
                            conflicts.Add(new Dictionary<string, object> { { "target", r.Name }, { "index", index }, { "key", row.Key }, { "reason", "not_found" } });
                            continue;
                        }
                        var dbKey = PatchiriValues.KeyIdentity(r.KeyColumns, locked.DbKey);
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
                    if (conflicts.Count > 0) return false;
                    var broken = CheckServerRules(r, rows, readValues);
                    if (broken.Count > 0)
                    {
                        ruleErrors = broken;
                        return false;
                    }
                    if (r.Stamp.Count > 0)
                    {
                        for (var i = 0; i < rows.Count; i++)
                        {
                            var stampBefore = new Row();
                            foreach (var kv in r.Stamp)
                            {
                                object v;
                                readValues[i].TryGetValue(kv.Key.Name, out v);
                                stampBefore[kv.Key.Name] = v;
                            }
                            rows[i].StampBefore = stampBefore;
                        }
                        result["undoScript"] = RenderUndoScript(r, requestId, rows);
                        if (!Fits(result))
                        {
                            tooLarge = true;
                            return false;
                        }
                    }
                    if (mode == "check") return false;
                    foreach (var row in rows)
                    {
                        var set = new Row(row.After);
                        foreach (var kv in userStamp) set[kv.Key] = kv.Value;
                        var n = tx.Update(r.Meta, dbKeyCols, DbKey(r, row.Key), set, nowStamp);
                        if (n != 1) throw new PatchiriDbException("UPDATE の影響行数が " + n + " でした（1 のはず）: " + PatchiriJson.Stringify(row.Key));
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
                throw new PatchiriFailure("bad_request", "1 行に誤りがあります")
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
            if (ruleErrors != null)
            {
                var indexes = new HashSet<int>();
                foreach (Dictionary<string, object> e in ruleErrors) indexes.Add((int)e["index"]);
                throw new PatchiriFailure("bad_request", indexes.Count + " 行がサーバの業務ルールに合いません") { RowErrors = ruleErrors };
            }
            if (conflicts.Count > 0)
            {
                var entry = logEntry("conflict");
                entry["conflicts"] = conflicts;
                SafeLog(entry);
                throw new PatchiriFailure("conflict", conflicts.Count + " 行が差分を取った後に変わっていたため、何も反映していません") { Conflicts = conflicts };
            }

            if (tooLarge) EnsureFits(result, ApplyTooLarge);
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

        /// <summary>
        /// 書き込む文字列が列の文字コードで表せるか、バイト数に収まるかを DB で確かめる。
        /// PatchiriValues の確認（.NET の文字コード）は DB のコードページと完全には一致しないので、最後はここで見る。
        /// </summary>
        List<object> CheckStrings(Resolved r, List<ApplyRow> rows, List<int> rowIndexes)
        {
            var errors = new List<object>();
            var items = new List<KeyValuePair<string, string>>();
            var itemRows = new List<int>();
            for (var i = 0; i < rows.Count; i++)
            {
                foreach (var kv in rows[i].After)
                {
                    var s = kv.Value as string;
                    if (s == null || r.Meta.Column(kv.Key).Type != "string") continue;
                    items.Add(new KeyValuePair<string, string>(kv.Key, s));
                    itemRows.Add(rowIndexes[i]);
                }
            }
            if (items.Count == 0) return errors;
            var results = o.Dialect.CheckStrings(r.Meta, items);
            for (var i = 0; i < items.Count; i++)
            {
                var res = results[i];
                if (res == null) continue;
                var col = r.Meta.Column(items[i].Key);
                string message = null;
                if (!res.Encodable) message = "after: 列の文字コード" + (col.Encoding != null ? "（" + col.Encoding + "）" : "") + "で表せない字があります";
                else if (col.MaxBytes.HasValue && res.Bytes > col.MaxBytes.Value) message = "after: " + col.MaxBytes.Value + " バイトを超えています（" + res.Bytes + " バイト）";
                if (message == null) continue;
                errors.Add(new Dictionary<string, object>
                {
                    { "target", r.Name },
                    { "index", itemRows[i] },
                    { "code", "invalid_value" },
                    { "column", col.Name },
                    { "message", message },
                });
            }
            return errors;
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

        /// <summary>サーバの業務ルールのうち error のもの。</summary>
        static List<PatchiriRule> ErrorRules(Resolved r)
        {
            var list = new List<PatchiriRule>();
            if (r.Rules == null) return list;
            foreach (var rule in r.Rules) if (rule.Severity == "error") list.Add(rule);
            return list;
        }

        /// <summary>stamp の "user" の列に、反映した人の名前が入るか。入らなければ DB に触る前に止める。</summary>
        void CheckStampUser(Resolved r, string user)
        {
            foreach (var kv in r.Stamp)
            {
                if (kv.Value != "user") continue;
                var col = kv.Key;
                var bad = PatchiriValues.CheckValue(col, user, false);
                if (bad == null)
                {
                    var res = o.Dialect.CheckStrings(r.Meta, new List<KeyValuePair<string, string>> { new KeyValuePair<string, string>(col.Name, user) })[0];
                    if (res != null && !res.Encodable) bad = "列の文字コードで表せない字があります";
                    else if (res != null && col.MaxBytes.HasValue && res.Bytes > col.MaxBytes.Value) bad = col.MaxBytes.Value + " バイトを超えています（" + res.Bytes + " バイト）";
                }
                if (bad != null)
                {
                    throw new PatchiriFailure("bad_request", "反映した人の名前（" + user + "）が stamp の列 " + col.Name + " に入りません（" + bad + "）")
                    {
                        Details = new Dictionary<string, object> { { "column", col.Name } },
                    };
                }
            }
        }

        /// <summary>
        /// サーバに置いた業務ルールのうち error のものを、反映した後の行（ロックして読んだ値に after を重ねたもの）で見る。
        /// 行が変える列にかかわるルールだけを見る（変えない列のルールは見ない）。
        /// </summary>
        List<object> CheckServerRules(Resolved r, List<ApplyRow> rows, List<Row> readValues)
        {
            var errors = new List<object>();
            var rules = ErrorRules(r);
            if (rules.Count == 0) return errors;
            for (var i = 0; i < rows.Count; i++)
            {
                var row = rows[i];
                var merged = new Row(readValues[i]);
                foreach (var kv in r.Scope) merged[kv.Key] = kv.Value;
                foreach (var kv in row.Key) merged[kv.Key] = kv.Value;
                foreach (var kv in row.After) merged[kv.Key] = kv.Value;
                foreach (var rule in rules)
                {
                    string touched = null;
                    foreach (var c in rule.Columns)
                    {
                        if (row.After.ContainsKey(c))
                        {
                            touched = c;
                            break;
                        }
                    }
                    if (touched == null) continue;
                    var changesColumn = row.After.ContainsKey(rule.Column);
                    var column = changesColumn ? rule.Column : touched;
                    object v;
                    merged.TryGetValue(rule.Column, out v);
                    var broken = PatchiriRules.Check(rule, v, merged);
                    if (broken == null && changesColumn) broken = PatchiriRules.CheckChange(rule, row.Before[rule.Column], row.After[rule.Column], merged);
                    if (broken == null) continue;
                    errors.Add(new Dictionary<string, object>
                    {
                        { "target", r.Name },
                        { "index", i },
                        { "code", "rule_violation" },
                        { "column", column },
                        { "message", PatchiriRules.MessageAt(rule, broken, column, merged) },
                    });
                }
            }
            return errors;
        }

        static string ScriptHead(Resolved r, string requestId, List<ApplyRow> rows)
        {
            return "-- patchiri " + requestId + " " + r.Name + " (" + r.Meta.Table + ") " + rows.Count + "行";
        }

        string RenderApplyScript(Resolved r, string requestId, string mode, List<ApplyRow> rows, string user)
        {
            var now = new List<string>();
            foreach (var kv in r.Stamp) if (kv.Value == "now") now.Add(kv.Key.Name);
            var updates = new List<ScriptUpdate>();
            foreach (var row in rows)
            {
                var set = new Row(row.After);
                foreach (var kv in r.Stamp) if (kv.Value == "user") set[kv.Key.Name] = user;
                updates.Add(new ScriptUpdate { Set = set, Key = DbKey(r, row.Key), Expect = row.Before, Now = now.Count > 0 ? now : null });
            }
            return o.Dialect.RenderScript(r.Meta, ScriptHead(r, requestId, rows) + " " + (mode == "check" ? "実行予定" : "実行済み"), updates, "apply");
        }

        /// <summary>戻し SQL。stamp の列は反映する前の値（ロックして読んだ値）に戻す。戻す条件はデータの列が after のままか。</summary>
        string RenderUndoScript(Resolved r, string requestId, List<ApplyRow> rows)
        {
            var updates = new List<ScriptUpdate>();
            foreach (var row in rows)
            {
                var set = new Row(row.Before);
                if (row.StampBefore != null) foreach (var kv in row.StampBefore) set[kv.Key] = kv.Value;
                updates.Add(new ScriptUpdate { Set = set, Key = DbKey(r, row.Key), Expect = row.After });
            }
            return o.Dialect.RenderScript(r.Meta, ScriptHead(r, requestId, rows) + " の戻し", updates, "undo");
        }
    }
}
