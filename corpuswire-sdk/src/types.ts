export const promptOutputModes = ["generic", "copilot", "claude-code", "sequential"] as const;
export type PromptOutputMode = (typeof promptOutputModes)[number];

export const promptTaskTypes = [
  "general",
  "bug_fix",
  "refactor",
  "documentation",
  "testing",
  "feature",
  "review",
  "explanation",
  "performance",
] as const;
export type PromptTaskType = (typeof promptTaskTypes)[number];

export const promptTaskTypeSources = ["heuristic", "llm", "heuristic_fallback"] as const;
export type PromptTaskTypeSource = (typeof promptTaskTypeSources)[number];

export const documentTypes = ["markdown", "text", "data", "pdf", "code", "config"] as const;
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

export type AgentContextRole =
  | "implementation"
  | "test"
  | "configuration"
  | "documentation"
  | "data"
  | "deployment"
  | "integration"
  | "unknown";

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
  retrieval_confidence?: number | null;
  retrieval_event_id?: string | null;
  retrieval_not_found?: boolean;
  score_semantics?: string | null;
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

export type QualityWorkType =
  | "semantic_retrieval"
  | "prompt_enhancement"
  | "review_context";

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
  weak_dimensions: Array<{ dimension: string; average: number }>;
  recurring_improvements: Array<{ value: string; count: number }>;
  recurring_warnings: Array<{ value: string; count: number }>;
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
export type ReviewJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "superseded";
export type ReviewFreshness = "exact" | "fresh" | "partial" | "stale";
export type ReviewTelemetryOperation =
  | "webhook"
  | "reconciliation"
  | "baseline_index"
  | "overlay_build"
  | "analyzer"
  | "graph_expansion"
  | "retrieval"
  | "evidence_packing"
  | "authorization"
  | "provider"
  | "durable_job"
  | "retention_purge"
  | "shadow_comparison";
export type ReviewTelemetryStatus =
  | "succeeded"
  | "partial"
  | "failed"
  | "retrying"
  | "duplicate"
  | "timed_out"
  | "cancelled";
export type ReviewFailureCategory =
  | "invalid_authentication"
  | "unauthorized_scope"
  | "empty_repository_set"
  | "missing_exact_base_snapshot"
  | "superseded_review_generation"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "graph_unavailable"
  | "analyzer_timeout"
  | "analyzer_failed"
  | "binary_content"
  | "lfs_content"
  | "submodule_content"
  | "truncated_content"
  | "missing_content"
  | "input_limit"
  | "backend_unavailable"
  | "expired_overlay";
export type ReviewMetricName =
  | "webhook_validation_failures"
  | "webhook_duplicates"
  | "webhook_gaps"
  | "reconciliation_pages"
  | "reconciliation_bindings"
  | "effective_repositories"
  | "reviews_discovered"
  | "changed_files"
  | "provider_warnings"
  | "authorization_exclusions"
  | "baseline_freshness_age_seconds"
  | "overlay_freshness_age_seconds"
  | "analyzer_successes"
  | "analyzer_fallbacks"
  | "analyzer_timeouts"
  | "analyzer_files"
  | "analyzer_failures"
  | "analyzer_truncations"
  | "analyzer_completeness"
  | "definitions"
  | "references"
  | "relationships"
  | "unresolved_relationships"
  | "graph_depth"
  | "graph_fan_out"
  | "candidate_repositories"
  | "graph_truncations"
  | "exact_candidates"
  | "lexical_candidates"
  | "semantic_candidates"
  | "reranked_candidates"
  | "evidence_items"
  | "evidence_tokens"
  | "cache_hits"
  | "omissions"
  | "provider_rate_limit_remaining"
  | "job_retries"
  | "lease_recoveries"
  | "purge_backlog"
  | "purged_overlays"
  | "unauthorized_leakage"
  | "expected_evidence"
  | "semantic_evidence"
  | "review_evidence"
  | "semantic_recall_at_20"
  | "review_recall_at_20"
  | "semantic_relevant_items_per_1000_tokens"
  | "review_relevant_items_per_1000_tokens"
  | "precision_improvement_ratio";

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

export interface ProviderContainerV1 {
  schema_version: ReviewContextSchemaVersion;
  tenant_id: string;
  container_id: string;
  provider: string;
  provider_host: string;
  provider_external_id: string;
  kind: string;
  display_name: string;
  status: "active" | "suspended" | "deleted";
}

export interface ProviderBindingV1 {
  schema_version: ReviewContextSchemaVersion;
  tenant_id: string;
  binding_id: string;
  codebase_id: string;
  container_id: string;
  repository_selection: RepositorySelectionV1;
  status: "active" | "disabled" | "revoked";
  reconciled_at: string | null;
}

export interface GitHubProviderBindingRequest {
  installationId: string;
  providerHost?: string;
  displayName: string;
  /**
   * Repository selection for the create-or-update operation. Omit to preserve
   * an existing selection (or select all on first creation), pass null to
   * select all, pass [] to select none, or pass IDs to select exactly them.
   */
  repositoryAllowlist?: string[] | null;
}

export interface GitHubProviderBindingPayload {
  installation_id: string;
  provider_host?: string;
  display_name: string;
  /** Wire equivalent of GitHubProviderBindingRequest.repositoryAllowlist. */
  repository_allowlist?: string[] | null;
}

export interface ProviderBindingResponseV1 {
  schema_version: ReviewContextSchemaVersion;
  container: ProviderContainerV1;
  binding: ProviderBindingV1;
}

export interface ProviderBindingRevocationV1 {
  schema_version: ReviewContextSchemaVersion;
  binding: ProviderBindingV1;
}

export interface ReviewBudgets {
  graphHops?: number;
  candidateRepositories?: number;
  preRankCandidates?: number;
  evidenceItems?: number;
  serializedTokens?: number;
  waitMs?: number;
}

export interface ReviewBudgetsV1 {
  schema_version?: ReviewContextSchemaVersion;
  graph_hops?: number;
  candidate_repositories?: number;
  pre_rank_candidates?: number;
  evidence_items?: number;
  serialized_tokens?: number;
  wait_ms?: number;
}

export interface ReviewContextRequest {
  codebaseId: string;
  targetRepositoryId: string;
  providerReviewId: string;
  expectedHeadSha?: string | null;
  objective: string;
  strictFreshness?: boolean;
  budgets?: ReviewBudgets;
  outputCharacterLimit?: number | null;
}

export interface ReviewContextRequestV1 {
  schema_version?: ReviewContextSchemaVersion;
  codebase_id: string;
  target_repository_id: string;
  provider_review_id: string;
  expected_head_sha?: string | null;
  objective: string;
  strict_freshness?: boolean;
  budgets?: ReviewBudgetsV1;
  output_character_limit?: number | null;
}

export interface ReviewContextJobV1 {
  schema_version: ReviewContextSchemaVersion;
  job_id: string;
  request_id: string;
  tenant_id: string;
  codebase_id: string;
  state: ReviewJobState;
  attempts: number;
  status_url: string;
  retry_after_seconds: number | null;
  created_at: string;
  updated_at: string;
  partial_reasons: string[];
}

export interface SourceRangeV1 {
  schema_version: ReviewContextSchemaVersion;
  start_line: number;
  end_line: number;
  start_column: number | null;
  end_column: number | null;
}

export interface ExtractorProvenanceV1 {
  schema_version: ReviewContextSchemaVersion;
  extractor_id: string;
  extractor_version: string;
  evidence_tier: "scip" | "compiler" | "native" | "syntax" | "text" | "retrieval";
  resolution_status: "exact" | "declared" | "inferred" | "unresolved";
  confidence: number;
  reason_codes: string[];
  artifact_digest: string | null;
}

export interface RelationshipStepV1 {
  schema_version: ReviewContextSchemaVersion;
  edge_id: string;
  relationship_kind: string;
  source_symbol_id: string;
  target_symbol_id: string;
  graph_distance: number;
}

export interface ScoreBreakdownV1 {
  schema_version: ReviewContextSchemaVersion;
  total: number;
  exact_overlap: number;
  graph: number;
  risk: number;
  freshness: number;
  lexical: number;
  semantic: number;
  reranker: number | null;
}

export interface EvidenceItemV1 {
  schema_version: ReviewContextSchemaVersion;
  evidence_id: string;
  repository_id: string;
  revision: string;
  layer: "snapshot" | "overlay";
  path: string;
  source_range: SourceRangeV1;
  content_hash: string;
  text: string;
  symbol_id: string | null;
  relationship_path: RelationshipStepV1[];
  graph_distance: number | null;
  provenance: ExtractorProvenanceV1;
  freshness: "exact" | "fresh" | "stale" | "unknown";
  confidence: number;
  score: ScoreBreakdownV1;
  selection_reason: string;
  token_count: number;
}

export interface ReviewContextResponseV1 {
  schema_version: ReviewContextSchemaVersion;
  request_id: string;
  telemetry_id: string;
  job_id: string | null;
  review_id: string;
  target_repository_id: string;
  base_sha: string;
  head_sha: string;
  snapshot_id: string;
  snapshot_generation: number;
  overlay_id: string;
  overlay_generation: number;
  freshness: ReviewFreshness;
  changed_symbols: string[];
  related_symbols: string[];
  evidence: EvidenceItemV1[];
  repository_count: number;
  candidate_count: number;
  serialized_token_count: number;
  truncated: boolean;
  omissions: string[];
  warnings: string[];
  retry_guidance: string | null;
}

export type ReviewContextResult = ReviewContextResponseV1 | ReviewContextJobV1;

export interface ReviewContextLimitsV1 {
  schema_version: ReviewContextSchemaVersion;
  repository_limit: number;
  changed_file_limit: number;
  max_file_bytes: number;
  max_diff_bytes: number;
  graph_hops: number;
  candidate_repositories: number;
  pre_rank_candidates: number;
  evidence_items: number;
  serialized_tokens: number;
  wait_ms: number;
  job_timeout_seconds: number;
  overlay_retention_hours: number;
}

export interface ReviewContextCapabilitiesV1 {
  schema_version: ReviewContextSchemaVersion;
  enabled: boolean;
  service_available: boolean;
  providers: Record<string, boolean>;
  analyzers: Record<string, boolean>;
  symbol_graph: boolean;
  review_overlays: boolean;
  supports_polling: boolean;
  supports_cancellation: boolean;
  supports_immediate_purge: boolean;
  limits: ReviewContextLimitsV1;
}

export interface ReviewTelemetrySummaryV1 {
  schema_version: ReviewContextSchemaVersion;
  event_count: number;
  by_operation: Partial<Record<ReviewTelemetryOperation, number>>;
  by_status: Partial<Record<ReviewTelemetryStatus, number>>;
  by_failure_category: Partial<Record<ReviewFailureCategory, number>>;
  metric_totals: Partial<Record<ReviewMetricName, number>>;
  p95_duration_ms: number | null;
}

export interface ReviewStatusV1 {
  schema_version: ReviewContextSchemaVersion;
  codebase_id: string;
  review_id: string;
  state:
    | "pending"
    | "ready"
    | "partial"
    | "closed"
    | "expired"
    | "purged"
    | "failed"
    | "cancelled"
    | "superseded";
  target_repository_id: string | null;
  head_sha: string | null;
  overlay_id: string | null;
  overlay_generation: number | null;
  freshness: ReviewFreshness | null;
  latest_job: ReviewContextJobV1 | null;
  purge_after: string | null;
  warnings: string[];
}

export interface ReviewPurgeV1 {
  schema_version: ReviewContextSchemaVersion;
  codebase_id: string;
  review_id: string;
  state: "purge_queued" | "purged";
  job: ReviewContextJobV1 | null;
  purged_at: string | null;
}

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

export interface ReviewContextPollOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onJob?: (job: ReviewContextJobV1) => void;
}

/** Structurally isolated deterministic symbol-change review contract. */
export type ReviewContextSchemaVersionV2 = "review-context/v2";
export type PairingStatusV2 =
  | "exact_symbol_id"
  | "exact_analyzer_declaration_id"
  | "exact_unique_declaration_key"
  | "one_sided"
  | "ambiguous"
  | "unresolved"
  | "unsupported";
export type SymbolChangeKindV2 =
  | "added"
  | "removed"
  | "modified"
  | "signature_changed"
  | "renamed"
  | "moved"
  | "renamed_and_moved"
  | "unchanged_context"
  | "ambiguous"
  | "unresolved"
  | "unsupported_split_merge";
export type ContinuityStatusV2 = "proven" | "not_established" | "ambiguous" | "unavailable";
export type ReviewJobStateV2 =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "superseded";
export type ReviewLayerV2 = "snapshot" | "overlay";
export type RelationshipDirectionV2 = "incoming" | "outgoing";

export interface SourceRangeV2 {
  schema_version: ReviewContextSchemaVersionV2;
  start_line: number;
  end_line: number;
  start_column: number | null;
  end_column: number | null;
}

export interface ExtractorProvenanceV2 {
  schema_version: ReviewContextSchemaVersionV2;
  extractor_id: string;
  extractor_version: string;
  evidence_tier: "scip" | "compiler" | "native" | "syntax" | "text" | "retrieval";
  resolution_status: "exact" | "declared" | "inferred" | "unresolved";
  confidence: number;
  reason_codes: string[];
  artifact_digest: string | null;
}

export interface StableDeclarationIdentityV2 {
  schema_version: ReviewContextSchemaVersionV2;
  extractor_id: string;
  identity_scheme_version: string;
  value: string;
}

export interface SymbolInstanceEvidenceV2 {
  schema_version: ReviewContextSchemaVersionV2;
  symbol_id: string;
  symbol_instance_id: string;
  repository_id: string;
  revision: string;
  layer: ReviewLayerV2;
  path: string;
  source_range: SourceRangeV2;
  language: string;
  project_root: string;
  qualified_name: string;
  display_name: string;
  kind: string;
  signature: string | null;
  source_content_sha256: string | null;
  symbol_extent_sha256: string | null;
  stable_declaration_identity: StableDeclarationIdentityV2 | null;
  provenance: ExtractorProvenanceV2;
}

export interface NormalizedDiffLineV2 {
  schema_version: ReviewContextSchemaVersionV2;
  kind: "context" | "addition" | "deletion";
  text: string;
  old_line: number | null;
  new_line: number | null;
  no_newline_at_end: boolean;
}

export interface NormalizedSymbolHunkV2 {
  schema_version: ReviewContextSchemaVersionV2;
  path: string;
  ordinal: number;
  old_start: number;
  old_count: number;
  new_start: number;
  new_count: number;
  section: string | null;
  lines: NormalizedDiffLineV2[];
  hunk_sha256: string;
}

export interface NormalizedFileDiffEvidenceV2 {
  schema_version: ReviewContextSchemaVersionV2;
  normalized_diff_hash: string;
  path: string;
  previous_path: string | null;
  change_kind: "added" | "modified" | "renamed" | "deleted";
  content_kind: "text" | "binary" | "lfs";
  patch_status: "complete" | "truncated" | "missing" | "not_applicable";
  additions: number;
  deletions: number;
}

export interface PairingGroupEvidenceV2 {
  schema_version: ReviewContextSchemaVersionV2;
  group_id: string;
  tier: "symbol_id" | "stable_declaration_identity" | "unique_declaration_key" | "authoritative_split_merge";
  base_candidate_instance_ids: string[];
  head_candidate_instance_ids: string[];
  base_candidate_count: number;
  head_candidate_count: number;
  candidates_truncated: boolean;
}

export interface ReviewSidePathObservationV2 {
  schema_version: ReviewContextSchemaVersionV2;
  path: string;
  path_role:
    | "added_base_absent"
    | "added_head"
    | "deleted_base"
    | "deleted_head_absent"
    | "modified_base"
    | "modified_head"
    | "renamed_base"
    | "renamed_head"
    | "unchanged_reanalyzed";
  source_state: "present" | "absent_by_diff" | "non_text" | "unavailable";
  analyzer_state:
    | "complete"
    | "degraded"
    | "skipped"
    | "truncated"
    | "failed"
    | "not_applicable"
    | "unavailable"
    | null;
  analyzed_scope_complete: boolean;
  source_content_sha256: string | null;
  reason_codes: string[];
}

export interface ResolvedRelationshipFactV2 {
  schema_version: ReviewContextSchemaVersionV2;
  fact_type: "resolved";
  edge_id: string;
  direction: RelationshipDirectionV2;
  relationship_kind: string;
  changed_logical_identity: string;
  endpoint_logical_identity: string | null;
  source_repository_id: string;
  source_snapshot_id: string;
  source_generation: number;
  source_symbol_id: string;
  source_symbol_instance_id: string;
  source_language: string;
  target_repository_id: string;
  target_snapshot_id: string;
  target_generation: number;
  target_symbol_id: string;
  target_symbol_instance_id: string;
  target_language: string;
  path: string;
  source_range: SourceRangeV2;
  provenance: ExtractorProvenanceV2;
  resolution_precedence: "local" | "declared_dependency" | "exact_coordinate" | "extractor";
  contract_evidence_id: string | null;
  contract_coordinate: string | null;
  contract_artifact_digest: string | null;
  revision: string;
  layer: ReviewLayerV2;
}

export interface UnresolvedRelationshipFactV2 {
  schema_version: ReviewContextSchemaVersionV2;
  fact_type: "unresolved";
  reference_id: string;
  direction: RelationshipDirectionV2;
  relationship_kind: string;
  changed_logical_identity: string;
  normalized_target: string;
  source_symbol_id: string;
  source_symbol_instance_id: string;
  path: string;
  source_range: SourceRangeV2;
  provenance: ExtractorProvenanceV2;
  resolution_status: "ambiguous" | "not_found" | "rejected";
  candidate_count: number;
  reason: string;
  revision: string;
  layer: ReviewLayerV2;
  generation: number;
}

export type RelationshipFactV2 = ResolvedRelationshipFactV2 | UnresolvedRelationshipFactV2;

export interface RelationshipDeltaCompletenessV2 {
  schema_version: ReviewContextSchemaVersionV2;
  base_declaring_unit_observed: boolean;
  head_declaring_unit_observed: boolean;
  incoming_dependents_reanalyzed: boolean;
  reason_codes: string[];
}

export interface RelationshipDeltaV2 {
  schema_version: ReviewContextSchemaVersionV2;
  status: "added" | "removed" | "preserved" | "evidence_changed" | "ambiguous" | "unresolved";
  relationship_kind: string;
  direction: RelationshipDirectionV2;
  changed_logical_identity: string;
  endpoint_logical_identity: string | null;
  base_fact: RelationshipFactV2 | null;
  head_fact: RelationshipFactV2 | null;
  comparison_attributes_changed: string[];
  completeness: RelationshipDeltaCompletenessV2;
}

export interface ChangeEvidenceCompletenessV2 {
  schema_version: ReviewContextSchemaVersionV2;
  symbol_pair_complete: boolean;
  normalized_hunks_complete: boolean;
  relationship_deltas_complete: boolean;
  complete: boolean;
  reason_codes: string[];
}

export interface SymbolChangeRecordV2 {
  schema_version: ReviewContextSchemaVersionV2;
  change_id: string;
  logical_identity: string;
  base: SymbolInstanceEvidenceV2 | null;
  head: SymbolInstanceEvidenceV2 | null;
  change_kind: SymbolChangeKindV2;
  pairing_status: PairingStatusV2;
  continuity_status: ContinuityStatusV2;
  pairing_confidence: number | null;
  pairing_group: PairingGroupEvidenceV2 | null;
  diff_evidence: NormalizedFileDiffEvidenceV2;
  normalized_hunks: NormalizedSymbolHunkV2[];
  relationship_deltas: RelationshipDeltaV2[];
  base_observation: ReviewSidePathObservationV2;
  head_observation: ReviewSidePathObservationV2;
  completeness: ChangeEvidenceCompletenessV2;
}

export interface ReviewBudgetsV2Input {
  graphHops?: number;
  candidateRepositories?: number;
  preRankCandidates?: number;
  evidenceItems?: number;
  serializedTokens?: number;
  serializedCharacters?: number;
  serializedUtf8Bytes?: number;
  waitMs?: number;
}

export interface ReviewBudgetsV2 {
  schema_version?: ReviewContextSchemaVersionV2;
  graph_hops?: number;
  candidate_repositories?: number;
  pre_rank_candidates?: number;
  evidence_items?: number;
  serialized_tokens?: number;
  serialized_characters?: number;
  serialized_utf8_bytes?: number;
  wait_ms?: number;
}

export interface ReviewContextRequestV2Input {
  codebaseId: string;
  targetRepositoryId: string;
  providerReviewId: string;
  expectedHeadSha?: string | null;
  objective: string;
  strictFreshness?: boolean;
  budgets?: ReviewBudgetsV2Input;
}

export interface ReviewContextRequestV2 {
  schema_version?: ReviewContextSchemaVersionV2;
  codebase_id: string;
  target_repository_id: string;
  provider_review_id: string;
  expected_head_sha?: string | null;
  objective: string;
  strict_freshness?: boolean;
  budgets?: ReviewBudgetsV2;
}

export interface ReviewScopeV2 {
  schema_version: ReviewContextSchemaVersionV2;
  tenant_id: string;
  actor_id: string;
  codebase_id: string;
  target_repository_id: string;
  authorized_repository_ids: string[];
  repository_set_id: string;
  repository_selection_digest: string;
  base_snapshot_id: string;
  base_snapshot_generation: number;
  base_snapshot_refresh_sequence: number;
  overlay_id: string;
  overlay_generation: number;
  overlay_refresh_sequence: number;
}

export interface ReviewPartialReasonV2 {
  schema_version: ReviewContextSchemaVersionV2;
  code: string;
  retryable: boolean;
  affected_side: "base" | "head" | "both" | "graph" | "response";
}

export interface ReviewContextLimitsV2 {
  schema_version: ReviewContextSchemaVersionV2;
  max_records: number;
  max_symbol_extent_utf8_bytes_per_side: number;
  max_symbol_extent_utf8_bytes_per_overlay: number;
  max_serialized_bundle_bytes: number;
  max_serialized_response_bytes: number;
  construction_timeout_ms: number;
  base_rebuild_timeout_ms: number;
  max_refresh_sequences_per_lineage: number;
}

export interface ReviewContextCapabilitiesV2 {
  schema_version: ReviewContextSchemaVersionV2;
  contract_version: ReviewContextSchemaVersionV2;
  enabled: boolean;
  service_available: boolean;
  construction_enabled: boolean;
  publication_enabled: boolean;
  read_enabled: boolean;
  routes_enabled: boolean;
  supports_polling: boolean;
  supports_cancellation: boolean;
  supports_repository_set_scoped_status: boolean;
  snapshot_artifact_contract_version: "snapshot-artifacts/v2";
  snapshot_builder_version: string;
  artifact_contract_version: "review-artifacts/v2";
  evidence_builder_version: string;
  build_policy_digest: string;
  limits: ReviewContextLimitsV2;
}

export interface ReviewContextJobV2 {
  schema_version: ReviewContextSchemaVersionV2;
  contract_version: ReviewContextSchemaVersionV2;
  job_id: string;
  request_id: string;
  tenant_id: string;
  codebase_id: string;
  repository_set_id: string;
  repository_selection_digest: string;
  state: ReviewJobStateV2;
  attempts: number;
  status_url: string;
  retry_after_seconds: number | null;
  created_at: string;
  updated_at: string;
  overlay_id: string | null;
  overlay_generation: number | null;
  overlay_refresh_sequence: number | null;
  partial_reasons: ReviewPartialReasonV2[];
}

export interface ReviewPublicationStatusV2 {
  schema_version: ReviewContextSchemaVersionV2;
  repository_set_id: string;
  repository_selection_digest: string;
  target_repository_id: string;
  base_sha: string;
  head_sha: string;
  base_snapshot_id: string;
  base_snapshot_generation: number;
  base_snapshot_refresh_sequence: number;
  overlay_id: string;
  overlay_generation: number;
  overlay_refresh_sequence: number;
  state: "ready" | "partial" | "failed" | "stale" | "closed" | "expired" | "purged";
  freshness: "exact" | "partial" | "stale" | null;
  evidence_state: "ready" | "partial" | "failed";
  warning_count: number;
  published_at: string;
}

export interface ReviewStatusV2 {
  schema_version: ReviewContextSchemaVersionV2;
  contract_version: ReviewContextSchemaVersionV2;
  codebase_id: string;
  review_id: string;
  target_repository_id: string;
  head_sha: string;
  publications: ReviewPublicationStatusV2[];
  latest_jobs: ReviewContextJobV2[];
}

export interface MinimumRequiredBudgetV2 {
  schema_version: ReviewContextSchemaVersionV2;
  evidence_items: number;
  tokens: number;
  characters: number;
  utf8_bytes: number;
}

export interface SymbolExtentEvidenceV2 {
  schema_version: ReviewContextSchemaVersionV2;
  side: "base" | "head";
  evidence_id: string;
  symbol_instance_id: string;
  repository_id: string;
  revision: string;
  layer: ReviewLayerV2;
  path: string;
  symbol_source_range: SourceRangeV2;
  extent_start_line: number;
  extent_end_line: number;
  source_content_sha256: string;
  symbol_extent_sha256: string;
  text: string;
  token_count: number;
}

export interface EvidenceItemV2 {
  schema_version: ReviewContextSchemaVersionV2;
  evidence_id: string;
  repository_id: string;
  revision: string;
  layer: ReviewLayerV2;
  path: string;
  source_range: SourceRangeV2;
  content_hash: string;
  text: string;
  symbol_id: string | null;
  graph_distance: number | null;
  provenance: ExtractorProvenanceV2;
  freshness: "exact" | "fresh" | "stale" | "unknown";
  confidence: number;
  selection_reason: string;
  token_count: number;
}

export interface BundleCompletenessV2 {
  schema_version: ReviewContextSchemaVersionV2;
  required_sides_complete: boolean;
  related_evidence_complete: boolean;
  reason_codes: string[];
}

export interface AdmittedSymbolChangeEvidenceBundleV2 {
  schema_version: ReviewContextSchemaVersionV2;
  ordinal: number;
  change_record: SymbolChangeRecordV2;
  base_evidence: SymbolExtentEvidenceV2 | null;
  head_evidence: SymbolExtentEvidenceV2 | null;
  related_evidence: EvidenceItemV2[];
  completeness: BundleCompletenessV2;
  evidence_item_count: number;
  serialized_tokens: number;
  serialized_characters: number;
  serialized_utf8_bytes: number;
}

export interface OmittedSymbolChangeEvidenceBundleV2 {
  schema_version: ReviewContextSchemaVersionV2;
  change_id: string;
  ordinal: number;
  change_kind: SymbolChangeKindV2;
  pairing_status: PairingStatusV2;
  reason:
    | "required_pair_budget_exceeded"
    | "required_evidence_unavailable"
    | "required_evidence_capacity_exceeded";
  omitted_sides: Array<"base" | "head" | "related">;
  minimum_required_budget: MinimumRequiredBudgetV2 | null;
  model_evidence_available: false;
}

export interface ReviewContextResponseV2 {
  schema_version: ReviewContextSchemaVersionV2;
  request_id: string;
  telemetry_id: string;
  job_id: string | null;
  review_id: string;
  target_repository_id: string;
  review_scope: ReviewScopeV2;
  base_sha: string;
  head_sha: string;
  base_snapshot_id: string;
  base_snapshot_generation: number;
  base_snapshot_refresh_sequence: number;
  base_artifact_contract_version: "snapshot-artifacts/v2";
  base_snapshot_builder_version: string;
  base_build_policy_digest: string;
  overlay_id: string;
  overlay_generation: number;
  overlay_refresh_sequence: number;
  artifact_contract_version: "review-artifacts/v2";
  evidence_builder_version: string;
  overlay_build_policy_digest: string;
  normalized_diff_hash: string;
  freshness: "exact" | "partial";
  bundles: AdmittedSymbolChangeEvidenceBundleV2[];
  omitted_bundles: OmittedSymbolChangeEvidenceBundleV2[];
  serialized_token_count: number;
  serialized_character_count: number;
  serialized_utf8_byte_count: number;
  partial: boolean;
  partial_reasons: ReviewPartialReasonV2[];
  retry_guidance: string | null;
}

export type ReviewContextResultV2 = ReviewContextResponseV2 | ReviewContextJobV2;

export interface ReviewContextErrorV2 {
  schema_version: ReviewContextSchemaVersionV2;
  error_code: string;
  message: string;
  request_id: string;
  retryable: boolean;
  retry_after_seconds: number | null;
  recovery_guidance: string[];
  details: Record<string, unknown>;
}

export interface ReviewContextPollOptionsV2 {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onJob?: (job: ReviewContextJobV2) => void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RemoteIndexMode = "full" | "incremental";
export type RemoteManifestOp = "upsert" | "delete";
export type RemoteIndexLayer = "snapshot" | "overlay";
export type RemoteIndexProgressState = "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type RemoteIndexProgressPhase =
  | "resolving_configuration"
  | "scanning"
  | "filtering_hashing"
  | "manifest_comparison"
  | "uploading"
  | "queued"
  | "parsing_chunking"
  | "embedding"
  | "vector_writes"
  | "committing"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled";
export type RemoteIndexEtaConfidence = "unknown" | "low" | "medium" | "high";
export type RemoteIndexVerificationStatus = "pending" | "verified" | "failed" | "not_applicable";

export interface RemoteIndexProgressEvent {
  schema_version: "index-progress/v1";
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
  protocol_versions?: string[];
  snapshot_scoping?: boolean;
}

export interface RemoteIndexCommitResponse {
  transfer?: IndexTransferSummary;
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
  inventoryScan?: InventoryScan;
  workspace: RemoteWorkspaceIdentity;
  files: RemoteWorkspaceFile[];
  deletedPaths?: string[];
  batchBytes?: number;
  maxConcurrentUploads?: number;
  processingTimeoutMs?: number;
  processingPollMs?: number;
  signal?: AbortSignal;
  detachSignal?: AbortSignal;
  onProgress?: (event: RemoteIndexProgressEvent) => void;
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
export interface WorkspaceCoverage {
  schema_version: "workspace-coverage/v1";
  state: "unknown" | "pending" | "verified" | "invalidated" | "unavailable" | "not_applicable";
  reason_codes: string[];
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
  collection_fingerprint?: string | null;
}
export interface IndexTransferSummary {
  files_submitted: number;
  files_upload_required: number | null;
  files_reused: number | null;
  files_transferred: number;
  source_bytes_transferred: number;
  upload_attempts: number;
  source_bytes_attempted: number;
  complete: boolean;
  /** Per-operation acknowledgements for authorized local cache updates; never activity telemetry. */
  acknowledged_files: Array<{ relative_path: string; sha256: string; disposition: "uploaded" | "confirmed_reused" }>;
}
