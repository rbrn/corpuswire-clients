import { createBearerAuthHeader, requestJson } from "./http.js";
const RUNTIME_ENV = globalThis.process?.env ?? {};
const DEFAULT_BASE_URL = RUNTIME_ENV.CORPUSWIRE_BASE_URL ?? "http://127.0.0.1:8000";
const DEFAULT_BASIC_AUTH = RUNTIME_ENV.CORPUSWIRE_BASIC_AUTH ?? "";
const DEFAULT_BEARER_TOKEN = RUNTIME_ENV.CORPUSWIRE_BEARER_TOKEN ?? "";
const DEFAULT_OUTPUT_MODE = "generic";
const DEFAULT_REVIEW_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_REVIEW_POLL_INTERVAL_MS = 1_000;
export class RemoteIndexDetachedError extends Error {
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
    async uploadFileBatch(sessionId, metadata, files) {
        const multipart = buildMultipartMixed(metadata, files);
        const response = await requestJson({
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
        const session = await this.startIndexSession(request);
        try {
            const manifestEntries = buildWorkspaceManifest(remoteFiles, request.deletedPaths ?? []);
            emitClientProgress("manifest_comparison", 0, manifestEntries.length, "files", "Sending manifest for comparison", session.session_id);
            const manifestResult = await this.sendManifestBatch(session.session_id, manifestEntries);
            const initiallyComplete = manifestResult.unchanged + manifestResult.deletes + manifestResult.skipped;
            emitClientProgress("manifest_comparison", manifestEntries.length, manifestEntries.length, "files", "Manifest comparison complete", session.session_id, initiallyComplete, manifestEntries.length);
            const uploadRequired = new Set(manifestResult.upload_required);
            const filesToUpload = remoteFiles.filter(({ file }) => uploadRequired.has(file.relativePath));
            let queuedBackgroundWork = false;
            let uploadedFiles = 0;
            if (filesToUpload.length > 0) {
                const uploadBatches = buildUploadBatches(filesToUpload, request.batchBytes ?? session.max_batch_bytes, session.max_batch_files);
                await runWithConcurrency(uploadBatches, request.maxConcurrentUploads ?? session.max_concurrent_uploads, async (batchFiles) => {
                    const result = await this.uploadFileBatch(session.session_id, { files: batchFiles.map((file) => file.descriptor) }, batchFiles);
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
            return committed;
        }
        catch (error) {
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
    const content = toUint8Array(file.content);
    return {
        file,
        content,
        sha256: file.sha256 ?? await sha256Hex(content),
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
    async function runNext() {
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
async function sha256Hex(content) {
    if (!globalThis.crypto?.subtle) {
        throw new Error("Remote indexWorkspace requires sha256 values when Web Crypto is unavailable.");
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
