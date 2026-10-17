// サーバ API 3 本を呼ぶクライアント。呼び出し方は rest と webmethod の 2 通り（仕様 1.1）。

import type {
  ApplyRequest,
  ApplyResponse,
  DescribeTargetsResponse,
  Failure,
  FetchRequest,
  FetchResponse,
  TableDescription,
} from "./types.js";

export interface ClientOptions {
  /** rest なら "http://127.0.0.1:7357"、webmethod なら "/Admin/Harikit.aspx" など。 */
  baseUrl: string;
  style?: "rest" | "webmethod";
  /** ローカルの Node 版サーバが起動時に出すトークン。 */
  token?: string;
  /** 載せ先の認証に合わせて足すヘッダ。 */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/** API が ok:false を返したとき（describe と fetch）に投げる。 */
export class HarikitApiError extends Error {
  constructor(public readonly failure: Failure) {
    super(`${failure.error.code}: ${failure.error.message}`);
    this.name = "HarikitApiError";
  }
}

export class HarikitClient {
  private readonly style: "rest" | "webmethod";
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.style = options.style ?? "rest";
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async call<T>(name: "describe" | "fetch" | "apply", req: unknown): Promise<T | Failure> {
    const method = this.style === "webmethod" ? name[0]!.toUpperCase() + name.slice(1) : name;
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/${method}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "X-Harikit": "1",
      ...this.options.headers,
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(this.style === "webmethod" ? { req } : req),
    });
    if (!res.ok) throw new Error(`サーバに届きませんでした（HTTP ${res.status}）: ${url}`);
    const body = (await res.json()) as { d?: unknown };
    return (this.style === "webmethod" ? body.d : body) as T | Failure;
  }

  private static unwrap<T>(r: T | Failure): T {
    if ((r as Failure).ok === false) throw new HarikitApiError(r as Failure);
    return r as T;
  }

  async targets(): Promise<DescribeTargetsResponse> {
    return HarikitClient.unwrap(await this.call<DescribeTargetsResponse>("describe", { v: 1 }));
  }

  async describe(target: string): Promise<TableDescription> {
    return HarikitClient.unwrap(await this.call<TableDescription>("describe", { v: 1, target }));
  }

  async fetch(req: Omit<FetchRequest, "v">): Promise<FetchResponse> {
    return HarikitClient.unwrap(await this.call<FetchResponse>("fetch", { v: 1, ...req }));
  }

  /** 衝突や行の誤りは業務上の結果なので、投げずに ok:false のまま返す。 */
  async apply(req: Omit<ApplyRequest, "v">): Promise<ApplyResponse | Failure> {
    return this.call<ApplyResponse>("apply", { v: 1, ...req });
  }
}
