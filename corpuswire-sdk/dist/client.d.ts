import type { EnhancePromptPayload, EnhancePromptRequest, EnhanceResponseEnvelope, CodebaseRepositoriesV1, CodebaseV1, CreateCodebaseRequest, GitHubProviderBindingPayload, GitHubProviderBindingRequest, HealthResponse, IndexActivityQuery, IndexActivitySummary, IndexEvent, IndexEventQuery, IndexSessionQuery, IndexWorkspaceRequest, IndexTransferSummary, CorpusWireClientOptions, LlmModelState, PromptEnhancementResult, PromptRewriteResult, QueryPromptPayload, QueryPromptRequest, QueryResponseEnvelope, QualityEvent, QualityEventPayload, QualityEventRequest, QualityEventsQuery, QualityReview, QualityReviewQuery, QueryValueEvent, ProviderBindingResponseV1, ProviderBindingRevocationV1, ValueFeedbackRequest, ValueRollup, ValueRollupQuery, RemoteFileBatchMetadata, RemoteFileBatchResult, RemoteFileContent, RemoteIndexCapabilities, RemoteIndexCommitResponse, RemoteIndexProgressEvent, RemoteIndexPreview, RemoteIndexSession, RemoteIndexStatus, RemoteManifestBatchResult, RemoteManifestEntry, ReviewContextCapabilitiesV1, ReviewContextJobV1, ReviewContextPollOptions, ReviewContextRequest, ReviewContextRequestV1, ReviewContextResult, ReviewContextCapabilitiesV2, ReviewContextJobV2, ReviewContextPollOptionsV2, ReviewContextRequestV2Input, ReviewContextRequestV2, ReviewContextResultV2, ReviewTelemetrySummaryV1, ReviewPurgeV1, ReviewStatusV1, ReviewStatusV2, SearchHit, StartRemoteIndexSessionRequest, WorkspaceDiagnosis, WorkspaceDiagnosisRequest, UpdateCodebaseRequest } from "./types.js";
export declare class RemoteIndexDetachedError extends Error {
    readonly transfer?: IndexTransferSummary;
    readonly sessionId: string;
    readonly status: RemoteIndexStatus;
    readonly backendContinues = true;
    constructor(sessionId: string, status: RemoteIndexStatus, reason: string);
}
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
    diagnoseWorkspace(request?: WorkspaceDiagnosisRequest): Promise<WorkspaceDiagnosis>;
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
    previewIndexWorkspace(request: IndexWorkspaceRequest): Promise<RemoteIndexPreview>;
    sendManifestBatch(sessionId: string, entries: RemoteManifestEntry[]): Promise<RemoteManifestBatchResult>;
    uploadFileBatch(sessionId: string, metadata: RemoteFileBatchMetadata, files: RemoteFileContent[], onAttempt?: () => void): Promise<RemoteFileBatchResult>;
    commitIndexSession(sessionId: string): Promise<RemoteIndexCommitResponse>;
    getIndexSessionStatus(sessionId: string): Promise<RemoteIndexStatus>;
    followIndexSession(sessionId: string, options?: {
        timeoutMs?: number;
        pollMs?: number;
        signal?: AbortSignal;
        detachSignal?: AbortSignal;
        onProgress?: (event: RemoteIndexProgressEvent) => void;
    }): Promise<RemoteIndexStatus>;
    abortIndexSession(sessionId: string): Promise<{
        ok: true;
        session_id: string;
        phase: string;
    }>;
    private abortIndexSessionQuietly;
    private waitForIndexSessionProcessing;
    indexWorkspace(request: IndexWorkspaceRequest): Promise<RemoteIndexCommitResponse>;
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
