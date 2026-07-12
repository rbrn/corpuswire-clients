import { createBearerAuthHeader, requestJson } from "./http.js";
const RUNTIME_ENV = globalThis.process?.env ?? {};
const DEFAULT_BASE_URL = RUNTIME_ENV.CORPUSWIRE_BASE_URL ?? "http://127.0.0.1:8000";
const DEFAULT_BASIC_AUTH = RUNTIME_ENV.CORPUSWIRE_BASIC_AUTH ?? "";
const DEFAULT_BEARER_TOKEN = RUNTIME_ENV.CORPUSWIRE_BEARER_TOKEN ?? "";
const DEFAULT_OUTPUT_MODE = "generic";
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
    async waitForIndexSessionProcessing(sessionId, timeoutMs, pollMs) {
        const deadline = Date.now() + Math.max(1, timeoutMs);
        for (;;) {
            const status = await this.getIndexSessionStatus(sessionId);
            if (["failed", "incomplete", "aborted", "expired"].includes(status.phase)) {
                throw new Error(`Remote index session ${sessionId} entered ${status.phase}: ${status.errors.join("; ") || "unknown error"}`);
            }
            const pendingBatches = status.pending_batches ?? 0;
            const activeBatches = status.active_batches ?? 0;
            if (pendingBatches === 0 && activeBatches === 0 && status.queue_depth === 0) {
                return status;
            }
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for remote index session ${sessionId}: ` +
                    `phase=${status.phase}; queue_depth=${status.queue_depth}; ` +
                    `pending_batches=${pendingBatches}; active_batches=${activeBatches}`);
            }
            await new Promise((resolve) => setTimeout(resolve, Math.max(10, pollMs)));
        }
    }
    async indexWorkspace(request) {
        const remoteFiles = await Promise.all(request.files.map(prepareRemoteWorkspaceFile));
        const session = await this.startIndexSession(request);
        try {
            const manifestEntries = [
                ...remoteFiles.map(({ file, content, sha256, mtimeNs }) => ({
                    relativePath: file.relativePath,
                    op: "upsert",
                    size: content.byteLength,
                    mtimeNs,
                    sha256,
                })),
                ...(request.deletedPaths ?? []).map((relativePath) => ({
                    relativePath,
                    op: "delete",
                })),
            ];
            const manifestResult = await this.sendManifestBatch(session.session_id, manifestEntries);
            const uploadRequired = new Set(manifestResult.upload_required);
            const filesToUpload = remoteFiles.filter(({ file }) => uploadRequired.has(file.relativePath));
            let queuedBackgroundWork = false;
            if (filesToUpload.length > 0) {
                const uploadBatches = buildUploadBatches(filesToUpload, request.batchBytes ?? session.max_batch_bytes, session.max_batch_files);
                await runWithConcurrency(uploadBatches, request.maxConcurrentUploads ?? session.max_concurrent_uploads, async (batchFiles) => {
                    const result = await this.uploadFileBatch(session.session_id, { files: batchFiles.map((file) => file.descriptor) }, batchFiles);
                    queuedBackgroundWork ||= result.queued === true;
                });
            }
            if (queuedBackgroundWork) {
                await this.waitForIndexSessionProcessing(session.session_id, request.processingTimeoutMs ?? 15 * 60 * 1000, request.processingPollMs ?? 250);
            }
            return await this.commitIndexSession(session.session_id);
        }
        catch (error) {
            await this.abortIndexSessionQuietly(session.session_id);
            throw error;
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
