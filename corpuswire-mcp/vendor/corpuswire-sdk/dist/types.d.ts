export declare const promptOutputModes: readonly ["generic", "copilot", "claude-code", "sequential"];
export type PromptOutputMode = (typeof promptOutputModes)[number];
export declare const promptTaskTypes: readonly ["general", "bug_fix", "refactor", "documentation", "testing", "feature", "review", "explanation", "performance"];
export type PromptTaskType = (typeof promptTaskTypes)[number];
export declare const promptTaskTypeSources: readonly ["heuristic", "llm", "heuristic_fallback"];
export type PromptTaskTypeSource = (typeof promptTaskTypeSources)[number];
export declare const documentTypes: readonly ["markdown", "text", "data", "pdf", "code", "config"];
export type DocumentType = (typeof documentTypes)[number];
export interface ChunkMetadata {
    source_path: string;
    title: string;
    section_heading: string | null;
    chunk_index: number;
    updated_at: string;
    doc_type: DocumentType;
    start_word: number;
    end_word: number;
    tags: string[];
    start_line?: number | null;
    end_line?: number | null;
    path_segments?: string[];
    source_name?: string | null;
    source_stem?: string | null;
    package_name?: string | null;
    symbol_kind?: string | null;
    content_category?: string | null;
    search_aliases?: string[];
    indexed_at?: string | null;
    indexed_commit?: string | null;
    source_generation?: number | null;
}
export interface SearchHit {
    chunk_id: string;
    score: number;
    text: string;
    metadata: ChunkMetadata;
}
export type AgentContextRole = "implementation" | "test" | "configuration" | "documentation" | "data" | "deployment" | "integration" | "unknown";
export interface AgentContextPacket {
    source_path: string;
    role: AgentContextRole;
    inspection_order: number;
    score: number;
    reasons: string[];
    symbols: string[];
    line_ranges: string[];
    chunk_ids: string[];
    doc_type: DocumentType;
    package_name?: string | null;
    tags: string[];
}
export interface PromptRewriteResult {
    user_prompt: string;
    retrieval_query: string;
    retrieval_backend: string | null;
    retrieval_warning: string | null;
    retrieved_chunks: SearchHit[];
    agent_context_packets?: AgentContextPacket[];
    task_type: PromptTaskType;
    task_type_source: PromptTaskTypeSource;
    task_type_classification_error: string | null;
    output_mode: PromptOutputMode;
    context_summary: string | null;
    summary_generation_error: string | null;
    enhancement_prompt: string;
    citations: string[];
    enhanced_prompt: string | null;
    enhancement_backend: string | null;
    generation_error: string | null;
}
export interface PromptEnhancementResult {
    user_prompt: string;
    retrieval_query: string;
    retrieval_backend: string | null;
    retrieval_warning: string | null;
    retrieved_chunks: SearchHit[];
    agent_context_packets?: AgentContextPacket[];
    augmented_prompt: string;
    citations: string[];
    answer: string | null;
    generation_error: string | null;
}
export interface QueryResponseContext {
    repo_path?: string | null;
    workspace_id?: string | null;
    collection: string;
    index?: IndexHealth;
}
export interface QueryResponseEnvelope {
    ok: boolean;
    result: PromptEnhancementResult;
    context?: QueryResponseContext;
}
export interface ApiErrorPayload {
    code: string;
    message: string;
    detail?: unknown;
}
export interface EnhanceResponseEnvelope {
    ok: boolean;
    request_id: string;
    duration_ms: number;
    result: PromptRewriteResult;
}
export interface EnhanceErrorEnvelope {
    ok: false;
    request_id: string;
    duration_ms: number;
    error: ApiErrorPayload;
}
export interface RuntimeSummary {
    embedding_provider_preference: string;
    generation_provider_preference: string;
    openai_compat_profile: string;
    openai_base_url: string | null;
    basic_auth_enabled: boolean;
    basic_auth_uses_fallback: boolean;
    embedding_order: string[];
    generation_order: string[];
    ollama_base_url: string | null;
    corpuswire_enabled: boolean;
}
export interface CorpusWireHealth {
    enabled: boolean;
    reachable: boolean;
    base_url: string | null;
    probe_path?: string | null;
    error?: string | null;
}
export interface QdrantHealth {
    collection: string;
    collection_exists?: boolean;
    point_count?: number;
    indexed?: boolean;
    indexed_at?: string | null;
    indexed_commit?: string | null;
    manifest_revision?: number | null;
    index_age_seconds?: number | null;
    source_file_count?: number | null;
    latest_source_modified_at?: string | null;
    latest_source_age_seconds?: number | null;
    payload_summary_error?: string | null;
    error?: string | null;
}
export interface IndexHealth {
    workspace_id?: string | null;
    path: string;
    collection: string;
    indexed: boolean;
    health_status?: string | null;
    health_warnings?: string[];
    indexed_at?: string | null;
    indexed_commit?: string | null;
    manifest_revision?: number | null;
    age_seconds?: number | null;
    source_files?: number | null;
    source_file_count?: number | null;
    latest_source_modified_at?: string | null;
    latest_source_age_seconds?: number | null;
    payload_points_seen?: number | null;
    payload_scan_complete?: boolean | null;
    latest_source_generation?: number | null;
    activity?: IndexActivitySummary | null;
}
export interface ActiveProjectHealth {
    path: string;
    collection: string;
    workspace_id?: string | null;
    indexed?: boolean;
    health_status?: string | null;
    health_warnings?: string[];
    indexed_at?: string | null;
    indexed_commit?: string | null;
    manifest_revision?: number | null;
    index_age_seconds?: number | null;
    source_file_count?: number | null;
    latest_source_modified_at?: string | null;
    latest_source_age_seconds?: number | null;
}
export interface LlmSessionHealth {
    backend: string;
    model?: string | null;
    session_provider?: string | null;
    session_state: string;
    session_active: boolean;
    healthy: boolean;
    display_name?: string | null;
    account_label?: string | null;
    expires_at?: string | null;
    generation_provider_preference?: string;
    generation_order?: string[];
}
export interface LlmProviderState {
    ok: boolean;
    provider: string;
    configured_provider: string;
    overridden: boolean;
    providers: string[];
}
export interface LlmModelState {
    ok: boolean;
    model: string;
    configured_model: string;
    overridden: boolean;
}
export interface AuthSummary {
    available: boolean;
    providers: unknown[];
    error?: string | null;
}
export interface HealthResponse {
    ok: boolean;
    build?: BuildInfo;
    docs_source_dir: string;
    runtime: RuntimeSummary;
    ollama: Record<string, unknown>;
    corpuswire: CorpusWireHealth;
    qdrant: QdrantHealth;
    index?: IndexHealth;
    index_activity?: IndexActivitySummary | null;
    llm?: LlmSessionHealth;
    llm_provider?: LlmProviderState;
    active_project?: ActiveProjectHealth;
    auth: AuthSummary;
    ui: string;
}
export type WorkspaceDiagnosisStatus = "ready" | "degraded" | "blocked";
export type WorkspaceDiagnosisCheckStatus = "ok" | "warning" | "error";
export type WorkspaceDiagnosisResolutionMode = "local" | "remote";
export interface WorkspaceDiagnosisCheck {
    name: string;
    status: WorkspaceDiagnosisCheckStatus;
    message: string;
}
export interface WorkspaceDiagnosis {
    status: WorkspaceDiagnosisStatus;
    can_retrieve: boolean;
    requested_repo_path?: string | null;
    requested_workspace_id?: string | null;
    resolved_context: string;
    resolved_workspace_id?: string | null;
    resolution_mode: WorkspaceDiagnosisResolutionMode;
    collection: string;
    collection_exists?: boolean | null;
    point_count?: number | null;
    qdrant_error?: string | null;
    index: IndexHealth;
    active_backend: {
        default_repo_path?: string;
        default_collection?: string;
        requested_context?: string;
        matches_requested_context?: boolean;
        [key: string]: unknown;
    };
    checks: WorkspaceDiagnosisCheck[];
    recovery_actions: string[];
}
export interface WorkspaceDiagnosisEnvelope {
    ok: boolean;
    diagnosis: WorkspaceDiagnosis;
}
export interface WorkspaceDiagnosisRequest {
    repoPath?: string;
    workspaceId?: string;
}
export interface BuildInfo {
    app_version: string;
    package_version: string;
    module_version: string;
    git_commit?: string | null;
    git_branch?: string | null;
    render_commit?: string | null;
    render_branch?: string | null;
    render_service?: string | null;
    started_at: string;
}
export interface EnhancePromptRequest {
    repoPath?: string;
    workspaceId?: string;
    prompt: string;
    topK?: number;
    minScore?: number;
    outputMode?: PromptOutputMode;
    localOnly?: boolean;
    sourceFilter?: string[];
}
export interface QueryPromptRequest {
    repoPath?: string;
    workspaceId?: string;
    prompt?: string;
    query?: string;
    topK?: number;
    minScore?: number;
    includeAnswer?: boolean;
    sourceFilter?: string[];
}
export interface CorpusWireClientOptions {
    baseUrl?: string;
    basicAuth?: string;
    endpointMode?: "compat" | "v1-only";
    fetchFn?: FetchLike;
    defaultHeaders?: Record<string, string>;
}
export interface IndexEventQuery {
    workspaceId?: string;
    collection?: string;
    status?: string;
    operation?: string;
    limit?: number;
}
export interface IndexActivityQuery {
    workspaceId?: string;
    collection?: string;
    windowHours?: number;
    expectedIntervalSeconds?: number;
}
export interface IndexEvent {
    event_id: string;
    occurred_at: string;
    workspace_id?: string | null;
    collection?: string | null;
    source_root?: string | null;
    operation: string;
    mode?: string | null;
    status: string;
    session_id?: string | null;
    files_manifested: number;
    files_indexed: number;
    files_deleted: number;
    files_unchanged: number;
    files_skipped: number;
    chunks_indexed: number;
    bytes_uploaded: number;
    bytes_skipped: number;
    duration_ms?: number | null;
    client_name?: string | null;
    client_transport?: string | null;
    client_version?: string | null;
    indexed_commit?: string | null;
    manifest_revision?: number | null;
    error?: string | null;
    warning?: string | null;
    metadata?: Record<string, unknown>;
}
export interface IndexEventsResponse {
    ok: true;
    events: IndexEvent[];
}
export interface IndexActivitySummary {
    available: boolean;
    log_path?: string;
    window_hours?: number;
    events_in_window?: number;
    successful_events_in_window?: number;
    failed_events_in_window?: number;
    last_attempt_at?: string | null;
    last_attempt_status?: string | null;
    last_success_at?: string | null;
    last_success_age_seconds?: number | null;
    consecutive_failures?: number;
    expected_interval_seconds?: number;
    gap_detected?: boolean;
    last_event?: IndexEvent | null;
    error?: string | null;
}
export interface IndexActivityResponse {
    ok: true;
    activity: IndexActivitySummary;
}
export interface EnhancePromptPayload {
    repo_path?: string;
    workspace_id?: string;
    prompt: string;
    top_k?: number;
    min_score?: number;
    output_mode: PromptOutputMode;
    local_only: boolean;
    source_filter?: string[];
}
export interface QueryPromptPayload {
    repo_path?: string;
    workspace_id?: string;
    prompt: string;
    top_k?: number;
    min_score?: number;
    include_answer: boolean;
    source_filter?: string[];
}
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type RemoteIndexMode = "full" | "incremental";
export type RemoteManifestOp = "upsert" | "delete";
export interface RemoteWorkspaceIdentity {
    workspaceId: string;
    displayRoot?: string;
    name?: string;
}
export interface StartRemoteIndexSessionRequest {
    workspace: RemoteWorkspaceIdentity;
    mode?: RemoteIndexMode;
    client?: Record<string, unknown>;
    includeGlobs?: string[];
    excludeGlobs?: string[];
    maxFileSizeBytes?: number;
    recreateCollection?: boolean;
}
export interface RemoteIndexSession {
    session_id: string;
    workspace_id: string;
    collection_name: string;
    mode: RemoteIndexMode;
    manifest_revision: number;
    max_batch_bytes: number;
    max_file_size_bytes: number;
    max_concurrent_uploads: number;
}
export interface RemoteManifestEntry {
    relativePath: string;
    op?: RemoteManifestOp;
    size?: number;
    mtimeNs?: number;
    sha256?: string;
    mode?: string;
    docTypeHint?: string;
    language?: string;
}
export interface RemoteManifestBatchResult {
    accepted: number;
    upload_required: string[];
    unchanged: number;
    deletes: number;
    skipped: number;
    errors: string[];
}
export interface RemoteFileDescriptor {
    relativePath: string;
    contentId: string;
    size: number;
    sha256: string;
    mtimeNs: number;
}
export interface RemoteFileBatchMetadata {
    files: RemoteFileDescriptor[];
}
export interface RemoteFileContent {
    descriptor: RemoteFileDescriptor;
    content: string | Uint8Array;
    contentType?: string;
}
export interface RemoteFileBatchResult {
    files_received: number;
    files_indexed: number;
    bytes_uploaded: number;
    bytes_skipped: number;
    errors: string[];
}
export interface RemoteIndexStatus {
    session_id: string;
    workspace_id: string;
    collection_name: string;
    mode: RemoteIndexMode;
    manifest_revision?: number | null;
    phase: string;
    files_manifested: number;
    files_indexed: number;
    files_deleted: number;
    files_unchanged: number;
    files_skipped: number;
    bytes_uploaded: number;
    bytes_skipped: number;
    queue_depth: number;
    errors: string[];
}
export interface RemoteIndexCapabilities {
    ok: true;
    protocol_version: string;
    max_batch_bytes: number;
    max_file_size_bytes: number;
    max_concurrent_uploads: number;
    supported_extensions: string[];
    manifest_compression: string[];
    file_batch_content_types: string[];
    payload_compression: string[];
}
export interface RemoteIndexCommitResponse {
    ok: true;
    result: Record<string, unknown>;
    status: RemoteIndexStatus;
}
export interface RemoteWorkspaceFile {
    relativePath: string;
    content: string | Uint8Array;
    mtimeNs?: number;
    sha256?: string;
}
export interface IndexWorkspaceRequest extends Omit<StartRemoteIndexSessionRequest, "workspace"> {
    workspace: RemoteWorkspaceIdentity;
    files: RemoteWorkspaceFile[];
    deletedPaths?: string[];
    batchBytes?: number;
    maxConcurrentUploads?: number;
}
