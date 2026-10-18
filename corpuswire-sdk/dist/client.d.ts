import type { EnhancePromptPayload, EnhancePromptRequest, EnhanceResponseEnvelope, CodebaseRepositoriesV1, CodebaseV1, CreateCodebaseRequest, GitHubProviderBindingPayload, GitHubProviderBindingRequest, HealthResponse, IndexActivityQuery, IndexActivitySummary, IndexEvent, IndexEventQuery, IndexSessionQuery, IndexWorkspaceRequest, IndexTransferSummary, CorpusWireClientOptions, LlmModelState, PromptEnhancementResult, PromptRewriteResult, QueryPromptPayload, QueryPromptRequest, QueryResponseEnvelope, QualityEvent, QualityEventPayload, QualityEventRequest, QualityEventsQuery, QualityReview, QualityReviewQuery, QueryValueEvent, ProviderBindingResponseV1, ProviderBindingRevocationV1, ValueFeedbackRequest, ValueRollup, ValueRollupQuery, RemoteFileBatchMetadata, RemoteFileBatchResult, RemoteFileContent, RemoteIndexCapabilities, RemoteIndexCommitResponse, RemoteIndexCodeStageResult, RemoteIndexProgressEvent, RemoteIndexPreview, RemoteIndexSession, RemoteIndexWorkspaceLease, WorkspaceLeaseOptions, WorkspaceLeaseRequest, RemoteIndexStatus, RemoteManifestBatchResult, RemoteManifestEntry, ReviewContextCapabilitiesV1, ReviewContextJobV1, ReviewContextPollOptions, ReviewContextRequest, ReviewContextRequestV1, ReviewContextResult, ReviewContextCapabilitiesV2, ReviewContextJobV2, ReviewContextPollOptionsV2, ReviewContextRequestV2Input, ReviewContextRequestV2, ReviewContextResultV2, ReviewTelemetrySummaryV1, ReviewPurgeV1, ReviewStatusV1, ReviewStatusV2, SearchHit, StartRemoteIndexSessionRequest, WorkspaceDiagnosis, WorkspaceDiagnosisRequest, UpdateCodebaseRequest } from "./types.js";
export type RemoteIndexOwnedSessionIdentity = Pick<RemoteIndexSession, "session_id" | "workspace_id" | "collection_name" | "mode">;
export declare class RemoteIndexInterruptionError extends Error {
    readonly reason: "cancel" | "detach" | "timeout";
    readonly sessionIdentity: RemoteIndexOwnedSessionIdentity;
    readonly status: RemoteIndexStatus | undefined;
    readonly transfer: IndexTransferSummary;
    readonly abortRequested: boolean;
    readonly releaseConfirmed: boolean;
    readonly interruptionOnly: boolean;
    readonly sessionId: string;
    constructor(message: string, reason: "cancel" | "detach" | "timeout", sessionIdentity: RemoteIndexOwnedSessionIdentity, status: RemoteIndexStatus | undefined, transfer: IndexTransferSummary, abortRequested: boolean, releaseConfirmed: boolean, interruptionOnly: boolean, cause: unknown);
}
export declare class RemoteIndexDetachedError extends Error {
    readonly transfer?: IndexTransferSummary;
    readonly sessionId: string;
    readonly status: RemoteIndexStatus;
    readonly backendContinues = true;
    constructor(sessionId: string, status: RemoteIndexStatus, reason: string);
}
/**
 * The workspace writer lease was lost while a session was running (CRP-001
 * L1.1). The session was aborted; callers requeue the paths and retry later.
 */
export declare class RemoteIndexLeaseLostError extends Error {
    readonly code = "lease_lost";
    readonly requeue = true;
    readonly transfer?: IndexTransferSummary;
    readonly sessionId: string | null;
    constructor(message: string, options?: {
        cause?: unknown;
        sessionId?: string | null;
        transfer?: IndexTransferSummary;
    });
}
/** True for a 409 that means another writer holds the workspace lease. */
export declare function isWorkspaceLeaseHeldError(error: unknown): boolean;
/** True when a lease was lost: a refused renewal, a refused fenced commit, or a local expiry. */
export declare function isWorkspaceLeaseLostError(error: unknown): boolean;
/** Build a holder id that satisfies the server pattern `[A-Za-z0-9._:@-]{8,128}`. */
export declare function createLeaseHolderId(prefix: string): string;
export declare class RemoteIndexCancelledError extends Error {
    readonly transfer?: IndexTransferSummary;
    readonly sessionId: string;
    readonly status: RemoteIndexStatus;
    constructor(sessionId: string, status: RemoteIndexStatus);
}
export declare class ReviewContextPollingTimeoutError extends Error {
    readonly jobId: string;
    readonly timeoutMs: number;
    constructor(jobId: string, timeoutMs: number);
}
export declare class ReviewContextPollingCancelledError extends Error {
    readonly jobId: string;
    constructor(jobId: string);
}
export declare class CorpusWireClient {
    readonly baseUrl: string;
    readonly basicAuth: string;
    readonly bearerToken: string;
    readonly endpointMode: "compat" | "v1-only";
    readonly fetchFn: CorpusWireClientOptions["fetchFn"];
    readonly defaultHeaders: Record<string, string>;
    constructor(options?: CorpusWireClientOptions);
    health(request?: {
        repoPath?: string;
        workspaceId?: string;
    }): Promise<HealthResponse>;
    diagnoseWorkspace(request?: WorkspaceDiagnosisRequest, options?: {
        signal?: AbortSignal;
    }): Promise<WorkspaceDiagnosis>;
    enhance(request: string | EnhancePromptRequest): Promise<PromptRewriteResult>;
    enhanceRaw(request: string | EnhancePromptRequest): Promise<EnhanceResponseEnvelope>;
    query(request: string | QueryPromptRequest): Promise<PromptEnhancementResult>;
    queryRaw(request: string | QueryPromptRequest): Promise<QueryResponseEnvelope>;
    semanticSearch(request: string | Omit<QueryPromptRequest, "includeAnswer">): Promise<SearchHit[]>;
    recordQualityEvent(request: QualityEventRequest): Promise<QualityEvent>;
    listQualityEvents(request?: QualityEventsQuery): Promise<QualityEvent[]>;
    reviewQuality(request?: QualityReviewQuery): Promise<QualityReview>;
    confirmQueryValue(request: ValueFeedbackRequest): Promise<QueryValueEvent>;
    valueRollup(request?: ValueRollupQuery): Promise<ValueRollup>;
    createCodebase(request: CreateCodebaseRequest): Promise<CodebaseV1>;
    listCodebases(): Promise<CodebaseV1[]>;
    getCodebase(codebaseId: string): Promise<CodebaseV1>;
    updateCodebase(codebaseId: string, request: UpdateCodebaseRequest): Promise<CodebaseV1>;
    deleteCodebase(codebaseId: string): Promise<CodebaseV1>;
    listCodebaseRepositories(codebaseId: string): Promise<CodebaseRepositoriesV1>;
    /** Create or update a GitHub binding while preserving allowlist tri-state values. */
    bindGitHubProvider(codebaseId: string, request: GitHubProviderBindingRequest): Promise<ProviderBindingResponseV1>;
    revokeGitHubProvider(codebaseId: string, installationId: string, providerHost?: string): Promise<ProviderBindingRevocationV1>;
    getReviewContextCapabilities(): Promise<ReviewContextCapabilitiesV1>;
    getReviewTelemetrySummary(): Promise<ReviewTelemetrySummaryV1>;
    requestReviewContext(request: ReviewContextRequest): Promise<ReviewContextResult>;
    getReviewContextJob(jobId: string): Promise<ReviewContextResult>;
    cancelReviewContextJob(jobId: string): Promise<ReviewContextJobV1>;
    pollReviewContextJob(jobOrId: ReviewContextJobV1 | string, options?: ReviewContextPollOptions): Promise<ReviewContextResult>;
    requestReviewContextAndWait(request: ReviewContextRequest, options?: ReviewContextPollOptions): Promise<ReviewContextResult>;
    getReviewStatus(codebaseId: string, reviewId: string): Promise<ReviewStatusV1>;
    /** Read the isolated deterministic symbol-change v2 capability envelope. */
    getReviewContextCapabilitiesV2(): Promise<ReviewContextCapabilitiesV2>;
    /** Request deterministic before/after symbol evidence through the v2-only route. */
    requestReviewContextV2(request: ReviewContextRequestV2Input): Promise<ReviewContextResultV2>;
    getReviewContextJobV2(jobId: string): Promise<ReviewContextResultV2>;
    cancelReviewContextJobV2(jobId: string): Promise<ReviewContextJobV2>;
    pollReviewContextJobV2(jobOrId: ReviewContextJobV2 | string, options?: ReviewContextPollOptionsV2): Promise<ReviewContextResultV2>;
    requestReviewContextV2AndWait(request: ReviewContextRequestV2Input, options?: ReviewContextPollOptionsV2): Promise<ReviewContextResultV2>;
    getReviewStatusV2(codebaseId: string, reviewId: string): Promise<ReviewStatusV2>;
    purgeReviewOverlay(codebaseId: string, reviewId: string): Promise<ReviewPurgeV1>;
    getLlmModel(): Promise<LlmModelState>;
    setLlmModel(model: string): Promise<LlmModelState>;
    getIndexCapabilities(): Promise<RemoteIndexCapabilities>;
    getIndexEvents(request?: IndexEventQuery): Promise<IndexEvent[]>;
    getIndexActivity(request?: IndexActivityQuery): Promise<IndexActivitySummary>;
    listIndexSessions(request?: IndexSessionQuery): Promise<RemoteIndexStatus[]>;
    startIndexSession(request: StartRemoteIndexSessionRequest): Promise<RemoteIndexSession>;
    /** Acquire (no leaseId) or renew (with leaseId) the workspace writer lease. */
    acquireWorkspaceLease(request: WorkspaceLeaseRequest): Promise<RemoteIndexWorkspaceLease>;
    /** Release a lease this holder owns; a lost lease releases nothing. */
    releaseWorkspaceLease(request: WorkspaceLeaseRequest): Promise<{
        workspace_id: string;
        released: boolean;
    }>;
    /**
     * CRP-001 L1.1: run {@link indexWorkspace} while holding the workspace
     * writer lease. The lease is acquired before `POST /sessions` and renewed
     * on a timer while the session runs; expiry is tracked on a local monotonic
     * clock from the server's relative TTL, so wall-clock skew cannot matter.
     * A 409 on acquisition (another writer) is thrown unchanged for the caller's
     * backoff. If the lease is lost mid-session the session is aborted and a
     * {@link RemoteIndexLeaseLostError} is thrown so the caller can requeue.
     */
    indexWorkspaceWithLease(request: IndexWorkspaceRequest, options: WorkspaceLeaseOptions): Promise<RemoteIndexCommitResponse>;
    previewIndexWorkspace(request: IndexWorkspaceRequest): Promise<RemoteIndexPreview>;
    sendManifestBatch(sessionId: string, entries: RemoteManifestEntry[]): Promise<RemoteManifestBatchResult>;
    uploadFileBatch(sessionId: string, metadata: RemoteFileBatchMetadata, files: RemoteFileContent[], onAttempt?: () => void, options?: {
        signal?: AbortSignal;
        queueWaitTimeoutMs?: number;
        onQueueRetry?: () => void;
        onQueueFull?: () => void;
        onTransportRetry?: () => void;
        onQueueWait?: (elapsedMs: number) => void;
        onQueueHeartbeat?: (elapsedMs: number, heartbeat: boolean) => void;
    }): Promise<RemoteFileBatchResult>;
    checkpointIndexSessionCode(sessionId: string, options?: {
        signal?: AbortSignal;
        deadline?: number;
    }): Promise<RemoteIndexStatus>;
    commitIndexSession(sessionId: string): Promise<RemoteIndexCommitResponse>;
    getIndexSessionStatus(sessionId: string, options?: {
        signal?: AbortSignal;
    }): Promise<RemoteIndexStatus>;
    followIndexSession(sessionId: string, options?: {
        timeoutMs?: number;
        pollMs?: number;
        signal?: AbortSignal;
        detachSignal?: AbortSignal;
        onProgress?: (event: RemoteIndexProgressEvent) => void;
    }): Promise<RemoteIndexStatus>;
    abortIndexSession(sessionId: string, options?: {
        signal?: AbortSignal;
    }): Promise<{
        ok: true;
        session_id: string;
        phase: string;
    }>;
    private releaseCodeStageSession;
    private abortIndexSessionByDeadline;
    private waitForIndexSessionProcessing;
    indexWorkspace(request: IndexWorkspaceRequest): Promise<RemoteIndexCommitResponse>;
    /**
     * Publish code from a complete scan and release the drained owned session.
     * Checkpoint and release share the processing budget, or 5 seconds when unspecified.
     * Interruption allows up to 1 extra second for best-effort abort confirmation.
     */
    indexWorkspaceCodeStage(request: IndexWorkspaceRequest): Promise<RemoteIndexCodeStageResult>;
    private runIndexWorkspace;
    private waitForIndexSessionTerminal;
}
export declare function toQualityEventPayload(request: QualityEventRequest): QualityEventPayload;
export declare function toEnhancePayload(request: string | EnhancePromptRequest): EnhancePromptPayload;
export declare function toQueryPayload(request: string | QueryPromptRequest): QueryPromptPayload;
export declare function toGitHubProviderBindingPayload(request: GitHubProviderBindingRequest): GitHubProviderBindingPayload;
export declare function toReviewContextPayload(request: ReviewContextRequest): ReviewContextRequestV1;
export declare function isReviewContextJob(result: ReviewContextResult): result is ReviewContextJobV1;
export declare function toReviewContextPayloadV2(request: ReviewContextRequestV2Input): ReviewContextRequestV2;
export declare function isReviewContextJobV2(result: ReviewContextResultV2): result is ReviewContextJobV2;
export declare function toStartIndexSessionPayload(request: StartRemoteIndexSessionRequest): Record<string, unknown>;
export declare function manifestEntriesToJsonl(entries: RemoteManifestEntry[]): string;
/** Fail closed on every current-v2 response/job field and semantic correlation. */
export declare function assertReviewContextV2Result(value: unknown): asserts value is ReviewContextResultV2;
export declare function resolveEnhancedPrompt(result: PromptRewriteResult): string | null;
export declare function requireEnhancedPrompt(result: PromptRewriteResult): string;
