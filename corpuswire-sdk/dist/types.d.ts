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
export type EvidenceSpanReason = "selected" | "projection" | "sibling" | "heading";
/** One packed evidence span (CRP-003 `server-v1`); exact indexed source lines. */
export interface EvidenceSpan {
    source_path: string;
    /** sha256 hex of the indexed file. */
    source_hash: string;
    start_line: number;
    end_line: number;
    /** Exact source lines joined by "\n". */
    text: string;
    from_chunk_ids: string[];
    reason: EvidenceSpanReason;
}
/** Server packing report; present only when the server packs evidence. */
export interface PackingReport {
    policy: "server-v1";
    budget_chars: number;
    used_chars: number;
    spans_total: number;
    spans_dropped_budget: number;
    spans_dropped_conflict: number;
    /** Selected projections clipped to the budget instead of dropped (engine >= #173). */
    spans_clipped_budget?: number;
    files: number;
    fallback_reason: string | null;
    /** True only when every span is verified; clients use spans only then. */
    complete?: boolean;
    unverified_hits?: number;
}
export interface PromptRewriteResult {
    user_prompt: string;
    retrieval_query: string;
    retrieval_backend: string | null;
    retrieval_warning: string | null;
    retrieval_confidence?: number | null;
    retrieval_event_id?: string | null;
    retrieval_not_found?: boolean;
    score_semantics?: string | null;
    retrieved_chunks: SearchHit[];
    agent_context_packets?: AgentContextPacket[];
    evidence_spans?: EvidenceSpan[];
    packing?: PackingReport;
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
    request_id?: string;
    tenant_id?: string;
    user_id?: string | null;
    actor_kind?: "human" | "service" | "basic" | "anonymous-local";
    workspace_id?: string;
    storage_workspace_id?: string;
    membership_role?: "owner" | "editor" | "viewer" | null;
}
export interface PromptEnhancementResult {
    user_prompt: string;
    retrieval_query: string;
    retrieval_backend: string | null;
    retrieval_warning: string | null;
    retrieval_confidence?: number | null;
    retrieval_event_id?: string | null;
    retrieval_not_found?: boolean;
    score_semantics?: string | null;
    retrieved_chunks: SearchHit[];
    agent_context_packets?: AgentContextPacket[];
    evidence_spans?: EvidenceSpan[];
    packing?: PackingReport;
    augmented_prompt: string;
    citations: string[];
    answer: string | null;
    generation_error: string | null;
}
export interface ActionResponseContext {
    request_id?: string;
    tenant_id?: string;
    user_id?: string | null;
    actor_kind?: "human" | "service" | "basic" | "anonymous-local";
    workspace_id?: string | null;
    storage_workspace_id?: string;
    membership_role?: "owner" | "editor" | "viewer" | null;
}
export interface QueryResponseContext extends ActionResponseContext {
    repo_path?: string | null;
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
    code_ready?: boolean;
    documentation_pending?: boolean;
    other_pending?: boolean;
    coverage?: WorkspaceCoverage;
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
    context?: ActionResponseContext;
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
    /**
     * Optional server evidence budget (positive integer), sent as
     * `max_evidence_chars` only when set. Servers that predate evidence packing
     * reject unknown request fields, so leave it unset for them.
     */
    maxEvidenceChars?: number;
    /**
     * Optional editor and chat state used by the server for retrieval and
     * rewriting only. It is sent as `session` only when it holds at least one
     * usable value, so older servers that reject the key keep working.
     */
    session?: EnhanceSessionContext;
}
export type EnhanceConversationRole = "user" | "assistant";
export interface EnhanceConversationTurn {
    role: EnhanceConversationRole;
    text: string;
}
export interface EnhanceSelection {
    /** Workspace-relative POSIX path, or an absolute path under the workspace root. */
    path: string;
    /** 1-based first line of the selection. */
    startLine: number;
    /** 1-based last line of the selection; must not precede startLine. */
    endLine: number;
    text?: string | null;
}
export interface EnhanceSessionContext {
    /** Prior chat turns, oldest first. Only the last 20 are sent. */
    conversation?: EnhanceConversationTurn[];
    activeFile?: string | null;
    selection?: EnhanceSelection | null;
    /** Recently edited files, most recent first. Only the first 50 are sent. */
    recentEdits?: string[];
    /**
     * Client-side only: the root used to turn absolute paths into
     * workspace-relative ones. Defaults to the request's repoPath. Never sent.
     */
    workspaceRoot?: string;
}
export interface EnhanceSelectionPayload {
    path: string;
    start_line: number;
    end_line: number;
    text?: string;
}
export interface EnhanceSessionContextPayload {
    conversation?: EnhanceConversationTurn[];
    active_file?: string;
    selection?: EnhanceSelectionPayload;
    recent_edits?: string[];
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
    /**
     * Optional server evidence budget (positive integer), sent as
     * `max_evidence_chars` only when set. Servers that predate evidence packing
     * reject unknown request fields, so leave it unset for them.
     */
    maxEvidenceChars?: number;
}
export interface CorpusWireClientOptions {
    baseUrl?: string;
    basicAuth?: string;
    bearerToken?: string;
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
export interface IndexSessionQuery {
    workspaceId?: string;
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
    max_evidence_chars?: number;
    session?: EnhanceSessionContextPayload;
}
export interface QueryPromptPayload {
    repo_path?: string;
    workspace_id?: string;
    prompt: string;
    top_k?: number;
    min_score?: number;
    include_answer: boolean;
    source_filter?: string[];
    max_evidence_chars?: number;
}
export type QualityWorkType = "semantic_retrieval" | "prompt_enhancement" | "review_context";
export interface QualityScorecard {
    relevance: number;
    fileSpecificity: number;
    coverage: number;
    freshness: number;
    actionability: number;
}
export interface QualityEventRequest {
    workspaceId: string;
    workType: QualityWorkType;
    engine: string;
    scorecard: QualityScorecard;
    query?: string;
    surface?: string;
    roundId?: string;
    resultPaths?: string[];
    warning?: string;
    improvement?: string;
    notes?: string;
    issueUrl?: string;
    metadata?: Record<string, unknown>;
}
export interface QualityEventPayload {
    workspace_id: string;
    work_type: QualityWorkType;
    engine: string;
    scorecard: {
        relevance: number;
        file_specificity: number;
        coverage: number;
        freshness: number;
        actionability: number;
    };
    query: string;
    surface?: string;
    round_id?: string;
    result_paths: string[];
    warning?: string;
    improvement?: string;
    notes?: string;
    issue_url?: string;
    metadata: Record<string, unknown>;
}
export interface QualityEvent {
    event_id: string;
    occurred_at: string;
    workspace_id: string;
    work_type: QualityWorkType;
    engine: string;
    surface?: string | null;
    round_id?: string | null;
    query: string;
    query_terms: string[];
    relevance: number;
    file_specificity: number;
    coverage: number;
    freshness: number;
    actionability: number;
    overall: number;
    result_paths: string[];
    warning?: string | null;
    improvement?: string | null;
    notes?: string | null;
    issue_url?: string | null;
    metadata: Record<string, unknown>;
}
export interface QualityEventsQuery {
    workspaceId?: string;
    workType?: QualityWorkType;
    engine?: string;
    days?: number;
    limit?: number;
}
export interface QualityReviewQuery {
    workspaceId?: string;
    workType?: QualityWorkType;
    engine?: string;
    days?: number;
}
export interface QualityReview {
    window_days: number;
    filters: Record<string, unknown>;
    event_count: number;
    overall_average: number;
    dimension_averages: Record<string, number>;
    by_engine: Record<string, unknown>;
    by_workspace: Record<string, unknown>;
    by_work_type: Record<string, unknown>;
    weak_dimensions: Array<{
        dimension: string;
        average: number;
    }>;
    recurring_improvements: Array<{
        value: string;
        count: number;
    }>;
    recurring_warnings: Array<{
        value: string;
        count: number;
    }>;
    recommended_actions: string[];
    low_score_events: Array<Record<string, unknown>>;
    generated_at: string;
}
export interface QualityEventResponse {
    ok: true;
    event: QualityEvent;
}
export interface QualityEventsResponse {
    ok: true;
    events: QualityEvent[];
}
export interface QualityReviewResponse {
    ok: true;
    review: QualityReview;
}
export interface ValueFeedbackRequest {
    eventId: string;
    minutesSaved: number;
    confirmedValue?: number;
    confirmedBy?: string;
}
export interface QueryValueEvent {
    event_id: string;
    workspace_id?: string | null;
    estimated_minutes_saved: number;
    confirmed_minutes_saved?: number | null;
    actual_cost: number;
    confirmed_value?: number | null;
    value_status: "estimated" | "sampled" | "user_confirmed";
}
export interface ValueRollupQuery {
    period?: "day" | "week" | "month";
    days?: number;
    workspaceId?: string;
    hourlyRate?: number;
}
export interface ValueRollup {
    period: "day" | "week" | "month";
    days: number;
    hourly_rate?: number | null;
    buckets: Array<Record<string, unknown>>;
}
export type ReviewContextSchemaVersion = "review-context/v1";
export type RepositorySelectionMode = "all" | "none" | "selected";
export interface RepositorySelectionV1 {
    schema_version: ReviewContextSchemaVersion;
    mode: RepositorySelectionMode;
    provider_repository_ids: string[];
}
export interface CodebaseV1 {
    schema_version: ReviewContextSchemaVersion;
    tenant_id: string;
    codebase_id: string;
    display_name: string;
    status: "active" | "disabled" | "deleting";
    repository_selection: RepositorySelectionV1;
    created_at: string;
    updated_at: string;
}
export interface CodebaseListV1 {
    schema_version: ReviewContextSchemaVersion;
    codebases: CodebaseV1[];
}
export interface CreateCodebaseRequest {
    displayName: string;
}
export interface UpdateCodebaseRequest {
    displayName?: string;
    status?: "active" | "disabled";
}
export interface RepositorySummaryV1 {
    schema_version: ReviewContextSchemaVersion;
    tenant_id: string;
    codebase_id: string;
    repository_id: string;
    provider: string | null;
    provider_host: string | null;
    provider_external_id: string | null;
    display_name: string;
    canonical_path: string;
    default_branch: string | null;
    state: "active" | "archived" | "deleted" | "inaccessible";
    discovered_at: string;
    updated_at: string;
}
export interface CodebaseRepositoriesV1 {
    schema_version: ReviewContextSchemaVersion;
    codebase_id: string;
    repository_selection: RepositorySelectionV1;
    repositories: RepositorySummaryV1[];
}
/** Stable error body returned by the Codebase catalog routes. */
export interface ReviewContextErrorV1 {
    schema_version: ReviewContextSchemaVersion;
    error_code: string;
    message: string;
    request_id: string;
    retryable: boolean;
    retry_after_seconds: number | null;
    recovery_guidance: string[];
    details: Record<string, unknown>;
}
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type RemoteIndexMode = "full" | "incremental";
export type RemoteManifestOp = "upsert" | "delete";
export type RemoteIndexLayer = "snapshot" | "overlay";
export type RemoteIndexProgressState = "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type RemoteIndexProgressPhase = "resolving_configuration" | "scanning" | "filtering_hashing" | "manifest_comparison" | "uploading" | "queued" | "parsing_chunking" | "embedding" | "vector_writes" | "committing" | "verifying" | "completed" | "failed" | "cancelling" | "cancelled";
export type RemoteIndexEtaConfidence = "unknown" | "low" | "medium" | "high";
export type RemoteIndexVerificationStatus = "pending" | "verified" | "failed" | "not_applicable";
export interface RemoteIndexProgressEvent {
    schema_version: "index-progress/v1";
    /** Optional origin disambiguates client and server sequence spaces. */
    event_origin?: "client" | "server";
    sequence: number;
    session_id: string;
    workspace_id: string;
    occurred_at: string;
    phase: RemoteIndexProgressPhase;
    state: RemoteIndexProgressState;
    message: string;
    overall_completed: number;
    overall_total: number | null;
    overall_percent: number | null;
    overall_indeterminate: boolean;
    phase_completed: number;
    phase_total: number | null;
    unit: string;
    elapsed_ms: number;
    phase_elapsed_ms: number;
    throughput_per_second: number | null;
    queue_depth: number;
    retries: number;
    warnings: string[];
    eta_seconds: number | null;
    eta_confidence: RemoteIndexEtaConfidence;
    heartbeat: boolean;
    last_progress_at: string;
    last_heartbeat_at: string | null;
    active_heartbeat: boolean;
    counts: Record<string, number>;
    phase_timings_ms: Record<string, number>;
    verification_status: RemoteIndexVerificationStatus;
}
export interface RemoteIndexScopeV2 {
    tenantId?: string | null;
    codebaseId: string;
    repositoryId: string;
    repositorySetId: string;
    snapshotId: string;
    layer: RemoteIndexLayer;
    revision: string;
    generation: number;
    overlayId?: string | null;
}
export interface RemoteIndexScopeV2Payload {
    tenant_id?: string | null;
    codebase_id: string;
    repository_id: string;
    repository_set_id: string;
    snapshot_id: string;
    layer: RemoteIndexLayer;
    revision: string;
    generation: number;
    overlay_id?: string | null;
}
export interface RemoteWorkspaceIdentity {
    workspaceId: string;
    displayRoot?: string;
    name?: string;
}
export interface StartRemoteIndexSessionRequest {
    inventory?: WorkspaceInventory;
    evaluationInventoryAttestation?: EvaluationInventoryAttestation;
    baseCoverageToken?: string;
    selectionPolicyDigest?: string;
    workspace: RemoteWorkspaceIdentity;
    mode?: RemoteIndexMode;
    client?: Record<string, unknown>;
    includeGlobs?: string[];
    excludeGlobs?: string[];
    maxFileSizeBytes?: number;
    recreateCollection?: boolean;
    snapshotScope?: RemoteIndexScopeV2 | null;
}
export interface RemoteIndexSession {
    /** This session supports publishing verified code before lower-priority files. */
    code_checkpoint?: boolean;
    session_id: string;
    workspace_id: string;
    collection_name: string;
    mode: RemoteIndexMode;
    manifest_revision: number;
    max_batch_bytes: number;
    max_batch_files?: number;
    max_file_size_bytes: number;
    max_concurrent_uploads: number;
    tenant_id?: string;
    snapshot_scope?: RemoteIndexScopeV2Payload | null;
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
    queued?: boolean;
    job_id?: string | null;
    phase?: string | null;
}
export interface RemoteIndexStatus {
    coverage?: WorkspaceCoverage | null;
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
    pending_batches?: number;
    active_batches?: number;
    completed_batches?: number;
    failed_batches?: number;
    age_seconds?: number | null;
    idle_seconds?: number | null;
    last_progress_seconds?: number | null;
    active_heartbeat?: boolean;
    idle_timeout_seconds?: number | null;
    errors: string[];
    progress?: RemoteIndexProgressEvent | null;
    snapshot_scope?: RemoteIndexScopeV2Payload | null;
}
export interface RemoteIndexPreview {
    workspace_id: string;
    collection_name: string;
    requested_mode: RemoteIndexMode;
    expected_mode: "full" | "incremental" | "no_change";
    candidates: number;
    included: number;
    excluded: number;
    changed: number;
    unchanged: number;
    deleted: number;
    candidate_bytes: number;
    destructive_risk: boolean;
}
export interface RemoteIndexSessionsResponse {
    ok: true;
    sessions: RemoteIndexStatus[];
}
export interface RemoteIndexCapabilities {
    inventory_coverage_versions?: string[];
    ok: true;
    protocol_version: string;
    max_batch_bytes: number;
    max_batch_files?: number;
    max_file_size_bytes: number;
    max_concurrent_uploads: number;
    supported_extensions: string[];
    supported_filenames?: string[];
    supported_file_registry_version?: string;
    manifest_compression: string[];
    file_batch_content_types: string[];
    payload_compression: string[];
    background_file_batches?: boolean;
    worker_count?: number;
    max_queued_batches?: number;
    max_queued_bytes?: number;
    protocol_versions?: string[];
    snapshot_scoping?: boolean;
    file_batch_priorities?: {
        code: number;
        documentation: number;
        other: number;
    };
    max_processing_files?: number;
    max_processing_source_bytes?: number;
    processing_quantum_boundary?: "complete_files";
    chunk_stream_preemption?: boolean;
}
export interface RemoteIndexCommitResponse {
    transfer?: IndexTransferSummary;
    ok: true;
    result: Record<string, unknown>;
    status: RemoteIndexStatus;
}
/** A released code publication is distinct from a verified full commit. */
export type RemoteIndexCodeStageResult = {
    outcome: "code_ready";
    full_inventory_complete: false;
    checkpoint: RemoteIndexStatus;
    release_status: RemoteIndexStatus;
    transfer: IndexTransferSummary;
} | {
    outcome: "deferred";
    reason: "no_code";
    full_inventory_complete: false;
    files_submitted: number;
} | {
    outcome: "full";
    reason: "checkpoint_unsupported" | "empty_inventory";
    /** False when an older service cannot certify inventory coverage. */
    full_inventory_complete: boolean;
    committed: RemoteIndexCommitResponse;
};
export interface RemoteWorkspaceFile {
    relativePath: string;
    content: string | Uint8Array;
    mtimeNs?: number;
    sha256?: string;
}
export interface IndexWorkspaceRequest extends Omit<StartRemoteIndexSessionRequest, "workspace"> {
    inventoryScan?: InventoryScan;
    workspace: RemoteWorkspaceIdentity;
    files: RemoteWorkspaceFile[];
    deletedPaths?: string[];
    batchBytes?: number;
    maxConcurrentUploads?: number;
    processingTimeoutMs?: number;
    processingPollMs?: number;
    /** Maximum admission wait per batch; defaults to 10 minutes. */
    queueWaitTimeoutMs?: number;
    signal?: AbortSignal;
    detachSignal?: AbortSignal;
    onProgress?: (event: RemoteIndexProgressEvent) => void;
    onCodeReady?: (status: RemoteIndexStatus) => void;
}
/** Evidence emitted only by a complete filesystem scan; a files array alone is insufficient. */
export interface InventoryScan {
    complete: true;
    startedAt: string;
    completedAt: string;
    excludedFileCount: number;
    ignoreDigest: string;
    producer: string;
}
export interface InventorySelectionPolicy {
    version: "workspace-selection/v1";
    include_globs: string[];
    exclude_globs: string[];
    ignore_digest: string;
    supported_file_registry_version: string;
    max_file_size_bytes: number;
    symlink_policy: "skip";
    producer: string;
}
export interface WorkspaceInventory {
    schema_version: "workspace-inventory/v1";
    scan_complete: true;
    selection_policy: InventorySelectionPolicy;
    selection_policy_digest: string;
    manifest_digest: string;
    eligible_file_count: number;
    eligible_source_bytes: number;
    excluded_file_count: number;
    scan_started_at: string;
    scan_completed_at: string;
}
export interface EvaluationInventoryEntry {
    relative_path: string;
    sha256: string;
    size: number;
}
export interface EvaluationInventoryAttestation {
    schema_version: "evaluation-inventory-attestation/v1";
    full_manifest_digest: string;
    eligible_manifest_digest: string;
    excluded_manifest_digest: string;
    allowlist_digest: string;
    required_evidence_digest: string;
    selection_policy_digest: string;
    complete_file_count: number;
    complete_source_bytes: number;
    excluded_file_count: number;
    excluded_source_bytes: number;
    excluded_entries: EvaluationInventoryEntry[];
    allowlist_entries: EvaluationInventoryEntry[];
    required_evidence_entries: EvaluationInventoryEntry[];
}
export interface WorkspaceCoverage {
    schema_version: "workspace-coverage/v1";
    state: "unknown" | "pending" | "verified" | "invalidated" | "unavailable" | "not_applicable";
    reason_codes: string[];
    code_ready?: boolean;
    documentation_pending?: boolean;
    other_pending?: boolean;
    coverage_token?: string | null;
    session_id?: string | null;
    published_revision?: number | null;
    baseline_revision?: number | null;
    last_delta_revision?: number | null;
    baseline_manifest_digest?: string | null;
    eligible_file_count?: number | null;
    eligible_source_bytes?: number | null;
    selection_policy_digest?: string | null;
    scan_started_at?: string | null;
    scan_completed_at?: string | null;
    published_at?: string | null;
    embedding_fingerprint?: string | null;
    collection_schema_fingerprint?: string | null;
    collection_fingerprint?: string | null;
    evaluation_full_manifest_digest?: string | null;
    evaluation_excluded_manifest_digest?: string | null;
    evaluation_allowlist_digest?: string | null;
    evaluation_required_evidence_digest?: string | null;
    evaluation_excluded_file_count?: number | null;
    evaluation_complete_file_count?: number | null;
}
export interface IndexTransferSummary {
    files_submitted: number;
    files_upload_required: number | null;
    files_reused: number | null;
    files_transferred: number;
    source_bytes_transferred: number;
    upload_attempts: number;
    source_bytes_attempted: number;
    queue_retries?: number;
    queue_full_responses?: number;
    /** Cumulative measured cooldown across batches, not session wall time. */
    queue_wait_ms?: number;
    transport_retries?: number;
    client_phase_timings_ms?: Record<string, number>;
    complete: boolean;
    /** Per-operation acknowledgements for authorized local cache updates; never activity telemetry. */
    acknowledged_files: Array<{
        relative_path: string;
        sha256: string;
        disposition: "uploaded" | "confirmed_reused";
    }>;
}
