import { createBearerAuthHeader, requestJson } from "./http.js";
import type {
  EnhancePromptPayload,
  EnhancePromptRequest,
  EnhanceResponseEnvelope,
  CodebaseListV1,
  CodebaseRepositoriesV1,
  CodebaseV1,
  CreateCodebaseRequest,
  GitHubProviderBindingPayload,
  GitHubProviderBindingRequest,
  HealthResponse,
  IndexActivityQuery,
  IndexActivityResponse,
  IndexActivitySummary,
  IndexEvent,
  IndexEventQuery,
  IndexEventsResponse,
  IndexSessionQuery,
  IndexWorkspaceRequest,
  CorpusWireClientOptions,
  LlmModelState,
  PromptOutputMode,
  PromptEnhancementResult,
  PromptRewriteResult,
  QueryPromptPayload,
  QueryPromptRequest,
  QueryResponseEnvelope,
  QualityEvent,
  QualityEventPayload,
  QualityEventRequest,
  QualityEventResponse,
  QualityEventsQuery,
  QualityEventsResponse,
  QualityReview,
  QualityReviewQuery,
  QualityReviewResponse,
  QueryValueEvent,
  ProviderBindingResponseV1,
  ProviderBindingRevocationV1,
  ValueFeedbackRequest,
  ValueRollup,
  ValueRollupQuery,
  RemoteFileBatchMetadata,
  RemoteFileBatchResult,
  RemoteFileContent,
  RemoteIndexCapabilities,
  RemoteIndexCommitResponse,
  RemoteIndexSession,
  RemoteIndexScopeV2,
  RemoteIndexSessionsResponse,
  RemoteIndexStatus,
  RemoteManifestBatchResult,
  RemoteManifestEntry,
  RemoteWorkspaceFile,
  ReviewContextCapabilitiesV1,
  ReviewContextJobV1,
  ReviewContextPollOptions,
  ReviewContextRequest,
  ReviewContextRequestV1,
  ReviewContextResponseV1,
  ReviewContextResult,
  ReviewTelemetrySummaryV1,
  ReviewPurgeV1,
  ReviewStatusV1,
  SearchHit,
  StartRemoteIndexSessionRequest,
  WorkspaceDiagnosis,
  WorkspaceDiagnosisEnvelope,
  WorkspaceDiagnosisRequest,
  UpdateCodebaseRequest,
} from "./types.js";

const RUNTIME_ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const DEFAULT_BASE_URL = RUNTIME_ENV.CORPUSWIRE_BASE_URL ?? "http://127.0.0.1:8000";
const DEFAULT_BASIC_AUTH = RUNTIME_ENV.CORPUSWIRE_BASIC_AUTH ?? "";
const DEFAULT_BEARER_TOKEN = RUNTIME_ENV.CORPUSWIRE_BEARER_TOKEN ?? "";
const DEFAULT_OUTPUT_MODE: PromptOutputMode = "generic";
const DEFAULT_REVIEW_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_REVIEW_POLL_INTERVAL_MS = 1_000;
const PENDING_REVIEW_JOB_STATES = new Set(["queued", "running"]);

export class ReviewContextPollingTimeoutError extends Error {
  readonly jobId: string;
  readonly timeoutMs: number;

  constructor(jobId: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for review-context job ${jobId}.`);
    this.name = "ReviewContextPollingTimeoutError";
    this.jobId = jobId;
    this.timeoutMs = timeoutMs;
  }
}

export class ReviewContextPollingCancelledError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Polling was cancelled for review-context job ${jobId}.`);
    this.name = "ReviewContextPollingCancelledError";
    this.jobId = jobId;
  }
}

export class CorpusWireClient {
  readonly baseUrl: string;
  readonly basicAuth: string;
  readonly bearerToken: string;
  readonly endpointMode: "compat" | "v1-only";
  readonly fetchFn: CorpusWireClientOptions["fetchFn"];
  readonly defaultHeaders: Record<string, string>;

  constructor(options: CorpusWireClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.basicAuth = options.basicAuth ?? DEFAULT_BASIC_AUTH;
    this.bearerToken = options.bearerToken ?? DEFAULT_BEARER_TOKEN;
    this.endpointMode = options.endpointMode ?? "compat";
    this.fetchFn = options.fetchFn;
    this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    const configuredAuthorization = Object.keys(this.defaultHeaders).some(
      (name) => name.toLowerCase() === "authorization",
    );
    const authMethodCount = Number(Boolean(this.basicAuth))
      + Number(Boolean(this.bearerToken))
      + Number(configuredAuthorization);
    if (authMethodCount > 1) {
      throw new Error("Configure exactly one CorpusWire authorization method.");
    }
    if (this.bearerToken) {
      this.defaultHeaders.Authorization = createBearerAuthHeader(this.bearerToken);
    }
  }

  async health(request: { repoPath?: string; workspaceId?: string } = {}): Promise<HealthResponse> {
    const query = toQueryString({
      repo_path: request.repoPath,
      workspace_id: request.workspaceId,
    });
    return requestJson<HealthResponse>({
      baseUrl: this.baseUrl,
      paths: this.endpointMode === "v1-only" ? [`/v1/health${query}`] : [`/v1/health${query}`, `/health${query}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
  }

  async diagnoseWorkspace(request: WorkspaceDiagnosisRequest = {}): Promise<WorkspaceDiagnosis> {
    const query = toQueryString({
      repo_path: request.repoPath,
      workspace_id: request.workspaceId,
    });
    const response = await requestJson<WorkspaceDiagnosisEnvelope>({
      baseUrl: this.baseUrl,
      paths: this.endpointMode === "v1-only"
        ? [`/v1/context/diagnose${query}`]
        : [`/v1/context/diagnose${query}`, `/context/diagnose${query}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.diagnosis;
  }

  async enhance(request: string | EnhancePromptRequest): Promise<PromptRewriteResult> {
    const response = await this.enhanceRaw(request);
    return response.result;
  }

  async enhanceRaw(request: string | EnhancePromptRequest): Promise<EnhanceResponseEnvelope> {
    return requestJson<EnhanceResponseEnvelope>({
      baseUrl: this.baseUrl,
      paths: this.endpointMode === "v1-only" ? ["/v1/enhance"] : ["/v1/enhance", "/enhance"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toEnhancePayload(request)),
      },
    });
  }

  async query(request: string | QueryPromptRequest): Promise<PromptEnhancementResult> {
    const response = await this.queryRaw(request);
    return response.result;
  }

  async queryRaw(request: string | QueryPromptRequest): Promise<QueryResponseEnvelope> {
    return requestJson<QueryResponseEnvelope>({
      baseUrl: this.baseUrl,
      paths: ["/query"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toQueryPayload(request)),
      },
    });
  }

  async semanticSearch(request: string | Omit<QueryPromptRequest, "includeAnswer">): Promise<SearchHit[]> {
    const response = await this.query({
      ...(typeof request === "string" ? { query: request } : request),
      includeAnswer: false,
    });
    return response.retrieved_chunks;
  }

  async recordQualityEvent(request: QualityEventRequest): Promise<QualityEvent> {
    const response = await requestJson<QualityEventResponse>({
      baseUrl: this.baseUrl,
      paths: ["/v1/quality/events"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toQualityEventPayload(request)),
      },
    });
    return response.event;
  }

  async listQualityEvents(request: QualityEventsQuery = {}): Promise<QualityEvent[]> {
    const query = toQueryString({
      workspace_id: request.workspaceId,
      work_type: request.workType,
      engine: request.engine,
      days: request.days?.toString(),
      limit: request.limit?.toString(),
    });
    const response = await requestJson<QualityEventsResponse>({
      baseUrl: this.baseUrl,
      paths: [`/v1/quality/events${query}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.events;
  }

  async reviewQuality(request: QualityReviewQuery = {}): Promise<QualityReview> {
    const query = toQueryString({
      workspace_id: request.workspaceId,
      work_type: request.workType,
      engine: request.engine,
      days: request.days?.toString(),
    });
    const response = await requestJson<QualityReviewResponse>({
      baseUrl: this.baseUrl,
      paths: [`/v1/quality/review${query}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.review;
  }

  async confirmQueryValue(request: ValueFeedbackRequest): Promise<QueryValueEvent> {
    const response = await requestJson<{ ok: true; event: QueryValueEvent }>({
      baseUrl: this.baseUrl,
      paths: [`/v1/value/events/${encodeURIComponent(request.eventId)}/confirm`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          minutes_saved: request.minutesSaved,
          confirmed_value: request.confirmedValue,
          confirmed_by: request.confirmedBy,
        }),
      },
    });
    return response.event;
  }

  async valueRollup(request: ValueRollupQuery = {}): Promise<ValueRollup> {
    const query = toQueryString({
      period: request.period,
      days: request.days?.toString(),
      workspace_id: request.workspaceId,
      hourly_rate: request.hourlyRate?.toString(),
    });
    const response = await requestJson<{ ok: true; rollup: ValueRollup }>({
      baseUrl: this.baseUrl,
      paths: [`/v1/value/rollup${query}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.rollup;
  }

  async createCodebase(request: CreateCodebaseRequest): Promise<CodebaseV1> {
    return requestJson<CodebaseV1>({
      baseUrl: this.baseUrl,
      paths: ["/v1/codebases"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: request.displayName }),
      },
    });
  }

  async listCodebases(): Promise<CodebaseV1[]> {
    const response = await requestJson<CodebaseListV1>({
      baseUrl: this.baseUrl,
      paths: ["/v1/codebases"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.codebases;
  }

  async getCodebase(codebaseId: string): Promise<CodebaseV1> {
    return requestJson<CodebaseV1>({
      baseUrl: this.baseUrl,
      paths: [`/v1/codebases/${encodeURIComponent(requireIdentifier(codebaseId, "codebaseId"))}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
  }

  async updateCodebase(codebaseId: string, request: UpdateCodebaseRequest): Promise<CodebaseV1> {
    return requestJson<CodebaseV1>({
      baseUrl: this.baseUrl,
      paths: [`/v1/codebases/${encodeURIComponent(requireIdentifier(codebaseId, "codebaseId"))}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(removeUndefinedValues({
          display_name: request.displayName,
          status: request.status,
        })),
      },
    });
  }

  async deleteCodebase(codebaseId: string): Promise<CodebaseV1> {
    return requestJson<CodebaseV1>({
      baseUrl: this.baseUrl,
      paths: [`/v1/codebases/${encodeURIComponent(requireIdentifier(codebaseId, "codebaseId"))}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "DELETE" },
    });
  }

  async listCodebaseRepositories(codebaseId: string): Promise<CodebaseRepositoriesV1> {
    return requestJson<CodebaseRepositoriesV1>({
      baseUrl: this.baseUrl,
      paths: [
        `/v1/codebases/${encodeURIComponent(requireIdentifier(codebaseId, "codebaseId"))}/repositories`,
      ],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
  }

  /** Create or update a GitHub binding while preserving allowlist tri-state values. */
  async bindGitHubProvider(
    codebaseId: string,
    request: GitHubProviderBindingRequest,
  ): Promise<ProviderBindingResponseV1> {
    return requestJson<ProviderBindingResponseV1>({
      baseUrl: this.baseUrl,
      paths: [
        `/v1/codebases/${encodeURIComponent(requireIdentifier(codebaseId, "codebaseId"))}`
          + "/provider-bindings/github",
      ],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toGitHubProviderBindingPayload(request)),
      },
    });
  }

  async revokeGitHubProvider(
    codebaseId: string,
    installationId: string,
    providerHost = "github.com",
  ): Promise<ProviderBindingRevocationV1> {
    const query = toQueryString({
      installation_id: requireIdentifier(installationId, "installationId"),
      provider_host: requireIdentifier(providerHost, "providerHost"),
    });
    return requestJson<ProviderBindingRevocationV1>({
      baseUrl: this.baseUrl,
      paths: [
        `/v1/codebases/${encodeURIComponent(requireIdentifier(codebaseId, "codebaseId"))}`
          + `/provider-bindings/github${query}`,
      ],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "DELETE" },
    });
  }

  async getReviewContextCapabilities(): Promise<ReviewContextCapabilitiesV1> {
    return requestJson<ReviewContextCapabilitiesV1>({
      baseUrl: this.baseUrl,
      paths: ["/v1/review-context/capabilities"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
  }

  async getReviewTelemetrySummary(): Promise<ReviewTelemetrySummaryV1> {
    return requestJson<ReviewTelemetrySummaryV1>({
      baseUrl: this.baseUrl,
      paths: ["/v1/review-context/telemetry/summary"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
  }

  async requestReviewContext(request: ReviewContextRequest): Promise<ReviewContextResult> {
    const codebaseId = requireIdentifier(request.codebaseId, "codebaseId");
    return requestJson<ReviewContextResult>({
      baseUrl: this.baseUrl,
      paths: [`/v1/codebases/${encodeURIComponent(codebaseId)}/reviews/context`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toReviewContextPayload(request)),
      },
    });
  }

  async getReviewContextJob(jobId: string): Promise<ReviewContextResult> {
    return requestJson<ReviewContextResult>({
      baseUrl: this.baseUrl,
      paths: [`/v1/review-context/jobs/${encodeURIComponent(requireIdentifier(jobId, "jobId"))}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
  }

  async cancelReviewContextJob(jobId: string): Promise<ReviewContextJobV1> {
    return requestJson<ReviewContextJobV1>({
      baseUrl: this.baseUrl,
      paths: [`/v1/review-context/jobs/${encodeURIComponent(requireIdentifier(jobId, "jobId"))}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "DELETE" },
    });
  }

  async pollReviewContextJob(
    jobOrId: ReviewContextJobV1 | string,
    options: ReviewContextPollOptions = {},
  ): Promise<ReviewContextResult> {
    const timeoutMs = validateNonNegativeNumber(
      options.timeoutMs ?? DEFAULT_REVIEW_POLL_TIMEOUT_MS,
      "timeoutMs",
    );
    const pollIntervalMs = validateNonNegativeNumber(
      options.pollIntervalMs ?? DEFAULT_REVIEW_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    const jobId = requireIdentifier(
      typeof jobOrId === "string" ? jobOrId : jobOrId.job_id,
      "jobId",
    );
    const deadline = Date.now() + timeoutMs;
    let result: ReviewContextResult = typeof jobOrId === "string"
      ? await this.getReviewContextJob(jobId)
      : jobOrId;

    for (;;) {
      throwIfReviewPollingCancelled(options.signal, jobId);
      if (!isReviewContextJob(result) || !PENDING_REVIEW_JOB_STATES.has(result.state)) {
        return result;
      }
      options.onJob?.(result);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new ReviewContextPollingTimeoutError(jobId, timeoutMs);
      }
      const serverDelayMs = result.retry_after_seconds === null
        ? pollIntervalMs
        : result.retry_after_seconds * 1_000;
      await waitForReviewPoll(
        Math.min(remainingMs, Math.max(10, serverDelayMs)),
        options.signal,
        jobId,
      );
      result = await this.getReviewContextJob(jobId);
    }
  }

  async requestReviewContextAndWait(
    request: ReviewContextRequest,
    options: ReviewContextPollOptions = {},
  ): Promise<ReviewContextResult> {
    const result = await this.requestReviewContext(request);
    return isReviewContextJob(result) && PENDING_REVIEW_JOB_STATES.has(result.state)
      ? this.pollReviewContextJob(result, options)
      : result;
  }

  async getReviewStatus(codebaseId: string, reviewId: string): Promise<ReviewStatusV1> {
    return requestJson<ReviewStatusV1>({
      baseUrl: this.baseUrl,
      paths: [
        `/v1/codebases/${encodeURIComponent(requireIdentifier(codebaseId, "codebaseId"))}`
          + `/reviews/${encodeURIComponent(requireIdentifier(reviewId, "reviewId"))}/status`,
      ],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
  }

  async purgeReviewOverlay(codebaseId: string, reviewId: string): Promise<ReviewPurgeV1> {
    return requestJson<ReviewPurgeV1>({
      baseUrl: this.baseUrl,
      paths: [
        `/v1/codebases/${encodeURIComponent(requireIdentifier(codebaseId, "codebaseId"))}`
          + `/reviews/${encodeURIComponent(requireIdentifier(reviewId, "reviewId"))}/overlay`,
      ],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "DELETE" },
    });
  }

  async getLlmModel(): Promise<LlmModelState> {
    return requestJson<LlmModelState>({
      baseUrl: this.baseUrl,
      paths: ["/llm/model"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
  }

  async setLlmModel(model: string): Promise<LlmModelState> {
    return requestJson<LlmModelState>({
      baseUrl: this.baseUrl,
      paths: ["/llm/model"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      },
    });
  }

  async getIndexCapabilities(): Promise<RemoteIndexCapabilities> {
    return requestJson<RemoteIndexCapabilities>({
      baseUrl: this.baseUrl,
      paths: ["/v1/index/capabilities"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
  }

  async getIndexEvents(request: IndexEventQuery = {}): Promise<IndexEvent[]> {
    const response = await requestJson<IndexEventsResponse>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/events${toQueryString(toIndexEventQueryParams(request))}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.events;
  }

  async getIndexActivity(request: IndexActivityQuery = {}): Promise<IndexActivitySummary> {
    const response = await requestJson<IndexActivityResponse>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/activity${toQueryString(toIndexActivityQueryParams(request))}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.activity;
  }

  async listIndexSessions(request: IndexSessionQuery = {}): Promise<RemoteIndexStatus[]> {
    const response = await requestJson<RemoteIndexSessionsResponse>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/sessions${toQueryString(toIndexSessionQueryParams(request))}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.sessions;
  }

  async startIndexSession(request: StartRemoteIndexSessionRequest): Promise<RemoteIndexSession> {
    const response = await requestJson<{ ok: true; result: RemoteIndexSession }>({
      baseUrl: this.baseUrl,
      paths: ["/v1/index/sessions"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toStartIndexSessionPayload(request)),
      },
    });
    return response.result;
  }

  async sendManifestBatch(sessionId: string, entries: RemoteManifestEntry[]): Promise<RemoteManifestBatchResult> {
    const response = await requestJson<{ ok: true; result: RemoteManifestBatchResult }>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/manifest/batch`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "Content-Encoding": "identity",
        },
        body: manifestEntriesToJsonl(entries),
      },
    });
    return response.result;
  }

  async uploadFileBatch(
    sessionId: string,
    metadata: RemoteFileBatchMetadata,
    files: RemoteFileContent[],
  ): Promise<RemoteFileBatchResult> {
    const multipart = buildMultipartMixed(metadata, files);
    const response = await requestJson<{ ok: true; result: RemoteFileBatchResult }>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/files/batch`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "POST",
        headers: {
          "Content-Type": multipart.contentType,
          Prefer: "respond-async",
        },
        body: new Blob([toArrayBuffer(multipart.body)]),
      },
    });
    return response.result;
  }

  async commitIndexSession(sessionId: string): Promise<RemoteIndexCommitResponse> {
    return requestJson<RemoteIndexCommitResponse>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/commit`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "POST" },
    });
  }

  async getIndexSessionStatus(sessionId: string): Promise<RemoteIndexStatus> {
    const response = await requestJson<{ ok: true; result: RemoteIndexStatus }>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/status`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.result;
  }

  async abortIndexSession(sessionId: string): Promise<{ ok: true; session_id: string; phase: string }> {
    return requestJson<{ ok: true; session_id: string; phase: string }>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "DELETE" },
    });
  }

  private async abortIndexSessionQuietly(sessionId: string): Promise<void> {
    try {
      await this.abortIndexSession(sessionId);
    } catch {
      // Best effort: preserve the original indexing failure for callers.
    }
  }

  private async waitForIndexSessionProcessing(
    sessionId: string,
    timeoutMs: number,
    pollMs: number,
  ): Promise<RemoteIndexStatus> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    for (;;) {
      const status = await this.getIndexSessionStatus(sessionId);
      if (["failed", "incomplete", "aborted", "expired"].includes(status.phase)) {
        throw new Error(
          `Remote index session ${sessionId} entered ${status.phase}: ${status.errors.join("; ") || "unknown error"}`,
        );
      }
      const pendingBatches = status.pending_batches ?? 0;
      const activeBatches = status.active_batches ?? 0;
      if (pendingBatches === 0 && activeBatches === 0 && status.queue_depth === 0) {
        return status;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for remote index session ${sessionId}: ` +
            `phase=${status.phase}; queue_depth=${status.queue_depth}; ` +
            `pending_batches=${pendingBatches}; active_batches=${activeBatches}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, pollMs)));
    }
  }

  async indexWorkspace(request: IndexWorkspaceRequest): Promise<RemoteIndexCommitResponse> {
    const remoteFiles = await Promise.all(request.files.map(prepareRemoteWorkspaceFile));
    const session = await this.startIndexSession(request);
    try {
      const manifestEntries: RemoteManifestEntry[] = [
        ...remoteFiles.map(({ file, content, sha256, mtimeNs }) => ({
          relativePath: file.relativePath,
          op: "upsert" as const,
          size: content.byteLength,
          mtimeNs,
          sha256,
        })),
        ...(request.deletedPaths ?? []).map((relativePath) => ({
          relativePath,
          op: "delete" as const,
        })),
      ];
      const manifestResult = await this.sendManifestBatch(session.session_id, manifestEntries);
      const uploadRequired = new Set(manifestResult.upload_required);
      const filesToUpload = remoteFiles.filter(({ file }) => uploadRequired.has(file.relativePath));
      let queuedBackgroundWork = false;
      if (filesToUpload.length > 0) {
        const uploadBatches = buildUploadBatches(
          filesToUpload,
          request.batchBytes ?? session.max_batch_bytes,
          session.max_batch_files,
        );
        await runWithConcurrency(
          uploadBatches,
          request.maxConcurrentUploads ?? session.max_concurrent_uploads,
          async (batchFiles) => {
            const result = await this.uploadFileBatch(
              session.session_id,
              { files: batchFiles.map((file) => file.descriptor) },
              batchFiles,
            );
            queuedBackgroundWork ||= result.queued === true;
          },
        );
      }
      if (queuedBackgroundWork) {
        await this.waitForIndexSessionProcessing(
          session.session_id,
          request.processingTimeoutMs ?? 15 * 60 * 1000,
          request.processingPollMs ?? 250,
        );
      }
      return await this.commitIndexSession(session.session_id);
    } catch (error) {
      await this.abortIndexSessionQuietly(session.session_id);
      throw error;
    }
  }
}

export function toQualityEventPayload(request: QualityEventRequest): QualityEventPayload {
  return removeUndefinedValues({
    workspace_id: request.workspaceId,
    work_type: request.workType,
    engine: request.engine,
    scorecard: {
      relevance: request.scorecard.relevance,
      file_specificity: request.scorecard.fileSpecificity,
      coverage: request.scorecard.coverage,
      freshness: request.scorecard.freshness,
      actionability: request.scorecard.actionability,
    },
    query: request.query ?? "",
    surface: request.surface,
    round_id: request.roundId,
    result_paths: request.resultPaths ?? [],
    warning: request.warning,
    improvement: request.improvement,
    notes: request.notes,
    issue_url: request.issueUrl,
    metadata: request.metadata ?? {},
  }) as unknown as QualityEventPayload;
}

export function toEnhancePayload(request: string | EnhancePromptRequest): EnhancePromptPayload {
  const normalizedRequest = typeof request === "string" ? { prompt: request } : request;

  return removeUndefinedValues({
    repo_path: normalizedRequest.repoPath,
    workspace_id: normalizedRequest.workspaceId,
    prompt: normalizedRequest.prompt,
    top_k: normalizedRequest.topK,
    min_score: normalizedRequest.minScore,
    output_mode: normalizedRequest.outputMode ?? DEFAULT_OUTPUT_MODE,
    local_only: normalizedRequest.localOnly ?? false,
    source_filter: normalizedRequest.sourceFilter,
  });
}

export function toQueryPayload(request: string | QueryPromptRequest): QueryPromptPayload {
  const normalizedRequest = typeof request === "string" ? { query: request } : request;
  const prompt = normalizedRequest.prompt ?? normalizedRequest.query;
  if (!prompt) {
    throw new Error("Query request requires prompt or query.");
  }

  return removeUndefinedValues({
    repo_path: normalizedRequest.repoPath,
    workspace_id: normalizedRequest.workspaceId,
    prompt,
    top_k: normalizedRequest.topK,
    min_score: normalizedRequest.minScore,
    include_answer: normalizedRequest.includeAnswer ?? false,
    source_filter: normalizedRequest.sourceFilter,
  });
}

export function toGitHubProviderBindingPayload(
  request: GitHubProviderBindingRequest,
): GitHubProviderBindingPayload {
  return removeUndefinedValues({
    installation_id: request.installationId,
    provider_host: request.providerHost,
    display_name: request.displayName,
    repository_allowlist: request.repositoryAllowlist,
  });
}

export function toReviewContextPayload(request: ReviewContextRequest): ReviewContextRequestV1 {
  const budgets = request.budgets === undefined
    ? undefined
    : removeUndefinedValues({
        graph_hops: request.budgets.graphHops,
        candidate_repositories: request.budgets.candidateRepositories,
        pre_rank_candidates: request.budgets.preRankCandidates,
        evidence_items: request.budgets.evidenceItems,
        serialized_tokens: request.budgets.serializedTokens,
        wait_ms: request.budgets.waitMs,
      });
  return removeUndefinedValues({
    codebase_id: request.codebaseId,
    target_repository_id: request.targetRepositoryId,
    provider_review_id: request.providerReviewId,
    expected_head_sha: request.expectedHeadSha,
    objective: request.objective,
    strict_freshness: request.strictFreshness,
    budgets,
    output_character_limit: request.outputCharacterLimit,
  });
}

export function isReviewContextJob(
  result: ReviewContextResult,
): result is ReviewContextJobV1 {
  return "state" in result && "job_id" in result;
}

export function toStartIndexSessionPayload(request: StartRemoteIndexSessionRequest): Record<string, unknown> {
  return removeUndefinedValues({
    workspace: removeUndefinedValues({
      workspace_id: request.workspace.workspaceId,
      display_root: request.workspace.displayRoot,
      name: request.workspace.name,
    }),
    mode: request.mode ?? "incremental",
    client: request.client ?? {},
    include_globs: request.includeGlobs,
    exclude_globs: request.excludeGlobs,
    max_file_size_bytes: request.maxFileSizeBytes,
    recreate_collection: request.recreateCollection ?? false,
    snapshot_scope: toRemoteIndexScopePayload(request.snapshotScope),
  });
}

function toRemoteIndexScopePayload(
  scope: RemoteIndexScopeV2 | null | undefined,
): Record<string, unknown> | null | undefined {
  if (scope === null || scope === undefined) {
    return scope;
  }
  return removeUndefinedValues({
    tenant_id: scope.tenantId,
    codebase_id: scope.codebaseId,
    repository_id: scope.repositoryId,
    repository_set_id: scope.repositorySetId,
    snapshot_id: scope.snapshotId,
    layer: scope.layer,
    revision: scope.revision,
    generation: scope.generation,
    overlay_id: scope.overlayId,
  });
}

export function manifestEntriesToJsonl(entries: RemoteManifestEntry[]): string {
  return entries.map((entry) => JSON.stringify(toRemoteManifestEntryPayload(entry))).join("\n") + "\n";
}

function toRemoteManifestEntryPayload(entry: RemoteManifestEntry): Record<string, unknown> {
  return removeUndefinedValues({
    relative_path: entry.relativePath,
    op: entry.op ?? "upsert",
    size: entry.size ?? 0,
    mtime_ns: entry.mtimeNs ?? 0,
    sha256: entry.sha256,
    mode: entry.mode,
    doc_type_hint: entry.docTypeHint,
    language: entry.language,
  });
}

function toRemoteFileDescriptorPayload(descriptor: RemoteFileContent["descriptor"]): Record<string, unknown> {
  return {
    relative_path: descriptor.relativePath,
    content_id: descriptor.contentId,
    size: descriptor.size,
    sha256: descriptor.sha256,
    mtime_ns: descriptor.mtimeNs,
  };
}

function buildMultipartMixed(
  metadata: RemoteFileBatchMetadata,
  files: RemoteFileContent[],
): { contentType: string; body: Uint8Array } {
  const boundary = `corpuswire-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const pushText = (value: string) => chunks.push(encoder.encode(value));

  pushText(`--${boundary}\r\nContent-Type: application/json\r\nContent-ID: <metadata>\r\n\r\n`);
  pushText(JSON.stringify({ files: metadata.files.map(toRemoteFileDescriptorPayload) }));
  pushText("\r\n");

  for (const file of files) {
    pushText(
      `--${boundary}\r\nContent-Type: ${file.contentType ?? "application/octet-stream"}\r\nContent-ID: <${file.descriptor.contentId}>\r\n\r\n`,
    );
    chunks.push(toUint8Array(file.content));
    pushText("\r\n");
  }
  pushText(`--${boundary}--\r\n`);

  return {
    contentType: `multipart/mixed; boundary=${boundary}`,
    body: concatUint8Arrays(chunks),
  };
}

async function prepareRemoteWorkspaceFile(
  file: RemoteWorkspaceFile,
): Promise<{ file: RemoteWorkspaceFile; content: Uint8Array; sha256: string; mtimeNs: number }> {
  const content = toUint8Array(file.content);
  return {
    file,
    content,
    sha256: file.sha256 ?? await sha256Hex(content),
    mtimeNs: file.mtimeNs ?? Date.now() * 1_000_000,
  };
}

function buildUploadBatches(
  files: Array<{ file: RemoteWorkspaceFile; content: Uint8Array; sha256: string; mtimeNs: number }>,
  batchBytes: number,
  batchFiles?: number,
): RemoteFileContent[][] {
  const maxBatchBytes = Math.max(1, Math.floor(batchBytes));
  const maxBatchFiles = batchFiles === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(batchFiles));
  const batches: RemoteFileContent[][] = [];
  let currentBatch: RemoteFileContent[] = [];
  let currentBytes = 0;
  let fileIndex = 0;

  for (const preparedFile of files) {
    const nextFile = toRemoteFileContent(preparedFile, `file-${fileIndex}`);
    fileIndex += 1;
    if (
      currentBatch.length > 0 &&
      (currentBytes + preparedFile.content.byteLength > maxBatchBytes || currentBatch.length >= maxBatchFiles)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }
    currentBatch.push(nextFile);
    currentBytes += preparedFile.content.byteLength;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}

function toRemoteFileContent(
  preparedFile: { file: RemoteWorkspaceFile; content: Uint8Array; sha256: string; mtimeNs: number },
  contentId: string,
): RemoteFileContent {
  return {
    descriptor: {
      relativePath: preparedFile.file.relativePath,
      contentId,
      size: preparedFile.content.byteLength,
      sha256: preparedFile.sha256,
      mtimeNs: preparedFile.mtimeNs,
    },
    content: preparedFile.content,
  };
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const maxConcurrency = Math.max(1, Math.floor(concurrency));
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    const currentIndex = nextIndex;
    nextIndex += 1;
    if (currentIndex >= items.length) {
      return;
    }
    await worker(items[currentIndex]);
    await runNext();
  }
  await Promise.all(items.slice(0, maxConcurrency).map(() => runNext()));
}

async function sha256Hex(content: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Remote indexWorkspace requires sha256 values when Web Crypto is unavailable.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toUint8Array(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function removeUndefinedValues<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function requireIdentifier(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} must not be empty.`);
  }
  return normalized;
}

function validateNonNegativeNumber(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a finite non-negative number.`);
  }
  return value;
}

function throwIfReviewPollingCancelled(signal: AbortSignal | undefined, jobId: string): void {
  if (signal?.aborted) {
    throw new ReviewContextPollingCancelledError(jobId);
  }
}

async function waitForReviewPoll(
  delayMs: number,
  signal: AbortSignal | undefined,
  jobId: string,
): Promise<void> {
  throwIfReviewPollingCancelled(signal, jobId);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new ReviewContextPollingCancelledError(jobId));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toIndexEventQueryParams(request: IndexEventQuery): Record<string, string | undefined> {
  return {
    workspace_id: request.workspaceId,
    collection: request.collection,
    status: request.status,
    operation: request.operation,
    limit: request.limit === undefined ? undefined : String(request.limit),
  };
}

function toIndexActivityQueryParams(request: IndexActivityQuery): Record<string, string | undefined> {
  return {
    workspace_id: request.workspaceId,
    collection: request.collection,
    window_hours: request.windowHours === undefined ? undefined : String(request.windowHours),
    expected_interval_seconds: request.expectedIntervalSeconds === undefined ? undefined : String(request.expectedIntervalSeconds),
  };
}

function toIndexSessionQueryParams(request: IndexSessionQuery): Record<string, string | undefined> {
  return {
    workspace_id: request.workspaceId,
  };
}

function toQueryString(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function resolveEnhancedPrompt(result: PromptRewriteResult): string | null {
  return result.enhanced_prompt ?? result.enhancement_prompt ?? null;
}

export function requireEnhancedPrompt(result: PromptRewriteResult): string {
  const prompt = resolveEnhancedPrompt(result);
  if (prompt) {
    return prompt;
  }

  throw new Error(result.generation_error ?? "Backend returned no enhanced prompt.");
}
