import { INVENTORY_VERSION, WorkspaceScanIncompleteError, buildWorkspaceInventory, canonicalInventoryPath, inventoryDigest } from "./inventory.js";
import { createBearerAuthHeader, requestJson } from "./http.js";
const RUNTIME_ENV = globalThis.process?.env ?? {};
const DEFAULT_BASE_URL = RUNTIME_ENV.CORPUSWIRE_BASE_URL ?? "http://127.0.0.1:8000";
const DEFAULT_BASIC_AUTH = RUNTIME_ENV.CORPUSWIRE_BASIC_AUTH ?? "";
const DEFAULT_BEARER_TOKEN = RUNTIME_ENV.CORPUSWIRE_BEARER_TOKEN ?? "";
const DEFAULT_OUTPUT_MODE = "generic";
const DEFAULT_REVIEW_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_REVIEW_POLL_INTERVAL_MS = 1_000;
export class RemoteIndexDetachedError extends Error {
    transfer;
    sessionId;
    status;
    backendContinues = true;
    constructor(sessionId, status, reason) {
        super(`${reason}; backend indexing continues for session ${sessionId}. `
            + `Reattach with getIndexSessionStatus(${JSON.stringify(sessionId)}).`);
        this.name = "RemoteIndexDetachedError";
        this.sessionId = sessionId;
        this.status = status;
    }
}
export class RemoteIndexCancelledError extends Error {
    transfer;
    sessionId;
    status;
    constructor(sessionId, status) {
        super(`Remote index session ${sessionId} was cancelled.`);
        this.name = "RemoteIndexCancelledError";
        this.sessionId = sessionId;
        this.status = status;
    }
}
const PENDING_REVIEW_JOB_STATES = new Set(["queued", "running"]);
const REVIEW_JOB_STATES_V2 = new Set([
    "queued", "running", "succeeded", "partial", "failed", "cancelled", "superseded",
]);
const SYMBOL_CHANGE_KINDS_V2 = new Set([
    "added", "removed", "modified", "signature_changed", "renamed", "moved",
    "renamed_and_moved", "unchanged_context", "ambiguous", "unresolved",
    "unsupported_split_merge",
]);
const PAIRING_STATUSES_V2 = new Set([
    "exact_symbol_id", "exact_analyzer_declaration_id", "exact_unique_declaration_key",
    "one_sided", "ambiguous", "unresolved", "unsupported",
]);
const CONTINUITY_STATUSES_V2 = new Set([
    "proven", "not_established", "ambiguous", "unavailable",
]);
const RELATIONSHIP_DELTA_STATUSES_V2 = new Set([
    "added", "removed", "preserved", "evidence_changed", "ambiguous", "unresolved",
]);
const BUNDLE_OMISSION_REASONS_V2 = new Set([
    "required_pair_budget_exceeded",
    "required_evidence_unavailable",
    "required_evidence_capacity_exceeded",
]);
export class ReviewContextPollingTimeoutError extends Error {
    jobId;
    timeoutMs;
    constructor(jobId, timeoutMs) {
        super(`Timed out after ${timeoutMs}ms waiting for review-context job ${jobId}.`);
        this.name = "ReviewContextPollingTimeoutError";
        this.jobId = jobId;
        this.timeoutMs = timeoutMs;
    }
}
export class ReviewContextPollingCancelledError extends Error {
    jobId;
    constructor(jobId) {
        super(`Polling was cancelled for review-context job ${jobId}.`);
        this.name = "ReviewContextPollingCancelledError";
        this.jobId = jobId;
    }
}
export class CorpusWireClient {
    baseUrl;
    basicAuth;
    bearerToken;
    endpointMode;
    fetchFn;
    defaultHeaders;
    constructor(options = {}) {
        this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
        this.basicAuth = options.basicAuth ?? DEFAULT_BASIC_AUTH;
        this.bearerToken = options.bearerToken ?? DEFAULT_BEARER_TOKEN;
        this.endpointMode = options.endpointMode ?? "compat";
        this.fetchFn = options.fetchFn;
        this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
        const configuredAuthorization = Object.keys(this.defaultHeaders).some((name) => name.toLowerCase() === "authorization");
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
    async health(request = {}) {
        const query = toQueryString({
            repo_path: request.repoPath,
            workspace_id: request.workspaceId,
        });
        return requestJson({
            baseUrl: this.baseUrl,
            paths: this.endpointMode === "v1-only" ? [`/v1/health${query}`] : [`/v1/health${query}`, `/health${query}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
    }
    async diagnoseWorkspace(request = {}) {
        const query = toQueryString({
            repo_path: request.repoPath,
            workspace_id: request.workspaceId,
        });
        const response = await requestJson({
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
    async enhance(request) {
        const response = await this.enhanceRaw(request);
        return response.result;
    }
    async enhanceRaw(request) {
        return requestJson({
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
    async query(request) {
        const response = await this.queryRaw(request);
        return response.result;
    }
    async queryRaw(request) {
        return requestJson({
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
    async semanticSearch(request) {
        const response = await this.query({
            ...(typeof request === "string" ? { query: request } : request),
            includeAnswer: false,
        });
        return response.retrieved_chunks;
    }
    async recordQualityEvent(request) {
        const response = await requestJson({
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
    async listQualityEvents(request = {}) {
        const query = toQueryString({
            workspace_id: request.workspaceId,
            work_type: request.workType,
            engine: request.engine,
            days: request.days?.toString(),
            limit: request.limit?.toString(),
        });
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/quality/events${query}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
        return response.events;
    }
    async reviewQuality(request = {}) {
        const query = toQueryString({
            workspace_id: request.workspaceId,
            work_type: request.workType,
            engine: request.engine,
            days: request.days?.toString(),
        });
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/quality/review${query}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
        return response.review;
    }
    async confirmQueryValue(request) {
        const response = await requestJson({
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
    async valueRollup(request = {}) {
        const query = toQueryString({
            period: request.period,
            days: request.days?.toString(),
            workspace_id: request.workspaceId,
            hourly_rate: request.hourlyRate?.toString(),
        });
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/value/rollup${query}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
        return response.rollup;
    }
    async createCodebase(request) {
        return requestJson({
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
    async listCodebases() {
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: ["/v1/codebases"],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
        return response.codebases;
    }
    async getCodebase(codebaseId) {
        return requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/codebases/${encodeURIComponent(requireIdentifier(codebaseId, "codebaseId"))}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
    }
    async updateCodebase(codebaseId, request) {
        return requestJson({
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
    async deleteCodebase(codebaseId) {
        return requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/codebases/${encodeURIComponent(requireIdentifier(codebaseId, "codebaseId"))}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "DELETE" },
        });
    }
    async listCodebaseRepositories(codebaseId) {
        return requestJson({
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
    async bindGitHubProvider(codebaseId, request) {
        return requestJson({
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
    async revokeGitHubProvider(codebaseId, installationId, providerHost = "github.com") {
        const query = toQueryString({
            installation_id: requireIdentifier(installationId, "installationId"),
            provider_host: requireIdentifier(providerHost, "providerHost"),
        });
        return requestJson({
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
    async getReviewContextCapabilities() {
        return requestJson({
            baseUrl: this.baseUrl,
            paths: ["/v1/review-context/capabilities"],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
    }
    async getReviewTelemetrySummary() {
        return requestJson({
            baseUrl: this.baseUrl,
            paths: ["/v1/review-context/telemetry/summary"],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
    }
    async requestReviewContext(request) {
        const codebaseId = requireIdentifier(request.codebaseId, "codebaseId");
        return requestJson({
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
    async getReviewContextJob(jobId) {
        return requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/review-context/jobs/${encodeURIComponent(requireIdentifier(jobId, "jobId"))}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
    }
    async cancelReviewContextJob(jobId) {
        return requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/review-context/jobs/${encodeURIComponent(requireIdentifier(jobId, "jobId"))}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "DELETE" },
        });
    }
    async pollReviewContextJob(jobOrId, options = {}) {
        const timeoutMs = validateNonNegativeNumber(options.timeoutMs ?? DEFAULT_REVIEW_POLL_TIMEOUT_MS, "timeoutMs");
        const pollIntervalMs = validateNonNegativeNumber(options.pollIntervalMs ?? DEFAULT_REVIEW_POLL_INTERVAL_MS, "pollIntervalMs");
        const jobId = requireIdentifier(typeof jobOrId === "string" ? jobOrId : jobOrId.job_id, "jobId");
        const deadline = Date.now() + timeoutMs;
        let result = typeof jobOrId === "string"
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
            await waitForReviewPoll(Math.min(remainingMs, Math.max(10, serverDelayMs)), options.signal, jobId);
            result = await this.getReviewContextJob(jobId);
        }
    }
    async requestReviewContextAndWait(request, options = {}) {
        const result = await this.requestReviewContext(request);
        return isReviewContextJob(result) && PENDING_REVIEW_JOB_STATES.has(result.state)
            ? this.pollReviewContextJob(result, options)
            : result;
    }
    async getReviewStatus(codebaseId, reviewId) {
        return requestJson({
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
    /** Read the isolated deterministic symbol-change v2 capability envelope. */
    async getReviewContextCapabilitiesV2() {
        const result = await requestJson({
            baseUrl: this.baseUrl,
            paths: ["/v2/review-context/capabilities"],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
        requireReviewContextV2Envelope(result, "capabilities", true);
        if (!isReviewCapabilitiesV2(result)) {
            throw new Error("Malformed capabilities v2 contract.");
        }
        return result;
    }
    /** Request deterministic before/after symbol evidence through the v2-only route. */
    async requestReviewContextV2(request) {
        const codebaseId = requireIdentifier(request.codebaseId, "codebaseId");
        const result = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v2/codebases/${encodeURIComponent(codebaseId)}/reviews/context`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(toReviewContextPayloadV2(request)),
            },
        });
        return requireReviewContextV2Result(result, "request result");
    }
    async getReviewContextJobV2(jobId) {
        const result = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v2/review-context/jobs/${encodeURIComponent(requireIdentifier(jobId, "jobId"))}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
        return requireReviewContextV2Result(result, "job result");
    }
    async cancelReviewContextJobV2(jobId) {
        const result = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v2/review-context/jobs/${encodeURIComponent(requireIdentifier(jobId, "jobId"))}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "DELETE" },
        });
        requireReviewContextV2Envelope(result, "cancel result", true);
        requireReviewContextJobV2(result, "cancel result");
        return result;
    }
    async pollReviewContextJobV2(jobOrId, options = {}) {
        const timeoutMs = validateNonNegativeNumber(options.timeoutMs ?? DEFAULT_REVIEW_POLL_TIMEOUT_MS, "timeoutMs");
        const pollIntervalMs = validateNonNegativeNumber(options.pollIntervalMs ?? DEFAULT_REVIEW_POLL_INTERVAL_MS, "pollIntervalMs");
        const jobId = requireIdentifier(typeof jobOrId === "string" ? jobOrId : jobOrId.job_id, "jobId");
        const deadline = Date.now() + timeoutMs;
        let result = typeof jobOrId === "string"
            ? await this.getReviewContextJobV2(jobId)
            : jobOrId;
        for (;;) {
            throwIfReviewPollingCancelled(options.signal, jobId);
            if (!isReviewContextJobV2(result) || !PENDING_REVIEW_JOB_STATES.has(result.state)) {
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
            await waitForReviewPoll(Math.min(remainingMs, Math.max(10, serverDelayMs)), options.signal, jobId);
            result = await this.getReviewContextJobV2(jobId);
        }
    }
    async requestReviewContextV2AndWait(request, options = {}) {
        const result = await this.requestReviewContextV2(request);
        return isReviewContextJobV2(result) && PENDING_REVIEW_JOB_STATES.has(result.state)
            ? this.pollReviewContextJobV2(result, options)
            : result;
    }
    async getReviewStatusV2(codebaseId, reviewId) {
        const result = await requestJson({
            baseUrl: this.baseUrl,
            paths: [
                `/v2/codebases/${encodeURIComponent(requireIdentifier(codebaseId, "codebaseId"))}`
                    + `/reviews/${encodeURIComponent(requireIdentifier(reviewId, "reviewId"))}/status`,
            ],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
        requireReviewContextV2Envelope(result, "status result", true);
        requireReviewStatusV2(result, "status result");
        return result;
    }
    async purgeReviewOverlay(codebaseId, reviewId) {
        return requestJson({
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
    async getLlmModel() {
        return requestJson({
            baseUrl: this.baseUrl,
            paths: ["/llm/model"],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
    }
    async setLlmModel(model) {
        return requestJson({
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
    async getIndexCapabilities() {
        return requestJson({
            baseUrl: this.baseUrl,
            paths: ["/v1/index/capabilities"],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
    }
    async getIndexEvents(request = {}) {
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/index/events${toQueryString(toIndexEventQueryParams(request))}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
        return response.events;
    }
    async getIndexActivity(request = {}) {
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/index/activity${toQueryString(toIndexActivityQueryParams(request))}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
        return response.activity;
    }
    async listIndexSessions(request = {}) {
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/index/sessions${toQueryString(toIndexSessionQueryParams(request))}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
        return response.sessions;
    }
    async startIndexSession(request) {
        if (request.inventory || request.baseCoverageToken || request.selectionPolicyDigest) {
            const capabilities = await this.getIndexCapabilities();
            if (!capabilities.inventory_coverage_versions?.includes(INVENTORY_VERSION)) {
                request = { ...request, inventory: undefined, baseCoverageToken: undefined, selectionPolicyDigest: undefined };
            }
        }
        const response = await requestJson({
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
    async previewIndexWorkspace(request) {
        const remoteFiles = await Promise.all(request.files.map(prepareRemoteWorkspaceFile));
        const manifest = buildWorkspaceManifest(remoteFiles, request.deletedPaths ?? []);
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: ["/v1/index/preview"],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...toStartIndexSessionPayload(request),
                    manifest: manifest.map(toRemoteManifestEntryPayload),
                }),
            },
        });
        return response.result;
    }
    async sendManifestBatch(sessionId, entries) {
        const response = await requestJson({
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
    async uploadFileBatch(sessionId, metadata, files, onAttempt) {
        const multipart = buildMultipartMixed(metadata, files);
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/files/batch`],
            fetchFn: (input, init) => { onAttempt?.(); return (this.fetchFn ?? globalThis.fetch)(input, init); },
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
    async commitIndexSession(sessionId) {
        return requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/commit`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "POST" },
        });
    }
    async getIndexSessionStatus(sessionId) {
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/status`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET" },
        });
        return response.result;
    }
    async followIndexSession(sessionId, options = {}) {
        const deadline = options.timeoutMs === undefined
            ? null
            : Date.now() + Math.max(1, options.timeoutMs);
        let abortSent = false;
        let lastSequence = -1;
        for (;;) {
            const status = await this.getIndexSessionStatus(sessionId);
            if (status.progress && status.progress.sequence !== lastSequence) {
                options.onProgress?.(status.progress);
                lastSequence = status.progress.sequence;
            }
            if (["completed", "aborted", "failed", "expired"].includes(status.phase)) {
                return status;
            }
            if (options.signal?.aborted && !abortSent) {
                await this.abortIndexSession(sessionId);
                abortSent = true;
            }
            if (options.detachSignal?.aborted) {
                throw new RemoteIndexDetachedError(sessionId, status, "Detached by caller");
            }
            if (deadline !== null && Date.now() >= deadline) {
                throw new RemoteIndexDetachedError(sessionId, status, "Caller wait timeout elapsed");
            }
            await new Promise((resolve) => setTimeout(resolve, Math.max(10, options.pollMs ?? 250)));
        }
    }
    async abortIndexSession(sessionId) {
        return requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "DELETE" },
        });
    }
    async abortIndexSessionQuietly(sessionId) {
        try {
            await this.abortIndexSession(sessionId);
        }
        catch {
            // Best effort: preserve the original indexing failure for callers.
        }
    }
    async waitForIndexSessionProcessing(sessionId, timeoutMs, pollMs, request) {
        const deadline = timeoutMs === undefined ? null : Date.now() + Math.max(1, timeoutMs);
        let lastSequence = -1;
        for (;;) {
            const status = await this.getIndexSessionStatus(sessionId);
            if (status.progress && status.progress.sequence !== lastSequence) {
                request.onProgress?.(status.progress);
                lastSequence = status.progress.sequence;
            }
            if (["failed", "incomplete", "aborted", "expired"].includes(status.phase)) {
                if (status.phase === "aborted") {
                    return status;
                }
                throw new Error(`Remote index session ${sessionId} entered ${status.phase}: ${status.errors.join("; ") || "unknown error"}`);
            }
            const pendingBatches = status.pending_batches ?? 0;
            const activeBatches = status.active_batches ?? 0;
            if (pendingBatches === 0 && activeBatches === 0 && status.queue_depth === 0) {
                return status;
            }
            if (request.signal?.aborted) {
                return status;
            }
            if (request.detachSignal?.aborted) {
                throw new RemoteIndexDetachedError(sessionId, status, "Detached by caller");
            }
            if (deadline !== null && Date.now() >= deadline) {
                throw new RemoteIndexDetachedError(sessionId, status, "Caller wait timeout elapsed");
            }
            await new Promise((resolve) => setTimeout(resolve, Math.max(10, pollMs)));
        }
    }
    async indexWorkspace(request) {
        const clientStartedAt = Date.now();
        let clientSequence = 0;
        let lastOverallPercent = null;
        const emitProgress = (event) => {
            const normalized = { ...event };
            if (normalized.overall_percent !== null) {
                normalized.overall_percent = lastOverallPercent === null
                    ? normalized.overall_percent
                    : Math.max(lastOverallPercent, normalized.overall_percent);
                lastOverallPercent = normalized.overall_percent;
            }
            request.onProgress?.(normalized);
        };
        const emitClientProgress = (phase, completed, total, unit, message, sessionId = "pending", overallCompleted = 0, overallTotal = null) => {
            emitProgress(clientIndexProgressEvent({
                sequence: clientSequence,
                sessionId,
                workspaceId: request.workspace.workspaceId,
                phase,
                completed,
                total,
                unit,
                message,
                startedAt: clientStartedAt,
                overallCompleted,
                overallTotal,
            }));
            clientSequence += 1;
        };
        emitClientProgress("resolving_configuration", 0, null, "items", "Resolving remote indexing configuration");
        const remoteFiles = await Promise.all(request.files.map(prepareRemoteWorkspaceFile));
        emitClientProgress("filtering_hashing", remoteFiles.length, remoteFiles.length, "files", "Workspace file hashes prepared");
        if (request.inventoryScan && request.signal?.aborted)
            throw new WorkspaceScanIncompleteError("Scan cancelled before session creation");
        const triples = remoteFiles.map(({ file, sha256, content }) => [file.relativePath, sha256, content.length]);
        await inventoryDigest(triples);
        if (request.inventoryScan) {
            if (request.mode !== "full" || request.snapshotScope)
                throw new WorkspaceScanIncompleteError("Inventory requires a v1 full scan");
            const capabilities = await this.getIndexCapabilities();
            if (request.inventoryScan.complete !== true)
                throw new WorkspaceScanIncompleteError();
            if (capabilities.inventory_coverage_versions?.includes(INVENTORY_VERSION)) {
                if (!capabilities.supported_file_registry_version)
                    throw new WorkspaceScanIncompleteError("Missing supported file registry version");
                request = { ...request, inventory: await buildWorkspaceInventory(triples, {
                        version: "workspace-selection/v1", include_globs: request.includeGlobs ?? [], exclude_globs: request.excludeGlobs ?? [],
                        ignore_digest: request.inventoryScan.ignoreDigest, producer: request.inventoryScan.producer,
                        supported_file_registry_version: capabilities.supported_file_registry_version,
                        max_file_size_bytes: Math.min(request.maxFileSizeBytes ?? capabilities.max_file_size_bytes, capabilities.max_file_size_bytes),
                        symlink_policy: "skip",
                    }, request.inventoryScan) };
            }
        }
        const transfer = {
            files_submitted: remoteFiles.length, files_upload_required: null, files_reused: null,
            files_transferred: 0, source_bytes_transferred: 0, upload_attempts: 0,
            source_bytes_attempted: 0, complete: false, acknowledged_files: [],
        };
        const session = await this.startIndexSession(request);
        try {
            const manifestEntries = buildWorkspaceManifest(remoteFiles, request.deletedPaths ?? []);
            emitClientProgress("manifest_comparison", 0, manifestEntries.length, "files", "Sending manifest for comparison", session.session_id);
            const manifestResult = await this.sendManifestBatch(session.session_id, manifestEntries);
            const initiallyComplete = manifestResult.unchanged + manifestResult.deletes + manifestResult.skipped;
            emitClientProgress("manifest_comparison", manifestEntries.length, manifestEntries.length, "files", "Manifest comparison complete", session.session_id, initiallyComplete, manifestEntries.length);
            const uploadRequired = new Set(manifestResult.upload_required);
            transfer.files_upload_required = uploadRequired.size;
            transfer.files_reused = manifestResult.unchanged;
            if (manifestResult.errors.length || manifestResult.skipped) {
                throw new WorkspaceScanIncompleteError("Server rejected manifest entries");
            }
            for (const { file, sha256 } of remoteFiles) {
                if (!uploadRequired.has(file.relativePath)) {
                    transfer.acknowledged_files.push({ relative_path: file.relativePath, sha256, disposition: "confirmed_reused" });
                }
            }
            const filesToUpload = remoteFiles.filter(({ file }) => uploadRequired.has(file.relativePath));
            let queuedBackgroundWork = false;
            let uploadedFiles = 0;
            if (filesToUpload.length > 0) {
                const uploadBatches = buildUploadBatches(filesToUpload, request.batchBytes ?? session.max_batch_bytes, session.max_batch_files);
                await runWithConcurrency(uploadBatches, request.maxConcurrentUploads ?? session.max_concurrent_uploads, async (batchFiles) => {
                    const result = await this.uploadFileBatch(session.session_id, { files: batchFiles.map((file) => file.descriptor) }, batchFiles, () => {
                        transfer.upload_attempts += 1;
                        transfer.source_bytes_attempted += batchFiles.reduce((sum, file) => sum + file.descriptor.size, 0);
                    });
                    if (result.errors.length)
                        throw new Error("Source upload was not fully acknowledged");
                    transfer.files_transferred += batchFiles.length;
                    transfer.source_bytes_transferred += batchFiles.reduce((sum, file) => sum + file.descriptor.size, 0);
                    transfer.acknowledged_files.push(...batchFiles.map((file) => ({
                        relative_path: file.descriptor.relativePath, sha256: file.descriptor.sha256, disposition: "uploaded",
                    })));
                    queuedBackgroundWork ||= result.queued === true;
                    uploadedFiles += batchFiles.length;
                    emitClientProgress("uploading", uploadedFiles, filesToUpload.length, "files", "Uploading changed files", session.session_id, initiallyComplete, manifestEntries.length);
                });
            }
            if (queuedBackgroundWork) {
                const processingStatus = await this.waitForIndexSessionProcessing(session.session_id, request.processingTimeoutMs, request.processingPollMs ?? 250, { ...request, onProgress: emitProgress });
                if (request.signal?.aborted || processingStatus.phase === "aborted") {
                    if (processingStatus.phase !== "aborted") {
                        await this.abortIndexSession(session.session_id);
                    }
                    const terminal = await this.waitForIndexSessionTerminal(session.session_id, request.processingPollMs ?? 250, emitProgress, request.detachSignal);
                    throw new RemoteIndexCancelledError(session.session_id, terminal);
                }
            }
            if (request.signal?.aborted) {
                await this.abortIndexSession(session.session_id);
                const terminal = await this.waitForIndexSessionTerminal(session.session_id, request.processingPollMs ?? 250, emitProgress, request.detachSignal);
                throw new RemoteIndexCancelledError(session.session_id, terminal);
            }
            const committed = await this.commitIndexSession(session.session_id);
            if (committed.status.progress) {
                emitProgress(committed.status.progress);
            }
            transfer.complete = true;
            return { ...committed, transfer };
        }
        catch (error) {
            if (error instanceof Error)
                Object.assign(error, { transfer });
            if (error instanceof RemoteIndexDetachedError || error instanceof RemoteIndexCancelledError) {
                throw error;
            }
            await this.abortIndexSessionQuietly(session.session_id);
            throw error;
        }
    }
    async waitForIndexSessionTerminal(sessionId, pollMs, onProgress, detachSignal) {
        for (;;) {
            const status = await this.getIndexSessionStatus(sessionId);
            if (status.progress) {
                onProgress?.(status.progress);
            }
            if (["aborted", "failed", "expired", "completed"].includes(status.phase)) {
                return status;
            }
            if (detachSignal?.aborted) {
                throw new RemoteIndexDetachedError(sessionId, status, "Detached while cancellation was pending");
            }
            await new Promise((resolve) => setTimeout(resolve, Math.max(10, pollMs)));
        }
    }
}
export function toQualityEventPayload(request) {
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
    });
}
export function toEnhancePayload(request) {
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
export function toQueryPayload(request) {
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
export function toGitHubProviderBindingPayload(request) {
    return removeUndefinedValues({
        installation_id: request.installationId,
        provider_host: request.providerHost,
        display_name: request.displayName,
        repository_allowlist: request.repositoryAllowlist,
    });
}
export function toReviewContextPayload(request) {
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
export function isReviewContextJob(result) {
    return "state" in result && "job_id" in result;
}
export function toReviewContextPayloadV2(request) {
    const budgets = request.budgets === undefined
        ? undefined
        : removeUndefinedValues({
            graph_hops: request.budgets.graphHops,
            candidate_repositories: request.budgets.candidateRepositories,
            pre_rank_candidates: request.budgets.preRankCandidates,
            evidence_items: request.budgets.evidenceItems,
            serialized_tokens: request.budgets.serializedTokens,
            serialized_characters: request.budgets.serializedCharacters,
            serialized_utf8_bytes: request.budgets.serializedUtf8Bytes,
            wait_ms: request.budgets.waitMs,
        });
    return removeUndefinedValues({
        schema_version: "review-context/v2",
        codebase_id: request.codebaseId,
        target_repository_id: request.targetRepositoryId,
        provider_review_id: request.providerReviewId,
        expected_head_sha: request.expectedHeadSha,
        objective: request.objective,
        strict_freshness: request.strictFreshness,
        budgets,
    });
}
export function isReviewContextJobV2(result) {
    return isRecord(result)
        && typeof result.job_id === "string"
        && REVIEW_JOB_STATES_V2.has(result.state);
}
export function toStartIndexSessionPayload(request) {
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
        inventory: request.inventory,
        base_coverage_token: request.baseCoverageToken,
        selection_policy_digest: request.selectionPolicyDigest,
    });
}
function toRemoteIndexScopePayload(scope) {
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
export function manifestEntriesToJsonl(entries) {
    return entries.map((entry) => JSON.stringify(toRemoteManifestEntryPayload(entry))).join("\n") + "\n";
}
function toRemoteManifestEntryPayload(entry) {
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
function toRemoteFileDescriptorPayload(descriptor) {
    return {
        relative_path: descriptor.relativePath,
        content_id: descriptor.contentId,
        size: descriptor.size,
        sha256: descriptor.sha256,
        mtime_ns: descriptor.mtimeNs,
    };
}
function buildMultipartMixed(metadata, files) {
    const boundary = `corpuswire-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const chunks = [];
    const encoder = new TextEncoder();
    const pushText = (value) => chunks.push(encoder.encode(value));
    pushText(`--${boundary}\r\nContent-Type: application/json\r\nContent-ID: <metadata>\r\n\r\n`);
    pushText(JSON.stringify({ files: metadata.files.map(toRemoteFileDescriptorPayload) }));
    pushText("\r\n");
    for (const file of files) {
        pushText(`--${boundary}\r\nContent-Type: ${file.contentType ?? "application/octet-stream"}\r\nContent-ID: <${file.descriptor.contentId}>\r\n\r\n`);
        chunks.push(toUint8Array(file.content));
        pushText("\r\n");
    }
    pushText(`--${boundary}--\r\n`);
    return {
        contentType: `multipart/mixed; boundary=${boundary}`,
        body: concatUint8Arrays(chunks),
    };
}
async function prepareRemoteWorkspaceFile(file) {
    const content = new Uint8Array(toUint8Array(file.content));
    const sha256 = await sha256Hex(content);
    if (file.sha256 !== undefined && file.sha256 !== sha256)
        throw new WorkspaceScanIncompleteError("Source hash changed after scan");
    return {
        file: { ...file, relativePath: canonicalInventoryPath(file.relativePath) },
        content,
        sha256,
        mtimeNs: file.mtimeNs ?? Date.now() * 1_000_000,
    };
}
function buildWorkspaceManifest(remoteFiles, deletedPaths) {
    return [
        ...remoteFiles.map(({ file, content, sha256, mtimeNs }) => ({
            relativePath: file.relativePath,
            op: "upsert",
            size: content.byteLength,
            mtimeNs,
            sha256,
        })),
        ...deletedPaths.map((relativePath) => ({
            relativePath,
            op: "delete",
        })),
    ];
}
function clientIndexProgressEvent(options) {
    const elapsedMs = Math.max(0, Date.now() - options.startedAt);
    const throughput = elapsedMs > 0 && options.completed > 0
        ? options.completed / (elapsedMs / 1_000)
        : null;
    const overallPercent = options.overallTotal && options.overallTotal > 0
        ? Math.min(99, (options.overallCompleted / options.overallTotal) * 99)
        : null;
    return {
        schema_version: "index-progress/v1",
        sequence: options.sequence,
        session_id: options.sessionId,
        workspace_id: options.workspaceId,
        occurred_at: new Date().toISOString(),
        phase: options.phase,
        state: "running",
        message: options.message,
        overall_completed: options.overallCompleted,
        overall_total: options.overallTotal,
        overall_percent: overallPercent,
        overall_indeterminate: overallPercent === null,
        phase_completed: options.completed,
        phase_total: options.total,
        unit: options.unit,
        elapsed_ms: elapsedMs,
        phase_elapsed_ms: elapsedMs,
        throughput_per_second: throughput,
        queue_depth: 0,
        retries: 0,
        warnings: [],
        eta_seconds: null,
        eta_confidence: "unknown",
        heartbeat: false,
        last_progress_at: new Date().toISOString(),
        last_heartbeat_at: null,
        active_heartbeat: false,
        counts: {},
        phase_timings_ms: {},
        verification_status: "pending",
    };
}
function buildUploadBatches(files, batchBytes, batchFiles) {
    const maxBatchBytes = Math.max(1, Math.floor(batchBytes));
    const maxBatchFiles = batchFiles === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.floor(batchFiles));
    const batches = [];
    let currentBatch = [];
    let currentBytes = 0;
    let fileIndex = 0;
    for (const preparedFile of files) {
        const nextFile = toRemoteFileContent(preparedFile, `file-${fileIndex}`);
        fileIndex += 1;
        if (currentBatch.length > 0 &&
            (currentBytes + preparedFile.content.byteLength > maxBatchBytes || currentBatch.length >= maxBatchFiles)) {
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
function toRemoteFileContent(preparedFile, contentId) {
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
async function runWithConcurrency(items, concurrency, worker) {
    const maxConcurrency = Math.max(1, Math.floor(concurrency));
    let nextIndex = 0;
    let failed = false;
    let firstError;
    async function runNext() {
        while (!failed && nextIndex < items.length) {
            const currentIndex = nextIndex++;
            try {
                await worker(items[currentIndex]);
            }
            catch (error) {
                if (!failed)
                    firstError = error;
                failed = true;
            }
        }
    }
    await Promise.all(items.slice(0, maxConcurrency).map(() => runNext()));
    if (failed)
        throw firstError;
}
async function sha256Hex(content) {
    if (!globalThis.crypto?.subtle) {
        throw new Error("Remote indexWorkspace requires Web Crypto to verify source hashes.");
    }
    const digest = await globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(content));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function toArrayBuffer(bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
function toUint8Array(content) {
    return typeof content === "string" ? new TextEncoder().encode(content) : content;
}
function concatUint8Arrays(chunks) {
    const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}
function removeUndefinedValues(record) {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
function requireIdentifier(value, fieldName) {
    const normalized = value.trim();
    if (!normalized) {
        throw new Error(`${fieldName} must not be empty.`);
    }
    return normalized;
}
function validateNonNegativeNumber(value, fieldName) {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${fieldName} must be a finite non-negative number.`);
    }
    return value;
}
function requireReviewContextV2Envelope(value, label, requireContractVersion = false) {
    if (!isRecord(value) || value.schema_version !== "review-context/v2") {
        throw new Error(`Unsupported ${label} schema_version: ${String(isRecord(value) ? value.schema_version || "missing" : "missing")}.`);
    }
    if (requireContractVersion
        && (!("contract_version" in value) || value.contract_version !== "review-context/v2")) {
        const contractVersion = "contract_version" in value
            ? value.contract_version
            : "missing";
        throw new Error(`Unsupported ${label} contract_version: ${String(contractVersion)}.`);
    }
    return value;
}
function requireReviewContextV2Result(value, label) {
    requireReviewContextV2Envelope(value, label);
    if ("state" in value) {
        requireReviewContextV2Envelope(value, label, true);
        requireReviewContextJobV2(value, label);
    }
    else {
        requireReviewContextResponseV2(value, label);
    }
    return value;
}
function requireReviewContextJobV2(value, label) {
    if (isRecord(value) && !REVIEW_JOB_STATES_V2.has(value.state)) {
        throw new Error(`Unsupported ${label} state: ${String(value.state ?? "missing")}.`);
    }
    if (!isReviewContextJobEnvelopeV2(value)) {
        throw new Error(`Malformed ${label} v2 job envelope.`);
    }
    if (!Array.isArray(value.partial_reasons) || !value.partial_reasons.every(isReviewPartialReasonV2)) {
        throw new Error(`Malformed ${label} partial_reasons.`);
    }
}
function requireReviewStatusV2(value, label) {
    if (!isReviewStatusEnvelopeV2(value)) {
        throw new Error(`Malformed ${label} v2 status envelope.`);
    }
}
function requireReviewContextResponseV2(value, label) {
    if (!isRecord(value)) {
        throw new Error(`Malformed ${label} v2 response envelope.`);
    }
    if (!isReviewResponseEnvelopeV2(value)) {
        throw new Error(`Malformed ${label} v2 response contract.`);
    }
}
/** Fail closed on every current-v2 response/job field and semantic correlation. */
export function assertReviewContextV2Result(value) {
    requireReviewContextV2Envelope(value, "review result");
    if (isRecord(value) && "state" in value) {
        requireReviewContextV2Envelope(value, "review job", true);
        requireReviewContextJobV2(value, "review job");
        return;
    }
    requireReviewContextResponseV2(value, "review response");
}
function isReviewBundleV2(value) {
    if (!hasV2Shape(value, [
        "ordinal", "change_record", "base_evidence", "head_evidence", "related_evidence",
        "completeness", "evidence_item_count", "serialized_tokens",
        "serialized_characters", "serialized_utf8_bytes",
    ]))
        return false;
    const record = value.change_record;
    if (!isReviewSymbolChangeRecordV2(record))
        return false;
    for (const [side, instance, evidence] of [
        ["base", record.base, value.base_evidence],
        ["head", record.head, value.head_evidence],
    ]) {
        const present = instance !== null && instance !== undefined;
        if (present !== (evidence !== null && evidence !== undefined))
            return false;
        if (!present)
            continue;
        if (!isSymbolExtentV2(evidence, side)
            || !isRecord(instance)
            || !extentMatchesInstance(evidence, instance, record.change_id, side))
            return false;
    }
    const evidenceCount = Number(value.base_evidence !== null)
        + Number(value.head_evidence !== null)
        + (Array.isArray(value.related_evidence) ? value.related_evidence.length : 0);
    return isNonNegativeInteger(value.ordinal)
        && isBundleCompletenessV2(value.completeness)
        && value.completeness.required_sides_complete === true
        && Array.isArray(value.related_evidence)
        && value.related_evidence.every(isEvidenceItemV2)
        && value.evidence_item_count === evidenceCount
        && [value.serialized_tokens, value.serialized_characters, value.serialized_utf8_bytes]
            .every(isPositiveInteger);
}
function isReviewSymbolChangeRecordV2(value) {
    if (!hasV2Shape(value, [
        "change_id", "logical_identity", "base", "head", "change_kind", "pairing_status",
        "continuity_status", "pairing_confidence", "pairing_group", "diff_evidence",
        "normalized_hunks", "relationship_deltas", "base_observation", "head_observation",
        "completeness",
    ]))
        return false;
    if (!SYMBOL_CHANGE_KINDS_V2.has(value.change_kind)) {
        throw new Error(`Unsupported v2 symbol change_kind: ${String(value.change_kind ?? "missing")}.`);
    }
    if (!PAIRING_STATUSES_V2.has(value.pairing_status)) {
        throw new Error(`Unsupported v2 symbol pairing_status: ${String(value.pairing_status ?? "missing")}.`);
    }
    if (!CONTINUITY_STATUSES_V2.has(value.continuity_status)) {
        throw new Error(`Unsupported v2 symbol continuity_status: ${String(value.continuity_status ?? "missing")}.`);
    }
    const base = value.base;
    const head = value.head;
    const basePresent = base !== null;
    const headPresent = head !== null;
    const sideCount = Number(basePresent) + Number(headPresent);
    const exact = String(value.pairing_status).startsWith("exact_");
    if ((base !== null && !isSymbolInstanceV2(base)) || (head !== null && !isSymbolInstanceV2(head)))
        return false;
    if (exact && (!basePresent || !headPresent || value.pairing_confidence !== 1 || value.continuity_status !== "proven"))
        return false;
    if (exact && ["added", "removed", "ambiguous", "unsupported_split_merge"].includes(String(value.change_kind)))
        return false;
    if (!exact && value.pairing_confidence !== null)
        return false;
    if (value.pairing_status === "one_sided" && (sideCount !== 1 || !["added", "removed"].includes(String(value.change_kind)) || value.continuity_status !== "not_established"))
        return false;
    if (value.pairing_status === "unresolved" && (sideCount !== 1 || value.change_kind !== "unresolved" || value.continuity_status !== "unavailable"))
        return false;
    if (value.pairing_status === "ambiguous" && (sideCount !== 1 || value.change_kind !== "ambiguous" || value.continuity_status !== "ambiguous"))
        return false;
    if (value.pairing_status === "unsupported" && (sideCount !== 1 || value.change_kind !== "unsupported_split_merge" || value.continuity_status !== "unavailable"))
        return false;
    if ((["ambiguous", "unsupported"].includes(String(value.pairing_status))) !== (value.pairing_group !== null))
        return false;
    if (value.pairing_group !== null && !isPairingGroupV2(value.pairing_group))
        return false;
    if (!isNormalizedDiffEvidenceV2(value.diff_evidence)
        || !isPathObservationV2(value.base_observation)
        || !isPathObservationV2(value.head_observation)
        || !isChangeCompletenessV2(value.completeness)
        || !Array.isArray(value.normalized_hunks)
        || !value.normalized_hunks.every(isNormalizedHunkV2)
        || !Array.isArray(value.relationship_deltas)
        || !value.relationship_deltas.every(isReviewRelationshipDeltaV2))
        return false;
    const diffEvidence = value.diff_evidence;
    const oldPath = diffEvidence.previous_path ?? diffEvidence.path;
    if (value.base_observation.path !== oldPath || value.head_observation.path !== diffEvidence.path)
        return false;
    if (isRecord(base) && (base.path !== value.base_observation.path || base.layer !== "snapshot"))
        return false;
    if (isRecord(head) && (head.path !== value.head_observation.path || head.layer !== "overlay"))
        return false;
    if (isRecord(base) && value.base_observation.source_state === "present"
        && base.source_content_sha256 !== null
        && base.source_content_sha256 !== value.base_observation.source_content_sha256)
        return false;
    if (isRecord(head) && value.head_observation.source_state === "present"
        && head.source_content_sha256 !== null
        && head.source_content_sha256 !== value.head_observation.source_content_sha256)
        return false;
    if (isRecord(base) && isRecord(head)
        && (base.revision === head.revision || base.repository_id !== head.repository_id))
        return false;
    const roles = {
        added: ["added_base_absent", "added_head"], deleted: ["deleted_base", "deleted_head_absent"],
        modified: ["modified_base", "modified_head"], renamed: ["renamed_base", "renamed_head"],
    }[String(diffEvidence.change_kind)];
    if (!roles || value.base_observation.path_role !== roles[0] || value.head_observation.path_role !== roles[1])
        return false;
    if (value.change_kind === "added" && (basePresent || !headPresent))
        return false;
    if (value.change_kind === "removed" && (!basePresent || headPresent))
        return false;
    if (value.change_kind === "added" && diffEvidence.change_kind === "added"
        && value.base_observation.source_state !== "absent_by_diff")
        return false;
    if (value.change_kind === "removed" && diffEvidence.change_kind === "deleted"
        && value.head_observation.source_state !== "absent_by_diff")
        return false;
    if (["unresolved", "ambiguous", "unsupported_split_merge"].includes(String(value.change_kind))
        && value.completeness.symbol_pair_complete)
        return false;
    if (value.pairing_status === "one_sided"
        && (!isAuthoritativeReviewObservation(value.base_observation)
            || !isAuthoritativeReviewObservation(value.head_observation)
            || !value.completeness.symbol_pair_complete))
        return false;
    const hunkOrdinals = value.normalized_hunks.map((hunk) => hunk.ordinal);
    if (!isSortedUniqueNumbers(hunkOrdinals))
        return false;
    if (value.normalized_hunks.some((hunk) => hunk.path !== diffEvidence.path))
        return false;
    if (["missing", "not_applicable"].includes(String(diffEvidence.patch_status)) && value.normalized_hunks.length > 0)
        return false;
    if (diffEvidence.patch_status !== "complete" && value.completeness.normalized_hunks_complete)
        return false;
    if (diffEvidence.patch_status === "complete" && value.normalized_hunks.some((hunk) => (hunk.lines.filter((line) => line.old_line !== null).length !== hunk.old_count
        || hunk.lines.filter((line) => line.new_line !== null).length !== hunk.new_count)))
        return false;
    if (value.relationship_deltas.some((delta) => delta.changed_logical_identity !== value.logical_identity))
        return false;
    for (const delta of value.relationship_deltas) {
        for (const [fact, instance, expectedLayer] of [
            [delta.base_fact, base, "snapshot"], [delta.head_fact, head, "overlay"],
        ]) {
            if (fact === null)
                continue;
            if (!isRecord(instance)
                || !relationshipFactIsIncidentToInstance(delta, fact, instance, expectedLayer))
                return false;
        }
    }
    return isNonEmptyId(value.change_id) && isNonEmptyId(value.logical_identity);
}
function isReviewRelationshipDeltaV2(value) {
    if (!hasV2Shape(value, [
        "status", "relationship_kind", "direction", "changed_logical_identity",
        "endpoint_logical_identity", "base_fact", "head_fact",
        "comparison_attributes_changed", "completeness",
    ]))
        return false;
    if (!RELATIONSHIP_DELTA_STATUSES_V2.has(value.status)) {
        throw new Error(`Unsupported v2 relationship delta status: ${String(value.status ?? "missing")}.`);
    }
    if (!["incoming", "outgoing"].includes(value.direction)) {
        throw new Error(`Unsupported v2 relationship direction: ${String(value.direction ?? "missing")}.`);
    }
    const factsValid = [value.base_fact, value.head_fact].every((fact) => {
        if (fact === null || fact === undefined)
            return true;
        if (!isRecord(fact))
            return false;
        if (!(fact.fact_type === "resolved" || fact.fact_type === "unresolved")) {
            throw new Error(`Unsupported v2 relationship fact_type: ${String(fact.fact_type ?? "missing")}.`);
        }
        return isRelationshipFactV2(fact)
            && fact.direction === value.direction
            && fact.relationship_kind === value.relationship_kind
            && fact.changed_logical_identity === value.changed_logical_identity;
    });
    const completeness = value.completeness;
    const basePresent = value.base_fact !== null;
    const headPresent = value.head_fact !== null;
    if (!basePresent && !headPresent)
        return false;
    if (value.status === "added" && (basePresent || !headPresent))
        return false;
    if (value.status === "removed" && (!basePresent || headPresent))
        return false;
    if (["preserved", "evidence_changed"].includes(String(value.status)) && (!basePresent || !headPresent))
        return false;
    if ((value.status === "evidence_changed") !== (Array.isArray(value.comparison_attributes_changed) && value.comparison_attributes_changed.length > 0))
        return false;
    if (!isSortedUniqueStrings(value.comparison_attributes_changed))
        return false;
    const definitive = ["added", "removed", "preserved", "evidence_changed"].includes(String(value.status));
    if (definitive && (!isRecord(completeness)
        || completeness.base_declaring_unit_observed !== true
        || completeness.head_declaring_unit_observed !== true
        || (value.direction === "incoming" && completeness.incoming_dependents_reanalyzed !== true)))
        return false;
    for (const fact of [value.base_fact, value.head_fact]) {
        if (!isRecord(fact))
            continue;
        if (fact.fact_type === "resolved" && fact.endpoint_logical_identity !== value.endpoint_logical_identity)
            return false;
        if (fact.fact_type === "unresolved" && value.endpoint_logical_identity !== null)
            return false;
    }
    const missingContractSemantics = [value.base_fact, value.head_fact].some((fact) => (isRecord(fact) && fact.fact_type === "resolved" && fact.contract_evidence_id !== null
        && fact.contract_coordinate === null));
    if (missingContractSemantics && (value.status !== "unresolved"
        || !isRecord(completeness)
        || !Array.isArray(completeness.reason_codes)
        || !completeness.reason_codes.includes("contract_semantic_evidence_unavailable")))
        return false;
    return factsValid
        && isNonEmptyId(value.relationship_kind)
        && isNonEmptyId(value.changed_logical_identity)
        && (value.endpoint_logical_identity === null || isNonEmptyId(value.endpoint_logical_identity))
        && Array.isArray(value.comparison_attributes_changed)
        && value.comparison_attributes_changed.every(isNonEmptyId)
        && hasV2Shape(completeness, [
            "base_declaring_unit_observed", "head_declaring_unit_observed",
            "incoming_dependents_reanalyzed", "reason_codes",
        ])
        && [completeness.base_declaring_unit_observed, completeness.head_declaring_unit_observed,
            completeness.incoming_dependents_reanalyzed].every((item) => typeof item === "boolean")
        && isIdArray(completeness.reason_codes);
}
function isReviewOmissionV2(value) {
    if (!hasV2Shape(value, [
        "change_id", "ordinal", "change_kind", "pairing_status", "reason", "omitted_sides",
        "minimum_required_budget", "model_evidence_available",
    ]))
        return false;
    if (!SYMBOL_CHANGE_KINDS_V2.has(value.change_kind)) {
        throw new Error(`Unsupported v2 omission change_kind: ${String(value.change_kind ?? "missing")}.`);
    }
    if (!PAIRING_STATUSES_V2.has(value.pairing_status)) {
        throw new Error(`Unsupported v2 omission pairing_status: ${String(value.pairing_status ?? "missing")}.`);
    }
    if (!BUNDLE_OMISSION_REASONS_V2.has(value.reason)) {
        throw new Error(`Unsupported v2 omission reason: ${String(value.reason ?? "missing")}.`);
    }
    const budgetCaused = value.reason === "required_pair_budget_exceeded";
    const budget = value.minimum_required_budget;
    return isNonEmptyId(value.change_id)
        && Number.isInteger(value.ordinal)
        && value.model_evidence_available === false
        && Array.isArray(value.omitted_sides)
        && value.omitted_sides.every((side) => side === "base" || side === "head" || side === "related")
        && new Set(value.omitted_sides).size === value.omitted_sides.length
        && (budgetCaused ? isMinimumReviewBudgetV2(budget) : budget === null);
}
function isMinimumReviewBudgetV2(value) {
    return hasV2Shape(value, ["evidence_items", "tokens", "characters", "utf8_bytes"])
        && [value.evidence_items, value.tokens, value.characters, value.utf8_bytes]
            .every((item) => Number.isInteger(item) && Number(item) > 0);
}
function isReviewPartialReasonV2(value) {
    return hasV2Shape(value, ["code", "retryable", "affected_side"])
        && isNonEmptyId(value.code)
        && typeof value.retryable === "boolean"
        && ["base", "head", "both", "graph", "response"].includes(String(value.affected_side));
}
function isReviewResponseEnvelopeV2(value) {
    if (!hasV2Shape(value, [
        "request_id", "telemetry_id", "job_id", "review_id", "target_repository_id",
        "review_scope", "base_sha", "head_sha", "base_snapshot_id",
        "base_snapshot_generation", "base_snapshot_refresh_sequence",
        "base_artifact_contract_version", "base_snapshot_builder_version",
        "base_build_policy_digest", "overlay_id", "overlay_generation",
        "overlay_refresh_sequence", "artifact_contract_version", "evidence_builder_version",
        "overlay_build_policy_digest", "normalized_diff_hash", "freshness", "bundles",
        "omitted_bundles", "serialized_token_count", "serialized_character_count",
        "serialized_utf8_byte_count", "partial", "partial_reasons", "retry_guidance",
    ]))
        return false;
    const scope = value.review_scope;
    if (!isReviewScopeV2(scope)
        || ![value.request_id, value.telemetry_id, value.review_id, value.target_repository_id,
            value.base_snapshot_id, value.base_snapshot_builder_version, value.overlay_id,
            value.evidence_builder_version].every(isNonEmptyId)
        || (value.job_id !== null && !isNonEmptyId(value.job_id))
        || !isCommitSha(value.base_sha) || !isCommitSha(value.head_sha)
        || ![value.base_build_policy_digest, value.overlay_build_policy_digest,
            value.normalized_diff_hash].every(isSha256)
        || value.base_artifact_contract_version !== "snapshot-artifacts/v2"
        || value.artifact_contract_version !== "review-artifacts/v2"
        || !isPositiveInteger(value.base_snapshot_generation)
        || !isNonNegativeInteger(value.base_snapshot_refresh_sequence)
        || !isPositiveInteger(value.overlay_generation)
        || !isNonNegativeInteger(value.overlay_refresh_sequence)
        || ![value.serialized_token_count, value.serialized_character_count,
            value.serialized_utf8_byte_count].every(isNonNegativeInteger)
        || !(value.freshness === "exact" || value.freshness === "partial")
        || typeof value.partial !== "boolean"
        || (value.retry_guidance !== null && typeof value.retry_guidance !== "string")
        || !Array.isArray(value.partial_reasons) || !value.partial_reasons.every(isReviewPartialReasonV2)
        || !Array.isArray(value.bundles) || !value.bundles.every(isReviewBundleV2)
        || !Array.isArray(value.omitted_bundles) || !value.omitted_bundles.every(isReviewOmissionV2))
        return false;
    if (value.target_repository_id !== scope.target_repository_id)
        return false;
    const publication = [value.base_snapshot_id, value.base_snapshot_generation,
        value.base_snapshot_refresh_sequence, value.overlay_id, value.overlay_generation,
        value.overlay_refresh_sequence];
    const scoped = [scope.base_snapshot_id, scope.base_snapshot_generation,
        scope.base_snapshot_refresh_sequence, scope.overlay_id, scope.overlay_generation,
        scope.overlay_refresh_sequence];
    if (publication.some((item, index) => item !== scoped[index]))
        return false;
    const admittedOrdinals = value.bundles
        .map((item) => item.ordinal);
    const omittedOrdinals = value.omitted_bundles
        .map((item) => item.ordinal);
    const ordinals = [...admittedOrdinals, ...omittedOrdinals];
    if (!isSortedNumbers(admittedOrdinals) || !isSortedNumbers(omittedOrdinals)
        || new Set(ordinals).size !== ordinals.length
        || [...ordinals].sort((left, right) => left - right)
            .some((ordinal, index) => ordinal !== index))
        return false;
    const changeIds = [...value.bundles.map((bundle) => bundle.change_record)
            .map((record) => record.change_id),
        ...value.omitted_bundles.map((item) => item.change_id)];
    if (new Set(changeIds).size !== changeIds.length)
        return false;
    if ((value.freshness === "partial") !== value.partial
        || value.partial !== (value.partial_reasons.length > 0 || value.omitted_bundles.length > 0))
        return false;
    return value.bundles.every((bundle) => {
        const record = bundle.change_record;
        if (record.diff_evidence.normalized_diff_hash !== value.normalized_diff_hash)
            return false;
        for (const [instance, revision, layer] of [[record.base, value.base_sha, "snapshot"], [record.head, value.head_sha, "overlay"]]) {
            if (instance === null)
                continue;
            if (!isRecord(instance) || instance.repository_id !== value.target_repository_id
                || instance.revision !== revision || instance.layer !== layer)
                return false;
        }
        const authorized = scope.authorized_repository_ids;
        if (!bundle.related_evidence
            || !bundle.related_evidence
                .every((evidence) => isRecord(evidence) && authorized.includes(String(evidence.repository_id))))
            return false;
        for (const delta of record.relationship_deltas) {
            for (const [fact, expectedGeneration] of [
                [delta.base_fact, value.base_snapshot_generation],
                [delta.head_fact, value.overlay_generation],
            ]) {
                if (!isRecord(fact))
                    continue;
                if (!relationshipFactMatchesPublication(fact, String(value.base_snapshot_id), Number(expectedGeneration)))
                    return false;
                if (fact.fact_type === "resolved"
                    && (!authorized.includes(String(fact.source_repository_id))
                        || !authorized.includes(String(fact.target_repository_id))))
                    return false;
            }
        }
        return true;
    });
}
function isReviewContextJobEnvelopeV2(value) {
    if (!hasV2Shape(value, [
        "contract_version", "job_id", "request_id", "tenant_id", "codebase_id",
        "repository_set_id", "repository_selection_digest", "state", "attempts", "status_url",
        "retry_after_seconds", "created_at", "updated_at", "overlay_id", "overlay_generation",
        "overlay_refresh_sequence", "partial_reasons",
    ]) || value.contract_version !== "review-context/v2")
        return false;
    if (![value.job_id, value.request_id, value.tenant_id, value.codebase_id,
        value.repository_set_id].every(isNonEmptyId)
        || !isBoundedString(value.status_url, 4096)
        || !isSha256(value.repository_selection_digest)
        || !REVIEW_JOB_STATES_V2.has(value.state)
        || !isNonNegativeInteger(value.attempts)
        || !isIsoDate(value.created_at) || !isIsoDate(value.updated_at)
        || !Array.isArray(value.partial_reasons) || !value.partial_reasons.every(isReviewPartialReasonV2))
        return false;
    const pinned = [value.overlay_id, value.overlay_generation, value.overlay_refresh_sequence];
    if (pinned.some((item) => item === null) !== pinned.every((item) => item === null))
        return false;
    const completed = value.state === "succeeded" || value.state === "partial";
    if (completed !== pinned.every((item) => item !== null))
        return false;
    const pending = value.state === "queued" || value.state === "running";
    if (pending !== (value.retry_after_seconds !== null))
        return false;
    if (value.retry_after_seconds !== null
        && (!isNonNegativeInteger(value.retry_after_seconds) || Number(value.retry_after_seconds) > 3600))
        return false;
    if (Date.parse(String(value.updated_at)) < Date.parse(String(value.created_at)))
        return false;
    const reasonKeys = value.partial_reasons.map((reason) => (`${reason.code}\0${reason.affected_side}\0${String(reason.retryable)}`));
    if (!isSortedUniqueStrings(reasonKeys))
        return false;
    if (value.state === "succeeded" && value.partial_reasons.length > 0)
        return false;
    if (value.state === "partial" && value.partial_reasons.length === 0)
        return false;
    return true;
}
function isReviewStatusEnvelopeV2(value) {
    if (!hasV2Shape(value, ["contract_version", "codebase_id", "review_id", "target_repository_id", "head_sha", "publications", "latest_jobs"])
        || value.contract_version !== "review-context/v2"
        || ![value.codebase_id, value.review_id, value.target_repository_id].every(isNonEmptyId)
        || !isCommitSha(value.head_sha)
        || !Array.isArray(value.publications) || !value.publications.every(isReviewPublicationV2)
        || !Array.isArray(value.latest_jobs) || !value.latest_jobs.every(isReviewContextJobEnvelopeV2))
        return false;
    const publicationKeys = value.publications.map((item) => `${item.repository_set_id}\0${item.repository_selection_digest}`);
    const jobKeys = value.latest_jobs.map((item) => `${item.repository_set_id}\0${item.repository_selection_digest}\0${item.job_id}`);
    return value.latest_jobs.every((job) => job.codebase_id === value.codebase_id)
        && isSortedUniqueStrings(publicationKeys) && isSortedUniqueStrings(jobKeys);
}
function isReviewPublicationV2(value) {
    if (!hasV2Shape(value, ["repository_set_id", "repository_selection_digest", "target_repository_id", "base_sha", "head_sha", "base_snapshot_id", "base_snapshot_generation", "base_snapshot_refresh_sequence", "overlay_id", "overlay_generation", "overlay_refresh_sequence", "state", "freshness", "evidence_state", "warning_count", "published_at"]))
        return false;
    return [value.repository_set_id, value.target_repository_id, value.base_snapshot_id, value.overlay_id].every(isNonEmptyId)
        && isSha256(value.repository_selection_digest) && isCommitSha(value.base_sha) && isCommitSha(value.head_sha)
        && isPositiveInteger(value.base_snapshot_generation) && isNonNegativeInteger(value.base_snapshot_refresh_sequence)
        && isPositiveInteger(value.overlay_generation) && isNonNegativeInteger(value.overlay_refresh_sequence)
        && ["ready", "partial", "failed", "stale", "closed", "expired", "purged"].includes(String(value.state))
        && (value.freshness === null || ["exact", "partial", "stale"].includes(String(value.freshness)))
        && ["ready", "partial", "failed"].includes(String(value.evidence_state))
        && isNonNegativeInteger(value.warning_count) && isIsoDate(value.published_at)
        && !(value.state === "ready" && (value.freshness !== "exact" || value.evidence_state !== "ready"))
        && !(value.state === "partial" && value.evidence_state !== "partial")
        && !(value.state === "failed" && value.evidence_state !== "failed")
        && !(value.state === "stale" && value.freshness !== "stale");
}
function isReviewCapabilitiesV2(value) {
    if (!hasV2Shape(value, ["contract_version", "enabled", "service_available", "construction_enabled", "publication_enabled", "read_enabled", "routes_enabled", "supports_polling", "supports_cancellation", "supports_repository_set_scoped_status", "snapshot_artifact_contract_version", "snapshot_builder_version", "artifact_contract_version", "evidence_builder_version", "build_policy_digest", "limits"]))
        return false;
    const limits = value.limits;
    return value.contract_version === "review-context/v2"
        && [value.enabled, value.service_available, value.construction_enabled, value.publication_enabled,
            value.read_enabled, value.routes_enabled, value.supports_polling, value.supports_cancellation,
            value.supports_repository_set_scoped_status].every((item) => typeof item === "boolean")
        && value.snapshot_artifact_contract_version === "snapshot-artifacts/v2"
        && isNonEmptyId(value.snapshot_builder_version)
        && value.artifact_contract_version === "review-artifacts/v2"
        && isNonEmptyId(value.evidence_builder_version) && isSha256(value.build_policy_digest)
        && hasV2Shape(limits, ["max_records", "max_symbol_extent_utf8_bytes_per_side", "max_symbol_extent_utf8_bytes_per_overlay", "max_serialized_bundle_bytes", "max_serialized_response_bytes", "construction_timeout_ms", "base_rebuild_timeout_ms", "max_refresh_sequences_per_lineage"])
        && [limits.max_records, limits.max_symbol_extent_utf8_bytes_per_side,
            limits.max_symbol_extent_utf8_bytes_per_overlay, limits.max_serialized_bundle_bytes,
            limits.max_serialized_response_bytes, limits.construction_timeout_ms,
            limits.base_rebuild_timeout_ms, limits.max_refresh_sequences_per_lineage].every(isPositiveInteger)
        && Number(limits.max_refresh_sequences_per_lineage) <= 10
        && !(value.publication_enabled && !value.construction_enabled)
        && !(value.service_available && (!value.read_enabled || !value.routes_enabled));
}
function isReviewScopeV2(value) {
    if (!hasV2Shape(value, ["tenant_id", "actor_id", "codebase_id", "target_repository_id", "authorized_repository_ids", "repository_set_id", "repository_selection_digest", "base_snapshot_id", "base_snapshot_generation", "base_snapshot_refresh_sequence", "overlay_id", "overlay_generation", "overlay_refresh_sequence"]))
        return false;
    return [value.tenant_id, value.actor_id, value.codebase_id, value.target_repository_id,
        value.repository_set_id, value.base_snapshot_id, value.overlay_id].every(isNonEmptyId)
        && isIdArray(value.authorized_repository_ids)
        && isSortedUniqueStrings(value.authorized_repository_ids)
        && isNonEmptyId(value.target_repository_id)
        && value.authorized_repository_ids.includes(value.target_repository_id)
        && isSha256(value.repository_selection_digest)
        && isPositiveInteger(value.base_snapshot_generation) && isNonNegativeInteger(value.base_snapshot_refresh_sequence)
        && isPositiveInteger(value.overlay_generation) && isNonNegativeInteger(value.overlay_refresh_sequence);
}
function isSymbolInstanceV2(value) {
    if (!hasV2Shape(value, ["symbol_id", "symbol_instance_id", "repository_id", "revision", "layer", "path", "source_range", "language", "project_root", "qualified_name", "display_name", "kind", "signature", "source_content_sha256", "symbol_extent_sha256", "stable_declaration_identity", "provenance"]))
        return false;
    const stableIdentityValid = value.stable_declaration_identity === null
        || (isStableDeclarationV2(value.stable_declaration_identity)
            && isRecord(value.provenance)
            && value.stable_declaration_identity.extractor_id === value.provenance.extractor_id);
    return [value.symbol_id, value.symbol_instance_id, value.repository_id].every(isNonEmptyId)
        && isBoundedString(value.language, 64)
        && isBoundedString(value.qualified_name, 2048)
        && isBoundedString(value.display_name, 512)
        && isBoundedString(value.kind, 128)
        && isCommitSha(value.revision) && (value.layer === "snapshot" || value.layer === "overlay")
        && isCanonicalPath(value.path) && isCanonicalPath(value.project_root, true)
        && isSourceRangeV2(value.source_range) && (value.signature === null || typeof value.signature === "string")
        && (value.source_content_sha256 === null || isSha256(value.source_content_sha256))
        && (value.symbol_extent_sha256 === null || isSha256(value.symbol_extent_sha256))
        && stableIdentityValid
        && isProvenanceV2(value.provenance);
}
function isNormalizedDiffEvidenceV2(value) {
    if (!hasV2Shape(value, ["normalized_diff_hash", "path", "previous_path", "change_kind", "content_kind", "patch_status", "additions", "deletions"]))
        return false;
    return isSha256(value.normalized_diff_hash) && isCanonicalPath(value.path)
        && (value.previous_path === null || isCanonicalPath(value.previous_path))
        && ["added", "modified", "renamed", "deleted"].includes(String(value.change_kind))
        && ["text", "binary", "lfs"].includes(String(value.content_kind))
        && ["complete", "truncated", "missing", "not_applicable"].includes(String(value.patch_status))
        && isNonNegativeInteger(value.additions) && isNonNegativeInteger(value.deletions)
        && ((value.change_kind === "renamed") === (value.previous_path !== null))
        && !(value.content_kind === "text" && value.patch_status === "not_applicable")
        && !(value.content_kind !== "text" && value.patch_status !== "not_applicable");
}
function isPathObservationV2(value) {
    if (!hasV2Shape(value, ["path", "path_role", "source_state", "analyzer_state", "analyzed_scope_complete", "source_content_sha256", "reason_codes"]))
        return false;
    return isCanonicalPath(value.path)
        && ["added_base_absent", "added_head", "deleted_base", "deleted_head_absent", "modified_base", "modified_head", "renamed_base", "renamed_head", "unchanged_reanalyzed"].includes(String(value.path_role))
        && ["present", "absent_by_diff", "non_text", "unavailable"].includes(String(value.source_state))
        && (value.analyzer_state === null || ["complete", "degraded", "skipped", "truncated", "failed", "not_applicable", "unavailable"].includes(String(value.analyzer_state)))
        && typeof value.analyzed_scope_complete === "boolean"
        && (value.source_content_sha256 === null || isSha256(value.source_content_sha256))
        && isIdArray(value.reason_codes)
        && isPathObservationTruthful(value);
}
function isPathObservationTruthful(value) {
    const absentRole = value.path_role === "added_base_absent" || value.path_role === "deleted_head_absent";
    if (value.source_state === "absent_by_diff") {
        return absentRole && value.analyzer_state === null && value.analyzed_scope_complete === false
            && value.source_content_sha256 === null;
    }
    if (absentRole)
        return false;
    if (value.source_state === "present") {
        return isSha256(value.source_content_sha256) && value.analyzer_state !== null
            && (!value.analyzed_scope_complete || value.analyzer_state === "complete");
    }
    if (value.source_content_sha256 !== null || value.analyzed_scope_complete)
        return false;
    if (value.source_state === "non_text")
        return value.analyzer_state === "not_applicable";
    return value.source_state === "unavailable"
        && (value.analyzer_state === "failed" || value.analyzer_state === "unavailable");
}
function isChangeCompletenessV2(value) {
    if (!hasV2Shape(value, ["symbol_pair_complete", "normalized_hunks_complete", "relationship_deltas_complete", "complete", "reason_codes"]))
        return false;
    const expected = Boolean(value.symbol_pair_complete) && Boolean(value.normalized_hunks_complete) && Boolean(value.relationship_deltas_complete);
    return [value.symbol_pair_complete, value.normalized_hunks_complete, value.relationship_deltas_complete, value.complete].every((item) => typeof item === "boolean")
        && value.complete === expected && isIdArray(value.reason_codes);
}
function isPairingGroupV2(value) {
    if (!hasV2Shape(value, ["group_id", "tier", "base_candidate_instance_ids", "head_candidate_instance_ids", "base_candidate_count", "head_candidate_count", "candidates_truncated"]))
        return false;
    return isNonEmptyId(value.group_id)
        && ["symbol_id", "stable_declaration_identity", "unique_declaration_key", "authoritative_split_merge"].includes(String(value.tier))
        && isIdArray(value.base_candidate_instance_ids) && isIdArray(value.head_candidate_instance_ids)
        && isNonNegativeInteger(value.base_candidate_count) && isNonNegativeInteger(value.head_candidate_count)
        && typeof value.candidates_truncated === "boolean"
        && isSortedUniqueStrings(value.base_candidate_instance_ids)
        && isSortedUniqueStrings(value.head_candidate_instance_ids)
        && Number(value.base_candidate_count) >= value.base_candidate_instance_ids.length
        && Number(value.head_candidate_count) >= value.head_candidate_instance_ids.length
        && value.candidates_truncated === (Number(value.base_candidate_count) > value.base_candidate_instance_ids.length
            || Number(value.head_candidate_count) > value.head_candidate_instance_ids.length);
}
function isNormalizedHunkV2(value) {
    if (!hasV2Shape(value, ["path", "ordinal", "old_start", "old_count", "new_start", "new_count", "section", "lines", "hunk_sha256"]))
        return false;
    return isCanonicalPath(value.path) && [value.ordinal, value.old_start, value.old_count, value.new_start, value.new_count].every(isNonNegativeInteger)
        && (value.section === null || typeof value.section === "string") && isSha256(value.hunk_sha256)
        && Array.isArray(value.lines) && value.lines.every(isNormalizedDiffLineV2)
        && value.lines.filter((line) => line.old_line !== null).length <= Number(value.old_count)
        && value.lines.filter((line) => line.new_line !== null).length <= Number(value.new_count)
        && sha256Utf8(canonicalJson({ path: value.path, ordinal: value.ordinal,
            old_start: value.old_start, old_count: value.old_count, new_start: value.new_start,
            new_count: value.new_count, section: value.section, lines: value.lines.map((line) => ({
                kind: line.kind, text: line.text, old_line: line.old_line, new_line: line.new_line,
                no_newline_at_end: line.no_newline_at_end,
            })) })) === value.hunk_sha256;
}
function isNormalizedDiffLineV2(value) {
    if (!hasV2Shape(value, ["kind", "text", "old_line", "new_line", "no_newline_at_end"]))
        return false;
    return ["context", "addition", "deletion"].includes(String(value.kind))
        && typeof value.text === "string" && !/[\r\n\0]/u.test(value.text)
        && (value.old_line === null || isPositiveInteger(value.old_line))
        && (value.new_line === null || isPositiveInteger(value.new_line))
        && typeof value.no_newline_at_end === "boolean"
        && (value.kind !== "context" || (value.old_line !== null && value.new_line !== null))
        && (value.kind !== "addition" || (value.old_line === null && value.new_line !== null))
        && (value.kind !== "deletion" || (value.old_line !== null && value.new_line === null));
}
function isRelationshipFactV2(value) {
    if (value.fact_type === "resolved") {
        if (!hasV2Shape(value, ["fact_type", "edge_id", "direction", "relationship_kind", "changed_logical_identity", "endpoint_logical_identity", "source_repository_id", "source_snapshot_id", "source_generation", "source_symbol_id", "source_symbol_instance_id", "source_language", "target_repository_id", "target_snapshot_id", "target_generation", "target_symbol_id", "target_symbol_instance_id", "target_language", "path", "source_range", "provenance", "resolution_precedence", "contract_evidence_id", "contract_coordinate", "contract_artifact_digest", "revision", "layer"]))
            return false;
        return [value.edge_id, value.relationship_kind, value.changed_logical_identity, value.source_repository_id, value.source_snapshot_id, value.source_symbol_id, value.source_symbol_instance_id, value.source_language, value.target_repository_id, value.target_snapshot_id, value.target_symbol_id, value.target_symbol_instance_id, value.target_language].every(isNonEmptyId)
            && (value.endpoint_logical_identity === null || isNonEmptyId(value.endpoint_logical_identity))
            && ["incoming", "outgoing"].includes(String(value.direction))
            && ["local", "declared_dependency", "exact_coordinate", "extractor"].includes(String(value.resolution_precedence))
            && isPositiveInteger(value.source_generation) && isPositiveInteger(value.target_generation)
            && isCanonicalPath(value.path) && isSourceRangeV2(value.source_range) && isProvenanceV2(value.provenance)
            && (value.contract_evidence_id === null || isNonEmptyId(value.contract_evidence_id))
            && (value.contract_coordinate === null || isBoundedString(value.contract_coordinate, 4096))
            && (value.contract_artifact_digest === null || isSha256(value.contract_artifact_digest))
            && ((value.contract_coordinate === null) === (value.contract_artifact_digest === null))
            && (value.contract_coordinate === null || value.contract_evidence_id !== null)
            && isCommitSha(value.revision) && ["snapshot", "overlay"].includes(String(value.layer));
    }
    if (!hasV2Shape(value, ["fact_type", "reference_id", "direction", "relationship_kind", "changed_logical_identity", "normalized_target", "source_symbol_id", "source_symbol_instance_id", "path", "source_range", "provenance", "resolution_status", "candidate_count", "reason", "revision", "layer", "generation"]))
        return false;
    return [value.reference_id, value.relationship_kind, value.changed_logical_identity,
        value.source_symbol_id, value.source_symbol_instance_id, value.reason].every(isNonEmptyId)
        && isBoundedString(value.normalized_target, 4096)
        && value.direction === "outgoing" && ["ambiguous", "not_found", "rejected"].includes(String(value.resolution_status))
        && isCanonicalPath(value.path) && isSourceRangeV2(value.source_range) && isProvenanceV2(value.provenance)
        && isNonNegativeInteger(value.candidate_count) && isCommitSha(value.revision)
        && ["snapshot", "overlay"].includes(String(value.layer)) && isPositiveInteger(value.generation);
}
function isSymbolExtentV2(value, side) {
    if (!hasV2Shape(value, ["side", "evidence_id", "symbol_instance_id", "repository_id", "revision", "layer", "path", "symbol_source_range", "extent_start_line", "extent_end_line", "source_content_sha256", "symbol_extent_sha256", "text", "token_count"]))
        return false;
    const physicalLineCount = Number(value.extent_end_line) - Number(value.extent_start_line) + 1;
    const lfCount = typeof value.text === "string" ? (value.text.match(/\n/gu) ?? []).length : -1;
    const lineCountMatches = lfCount === physicalLineCount - 1
        || (typeof value.text === "string" && value.text.endsWith("\n") && lfCount === physicalLineCount);
    return value.side === side && isNonEmptyId(value.evidence_id) && isNonEmptyId(value.symbol_instance_id)
        && isNonEmptyId(value.repository_id) && isCommitSha(value.revision)
        && value.layer === (side === "base" ? "snapshot" : "overlay")
        && isCanonicalPath(value.path) && isSourceRangeV2(value.symbol_source_range)
        && isPositiveInteger(value.extent_start_line) && isPositiveInteger(value.extent_end_line)
        && value.extent_start_line === value.symbol_source_range.start_line
        && value.extent_end_line === value.symbol_source_range.end_line
        && isSha256(value.source_content_sha256) && isSha256(value.symbol_extent_sha256)
        && typeof value.text === "string" && sha256Utf8(value.text) === value.symbol_extent_sha256
        && lineCountMatches
        && isNonNegativeInteger(value.token_count);
}
function extentMatchesInstance(extent, instance, changeId, side) {
    if (!isNonEmptyId(changeId))
        return false;
    const correlated = extent.side === side && extent.symbol_instance_id === instance.symbol_instance_id
        && extent.repository_id === instance.repository_id && extent.revision === instance.revision
        && extent.layer === instance.layer && extent.path === instance.path
        && sourceRangesEqual(extent.symbol_source_range, instance.source_range)
        && extent.source_content_sha256 === instance.source_content_sha256
        && extent.symbol_extent_sha256 === instance.symbol_extent_sha256;
    return correlated && extent.evidence_id === canonicalExtentEvidenceId(changeId, side, instance);
}
function canonicalExtentEvidenceId(changeId, side, instance) {
    const range = instance.source_range;
    const values = [changeId, side, instance.symbol_instance_id, instance.repository_id,
        instance.revision, instance.path, String(range.start_line), String(range.end_line),
        instance.source_content_sha256, instance.symbol_extent_sha256];
    return `symbol-extent:${sha256Utf8(JSON.stringify(values))}`;
}
function isEvidenceItemV2(value) {
    if (!hasV2Shape(value, ["evidence_id", "repository_id", "revision", "layer", "path", "source_range", "content_hash", "text", "symbol_id", "graph_distance", "provenance", "freshness", "confidence", "selection_reason", "token_count"]))
        return false;
    return [value.evidence_id, value.repository_id, value.selection_reason].every(isNonEmptyId)
        && isCommitSha(value.revision) && ["snapshot", "overlay"].includes(String(value.layer))
        && isCanonicalPath(value.path) && isSourceRangeV2(value.source_range) && isSha256(value.content_hash)
        && typeof value.text === "string" && value.text.length > 0
        && (value.symbol_id === null || isNonEmptyId(value.symbol_id))
        && (value.graph_distance === null || (isNonNegativeInteger(value.graph_distance) && Number(value.graph_distance) <= 4))
        && isProvenanceV2(value.provenance) && ["exact", "fresh", "stale", "unknown"].includes(String(value.freshness))
        && typeof value.confidence === "number" && value.confidence >= 0 && value.confidence <= 1
        && isPositiveInteger(value.token_count);
}
function isBundleCompletenessV2(value) {
    return hasV2Shape(value, ["required_sides_complete", "related_evidence_complete", "reason_codes"])
        && typeof value.required_sides_complete === "boolean"
        && typeof value.related_evidence_complete === "boolean" && isIdArray(value.reason_codes);
}
function isProvenanceV2(value) {
    if (!hasV2Shape(value, ["extractor_id", "extractor_version", "evidence_tier", "resolution_status", "confidence", "reason_codes", "artifact_digest"]))
        return false;
    return isNonEmptyId(value.extractor_id) && isBoundedString(value.extractor_version, 128)
        && ["scip", "compiler", "native", "syntax", "text", "retrieval"].includes(String(value.evidence_tier))
        && ["exact", "declared", "inferred", "unresolved"].includes(String(value.resolution_status))
        && typeof value.confidence === "number" && value.confidence >= 0 && value.confidence <= 1
        && isIdArray(value.reason_codes) && (value.artifact_digest === null || isSha256(value.artifact_digest));
}
function isStableDeclarationV2(value) {
    return hasV2Shape(value, ["extractor_id", "identity_scheme_version", "value"])
        && isNonEmptyId(value.extractor_id)
        && isBoundedString(value.identity_scheme_version, 128)
        && isBoundedString(value.value, 2048);
}
function isSourceRangeV2(value) {
    if (!hasV2Shape(value, ["start_line", "end_line", "start_column", "end_column"]))
        return false;
    return isPositiveInteger(value.start_line) && isPositiveInteger(value.end_line)
        && Number(value.end_line) >= Number(value.start_line)
        && (value.start_column === null || isPositiveInteger(value.start_column))
        && (value.end_column === null || isPositiveInteger(value.end_column))
        && !(value.start_line === value.end_line
            && value.start_column !== null && value.end_column !== null
            && Number(value.end_column) < Number(value.start_column));
}
function isAuthoritativeReviewObservation(value) {
    return value.source_state === "absent_by_diff" || (value.source_state === "present"
        && value.analyzer_state === "complete"
        && value.analyzed_scope_complete === true
        && isSha256(value.source_content_sha256));
}
function relationshipFactIsIncidentToInstance(delta, fact, instance, expectedLayer) {
    if (fact.layer !== expectedLayer || fact.revision !== instance.revision)
        return false;
    if (fact.fact_type === "unresolved") {
        return fact.direction === "outgoing"
            && fact.source_symbol_id === instance.symbol_id
            && fact.source_symbol_instance_id === instance.symbol_instance_id
            && fact.path === instance.path
            && sourceRangeContains(instance.source_range, fact.source_range);
    }
    const incident = delta.direction === "outgoing"
        ? [fact.source_repository_id, fact.source_symbol_id,
            fact.source_symbol_instance_id, fact.source_language]
        : [fact.target_repository_id, fact.target_symbol_id,
            fact.target_symbol_instance_id, fact.target_language];
    const expected = [instance.repository_id, instance.symbol_id,
        instance.symbol_instance_id, instance.language];
    if (incident.some((item, index) => item !== expected[index]))
        return false;
    return delta.direction !== "outgoing" || (fact.path === instance.path && sourceRangeContains(instance.source_range, fact.source_range));
}
function relationshipFactMatchesPublication(fact, baseSnapshotId, expectedGeneration) {
    if (fact.fact_type === "unresolved")
        return fact.generation === expectedGeneration;
    const snapshotId = fact.direction === "outgoing"
        ? fact.source_snapshot_id : fact.target_snapshot_id;
    const generation = fact.direction === "outgoing"
        ? fact.source_generation : fact.target_generation;
    return snapshotId === baseSnapshotId && generation === expectedGeneration;
}
function sourceRangeContains(outer, inner) {
    if (!isSourceRangeV2(outer) || !isSourceRangeV2(inner))
        return false;
    if (Number(inner.start_line) < Number(outer.start_line)
        || Number(inner.end_line) > Number(outer.end_line))
        return false;
    if (inner.start_line === outer.start_line && outer.start_column !== null
        && inner.start_column !== null
        && Number(inner.start_column) < Number(outer.start_column))
        return false;
    if (inner.end_line === outer.end_line && outer.end_column !== null
        && inner.end_column !== null
        && Number(inner.end_column) > Number(outer.end_column))
        return false;
    return true;
}
function sourceRangesEqual(left, right) {
    if (!isSourceRangeV2(left) || !isSourceRangeV2(right))
        return false;
    return left.start_line === right.start_line && left.end_line === right.end_line
        && left.start_column === right.start_column && left.end_column === right.end_column;
}
function hasV2Shape(value, required) {
    if (!isRecord(value) || value.schema_version !== "review-context/v2"
        || !required.every((key) => Object.hasOwn(value, key)))
        return false;
    const allowed = new Set(["schema_version", ...required]);
    return Object.keys(value).every((key) => allowed.has(key));
}
function isNonEmptyId(value) {
    return isBoundedString(value, 256);
}
function isBoundedString(value, maxLength) {
    return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}
function isIdArray(value) {
    return Array.isArray(value) && value.every(isNonEmptyId);
}
function isSortedUniqueStrings(values) {
    return values.every((value, index) => index === 0 || values[index - 1] < value);
}
function isSortedNumbers(values) {
    return values.every((value, index) => index === 0 || values[index - 1] <= value);
}
function isSortedUniqueNumbers(values) {
    return values.every((value, index) => index === 0 || values[index - 1] < value);
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
function isPositiveInteger(value) {
    return Number.isInteger(value) && Number(value) >= 1;
}
function isNonNegativeInteger(value) {
    return Number.isInteger(value) && Number(value) >= 0;
}
function isSha256(value) {
    return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
function isCommitSha(value) {
    return typeof value === "string" && /^[0-9a-f]{40,64}$/u.test(value);
}
function isIsoDate(value) {
    if (typeof value !== "string")
        return false;
    const match = /^(\d{4})-[0-1]\d-[0-3]\d[Tt][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-][0-2]\d:[0-5]\d)$/u.exec(value);
    if (match === null)
        return false;
    const [datePart, timeAndZone] = value.split(/[Tt]/u, 2);
    if (datePart === undefined || timeAndZone === undefined)
        return false;
    const [yearText, monthText, dayText] = datePart.split("-");
    const timeMatch = /^([0-2]\d):([0-5]\d):([0-5]\d)(?:\.\d+)?([Zz]|[+-]([0-2]\d):([0-5]\d))$/u.exec(timeAndZone);
    if (timeMatch === null)
        return false;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    const second = Number(timeMatch[3]);
    const offsetHour = timeMatch[5] === undefined ? 0 : Number(timeMatch[5]);
    const offsetMinute = timeMatch[6] === undefined ? 0 : Number(timeMatch[6]);
    if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59
        || offsetHour > 23 || offsetMinute > 59)
        return false;
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day >= 1 && day <= Number(daysInMonth[month - 1]);
}
function isCanonicalPath(value, allowRoot = false) {
    if (typeof value !== "string" || value.length > 4096 || value.includes("\\") || value.startsWith("/") || value.includes("\0"))
        return false;
    if (allowRoot && (value === "" || value === "."))
        return true;
    const parts = value.split("/");
    return value.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== "..");
}
function sha256Utf8(input) {
    const bytes = new TextEncoder().encode(input);
    const constants = new Uint32Array(64);
    const words = new Uint32Array(64);
    const isComposite = new Uint8Array(312);
    let primeCount = 0;
    for (let candidate = 2; primeCount < 64; candidate += 1) {
        if (isComposite[candidate])
            continue;
        for (let multiple = candidate * candidate; multiple < isComposite.length; multiple += candidate)
            isComposite[multiple] = 1;
        constants[primeCount] = Math.floor((Math.cbrt(candidate) % 1) * 0x100000000) >>> 0;
        primeCount += 1;
    }
    const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 4, bitLength >>> 0);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index += 1)
            words[index] = view.getUint32(offset + index * 4);
        for (let index = 16; index < 64; index += 1) {
            const x = words[index - 15];
            const y = words[index - 2];
            const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
            const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
            words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = hash;
        for (let index = 0; index < 64; index += 1) {
            const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const choice = (e & f) ^ (~e & g);
            const t1 = (h + s1 + choice + constants[index] + words[index]) >>> 0;
            const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (s0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        hash[0] = (hash[0] + a) >>> 0;
        hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0;
        hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0;
        hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0;
        hash[7] = (hash[7] + h) >>> 0;
    }
    return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function throwIfReviewPollingCancelled(signal, jobId) {
    if (signal?.aborted) {
        throw new ReviewContextPollingCancelledError(jobId);
    }
}
async function waitForReviewPoll(delayMs, signal, jobId) {
    throwIfReviewPollingCancelled(signal, jobId);
    await new Promise((resolve, reject) => {
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
function toIndexEventQueryParams(request) {
    return {
        workspace_id: request.workspaceId,
        collection: request.collection,
        status: request.status,
        operation: request.operation,
        limit: request.limit === undefined ? undefined : String(request.limit),
    };
}
function toIndexActivityQueryParams(request) {
    return {
        workspace_id: request.workspaceId,
        collection: request.collection,
        window_hours: request.windowHours === undefined ? undefined : String(request.windowHours),
        expected_interval_seconds: request.expectedIntervalSeconds === undefined ? undefined : String(request.expectedIntervalSeconds),
    };
}
function toIndexSessionQueryParams(request) {
    return {
        workspace_id: request.workspaceId,
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
export function resolveEnhancedPrompt(result) {
    return result.enhanced_prompt ?? result.enhancement_prompt ?? null;
}
export function requireEnhancedPrompt(result) {
    const prompt = resolveEnhancedPrompt(result);
    if (prompt) {
        return prompt;
    }
    throw new Error(result.generation_error ?? "Backend returned no enhanced prompt.");
}
