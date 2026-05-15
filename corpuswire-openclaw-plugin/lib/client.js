const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504]);

export const DEFAULT_PLUGIN_CONFIG = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  basicAuth: "",
  repoPath: undefined,
  workspaceId: undefined,
  topK: 5,
  minScore: 0.15,
  maxContextChars: 6000,
  requestTimeoutMs: 30000,
  requestRetryAttempts: 2,
  requestRetryDelayMs: 250,
  autoContext: false,
  contextEngineAutoContext: true,
});

export class CorpusWireHttpError extends Error {
  constructor(status, statusText, responseBody) {
    super(`${status} ${statusText}: ${responseBody}`);
    this.name = "CorpusWireHttpError";
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
  }
}

export class CorpusWireClient {
  constructor(config, fetchFn = globalThis.fetch) {
    this.config = config;
    this.fetchFn = fetchFn;
  }

  async health(options = {}) {
    const queryString = toQueryString({
      repo_path: this.config.repoPath,
      workspace_id: this.config.workspaceId,
    });
    return requestJson({
      baseUrl: this.config.baseUrl,
      paths: [`/v1/health${queryString}`, `/health${queryString}`],
      basicAuth: this.config.basicAuth,
      timeoutMs: this.config.requestTimeoutMs,
      retryAttempts: this.config.requestRetryAttempts,
      retryDelayMs: this.config.requestRetryDelayMs,
      fetchFn: this.fetchFn,
      signal: options.signal,
      init: { method: "GET" },
    });
  }

  async query(request, options = {}) {
    const prompt = request.query ?? request.prompt;
    return requestJson({
      baseUrl: this.config.baseUrl,
      paths: ["/query"],
      basicAuth: this.config.basicAuth,
      timeoutMs: this.config.requestTimeoutMs,
      retryAttempts: this.config.requestRetryAttempts,
      retryDelayMs: this.config.requestRetryDelayMs,
      fetchFn: this.fetchFn,
      signal: options.signal,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          removeUndefinedValues({
            repo_path: request.repoPath ?? this.config.repoPath,
            workspace_id: request.workspaceId ?? this.config.workspaceId,
            prompt,
            top_k: request.topK ?? this.config.topK,
            min_score: request.minScore ?? this.config.minScore,
            include_answer: false,
          }),
        ),
      },
    });
  }

  async enhance(request, options = {}) {
    return requestJson({
      baseUrl: this.config.baseUrl,
      paths: ["/v1/enhance", "/enhance"],
      basicAuth: this.config.basicAuth,
      timeoutMs: this.config.requestTimeoutMs,
      retryAttempts: this.config.requestRetryAttempts,
      retryDelayMs: this.config.requestRetryDelayMs,
      fetchFn: this.fetchFn,
      signal: options.signal,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          removeUndefinedValues({
            repo_path: request.repoPath ?? this.config.repoPath,
            workspace_id: request.workspaceId ?? this.config.workspaceId,
            prompt: request.prompt,
            top_k: request.topK ?? this.config.topK,
            min_score: request.minScore ?? this.config.minScore,
            output_mode: request.outputMode ?? "generic",
            local_only: request.localOnly ?? false,
          }),
        ),
      },
    });
  }

  async ingest(request = {}, options = {}) {
    const localRepoPath = request.repoPath ?? this.config.repoPath;
    const localSourceDir = request.sourceDir;
    const workspaceId = request.workspaceId ?? this.config.workspaceId;
    if (workspaceId && !localRepoPath && !localSourceDir) {
      throw new Error("Local /ingest cannot index a remote workspaceId. Use a client that uploads files through /v1/index.");
    }

    return requestJson({
      baseUrl: this.config.baseUrl,
      paths: ["/ingest"],
      basicAuth: this.config.basicAuth,
      timeoutMs: this.config.requestTimeoutMs,
      retryAttempts: this.config.requestRetryAttempts,
      retryDelayMs: this.config.requestRetryDelayMs,
      fetchFn: this.fetchFn,
      signal: options.signal,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          removeUndefinedValues({
            repo_path: request.repoPath ?? this.config.repoPath,
            source_dir: request.sourceDir,
            recreate_collection: request.recreateCollection ?? false,
            include_globs: request.includeGlobs,
            exclude_globs: request.excludeGlobs,
            max_file_size_bytes: request.maxFileSizeBytes,
          }),
        ),
      },
    });
  }
}

export function buildCorpusWireClient(config, fetchFn = globalThis.fetch) {
  return new CorpusWireClient(config, fetchFn);
}

export function normalizePluginConfig(value = {}, env = process.env) {
  const errors = [];
  const record = isRecord(value) ? value : {};
  if (!isRecord(value)) {
    errors.push("plugin config must be an object");
  }

  const baseUrl = readString(record, "baseUrl", env.CORPUSWIRE_BASE_URL ?? DEFAULT_PLUGIN_CONFIG.baseUrl, {
    errors,
    allowEmpty: false,
  });
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl, errors);

  const basicAuth = readString(record, "basicAuth", env.CORPUSWIRE_BASIC_AUTH ?? DEFAULT_PLUGIN_CONFIG.basicAuth, {
    errors,
    allowEmpty: true,
  });
  const repoPath = readOptionalString(record, "repoPath", env.CORPUSWIRE_REPO_PATH);
  const workspaceId = readOptionalString(record, "workspaceId", env.CORPUSWIRE_WORKSPACE_ID);

  return {
    config: {
      baseUrl: normalizedBaseUrl,
      basicAuth,
      repoPath,
      workspaceId,
      topK: readInteger(record, "topK", DEFAULT_PLUGIN_CONFIG.topK, { errors, min: 1, max: 20 }),
      minScore: readNumber(record, "minScore", DEFAULT_PLUGIN_CONFIG.minScore, { errors, min: 0, max: 1 }),
      maxContextChars: readInteger(record, "maxContextChars", DEFAULT_PLUGIN_CONFIG.maxContextChars, {
        errors,
        min: 500,
        max: 50000,
      }),
      requestTimeoutMs: readInteger(record, "requestTimeoutMs", DEFAULT_PLUGIN_CONFIG.requestTimeoutMs, {
        errors,
        min: 1000,
        max: 120000,
      }),
      requestRetryAttempts: readInteger(record, "requestRetryAttempts", DEFAULT_PLUGIN_CONFIG.requestRetryAttempts, {
        errors,
        min: 0,
        max: 5,
      }),
      requestRetryDelayMs: readInteger(record, "requestRetryDelayMs", DEFAULT_PLUGIN_CONFIG.requestRetryDelayMs, {
        errors,
        min: 0,
        max: 5000,
      }),
      autoContext: readBoolean(record, "autoContext", DEFAULT_PLUGIN_CONFIG.autoContext, { errors }),
      contextEngineAutoContext: readBoolean(
        record,
        "contextEngineAutoContext",
        DEFAULT_PLUGIN_CONFIG.contextEngineAutoContext,
        { errors },
      ),
    },
    errors,
  };
}

function toQueryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function normalizeBaseUrl(baseUrl, errors = []) {
  const normalized = String(baseUrl).trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(normalized);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      errors.push("baseUrl must use http or https");
      return DEFAULT_PLUGIN_CONFIG.baseUrl;
    }
    return normalized;
  } catch {
    errors.push("baseUrl must be a valid URL");
    return DEFAULT_PLUGIN_CONFIG.baseUrl;
  }
}

export async function requestJson(options) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("A fetch implementation is required. Use Node.js 18+ or provide fetchFn.");
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const retryAttempts = Math.max(0, options.retryAttempts ?? DEFAULT_PLUGIN_CONFIG.requestRetryAttempts);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_PLUGIN_CONFIG.requestRetryDelayMs);
  let sawNotFound = false;

  for (const path of options.paths) {
    for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
      let response;
      try {
        response = await fetchWithTimeout(fetchFn, `${baseUrl}${path}`, options);
      } catch (error) {
        if (attempt < retryAttempts && isRetryableFetchError(error)) {
          await waitForRetry(retryDelayMs, attempt);
          continue;
        }
        throw error;
      }

      if (response.status === 404) {
        sawNotFound = true;
        break;
      }

      if (!response.ok) {
        if (attempt < retryAttempts && TRANSIENT_HTTP_STATUSES.has(response.status)) {
          await discardResponseBody(response);
          await waitForRetry(retryDelayMs, attempt);
          continue;
        }

        const responseBody = await response.text();
        throw new CorpusWireHttpError(response.status, response.statusText ?? "ERROR", responseBody);
      }

      return response.json();
    }
  }

  if (sawNotFound) {
    throw new Error(`No supported CorpusWire endpoint found under ${baseUrl}`);
  }
  throw new Error(`No response received from ${baseUrl}`);
}

async function fetchWithTimeout(fetchFn, url, options) {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), options.timeoutMs ?? DEFAULT_PLUGIN_CONFIG.requestTimeoutMs);

  try {
    return await fetchFn(url, {
      ...options.init,
      headers: buildHeaders(options.basicAuth, options.init?.headers),
      signal: mergeAbortSignals([options.signal, timeoutController.signal]),
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function discardResponseBody(response) {
  try {
    await response.text();
  } catch {
    // Best effort: retry eligibility should not depend on reading a gateway error page.
  }
}

function isRetryableFetchError(error) {
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

async function waitForRetry(baseDelayMs, attempt) {
  if (baseDelayMs <= 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, baseDelayMs * (attempt + 1));
  });
}

function buildHeaders(basicAuth, initHeaders) {
  const headers = new Headers(initHeaders ?? {});
  if (basicAuth) {
    headers.set("Authorization", createBasicAuthHeader(basicAuth));
  }
  return headers;
}

export function createBasicAuthHeader(credentials) {
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

function mergeAbortSignals(signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }

  const controller = new AbortController();
  const abort = (signal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }

  return controller.signal;
}

function removeUndefinedValues(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(record, key, fallback, options) {
  if (!(key in record)) {
    return fallback;
  }

  const value = record[key];
  if (typeof value !== "string") {
    options.errors.push(`${key} must be a string`);
    return fallback;
  }

  const trimmed = value.trim();
  if (!options.allowEmpty && !trimmed) {
    options.errors.push(`${key} must not be empty`);
    return fallback;
  }
  return trimmed;
}

function readOptionalString(record, key, fallback) {
  if (!(key in record)) {
    return normalizeOptionalString(fallback);
  }
  return normalizeOptionalString(record[key]);
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readInteger(record, key, fallback, options) {
  const value = readNumber(record, key, fallback, options);
  return Number.isInteger(value) ? value : fallback;
}

function readNumber(record, key, fallback, options) {
  if (!(key in record)) {
    return fallback;
  }

  const value = typeof record[key] === "string" ? Number(record[key]) : record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    options.errors.push(`${key} must be a number`);
    return fallback;
  }

  if (value < options.min || value > options.max) {
    options.errors.push(`${key} must be between ${options.min} and ${options.max}`);
    return fallback;
  }
  return value;
}

function readBoolean(record, key, fallback, options) {
  if (!(key in record)) {
    return fallback;
  }

  const value = record[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  options.errors.push(`${key} must be a boolean`);
  return fallback;
}
