import type { EnhanceErrorEnvelope, FetchLike } from "./types.js";

const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504]);
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

export class CorpusWireHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly responseBody: string;
  readonly requestId: string | null;
  readonly durationMs: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly errorDetail: unknown;
  readonly errorEnvelope: EnhanceErrorEnvelope | null;

  constructor(
    status: number,
    statusText: string,
    responseBody: string,
    options: {
      requestId?: string | null;
      durationMs?: number | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      errorDetail?: unknown;
      errorEnvelope?: EnhanceErrorEnvelope | null;
    } = {},
  ) {
    super(`${status} ${statusText}: ${options.errorMessage ?? responseBody}`);
    this.name = "CorpusWireHttpError";
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
    this.requestId = options.requestId ?? null;
    this.durationMs = options.durationMs ?? null;
    this.errorCode = options.errorCode ?? null;
    this.errorMessage = options.errorMessage ?? null;
    this.errorDetail = options.errorDetail;
    this.errorEnvelope = options.errorEnvelope ?? null;
  }
}

export interface RequestJsonOptions {
  baseUrl: string;
  paths: string[];
  fetchFn?: FetchLike;
  defaultHeaders?: Record<string, string>;
  basicAuth?: string;
  init?: RequestInit;
  retryAttempts?: number;
  retryDelayMs?: number;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function createBasicAuthHeader(credentials: string): string {
  return `Basic ${base64Encode(credentials)}`;
}

export function buildHeaders(
  defaultHeaders: Record<string, string> = {},
  basicAuth?: string,
  initHeaders?: HeadersInit,
): Headers {
  const headers = new Headers(defaultHeaders);
  if (basicAuth) {
    headers.set("Authorization", createBasicAuthHeader(basicAuth));
  }
  if (initHeaders) {
    new Headers(initHeaders).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return headers;
}

export async function requestJson<T>(options: RequestJsonOptions): Promise<T> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("A fetch implementation is required. Provide fetchFn or use a Node.js runtime with global fetch.");
  }

  const normalizedBaseUrl = normalizeBaseUrl(options.baseUrl);
  const retryAttempts = Math.max(0, options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  let lastNotFound = false;

  for (const path of options.paths) {
    for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetchFn(`${normalizedBaseUrl}${path}`, {
          ...options.init,
          headers: buildHeaders(options.defaultHeaders, options.basicAuth, options.init?.headers),
        });
      } catch (error) {
        if (attempt < retryAttempts && isRetryableFetchError(error)) {
          await waitForRetry(retryDelayMs, attempt);
          continue;
        }
        throw error;
      }

      if (response.status === 404) {
        lastNotFound = true;
        break;
      }

      if (!response.ok) {
        if (attempt < retryAttempts && TRANSIENT_HTTP_STATUSES.has(response.status)) {
          await discardResponseBody(response);
          await waitForRetry(retryDelayMs, attempt);
          continue;
        }

        const responseBody = await response.text();
        const parsedEnvelope = parseEnhanceErrorEnvelope(responseBody);

        throw new CorpusWireHttpError(response.status, response.statusText, responseBody, {
          requestId: parsedEnvelope?.request_id ?? null,
          durationMs: parsedEnvelope?.duration_ms ?? null,
          errorCode: parsedEnvelope?.error.code ?? null,
          errorMessage: parsedEnvelope?.error.message ?? null,
          errorDetail: parsedEnvelope?.error.detail,
          errorEnvelope: parsedEnvelope,
        });
      }

      return (await response.json()) as T;
    }
  }

  if (lastNotFound) {
    throw new Error(`No supported endpoint found under ${normalizedBaseUrl}`);
  }

  throw new Error(`No response received from ${normalizedBaseUrl}`);
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.text();
  } catch {
    // Best effort: retry eligibility should not depend on reading a gateway error page.
  }
}

function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return false;
  }

  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.includes("fetch failed")
    || message.includes("ECONNRESET")
    || message.includes("ECONNREFUSED")
    || message.includes("ETIMEDOUT")
    || message.includes("EPIPE")
    || message.includes("UND_ERR_SOCKET");
}

async function waitForRetry(baseDelayMs: number, attempt: number): Promise<void> {
  if (baseDelayMs <= 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, baseDelayMs * (attempt + 1));
  });
}

function parseEnhanceErrorEnvelope(responseBody: string): EnhanceErrorEnvelope | null {
  try {
    const payload = JSON.parse(responseBody) as unknown;
    if (!payload || typeof payload !== "object") {
      return null;
    }

    if (
      !("ok" in payload)
      || !("request_id" in payload)
      || !("duration_ms" in payload)
      || !("error" in payload)
    ) {
      return null;
    }

    const candidate = payload as Partial<EnhanceErrorEnvelope>;
    if (
      candidate.ok !== false
      || typeof candidate.request_id !== "string"
      || typeof candidate.duration_ms !== "number"
      || !candidate.error
      || typeof candidate.error.code !== "string"
      || typeof candidate.error.message !== "string"
    ) {
      return null;
    }

    return candidate as EnhanceErrorEnvelope;
  } catch {
    return null;
  }
}

function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += alphabet[(triple >> 18) & 63];
    encoded += alphabet[(triple >> 12) & 63];
    encoded += second === undefined ? "=" : alphabet[(triple >> 6) & 63];
    encoded += third === undefined ? "=" : alphabet[triple & 63];
  }
  return encoded;
}
