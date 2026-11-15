// Thin fetch wrapper for the REST API (`/api/v1`). Adds the CSRF header on unsafe requests,
// normalises error bodies (`{error:{code,message,details}}`) and reports 401s to the app.

const BASE = "/api/v1";
const SAFE_METHODS: Record<string, true> = { GET: true, HEAD: true, OPTIONS: true };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {};

/** Registers the app-level 401 handler (redirect to /login). */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

export interface RequestOptions {
  /** Do not trigger the global 401 redirect (login/session probes). */
  allowUnauthorized?: boolean;
  signal?: AbortSignal;
  /** Sent as `Idempotency-Key`: the server applies a retried write once. */
  idempotencyKey?: string;
  /** Receives the response headers (e.g. `X-Undo-Steps`) before the body is read. */
  onHeaders?: (headers: Headers) => void;
}

export function apiUrl(path: string, query?: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return `${BASE}${path}${qs ? `?${qs}` : ""}`;
}

export async function request<T>(method: string, url: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!SAFE_METHODS[method]) headers["X-Requested-With"] = "prana-bindu";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(url.startsWith("/") ? url : `${BASE}${url}`, {
      method,
      headers,
      body: payload,
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "network", "Network error: the server could not be reached.");
  }
  options.onHeaders?.(response.headers);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    const apiError = new ApiError(
      response.status,
      err?.code ?? `http_${response.status}`,
      err?.message ?? (typeof data === "string" && data ? data : `Request failed (${response.status})`),
      err?.details,
    );
    if (response.status === 401 && !options.allowUnauthorized) onUnauthorized();
    throw apiError;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Parameters<typeof apiUrl>[1], options?: RequestOptions) =>
    request<T>("GET", apiUrl(path, query), undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>("POST", apiUrl(path), body ?? {}, options),
  patch: <T>(path: string, body: unknown, options?: RequestOptions) => request<T>("PATCH", apiUrl(path), body, options),
  put: <T>(path: string, body: unknown, options?: RequestOptions) => request<T>("PUT", apiUrl(path), body, options),
  del: <T = void>(path: string, options?: RequestOptions) => request<T>("DELETE", apiUrl(path), undefined, options),
  upload: <T>(path: string, form: FormData, options?: RequestOptions) => request<T>("POST", apiUrl(path), form, options),
};
