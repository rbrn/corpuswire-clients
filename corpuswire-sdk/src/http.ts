import type {
  EnhanceErrorEnvelope,
  FetchLike,
  ReviewContextErrorV1,
} from "./types.js";

const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);
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
  readonly errorEnvelope: EnhanceErrorEnvelope | ReviewContextErrorV1 | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly recoveryGuidance: readonly string[];

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
      errorEnvelope?: EnhanceErrorEnvelope | ReviewContextErrorV1 | null;
      retryable?: boolean;
      retryAfterSeconds?: number | null;
      recoveryGuidance?: readonly string[];
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
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.recoveryGuidance = normalizeRecoveryGuidance(options.recoveryGuidance);
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

export function createBearerAuthHeader(token: string): string {
  const normalized = token.trim();
  if (!normalized) {
    throw new Error("Bearer token must not be empty.");
  }
  return `Bearer ${normalized}`;
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
          const retryAfterSeconds = responseRetryAfterSeconds(response);
          await discardResponseBody(response);
          await waitForRetry(retryDelayMs, attempt, retryAfterSeconds);
          continue;
        }

        const responseBody = await response.text();
        const parsed = parseApiError(responseBody);
        const headerRequestId = response.headers?.get?.("x-request-id") ?? null;
        const headerRetryAfter = responseRetryAfterSeconds(response);

        throw new CorpusWireHttpError(response.status, response.statusText, responseBody, {
          requestId: parsed?.requestId ?? headerRequestId,
          durationMs: parsed?.durationMs ?? null,
          errorCode: parsed?.errorCode ?? null,
          errorMessage: parsed?.errorMessage ?? null,
          errorDetail: parsed?.errorDetail,
          errorEnvelope: parsed?.errorEnvelope ?? null,
          retryable: parsed?.retryable ?? TRANSIENT_HTTP_STATUSES.has(response.status),
          retryAfterSeconds: parsed?.retryAfterSeconds ?? headerRetryAfter,
          recoveryGuidance: parsed?.recoveryGuidance ?? [],
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

async function waitForRetry(
  baseDelayMs: number,
  attempt: number,
  retryAfterSeconds: number | null = null,
): Promise<void> {
  const delayMs = retryAfterSeconds === null
    ? baseDelayMs * (attempt + 1)
    : retryAfterSeconds * 1_000;
  if (delayMs <= 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

interface ParsedApiError {
  requestId: string;
  durationMs: number | null;
  errorCode: string;
  errorMessage: string;
  errorDetail: unknown;
  errorEnvelope: EnhanceErrorEnvelope | ReviewContextErrorV1 | null;
  retryable: boolean;
  retryAfterSeconds: number | null;
  recoveryGuidance: readonly string[];
}

function parseApiError(responseBody: string): ParsedApiError | null {
  try {
    const payload = JSON.parse(responseBody) as unknown;
    if (!payload || typeof payload !== "object") {
      return null;
    }

    if (
      "error_code" in payload
      && "message" in payload
      && "request_id" in payload
      && typeof payload.error_code === "string"
      && typeof payload.message === "string"
      && typeof payload.request_id === "string"
    ) {
      const candidate = payload as unknown as ReviewContextErrorV1;
      return {
        requestId: candidate.request_id,
        durationMs: null,
        errorCode: candidate.error_code,
        errorMessage: candidate.message,
        errorDetail: candidate.details,
        errorEnvelope: candidate,
        retryable: candidate.retryable === true,
        retryAfterSeconds: nonNegativeIntegerOrNull(candidate.retry_after_seconds),
        recoveryGuidance: normalizeRecoveryGuidance(candidate.recovery_guidance),
      };
    }

    const candidate = payload as Partial<EnhanceErrorEnvelope>;
    if ("detail" in payload) {
      const detail = (payload as { detail?: unknown }).detail;
      const detailRecord = detail && typeof detail === "object" && !Array.isArray(detail)
        ? detail as Record<string, unknown>
        : null;
      const message = typeof detail === "string"
        ? detail
        : typeof detailRecord?.message === "string"
        ? detailRecord.message
        : "CorpusWire request failed";
      return {
        requestId: "",
        durationMs: null,
        errorCode: "http_error",
        errorMessage: message,
        errorDetail: detail,
        errorEnvelope: null,
        retryable: false,
        retryAfterSeconds: null,
        recoveryGuidance: [],
      };
    }
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

    const envelope = candidate as EnhanceErrorEnvelope;
    return {
      requestId: envelope.request_id,
      durationMs: envelope.duration_ms,
      errorCode: envelope.error.code,
      errorMessage: envelope.error.message,
      errorDetail: envelope.error.detail,
      errorEnvelope: envelope,
      retryable: false,
      retryAfterSeconds: null,
      recoveryGuidance: [],
    };
  } catch {
    return null;
  }
}

function responseRetryAfterSeconds(response: Response): number | null {
  const value = response.headers?.get?.("retry-after");
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  return nonNegativeIntegerOrNull(seconds);
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function normalizeRecoveryGuidance(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Object.freeze(
    value
      .filter((item): item is string => (
        typeof item === "string"
        && item.length > 0
        && item.length <= 256
        && !item.includes("\n")
        && !item.includes("\r")
      ))
      .slice(0, 4),
  );
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
