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
  /** rest なら "http://127.0.0.1:7357"、webmethod なら "/Admin/Patchiri.aspx" など。 */
  baseUrl: string;
  style?: "rest" | "webmethod";
  /** ローカルの Node 版サーバが起動時に出すトークン。 */
  token?: string;
  /** 載せ先の認証に合わせて足すヘッダ。 */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/** サーバが HTTP のエラー（401 など）を返したとき、または応答が JSON でなかったときに投げる。 */
export class PatchiriHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    /** HTTP は成功でも、応答が JSON でなかった（載せ先のログインの画面に回されたときなど）。 */
    public readonly notJson = false,
  ) {
    super(notJson ? `サーバの応答が JSON ではありません（HTTP ${status}）: ${url}` : `サーバに届きませんでした（HTTP ${status}）: ${url}`);
    this.name = "PatchiriHttpError";
  }
}

/** API が ok:false を返したとき（describe と fetch）に投げる。 */
export class PatchiriApiError extends Error {
  constructor(public readonly failure: Failure) {
    super(`${failure.error.code}: ${failure.error.message}`);
    this.name = "PatchiriApiError";
  }
}

export class PatchiriClient {
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
      "X-Patchiri": "1",
      ...this.options.headers,
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(this.style === "webmethod" ? { req } : req),
    });
    if (!res.ok) throw new PatchiriHttpError(res.status, url);
    let body: { d?: unknown };
    try {
      body = JSON.parse(await res.text()) as { d?: unknown };
    } catch {
      throw new PatchiriHttpError(res.status, url, true);
    }
    return (this.style === "webmethod" ? body.d : body) as T | Failure;
  }

  private static unwrap<T>(r: T | Failure): T {
    if ((r as Failure).ok === false) throw new PatchiriApiError(r as Failure);
    return r as T;
  }

  async targets(): Promise<DescribeTargetsResponse> {
    return PatchiriClient.unwrap(await this.call<DescribeTargetsResponse>("describe", { v: 1 }));
  }

  async describe(target: string): Promise<TableDescription> {
    return PatchiriClient.unwrap(await this.call<TableDescription>("describe", { v: 1, target }));
  }

  async fetch(req: Omit<FetchRequest, "v">): Promise<FetchResponse> {
    return PatchiriClient.unwrap(await this.call<FetchResponse>("fetch", { v: 1, ...req }));
  }

  /** 衝突や行の誤りは業務上の結果なので、投げずに ok:false のまま返す。 */
  async apply(req: Omit<ApplyRequest, "v">): Promise<ApplyResponse | Failure> {
    return this.call<ApplyResponse>("apply", { v: 1, ...req });
  }
}
