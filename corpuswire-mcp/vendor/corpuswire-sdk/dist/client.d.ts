import type { EnhancePromptPayload, EnhancePromptRequest, EnhanceSessionContext, EnhanceSessionContextPayload, EnhanceResponseEnvelope, CodebaseRepositoriesV1, CodebaseV1, CreateCodebaseRequest, HealthResponse, IndexActivityQuery, IndexActivitySummary, IndexEvent, IndexEventQuery, IndexSessionQuery, IndexWorkspaceRequest, IndexTransferSummary, CorpusWireClientOptions, LlmModelState, PromptEnhancementResult, PromptRewriteResult, QueryPromptPayload, QueryPromptRequest, QueryResponseEnvelope, QualityEvent, QualityEventPayload, QualityEventRequest, QualityEventsQuery, QualityReview, QualityReviewQuery, QueryValueEvent, ValueFeedbackRequest, ValueRollup, ValueRollupQuery, RemoteFileBatchMetadata, RemoteFileBatchResult, RemoteFileContent, RemoteIndexCapabilities, RemoteIndexCommitResponse, RemoteIndexCodeStageResult, RemoteIndexProgressEvent, RemoteIndexPreview, RemoteIndexSession, RemoteIndexStatus, RemoteManifestBatchResult, RemoteManifestEntry, SearchHit, StartRemoteIndexSessionRequest, WorkspaceDiagnosis, WorkspaceDiagnosisRequest, UpdateCodebaseRequest } from "./types.js";
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
export declare class RemoteIndexCancelledError extends Error {
    readonly transfer?: IndexTransferSummary;
    readonly sessionId: string;
    readonly status: RemoteIndexStatus;
    constructor(sessionId: string, status: RemoteIndexStatus);
}
export interface EnsuredWorkspace {
    mode: "anonymous-local" | "wildcard-token" | "member";
    created: boolean;
    workspaceId: string;
    tenantId: string;
}
export interface SelfOnboardingRequest {
    tenantId: string;
    tenantDisplayName: string;
    ownerDisplayName: string;
    workspaceId: string;
    workspaceDisplayName?: string;
    credentialName: string;
    scopes?: string[];
}
export interface SelfOnboardingResult {
    tenantId: string;
    token: string;
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
    /** Idempotently register a workspace in the caller's tenant with the caller as owner. */
    ensureWorkspace(request: {
        workspaceId: string;
        displayName?: string;
    }): Promise<EnsuredWorkspace>;
    /** Create a tenant, its owner, a first workspace and a tenant-wide credential (shown once). */
    selfOnboard(request: SelfOnboardingRequest): Promise<SelfOnboardingResult>;
    createCodebase(request: CreateCodebaseRequest): Promise<CodebaseV1>;
    listCodebases(): Promise<CodebaseV1[]>;
    getCodebase(codebaseId: string): Promise<CodebaseV1>;
    updateCodebase(codebaseId: string, request: UpdateCodebaseRequest): Promise<CodebaseV1>;
    deleteCodebase(codebaseId: string): Promise<CodebaseV1>;
    listCodebaseRepositories(codebaseId: string): Promise<CodebaseRepositoriesV1>;
    getLlmModel(): Promise<LlmModelState>;
    setLlmModel(model: string): Promise<LlmModelState>;
    getIndexCapabilities(): Promise<RemoteIndexCapabilities>;
    getIndexEvents(request?: IndexEventQuery): Promise<IndexEvent[]>;
    getIndexActivity(request?: IndexActivityQuery): Promise<IndexActivitySummary>;
    listIndexSessions(request?: IndexSessionQuery, options?: {
        signal?: AbortSignal;
    }): Promise<RemoteIndexStatus[]>;
    startIndexSession(request: StartRemoteIndexSessionRequest): Promise<RemoteIndexSession>;
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
/** Server caps for `EnhanceRequest.session` (see corpuswire `EnhanceSessionContext`). */
export declare const ENHANCE_SESSION_LIMITS: Readonly<{
    conversationTurns: 20;
    textChars: 8000;
    pathChars: 1024;
    recentEdits: 50;
}>;
/**
 * Normalizes a session path to the workspace-relative POSIX form the server
 * accepts. Absolute paths are made relative to `workspaceRoot` when they sit
 * under it. Returns null for anything that cannot be made relative (outside
 * the root, home-relative, escaping with `..`, too long or empty).
 */
export declare function toWorkspaceRelativeSessionPath(path: unknown, workspaceRoot?: string | null): string | null;
/**
 * Converts caller session state into the capped snake_case wire payload.
 * Returns undefined when nothing usable remains, so `session` is omitted.
 */
export declare function toEnhanceSessionPayload(session: EnhanceSessionContext | null | undefined, workspaceRoot?: string | null): EnhanceSessionContextPayload | undefined;
export declare function toQueryPayload(request: string | QueryPromptRequest): QueryPromptPayload;
export declare function toStartIndexSessionPayload(request: StartRemoteIndexSessionRequest): Record<string, unknown>;
export declare function manifestEntriesToJsonl(entries: RemoteManifestEntry[]): string;
export declare function resolveEnhancedPrompt(result: PromptRewriteResult): string | null;
export declare function requireEnhancedPrompt(result: PromptRewriteResult): string;
