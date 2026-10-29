import { INVENTORY_VERSION, WorkspaceScanIncompleteError, buildWorkspaceInventory, canonicalInventoryPath, ingestionPriority, inventoryDigest } from "./inventory.js";
import { CorpusWireHttpError, createBearerAuthHeader, requestJson, waitForAbortableDelay } from "./http.js";
const RUNTIME_ENV = globalThis.process?.env ?? {};
const DEFAULT_BASE_URL = RUNTIME_ENV.CORPUSWIRE_BASE_URL ?? "http://127.0.0.1:8000";
const DEFAULT_BASIC_AUTH = RUNTIME_ENV.CORPUSWIRE_BASIC_AUTH ?? "";
const DEFAULT_BEARER_TOKEN = RUNTIME_ENV.CORPUSWIRE_BEARER_TOKEN ?? "";
const DEFAULT_OUTPUT_MODE = "generic";
const MAX_MANIFEST_ERROR_DETAILS = 20;
const MAX_MANIFEST_ERROR_LENGTH = 256;
const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 600_000;
class IndexProcessingInterruptedError extends Error {
    reason;
    status;
    constructor(reason, status, cause) {
        super(reason === "timeout" ? "Caller wait timeout elapsed" : "Processing wait interrupted by caller", { cause });
        this.reason = reason;
        this.status = status;
    }
}
export class RemoteIndexInterruptionError extends Error {
    reason;
    sessionIdentity;
    status;
    transfer;
    abortRequested;
    releaseConfirmed;
    interruptionOnly;
    sessionId;
    constructor(message, reason, sessionIdentity, status, transfer, abortRequested, releaseConfirmed, interruptionOnly, cause) {
        super(message, { cause });
        this.reason = reason;
        this.sessionIdentity = sessionIdentity;
        this.status = status;
        this.transfer = transfer;
        this.abortRequested = abortRequested;
        this.releaseConfirmed = releaseConfirmed;
        this.interruptionOnly = interruptionOnly;
        this.name = "RemoteIndexInterruptionError";
        this.sessionId = sessionIdentity.session_id;
    }
}
function isInterruptionOnly(error) {
    const cause = error instanceof IndexProcessingInterruptedError ? error.cause : error;
    return (error instanceof IndexProcessingInterruptedError && cause === undefined)
        || (cause instanceof DOMException && (cause.name === "AbortError" || cause.name === "TimeoutError"));
}
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
    async diagnoseWorkspace(request = {}, options = {}) {
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
            init: { method: "GET", signal: options.signal },
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
    /** Idempotently register a workspace in the caller's tenant with the caller as owner. */
    async ensureWorkspace(request) {
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: ["/v1/workspaces/ensure"],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ workspace_id: request.workspaceId, display_name: request.displayName }),
            },
        });
        return {
            mode: response.mode,
            created: response.created,
            workspaceId: response.workspace_id,
            tenantId: response.tenant_id,
        };
    }
    /** Create a tenant, its owner, a first workspace and a tenant-wide credential (shown once). */
    async selfOnboard(request) {
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: ["/v1/onboarding"],
            fetchFn: this.fetchFn,
            defaultHeaders: {},
            init: {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tenant_id: request.tenantId,
                    tenant_display_name: request.tenantDisplayName,
                    owner_display_name: request.ownerDisplayName,
                    workspace_id: request.workspaceId,
                    workspace_display_name: request.workspaceDisplayName,
                    credential_name: request.credentialName,
                    scopes: request.scopes ?? ["index:read", "index:write", "retrieval:read"],
                }),
            },
        });
        return { tenantId: response.tenant.tenant_id, token: response.credential.token };
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
    async listIndexSessions(request = {}, options = {}) {
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/index/sessions${toQueryString(toIndexSessionQueryParams(request))}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET", signal: options.signal },
        });
        return response.sessions;
    }
    async startIndexSession(request) {
        if (request.inventory || request.baseCoverageToken || request.selectionPolicyDigest) {
            const capabilities = await this.getIndexCapabilities();
            if (!capabilities.inventory_coverage_versions?.includes(INVENTORY_VERSION)) {
                if (request.evaluationInventoryAttestation) {
                    throw new WorkspaceScanIncompleteError("Evaluation inventory attestation requires workspace inventory coverage");
                }
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
                const excludedPaths = new Set(request.evaluationInventoryAttestation?.excluded_entries.map((entry) => entry.relative_path) ?? []);
                const eligibleTriples = request.evaluationInventoryAttestation
                    ? triples.filter(([relativePath]) => !excludedPaths.has(relativePath))
                    : triples;
                request = { ...request, inventory: await buildWorkspaceInventory(eligibleTriples, {
                        version: "workspace-selection/v1", include_globs: request.includeGlobs ?? [], exclude_globs: request.excludeGlobs ?? [],
                        ignore_digest: request.inventoryScan.ignoreDigest, producer: request.inventoryScan.producer,
                        supported_file_registry_version: capabilities.supported_file_registry_version,
                        max_file_size_bytes: Math.min(request.maxFileSizeBytes ?? capabilities.max_file_size_bytes, capabilities.max_file_size_bytes),
                        symlink_policy: "skip",
                    }, request.inventoryScan) };
            }
            if (request.evaluationInventoryAttestation && !request.inventory) {
                throw new WorkspaceScanIncompleteError("Evaluation inventory attestation requires workspace inventory coverage");
            }
        }
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
    async uploadFileBatch(sessionId, metadata, files, onAttempt, options = {}) {
        const multipart = buildMultipartMixed(metadata, files);
        const timeoutMs = validateNonNegativeNumber(options.queueWaitTimeoutMs ?? DEFAULT_QUEUE_WAIT_TIMEOUT_MS, "queueWaitTimeoutMs");
        const deadline = Date.now() + timeoutMs;
        let lastQueueError;
        return withRequestBudget(async (signal) => {
            for (;;) {
                if (signal.aborted)
                    throw new DOMException("Upload aborted", "AbortError");
                try {
                    const response = await requestJson({
                        retryHttp429: false,
                        onRetry: options.onTransportRetry,
                        retryAttempts: timeoutMs === 0 ? 0 : undefined,
                        baseUrl: this.baseUrl,
                        paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/files/batch`],
                        fetchFn: (input, init) => {
                            if (signal.aborted)
                                throw new DOMException("Upload aborted", "AbortError");
                            onAttempt?.();
                            return (this.fetchFn ?? globalThis.fetch)(input, init);
                        },
                        defaultHeaders: this.defaultHeaders,
                        basicAuth: this.basicAuth,
                        init: {
                            method: "POST",
                            signal,
                            headers: {
                                "Content-Type": multipart.contentType,
                                Prefer: "respond-async",
                            },
                            body: new Blob([toArrayBuffer(multipart.body)]),
                        },
                    });
                    return response.result;
                }
                catch (error) {
                    if (!(error instanceof CorpusWireHttpError) || error.status !== 429
                        || error.errorCode !== "index_queue_full" || !error.retryable)
                        throw error;
                    lastQueueError = error;
                    options.onQueueFull?.();
                    const remainingMs = deadline - Date.now();
                    if (remainingMs <= 0)
                        throw error;
                    const waitStartedAt = Date.now();
                    options.onQueueHeartbeat?.(0, false);
                    const waitEndsAt = waitStartedAt
                        + Math.min(remainingMs, Math.max(10, (error.retryAfterSeconds ?? 1) * 1_000));
                    try {
                        while (Date.now() < waitEndsAt) {
                            await waitForAbortableDelay(Math.min(waitEndsAt - Date.now(), options.onQueueHeartbeat ? 1_000 : remainingMs), signal);
                            if (Date.now() < waitEndsAt) {
                                options.onQueueHeartbeat?.(Math.max(0, Date.now() - waitStartedAt), true);
                            }
                        }
                    }
                    finally {
                        options.onQueueWait?.(Math.max(0, Date.now() - waitStartedAt));
                    }
                    if (Date.now() >= deadline)
                        throw error;
                    options.onQueueRetry?.();
                }
            }
        }, timeoutMs, options.signal, () => lastQueueError ?? new Error("Upload admission timeout elapsed"));
    }
    async checkpointIndexSessionCode(sessionId, options = {}) {
        const remainingMs = options.deadline === undefined ? 0 : options.deadline - Date.now();
        if (options.deadline !== undefined && remainingMs <= 0)
            throw new DOMException("Code checkpoint timeout elapsed", "TimeoutError");
        return withRequestBudget(async (signal) => {
            const response = await requestJson({
                baseUrl: this.baseUrl,
                paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/checkpoint/code`],
                fetchFn: this.fetchFn,
                defaultHeaders: this.defaultHeaders,
                basicAuth: this.basicAuth,
                init: { method: "POST", signal },
            });
            const observed = response.result;
            // Returned backend failure evidence takes precedence over caller races.
            if (["failed", "incomplete", "expired"].includes(observed.phase)
                || observed.errors.length > 0 || (observed.failed_batches ?? 0) > 0) {
                throw new Error(`Remote index session ${sessionId} failed: ${observed.errors.join("; ") || observed.phase}`, { cause: observed });
            }
            if (signal.aborted)
                throw new DOMException("Code checkpoint aborted", "AbortError");
            if (options.deadline !== undefined && Date.now() >= options.deadline)
                throw new DOMException("Code checkpoint timeout elapsed", "TimeoutError");
            return response.result;
        }, remainingMs, options.signal, () => new DOMException("Code checkpoint timeout elapsed", "TimeoutError"));
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
    async getIndexSessionStatus(sessionId, options = {}) {
        const response = await requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/status`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "GET", signal: options.signal },
        });
        return response.result;
    }
    async followIndexSession(sessionId, options = {}) {
        const deadline = options.timeoutMs === undefined
            ? null
            : Date.now() + Math.max(1, options.timeoutMs);
        let abortSent = false;
        const observeStatus = createIndexStatusObserver(options.pollMs ?? 250, options.onProgress);
        for (;;) {
            const status = await this.getIndexSessionStatus(sessionId);
            const pollDelay = observeStatus(status);
            if (["completed", "aborted", "failed", "expired", "incomplete"].includes(status.phase)) {
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
            await waitForIndexInterruptDelay(remainingIndexPollDelay(pollDelay, deadline), abortSent
                ? { detachSignal: options.detachSignal } : options);
        }
    }
    async abortIndexSession(sessionId, options = {}) {
        return requestJson({
            baseUrl: this.baseUrl,
            paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}`],
            fetchFn: this.fetchFn,
            defaultHeaders: this.defaultHeaders,
            basicAuth: this.basicAuth,
            init: { method: "DELETE", signal: options.signal },
        });
    }
    async releaseCodeStageSession(session, workspaceId, deadline, pollMs, callerSignal, cancellationSignal, onProgress) {
        const release = (attemptDeadline, signal) => this.abortIndexSessionByDeadline(session.session_id, attemptDeadline, pollMs, onProgress, signal);
        try {
            return await release(deadline ?? Date.now() + 5_000, callerSignal);
        }
        catch (cause) {
            // A cancelled transport may already have delivered DELETE. Retry cleanup
            // with an independent finite reserve; never strand callers on its IO.
            let cleanupStatus;
            try {
                cleanupStatus = await release(Date.now() + 1_000);
            }
            catch { /* Best effort only. */ }
            const confirmed = cleanupStatus !== undefined
                && isOwnedCodeStageStatus(cleanupStatus, session, workspaceId)
                && cleanupStatus.phase === "aborted" && cleanupStatus.pending_batches === 0
                && cleanupStatus.active_batches === 0;
            if (cancellationSignal?.aborted && confirmed)
                return cleanupStatus;
            throw new Error(`Code stage session release was interrupted; ${confirmed
                ? "the owned session abort was confirmed" : "an abort was requested but release could not be confirmed"}. Start a new index operation.`, { cause });
        }
    }
    abortIndexSessionByDeadline(sessionId, deadline, pollMs, onProgress, callerSignal) {
        const budgetMs = deadline - Date.now();
        if (budgetMs <= 0)
            return Promise.reject(new Error("Code stage session release timed out"));
        return withRequestBudget(async (transportSignal) => {
            await this.abortIndexSession(sessionId, { signal: transportSignal });
            const status = await this.waitForIndexSessionTerminal(sessionId, pollMs, onProgress, undefined, deadline, transportSignal);
            if (Date.now() >= deadline)
                throw new Error("Code stage session release timed out");
            return status;
        }, budgetMs, callerSignal, () => new Error("Code stage session release timed out"));
    }
    async waitForIndexSessionProcessing(sessionId, deadline, pollMs, request, ignoreMissingUploads = false, remainingUploads = 0, transportSignal) {
        const observeStatus = createIndexStatusObserver(pollMs, request.onProgress);
        let lastStatus;
        const interrupt = (cause) => new IndexProcessingInterruptedError(request.signal?.aborted ? "cancel"
            : request.detachSignal?.aborted ? "detach" : "timeout", lastStatus, cause);
        for (;;) {
            if (request.signal?.aborted || request.detachSignal?.aborted
                || (deadline !== null && Date.now() >= deadline))
                throw interrupt();
            let status;
            try {
                status = await withRequestBudget(async (signal) => {
                    const observed = await this.getIndexSessionStatus(sessionId, { signal });
                    lastStatus = observed;
                    // A returned backend failure takes precedence over a racing caller
                    // interruption or deadline; retain its evidence through abort cleanup.
                    if (["failed", "incomplete", "expired"].includes(observed.phase)
                        || observed.errors.length > 0 || (observed.failed_batches ?? 0) > 0) {
                        throw new Error(`Remote index session ${sessionId} failed: ${observed.errors.join("; ") || observed.phase}`, { cause: observed });
                    }
                    if (signal.aborted)
                        throw new DOMException("Processing wait aborted", "AbortError");
                    if (deadline !== null && Date.now() >= deadline)
                        throw new DOMException("Caller wait timeout elapsed", "TimeoutError");
                    return observed;
                }, deadline === null ? 0 : Math.max(1, deadline - Date.now()), transportSignal, () => new DOMException("Caller wait timeout elapsed", "TimeoutError"));
            }
            catch (cause) {
                if (request.signal?.aborted || request.detachSignal?.aborted
                    || (cause instanceof Error && cause.name === "TimeoutError"))
                    throw interrupt(cause);
                throw cause;
            }
            const pollDelay = observeStatus(status);
            if (["failed", "incomplete", "aborted", "expired"].includes(status.phase)) {
                if (status.phase === "aborted") {
                    return status;
                }
                throw new Error(`Remote index session ${sessionId} entered ${status.phase}: ${status.errors.join("; ") || "unknown error"}`);
            }
            const pendingBatches = status.pending_batches ?? 0;
            const activeBatches = status.active_batches ?? 0;
            if (status.errors.length > 0)
                throw new Error(`Remote index session ${sessionId} failed: ${status.errors.join("; ")}`);
            const countersAvailable = status.pending_batches !== undefined && status.active_batches !== undefined;
            const drained = ignoreMissingUploads
                ? countersAvailable || status.queue_depth <= remainingUploads
                : status.queue_depth === 0;
            if (request.signal?.aborted || request.detachSignal?.aborted
                || (deadline !== null && Date.now() >= deadline))
                throw interrupt();
            if (pendingBatches === 0 && activeBatches === 0 && drained) {
                return status;
            }
            await waitForIndexInterruptDelay(remainingIndexPollDelay(pollDelay, deadline), request);
        }
    }
    async indexWorkspace(request) {
        return this.runIndexWorkspace(request, false);
    }
    /**
     * Publish code from a complete scan and release the drained owned session.
     * Checkpoint and release share the processing budget, or 5 seconds when unspecified.
     * Interruption allows up to 1 extra second for best-effort abort confirmation.
     */
    async indexWorkspaceCodeStage(request) {
        if (request.mode !== "full" || request.snapshotScope || request.evaluationInventoryAttestation
            || request.inventoryScan?.complete !== true) {
            throw new WorkspaceScanIncompleteError("Code stage requires a complete canonical v1 full scan");
        }
        return this.runIndexWorkspace(request, true);
    }
    async runIndexWorkspace(request, codeStage) {
        const clientStartedAt = Date.now();
        let clientSequence = 0;
        const phaseClock = createClientPhaseClock();
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
                phaseStartedAt: phaseClock.enter(phase),
                phaseTimings: phaseClock.snapshot(),
                throughputCompleted: phaseClock.workCompleted(completed),
                overallCompleted,
                overallTotal,
            }));
            clientSequence += 1;
        };
        emitClientProgress("resolving_configuration", 0, null, "items", "Resolving remote indexing configuration");
        emitClientProgress("filtering_hashing", 0, request.files.length, "files", "Preparing workspace file hashes");
        const remoteFiles = await Promise.all(request.files.map(prepareRemoteWorkspaceFile));
        emitClientProgress("filtering_hashing", remoteFiles.length, remoteFiles.length, "files", "Workspace file hashes prepared");
        if (request.inventoryScan && request.signal?.aborted)
            throw new WorkspaceScanIncompleteError("Scan cancelled before session creation");
        const triples = remoteFiles.map(({ file, sha256, content }) => [file.relativePath, sha256, content.length]);
        await inventoryDigest(triples);
        phaseClock.pause();
        phaseClock.enter("resolving_configuration");
        if (request.inventoryScan) {
            if (request.mode !== "full" || request.snapshotScope)
                throw new WorkspaceScanIncompleteError("Inventory requires a v1 full scan");
            const capabilities = await this.getIndexCapabilities();
            if (request.inventoryScan.complete !== true)
                throw new WorkspaceScanIncompleteError();
            if (capabilities.inventory_coverage_versions?.includes(INVENTORY_VERSION)) {
                if (!capabilities.supported_file_registry_version)
                    throw new WorkspaceScanIncompleteError("Missing supported file registry version");
                const excludedPaths = new Set(request.evaluationInventoryAttestation?.excluded_entries.map((entry) => entry.relative_path) ?? []);
                const eligibleTriples = request.evaluationInventoryAttestation
                    ? triples.filter(([relativePath]) => !excludedPaths.has(relativePath))
                    : triples;
                request = { ...request, inventory: await buildWorkspaceInventory(eligibleTriples, {
                        version: "workspace-selection/v1", include_globs: request.includeGlobs ?? [], exclude_globs: request.excludeGlobs ?? [],
                        ignore_digest: request.inventoryScan.ignoreDigest, producer: request.inventoryScan.producer,
                        supported_file_registry_version: capabilities.supported_file_registry_version,
                        max_file_size_bytes: Math.min(request.maxFileSizeBytes ?? capabilities.max_file_size_bytes, capabilities.max_file_size_bytes),
                        symlink_policy: "skip",
                    }, request.inventoryScan) };
            }
            if (request.evaluationInventoryAttestation && !request.inventory) {
                throw new WorkspaceScanIncompleteError("Evaluation inventory attestation requires workspace inventory coverage");
            }
        }
        if (codeStage && remoteFiles.length > 0
            && !remoteFiles.some(({ file }) => ingestionPriority(file.relativePath) === 1)) {
            return { outcome: "deferred", reason: "no_code", full_inventory_complete: false,
                files_submitted: remoteFiles.length };
        }
        const transfer = {
            files_submitted: remoteFiles.length, files_upload_required: null, files_reused: null,
            files_transferred: 0, source_bytes_transferred: 0, upload_attempts: 0,
            source_bytes_attempted: 0, queue_retries: 0, queue_full_responses: 0, queue_wait_ms: 0, transport_retries: 0,
            client_phase_timings_ms: {}, complete: false, acknowledged_files: [],
        };
        const session = await this.startIndexSession(request);
        const uploadStop = new AbortController();
        let clientOwnedCheckpoint = false;
        let codeStageReleaseStarted = false;
        let lastProcessingStatus;
        const stopUploads = () => uploadStop.abort();
        request.signal?.addEventListener("abort", stopUploads, { once: true });
        request.detachSignal?.addEventListener("abort", stopUploads, { once: true });
        const checkInterrupt = async () => {
            // Include interrupts queued by a just-delivered progress callback.
            await Promise.resolve();
            if (request.signal?.aborted || request.detachSignal?.aborted) {
                throw new IndexProcessingInterruptedError(request.signal?.aborted ? "cancel" : "detach", lastProcessingStatus);
            }
        };
        try {
            await checkInterrupt();
            const manifestEntries = buildWorkspaceManifest(remoteFiles, request.deletedPaths ?? []);
            emitClientProgress("manifest_comparison", 0, manifestEntries.length, "files", "Sending manifest for comparison", session.session_id);
            const manifestResult = await this.sendManifestBatch(session.session_id, manifestEntries);
            const initiallyComplete = manifestResult.unchanged + manifestResult.deletes + manifestResult.skipped;
            emitClientProgress("manifest_comparison", manifestEntries.length, manifestEntries.length, "files", "Manifest comparison complete", session.session_id, initiallyComplete, manifestEntries.length);
            phaseClock.pause();
            const uploadRequired = new Set(manifestResult.upload_required);
            transfer.files_upload_required = uploadRequired.size;
            transfer.files_reused = manifestResult.unchanged;
            const expectedEvaluationSkips = request.evaluationInventoryAttestation?.excluded_file_count ?? 0;
            if (manifestResult.errors.length
                || manifestResult.skipped !== expectedEvaluationSkips) {
                const manifestErrors = sanitizeManifestErrors(manifestResult.errors);
                const detail = manifestErrors.length > 0
                    ? `: ${manifestErrors.join("; ")}`
                    : `: skipped=${manifestResult.skipped}`;
                throw new WorkspaceScanIncompleteError(`Server rejected manifest entries${detail}`, {
                    sessionId: session.session_id,
                    manifestErrors,
                    manifestSkipped: manifestResult.skipped,
                });
            }
            for (const { file, sha256 } of remoteFiles) {
                if (!uploadRequired.has(file.relativePath)) {
                    transfer.acknowledged_files.push({ relative_path: file.relativePath, sha256, disposition: "confirmed_reused" });
                }
            }
            const filesToUpload = remoteFiles.filter(({ file }) => uploadRequired.has(file.relativePath));
            let queuedBackgroundWork = false;
            let uploadedFiles = 0;
            // All tier drains share the caller's processing budget. Starting it at
            // the first drain or checkpoint preserves the upload-versus-processing split.
            let processingDeadline = null;
            const processingWaitDeadline = () => {
                const timeoutMs = request.processingTimeoutMs ?? (codeStage ? 5_000 : undefined);
                if (processingDeadline === null && timeoutMs !== undefined) {
                    processingDeadline = Date.now() + Math.max(1, timeoutMs);
                }
                return processingDeadline;
            };
            for (const priority of [1, 2, 3]) {
                await checkInterrupt();
                if (processingDeadline !== null && Date.now() >= processingDeadline
                    && uploadedFiles < filesToUpload.length) {
                    if (clientOwnedCheckpoint)
                        throw new DOMException("Caller wait timeout elapsed", "TimeoutError");
                    throw new IndexProcessingInterruptedError("timeout");
                }
                const tierFiles = filesToUpload.filter(({ file }) => ingestionPriority(file.relativePath) === priority);
                let tierQueued = false;
                const uploadBatches = tierFiles.length === 0 ? [] : buildUploadBatches(tierFiles, clampUploadLimit(request.batchBytes, session.max_batch_bytes, "batchBytes"), session.max_batch_files);
                if (uploadBatches.length)
                    phaseClock.enter("uploading", uploadedFiles);
                await runWithConcurrency(uploadBatches, uploadBatches.length === 0 ? 1
                    : clampUploadLimit(request.maxConcurrentUploads, session.max_concurrent_uploads, "maxConcurrentUploads"), async (batchFiles) => {
                    if (uploadStop.signal.aborted)
                        throw new DOMException("Upload stopped", "AbortError");
                    if (batchFiles.some((file) => file.descriptor.size > session.max_batch_bytes)) {
                        uploadStop.abort();
                        throw new Error("A source file exceeds the server's upload batch byte limit");
                    }
                    try {
                        let queueSequence = clientSequence;
                        let queueProgressAt = new Date().toISOString();
                        const result = await this.uploadFileBatch(session.session_id, { files: batchFiles.map((file) => file.descriptor) }, batchFiles, () => {
                            transfer.upload_attempts += 1;
                            transfer.source_bytes_attempted += batchFiles.reduce((sum, file) => sum + file.descriptor.size, 0);
                        }, {
                            signal: uploadStop.signal, queueWaitTimeoutMs: request.queueWaitTimeoutMs,
                            onQueueRetry: () => { transfer.queue_retries += 1; },
                            onQueueFull: () => { transfer.queue_full_responses += 1; },
                            onTransportRetry: () => { transfer.transport_retries += 1; },
                            onQueueWait: (elapsedMs) => { transfer.queue_wait_ms += elapsedMs; },
                            onQueueHeartbeat: (elapsedMs, heartbeat) => {
                                const occurredAt = new Date().toISOString();
                                if (!heartbeat) {
                                    queueSequence = clientSequence;
                                    clientSequence += 1;
                                    queueProgressAt = occurredAt;
                                }
                                emitProgress({ ...clientIndexProgressEvent({
                                        sequence: queueSequence, sessionId: session.session_id,
                                        workspaceId: request.workspace.workspaceId, phase: "queued",
                                        completed: uploadedFiles, total: filesToUpload.length, unit: "files",
                                        message: "Waiting for upload queue capacity", startedAt: clientStartedAt,
                                        phaseStartedAt: Date.now() - elapsedMs, phaseTimings: phaseClock.snapshot(),
                                        throughputCompleted: 0,
                                        overallCompleted: initiallyComplete, overallTotal: manifestEntries.length,
                                    }), heartbeat, active_heartbeat: heartbeat, last_progress_at: queueProgressAt,
                                    last_heartbeat_at: heartbeat ? occurredAt : null });
                            },
                        });
                        if (result.errors.length)
                            throw new Error("Source upload was not fully acknowledged");
                        transfer.files_transferred += batchFiles.length;
                        transfer.source_bytes_transferred += batchFiles.reduce((sum, file) => sum + file.descriptor.size, 0);
                        transfer.acknowledged_files.push(...batchFiles.map((file) => ({
                            relative_path: file.descriptor.relativePath, sha256: file.descriptor.sha256, disposition: "uploaded",
                        })));
                        queuedBackgroundWork ||= result.queued === true;
                        tierQueued ||= result.queued === true;
                        uploadedFiles += batchFiles.length;
                        emitClientProgress("uploading", uploadedFiles, filesToUpload.length, "files", "Uploading changed files", session.session_id, initiallyComplete, manifestEntries.length);
                    }
                    catch (error) {
                        uploadStop.abort();
                        throw error;
                    }
                });
                phaseClock.pause();
                if (tierQueued) {
                    // Later queued tiers still need this client's commit after they drain.
                    const status = await this.waitForIndexSessionProcessing(session.session_id, processingWaitDeadline(), request.processingPollMs ?? 250, { ...request, onProgress: emitProgress }, true, filesToUpload.length - uploadedFiles, uploadStop.signal);
                    lastProcessingStatus = status;
                    if (status.phase === "aborted")
                        throw new RemoteIndexCancelledError(session.session_id, status);
                }
                await checkInterrupt();
                if (priority === 1 && session.code_checkpoint === true && request.inventory
                    && session.mode === "full" && !request.snapshotScope && !request.evaluationInventoryAttestation
                    && remoteFiles.some(({ file }) => ingestionPriority(file.relativePath) === 1)) {
                    clientOwnedCheckpoint = true;
                    const status = await this.checkpointIndexSessionCode(session.session_id, {
                        signal: uploadStop.signal, deadline: processingWaitDeadline() ?? undefined,
                    });
                    if (status.coverage?.code_ready !== true) {
                        throw new Error("Code checkpoint did not confirm code readiness");
                    }
                    if (codeStage && (!isOwnedCodeStageStatus(status, session, request.workspace.workspaceId)
                        || status.coverage.state !== "pending" || status.coverage.session_id !== session.session_id
                        || status.pending_batches !== 0 || status.active_batches !== 0
                        || status.phase !== "ready_to_commit")) {
                        throw new Error("Code stage checkpoint did not confirm drained pending code publication");
                    }
                    if (status.progress)
                        emitProgress(status.progress);
                    request.onCodeReady?.(status);
                    if (codeStage) {
                        codeStageReleaseStarted = true;
                        const releaseStatus = await this.releaseCodeStageSession(session, request.workspace.workspaceId, processingWaitDeadline(), request.processingPollMs ?? 250, uploadStop.signal, request.signal, emitProgress);
                        if (!isOwnedCodeStageStatus(releaseStatus, session, request.workspace.workspaceId)
                            || releaseStatus.phase !== "aborted" || releaseStatus.pending_batches !== 0
                            || releaseStatus.active_batches !== 0) {
                            throw new Error("Code stage session release was not confirmed");
                        }
                        if (request.signal?.aborted)
                            throw new RemoteIndexCancelledError(session.session_id, releaseStatus);
                        transfer.client_phase_timings_ms = phaseClock.snapshot();
                        return { outcome: "code_ready", full_inventory_complete: false, checkpoint: status,
                            release_status: releaseStatus, transfer };
                    }
                    await checkInterrupt();
                }
            }
            if (queuedBackgroundWork) {
                phaseClock.pause();
                const processingStatus = await this.waitForIndexSessionProcessing(session.session_id, processingWaitDeadline(), request.processingPollMs ?? 250, { ...request, onProgress: emitProgress }, false, 0, uploadStop.signal);
                lastProcessingStatus = processingStatus;
                if (request.signal?.aborted || processingStatus.phase === "aborted") {
                    throw new IndexProcessingInterruptedError("cancel", processingStatus);
                }
            }
            await checkInterrupt();
            emitClientProgress("committing", 0, null, "items", "Waiting for verified commit", session.session_id);
            await checkInterrupt();
            const committed = await this.commitIndexSession(session.session_id);
            clientOwnedCheckpoint = false;
            phaseClock.pause();
            transfer.client_phase_timings_ms = phaseClock.snapshot();
            if (committed.status.progress) {
                emitProgress(committed.status.progress);
            }
            if (codeStage && committed.status.phase !== "completed") {
                throw new WorkspaceScanIncompleteError("Code-stage full fallback did not confirm completed indexing");
            }
            transfer.complete = true;
            const fullResult = { ...committed, transfer };
            return codeStage ? { outcome: "full", reason: remoteFiles.length === 0 ? "empty_inventory"
                    : "checkpoint_unsupported", full_inventory_complete: committed.status.coverage?.state === "verified",
                committed: fullResult } : fullResult;
        }
        catch (error) {
            phaseClock.pause();
            const originalError = error;
            const interruptionOnly = isInterruptionOnly(originalError);
            // Cleanup can itself trigger caller abort callbacks. Preserve the reason
            // observed on catch entry rather than reclassifying the primary failure.
            const cancelledAtCatch = request.signal?.aborted === true;
            const detachedAtCatch = request.detachSignal?.aborted === true;
            if (codeStageReleaseStarted) {
                if (error instanceof Error)
                    Object.assign(error, { transfer });
                throw error;
            }
            if (!(error instanceof IndexProcessingInterruptedError) && (cancelledAtCatch || detachedAtCatch
                || error instanceof RemoteIndexDetachedError)) {
                error = new IndexProcessingInterruptedError(cancelledAtCatch ? "cancel" : "detach", lastProcessingStatus, error);
            }
            if (clientOwnedCheckpoint || error instanceof IndexProcessingInterruptedError || error instanceof RemoteIndexCancelledError) {
                let terminal;
                try {
                    terminal = await this.abortIndexSessionByDeadline(session.session_id, Date.now() + 1_000, request.processingPollMs ?? 250, emitProgress);
                }
                catch { /* The owned abort has only a finite best-effort reserve. */ }
                const confirmed = terminal !== undefined && terminal.phase === "aborted"
                    && (clientOwnedCheckpoint
                        ? isOwnedCodeStageStatus(terminal, session, request.workspace.workspaceId)
                            && terminal.pending_batches === 0 && terminal.active_batches === 0
                        : terminal.session_id === session.session_id && Array.isArray(terminal.errors) && terminal.errors.length === 0
                            && (session.workspace_id === undefined || terminal.workspace_id === session.workspace_id)
                            && (session.collection_name === undefined || terminal.collection_name === session.collection_name)
                            && (session.mode === undefined || terminal.mode === session.mode)
                            && (terminal.failed_batches === undefined || terminal.failed_batches === 0)
                            && terminal.pending_batches === 0 && terminal.active_batches === 0);
                if ((interruptionOnly || error instanceof RemoteIndexCancelledError)
                    && (cancelledAtCatch || error instanceof RemoteIndexCancelledError
                        || (error instanceof IndexProcessingInterruptedError && error.reason === "cancel")) && confirmed) {
                    const cancelled = new RemoteIndexCancelledError(session.session_id, terminal);
                    Object.assign(cancelled, { transfer, cause: error });
                    throw cancelled;
                }
                // Genuine checkpoint/publication failures remain primary after cleanup;
                // only actual interruption evidence should receive an interruption label.
                if (!cancelledAtCatch && !detachedAtCatch
                    && !(error instanceof RemoteIndexDetachedError) && !(error instanceof RemoteIndexCancelledError)
                    && !(error instanceof IndexProcessingInterruptedError)
                    && !(error instanceof Error && error.name === "TimeoutError")) {
                    if (error instanceof Error)
                        Object.assign(error, { transfer });
                    throw error;
                }
                const incompleteUploads = transfer.files_upload_required === null || transfer.files_transferred < transfer.files_upload_required;
                const stopped = clientOwnedCheckpoint ? "Indexing stopped during the client-owned code checkpoint"
                    : incompleteUploads ? "Indexing stopped before all required source uploads were submitted"
                        : "Indexing stopped while waiting for source processing";
                const interrupted = new RemoteIndexInterruptionError(`${stopped}; ${confirmed
                    ? `${incompleteUploads ? "an abort was requested for the incomplete session; " : ""}the owned session abort was confirmed`
                    : `an abort was requested${incompleteUploads ? " for the incomplete session" : ""} but release could not be confirmed`}. Start a new index operation to complete the inventory.`, error instanceof IndexProcessingInterruptedError ? error.reason
                    : cancelledAtCatch ? "cancel" : detachedAtCatch ? "detach" : "timeout", { session_id: session.session_id, workspace_id: session.workspace_id,
                    collection_name: session.collection_name, mode: session.mode }, terminal ?? (originalError instanceof IndexProcessingInterruptedError ? originalError.status : lastProcessingStatus), transfer, true, confirmed, interruptionOnly, originalError);
                throw interrupted;
            }
            if (error instanceof Error)
                Object.assign(error, { transfer });
            try {
                await withRequestBudget((signal) => this.abortIndexSession(session.session_id, { signal }), 1_000, undefined, () => new Error("Index failure cleanup timed out"));
            }
            catch { /* Preserve the original failure; release remains unconfirmed. */ }
            throw error;
        }
        finally {
            phaseClock.pause();
            transfer.client_phase_timings_ms = phaseClock.snapshot();
            request.signal?.removeEventListener("abort", stopUploads);
            request.detachSignal?.removeEventListener("abort", stopUploads);
        }
    }
    async waitForIndexSessionTerminal(sessionId, pollMs, onProgress, detachSignal, deadline = null, transportSignal) {
        const observeStatus = createIndexStatusObserver(pollMs, onProgress);
        for (;;) {
            if (transportSignal?.aborted)
                throw new DOMException("Session release aborted", "AbortError");
            if (deadline !== null && Date.now() >= deadline)
                throw new Error("Session release confirmation timed out");
            const status = await this.getIndexSessionStatus(sessionId, { signal: transportSignal });
            if (transportSignal?.aborted)
                throw new DOMException("Session release aborted", "AbortError");
            if (deadline !== null && Date.now() >= deadline) {
                throw new RemoteIndexDetachedError(sessionId, status, "Session release confirmation timed out");
            }
            const pollDelay = observeStatus(status);
            if (["aborted", "failed", "expired", "completed"].includes(status.phase)) {
                return status;
            }
            if (detachSignal?.aborted) {
                throw new RemoteIndexDetachedError(sessionId, status, "Detached while cancellation was pending");
            }
            if (deadline !== null && Date.now() >= deadline) {
                throw new RemoteIndexDetachedError(sessionId, status, "Session release confirmation timed out");
            }
            await waitForIndexInterruptDelay(remainingIndexPollDelay(pollDelay, deadline), { signal: transportSignal, detachSignal });
        }
    }
}
/** A code publication/release receipt must identify the owned canonical session. */
function isOwnedCodeStageStatus(status, session, workspaceId) {
    return typeof session.session_id === "string" && session.session_id.length > 0
        && session.workspace_id === workspaceId && session.mode === "full"
        && typeof session.collection_name === "string" && session.collection_name.length > 0
        && status.session_id === session.session_id && status.workspace_id === session.workspace_id
        && status.mode === session.mode && status.collection_name === session.collection_name
        && (status.coverage?.session_id === undefined || status.coverage.session_id === session.session_id)
        && Array.isArray(status.errors) && status.errors.length === 0
        && (status.failed_batches === undefined || status.failed_batches === 0);
}
function sanitizeManifestErrors(errors) {
    return errors
        .slice(0, MAX_MANIFEST_ERROR_DETAILS)
        .map((error) => String(error).replace(/[\r\n\t]+/g, " ").trim().slice(0, MAX_MANIFEST_ERROR_LENGTH))
        .filter(Boolean);
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
        max_evidence_chars: normalizedRequest.maxEvidenceChars,
        session: toEnhanceSessionPayload(normalizedRequest.session, normalizedRequest.session?.workspaceRoot ?? normalizedRequest.repoPath),
    });
}
/** Server caps for `EnhanceRequest.session` (see corpuswire `EnhanceSessionContext`). */
export const ENHANCE_SESSION_LIMITS = Object.freeze({
    conversationTurns: 20,
    textChars: 8_000,
    pathChars: 1_024,
    recentEdits: 50,
});
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
/**
 * Normalizes a session path to the workspace-relative POSIX form the server
 * accepts. Absolute paths are made relative to `workspaceRoot` when they sit
 * under it. Returns null for anything that cannot be made relative (outside
 * the root, home-relative, escaping with `..`, too long or empty).
 */
export function toWorkspaceRelativeSessionPath(path, workspaceRoot) {
    if (typeof path !== "string") {
        return null;
    }
    const trimmed = path.trim();
    if (!trimmed || trimmed.includes("\0") || trimmed.startsWith("~")) {
        return null;
    }
    const slashed = trimmed.replace(/\\/g, "/");
    let relative;
    if (slashed.startsWith("/") || WINDOWS_DRIVE_PATTERN.test(slashed)) {
        const absolute = normalizeAbsoluteSessionPath(slashed);
        const root = typeof workspaceRoot === "string" && workspaceRoot.trim()
            ? normalizeAbsoluteSessionPath(workspaceRoot.trim().replace(/\\/g, "/"))
            : null;
        if (!absolute || !root) {
            return null;
        }
        const caseInsensitive = WINDOWS_DRIVE_PATTERN.test(root);
        const comparablePath = caseInsensitive ? absolute.toLowerCase() : absolute;
        const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
        const prefix = comparableRoot.endsWith("/") ? comparableRoot : `${comparableRoot}/`;
        if (!comparablePath.startsWith(prefix)) {
            return null;
        }
        relative = absolute.slice(prefix.length);
    }
    else {
        relative = slashed;
    }
    const segments = [];
    for (const segment of relative.split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment === "..") {
            if (segments.length === 0) {
                return null;
            }
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    const normalized = segments.join("/");
    if (!normalized || normalized.length > ENHANCE_SESSION_LIMITS.pathChars || WINDOWS_DRIVE_PATTERN.test(normalized)) {
        return null;
    }
    return normalized;
}
function normalizeAbsoluteSessionPath(path) {
    const driveMatch = WINDOWS_DRIVE_PATTERN.exec(path);
    const head = driveMatch ? driveMatch[0] : "";
    const rest = path.slice(head.length);
    if (driveMatch && !rest.startsWith("/")) {
        return null;
    }
    const segments = [];
    for (const segment of rest.split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment === "..") {
            if (segments.length === 0) {
                return null;
            }
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return `${head}/${segments.join("/")}`;
}
function truncateSessionText(text) {
    const limit = ENHANCE_SESSION_LIMITS.textChars;
    if (text.length <= limit) {
        return text;
    }
    const code = text.charCodeAt(limit - 1);
    const cut = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
    return text.slice(0, cut);
}
function toPositiveLine(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }
    const line = Math.trunc(value);
    return line >= 1 ? line : null;
}
/**
 * Converts caller session state into the capped snake_case wire payload.
 * Returns undefined when nothing usable remains, so `session` is omitted.
 */
export function toEnhanceSessionPayload(session, workspaceRoot) {
    if (!session || typeof session !== "object") {
        return undefined;
    }
    const payload = {};
    if (Array.isArray(session.conversation)) {
        const turns = [];
        for (const turn of session.conversation) {
            if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.text !== "string") {
                continue;
            }
            if (!turn.text.trim()) {
                continue;
            }
            turns.push({ role: turn.role, text: truncateSessionText(turn.text) });
        }
        const kept = turns.slice(-ENHANCE_SESSION_LIMITS.conversationTurns);
        if (kept.length > 0) {
            payload.conversation = kept;
        }
    }
    const activeFile = toWorkspaceRelativeSessionPath(session.activeFile, workspaceRoot);
    if (activeFile) {
        payload.active_file = activeFile;
    }
    if (session.selection && typeof session.selection === "object") {
        const path = toWorkspaceRelativeSessionPath(session.selection.path, workspaceRoot);
        const startLine = toPositiveLine(session.selection.startLine);
        const endLine = toPositiveLine(session.selection.endLine);
        if (path && startLine !== null && endLine !== null) {
            const selection = {
                path,
                start_line: Math.min(startLine, endLine),
                end_line: Math.max(startLine, endLine),
            };
            if (typeof session.selection.text === "string" && session.selection.text.length > 0) {
                selection.text = truncateSessionText(session.selection.text);
            }
            payload.selection = selection;
        }
    }
    if (Array.isArray(session.recentEdits)) {
        const seen = new Set();
        for (const candidate of session.recentEdits) {
            const path = toWorkspaceRelativeSessionPath(candidate, workspaceRoot);
            if (!path || seen.has(path)) {
                continue;
            }
            seen.add(path);
            if (seen.size >= ENHANCE_SESSION_LIMITS.recentEdits) {
                break;
            }
        }
        if (seen.size > 0) {
            payload.recent_edits = [...seen];
        }
    }
    return Object.keys(payload).length > 0 ? payload : undefined;
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
        max_evidence_chars: normalizedRequest.maxEvidenceChars,
    });
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
        evaluation_inventory_attestation: request.evaluationInventoryAttestation,
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
    const phaseElapsedMs = Math.max(0, Date.now() - (options.phaseStartedAt ?? options.startedAt));
    const workCompleted = options.throughputCompleted ?? options.completed;
    const throughput = phaseElapsedMs > 0 && workCompleted > 0
        ? workCompleted / (phaseElapsedMs / 1_000)
        : null;
    const overallPercent = options.overallTotal && options.overallTotal > 0
        ? Math.min(99, (options.overallCompleted / options.overallTotal) * 99)
        : null;
    return {
        schema_version: "index-progress/v1",
        event_origin: "client",
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
        phase_elapsed_ms: phaseElapsedMs,
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
        phase_timings_ms: options.phaseTimings ?? {},
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
async function withRequestBudget(operation, timeoutMs, callerSignal, timeoutError) {
    if (callerSignal?.aborted)
        throw new DOMException("Upload aborted", "AbortError");
    const controller = new AbortController();
    let rejectInterruption;
    const interruption = new Promise((_, reject) => { rejectInterruption = reject; });
    let callerAbortPending = false;
    let callerAbortTimer;
    const interrupt = (error) => {
        rejectInterruption(error);
        controller.abort(error);
    };
    const onAbort = () => {
        const error = new DOMException("Upload aborted", "AbortError");
        callerAbortPending = true;
        controller.abort(error);
        // Drain settled transport promise chains before choosing caller interruption.
        // Only caller abort gets this single-turn grace; the timeout stays absolute.
        callerAbortTimer = setTimeout(() => rejectInterruption(error), 0);
    };
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    // Zero retains the existing one-initial-attempt/no-queue-wait behavior.
    const timer = timeoutMs > 0 ? setTimeout(() => interrupt(timeoutError()), timeoutMs) : undefined;
    try {
        // Abort alone cannot bound injected transports or stalled response bodies.
        const result = await Promise.race([operation(controller.signal), interruption]);
        if (callerAbortPending)
            throw new DOMException("Upload aborted", "AbortError");
        return result;
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        if (callerAbortTimer !== undefined)
            clearTimeout(callerAbortTimer);
        callerSignal?.removeEventListener("abort", onAbort);
        controller.abort();
    }
}
function clampUploadLimit(requested, advertised, name) {
    if (!Number.isFinite(advertised) || advertised < 1
        || (requested !== undefined && (!Number.isFinite(requested) || requested < 1))) {
        throw new Error(`${name} requires a positive finite limit`);
    }
    return Math.floor(Math.min(requested ?? advertised, advertised));
}
/** Keep client phases separate from server processing time and repeated upload tiers. */
function createClientPhaseClock() {
    const timings = {};
    let phase;
    let initialCompleted = 0;
    let startedAt = Date.now();
    const pause = () => {
        if (phase)
            timings[phase] = (timings[phase] ?? 0) + Math.max(0, Date.now() - startedAt);
        phase = undefined;
    };
    return {
        enter(next, completed = 0) {
            if (next !== phase) {
                pause();
                phase = next;
                startedAt = Date.now();
                initialCompleted = completed;
            }
            return startedAt;
        },
        pause,
        workCompleted(completed) { return Math.max(0, completed - initialCompleted); },
        snapshot() {
            return { ...timings, ...(phase ? { [phase]: (timings[phase] ?? 0) + Math.max(0, Date.now() - startedAt) } : {}) };
        },
    };
}
function remainingIndexPollDelay(delay, deadline) {
    return deadline === null ? delay : Math.max(0, Math.min(delay, deadline - Date.now()));
}
/** Preserve server identity; a timestamp identifies each bounded liveness observation. */
function createIndexStatusObserver(pollMs, onProgress) {
    const baseDelay = Math.min(2_000, Math.max(10, pollMs));
    let delay = baseDelay;
    let identity = "";
    let receivedAt = Date.now();
    let baselineProgress;
    let emittedAt = 0;
    return (status) => {
        const progress = status.progress;
        const nextIdentity = JSON.stringify([status.phase, status.queue_depth, status.pending_batches,
            status.active_batches, status.files_indexed, progress?.sequence, progress?.phase, progress?.state, progress?.phase_completed]);
        const now = Date.now();
        if (nextIdentity !== identity) {
            identity = nextIdentity;
            receivedAt = now;
            baselineProgress = progress ?? undefined;
            emittedAt = now;
            delay = baseDelay;
            if (progress)
                onProgress?.({ ...progress, event_origin: progress.event_origin ?? "server" });
        }
        else {
            if (baseDelay > 10)
                delay = Math.min(2_000, Math.ceil(delay * 1.5));
            if (progress && now - emittedAt >= 1_000 && !["completed", "failed", "aborted", "expired"].includes(status.phase)) {
                const occurredAt = new Date(now).toISOString();
                onProgress?.({ ...progress, event_origin: progress.event_origin ?? "server",
                    occurred_at: occurredAt,
                    elapsed_ms: Math.max(progress.elapsed_ms, (baselineProgress?.elapsed_ms ?? progress.elapsed_ms) + now - receivedAt),
                    phase_elapsed_ms: Math.max(progress.phase_elapsed_ms, (baselineProgress?.phase_elapsed_ms ?? progress.phase_elapsed_ms) + now - receivedAt),
                    heartbeat: true, active_heartbeat: true, last_heartbeat_at: occurredAt });
                emittedAt = now;
            }
        }
        return delay;
    };
}
/** Wake polling immediately on either interrupt; the caller owns its semantics. */
async function waitForIndexInterruptDelay(delayMs, request) {
    if (request.signal?.aborted || request.detachSignal?.aborted)
        return;
    await new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            request.signal?.removeEventListener("abort", finish);
            request.detachSignal?.removeEventListener("abort", finish);
            resolve();
        };
        const timer = setTimeout(finish, delayMs);
        request.signal?.addEventListener("abort", finish, { once: true });
        request.detachSignal?.addEventListener("abort", finish, { once: true });
    });
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
