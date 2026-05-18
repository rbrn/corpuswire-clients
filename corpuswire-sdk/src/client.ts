import { requestJson } from "./http.js";
import type {
  EnhancePromptPayload,
  EnhancePromptRequest,
  EnhanceResponseEnvelope,
  HealthResponse,
  IndexActivityQuery,
  IndexActivityResponse,
  IndexActivitySummary,
  IndexEvent,
  IndexEventQuery,
  IndexEventsResponse,
  IndexSessionQuery,
  IndexWorkspaceRequest,
  CorpusWireClientOptions,
  LlmModelState,
  PromptOutputMode,
  PromptEnhancementResult,
  PromptRewriteResult,
  QueryPromptPayload,
  QueryPromptRequest,
  QueryResponseEnvelope,
  RemoteFileBatchMetadata,
  RemoteFileBatchResult,
  RemoteFileContent,
  RemoteIndexCapabilities,
  RemoteIndexCommitResponse,
  RemoteIndexSession,
  RemoteIndexSessionsResponse,
  RemoteIndexStatus,
  RemoteManifestBatchResult,
  RemoteManifestEntry,
  RemoteWorkspaceFile,
  SearchHit,
  StartRemoteIndexSessionRequest,
  WorkspaceDiagnosis,
  WorkspaceDiagnosisEnvelope,
  WorkspaceDiagnosisRequest,
} from "./types.js";

const RUNTIME_ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const DEFAULT_BASE_URL = RUNTIME_ENV.CORPUSWIRE_BASE_URL ?? "http://127.0.0.1:8000";
const DEFAULT_BASIC_AUTH = RUNTIME_ENV.CORPUSWIRE_BASIC_AUTH ?? "";
const DEFAULT_OUTPUT_MODE: PromptOutputMode = "generic";

export class CorpusWireClient {
  readonly baseUrl: string;
  readonly basicAuth: string;
  readonly endpointMode: "compat" | "v1-only";
  readonly fetchFn: CorpusWireClientOptions["fetchFn"];
  readonly defaultHeaders: Record<string, string>;

  constructor(options: CorpusWireClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.basicAuth = options.basicAuth ?? DEFAULT_BASIC_AUTH;
    this.endpointMode = options.endpointMode ?? "compat";
    this.fetchFn = options.fetchFn;
    this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
  }

  async health(request: { repoPath?: string; workspaceId?: string } = {}): Promise<HealthResponse> {
    const query = toQueryString({
      repo_path: request.repoPath,
      workspace_id: request.workspaceId,
    });
    return requestJson<HealthResponse>({
      baseUrl: this.baseUrl,
      paths: this.endpointMode === "v1-only" ? [`/v1/health${query}`] : [`/v1/health${query}`, `/health${query}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
  }

  async diagnoseWorkspace(request: WorkspaceDiagnosisRequest = {}): Promise<WorkspaceDiagnosis> {
    const query = toQueryString({
      repo_path: request.repoPath,
      workspace_id: request.workspaceId,
    });
    const response = await requestJson<WorkspaceDiagnosisEnvelope>({
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

  async enhance(request: string | EnhancePromptRequest): Promise<PromptRewriteResult> {
    const response = await this.enhanceRaw(request);
    return response.result;
  }

  async enhanceRaw(request: string | EnhancePromptRequest): Promise<EnhanceResponseEnvelope> {
    return requestJson<EnhanceResponseEnvelope>({
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

  async query(request: string | QueryPromptRequest): Promise<PromptEnhancementResult> {
    const response = await this.queryRaw(request);
    return response.result;
  }

  async queryRaw(request: string | QueryPromptRequest): Promise<QueryResponseEnvelope> {
    return requestJson<QueryResponseEnvelope>({
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

  async semanticSearch(request: string | Omit<QueryPromptRequest, "includeAnswer">): Promise<SearchHit[]> {
    const response = await this.query({
      ...(typeof request === "string" ? { query: request } : request),
      includeAnswer: false,
    });
    return response.retrieved_chunks;
  }

  async getLlmModel(): Promise<LlmModelState> {
    return requestJson<LlmModelState>({
      baseUrl: this.baseUrl,
      paths: ["/llm/model"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
  }

  async setLlmModel(model: string): Promise<LlmModelState> {
    return requestJson<LlmModelState>({
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

  async getIndexCapabilities(): Promise<RemoteIndexCapabilities> {
    return requestJson<RemoteIndexCapabilities>({
      baseUrl: this.baseUrl,
      paths: ["/v1/index/capabilities"],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
  }

  async getIndexEvents(request: IndexEventQuery = {}): Promise<IndexEvent[]> {
    const response = await requestJson<IndexEventsResponse>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/events${toQueryString(toIndexEventQueryParams(request))}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.events;
  }

  async getIndexActivity(request: IndexActivityQuery = {}): Promise<IndexActivitySummary> {
    const response = await requestJson<IndexActivityResponse>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/activity${toQueryString(toIndexActivityQueryParams(request))}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.activity;
  }

  async listIndexSessions(request: IndexSessionQuery = {}): Promise<RemoteIndexStatus[]> {
    const response = await requestJson<RemoteIndexSessionsResponse>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/sessions${toQueryString(toIndexSessionQueryParams(request))}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.sessions;
  }

  async startIndexSession(request: StartRemoteIndexSessionRequest): Promise<RemoteIndexSession> {
    const response = await requestJson<{ ok: true; result: RemoteIndexSession }>({
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

  async sendManifestBatch(sessionId: string, entries: RemoteManifestEntry[]): Promise<RemoteManifestBatchResult> {
    const response = await requestJson<{ ok: true; result: RemoteManifestBatchResult }>({
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

  async uploadFileBatch(
    sessionId: string,
    metadata: RemoteFileBatchMetadata,
    files: RemoteFileContent[],
  ): Promise<RemoteFileBatchResult> {
    const multipart = buildMultipartMixed(metadata, files);
    const response = await requestJson<{ ok: true; result: RemoteFileBatchResult }>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/files/batch`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: {
        method: "POST",
        headers: { "Content-Type": multipart.contentType },
        body: new Blob([toArrayBuffer(multipart.body)]),
      },
    });
    return response.result;
  }

  async commitIndexSession(sessionId: string): Promise<RemoteIndexCommitResponse> {
    return requestJson<RemoteIndexCommitResponse>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/commit`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "POST" },
    });
  }

  async getIndexSessionStatus(sessionId: string): Promise<RemoteIndexStatus> {
    const response = await requestJson<{ ok: true; result: RemoteIndexStatus }>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}/status`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "GET" },
    });
    return response.result;
  }

  async abortIndexSession(sessionId: string): Promise<{ ok: true; session_id: string; phase: string }> {
    return requestJson<{ ok: true; session_id: string; phase: string }>({
      baseUrl: this.baseUrl,
      paths: [`/v1/index/sessions/${encodeURIComponent(sessionId)}`],
      fetchFn: this.fetchFn,
      defaultHeaders: this.defaultHeaders,
      basicAuth: this.basicAuth,
      init: { method: "DELETE" },
    });
  }

  private async abortIndexSessionQuietly(sessionId: string): Promise<void> {
    try {
      await this.abortIndexSession(sessionId);
    } catch {
      // Best effort: preserve the original indexing failure for callers.
    }
  }

  async indexWorkspace(request: IndexWorkspaceRequest): Promise<RemoteIndexCommitResponse> {
    const remoteFiles = await Promise.all(request.files.map(prepareRemoteWorkspaceFile));
    const session = await this.startIndexSession(request);
    try {
      const manifestEntries: RemoteManifestEntry[] = [
        ...remoteFiles.map(({ file, content, sha256, mtimeNs }) => ({
          relativePath: file.relativePath,
          op: "upsert" as const,
          size: content.byteLength,
          mtimeNs,
          sha256,
        })),
        ...(request.deletedPaths ?? []).map((relativePath) => ({
          relativePath,
          op: "delete" as const,
        })),
      ];
      const manifestResult = await this.sendManifestBatch(session.session_id, manifestEntries);
      const uploadRequired = new Set(manifestResult.upload_required);
      const filesToUpload = remoteFiles.filter(({ file }) => uploadRequired.has(file.relativePath));
      if (filesToUpload.length > 0) {
        const uploadBatches = buildUploadBatches(
          filesToUpload,
          request.batchBytes ?? session.max_batch_bytes,
        );
        await runWithConcurrency(
          uploadBatches,
          request.maxConcurrentUploads ?? session.max_concurrent_uploads,
          async (batchFiles) => {
            await this.uploadFileBatch(
              session.session_id,
              { files: batchFiles.map((file) => file.descriptor) },
              batchFiles,
            );
          },
        );
      }
      return await this.commitIndexSession(session.session_id);
    } catch (error) {
      await this.abortIndexSessionQuietly(session.session_id);
      throw error;
    }
  }
}

export function toEnhancePayload(request: string | EnhancePromptRequest): EnhancePromptPayload {
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

export function toQueryPayload(request: string | QueryPromptRequest): QueryPromptPayload {
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

export function toStartIndexSessionPayload(request: StartRemoteIndexSessionRequest): Record<string, unknown> {
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

export function manifestEntriesToJsonl(entries: RemoteManifestEntry[]): string {
  return entries.map((entry) => JSON.stringify(toRemoteManifestEntryPayload(entry))).join("\n") + "\n";
}

function toRemoteManifestEntryPayload(entry: RemoteManifestEntry): Record<string, unknown> {
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

function toRemoteFileDescriptorPayload(descriptor: RemoteFileContent["descriptor"]): Record<string, unknown> {
  return {
    relative_path: descriptor.relativePath,
    content_id: descriptor.contentId,
    size: descriptor.size,
    sha256: descriptor.sha256,
    mtime_ns: descriptor.mtimeNs,
  };
}

function buildMultipartMixed(
  metadata: RemoteFileBatchMetadata,
  files: RemoteFileContent[],
): { contentType: string; body: Uint8Array } {
  const boundary = `corpuswire-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const pushText = (value: string) => chunks.push(encoder.encode(value));

  pushText(`--${boundary}\r\nContent-Type: application/json\r\nContent-ID: <metadata>\r\n\r\n`);
  pushText(JSON.stringify({ files: metadata.files.map(toRemoteFileDescriptorPayload) }));
  pushText("\r\n");

  for (const file of files) {
    pushText(
      `--${boundary}\r\nContent-Type: ${file.contentType ?? "application/octet-stream"}\r\nContent-ID: <${file.descriptor.contentId}>\r\n\r\n`,
    );
    chunks.push(toUint8Array(file.content));
    pushText("\r\n");
  }
  pushText(`--${boundary}--\r\n`);

  return {
    contentType: `multipart/mixed; boundary=${boundary}`,
    body: concatUint8Arrays(chunks),
  };
}

async function prepareRemoteWorkspaceFile(
  file: RemoteWorkspaceFile,
): Promise<{ file: RemoteWorkspaceFile; content: Uint8Array; sha256: string; mtimeNs: number }> {
  const content = toUint8Array(file.content);
  return {
    file,
    content,
    sha256: file.sha256 ?? await sha256Hex(content),
    mtimeNs: file.mtimeNs ?? Date.now() * 1_000_000,
  };
}

function buildUploadBatches(
  files: Array<{ file: RemoteWorkspaceFile; content: Uint8Array; sha256: string; mtimeNs: number }>,
  batchBytes: number,
): RemoteFileContent[][] {
  const maxBatchBytes = Math.max(1, Math.floor(batchBytes));
  const batches: RemoteFileContent[][] = [];
  let currentBatch: RemoteFileContent[] = [];
  let currentBytes = 0;
  let fileIndex = 0;

  for (const preparedFile of files) {
    const nextFile = toRemoteFileContent(preparedFile, `file-${fileIndex}`);
    fileIndex += 1;
    if (currentBatch.length > 0 && currentBytes + preparedFile.content.byteLength > maxBatchBytes) {
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

function toRemoteFileContent(
  preparedFile: { file: RemoteWorkspaceFile; content: Uint8Array; sha256: string; mtimeNs: number },
  contentId: string,
): RemoteFileContent {
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

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const maxConcurrency = Math.max(1, Math.floor(concurrency));
  let nextIndex = 0;
  async function runNext(): Promise<void> {
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

async function sha256Hex(content: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Remote indexWorkspace requires sha256 values when Web Crypto is unavailable.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toUint8Array(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function removeUndefinedValues<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function toIndexEventQueryParams(request: IndexEventQuery): Record<string, string | undefined> {
  return {
    workspace_id: request.workspaceId,
    collection: request.collection,
    status: request.status,
    operation: request.operation,
    limit: request.limit === undefined ? undefined : String(request.limit),
  };
}

function toIndexActivityQueryParams(request: IndexActivityQuery): Record<string, string | undefined> {
  return {
    workspace_id: request.workspaceId,
    collection: request.collection,
    window_hours: request.windowHours === undefined ? undefined : String(request.windowHours),
    expected_interval_seconds: request.expectedIntervalSeconds === undefined ? undefined : String(request.expectedIntervalSeconds),
  };
}

function toIndexSessionQueryParams(request: IndexSessionQuery): Record<string, string | undefined> {
  return {
    workspace_id: request.workspaceId,
  };
}

function toQueryString(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function resolveEnhancedPrompt(result: PromptRewriteResult): string | null {
  return result.enhanced_prompt ?? result.enhancement_prompt ?? null;
}

export function requireEnhancedPrompt(result: PromptRewriteResult): string {
  const prompt = resolveEnhancedPrompt(result);
  if (prompt) {
    return prompt;
  }

  throw new Error(result.generation_error ?? "Backend returned no enhanced prompt.");
}
