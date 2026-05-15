import type { EnhancePromptPayload, EnhancePromptRequest, EnhanceResponseEnvelope, HealthResponse, IndexActivityQuery, IndexActivitySummary, IndexEvent, IndexEventQuery, IndexWorkspaceRequest, CorpusWireClientOptions, PromptEnhancementResult, PromptRewriteResult, QueryPromptPayload, QueryPromptRequest, QueryResponseEnvelope, RemoteFileBatchMetadata, RemoteFileBatchResult, RemoteFileContent, RemoteIndexCapabilities, RemoteIndexCommitResponse, RemoteIndexSession, RemoteIndexStatus, RemoteManifestBatchResult, RemoteManifestEntry, SearchHit, StartRemoteIndexSessionRequest } from "./types.js";
export declare class CorpusWireClient {
    readonly baseUrl: string;
    readonly basicAuth: string;
    readonly endpointMode: "compat" | "v1-only";
    readonly fetchFn: CorpusWireClientOptions["fetchFn"];
    readonly defaultHeaders: Record<string, string>;
    constructor(options?: CorpusWireClientOptions);
    health(request?: {
        repoPath?: string;
        workspaceId?: string;
    }): Promise<HealthResponse>;
    enhance(request: string | EnhancePromptRequest): Promise<PromptRewriteResult>;
    enhanceRaw(request: string | EnhancePromptRequest): Promise<EnhanceResponseEnvelope>;
    query(request: string | QueryPromptRequest): Promise<PromptEnhancementResult>;
    queryRaw(request: string | QueryPromptRequest): Promise<QueryResponseEnvelope>;
    semanticSearch(request: string | Omit<QueryPromptRequest, "includeAnswer">): Promise<SearchHit[]>;
    getIndexCapabilities(): Promise<RemoteIndexCapabilities>;
    getIndexEvents(request?: IndexEventQuery): Promise<IndexEvent[]>;
    getIndexActivity(request?: IndexActivityQuery): Promise<IndexActivitySummary>;
    startIndexSession(request: StartRemoteIndexSessionRequest): Promise<RemoteIndexSession>;
    sendManifestBatch(sessionId: string, entries: RemoteManifestEntry[]): Promise<RemoteManifestBatchResult>;
    uploadFileBatch(sessionId: string, metadata: RemoteFileBatchMetadata, files: RemoteFileContent[]): Promise<RemoteFileBatchResult>;
    commitIndexSession(sessionId: string): Promise<RemoteIndexCommitResponse>;
    getIndexSessionStatus(sessionId: string): Promise<RemoteIndexStatus>;
    abortIndexSession(sessionId: string): Promise<{
        ok: true;
        session_id: string;
        phase: string;
    }>;
    indexWorkspace(request: IndexWorkspaceRequest): Promise<RemoteIndexCommitResponse>;
}
export declare function toEnhancePayload(request: string | EnhancePromptRequest): EnhancePromptPayload;
export declare function toQueryPayload(request: string | QueryPromptRequest): QueryPromptPayload;
export declare function toStartIndexSessionPayload(request: StartRemoteIndexSessionRequest): Record<string, unknown>;
export declare function manifestEntriesToJsonl(entries: RemoteManifestEntry[]): string;
export declare function resolveEnhancedPrompt(result: PromptRewriteResult): string | null;
export declare function requireEnhancedPrompt(result: PromptRewriteResult): string;
