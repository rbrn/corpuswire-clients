#!/usr/bin/env node

import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, watch as watchFileSystem } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const JSONRPC_VERSION = "2.0";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "corpuswire-context-engine";
const SERVER_VERSION = "0.1.3";
const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_OUTPUT_MODE = "generic";
const DEFAULT_TOP_K = 5;
const DEFAULT_SYNC_DEBOUNCE_MS = 1000;
const DEFAULT_SYNC_READ_FLUSH_TIMEOUT_MS = 250;
const DEFAULT_SYNC_FLUSH_TIMEOUT_MS = 60000;
const DEFAULT_SYNC_BOOTSTRAP_TIMEOUT_MS = 5000;
const DEFAULT_SYNC_GIT_TIMEOUT_MS = 5000;
const DEFAULT_SYNC_GIT_MAX_FILES = 1000;
const DEFAULT_SYNC_GIT_MAX_STATUS_BYTES = 1024 * 1024;
const DEFAULT_SYNC_MAX_FILE_SIZE_BYTES = 512 * 1024;
const DEFAULT_SYNC_MAX_PENDING_PATHS = 100;
const DEFAULT_SYNC_RECONCILE_MAX_FILES = 5000;
const DEFAULT_SYNC_SESSION_CONFLICT_RETRY_ATTEMPTS = 5;
const DEFAULT_SYNC_SESSION_CONFLICT_RETRY_DELAY_MS = 750;
const DEFAULT_SYNC_SESSION_CONFLICT_RETRY_MAX_DELAY_MS = 5000;
const DEFAULT_SYNC_RECENT_EVENTS_LIMIT = 25;
const DEFAULT_SYNC_LATENCY_SAMPLE_LIMIT = 20;
const DEFAULT_SYNC_CACHE_SCHEMA_VERSION = 1;
const DIRECTORY_GLOB_PROBE = "__corpuswire_directory_probe__";
const OUTPUT_MODES = new Set(["generic", "copilot", "claude-code", "sequential"]);
const QUALITY_WORK_TYPES = Object.freeze([
  "semantic_retrieval",
  "prompt_enhancement",
  "review_context",
]);
const QUALITY_WORK_TYPE_SET = new Set(QUALITY_WORK_TYPES);
const INDEX_OBSERVABILITY_SCHEMA_VERSION = "index-observability/v1";
const INDEX_OBSERVABILITY_HEADER = "X-CorpusWire-Index-Observability";
const INDEX_OBSERVABILITY_STAGES = new Set([
  "mcp_receipt", "server_receipt", "queue_wait", "file_discovery", "file_read",
  "filtering_hashing", "parsing_chunking", "model_wait", "embedding_batch",
  "vector_writes", "cleanup",
]);
const INDEXABLE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".csv",
  ".pdf",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".py",
  ".pyi",
  ".sh",
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".html",
  ".htm",
  ".tf",
  ".hcl",
  ".bat",
  ".json",
  ".jsonl",
  ".ndjson",
  ".toml",
  ".yaml",
  ".yml",
]);
const INDEXABLE_FILENAMES = new Set(["gradlew", "mvnw"]);
const DISCOVERY_ONLY_FILENAMES = new Set([
  ".terraform.lock.hcl",
  "angular.json",
  "bun.lock",
  "bun.lockb",
  "build.gradle",
  "build.gradle.kts",
  "dependencies.lock",
  "gradle.lockfile",
  "gradle.properties",
  "jsconfig.json",
  "libs.versions.toml",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pdm.lock",
  "pipfile",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pom.xml",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "settings.gradle",
  "settings.gradle.kts",
  "uv.lock",
  "yarn.lock",
]);
const EXCLUDED_PATH_SEGMENTS = new Set([
  ".git",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".qdrant",
]);
const SAFE_INDEXABLE_PATHS = new Set([".vscode/mcp.json.example"]);
const CONFIG_EXAMPLE_SUFFIXES = new Set([".json.example"]);

const execFileAsync = promisify(execFile);
const sdk = await loadSdk();

class JsonRpcError extends Error {
  constructor(code, message, data = undefined) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

async function loadSdk() {
  const configuredPath = process.env.CORPUSWIRE_SDK_PATH;
  const sdkCandidates = configuredPath
    ? [pathToImportUrl(configuredPath)]
    : [
        new URL("../vendor/corpuswire-sdk/dist/index.js", import.meta.url).href,
        "@corpuswire/sdk",
        new URL("../../../clients/corpuswire-sdk/dist/index.js", import.meta.url).href,
      ];

  const failures = [];
  for (const sdkUrl of sdkCandidates) {
    try {
      return await import(sdkUrl);
    } catch (error) {
      failures.push(`${sdkUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Could not load @corpuswire/sdk. Tried: ${failures.join("; ")}`);
}

function pathToImportUrl(value) {
  if (value.startsWith("file:") || value.startsWith("node:")) {
    return value;
  }

  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return new URL(`file://${value}`).href;
  }

  return value;
}

class SyncManager {
  constructor(env = process.env) {
    this.env = env;
    this.pendingChangedPaths = new Map();
    this.pendingDeletedPaths = new Set();
    this.pendingRetryBatches = [];
    this.pendingContext = null;
    this.timer = null;
    this.activeFlush = null;
    this.activeReconcile = null;
    this.activeBootstrapCheck = null;
    this.activeGitDelta = null;
    this.watcher = null;
    this.reconcileTimer = null;
    this.lastResult = null;
    this.lastError = null;
    this.lastFlushStartedAt = null;
    this.lastFlushFinishedAt = null;
    this.lastReconcileStartedAt = null;
    this.lastReconcileFinishedAt = null;
    this.lastGitScanStartedAt = null;
    this.lastGitScanFinishedAt = null;
    this.lastGitScanDurationMs = null;
    this.lastGitHead = null;
    this.lastGitBranch = null;
    this.lastGitDeltaCounts = null;
    this.lastEventAt = null;
    this.firstQueuedAt = null;
    this.lastFlushDurationMs = null;
    this.lastReconcileDurationMs = null;
    this.flushDurationSamplesMs = [];
    this.recentEvents = [];
    this.acceptedEventCounts = { changed: 0, deleted: 0 };
    this.skippedEventCounts = {};
    this.cacheState = null;
    this.cacheDecisionCounts = {};
    this.bootstrapStatus = initialBootstrapStatus();
    this.sessionConflictRetryCounts = { retries: 0, exhausted: 0 };
    this.lastSessionConflictAt = null;
    this.lastSessionConflictOperation = null;
    this.lastSessionConflictAttempt = null;
    this.lastSessionConflictRetryDelayMs = null;
    this.lastSessionConflictMessage = null;
    this.supportedFileRegistryVersion = "fallback-v1";
    this.indexableExtensions = new Set(INDEXABLE_EXTENSIONS);
    this.indexableFilenames = new Set(INDEXABLE_FILENAMES);
    this.supportedFileCapabilitiesPromise = null;
  }

  startWatcherIfConfigured() {
    if (!this.isEnabled() || !optionalBoolean(this.env.CORPUSWIRE_SYNC_WATCH, false)) {
      return;
    }

    let context;
    try {
      context = this.resolveContext({});
    } catch (error) {
      this.recordError(error);
      return;
    }

    try {
      this.watcher = watchFileSystem(context.sourceRoot, { recursive: true }, (_eventType, filename) => {
        if (!filename) {
          return;
        }
        const absolutePath = path.resolve(context.sourceRoot, String(filename));
        const delta = existsSync(absolutePath)
          ? { changedPaths: [absolutePath], deletedPaths: [] }
          : { changedPaths: [], deletedPaths: [absolutePath] };
        this.addDelta({
          ...delta,
          sourceRoot: context.sourceRoot,
          workspaceId: context.workspaceId,
          eventSource: "watcher",
        }).catch((error) => this.recordError(error));
      });
      if (typeof this.watcher.unref === "function") {
        this.watcher.unref();
      }
    } catch (error) {
      this.recordError(error);
    }
  }

  startScheduledReconcileIfConfigured() {
    if (!this.isEnabled()) {
      return;
    }
    const intervalMs = optionalNonNegativeInteger(this.env.CORPUSWIRE_SYNC_RECONCILE_INTERVAL_MS, 0);
    if (intervalMs <= 0) {
      return;
    }

    this.reconcileTimer = setInterval(() => {
      if (this.activeReconcile) {
        return;
      }
      this.reconcileExplicit({ maxWaitMs: DEFAULT_SYNC_FLUSH_TIMEOUT_MS }).catch((error) => this.recordError(error));
    }, intervalMs);
    if (typeof this.reconcileTimer.unref === "function") {
      this.reconcileTimer.unref();
    }
  }

  startBootstrapCheckIfConfigured() {
    if (!this.isEnabled() || !optionalBoolean(this.env.CORPUSWIRE_SYNC_BOOTSTRAP_CHECK, false)) {
      return;
    }

    this.activeBootstrapCheck = this.bootstrapExplicit({
      maxWaitMs: optionalPositiveInteger(
        this.env.CORPUSWIRE_SYNC_BOOTSTRAP_TIMEOUT_MS,
        DEFAULT_SYNC_BOOTSTRAP_TIMEOUT_MS,
      ),
    })
      .catch((error) => {
        this.recordError(error, "bootstrap");
        this.recordBootstrapStatus(bootstrapStatusFromError(error));
      })
      .finally(() => {
        this.activeBootstrapCheck = null;
      });
  }

  isEnabled() {
    return optionalBoolean(this.env.CORPUSWIRE_SYNC_ENABLED, false) && this.syncCapability().allowed;
  }

  syncCapability() {
    try {
      const policy = resolveBackendPolicy(this.env);
      if (policy.isLocal || policy.remoteSyncEnabled) {
        return { allowed: true, reason: null, backendMode: policy.isLocal ? "local" : "remote" };
      }
      return {
        allowed: false,
        reason: "Remote workspace sync requires CORPUSWIRE_REMOTE_SYNC_ENABLED=true.",
        backendMode: "remote",
      };
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : String(error),
        backendMode: "invalid",
      };
    }
  }

  disabledReason(operation) {
    if (!optionalBoolean(this.env.CORPUSWIRE_SYNC_ENABLED, false)) {
      return `Set CORPUSWIRE_SYNC_ENABLED=true to enable ${operation}.`;
    }
    return this.syncCapability().reason ?? `CorpusWire sync is unavailable for ${operation}.`;
  }

  isCacheEnabled() {
    return optionalBoolean(
      this.env.CORPUSWIRE_SYNC_MTIME_CACHE_ENABLED ?? this.env.CORPUSWIRE_SYNC_CACHE_ENABLED,
      false,
    );
  }

  async refreshSupportedFileCapabilities() {
    if (this.supportedFileCapabilitiesPromise) {
      return this.supportedFileCapabilitiesPromise;
    }
    this.supportedFileCapabilitiesPromise = (async () => {
      const client = buildClient();
      if (typeof client.getIndexCapabilities !== "function") {
        return;
      }
      try {
        const capabilities = asRecord(await client.getIndexCapabilities());
        const extensions = boundedSupportedFileValues(
          capabilities.supported_extensions,
          /^\\.[a-z0-9.]+$/,
        );
        const filenames = boundedSupportedFileValues(
          capabilities.supported_filenames,
          /^[a-z0-9][a-z0-9._-]*$/,
        );
        if (extensions.length > 0) {
          this.indexableExtensions = new Set(extensions);
        }
        if (Array.isArray(capabilities.supported_filenames)) {
          this.indexableFilenames = new Set(filenames);
        }
        if (typeof capabilities.supported_file_registry_version === "string") {
          this.supportedFileRegistryVersion = capabilities.supported_file_registry_version.slice(0, 128);
        }
      } catch {
        // The local fallback remains safe when an older server lacks capabilities.
      }
    })();
    return this.supportedFileCapabilitiesPromise;
  }

  isCacheUsable() {
    if (!this.isCacheEnabled()) {
      return false;
    }
    if (optionalBoolean(this.env.CORPUSWIRE_SYNC_BOOTSTRAP_CHECK, false)) {
      if (this.activeBootstrapCheck || !this.bootstrapStatus.checkedAt) {
        return false;
      }
    }
    return this.bootstrapStatus.state !== "error" && this.bootstrapStatus.needsReconcile !== true;
  }

  async probePaths(args = {}) {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        reason: this.disabledReason("sync path probing"),
        results: [],
        status: this.snapshot(),
      };
    }

    await this.refreshSupportedFileCapabilities();
    const context = this.resolveContext(args);
    const paths = optionalStringArray(args, "paths", "changedPaths", "changed_paths");
    if (paths.length === 0) {
      throw new JsonRpcError(-32602, "Invalid params: paths must contain at least one path.");
    }

    const maxPaths = Math.min(optionalPositiveInteger(args.maxPaths ?? args.max_paths, 100), 500);
    const includeHash = optionalBoolean(args.includeHash ?? args.include_hash, false);
    const maxFileSizeBytes = optionalPositiveInteger(
      this.env.CORPUSWIRE_SYNC_MAX_FILE_SIZE_BYTES,
      DEFAULT_SYNC_MAX_FILE_SIZE_BYTES,
    );
    const selectedPaths = paths.slice(0, maxPaths);
    const results = [];
    for (const rawPath of selectedPaths) {
      results.push(await this.probePath(rawPath, context, { includeHash, maxFileSizeBytes }));
    }

    return {
      enabled: true,
      sourceRoot: context.sourceRoot,
      workspaceId: context.workspaceId,
      requestedPaths: paths.length,
      probedPaths: selectedPaths.length,
      truncated: paths.length > selectedPaths.length,
      includeHash,
      maxFileSizeBytes,
      results,
      status: this.snapshot(),
    };
  }

  async probePath(rawPath, context, { includeHash, maxFileSizeBytes }) {
    const classified = this.classifyPath(rawPath, context);
    const result = {
      rawPath,
      relativePath: classified.relativePath ?? null,
      pathAccepted: classified.accepted,
      decision: classified.accepted ? "stat_pending" : "skipped",
      reason: classified.reason,
    };
    if (!classified.accepted) {
      return result;
    }

    try {
      const fileStat = await stat(classified.absolutePath);
      const mtimeNs = Math.trunc(fileStat.mtimeMs * 1_000_000);
      Object.assign(result, {
        exists: true,
        isFile: fileStat.isFile(),
        sizeBytes: fileStat.size,
        mtimeNs,
      });
      if (!fileStat.isFile()) {
        return { ...result, decision: "skipped", reason: "not_file" };
      }
      if (fileStat.size > maxFileSizeBytes) {
        return { ...result, decision: "skipped", reason: "too_large" };
      }
      if (includeHash) {
        const content = await readFile(classified.absolutePath);
        result.sha256 = createHash("sha256").update(content).digest("hex");
      }
      return { ...result, decision: "upload_candidate", reason: "accepted" };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { ...result, exists: false, decision: "delete_candidate", reason: "missing_file" };
      }
      throw error;
    }
  }

  async addDelta(args) {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        reason: this.disabledReason("incremental sync"),
        status: this.snapshot(),
      };
    }

    await this.refreshSupportedFileCapabilities();
    const context = this.resolveContext(args);
    const changedPaths = optionalStringArray(args, "changedPaths", "changed_paths");
    const deletedPaths = optionalStringArray(args, "deletedPaths", "deleted_paths");
    const acceptedChanged = [];
    const acceptedDeleted = [];
    const skipped = [];
    const eventSource = optionalString(args.eventSource ?? args.event_source) ?? "delta";

    this.ensurePendingContext(context);

    for (const rawPath of changedPaths) {
      const normalized = this.classifyPath(rawPath, context);
      if (!normalized.accepted) {
        skipped.push(rawPath);
        this.recordSyncEvent({
          source: eventSource,
          eventType: "changed",
          rawPath,
          relativePath: normalized.relativePath,
          decision: "skipped",
          reason: normalized.reason,
        });
        continue;
      }
      this.pendingChangedPaths.set(normalized.relativePath, normalized.absolutePath);
      this.pendingDeletedPaths.delete(normalized.relativePath);
      acceptedChanged.push(normalized.relativePath);
      this.markQueueNonEmpty();
      this.recordSyncEvent({
        source: eventSource,
        eventType: "changed",
        rawPath,
        relativePath: normalized.relativePath,
        decision: "accepted",
        reason: "accepted",
      });
    }

    for (const rawPath of deletedPaths) {
      const normalized = this.classifyPath(rawPath, context);
      if (!normalized.accepted) {
        skipped.push(rawPath);
        this.recordSyncEvent({
          source: eventSource,
          eventType: "deleted",
          rawPath,
          relativePath: normalized.relativePath,
          decision: "skipped",
          reason: normalized.reason,
        });
        continue;
      }
      this.pendingChangedPaths.delete(normalized.relativePath);
      this.pendingDeletedPaths.add(normalized.relativePath);
      acceptedDeleted.push(normalized.relativePath);
      this.markQueueNonEmpty();
      this.recordSyncEvent({
        source: eventSource,
        eventType: "deleted",
        rawPath,
        relativePath: normalized.relativePath,
        decision: "accepted",
        reason: "accepted",
      });
    }

    const shouldFlush = optionalBoolean(args.flush, false);
    if (shouldFlush) {
      const flush = await this.flushAll({
        maxWaitMs: optionalPositiveInteger(args.maxWaitMs, DEFAULT_SYNC_FLUSH_TIMEOUT_MS),
        processingTimeoutMs: optionalPositiveInteger(
          args.processingTimeoutMs ?? args.processing_timeout_ms,
          undefined,
        ),
      });
      return {
        enabled: true,
        acceptedChanged,
        acceptedDeleted,
        skipped,
        flushReason: "explicit",
        flush,
        status: this.snapshot(),
      };
    }

    const maxPendingPaths = optionalPositiveInteger(
      args.maxPendingPaths ?? args.max_pending_paths ?? this.env.CORPUSWIRE_SYNC_MAX_PENDING_PATHS,
      DEFAULT_SYNC_MAX_PENDING_PATHS,
    );
    if (this.pendingSize() >= maxPendingPaths) {
      const flush = await this.flushAll({
        maxWaitMs: optionalPositiveInteger(args.maxWaitMs, DEFAULT_SYNC_FLUSH_TIMEOUT_MS),
        processingTimeoutMs: optionalPositiveInteger(
          args.processingTimeoutMs ?? args.processing_timeout_ms,
          undefined,
        ),
      });
      return {
        enabled: true,
        acceptedChanged,
        acceptedDeleted,
        skipped,
        flushReason: "buffer_full",
        flush,
        status: this.snapshot(),
      };
    }

    this.scheduleFlush(
      optionalPositiveInteger(
        args.debounceMs ?? this.env.CORPUSWIRE_SYNC_DEBOUNCE_MS,
        DEFAULT_SYNC_DEBOUNCE_MS,
      ),
    );
    return {
      enabled: true,
      acceptedChanged,
      acceptedDeleted,
      skipped,
      status: this.snapshot(),
    };
  }

  async flushExplicit(args = {}, onProgress = undefined) {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        reason: this.disabledReason("incremental sync"),
        status: this.snapshot(),
      };
    }
    return this.flushAll({
      maxWaitMs: optionalPositiveInteger(args.maxWaitMs, DEFAULT_SYNC_FLUSH_TIMEOUT_MS),
      processingTimeoutMs: optionalPositiveInteger(
        args.processingTimeoutMs ?? args.processing_timeout_ms,
        undefined,
      ),
      onProgress,
    });
  }

  async flushBeforeRead() {
    if (!this.isEnabled() || !optionalBoolean(this.env.CORPUSWIRE_SYNC_FLUSH_BEFORE_READ, true)) {
      return null;
    }
    try {
      return await this.flushAll({
        maxWaitMs: optionalPositiveInteger(
          this.env.CORPUSWIRE_SYNC_READ_FLUSH_TIMEOUT_MS,
          DEFAULT_SYNC_READ_FLUSH_TIMEOUT_MS,
        ),
      });
    } catch (error) {
      this.recordError(error);
      return {
        enabled: true,
        flushed: false,
        error: error instanceof Error ? error.message : String(error),
        status: this.snapshot(),
      };
    }
  }

  async prepareForRead(args = {}) {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        freshness: this.readFreshnessStatus(),
      };
    }

    const flush = await this.flushBeforeRead();
    let gitDelta = null;
    if (optionalBoolean(this.env.CORPUSWIRE_SYNC_GIT_DELTA_BEFORE_READ, false)) {
      gitDelta = await this.gitDeltaExplicit({
        sourceRoot: args.sourceRoot ?? args.source_root,
        workspaceId: args.workspaceId ?? args.workspace_id,
        repoPath: args.repoPath ?? args.repo_path,
        includeGlobs: args.includeGlobs ?? args.include_globs,
        excludeGlobs: args.excludeGlobs ?? args.exclude_globs,
        flush: true,
        maxWaitMs: optionalPositiveInteger(
          this.env.CORPUSWIRE_SYNC_READ_GIT_TIMEOUT_MS ?? this.env.CORPUSWIRE_SYNC_GIT_TIMEOUT_MS,
          DEFAULT_SYNC_GIT_TIMEOUT_MS,
        ),
        flushMaxWaitMs: optionalPositiveInteger(
          this.env.CORPUSWIRE_SYNC_READ_FLUSH_TIMEOUT_MS,
          DEFAULT_SYNC_READ_FLUSH_TIMEOUT_MS,
        ),
      });
    }
    if (optionalBoolean(this.env.CORPUSWIRE_SYNC_READ_FRESHNESS_CHECK, false)) {
      const maxWaitMs = optionalPositiveInteger(
        this.env.CORPUSWIRE_SYNC_READ_FRESHNESS_TIMEOUT_MS ?? this.env.CORPUSWIRE_SYNC_BOOTSTRAP_TIMEOUT_MS,
        DEFAULT_SYNC_BOOTSTRAP_TIMEOUT_MS,
      );
      const checked = await awaitWithTimeout(this.refreshBootstrapStatus(args), maxWaitMs);
      if (checked.timedOut) {
        this.recordBootstrapStatus(bootstrapStatusForTimeout(maxWaitMs));
      }
    }

    const freshness = this.readFreshnessStatus();
    if (freshness.strictBlocked) {
      throw new Error(`Read-side freshness strict mode blocked retrieval: ${freshness.reason}`);
    }
    return {
      enabled: true,
      flush,
      gitDelta,
      freshness,
      status: this.snapshot(),
    };
  }

  readFreshnessStatus() {
    const strict = optionalBoolean(this.env.CORPUSWIRE_SYNC_READ_STRICT, false);
    const staleAfterMs = optionalNonNegativeInteger(
      this.env.CORPUSWIRE_SYNC_READ_STRICT_STALE_AFTER_MS,
      0,
    );
    const checkedAt = this.bootstrapStatus.checkedAt;
    const checkedAtMs = checkedAt ? Date.parse(checkedAt) : NaN;
    const freshnessAgeMs = Number.isFinite(checkedAtMs) ? Math.max(0, Date.now() - checkedAtMs) : null;
    const isStaleForStrict = this.bootstrapStatus.needsReconcile === true
      && (staleAfterMs === 0 || (freshnessAgeMs !== null && freshnessAgeMs >= staleAfterMs));
    return {
      state: this.bootstrapStatus.state,
      needsReconcile: this.bootstrapStatus.needsReconcile,
      checkedAt,
      ageMs: freshnessAgeMs,
      reason: this.bootstrapStatus.reason,
      strict,
      strictStaleAfterMs: staleAfterMs,
      strictBlocked: strict && isStaleForStrict,
    };
  }

  async reconcileExplicit(args = {}, onProgress = undefined) {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        reason: this.disabledReason("reconciliation"),
        status: this.snapshot(),
      };
    }

    const maxWaitMs = optionalPositiveInteger(args.maxWaitMs, DEFAULT_SYNC_FLUSH_TIMEOUT_MS);
    let latestProgress;
    const reportProgress = (event) => {
      latestProgress = event;
      onProgress?.(event);
    };
    const reconciliation = this.reconcileAll(args, reportProgress);
    const waited = await awaitWithTimeout(reconciliation, maxWaitMs);
    if (waited.timedOut) {
      const sessionId = latestProgress?.session_id === "pending"
        ? undefined
        : latestProgress?.session_id;
      return {
        enabled: true,
        reconciled: false,
        timedOut: true,
        backendContinues: true,
        sessionId,
        reattach: sessionId
          ? `corpuswire index --attach ${sessionId}`
          : "Inspect corpuswire_sync_sessions and attach to the active workspace session.",
        status: this.snapshot(),
      };
    }
    const reconcileResult = waited.value;
    return {
      enabled: true,
      reconciled: reconcileResult?.ok !== false,
      timedOut: false,
      reconcile: reconcileResult,
      status: this.snapshot(),
    };
  }

  async gitDeltaExplicit(args = {}) {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        reason: this.disabledReason("git delta reconciliation"),
        status: this.snapshot(),
      };
    }

    const maxWaitMs = optionalPositiveInteger(
      args.maxWaitMs ?? args.max_wait_ms ?? this.env.CORPUSWIRE_SYNC_GIT_TIMEOUT_MS,
      DEFAULT_SYNC_GIT_TIMEOUT_MS,
    );
    if (!this.activeGitDelta) {
      this.activeGitDelta = this.runGitDelta(args)
        .catch((error) => {
          this.recordError(error, "git");
          return {
            enabled: true,
            scanned: false,
            error: error instanceof Error ? error.message : String(error),
            status: this.snapshot(),
          };
        })
        .finally(() => {
          this.activeGitDelta = null;
        });
    }

    const waited = await awaitWithTimeout(this.activeGitDelta, maxWaitMs);
    if (waited.timedOut) {
      return {
        enabled: true,
        scanned: false,
        timedOut: true,
        status: this.snapshot(),
      };
    }
    return waited.value;
  }

  async runGitDelta(args = {}) {
    const startedAt = Date.now();
    this.lastGitScanStartedAt = new Date(startedAt).toISOString();
    const context = this.resolveContext(args);
    const maxFiles = optionalPositiveInteger(
      args.maxFiles ?? args.max_files ?? this.env.CORPUSWIRE_SYNC_GIT_MAX_FILES,
      DEFAULT_SYNC_GIT_MAX_FILES,
    );
    const entries = await this.collectGitStatusEntries(context, {
      maxFiles,
      timeoutMs: optionalPositiveInteger(
        args.gitTimeoutMs ?? args.git_timeout_ms ?? this.env.CORPUSWIRE_SYNC_GIT_TIMEOUT_MS,
        DEFAULT_SYNC_GIT_TIMEOUT_MS,
      ),
      maxStatusBytes: optionalPositiveInteger(
        args.maxStatusBytes ?? args.max_status_bytes ?? this.env.CORPUSWIRE_SYNC_GIT_MAX_STATUS_BYTES,
        DEFAULT_SYNC_GIT_MAX_STATUS_BYTES,
      ),
    });
    const delta = gitStatusEntriesToDelta(entries);
    const metadata = await this.readGitMetadata(context.sourceRoot);
    this.lastGitHead = metadata.git_head ?? null;
    this.lastGitBranch = metadata.git_branch ?? null;
    this.lastGitDeltaCounts = {
      statusEntries: entries.length,
      changed: delta.changedPaths.length,
      deleted: delta.deletedPaths.length,
      renamed: delta.renamed,
      copied: delta.copied,
      untracked: delta.untracked,
    };
    this.lastGitScanFinishedAt = new Date().toISOString();
    this.lastGitScanDurationMs = Date.now() - startedAt;

    const sync = await this.addDelta({
      sourceRoot: context.sourceRoot,
      workspaceId: context.workspaceId,
      includeGlobs: context.includeGlobs,
      excludeGlobs: context.excludeGlobs,
      changedPaths: delta.changedPaths,
      deletedPaths: delta.deletedPaths,
      flush: optionalBoolean(args.flush, false),
      maxWaitMs: optionalPositiveInteger(args.flushMaxWaitMs ?? args.maxWaitMs, DEFAULT_SYNC_FLUSH_TIMEOUT_MS),
      eventSource: "git",
    });

    return {
      enabled: true,
      scanned: true,
      timedOut: false,
      git: {
        statusEntries: entries.length,
        changedPaths: delta.changedPaths,
        deletedPaths: delta.deletedPaths,
        renamed: delta.renamed,
        copied: delta.copied,
        untracked: delta.untracked,
        head: this.lastGitHead,
        branch: this.lastGitBranch,
      },
      sync,
      status: this.snapshot(),
    };
  }

  async bootstrapExplicit(args = {}) {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        checked: false,
        reason: this.disabledReason("bootstrap freshness checks"),
        bootstrap: this.bootstrapStatus,
        status: this.snapshot(),
      };
    }

    const maxWaitMs = optionalPositiveInteger(
      args.maxWaitMs ?? args.max_wait_ms ?? this.env.CORPUSWIRE_SYNC_BOOTSTRAP_TIMEOUT_MS,
      DEFAULT_SYNC_BOOTSTRAP_TIMEOUT_MS,
    );
    const checked = await awaitWithTimeout(this.refreshBootstrapStatus(args), maxWaitMs);
    if (checked.timedOut) {
      this.recordBootstrapStatus(bootstrapStatusForTimeout(maxWaitMs));
      return {
        enabled: true,
        checked: false,
        timedOut: true,
        reconciled: false,
        bootstrap: this.bootstrapStatus,
        status: this.snapshot(),
      };
    }

    let reconcileResult = null;
    if (optionalBoolean(args.reconcile ?? args.runReconcile ?? args.run_reconcile, false)) {
      reconcileResult = await this.reconcileExplicit(args);
      const refreshed = await awaitWithTimeout(this.refreshBootstrapStatus(args), maxWaitMs);
      if (refreshed.timedOut) {
        this.recordBootstrapStatus(bootstrapStatusForTimeout(maxWaitMs));
      }
    }

    return {
      enabled: true,
      checked: true,
      timedOut: false,
      reconciled: reconcileResult?.reconciled ?? false,
      bootstrap: this.bootstrapStatus,
      reconcile: reconcileResult?.reconcile,
      status: this.snapshot(),
    };
  }

  async refreshBootstrapStatus(args = {}) {
    const context = this.resolveContext(args);
    const repoPath = firstNonEmptyString(
      args.repoPath,
      args.repo_path,
      this.env.CORPUSWIRE_REPO_PATH,
      context.sourceRoot,
    );
    const workspaceId = firstNonEmptyString(args.workspaceId, args.workspace_id, context.workspaceId);
    const client = buildClient();
    const diagnosis = typeof client.diagnoseWorkspace === "function"
      ? await client.diagnoseWorkspace({ repoPath, workspaceId })
      : diagnosisFromHealth(await client.health({ repoPath, workspaceId }), { repoPath, workspaceId });
    const bootstrapStatus = bootstrapStatusFromDiagnosis(diagnosis, { repoPath, workspaceId });
    this.recordBootstrapStatus(bootstrapStatus);
    return bootstrapStatus;
  }

  async reconcileAll(args = {}, onProgress = undefined) {
    if (this.activeReconcile) {
      return this.activeReconcile;
    }

    await this.refreshSupportedFileCapabilities();
    const context = this.resolveContext(args);
    this.activeReconcile = this.runReconcile(context, args, onProgress)
      .catch((error) => {
        this.recordError(error, "reconcile");
        this.lastReconcileFinishedAt = new Date().toISOString();
        return {
          ok: false,
          reconcile: true,
          error: error instanceof Error ? error.message : String(error),
          filesQueued: 0,
          filesUploaded: 0,
          filesDeleted: 0,
          filesSkipped: 0,
        };
      })
      .finally(() => {
        this.activeReconcile = null;
        if (this.hasPending()) {
          this.scheduleFlush(0);
        }
      });
    return this.activeReconcile;
  }

  async flushAll({ maxWaitMs, allowDuringReconcile = false, processingTimeoutMs = undefined, onProgress = undefined }) {
    const summaries = [];
    const deadline = Date.now() + maxWaitMs;
    let latestProgress;
    const reportProgress = (event) => {
      latestProgress = event;
      onProgress?.(event);
    };
    const timeoutResult = () => {
      const sessionId = latestProgress?.session_id === "pending"
        ? undefined
        : latestProgress?.session_id;
      return {
        enabled: true,
        flushed: summaries.length > 0,
        timedOut: true,
        backendContinues: Boolean(this.activeFlush || this.activeReconcile),
        sessionId,
        reattach: sessionId
          ? `corpuswire index --attach ${sessionId}`
          : "Inspect corpuswire_sync_sessions and attach to the active workspace session.",
        summaries,
        status: this.snapshot(),
      };
    };

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    while (true) {
      if (this.activeReconcile && !allowDuringReconcile) {
        const waited = await awaitWithTimeout(this.activeReconcile, Math.max(0, deadline - Date.now()));
        if (waited.timedOut) {
          return timeoutResult();
        }
        continue;
      }

      if (this.activeFlush) {
        const waited = await awaitWithTimeout(this.activeFlush, Math.max(0, deadline - Date.now()));
        if (waited.timedOut) {
          return timeoutResult();
        }
        summaries.push(waited.value);
        continue;
      }

      if (!this.hasPending()) {
        return {
          enabled: true,
          flushed: summaries.length > 0,
          timedOut: false,
          summaries,
          status: this.snapshot(),
        };
      }

      if (Date.now() >= deadline) {
        return timeoutResult();
      }

      const batch = this.takePendingBatch();
      const flush = this.runBatch(batch, { processingTimeoutMs, onProgress: reportProgress })
        .catch((error) => {
          if (error?.name === "RemoteIndexDetachedError") {
            this.recordError(error);
            return {
              ok: false,
              detached: true,
              backendContinues: true,
              sessionId: error.sessionId,
              error: error.message,
              filesQueued: batch.changedPaths.length,
              filesUploaded: batch.changedPaths.length,
              filesDeleted: batch.deletedPaths.length,
              filesSkipped: 0,
            };
          }
          this.requeueBatch(batch);
          this.scheduleFlush(DEFAULT_SYNC_DEBOUNCE_MS);
          this.recordError(error);
          return {
            ok: false,
            requeued: true,
            error: error instanceof Error ? error.message : String(error),
            filesQueued: batch.changedPaths.length,
            filesUploaded: 0,
            filesDeleted: batch.deletedPaths.length,
            filesSkipped: 0,
          };
        })
        .finally(() => {
          this.activeFlush = null;
        });
      this.activeFlush = flush;
      const waited = await awaitWithTimeout(flush, Math.max(0, deadline - Date.now()));
      if (waited.timedOut) {
        return timeoutResult();
      }
      summaries.push(waited.value);
      if (waited.value?.requeued) {
        return {
          enabled: true,
          flushed: summaries.length > 0,
          timedOut: false,
          summaries,
          status: this.snapshot(),
        };
      }
    }
  }

  scheduleFlush(debounceMs) {
    if (!this.hasPending()) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushAll({ maxWaitMs: DEFAULT_SYNC_FLUSH_TIMEOUT_MS }).catch((error) => this.recordError(error));
    }, debounceMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  async runBatch(batch, { processingTimeoutMs = undefined, onProgress = undefined } = {}) {
    const startedAt = Date.now();
    this.lastFlushStartedAt = new Date(startedAt).toISOString();
    const files = [];
    const cacheEntries = [];
    const deletedPaths = new Set(batch.deletedPaths);
    const skippedPaths = [];

    const fileReadStartedAt = Date.now();
    for (const entry of batch.changedPaths) {
      try {
        const remoteFile = await this.readRemoteFile(entry, batch, { useCache: true });
        if (remoteFile.file) {
          files.push(remoteFile.file);
          if (remoteFile.cacheEntry) {
            cacheEntries.push(remoteFile.cacheEntry);
          }
        } else if (remoteFile.deleted) {
          deletedPaths.add(entry.relativePath);
        } else {
          skippedPaths.push(entry.relativePath);
          this.recordSyncEvent({
            source: "flush",
            eventType: "changed",
            relativePath: entry.relativePath,
            decision: "skipped",
            reason: remoteFile.reason ?? "not_indexable_file",
          });
        }
      } catch (error) {
        if (isMissingFileError(error)) {
          deletedPaths.add(entry.relativePath);
          this.recordSyncEvent({
            source: "flush",
            eventType: "deleted",
            relativePath: entry.relativePath,
            decision: "accepted",
            reason: "missing_file",
          });
        } else {
          throw error;
        }
      }
    }
    const fileReadDurationMs = Date.now() - fileReadStartedAt;

    if (files.length === 0 && deletedPaths.size === 0) {
      const durationMs = Date.now() - startedAt;
      const observability = buildMcpIndexTrace({
        totalDurationMs: durationMs,
        fileReadDurationMs,
      });
      const result = {
        ok: true,
        noOp: true,
        filesQueued: batch.changedPaths.length,
        filesUploaded: 0,
        filesDeleted: 0,
        filesSkipped: skippedPaths.length,
        skippedPaths,
        durationMs,
        ...(observability ? { observability } : {}),
      };
      this.recordResult(result, "flush");
      return result;
    }

    const client = buildClient();
    if (typeof client.indexWorkspace !== "function") {
      throw new Error("@corpuswire/sdk does not expose indexWorkspace; update the SDK before enabling sync.");
    }

    const gitMetadata = await this.readGitMetadata(batch.sourceRoot);
    const response = await this.indexWorkspaceWithSessionConflictRetry(client, {
      workspace: {
        workspaceId: batch.workspaceId,
        displayRoot: batch.sourceRoot,
        name: path.basename(batch.sourceRoot),
      },
      mode: "incremental",
      client: removeUndefinedValues({
        name: SERVER_NAME,
        transport: "codex-mcp",
        sourceRoot: batch.sourceRoot,
        indexed_commit: optionalString(this.env.CORPUSWIRE_SYNC_INDEXED_COMMIT) ?? gitMetadata.git_head,
        git_head: gitMetadata.git_head,
        git_branch: gitMetadata.git_branch,
      }),
      maxConcurrentUploads: optionalPositiveInteger(
        this.env.CORPUSWIRE_SYNC_MAX_CONCURRENT_UPLOADS,
        undefined,
      ),
      processingTimeoutMs: optionalPositiveInteger(
        processingTimeoutMs,
        undefined,
      ),
      batchBytes: optionalPositiveInteger(this.env.CORPUSWIRE_SYNC_BATCH_BYTES, undefined),
      maxFileSizeBytes: optionalPositiveInteger(
        this.env.CORPUSWIRE_SYNC_MAX_FILE_SIZE_BYTES,
        DEFAULT_SYNC_MAX_FILE_SIZE_BYTES,
      ),
      files,
      deletedPaths: [...deletedPaths].sort(),
      onProgress,
    }, { operation: "flush" });

    await this.applySyncCacheUploadResult(batch, cacheEntries, deletedPaths, response);

    const durationMs = Date.now() - startedAt;
    const observability = buildMcpIndexTrace({
      client,
      response,
      totalDurationMs: durationMs,
      fileReadDurationMs,
    });
    const result = {
      ok: true,
      noOp: false,
      filesQueued: batch.changedPaths.length,
      filesUploaded: files.length,
      filesDeleted: deletedPaths.size,
      filesSkipped: skippedPaths.length,
      skippedPaths,
      response,
      durationMs,
      ...(observability ? { observability } : {}),
    };
    this.recordResult(result, "flush");
    return result;
  }

  async runReconcile(context, args, onProgress = undefined) {
    const startedAt = Date.now();
    this.lastReconcileStartedAt = new Date(startedAt).toISOString();
    const recreateCollection = optionalBoolean(
      args.recreateCollection ?? args.recreate_collection ?? this.env.CORPUSWIRE_SYNC_RECREATE_COLLECTION,
      false,
    );
    await this.flushAll({
      maxWaitMs: optionalPositiveInteger(args.flushMaxWaitMs, DEFAULT_SYNC_FLUSH_TIMEOUT_MS),
      allowDuringReconcile: true,
    });

    const maxFiles = optionalPositiveInteger(
      args.maxFiles ?? this.env.CORPUSWIRE_SYNC_RECONCILE_MAX_FILES,
      DEFAULT_SYNC_RECONCILE_MAX_FILES,
    );
    const discoveryStartedAt = Date.now();
    const changedPaths = await this.collectWorkspaceFileEntries(context, maxFiles);
    const fileDiscoveryDurationMs = Date.now() - discoveryStartedAt;
    const files = [];
    const skippedPaths = [];
    const fileReadStartedAt = Date.now();
    for (const entry of changedPaths) {
      try {
        const remoteFile = await this.readRemoteFile(entry, context, { useCache: false });
        if (remoteFile.file) {
          files.push(remoteFile.file);
        } else {
          skippedPaths.push(entry.relativePath);
          this.recordSyncEvent({
            source: "reconcile",
            eventType: "changed",
            relativePath: entry.relativePath,
            decision: "skipped",
            reason: remoteFile.reason ?? "not_indexable_file",
          });
        }
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }
    const fileReadDurationMs = Date.now() - fileReadStartedAt;

    const client = buildClient();
    if (typeof client.indexWorkspace !== "function") {
      throw new Error("@corpuswire/sdk does not expose indexWorkspace; update the SDK before enabling reconciliation.");
    }

    const gitMetadata = await this.readGitMetadata(context.sourceRoot);
    const response = await this.indexWorkspaceWithSessionConflictRetry(client, {
      workspace: {
        workspaceId: context.workspaceId,
        displayRoot: context.sourceRoot,
        name: path.basename(context.sourceRoot),
      },
      mode: "full",
      client: removeUndefinedValues({
        name: SERVER_NAME,
        transport: "codex-mcp-reconcile",
        sourceRoot: context.sourceRoot,
        indexed_commit: optionalString(this.env.CORPUSWIRE_SYNC_INDEXED_COMMIT) ?? gitMetadata.git_head,
        git_head: gitMetadata.git_head,
        git_branch: gitMetadata.git_branch,
      }),
      maxConcurrentUploads: optionalPositiveInteger(
        this.env.CORPUSWIRE_SYNC_MAX_CONCURRENT_UPLOADS,
        undefined,
      ),
      processingTimeoutMs: optionalPositiveInteger(
        args.processingTimeoutMs ?? args.processing_timeout_ms,
        undefined,
      ),
      batchBytes: optionalPositiveInteger(this.env.CORPUSWIRE_SYNC_BATCH_BYTES, undefined),
      maxFileSizeBytes: optionalPositiveInteger(
        this.env.CORPUSWIRE_SYNC_MAX_FILE_SIZE_BYTES,
        DEFAULT_SYNC_MAX_FILE_SIZE_BYTES,
      ),
      recreateCollection,
      files,
      deletedPaths: [],
      onProgress,
    }, { operation: "reconcile" });

    const durationMs = Date.now() - startedAt;
    const observability = buildMcpIndexTrace({
      client,
      response,
      totalDurationMs: durationMs,
      fileDiscoveryDurationMs,
      fileReadDurationMs,
    });
    const result = {
      ok: true,
      noOp: false,
      reconcile: true,
      filesQueued: changedPaths.length,
      filesUploaded: files.length,
      filesDeleted: 0,
      filesSkipped: skippedPaths.length,
      skippedPaths,
      recreateCollection,
      response,
      durationMs,
      ...(observability ? { observability } : {}),
    };
    this.recordResult(result, "reconcile");
    return result;
  }

  async readRemoteFile(entry, context, { useCache = false } = {}) {
    const fileStat = await stat(entry.absolutePath);
    if (!fileStat.isFile()) {
      return { skipped: true, reason: "not_file" };
    }

    const maxFileSizeBytes = optionalPositiveInteger(
      this.env.CORPUSWIRE_SYNC_MAX_FILE_SIZE_BYTES,
      DEFAULT_SYNC_MAX_FILE_SIZE_BYTES,
    );
    if (fileStat.size > maxFileSizeBytes) {
      return { skipped: true, reason: "too_large" };
    }

    const mtimeNs = Math.trunc(fileStat.mtimeMs * 1_000_000);
    const cached = useCache ? await this.findUsableCacheEntry(context, entry, fileStat, mtimeNs) : null;
    if (cached?.skipReason) {
      return { skipped: true, reason: cached.skipReason, cacheHit: true };
    }

    const content = await readFile(entry.absolutePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (cached?.cacheState && cached?.entry && cached.entry.sha256 === sha256) {
      await this.updateSyncCacheEntry(cached.cacheState, {
        relativePath: entry.relativePath,
        size: fileStat.size,
        mtimeNs,
        sha256,
        lastDecision: "unchanged_hash",
      });
      this.recordCacheDecision("unchanged_hash");
      this.recordSyncEvent({
        source: "cache",
        eventType: "changed",
        relativePath: entry.relativePath,
        decision: "skipped",
        reason: "unchanged_hash",
      });
      return { skipped: true, reason: "unchanged_hash", cacheHit: true };
    }

    this.recordCacheDecision(useCache ? "miss" : "disabled");
    return {
      file: {
        relativePath: entry.relativePath,
        content,
        sha256,
        mtimeNs,
      },
      cacheEntry: {
        relativePath: entry.relativePath,
        size: fileStat.size,
        mtimeNs,
        sha256,
      },
    };
  }

  async indexWorkspaceWithSessionConflictRetry(client, request, { operation }) {
    const retryAttempts = optionalNonNegativeInteger(
      this.env.CORPUSWIRE_SYNC_SESSION_CONFLICT_RETRY_ATTEMPTS,
      DEFAULT_SYNC_SESSION_CONFLICT_RETRY_ATTEMPTS,
    );
    const baseDelayMs = optionalNonNegativeInteger(
      this.env.CORPUSWIRE_SYNC_SESSION_CONFLICT_RETRY_DELAY_MS,
      DEFAULT_SYNC_SESSION_CONFLICT_RETRY_DELAY_MS,
    );
    const maxDelayMs = optionalPositiveInteger(
      this.env.CORPUSWIRE_SYNC_SESSION_CONFLICT_RETRY_MAX_DELAY_MS,
      DEFAULT_SYNC_SESSION_CONFLICT_RETRY_MAX_DELAY_MS,
    );

    for (let conflictAttempt = 0; ; conflictAttempt += 1) {
      try {
        return await client.indexWorkspace(request);
      } catch (error) {
        if (!isActiveSessionConflictError(error)) {
          throw error;
        }
        if (conflictAttempt >= retryAttempts) {
          this.recordSessionConflict(error, {
            operation,
            attempt: conflictAttempt + 1,
            delayMs: 0,
            exhausted: true,
          });
          throw error;
        }

        const retryDelayMs = calculateSessionConflictRetryDelayMs(error, {
          attempt: conflictAttempt,
          baseDelayMs,
          maxDelayMs,
        });
        this.recordSessionConflict(error, {
          operation,
          attempt: conflictAttempt + 1,
          delayMs: retryDelayMs,
          exhausted: false,
        });
        await sleepMs(retryDelayMs);
      }
    }
  }

  async findUsableCacheEntry(context, entry, fileStat, mtimeNs) {
    if (!this.isCacheUsable()) {
      this.recordCacheDecision(this.isCacheEnabled() ? "unusable" : "disabled");
      return null;
    }
    const cacheState = await this.loadSyncCache(context);
    const cachedEntry = asRecord(cacheState.data.entries?.[entry.relativePath]);
    if (!cachedEntry.sha256) {
      this.recordCacheDecision("miss");
      return { cacheState, entry: null };
    }
    if (cachedEntry.size === fileStat.size && cachedEntry.mtimeNs === mtimeNs) {
      this.recordCacheDecision("unchanged_mtime_size");
      this.recordSyncEvent({
        source: "cache",
        eventType: "changed",
        relativePath: entry.relativePath,
        decision: "skipped",
        reason: "unchanged_mtime_size",
      });
      return { cacheState, entry: cachedEntry, skipReason: "unchanged_mtime_size" };
    }
    return { cacheState, entry: cachedEntry };
  }

  async applySyncCacheUploadResult(context, cacheEntries, deletedPaths, response) {
    if (!this.isCacheEnabled()) {
      return;
    }
    let cacheState;
    try {
      cacheState = await this.loadSyncCache(context);
      const manifestRevision = asRecord(asRecord(response).status).manifest_revision;
      const uploadedAt = new Date().toISOString();
      for (const entry of cacheEntries) {
        cacheState.data.entries[entry.relativePath] = removeUndefinedValues({
          size: entry.size,
          mtimeNs: entry.mtimeNs,
          sha256: entry.sha256,
          lastUploadedAt: uploadedAt,
          manifestRevision,
          lastDecision: "uploaded",
          lastError: null,
        });
        this.recordCacheDecision("updated");
      }
      for (const relativePath of deletedPaths) {
        if (cacheState.data.entries[relativePath]) {
          delete cacheState.data.entries[relativePath];
          this.recordCacheDecision("deleted");
        }
      }
      await this.saveSyncCache(cacheState);
    } catch (error) {
      this.recordError(error, "cache");
    }
  }

  async updateSyncCacheEntry(cacheState, entry) {
    try {
      cacheState.data.entries[entry.relativePath] = {
        ...asRecord(cacheState.data.entries[entry.relativePath]),
        size: entry.size,
        mtimeNs: entry.mtimeNs,
        sha256: entry.sha256,
        lastCheckedAt: new Date().toISOString(),
        lastDecision: entry.lastDecision,
        lastError: null,
      };
      await this.saveSyncCache(cacheState);
    } catch (error) {
      this.recordError(error, "cache");
    }
  }

  async loadSyncCache(context) {
    const key = syncContextKey(context);
    const cachePath = this.syncCachePath(context, key);
    if (this.cacheState?.key === key && this.cacheState?.path === cachePath) {
      return this.cacheState;
    }

    let data = null;
    try {
      const raw = await readFile(cachePath, "utf8");
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)
        && parsed.schemaVersion === DEFAULT_SYNC_CACHE_SCHEMA_VERSION
        && parsed.contextKey === key
        && isRecord(parsed.entries)) {
        data = parsed;
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        this.recordError(error, "cache");
      }
    }

    const now = new Date().toISOString();
    this.cacheState = {
      key,
      path: cachePath,
      loadedAt: now,
      updatedAt: data?.updatedAt ?? null,
      data: data ?? {
        schemaVersion: DEFAULT_SYNC_CACHE_SCHEMA_VERSION,
        contextKey: key,
        workspaceId: context.workspaceId,
        sourceRoot: context.sourceRoot,
        includeGlobs: context.includeGlobs ?? [],
        excludeGlobs: context.excludeGlobs ?? [],
        createdAt: now,
        updatedAt: null,
        entries: {},
      },
    };
    return this.cacheState;
  }

  async saveSyncCache(cacheState) {
    const now = new Date().toISOString();
    cacheState.data.updatedAt = now;
    cacheState.updatedAt = now;
    await mkdir(path.dirname(cacheState.path), { recursive: true });
    const temporaryPath = `${cacheState.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(cacheState.data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, cacheState.path);
  }

  syncCachePath(context, key = syncContextKey(context)) {
    const configuredStateDir = firstNonEmptyString(
      this.env.CORPUSWIRE_SYNC_STATE_DIR,
      this.env.CORPUSWIRE_STATE_DIR,
    );
    const baseDir = configuredStateDir
      ?? path.join(this.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "corpuswire", "mcp-sync");
    const cacheName = createHash("sha256").update(key).digest("hex").slice(0, 24);
    return path.join(baseDir, `${cacheName}.json`);
  }

  async collectGitStatusEntries(context, { maxFiles, timeoutMs, maxStatusBytes }) {
    const stdout = await runGit(context.sourceRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=no",
    ], { timeoutMs, maxBuffer: maxStatusBytes });
    const entries = parseGitStatusPorcelainZ(stdout);
    if (entries.length > maxFiles) {
      throw new Error(`Git delta scan found ${entries.length} path entries, above maxFiles ${maxFiles}. Increase CORPUSWIRE_SYNC_GIT_MAX_FILES or run a scoped sync.`);
    }
    return entries;
  }

  async readGitMetadata(sourceRoot) {
    const timeoutMs = optionalPositiveInteger(
      this.env.CORPUSWIRE_SYNC_GIT_TIMEOUT_MS,
      DEFAULT_SYNC_GIT_TIMEOUT_MS,
    );
    const maxBuffer = DEFAULT_SYNC_GIT_MAX_STATUS_BYTES;
    const [head, branch] = await Promise.all([
      runGit(sourceRoot, ["rev-parse", "HEAD"], { timeoutMs, maxBuffer }).catch(() => ""),
      runGit(sourceRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs, maxBuffer }).catch(() => ""),
    ]);
    return removeUndefinedValues({
      git_head: optionalString(head),
      git_branch: optionalString(branch) && branch.trim() !== "HEAD" ? branch.trim() : undefined,
    });
  }

  async collectWorkspaceFileEntries(context, maxFiles) {
    const result = [];
    const { sourceRoot } = context;
    const stack = [sourceRoot];
    while (stack.length > 0) {
      const directory = stack.pop();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissingFileError(error) && directory !== sourceRoot) {
          continue;
        }
        throw error;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const absolutePath = path.join(directory, entry.name);
        const relativePath = path.relative(sourceRoot, absolutePath).split(path.sep).join("/");
        if (entry.isDirectory()) {
          if (
            (EXCLUDED_PATH_SEGMENTS.has(entry.name) || entry.name.startsWith("."))
            && !isSafeIndexableDirectoryAncestor(relativePath)
          ) {
            continue;
          }
          if (isExcludedDirectory(relativePath, context.excludeGlobs)) {
            continue;
          }
          stack.push(absolutePath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (!isSyncIndexableRelativePath(relativePath, context)) {
          continue;
        }
        if (result.length >= maxFiles) {
          throw new Error(`Reconciliation exceeded max file count ${maxFiles}. Increase CORPUSWIRE_SYNC_RECONCILE_MAX_FILES.`);
        }
        result.push({ absolutePath, relativePath });
      }
    }
    result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return result;
  }

  resolveContext(args) {
    const sourceRootRaw = firstNonEmptyString(
      args.sourceRoot,
      args.source_root,
      args.root,
      this.env.CORPUSWIRE_SYNC_ROOT,
      this.env.CORPUSWIRE_REPO_PATH,
      process.cwd(),
    );
    const workspaceId = firstNonEmptyString(args.workspaceId, args.workspace_id, this.env.CORPUSWIRE_WORKSPACE_ID);
    if (!sourceRootRaw) {
      throw new JsonRpcError(-32602, "Sync requires sourceRoot, CORPUSWIRE_SYNC_ROOT, or CORPUSWIRE_REPO_PATH.");
    }
    if (!workspaceId) {
      throw new JsonRpcError(-32602, "Sync requires workspaceId or CORPUSWIRE_WORKSPACE_ID.");
    }
    return {
      sourceRoot: path.resolve(sourceRootRaw),
      workspaceId,
      includeGlobs: resolveSyncGlobList(args, this.env.CORPUSWIRE_SYNC_INCLUDE_GLOBS, "includeGlobs", "include_globs"),
      excludeGlobs: resolveSyncGlobList(args, this.env.CORPUSWIRE_SYNC_EXCLUDE_GLOBS, "excludeGlobs", "exclude_globs"),
      indexableExtensions: this.indexableExtensions,
      indexableFilenames: this.indexableFilenames,
    };
  }

  ensurePendingContext(context) {
    const key = syncContextKey(context);
    if (this.pendingContext && this.pendingContext.key !== key && this.hasPending()) {
      throw new JsonRpcError(
        -32602,
        "A sync batch is already queued for another sourceRoot/workspaceId/filter set. Flush it before queuing a different workspace.",
      );
    }
    this.pendingContext = { ...context, key };
  }

  classifyPath(rawPath, context) {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return {
        accepted: false,
        reason: "empty_path",
        rawPath: typeof rawPath === "string" ? rawPath : String(rawPath),
      };
    }
    const absolutePath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(context.sourceRoot, rawPath);
    const relativePath = path.relative(context.sourceRoot, absolutePath);
    if (!relativePath || relativePath === "." || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return {
        accepted: false,
        reason: "outside_source_root",
        rawPath,
      };
    }
    const posixRelativePath = relativePath.split(path.sep).join("/");
    const classification = classifySyncRelativePath(posixRelativePath, context);
    if (!classification.accepted) {
      return {
        accepted: false,
        reason: classification.reason,
        rawPath,
        relativePath: posixRelativePath,
      };
    }
    return {
      accepted: true,
      reason: "accepted",
      rawPath,
      absolutePath,
      relativePath: posixRelativePath,
    };
  }

  requeueBatch(batch) {
    // Restore entries from a failed batch without overwriting newer events.
    // A newer changed/deleted event that arrived after takePendingBatch() takes
    // priority, so we only insert back paths that have no current entry.
    if (!this.pendingContext) {
      this.pendingContext = {
        sourceRoot: batch.sourceRoot,
        workspaceId: batch.workspaceId,
        includeGlobs: batch.includeGlobs ?? [],
        excludeGlobs: batch.excludeGlobs ?? [],
        key: syncContextKey(batch),
      };
    }
    for (const { relativePath, absolutePath } of batch.changedPaths) {
      if (!this.pendingChangedPaths.has(relativePath) && !this.pendingDeletedPaths.has(relativePath)) {
        this.pendingChangedPaths.set(relativePath, absolutePath);
        this.markQueueNonEmpty();
      }
    }
    for (const relativePath of batch.deletedPaths) {
      if (!this.pendingChangedPaths.has(relativePath) && !this.pendingDeletedPaths.has(relativePath)) {
        this.pendingDeletedPaths.add(relativePath);
        this.markQueueNonEmpty();
      }
    }
  }

  hasPending() {
    return this.pendingRetryBatches.length > 0 || this.pendingChangedPaths.size > 0 || this.pendingDeletedPaths.size > 0;
  }

  pendingSize() {
    let retryPaths = 0;
    for (const batch of this.pendingRetryBatches) {
      retryPaths += batch.changedPaths.length + batch.deletedPaths.length;
    }
    return retryPaths + this.pendingChangedPaths.size + this.pendingDeletedPaths.size;
  }

  takePendingBatch() {
    if (this.pendingRetryBatches.length > 0) {
      return this.pendingRetryBatches.shift();
    }
    const context = this.pendingContext;
    if (!context) {
      throw new Error("Cannot flush sync queue without a pending context.");
    }
    const changedPaths = [...this.pendingChangedPaths.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, absolutePath]) => ({ relativePath, absolutePath }));
    const deletedPaths = [...this.pendingDeletedPaths].sort();

    this.pendingChangedPaths.clear();
    this.pendingDeletedPaths.clear();
    this.pendingContext = null;
    if (!this.hasPending()) {
      this.firstQueuedAt = null;
    }

    return {
      sourceRoot: context.sourceRoot,
      workspaceId: context.workspaceId,
      includeGlobs: context.includeGlobs,
      excludeGlobs: context.excludeGlobs,
      changedPaths,
      deletedPaths,
    };
  }

  recordResult(result, operation = "flush") {
    this.lastResult = result;
    this.lastError = null;
    const finishedAt = new Date().toISOString();
    if (operation === "reconcile") {
      this.lastReconcileFinishedAt = finishedAt;
      this.lastReconcileDurationMs = Number.isInteger(result.durationMs) ? result.durationMs : null;
    } else {
      this.lastFlushFinishedAt = finishedAt;
      this.lastFlushDurationMs = Number.isInteger(result.durationMs) ? result.durationMs : null;
      if (Number.isInteger(result.durationMs)) {
        this.flushDurationSamplesMs.push(result.durationMs);
        if (this.flushDurationSamplesMs.length > DEFAULT_SYNC_LATENCY_SAMPLE_LIMIT) {
          this.flushDurationSamplesMs.shift();
        }
      }
    }
  }

  recordError(error, operation = "flush") {
    this.lastError = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date().toISOString();
    if (operation === "reconcile") {
      this.lastReconcileFinishedAt = finishedAt;
    } else if (operation === "bootstrap") {
      this.bootstrapStatus = {
        ...this.bootstrapStatus,
        state: "error",
        checkedAt: finishedAt,
        reason: this.lastError,
        lastError: this.lastError,
      };
    } else if (operation === "cache") {
      // Cache failures should be visible but must not rewrite flush/reconcile timing.
    } else if (operation === "git") {
      this.lastGitScanFinishedAt = finishedAt;
    } else {
      this.lastFlushFinishedAt = finishedAt;
    }
  }

  recordBootstrapStatus(status) {
    this.bootstrapStatus = {
      ...initialBootstrapStatus(),
      ...status,
    };
  }

  recordCacheDecision(reason) {
    this.cacheDecisionCounts[reason] = (this.cacheDecisionCounts[reason] ?? 0) + 1;
  }

  recordSessionConflict(error, { operation, attempt, delayMs, exhausted }) {
    const message = errorMessage(error);
    this.lastSessionConflictAt = new Date().toISOString();
    this.lastSessionConflictOperation = operation;
    this.lastSessionConflictAttempt = attempt;
    this.lastSessionConflictRetryDelayMs = delayMs;
    this.lastSessionConflictMessage = message;
    if (exhausted) {
      this.sessionConflictRetryCounts.exhausted += 1;
    } else {
      this.sessionConflictRetryCounts.retries += 1;
    }
    this.recordSyncEvent({
      source: operation,
      eventType: "session_conflict",
      decision: exhausted ? "failed" : "skipped",
      reason: exhausted ? "session_conflict_exhausted" : "session_conflict_retry",
      rawPath: message,
    });
  }

  recordSyncEvent(event) {
    const occurredAt = new Date().toISOString();
    this.lastEventAt = occurredAt;
    const compactEvent = removeUndefinedValues({
      occurredAt,
      source: event.source,
      eventType: event.eventType,
      decision: event.decision,
      reason: event.reason,
      relativePath: event.relativePath,
      rawPath: event.rawPath,
    });
    this.recentEvents.push(compactEvent);
    while (this.recentEvents.length > DEFAULT_SYNC_RECENT_EVENTS_LIMIT) {
      this.recentEvents.shift();
    }
    if (event.decision === "accepted") {
      if (event.eventType === "deleted") {
        this.acceptedEventCounts.deleted += 1;
      } else {
        this.acceptedEventCounts.changed += 1;
      }
      return;
    }
    const reason = event.reason ?? "unknown";
    this.skippedEventCounts[reason] = (this.skippedEventCounts[reason] ?? 0) + 1;
  }

  markQueueNonEmpty() {
    if (!this.firstQueuedAt) {
      this.firstQueuedAt = new Date().toISOString();
    }
  }

  pendingOldestAgeMs() {
    if (!this.firstQueuedAt) {
      return 0;
    }
    const startedAt = Date.parse(this.firstQueuedAt);
    if (!Number.isFinite(startedAt)) {
      return 0;
    }
    return Math.max(0, Date.now() - startedAt);
  }

  averageFlushDurationMs() {
    if (this.flushDurationSamplesMs.length === 0) {
      return null;
    }
    const total = this.flushDurationSamplesMs.reduce((sum, value) => sum + value, 0);
    return Math.round(total / this.flushDurationSamplesMs.length);
  }

  snapshot() {
    const syncCapability = this.syncCapability();
    return {
      enabled: this.isEnabled(),
      capabilityAllowed: syncCapability.allowed,
      capabilityReason: syncCapability.reason,
      backendMode: syncCapability.backendMode,
      supportedFileRegistryVersion: this.supportedFileRegistryVersion,
      watcherActive: this.watcher !== null,
      bootstrapActive: this.activeBootstrapCheck !== null,
      gitDeltaActive: this.activeGitDelta !== null,
      flushActive: this.activeFlush !== null,
      reconcileActive: this.activeReconcile !== null,
      timerActive: this.timer !== null,
      reconcileTimerActive: this.reconcileTimer !== null,
      cacheEnabled: this.isCacheEnabled(),
      cacheUsable: this.isCacheUsable(),
      cachePath: this.cacheState?.path ?? null,
      cacheEntries: this.cacheState ? Object.keys(asRecord(this.cacheState.data.entries)).length : 0,
      cacheLoadedAt: this.cacheState?.loadedAt ?? null,
      cacheUpdatedAt: this.cacheState?.updatedAt ?? null,
      cacheDecisionCounts: { ...this.cacheDecisionCounts },
      pendingChanged: this.pendingChangedPaths.size,
      pendingDeleted: this.pendingDeletedPaths.size,
      pendingRetryBatches: this.pendingRetryBatches.length,
      pendingTotal: this.pendingSize(),
      pendingSourceRoot: this.pendingContext?.sourceRoot ?? null,
      pendingWorkspaceId: this.pendingContext?.workspaceId ?? null,
      pendingOldestAgeMs: this.pendingOldestAgeMs(),
      firstQueuedAt: this.firstQueuedAt,
      lastEventAt: this.lastEventAt,
      lastFlushStartedAt: this.lastFlushStartedAt,
      lastFlushFinishedAt: this.lastFlushFinishedAt,
      lastFlushDurationMs: this.lastFlushDurationMs,
      averageFlushDurationMs: this.averageFlushDurationMs(),
      lastReconcileStartedAt: this.lastReconcileStartedAt,
      lastReconcileFinishedAt: this.lastReconcileFinishedAt,
      lastReconcileDurationMs: this.lastReconcileDurationMs,
      lastGitScanStartedAt: this.lastGitScanStartedAt,
      lastGitScanFinishedAt: this.lastGitScanFinishedAt,
      lastGitScanDurationMs: this.lastGitScanDurationMs,
      lastGitHead: this.lastGitHead,
      lastGitBranch: this.lastGitBranch,
      lastGitDeltaCounts: this.lastGitDeltaCounts,
      lastError: this.lastError,
      sessionConflictRetryCounts: { ...this.sessionConflictRetryCounts },
      lastSessionConflictAt: this.lastSessionConflictAt,
      lastSessionConflictOperation: this.lastSessionConflictOperation,
      lastSessionConflictAttempt: this.lastSessionConflictAttempt,
      lastSessionConflictRetryDelayMs: this.lastSessionConflictRetryDelayMs,
      lastSessionConflictMessage: this.lastSessionConflictMessage,
      bootstrapState: this.bootstrapStatus.state,
      needsReconcile: this.bootstrapStatus.needsReconcile,
      bootstrapCheckedAt: this.bootstrapStatus.checkedAt,
      bootstrapReason: this.bootstrapStatus.reason,
      bootstrapStatus: this.bootstrapStatus.status,
      bootstrapCanRetrieve: this.bootstrapStatus.canRetrieve,
      bootstrapCollection: this.bootstrapStatus.collection,
      bootstrapIndexHealthStatus: this.bootstrapStatus.indexHealthStatus,
      bootstrapIndexedAt: this.bootstrapStatus.indexedAt,
      bootstrapIndexedCommit: this.bootstrapStatus.indexedCommit,
      bootstrapManifestRevision: this.bootstrapStatus.manifestRevision,
      bootstrapRecoveryActions: [...(this.bootstrapStatus.recoveryActions ?? [])],
      bootstrapLastError: this.bootstrapStatus.lastError,
      lastResult: summarizeSyncResult(this.lastResult),
      acceptedEventCounts: { ...this.acceptedEventCounts },
      skippedEventCounts: { ...this.skippedEventCounts },
      recentEvents: [...this.recentEvents].reverse().slice(0, 10),
    };
  }
}

const syncManager = new SyncManager();
syncManager.startWatcherIfConfigured();
syncManager.startScheduledReconcileIfConfigured();
syncManager.startBootstrapCheckIfConfigured();

process.stdin.setEncoding("utf8");

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) {
      void handleLine(line);
    }
    newlineIndex = buffer.indexOf("\n");
  }
});

async function handleLine(line) {
  let response;
  try {
    const message = JSON.parse(line);
    response = await handleMessage(message);
  } catch (error) {
    response = errorResponse(null, normalizeError(error, -32700, "Parse error"));
  }

  if (response) {
    writeProtocolMessage(response);
  }
}

function writeProtocolMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function createMcpProgressReporter(params) {
  const metadata = asRecord(params._meta);
  const progressToken = metadata.progressToken;
  if (typeof progressToken !== "string" && typeof progressToken !== "number") {
    return undefined;
  }
  return (event) => {
    if (!isRecord(event) || event.schema_version !== "index-progress/v1") {
      return;
    }
    const percent = typeof event.overall_percent === "number"
      ? event.overall_percent
      : Number(event.sequence ?? 0);
    const total = typeof event.overall_percent === "number" ? 100 : undefined;
    writeProtocolMessage({
      jsonrpc: JSONRPC_VERSION,
      method: "notifications/progress",
      params: removeUndefinedValues({
        progressToken,
        progress: percent,
        total,
        message: formatMcpIndexProgress(event),
        corpuswire_event: event,
      }),
    });
  };
}

function formatMcpIndexProgress(event) {
  const total = Number.isFinite(event.phase_total) ? event.phase_total : null;
  const completed = Number.isFinite(event.phase_completed) ? event.phase_completed : 0;
  const work = total === null ? `${completed}` : `${completed}/${total}`;
  const elapsedSeconds = Number.isFinite(event.elapsed_ms)
    ? (event.elapsed_ms / 1000).toFixed(1)
    : "unknown";
  return `${event.phase ?? "indexing"} ${work} ${event.unit ?? "items"} elapsed=${elapsedSeconds}s`;
}

async function handleMessage(message) {
  if (!isRecord(message)) {
    return errorResponse(null, new JsonRpcError(-32600, "Invalid Request: message must be an object."));
  }

  const messageId = message.id;
  if (messageId === undefined || messageId === null) {
    return null;
  }

  if (typeof message.method !== "string") {
    return errorResponse(messageId, new JsonRpcError(-32600, "Invalid Request: method is required."));
  }

  try {
    const result = await handleRequest(message.method, asRecord(message.params));
    return {
      jsonrpc: JSONRPC_VERSION,
      id: messageId,
      result,
    };
  } catch (error) {
    return errorResponse(messageId, normalizeError(error, -32603, "Internal error"));
  }
}

async function handleRequest(method, params) {
  switch (method) {
    case "initialize":
      return initialize(params);
    case "ping":
      return {};
    case "tools/list":
      return { tools: await listToolsWithPlugins() };
    case "tools/call":
      return callTool(params);
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      throw new JsonRpcError(-32601, `Method not found: ${method}`);
  }
}

function initialize(params) {
  const requestedProtocol = typeof params.protocolVersion === "string" && params.protocolVersion.trim()
    ? params.protocolVersion
    : PROTOCOL_VERSION;

  return {
    protocolVersion: requestedProtocol,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
  };
}

async function callTool(params) {
  const name = params.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new JsonRpcError(-32602, "Invalid params: tool name is required.");
  }

  const args = asRecord(params.arguments);
  const onProgress = createMcpProgressReporter(params);
  if (name === "corpuswire_search") {
    try {
      return textToolResult(await searchContext(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "search request"), true);
    }
  }
  if (name === "corpuswire_review_context") {
    try {
      return textToolResult(await reviewContext(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "review context request"), true);
    }
  }
  if (name === "corpuswire_codebase_status") {
    try {
      return textToolResult(await codebaseStatus(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "Codebase status request"), true);
    }
  }
  if (name === "corpuswire_enhance_prompt") {
    try {
      return textToolResult(await enhancePrompt(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "enhancement request"), true);
    }
  }
  if (name === "corpuswire_rate_result") {
    try {
      return textToolResult(await recordQualityResult(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "quality rating request"), true);
    }
  }
  if (name === "corpuswire_quality_review") {
    try {
      return textToolResult(await reviewQualityResults(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "quality review request"), true);
    }
  }
  if (name === "corpuswire_confirm_value") {
    try {
      return textToolResult(await confirmQueryValue(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "value confirmation request"), true);
    }
  }
  if (name === "corpuswire_value_rollup") {
    try {
      return textToolResult(await reviewQueryValue(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "value rollup request"), true);
    }
  }
  if (name === "corpuswire_health") {
    try {
      return textToolResult(await health());
    } catch (error) {
      return textToolResult(formatToolError(error, "health request"), true);
    }
  }
  if (name === "corpuswire_diagnose_workspace") {
    try {
      return textToolResult(await diagnoseWorkspace(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "workspace diagnosis request"), true);
    }
  }
  if (name === "corpuswire_doctor") {
    try {
      return textToolResult(await doctor(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "doctor request"), true);
    }
  }
  if (name === "corpuswire_sync_delta") {
    try {
      return textToolResult(formatSyncPayload(await syncManager.addDelta(args)));
    } catch (error) {
      return textToolResult(formatToolError(error, "sync delta request"), true);
    }
  }
  if (name === "corpuswire_sync_flush") {
    try {
      return textToolResult(formatSyncPayload(await syncManager.flushExplicit(args, onProgress)));
    } catch (error) {
      return textToolResult(formatToolError(error, "sync flush request"), true);
    }
  }
  if (name === "corpuswire_sync_probe_paths") {
    try {
      return textToolResult(formatPathProbePayload(await syncManager.probePaths(args)));
    } catch (error) {
      return textToolResult(formatToolError(error, "sync path probe request"), true);
    }
  }
  if (name === "corpuswire_sync_reconcile") {
    try {
      return textToolResult(formatSyncPayload(await syncManager.reconcileExplicit(args, onProgress)));
    } catch (error) {
      return textToolResult(formatToolError(error, "sync reconcile request"), true);
    }
  }
  if (name === "corpuswire_sync_git_delta") {
    try {
      return textToolResult(formatSyncPayload(await syncManager.gitDeltaExplicit(args)));
    } catch (error) {
      return textToolResult(formatToolError(error, "sync git delta request"), true);
    }
  }
  if (name === "corpuswire_sync_bootstrap") {
    try {
      return textToolResult(formatSyncPayload(await syncManager.bootstrapExplicit(args)));
    } catch (error) {
      return textToolResult(formatToolError(error, "sync bootstrap request"), true);
    }
  }
  if (name === "corpuswire_sync_status") {
    try {
      return textToolResult(formatSyncPayload({ status: syncManager.snapshot() }));
    } catch (error) {
      return textToolResult(formatToolError(error, "sync status request"), true);
    }
  }
  if (name === "corpuswire_sync_sessions") {
    try {
      return textToolResult(await listIndexSessions(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "sync sessions request"), true);
    }
  }
  if (name === "corpuswire_sync_abort_session") {
    try {
      return textToolResult(await abortIndexSession(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "sync abort session request"), true);
    }
  }
  if (name === "corpuswire_index_activity") {
    try {
      return textToolResult(await indexActivity(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "index activity request"), true);
    }
  }

  // Plugin-contributed tool: dispatch to /v1/plugins/mcp-call.
  const pluginTools = await fetchPluginTools();
  if (pluginTools.some((t) => t.name === name)) {
    try {
      return textToolResult(await dispatchPluginTool(name, args));
    } catch (error) {
      return textToolResult(formatToolError(error, `plugin tool ${name}`), true);
    }
  }

  throw new JsonRpcError(-32602, `Unknown tool: ${name}`);
}

async function dispatchPluginTool(name, args) {
  const baseUrl = resolveBackendPolicy().baseUrl.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/v1/plugins/mcp-call`, {
    method: "POST",
    headers: corpuswireHttpHeaders({ "content-type": "application/json" }),
    redirect: "error",
    body: JSON.stringify({ name, arguments: args ?? {} }),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
    } catch (_err) {
      // keep raw text
    }
    throw new Error(`plugin call failed (${response.status}): ${detail}`);
  }
  return text;
}

const PLUGIN_TOOLS_CACHE_TTL_MS = 60_000;
let pluginToolsCache = { fetchedAt: 0, tools: [] };

async function fetchPluginTools() {
  const now = Date.now();
  if (now - pluginToolsCache.fetchedAt < PLUGIN_TOOLS_CACHE_TTL_MS) {
    return pluginToolsCache.tools;
  }
  const baseUrl = resolveBackendPolicy().baseUrl;
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/plugins/mcp-tools`, {
      headers: corpuswireHttpHeaders(),
      redirect: "error",
    });
    if (!response.ok) {
      pluginToolsCache = { fetchedAt: now, tools: [] };
      return [];
    }
    const payload = await response.json();
    const tools = Array.isArray(payload?.tools)
      ? payload.tools
          .filter((t) => t && typeof t.name === "string")
          .map((t) => ({
            name: t.name,
            description: typeof t.description === "string" ? t.description : "",
            inputSchema:
              t.input_schema && typeof t.input_schema === "object"
                ? t.input_schema
                : { type: "object", additionalProperties: true },
            plugin: typeof t.plugin === "string" ? t.plugin : undefined,
          }))
      : [];
    pluginToolsCache = { fetchedAt: now, tools };
    return tools;
  } catch (_err) {
    pluginToolsCache = { fetchedAt: now, tools: [] };
    return [];
  }
}

function corpuswireHttpHeaders(headers = {}, env = process.env) {
  const result = { ...headers };
  const { basicAuth, bearerToken } = resolveAuthConfiguration(env);
  if (bearerToken && !hasHeader(result, "authorization")) {
    result.Authorization = typeof sdk.createBearerAuthHeader === "function"
      ? sdk.createBearerAuthHeader(bearerToken)
      : `Bearer ${bearerToken}`;
  }
  if (basicAuth && !hasHeader(result, "authorization")) {
    result.Authorization = typeof sdk.createBasicAuthHeader === "function"
      ? sdk.createBasicAuthHeader(basicAuth)
      : `Basic ${Buffer.from(basicAuth, "utf8").toString("base64")}`;
  }
  return result;
}

function hasHeader(headers, name) {
  const expected = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === expected);
}

function resolveAuthConfiguration(env = process.env) {
  const basicAuth = (env.CORPUSWIRE_BASIC_AUTH ?? "").trim();
  const bearerToken = (env.CORPUSWIRE_BEARER_TOKEN ?? "").trim();
  if (basicAuth && bearerToken) {
    throw new JsonRpcError(
      -32602,
      "Configure only one of CORPUSWIRE_BASIC_AUTH or CORPUSWIRE_BEARER_TOKEN.",
    );
  }
  return { basicAuth, bearerToken };
}

function resolveBackendPolicy(env = process.env) {
  const baseUrl = env.CORPUSWIRE_BASE_URL ?? DEFAULT_BASE_URL;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new JsonRpcError(-32602, `Invalid CORPUSWIRE_BASE_URL: ${baseUrl}`);
  }

  if (parsed.username || parsed.password) {
    throw new JsonRpcError(-32602, "CORPUSWIRE_BASE_URL must not contain embedded credentials.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new JsonRpcError(-32602, "CORPUSWIRE_BASE_URL must use HTTP or HTTPS.");
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLocalhost = hostname === "localhost" || hostname.endsWith(".localhost");
  const isLoopback = hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  const isLocal = isLocalhost || isLoopback;
  if (isLocal) {
    return {
      baseUrl,
      origin: parsed.origin,
      isLocal: true,
      remoteSyncEnabled: false,
      authMode: resolveAuthMode(env),
    };
  }

  if (parsed.protocol !== "https:") {
    throw new JsonRpcError(-32602, "Remote CORPUSWIRE_BASE_URL values must use HTTPS.");
  }
  if (!optionalBoolean(env.CORPUSWIRE_REMOTE_ENABLED, false)) {
    throw new JsonRpcError(
      -32602,
      "Remote CorpusWire access is disabled; set CORPUSWIRE_REMOTE_ENABLED=true after configuring an allow-listed HTTPS origin.",
    );
  }
  const allowedOrigins = parseAllowedOrigins(env.CORPUSWIRE_ALLOWED_ORIGINS ?? "");
  if (!allowedOrigins.has(parsed.origin)) {
    throw new JsonRpcError(
      -32602,
      `Remote CorpusWire origin ${parsed.origin} is not present in CORPUSWIRE_ALLOWED_ORIGINS.`,
    );
  }
  const authMode = resolveAuthMode(env);
  if (authMode === "none") {
    throw new JsonRpcError(
      -32602,
      "Remote CorpusWire access requires CORPUSWIRE_BEARER_TOKEN or CORPUSWIRE_BASIC_AUTH.",
    );
  }
  return {
    baseUrl,
    origin: parsed.origin,
    isLocal: false,
    remoteSyncEnabled: optionalBoolean(env.CORPUSWIRE_REMOTE_SYNC_ENABLED, false),
    authMode,
  };
}

function resolveAuthMode(env = process.env) {
  const { basicAuth, bearerToken } = resolveAuthConfiguration(env);
  if (bearerToken) return "bearer";
  if (basicAuth) return "basic";
  return "none";
}

function parseAllowedOrigins(value) {
  const origins = new Set();
  for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    let parsed;
    try {
      parsed = new URL(entry);
    } catch (_error) {
      throw new JsonRpcError(-32602, `Invalid origin in CORPUSWIRE_ALLOWED_ORIGINS: ${entry}`);
    }
    if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new JsonRpcError(
        -32602,
        `CORPUSWIRE_ALLOWED_ORIGINS entries must be HTTPS origins without paths: ${entry}`,
      );
    }
    origins.add(parsed.origin);
  }
  return origins;
}

async function listToolsWithPlugins() {
  const builtin = toolDefinitions();
  const builtinNames = new Set(builtin.map((t) => t.name));
  const plugin = await fetchPluginTools();
  const merged = [...builtin];
  for (const tool of plugin) {
    if (builtinNames.has(tool.name)) continue;
    merged.push(tool);
  }
  return merged;
}

function toolDefinitions() {
  return [
    {
      name: "corpuswire_review_context",
      description: "Build or poll a bounded, provenance-bearing multi-repository evidence pack for one code review.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          codebaseId: { type: "string", minLength: 1, maxLength: 256, description: "Opaque Codebase identifier." },
          targetRepositoryId: { type: "string", minLength: 1, maxLength: 256, description: "Immutable target Repository identifier." },
          providerReviewId: { type: "string", minLength: 1, maxLength: 256, description: "Provider review or pull-request identifier." },
          expectedHeadSha: { type: ["string", "null"], pattern: "^[0-9a-f]{40,64}$" },
          objective: { type: "string", minLength: 1, maxLength: 16000, description: "Review objective used to rank related evidence." },
          strictFreshness: { type: "boolean", default: true },
          budgets: {
            type: "object",
            additionalProperties: false,
            properties: {
              graphHops: { type: "integer", minimum: 0, maximum: 4, default: 2 },
              candidateRepositories: { type: "integer", minimum: 1, maximum: 100, default: 25 },
              preRankCandidates: { type: "integer", minimum: 1, maximum: 5000, default: 500 },
              evidenceItems: { type: "integer", minimum: 1, maximum: 500, default: 40 },
              serializedTokens: { type: "integer", minimum: 256, maximum: 100000, default: 12000 },
              waitMs: { type: "integer", minimum: 0, maximum: 60000, default: 2500 },
            },
          },
          outputCharacterLimit: {
            type: ["integer", "null"],
            minimum: 256,
            maximum: 2000000,
            description: "Server evidence and MCP text formatting character limit.",
          },
          waitForCompletion: {
            type: "boolean",
            default: true,
            description: "Poll durable work until usable or terminal when true.",
          },
          timeoutMs: { type: "integer", minimum: 0, default: 60000 },
          pollIntervalMs: { type: "integer", minimum: 0, default: 1000 },
        },
        required: ["codebaseId", "targetRepositoryId", "providerReviewId", "objective"],
      },
    },
    {
      name: "corpuswire_codebase_status",
      description: "Inspect one authorized Codebase, repository selection, review capabilities, and optional review status.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          codebaseId: { type: "string", description: "Opaque Codebase identifier." },
          reviewId: { type: "string", description: "Optional provider review identifier." },
          includeRepositories: { type: "boolean", default: true },
          includeCapabilities: { type: "boolean", default: true },
          maxRepositories: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        },
        required: ["codebaseId"],
      },
    },
    {
      name: "corpuswire_search",
      description: "Search the configured CorpusWire index for repository context without answer generation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Semantic retrieval query to run against the configured CorpusWire workspace index.",
          },
          repoPath: {
            type: "string",
            description: "Service-local repository root used to scope retrieval. Defaults to CORPUSWIRE_REPO_PATH when set.",
          },
          workspaceId: {
            type: "string",
            description: "Local API workspace id used to scope retrieval. Defaults to CORPUSWIRE_WORKSPACE_ID when set.",
          },
          topK: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_TOP_K,
            description: "Number of retrieved context chunks to return.",
          },
          minScore: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Optional retrieval score threshold.",
          },
          maxChars: {
            type: "integer",
            minimum: 200,
            default: 12000,
            description: "Maximum characters of hit text to include in the tool response.",
          },
          sourceFilter: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of source-system identifiers (e.g. plugin names) used to restrict retrieval. Plugins translate these via RetrieverHooks.extra_filters().",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "corpuswire_enhance_prompt",
      description: "Preview a base Codex prompt enhanced with local repository context. Returns the original prompt, augmented prompt, context sources, and retrieval metadata.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          prompt: {
            type: "string",
            description: "Base prompt to rewrite into a clearer context-grounded Codex instruction.",
          },
          outputMode: {
            type: "string",
            enum: [...OUTPUT_MODES],
            default: DEFAULT_OUTPUT_MODE,
            description: "Prompt style requested from the backend.",
          },
          repoPath: {
            type: "string",
            description: "Service-local repository root used to scope retrieval. Defaults to CORPUSWIRE_REPO_PATH when set.",
          },
          workspaceId: {
            type: "string",
            description: "Local API workspace id used to scope retrieval. Defaults to CORPUSWIRE_WORKSPACE_ID when set.",
          },
          topK: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_TOP_K,
            description: "Number of retrieved context chunks to use.",
          },
          minScore: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Optional retrieval score threshold.",
          },
          localOnly: {
            type: "boolean",
            default: true,
            description: "Use deterministic local rewriting without a generation provider.",
          },
          sourceFilter: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of source-system identifiers (e.g. plugin names) used to restrict retrieval. Plugins translate these via RetrieverHooks.extra_filters().",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "corpuswire_rate_result",
      description: "Record a 1-5 quality scorecard for Augment, CorpusWire, Auggie, or another engine in the central cross-workspace quality ledger.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspaceId: {
            type: "string",
            description: "Stable workspace identity. Defaults to CORPUSWIRE_WORKSPACE_ID.",
          },
          workType: {
            type: "string",
            enum: [...QUALITY_WORK_TYPES],
            description: "Whether this rating assesses semantic retrieval, prompt enhancement, or review context.",
          },
          engine: {
            type: "string",
            description: "Engine being rated, such as augment, corpuswire, or auggie.",
          },
          relevance: { type: "number", minimum: 1, maximum: 5 },
          fileSpecificity: { type: "number", minimum: 1, maximum: 5 },
          coverage: { type: "number", minimum: 1, maximum: 5 },
          freshness: { type: "number", minimum: 1, maximum: 5 },
          actionability: { type: "number", minimum: 1, maximum: 5 },
          query: {
            type: "string",
            description: "Evaluated query or base prompt. The server redacts it by default before persistence.",
          },
          surface: { type: "string", description: "Calling surface, for example codex, vscode, copilot, or cli." },
          roundId: { type: "string", description: "Shared id linking the engines evaluated in one comparison round." },
          resultPaths: { type: "array", items: { type: "string" }, default: [] },
          warning: { type: "string" },
          improvement: { type: "string", description: "Concrete improvement derived from this result." },
          notes: { type: "string" },
          issueUrl: { type: "string" },
          metadata: { type: "object", additionalProperties: true },
        },
        required: ["workType", "engine", "relevance", "fileSpecificity", "coverage", "freshness", "actionability"],
      },
    },
    {
      name: "corpuswire_quality_review",
      description: "Review central retrieval, prompt-enhancement, and review-context ratings to identify weak dimensions, recurring patterns, and recommended improvements.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspaceId: {
            type: "string",
            description: "Optional workspace filter. Omit for the central cross-workspace review.",
          },
          workType: {
            type: "string",
            enum: [...QUALITY_WORK_TYPES],
          },
          engine: { type: "string" },
          days: { type: "integer", minimum: 1, maximum: 3650, default: 30 },
        },
      },
    },
    {
      name: "corpuswire_confirm_value",
      description: "Confirm time or monetary value delivered by one CorpusWire retrieval event.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          eventId: { type: "string" },
          minutesSaved: { type: "number", minimum: 0 },
          confirmedValue: { type: "number", minimum: 0 },
          confirmedBy: { type: "string" },
        },
        required: ["eventId", "minutesSaved"],
      },
    },
    {
      name: "corpuswire_value_rollup",
      description: "Aggregate CorpusWire query cost and estimated/confirmed value by day, week, or month.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          period: { type: "string", enum: ["day", "week", "month"], default: "day" },
          days: { type: "integer", minimum: 1, maximum: 3650, default: 30 },
          workspaceId: { type: "string" },
          hourlyRate: { type: "number", minimum: 0 },
        },
      },
    },
    {
      name: "corpuswire_health",
      description: "Check that the CorpusWire FastAPI backend is reachable.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: "corpuswire_diagnose_workspace",
      description: "Diagnose whether the requested repoPath or workspaceId is indexed, readable, and safe to use before retrieval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          repoPath: {
            type: "string",
            description: "Service-local repository root to diagnose. Defaults to CORPUSWIRE_REPO_PATH when set.",
          },
          workspaceId: {
            type: "string",
            description: "Remote workspace id to diagnose. Defaults to CORPUSWIRE_WORKSPACE_ID when set.",
          },
        },
      },
    },
    {
      name: "corpuswire_doctor",
      description: "Run a read-only CorpusWire readiness check across backend health, workspace diagnosis, sync state, active sessions, and persisted activity.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          repoPath: {
            type: "string",
            description: "Service-local repository root to diagnose. Defaults to CORPUSWIRE_REPO_PATH when set.",
          },
          workspaceId: {
            type: "string",
            description: "Remote workspace id to diagnose. Defaults to CORPUSWIRE_WORKSPACE_ID when set.",
          },
          collection: {
            type: "string",
            description: "Optional backend collection name filter for persisted index activity.",
          },
          activityWindowHours: {
            type: "integer",
            minimum: 1,
            description: "Backend activity summary window in hours. Defaults to 24.",
          },
        },
      },
    },
    {
      name: "corpuswire_sync_delta",
      description: "Queue changed and deleted local workspace paths for incremental indexing by the configured CorpusWire API.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          changedPaths: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "Files that were created or modified. Paths may be absolute or relative to sourceRoot.",
          },
          deletedPaths: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "Files that were deleted. Paths may be absolute or relative to sourceRoot.",
          },
          sourceRoot: {
            type: "string",
            description: "Local workspace root readable by this MCP server. Defaults to CORPUSWIRE_SYNC_ROOT or CORPUSWIRE_REPO_PATH.",
          },
          workspaceId: {
            type: "string",
            description: "Local API workspace id used by the CorpusWire index. Defaults to CORPUSWIRE_WORKSPACE_ID.",
          },
          includeGlobs: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "Optional glob filters for changed/deleted files to include. Defaults to CORPUSWIRE_SYNC_INCLUDE_GLOBS.",
          },
          excludeGlobs: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "Optional glob filters for changed/deleted files to exclude. Defaults to CORPUSWIRE_SYNC_EXCLUDE_GLOBS.",
          },
          flush: {
            type: "boolean",
            default: false,
            description: "When true, immediately flush the queued delta before returning.",
          },
          debounceMs: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_SYNC_DEBOUNCE_MS,
            description: "Debounce delay used when flush is false.",
          },
          maxWaitMs: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_SYNC_FLUSH_TIMEOUT_MS,
            description: "Maximum time to wait when flush is true.",
          },
          maxPendingPaths: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_SYNC_MAX_PENDING_PATHS,
            description: "Flush the buffered delta when queued changed/deleted paths reach this count.",
          },
        },
      },
    },
    {
      name: "corpuswire_sync_flush",
      description: "Flush queued CorpusWire incremental sync changes to the configured API indexer.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxWaitMs: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_SYNC_FLUSH_TIMEOUT_MS,
            description: "Maximum time to wait for queued or active sync work.",
          },
        },
      },
    },
    {
      name: "corpuswire_sync_probe_paths",
      description: "Classify workspace paths under current CorpusWire sync filters without queuing or uploading them.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["paths"],
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Workspace-relative or absolute paths to classify.",
          },
          sourceRoot: {
            type: "string",
            description: "Optional sync root override. Defaults to CORPUSWIRE_SYNC_ROOT or CORPUSWIRE_REPO_PATH.",
          },
          workspaceId: {
            type: "string",
            description: "Optional CorpusWire workspace id. Defaults to CORPUSWIRE_WORKSPACE_ID.",
          },
          includeGlobs: {
            type: "array",
            items: { type: "string" },
            description: "Optional include globs overriding CORPUSWIRE_SYNC_INCLUDE_GLOBS.",
          },
          excludeGlobs: {
            type: "array",
            items: { type: "string" },
            description: "Optional exclude globs overriding CORPUSWIRE_SYNC_EXCLUDE_GLOBS.",
          },
          maxPaths: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Maximum paths to classify. Defaults to 100.",
          },
          includeHash: {
            type: "boolean",
            description: "When true, compute SHA-256 for upload-candidate files. Defaults to false.",
          },
        },
      },
    },
    {
      name: "corpuswire_sync_reconcile",
      description: "Run a full workspace reconciliation scan to heal missed sync events.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceRoot: {
            type: "string",
            description: "Local workspace root readable by this MCP server. Defaults to CORPUSWIRE_SYNC_ROOT or CORPUSWIRE_REPO_PATH.",
          },
          workspaceId: {
            type: "string",
            description: "Remote workspace id used by the CorpusWire index. Defaults to CORPUSWIRE_WORKSPACE_ID.",
          },
          includeGlobs: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "Optional glob filters for files to include in the reconciliation scan. Defaults to CORPUSWIRE_SYNC_INCLUDE_GLOBS.",
          },
          excludeGlobs: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "Optional glob filters for files and directories to exclude from the reconciliation scan. Defaults to CORPUSWIRE_SYNC_EXCLUDE_GLOBS.",
          },
          maxWaitMs: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_SYNC_FLUSH_TIMEOUT_MS,
            description: "Maximum caller wait for reconciliation. Expiry detaches and leaves backend work running.",
          },
          processingTimeoutMs: {
            type: "integer",
            minimum: 1,
            description: "Optional SDK wait budget. Omit to follow backend indexing until terminal state.",
          },
          maxFiles: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_SYNC_RECONCILE_MAX_FILES,
            description: "Maximum number of indexable files to include in one reconciliation scan.",
          },
          recreateCollection: {
            type: "boolean",
            default: false,
            description: "Recreate the target workspace collection before indexing uploaded files. Use only for intentional clean rebuilds, such as embedding dimension changes.",
          },
        },
      },
    },
    {
      name: "corpuswire_sync_git_delta",
      description: "Scan git status for modified, added, deleted, renamed, and untracked files, then queue matching paths for incremental sync.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceRoot: {
            type: "string",
            description: "Local git workspace root readable by this MCP server. Defaults to CORPUSWIRE_SYNC_ROOT or CORPUSWIRE_REPO_PATH.",
          },
          workspaceId: {
            type: "string",
            description: "Remote workspace id used by the CorpusWire index. Defaults to CORPUSWIRE_WORKSPACE_ID.",
          },
          includeGlobs: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "Optional glob filters for git-detected files to include. Defaults to CORPUSWIRE_SYNC_INCLUDE_GLOBS.",
          },
          excludeGlobs: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "Optional glob filters for git-detected files to exclude. Defaults to CORPUSWIRE_SYNC_EXCLUDE_GLOBS.",
          },
          flush: {
            type: "boolean",
            default: false,
            description: "When true, immediately flush the queued git delta before returning.",
          },
          maxWaitMs: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_SYNC_GIT_TIMEOUT_MS,
            description: "Maximum time to wait for the git scan result.",
          },
          flushMaxWaitMs: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_SYNC_FLUSH_TIMEOUT_MS,
            description: "Maximum time to wait for upload when flush is true.",
          },
          maxFiles: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_SYNC_GIT_MAX_FILES,
            description: "Maximum git status entries to process.",
          },
        },
      },
    },
    {
      name: "corpuswire_sync_bootstrap",
      description: "Diagnose startup sync freshness for the configured workspace and optionally run an explicit reconciliation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceRoot: {
            type: "string",
            description: "Local workspace root readable by this MCP server. Defaults to CORPUSWIRE_SYNC_ROOT or CORPUSWIRE_REPO_PATH.",
          },
          repoPath: {
            type: "string",
            description: "Service-local repository root to diagnose. Defaults to CORPUSWIRE_REPO_PATH or sourceRoot.",
          },
          workspaceId: {
            type: "string",
            description: "Remote workspace id used by the CorpusWire index. Defaults to CORPUSWIRE_WORKSPACE_ID.",
          },
          includeGlobs: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "Optional glob filters used only when reconcile is true. Defaults to CORPUSWIRE_SYNC_INCLUDE_GLOBS.",
          },
          excludeGlobs: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "Optional glob filters used only when reconcile is true. Defaults to CORPUSWIRE_SYNC_EXCLUDE_GLOBS.",
          },
          reconcile: {
            type: "boolean",
            default: false,
            description: "When true, run an explicit bounded reconciliation after diagnosis.",
          },
          maxWaitMs: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_SYNC_BOOTSTRAP_TIMEOUT_MS,
            description: "Maximum time to wait for each diagnosis check.",
          },
          maxFiles: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_SYNC_RECONCILE_MAX_FILES,
            description: "Maximum indexable files to include if reconcile is true.",
          },
        },
      },
    },
    {
      name: "corpuswire_sync_status",
      description: "Report CorpusWire incremental sync queue, watcher, bootstrap, and last flush status.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: "corpuswire_sync_sessions",
      description: "List active CorpusWire index sessions visible to the local backend.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspaceId: {
            type: "string",
            description: "Optional CorpusWire workspace id used to filter active sessions. Defaults to CORPUSWIRE_WORKSPACE_ID.",
          },
        },
      },
    },
    {
      name: "corpuswire_sync_abort_session",
      description: "Abort a known CorpusWire index session by session id.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId"],
        properties: {
          sessionId: {
            type: "string",
            description: "Index session id to abort. Inspect active sessions first with corpuswire_sync_sessions.",
          },
        },
      },
    },
    {
      name: "corpuswire_index_activity",
      description: "Report persisted CorpusWire index activity and recent backend index events.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspaceId: {
            type: "string",
            description: "Optional CorpusWire workspace id used to filter activity. Defaults to CORPUSWIRE_WORKSPACE_ID.",
          },
          collection: {
            type: "string",
            description: "Optional backend collection name filter.",
          },
          windowHours: {
            type: "integer",
            minimum: 1,
            description: "Activity summary window in hours. Defaults to 24.",
          },
          expectedIntervalSeconds: {
            type: "integer",
            minimum: 1,
            description: "Optional expected sync cadence used for gap detection.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Maximum recent events to show. Defaults to 10.",
          },
        },
      },
    },
  ];
}

async function reviewContext(args) {
  const codebaseId = requiredString(args, "codebaseId");
  const targetRepositoryId = requiredString(args, "targetRepositoryId");
  const providerReviewId = requiredString(args, "providerReviewId");
  const objective = requiredString(args, "objective");
  const budgets = reviewBudgets(args.budgets);
  const expectedHeadSha = args.expectedHeadSha === null
    ? null
    : optionalString(args.expectedHeadSha);
  const outputCharacterLimit = nullableBoundedInteger(
    args.outputCharacterLimit,
    "outputCharacterLimit",
    256,
    2_000_000,
  );
  const waitForCompletion = optionalBoolean(args.waitForCompletion, true);
  const timeoutMs = optionalNonNegativeInteger(args.timeoutMs, 60_000);
  const pollIntervalMs = optionalNonNegativeInteger(args.pollIntervalMs, 1_000);
  const client = buildClient();
  if (
    typeof client.requestReviewContext !== "function"
    || typeof client.requestReviewContextAndWait !== "function"
  ) {
    throw new Error(
      "@corpuswire/sdk does not expose review-context methods; rebuild and re-vendor the SDK.",
    );
  }
  const request = {
    codebaseId,
    targetRepositoryId,
    providerReviewId,
    expectedHeadSha,
    objective,
    strictFreshness: optionalBoolean(args.strictFreshness, true),
    budgets,
    outputCharacterLimit,
  };
  const result = waitForCompletion
    ? await client.requestReviewContextAndWait(request, { timeoutMs, pollIntervalMs })
    : await client.requestReviewContext(request);
  const maxChars = outputCharacterLimit ?? 12_000;
  return formatReviewContextResult({ result, maxChars });
}

async function codebaseStatus(args) {
  const codebaseId = requiredString(args, "codebaseId");
  const reviewId = optionalString(args.reviewId);
  const includeRepositories = optionalBoolean(args.includeRepositories, true);
  const includeCapabilities = optionalBoolean(args.includeCapabilities, true);
  const maxRepositories = optionalBoundedInteger(
    args.maxRepositories,
    "maxRepositories",
    1,
    500,
  ) ?? 100;
  const client = buildClient();
  if (typeof client.getCodebase !== "function") {
    throw new Error(
      "@corpuswire/sdk does not expose Codebase methods; rebuild and re-vendor the SDK.",
    );
  }
  const codebase = await client.getCodebase(codebaseId);
  const [repositoriesResult, capabilitiesResult, reviewResult] = await Promise.all([
    includeRepositories && typeof client.listCodebaseRepositories === "function"
      ? optionalSdkResult(() => client.listCodebaseRepositories(codebaseId))
      : Promise.resolve({ value: null, error: null }),
    includeCapabilities && typeof client.getReviewContextCapabilities === "function"
      ? optionalSdkResult(() => client.getReviewContextCapabilities())
      : Promise.resolve({ value: null, error: null }),
    reviewId && typeof client.getReviewStatus === "function"
      ? optionalSdkResult(() => client.getReviewStatus(codebaseId, reviewId))
      : Promise.resolve({ value: null, error: null }),
  ]);
  return formatCodebaseStatus({
    codebase,
    repositoriesResult,
    capabilitiesResult,
    reviewResult,
    maxRepositories,
  });
}

async function optionalSdkResult(operation) {
  try {
    return { value: await operation(), error: null };
  } catch (error) {
    return { value: null, error: formatToolError(error, "optional status request") };
  }
}

function reviewBudgets(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new JsonRpcError(-32602, "Invalid params: budgets must be an object.");
  }
  return removeUndefinedValues({
    graphHops: optionalBoundedInteger(value.graphHops, "graphHops", 0, 4),
    candidateRepositories: optionalBoundedInteger(
      value.candidateRepositories,
      "candidateRepositories",
      1,
      100,
    ),
    preRankCandidates: optionalBoundedInteger(
      value.preRankCandidates,
      "preRankCandidates",
      1,
      5_000,
    ),
    evidenceItems: optionalBoundedInteger(value.evidenceItems, "evidenceItems", 1, 500),
    serializedTokens: optionalBoundedInteger(
      value.serializedTokens,
      "serializedTokens",
      256,
      100_000,
    ),
    waitMs: optionalBoundedInteger(value.waitMs, "waitMs", 0, 60_000),
  });
}

function formatReviewContextResult({ result, maxChars }) {
  if (!isRecord(result)) {
    throw new Error("CorpusWire returned an invalid review-context result.");
  }
  if (typeof result.state === "string" && typeof result.job_id === "string") {
    return truncateText([
      "CorpusWire review context job:",
      `- jobId: ${result.job_id}`,
      `- requestId: ${result.request_id ?? "unknown"}`,
      `- codebaseId: ${result.codebase_id ?? "unknown"}`,
      `- state: ${result.state}`,
      `- attempts: ${result.attempts ?? 0}`,
      `- statusUrl: ${result.status_url ?? "unknown"}`,
      `- retryAfterSeconds: ${result.retry_after_seconds ?? "none"}`,
      `- partialReasons: ${stringList(result.partial_reasons) || "none"}`,
    ].join("\n"), maxChars);
  }

  const evidence = Array.isArray(result.evidence) ? result.evidence.filter(isRecord) : [];
  const lines = [
    "CorpusWire review context:",
    `- requestId: ${result.request_id ?? "unknown"}`,
    `- telemetryId: ${result.telemetry_id ?? "unknown"}`,
    `- jobId: ${result.job_id ?? "none"}`,
    `- reviewId: ${result.review_id ?? "unknown"}`,
    `- targetRepositoryId: ${result.target_repository_id ?? "unknown"}`,
    `- baseSha: ${result.base_sha ?? "unknown"}`,
    `- headSha: ${result.head_sha ?? "unknown"}`,
    `- snapshot: ${result.snapshot_id ?? "unknown"}@${result.snapshot_generation ?? "unknown"}`,
    `- overlay: ${result.overlay_id ?? "unknown"}@${result.overlay_generation ?? "unknown"}`,
    `- freshness: ${result.freshness ?? "unknown"}`,
    `- repositories: ${result.repository_count ?? 0}`,
    `- candidates: ${result.candidate_count ?? 0}`,
    `- serializedTokens: ${result.serialized_token_count ?? 0}`,
    `- truncated: ${result.truncated ?? false}`,
    `- changedSymbols: ${stringList(result.changed_symbols) || "none"}`,
    `- relatedSymbols: ${stringList(result.related_symbols) || "none"}`,
    `- omissions: ${stringList(result.omissions) || "none"}`,
    `- warnings: ${stringList(result.warnings) || "none"}`,
    ...(result.retry_guidance ? [`- retryGuidance: ${result.retry_guidance}`] : []),
    "",
    `Evidence (${evidence.length}):`,
  ];
  let remaining = Math.max(0, maxChars - lines.join("\n").length);
  for (const [index, item] of evidence.entries()) {
    const formatted = formatReviewEvidence(item, index + 1, remaining);
    lines.push(formatted.text);
    remaining = formatted.remaining;
    if (remaining <= 0 && index < evidence.length - 1) {
      lines.push(`- ${evidence.length - index - 1} additional evidence item(s) omitted by MCP formatting limit.`);
      break;
    }
  }
  if (evidence.length === 0) {
    lines.push("- none");
  }
  return truncateText(lines.join("\n"), maxChars);
}

function formatReviewEvidence(item, ordinal, remaining) {
  const range = asRecord(item.source_range);
  const provenance = asRecord(item.provenance);
  const score = asRecord(item.score);
  const relationship = Array.isArray(item.relationship_path)
    ? item.relationship_path.filter(isRecord).map((step) => (
        `${step.relationship_kind ?? "edge"}:`
        + `${step.source_symbol_id ?? "?"}->${step.target_symbol_id ?? "?"}`
        + `@${step.graph_distance ?? "?"}`
      )).join(" | ")
    : "";
  const prefix = [
    `${ordinal}. evidenceId: ${item.evidence_id ?? "unknown"}`,
    `   repository: ${item.repository_id ?? "unknown"}`,
    `   revision: ${item.revision ?? "unknown"}`,
    `   layer: ${item.layer ?? "unknown"}`,
    `   location: ${item.path ?? "unknown"}:${range.start_line ?? "?"}-${range.end_line ?? "?"}`,
    `   contentHash: ${item.content_hash ?? "unknown"}`,
    `   symbol: ${item.symbol_id ?? "none"}`,
    `   freshness: ${item.freshness ?? "unknown"}`,
    `   confidence: ${item.confidence ?? "unknown"}`,
    `   selectionReason: ${item.selection_reason ?? "unknown"}`,
    `   graphDistance: ${item.graph_distance ?? "none"}`,
    `   relationship: ${relationship || "none"}`,
    `   provenance: ${provenance.extractor_id ?? "unknown"}@${provenance.extractor_version ?? "unknown"}`
      + ` tier=${provenance.evidence_tier ?? "unknown"}`
      + ` resolution=${provenance.resolution_status ?? "unknown"}`
      + ` confidence=${provenance.confidence ?? "unknown"}`,
    `   score: total=${score.total ?? "unknown"} graph=${score.graph ?? 0}`
      + ` freshness=${score.freshness ?? 0} semantic=${score.semantic ?? 0}`,
    "   text:",
  ];
  const prefixText = prefix.join("\n");
  const textBudget = Math.max(0, remaining - prefixText.length - 1);
  const snippet = truncateText(typeof item.text === "string" ? item.text.trim() : "", textBudget);
  return {
    text: `${prefixText}\n${indentSnippet(snippet || "(omitted by character limit)")}`,
    remaining: Math.max(0, remaining - prefixText.length - snippet.length - 1),
  };
}

function formatCodebaseStatus({
  codebase,
  repositoriesResult,
  capabilitiesResult,
  reviewResult,
  maxRepositories,
}) {
  const selection = asRecord(codebase.repository_selection);
  const repositoryEnvelope = asRecord(repositoriesResult.value);
  const repositories = Array.isArray(repositoryEnvelope.repositories)
    ? repositoryEnvelope.repositories.filter(isRecord)
    : [];
  const capabilities = asRecord(capabilitiesResult.value);
  const review = asRecord(reviewResult.value);
  const lines = [
    "CorpusWire Codebase status:",
    `- codebaseId: ${codebase.codebase_id ?? "unknown"}`,
    `- tenantId: ${codebase.tenant_id ?? "unknown"}`,
    `- displayName: ${codebase.display_name ?? "unknown"}`,
    `- status: ${codebase.status ?? "unknown"}`,
    `- repositorySelection: ${selection.mode ?? "unknown"}`,
    `- selectedProviderRepositoryIds: ${stringList(selection.provider_repository_ids) || "none"}`,
    `- createdAt: ${codebase.created_at ?? "unknown"}`,
    `- updatedAt: ${codebase.updated_at ?? "unknown"}`,
    `- repositoriesVisible: ${repositories.length}`,
  ];
  if (repositoriesResult.error) {
    lines.push(`- repositoriesWarning: ${repositoriesResult.error}`);
  }
  if (repositories.length > 0) {
    lines.push("", "Repositories:");
    for (const repository of repositories.slice(0, maxRepositories)) {
      lines.push(
        `- ${repository.repository_id ?? "unknown"}`
          + ` ${repository.provider ?? "provider-neutral"}`
          + `:${repository.provider_external_id ?? repository.canonical_path ?? "unknown"}`
          + ` state=${repository.state ?? "unknown"}`,
      );
    }
    if (repositories.length > maxRepositories) {
      lines.push(`- ${repositories.length - maxRepositories} additional repository record(s) omitted.`);
    }
  }
  if (capabilitiesResult.error) {
    lines.push("", `Capabilities warning: ${capabilitiesResult.error}`);
  } else if (Object.keys(capabilities).length > 0) {
    lines.push(
      "",
      "Review capabilities:",
      `- enabled: ${capabilities.enabled ?? false}`,
      `- serviceAvailable: ${capabilities.service_available ?? false}`,
      `- symbolGraph: ${capabilities.symbol_graph ?? false}`,
      `- reviewOverlays: ${capabilities.review_overlays ?? false}`,
      `- providers: ${enabledCapabilityNames(capabilities.providers)}`,
      `- analyzers: ${enabledCapabilityNames(capabilities.analyzers)}`,
    );
  }
  if (reviewResult.error) {
    lines.push("", `Review status warning: ${reviewResult.error}`);
  } else if (Object.keys(review).length > 0) {
    const latestJob = asRecord(review.latest_job);
    lines.push(
      "",
      "Review status:",
      `- reviewId: ${review.review_id ?? "unknown"}`,
      `- state: ${review.state ?? "unknown"}`,
      `- targetRepositoryId: ${review.target_repository_id ?? "unknown"}`,
      `- headSha: ${review.head_sha ?? "unknown"}`,
      `- overlay: ${review.overlay_id ?? "none"}@${review.overlay_generation ?? "none"}`,
      `- freshness: ${review.freshness ?? "unknown"}`,
      `- latestJob: ${latestJob.job_id ?? "none"} ${latestJob.state ?? ""}`.trimEnd(),
      `- purgeAfter: ${review.purge_after ?? "none"}`,
      `- warnings: ${stringList(review.warnings) || "none"}`,
    );
  }
  return lines.join("\n");
}

function enabledCapabilityNames(value) {
  const record = asRecord(value);
  const enabled = Object.entries(record)
    .filter(([, available]) => available === true)
    .map(([name]) => name)
    .sort();
  return enabled.length > 0 ? enabled.join(", ") : "none";
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).join(", ")
    : "";
}

function optionalBoundedInteger(value, name, minimum, maximum) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new JsonRpcError(
      -32602,
      `Invalid ${name}: expected an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}

function nullableBoundedInteger(value, name, minimum, maximum) {
  if (value === undefined || value === null) {
    return value;
  }
  return optionalBoundedInteger(value, name, minimum, maximum);
}

async function searchContext(args) {
  const query = requiredString(args, "query");
  const topK = optionalPositiveInteger(args.topK ?? process.env.CORPUSWIRE_TOP_K, DEFAULT_TOP_K);
  const minScore = optionalScore(args.minScore ?? process.env.CORPUSWIRE_MIN_SCORE);
  const repoPath = optionalString(args.repoPath ?? process.env.CORPUSWIRE_REPO_PATH);
  const workspaceId = optionalString(args.workspaceId ?? process.env.CORPUSWIRE_WORKSPACE_ID);
  const sourceFilterRaw = optionalStringArray(args, "sourceFilter");
  const sourceFilter = sourceFilterRaw.length > 0 ? sourceFilterRaw : undefined;
  const maxChars = Math.min(
    Math.max(optionalPositiveInteger(args.maxChars ?? process.env.CORPUSWIRE_MAX_SEARCH_CHARS, 12000), 200),
    50000,
  );

  const readPreparation = await syncManager.prepareForRead(args);
  const client = buildClient();
  const request = {
    query,
    repoPath,
    workspaceId,
    topK,
    minScore,
    includeAnswer: false,
    sourceFilter,
  };
  const response = typeof client.queryRaw === "function"
    ? await client.queryRaw(request)
    : { result: await client.query(request), context: {} };
  const result = response.result ?? response;
  const context = response.context ?? {};
  const hits = Array.isArray(result.retrieved_chunks) ? result.retrieved_chunks : [];

  return formatSearchResult({
    baseUrl: client.baseUrl,
    query,
    repoPath,
    workspaceId,
    topK,
    minScore,
    maxChars,
    result,
    context,
    hits,
    readPreparation,
  });
}

async function health() {
  const client = buildClient();
  const repoPath = optionalString(process.env.CORPUSWIRE_REPO_PATH);
  const workspaceId = optionalString(process.env.CORPUSWIRE_WORKSPACE_ID);
  const response = await client.health({ repoPath, workspaceId });
  const runtime = response.runtime ?? {};
  const qdrant = response.qdrant ?? {};
  const index = response.index ?? {};
  const activeProject = response.active_project ?? {};
  const context = response.context ?? {};

  return [
    "corpuswire health:",
    `- status: ${response.ok ? "ok" : "unknown"}`,
    `- baseUrl: ${client.baseUrl}`,
    `- tenantId: ${context.tenant_id ?? "unknown"}`,
    `- userId: ${context.user_id ?? "anonymous-local"}`,
    `- actorKind: ${context.actor_kind ?? "unknown"}`,
    `- workspaceId: ${context.workspace_id ?? activeProject.workspace_id ?? "unknown"}`,
    `- indexStatus: ${index.health_status ?? "unknown"}`,
    `- corpuswire_enabled: ${runtime.corpuswire_enabled ?? "unknown"}`,
    `- qdrant_collection: ${qdrant.collection ?? "unknown"}`,
    `- indexed_at: ${index.indexed_at ?? qdrant.indexed_at ?? "unknown"}`,
    `- indexed_commit: ${index.indexed_commit ?? qdrant.indexed_commit ?? "unknown"}`,
    `- manifest_revision: ${index.manifest_revision ?? qdrant.manifest_revision ?? "unknown"}`,
    `- source_file_count: ${index.source_file_count ?? index.source_files ?? qdrant.source_file_count ?? "unknown"}`,
    `- active_project: ${activeProject.path ?? response.docs_source_dir ?? "unknown"}`,
    `- workspaceId: ${workspaceId ?? activeProject.workspace_id ?? "backend default"}`,
    ...formatWarnings(index.health_warnings),
  ].join("\n");
}

async function listIndexSessions(args) {
  const workspaceId = optionalString(args.workspaceId ?? args.workspace_id ?? process.env.CORPUSWIRE_WORKSPACE_ID);
  const client = buildClient();
  if (typeof client.listIndexSessions !== "function") {
    throw new Error("@corpuswire/sdk does not expose listIndexSessions; update the SDK before inspecting active sessions.");
  }
  const sessions = await client.listIndexSessions({ workspaceId });
  return formatIndexSessions({ baseUrl: client.baseUrl, workspaceId, sessions });
}

async function abortIndexSession(args) {
  const sessionId = optionalString(args.sessionId ?? args.session_id);
  if (!sessionId) {
    throw new JsonRpcError(-32602, "Invalid params: sessionId must be a non-empty string.");
  }
  const client = buildClient();
  if (typeof client.abortIndexSession !== "function") {
    throw new Error("@corpuswire/sdk does not expose abortIndexSession; update the SDK before aborting sessions.");
  }
  const result = await client.abortIndexSession(sessionId);
  return formatAbortIndexSession({ baseUrl: client.baseUrl, sessionId, result });
}

async function indexActivity(args) {
  const workspaceId = optionalString(args.workspaceId ?? args.workspace_id ?? process.env.CORPUSWIRE_WORKSPACE_ID);
  const collection = optionalString(args.collection);
  const windowHours = optionalPositiveInteger(args.windowHours ?? args.window_hours, 24);
  const expectedIntervalSeconds = optionalPositiveInteger(
    args.expectedIntervalSeconds ?? args.expected_interval_seconds,
    undefined,
  );
  const limit = Math.min(optionalPositiveInteger(args.limit, 10), 50);
  const client = buildClient();
  if (typeof client.getIndexActivity !== "function" || typeof client.getIndexEvents !== "function") {
    throw new Error("@corpuswire/sdk does not expose index activity helpers; update the SDK before inspecting backend activity.");
  }

  const request = { workspaceId, collection };
  const activity = await client.getIndexActivity({ ...request, windowHours, expectedIntervalSeconds });
  const events = await client.getIndexEvents({ ...request, limit });
  return formatIndexActivity({ baseUrl: client.baseUrl, workspaceId, collection, windowHours, limit, activity, events });
}

async function doctor(args) {
  const client = buildClient();
  const repoPath = optionalString(args.repoPath ?? args.repo_path ?? process.env.CORPUSWIRE_REPO_PATH);
  const workspaceId = optionalString(args.workspaceId ?? args.workspace_id ?? process.env.CORPUSWIRE_WORKSPACE_ID);
  const collection = optionalString(args.collection);
  const activityWindowHours = optionalPositiveInteger(
    args.activityWindowHours ?? args.activity_window_hours,
    24,
  );
  const errors = [];

  let healthResponse = null;
  try {
    healthResponse = await client.health({ repoPath, workspaceId });
  } catch (error) {
    errors.push(`health: ${errorMessage(error)}`);
  }

  let diagnosis = null;
  try {
    diagnosis = typeof client.diagnoseWorkspace === "function"
      ? await client.diagnoseWorkspace({ repoPath, workspaceId })
      : diagnosisFromHealth(healthResponse ?? {}, { repoPath, workspaceId });
  } catch (error) {
    errors.push(`diagnosis: ${errorMessage(error)}`);
  }

  let sessions = [];
  if (typeof client.listIndexSessions === "function") {
    try {
      sessions = await client.listIndexSessions({ workspaceId });
    } catch (error) {
      errors.push(`sessions: ${errorMessage(error)}`);
    }
  }

  let activity = null;
  if (typeof client.getIndexActivity === "function") {
    try {
      activity = await client.getIndexActivity({ workspaceId, collection, windowHours: activityWindowHours });
    } catch (error) {
      errors.push(`activity: ${errorMessage(error)}`);
    }
  }

  const syncStatus = syncManager.snapshot();
  const verdict = determineDoctorVerdict({ healthResponse, diagnosis, syncStatus, sessions, activity, errors });
  return formatDoctor({
    baseUrl: client.baseUrl,
    repoPath,
    workspaceId,
    collection,
    activityWindowHours,
    verdict,
    healthResponse,
    diagnosis,
    syncStatus,
    sessions,
    activity,
    errors,
  });
}

async function diagnoseWorkspace(args) {
  const client = buildClient();
  const repoPath = optionalString(args.repoPath ?? process.env.CORPUSWIRE_REPO_PATH);
  const workspaceId = optionalString(args.workspaceId ?? process.env.CORPUSWIRE_WORKSPACE_ID);
  const diagnosis = typeof client.diagnoseWorkspace === "function"
    ? await client.diagnoseWorkspace({ repoPath, workspaceId })
    : diagnosisFromHealth(await client.health({ repoPath, workspaceId }), { repoPath, workspaceId });
  return formatWorkspaceDiagnosis({ baseUrl: client.baseUrl, repoPath, workspaceId, diagnosis });
}

function diagnosisFromHealth(response, { repoPath, workspaceId }) {
  const index = response.index ?? {};
  const activeProject = response.active_project ?? {};
  const qdrant = response.qdrant ?? {};
  const collectionExists = typeof qdrant.collection_exists === "boolean" ? qdrant.collection_exists : undefined;
  const pointCount = Number.isInteger(qdrant.point_count) ? qdrant.point_count : undefined;
  const canRetrieve = collectionExists === true && (pointCount ?? 0) > 0;
  return {
    status: canRetrieve ? "ready" : "blocked",
    can_retrieve: canRetrieve,
    requested_repo_path: repoPath ?? null,
    requested_workspace_id: workspaceId ?? null,
    resolved_context: activeProject.path ?? response.docs_source_dir ?? "unknown",
    resolved_workspace_id: activeProject.workspace_id ?? workspaceId ?? null,
    resolution_mode: workspaceId ? "remote" : "local",
    collection: activeProject.collection ?? qdrant.collection ?? "unknown",
    collection_exists: collectionExists,
    point_count: pointCount,
    qdrant_error: qdrant.error ?? null,
    index,
    active_backend: {
      default_repo_path: response.docs_source_dir,
      default_collection: qdrant.collection,
      requested_context: activeProject.path ?? response.docs_source_dir,
      matches_requested_context: true,
    },
    checks: [],
    recovery_actions: [],
  };
}

function initialBootstrapStatus() {
  return {
    state: "not_checked",
    needsReconcile: false,
    checkedAt: null,
    reason: "Bootstrap freshness check has not run.",
    status: null,
    canRetrieve: null,
    repoPath: null,
    workspaceId: null,
    resolvedContext: null,
    resolvedWorkspaceId: null,
    collection: null,
    collectionExists: null,
    pointCount: null,
    indexHealthStatus: null,
    indexedAt: null,
    indexedCommit: null,
    manifestRevision: null,
    sourceFileCount: null,
    recoveryActions: [],
    lastError: null,
  };
}

function bootstrapStatusForTimeout(maxWaitMs) {
  return {
    ...initialBootstrapStatus(),
    state: "unknown",
    checkedAt: new Date().toISOString(),
    reason: `Bootstrap freshness check timed out after ${maxWaitMs}ms.`,
  };
}

function bootstrapStatusFromError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...initialBootstrapStatus(),
    state: "error",
    checkedAt: new Date().toISOString(),
    reason: message,
    lastError: message,
  };
}

function bootstrapStatusFromDiagnosis(diagnosis, { repoPath, workspaceId }) {
  const index = asRecord(diagnosis.index);
  const checks = Array.isArray(diagnosis.checks) ? diagnosis.checks.filter(isRecord) : [];
  const recoveryActions = compactStringArray(diagnosis.recovery_actions);
  const healthWarnings = compactStringArray(index.health_warnings);
  const checkMessages = checks
    .map((check) => [check.name, check.status, check.message].filter(Boolean).join(" "))
    .filter(Boolean);
  const diagnosisStatus = optionalString(diagnosis.status);
  const indexHealthStatus = optionalString(index.health_status);
  const textSignals = [
    diagnosisStatus,
    indexHealthStatus,
    optionalString(diagnosis.qdrant_error),
    ...healthWarnings,
    ...checkMessages,
    ...recoveryActions,
  ].filter(Boolean);
  const hasFreshnessProblem = textSignals.some(hasBootstrapFreshnessSignal);
  const collectionExists = typeof diagnosis.collection_exists === "boolean" ? diagnosis.collection_exists : null;
  const canRetrieve = typeof diagnosis.can_retrieve === "boolean" ? diagnosis.can_retrieve : null;
  const pointCount = Number.isInteger(diagnosis.point_count) ? diagnosis.point_count : null;
  const statusLooksBlocked = ["blocked", "error", "missing"].includes((diagnosisStatus ?? "").toLowerCase());
  const needsReconcile = hasFreshnessProblem
    || collectionExists === false
    || indexHealthStatus === "degraded"
    || indexHealthStatus === "stale"
    || (canRetrieve === false && (pointCount === 0 || pointCount === null));
  const firstActionableSignal = textSignals.find(hasBootstrapFreshnessSignal);
  const state = needsReconcile
    ? "needs_reconcile"
    : canRetrieve === true || diagnosisStatus === "ready"
      ? "ready"
      : statusLooksBlocked || canRetrieve === false
        ? "blocked"
        : "unknown";

  return {
    state,
    needsReconcile,
    checkedAt: new Date().toISOString(),
    reason: firstNonEmptyString(
      firstActionableSignal,
      recoveryActions[0],
      healthWarnings[0],
      checkMessages[0],
      diagnosisStatus ? `Diagnosis status is ${diagnosisStatus}.` : null,
    ),
    status: diagnosisStatus,
    canRetrieve,
    repoPath: repoPath ?? null,
    workspaceId: workspaceId ?? null,
    resolvedContext: diagnosis.resolved_context ?? null,
    resolvedWorkspaceId: diagnosis.resolved_workspace_id ?? null,
    collection: diagnosis.collection ?? index.collection ?? null,
    collectionExists,
    pointCount,
    indexHealthStatus: indexHealthStatus ?? null,
    indexedAt: index.indexed_at ?? null,
    indexedCommit: index.indexed_commit ?? null,
    manifestRevision: index.manifest_revision ?? null,
    sourceFileCount: index.source_file_count ?? index.source_files ?? null,
    recoveryActions: recoveryActions.slice(0, 5),
    lastError: null,
  };
}

function compactStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
}

function hasBootstrapFreshnessSignal(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  return [
    /stale/i,
    /degraded/i,
    /outdated/i,
    /reindex/i,
    /run CorpusWire sync/i,
    /sync workspace/i,
    /index or sync/i,
    /no indexed/i,
    /collection does not exist/i,
    /manifest is unavailable/i,
  ].some((pattern) => pattern.test(value));
}

function formatWorkspaceDiagnosis({ baseUrl, repoPath, workspaceId, diagnosis }) {
  const index = asRecord(diagnosis.index);
  const activeBackend = asRecord(diagnosis.active_backend);
  const checks = Array.isArray(diagnosis.checks) ? diagnosis.checks : [];
  const recoveryActions = Array.isArray(diagnosis.recovery_actions) ? diagnosis.recovery_actions : [];
  const lines = [
    "CorpusWire workspace diagnosis:",
    `- baseUrl: ${baseUrl}`,
    `- status: ${diagnosis.status ?? "unknown"}`,
    `- canRetrieve: ${diagnosis.can_retrieve ?? "unknown"}`,
    `- requestedRepoPath: ${repoPath ?? diagnosis.requested_repo_path ?? "backend default"}`,
    `- requestedWorkspaceId: ${workspaceId ?? diagnosis.requested_workspace_id ?? "backend default"}`,
    `- resolvedContext: ${diagnosis.resolved_context ?? "unknown"}`,
    `- resolvedWorkspaceId: ${diagnosis.resolved_workspace_id ?? "none"}`,
    `- resolutionMode: ${diagnosis.resolution_mode ?? "unknown"}`,
    `- collection: ${diagnosis.collection ?? "unknown"}`,
    `- collectionExists: ${diagnosis.collection_exists ?? "unknown"}`,
    `- pointCount: ${diagnosis.point_count ?? "unknown"}`,
    `- indexedAt: ${index.indexed_at ?? "unknown"}`,
    `- indexedCommit: ${index.indexed_commit ?? "unknown"}`,
    `- manifestRevision: ${index.manifest_revision ?? "unknown"}`,
    `- sourceFileCount: ${index.source_file_count ?? index.source_files ?? "unknown"}`,
    `- activeDefaultRepoPath: ${activeBackend.default_repo_path ?? "unknown"}`,
    `- activeDefaultCollection: ${activeBackend.default_collection ?? "unknown"}`,
    `- backendMatchesRequestedContext: ${activeBackend.matches_requested_context ?? "unknown"}`,
    ...(diagnosis.qdrant_error ? [`- qdrantError: ${diagnosis.qdrant_error}`] : []),
  ];

  if (checks.length > 0) {
    lines.push("", "Checks:");
    for (const check of checks) {
      if (!isRecord(check)) {
        continue;
      }
      lines.push(`- [${check.status ?? "unknown"}] ${check.name ?? "check"}: ${check.message ?? ""}`);
    }
  }

  if (recoveryActions.length > 0) {
    lines.push("", "Recovery:");
    for (const action of recoveryActions) {
      if (typeof action === "string" && action.trim()) {
        lines.push(`- ${action.trim()}`);
      }
    }
  }

  return lines.join("\n");
}

function formatIndexSessions({ baseUrl, workspaceId, sessions }) {
  const activeSessions = Array.isArray(sessions) ? sessions.filter(isRecord) : [];
  const lines = [
    "CorpusWire active index sessions:",
    `- baseUrl: ${baseUrl}`,
    `- workspaceId: ${workspaceId ?? "backend all"}`,
    `- activeSessions: ${activeSessions.length}`,
  ];
  if (activeSessions.length === 0) {
    lines.push("- status: none");
    return lines.join("\n");
  }

  lines.push("", "Sessions:");
  for (const [index, session] of activeSessions.entries()) {
    lines.push(
      [
        `${index + 1}. sessionId: ${session.session_id ?? "unknown"}`,
        `   workspaceId: ${session.workspace_id ?? "unknown"}`,
        `   collection: ${session.collection_name ?? "unknown"}`,
        `   mode: ${session.mode ?? "unknown"}`,
        `   phase: ${session.phase ?? "unknown"}`,
        `   manifestRevision: ${session.manifest_revision ?? "unknown"}`,
        `   filesManifested: ${session.files_manifested ?? 0}`,
        `   filesIndexed: ${session.files_indexed ?? 0}`,
        `   queueDepth: ${session.queue_depth ?? 0}`,
        `   ageSeconds: ${session.age_seconds ?? "unknown"}`,
        `   idleSeconds: ${session.idle_seconds ?? "unknown"}`,
        `   idleTimeoutSeconds: ${session.idle_timeout_seconds ?? "unknown"}`,
        `   errors: ${Array.isArray(session.errors) ? session.errors.length : 0}`,
      ].join("\n"),
    );
  }
  return lines.join("\n");
}

function formatAbortIndexSession({ baseUrl, sessionId, result }) {
  const response = isRecord(result) ? result : {};
  return [
    "CorpusWire abort index session:",
    `- baseUrl: ${baseUrl}`,
    `- requestedSessionId: ${sessionId}`,
    `- sessionId: ${response.session_id ?? sessionId}`,
    `- phase: ${response.phase ?? "unknown"}`,
    `- status: ${response.ok === false ? "unknown" : "aborted"}`,
  ].join("\n");
}

function determineDoctorVerdict({ healthResponse, diagnosis, syncStatus, sessions, activity, errors }) {
  if (errors.length > 0) {
    return "blocked";
  }
  const canRetrieve = diagnosis?.can_retrieve;
  const diagnosisStatus = optionalString(diagnosis?.status);
  if (healthResponse?.ok === false || canRetrieve === false || diagnosisStatus === "blocked") {
    return "blocked";
  }
  const pendingTotal = Number(syncStatus?.pendingTotal ?? 0);
  const hasActiveSessions = Array.isArray(sessions) && sessions.length > 0;
  const hasActivityGap = activity?.gap_detected === true;
  const consecutiveFailures = Number(activity?.consecutive_failures ?? 0);
  if (
    syncStatus?.needsReconcile === true
    || pendingTotal > 0
    || hasActiveSessions
    || hasActivityGap
    || consecutiveFailures > 0
    || diagnosisStatus === "degraded"
  ) {
    return "attention";
  }
  return "ready";
}

function formatDoctor({
  baseUrl,
  repoPath,
  workspaceId,
  collection,
  activityWindowHours,
  verdict,
  healthResponse,
  diagnosis,
  syncStatus,
  sessions,
  activity,
  errors,
}) {
  const index = asRecord(diagnosis?.index);
  const activeSessions = Array.isArray(sessions) ? sessions.filter(isRecord) : [];
  const activitySummary = isRecord(activity) ? activity : {};
  const lines = [
    "CorpusWire doctor:",
    `- verdict: ${verdict}`,
    `- baseUrl: ${baseUrl}`,
    `- repoPath: ${repoPath ?? "backend default"}`,
    `- workspaceId: ${workspaceId ?? "backend default"}`,
    `- collection: ${collection ?? diagnosis?.collection ?? index.collection ?? "backend default"}`,
    `- backendOk: ${healthResponse?.ok ?? "unknown"}`,
    `- diagnosisStatus: ${diagnosis?.status ?? "unknown"}`,
    `- canRetrieve: ${diagnosis?.can_retrieve ?? "unknown"}`,
    `- indexHealthStatus: ${index.health_status ?? "unknown"}`,
    `- manifestRevision: ${index.manifest_revision ?? "unknown"}`,
    `- syncEnabled: ${syncStatus.enabled ?? false}`,
    `- watcherActive: ${syncStatus.watcherActive ?? false}`,
    `- pendingTotal: ${syncStatus.pendingTotal ?? 0}`,
    `- needsReconcile: ${syncStatus.needsReconcile ?? false}`,
    `- activeSessions: ${activeSessions.length}`,
    `- activityWindowHours: ${activityWindowHours}`,
    `- lastAttemptStatus: ${activitySummary.last_attempt_status ?? "unknown"}`,
    `- lastSuccessAgeSeconds: ${activitySummary.last_success_age_seconds ?? "unknown"}`,
    `- consecutiveFailures: ${activitySummary.consecutive_failures ?? "unknown"}`,
    `- gapDetected: ${activitySummary.gap_detected ?? "unknown"}`,
  ];

  if (errors.length > 0) {
    lines.push("", "Errors:", ...errors.map((error) => `- ${error}`));
  }

  const recoveryActions = Array.isArray(diagnosis?.recovery_actions) ? diagnosis.recovery_actions : [];
  if (recoveryActions.length > 0) {
    lines.push("", "Recovery:");
    for (const action of recoveryActions) {
      if (typeof action === "string" && action.trim()) {
        lines.push(`- ${action.trim()}`);
      }
    }
  }

  if (activeSessions.length > 0) {
    lines.push("", "Active sessions:");
    for (const session of activeSessions.slice(0, 5)) {
      lines.push(
        `- ${session.session_id ?? "unknown"} phase=${session.phase ?? "unknown"} idleSeconds=${session.idle_seconds ?? "unknown"} queueDepth=${session.queue_depth ?? 0}`,
      );
    }
  }

  return lines.join("\n");
}

function formatIndexActivity({ baseUrl, workspaceId, collection, windowHours, limit, activity, events }) {
  const summary = isRecord(activity) ? activity : {};
  const recentEvents = Array.isArray(events) ? events.filter(isRecord) : [];
  const lines = [
    "CorpusWire index activity:",
    `- baseUrl: ${baseUrl}`,
    `- workspaceId: ${workspaceId ?? "backend default"}`,
    `- collection: ${collection ?? "backend default"}`,
    `- windowHours: ${windowHours}`,
    `- available: ${summary.available ?? "unknown"}`,
    `- eventsInWindow: ${summary.events_in_window ?? "unknown"}`,
    `- successfulEventsInWindow: ${summary.successful_events_in_window ?? "unknown"}`,
    `- failedEventsInWindow: ${summary.failed_events_in_window ?? "unknown"}`,
    `- lastAttemptAt: ${summary.last_attempt_at ?? "unknown"}`,
    `- lastAttemptStatus: ${summary.last_attempt_status ?? "unknown"}`,
    `- lastSuccessAt: ${summary.last_success_at ?? "unknown"}`,
    `- lastSuccessAgeSeconds: ${summary.last_success_age_seconds ?? "unknown"}`,
    `- consecutiveFailures: ${summary.consecutive_failures ?? "unknown"}`,
    `- gapDetected: ${summary.gap_detected ?? "unknown"}`,
    `- recentEventLimit: ${limit}`,
  ];

  if (summary.error) {
    lines.push(`- error: ${summary.error}`);
  }

  if (recentEvents.length === 0) {
    lines.push("", "Recent events:", "- none");
    return lines.join("\n");
  }

  lines.push("", "Recent events:");
  for (const [index, event] of recentEvents.entries()) {
    const parts = [
      `${index + 1}. occurredAt: ${event.occurred_at ?? "unknown"}`,
      `   operation: ${event.operation ?? "unknown"}`,
      `   status: ${event.status ?? "unknown"}`,
      `   workspaceId: ${event.workspace_id ?? "unknown"}`,
      `   mode: ${event.mode ?? "unknown"}`,
      `   sessionId: ${event.session_id ?? "unknown"}`,
      `   manifestRevision: ${event.manifest_revision ?? "unknown"}`,
      `   filesIndexed: ${event.files_indexed ?? 0}`,
      `   filesDeleted: ${event.files_deleted ?? 0}`,
      `   filesSkipped: ${event.files_skipped ?? 0}`,
      `   bytesUploaded: ${event.bytes_uploaded ?? 0}`,
      `   durationMs: ${event.duration_ms ?? "unknown"}`,
    ];
    if (event.error) {
      parts.push(`   error: ${event.error}`);
    }
    if (event.warning) {
      parts.push(`   warning: ${event.warning}`);
    }
    lines.push(parts.join("\n"));
  }

  return lines.join("\n");
}

function formatSearchResult({ baseUrl, query, repoPath, workspaceId, topK, minScore, maxChars, result, context, hits, readPreparation }) {
  const index = asRecord(context.index);
  const retrievalWarning = optionalString(result.retrieval_warning);
  const lines = [
    "CorpusWire search:",
    `- baseUrl: ${baseUrl}`,
    `- query: ${query}`,
    `- retrievalQuery: ${result.retrieval_query ?? "unknown"}`,
    `- requestedRepoPath: ${repoPath ?? "backend default"}`,
    `- requestedWorkspaceId: ${workspaceId ?? "backend default"}`,
    `- resolvedContext: ${context.repo_path ?? context.workspace_id ?? "unknown"}`,
    `- contextWorkspaceId: ${context.workspace_id ?? "unknown"}`,
    `- tenantId: ${context.tenant_id ?? "unknown"}`,
    `- userId: ${context.user_id ?? "anonymous-local"}`,
    `- actorKind: ${context.actor_kind ?? "unknown"}`,
    `- membershipRole: ${context.membership_role ?? "none"}`,
    `- collection: ${context.collection ?? "unknown"}`,
    `- indexedAt: ${index.indexed_at ?? "unknown"}`,
    `- indexedCommit: ${index.indexed_commit ?? "unknown"}`,
    `- manifestRevision: ${index.manifest_revision ?? "unknown"}`,
    `- sourceFileCount: ${index.source_file_count ?? index.source_files ?? "unknown"}`,
    `- topK: ${topK}`,
    `- minScore: ${minScore ?? "none"}`,
    `- retrievalBackend: ${result.retrieval_backend ?? "unknown"}`,
    `- retrievalConfidence: ${result.retrieval_confidence ?? "unknown"}`,
    `- retrievalNotFound: ${result.retrieval_not_found ?? hits.length === 0}`,
    `- scoreSemantics: ${result.score_semantics ?? "backend-specific rank score"}`,
    `- hits: ${hits.length}`,
    ...(retrievalWarning ? [`- retrievalWarning: ${retrievalWarning}`] : []),
    ...formatWarnings(index.health_warnings),
    ...formatReadPreparation(readPreparation),
  ];

  if (hits.length === 0) {
    lines.push("", "No hits returned.");
    const advice = retrievalRecoveryAdvice({ result, context, retrievalWarning });
    if (advice) {
      lines.push("", "Recovery:", advice);
    }
    return lines.join("\n");
  }

  const packets = Array.isArray(result.agent_context_packets) ? result.agent_context_packets : [];
  if (packets.length > 0) {
    lines.push("", "Agent context packets:");
    for (const packet of packets) {
      lines.push(formatAgentContextPacket(packet));
    }
  }

  lines.push("", "Hits:");
  let remainingChars = maxChars;
  for (const [index, hit] of hits.entries()) {
    const formatted = formatSearchHit(hit, index + 1, remainingChars);
    lines.push(formatted.text);
    remainingChars = formatted.remainingChars;
    if (remainingChars <= 0 && index < hits.length - 1) {
      lines.push(`\nResponse truncated before ${hits.length - index - 1} additional hit(s). Increase maxChars to include more text.`);
      break;
    }
  }

  if (Array.isArray(result.citations) && result.citations.length > 0) {
    lines.push("", "Citations:", ...result.citations.map((citation) => `- ${citation}`));
  }

  return lines.join("\n");
}

function formatReadPreparation(readPreparation) {
  if (!readPreparation?.enabled) {
    return [];
  }
  const freshness = readPreparation.freshness ?? {};
  const lines = [
    `- readFlushRan: ${readPreparation.flush?.flushed ?? false}`,
    `- readFlushTimedOut: ${readPreparation.flush?.timedOut ?? false}`,
    `- readGitDeltaBeforeRead: ${readPreparation.gitDelta !== null}`,
    `- readGitDeltaScanned: ${readPreparation.gitDelta?.scanned ?? false}`,
    `- readFreshnessState: ${freshness.state ?? "not_checked"}`,
    `- readNeedsReconcile: ${freshness.needsReconcile ?? false}`,
    `- readFreshnessCheckedAt: ${freshness.checkedAt ?? "never"}`,
    `- readFreshnessAgeMs: ${freshness.ageMs ?? "unknown"}`,
    `- readFreshnessStrict: ${freshness.strict ?? false}`,
  ];
  if (freshness.needsReconcile) {
    lines.push(`- readFreshnessWarning: ${freshness.reason ?? "Index needs reconciliation before it should be trusted."}`);
  }
  if (readPreparation.gitDelta?.git) {
    lines.push(`- readGitChanged: ${readPreparation.gitDelta.git.changedPaths?.length ?? 0}`);
    lines.push(`- readGitDeleted: ${readPreparation.gitDelta.git.deletedPaths?.length ?? 0}`);
  }
  return lines;
}

function formatAgentContextPacket(packet) {
  const symbols = Array.isArray(packet.symbols) && packet.symbols.length > 0
    ? packet.symbols.join(", ")
    : "none";
  const lines = Array.isArray(packet.line_ranges) && packet.line_ranges.length > 0
    ? packet.line_ranges.join(", ")
    : "unknown";
  const reasons = Array.isArray(packet.reasons) && packet.reasons.length > 0
    ? packet.reasons.join("; ")
    : "none";
  return [
    `- ${packet.inspection_order ?? "?"}. ${packet.source_path ?? "unknown"}`,
    `  role: ${packet.role ?? "unknown"}`,
    `  score: ${typeof packet.score === "number" ? packet.score.toFixed(4) : "unknown"}`,
    `  lines: ${lines}`,
    `  symbols: ${symbols}`,
    `  reasons: ${reasons}`,
  ].join("\n");
}

function formatSearchHit(hit, ordinal, remainingChars) {
  const metadata = asRecord(hit.metadata);
  const sourcePath = optionalString(metadata.source_path) ?? "unknown";
  const heading = optionalString(metadata.section_heading);
  const title = optionalString(metadata.title);
  const docType = optionalString(metadata.doc_type);
  const chunkIndex = Number.isInteger(metadata.chunk_index) ? metadata.chunk_index : "unknown";
  const score = typeof hit.score === "number" ? hit.score.toFixed(4) : "unknown";
  const tags = Array.isArray(metadata.tags) && metadata.tags.length > 0
    ? metadata.tags.filter((tag) => typeof tag === "string" && tag.trim()).join(", ")
    : "";
  const lineRange = Number.isInteger(metadata.start_line) && Number.isInteger(metadata.end_line)
    ? `${metadata.start_line}-${metadata.end_line}`
    : "";
  const rawText = typeof hit.text === "string" ? hit.text.trim() : "";
  const snippetBudget = Math.max(0, remainingChars);
  const snippet = truncateText(rawText, snippetBudget);
  const consumedChars = Math.min(rawText.length, snippetBudget);

  return {
    remainingChars: Math.max(0, remainingChars - consumedChars),
    text: [
      `\n${ordinal}. ${sourcePath}`,
      `   score: ${score}`,
      `   chunk: ${chunkIndex}`,
      ...(title ? [`   title: ${title}`] : []),
      ...(heading ? [`   heading: ${heading}`] : []),
      ...(docType ? [`   docType: ${docType}`] : []),
      ...(lineRange ? [`   lines: ${lineRange}`] : []),
      ...(metadata.package_name ? [`   package: ${metadata.package_name}`] : []),
      ...(metadata.symbol_kind ? [`   symbolKind: ${metadata.symbol_kind}`] : []),
      ...(metadata.indexed_commit ? [`   indexedCommit: ${metadata.indexed_commit}`] : []),
      ...(tags ? [`   tags: ${tags}`] : []),
      ...(hit.chunk_id ? [`   chunkId: ${hit.chunk_id}`] : []),
      "   text:",
      indentSnippet(snippet || "(empty)"),
    ].join("\n"),
  };
}

function truncateText(text, maxChars) {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = "\n... truncated";
  return `${text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`;
}

function indentSnippet(text) {
  return text
    .split("\n")
    .map((line) => `     ${line}`)
    .join("\n");
}

async function enhancePrompt(args) {
  const prompt = requiredString(args, "prompt");
  const outputMode = readOutputMode(args.outputMode ?? process.env.CORPUSWIRE_OUTPUT_MODE ?? DEFAULT_OUTPUT_MODE);
  const topK = optionalPositiveInteger(args.topK ?? process.env.CORPUSWIRE_TOP_K, DEFAULT_TOP_K);
  const minScore = optionalScore(args.minScore ?? process.env.CORPUSWIRE_MIN_SCORE);
  const repoPath = optionalString(args.repoPath ?? process.env.CORPUSWIRE_REPO_PATH);
  const workspaceId = optionalString(args.workspaceId ?? process.env.CORPUSWIRE_WORKSPACE_ID);
  const localOnly = optionalBoolean(args.localOnly ?? process.env.CORPUSWIRE_LOCAL_ONLY, true);
  const sourceFilterRaw = optionalStringArray(args, "sourceFilter");
  const sourceFilter = sourceFilterRaw.length > 0 ? sourceFilterRaw : undefined;

  const readPreparation = await syncManager.prepareForRead(args);
  const client = buildClient();
  const request = {
    prompt,
    outputMode,
    repoPath,
    workspaceId,
    topK,
    minScore,
    localOnly,
    sourceFilter,
  };
  const { result, usedLocalFallback } = await enhanceWithLocalFallback(client, request);

  const enhancedPrompt = resolveEnhancedPrompt(result);
  if (!enhancedPrompt) {
    throw new Error(result.generation_error ?? "corpuswire returned no enhanced prompt.");
  }
  const recoveryAdvice = retrievalRecoveryAdvice({
    result,
    context: { repo_path: result.repo_path, workspace_id: result.workspace_id },
    retrievalWarning: optionalString(result.retrieval_warning),
  });
  const contextUsed = Array.isArray(result.agent_context_packets)
    ? result.agent_context_packets.slice(0, 10).map((packet) => {
      const sourcePath = optionalString(packet?.source_path) ?? "unknown source";
      const role = optionalString(packet?.role) ?? "context";
      const score = Number.isFinite(Number(packet?.score)) ? Number(packet.score).toFixed(3) : "unknown";
      return `- \`${sourcePath}\` (role: ${role}; score: ${score})`;
    })
    : [];

  return [
    "Prompt augmentation preview",
    "",
    "Original prompt:",
    indentPreviewBlock(prompt.trim()),
    "",
    "Augmented prompt:",
    indentPreviewBlock(enhancedPrompt),
    "",
    "Context used:",
    ...(contextUsed.length > 0 ? contextUsed : ["- No repository context was selected."]),
    "",
    "Retrieval metadata:",
    `- baseUrl: ${client.baseUrl}`,
    `- repoPath: ${repoPath ?? "backend default"}`,
    `- workspaceId: ${workspaceId ?? result.workspace_id ?? "backend default"}`,
    `- tenantId: ${result.tenant_id ?? "unknown"}`,
    `- userId: ${result.user_id ?? "anonymous-local"}`,
    `- actorKind: ${result.actor_kind ?? "unknown"}`,
    `- membershipRole: ${result.membership_role ?? "none"}`,
    `- outputMode: ${result.output_mode ?? outputMode}`,
    `- topK: ${topK}`,
    `- taskType: ${result.task_type ?? "unknown"}`,
    `- retrievalBackend: ${result.retrieval_backend ?? "unknown"}`,
    `- retrievalConfidence: ${result.retrieval_confidence ?? "unknown"}`,
    `- retrievalNotFound: ${result.retrieval_not_found ?? false}`,
    `- scoreSemantics: ${result.score_semantics ?? "backend-specific rank score"}`,
    ...(result.retrieval_warning ? [`- retrievalWarning: ${result.retrieval_warning}`] : []),
    `- enhancementBackend: ${result.enhancement_backend ?? "unknown"}`,
    ...(usedLocalFallback ? ["- localFallback: retried with localOnly=true after generation setup failed"] : []),
    ...(result.generation_error ? [`- generationError: ${result.generation_error}`] : []),
    ...formatReadPreparation(readPreparation),
    ...formatAgentContextPackets(result.agent_context_packets),
    ...(recoveryAdvice ? ["", "Recovery:", recoveryAdvice] : []),
    ...(Array.isArray(result.citations) && result.citations.length > 0
      ? ["", "Citations:", ...result.citations.map((citation) => `- ${citation}`)]
      : []),
  ].join("\n");
}

function indentPreviewBlock(text) {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

async function recordQualityResult(args) {
  const workspaceId = optionalString(args.workspaceId ?? process.env.CORPUSWIRE_WORKSPACE_ID);
  if (!workspaceId) {
    throw new JsonRpcError(-32602, "Quality ratings require workspaceId or CORPUSWIRE_WORKSPACE_ID.");
  }
  const workType = requiredString(args, "workType").toLowerCase();
  if (!QUALITY_WORK_TYPE_SET.has(workType)) {
    throw new JsonRpcError(
      -32602,
      `workType must be one of: ${QUALITY_WORK_TYPES.join(", ")}.`,
    );
  }
  const engine = requiredString(args, "engine").toLowerCase();
  const client = buildClient();
  const event = await client.recordQualityEvent({
    workspaceId,
    workType,
    engine,
    scorecard: {
      relevance: qualityDimension(args.relevance, "relevance"),
      fileSpecificity: qualityDimension(args.fileSpecificity, "fileSpecificity"),
      coverage: qualityDimension(args.coverage, "coverage"),
      freshness: qualityDimension(args.freshness, "freshness"),
      actionability: qualityDimension(args.actionability, "actionability"),
    },
    query: optionalString(args.query) ?? "",
    surface: optionalString(args.surface) ?? "codex",
    roundId: optionalString(args.roundId),
    resultPaths: optionalStringArray(args, "resultPaths"),
    warning: optionalString(args.warning),
    improvement: optionalString(args.improvement),
    notes: optionalString(args.notes),
    issueUrl: optionalString(args.issueUrl),
    metadata: isRecord(args.metadata) ? args.metadata : {},
  });
  return [
    "CorpusWire quality rating recorded:",
    `- eventId: ${event.event_id}`,
    `- workspaceId: ${event.workspace_id}`,
    `- workType: ${event.work_type}`,
    `- engine: ${event.engine}`,
    `- overall: ${event.overall}`,
    `- relevance: ${event.relevance}`,
    `- fileSpecificity: ${event.file_specificity}`,
    `- coverage: ${event.coverage}`,
    `- freshness: ${event.freshness}`,
    `- actionability: ${event.actionability}`,
    `- queryStoredAs: ${event.query}`,
    ...(event.improvement ? [`- improvement: ${event.improvement}`] : []),
    ...(event.issue_url ? [`- issueUrl: ${event.issue_url}`] : []),
  ].join("\n");
}

async function reviewQualityResults(args) {
  const client = buildClient();
  const workspaceId = optionalString(args.workspaceId);
  const workType = optionalString(args.workType);
  if (workType && !QUALITY_WORK_TYPE_SET.has(workType)) {
    throw new JsonRpcError(
      -32602,
      `workType must be one of: ${QUALITY_WORK_TYPES.join(", ")}.`,
    );
  }
  const review = await client.reviewQuality({
    workspaceId,
    workType,
    engine: optionalString(args.engine),
    days: optionalPositiveInteger(args.days, 30),
  });
  const lines = [
    "CorpusWire central quality review:",
    `- windowDays: ${review.window_days}`,
    `- eventCount: ${review.event_count}`,
    `- overallAverage: ${review.overall_average}`,
    `- workspaceFilter: ${workspaceId ?? "all"}`,
    `- workTypeFilter: ${workType ?? "all"}`,
    `- engineFilter: ${optionalString(args.engine) ?? "all"}`,
    "",
    "Dimension averages:",
  ];
  for (const [name, value] of Object.entries(review.dimension_averages ?? {})) {
    lines.push(`- ${name}: ${value}`);
  }
  lines.push("", "Engine averages:");
  for (const [name, summary] of Object.entries(review.by_engine ?? {})) {
    lines.push(`- ${name}: ${summary?.overall_average ?? "unknown"} (${summary?.count ?? 0} event(s))`);
  }
  lines.push("", "Recommended actions:");
  const actions = Array.isArray(review.recommended_actions) ? review.recommended_actions : [];
  lines.push(...(actions.length > 0 ? actions.map((action) => `- ${action}`) : ["- none yet"]));
  const improvements = Array.isArray(review.recurring_improvements) ? review.recurring_improvements : [];
  if (improvements.length > 0) {
    lines.push("", "Recurring improvements:");
    for (const item of improvements.slice(0, 10)) {
      lines.push(`- ${item.value} (${item.count})`);
    }
  }
  const lowScores = Array.isArray(review.low_score_events) ? review.low_score_events : [];
  if (lowScores.length > 0) {
    lines.push("", "Low-score events:");
    for (const event of lowScores.slice(0, 10)) {
      lines.push(`- ${event.event_id} ${event.workspace_id} ${event.engine} overall=${event.overall}`);
    }
  }
  return lines.join("\n");
}

async function confirmQueryValue(args) {
  const eventId = requiredString(args, "eventId");
  const minutesSaved = Number(args.minutesSaved);
  const confirmedValue = args.confirmedValue === undefined ? undefined : Number(args.confirmedValue);
  if (!Number.isFinite(minutesSaved) || minutesSaved < 0) {
    throw new JsonRpcError(-32602, "minutesSaved must be a non-negative number.");
  }
  if (confirmedValue !== undefined && (!Number.isFinite(confirmedValue) || confirmedValue < 0)) {
    throw new JsonRpcError(-32602, "confirmedValue must be a non-negative number.");
  }
  const event = await buildClient().confirmQueryValue({
    eventId,
    minutesSaved,
    confirmedValue,
    confirmedBy: optionalString(args.confirmedBy),
  });
  return [
    "CorpusWire query value confirmed:",
    `- eventId: ${event.event_id}`,
    `- minutesSaved: ${event.confirmed_minutes_saved}`,
    `- confirmedValue: ${event.confirmed_value ?? "not provided"}`,
    `- status: ${event.value_status}`,
  ].join("\n");
}

async function reviewQueryValue(args) {
  const period = optionalString(args.period) ?? "day";
  if (!["day", "week", "month"].includes(period)) {
    throw new JsonRpcError(-32602, "period must be day, week, or month.");
  }
  const hourlyRate = args.hourlyRate === undefined ? undefined : Number(args.hourlyRate);
  if (hourlyRate !== undefined && (!Number.isFinite(hourlyRate) || hourlyRate < 0)) {
    throw new JsonRpcError(-32602, "hourlyRate must be a non-negative number.");
  }
  const client = buildClient();
  if (typeof client.valueRollup !== "function") {
    throw new Error(
      "@corpuswire/sdk does not expose valueRollup; rebuild and re-vendor the SDK so the MCP runtime matches its advertised tools.",
    );
  }
  const rollup = await client.valueRollup({
    period,
    days: optionalPositiveInteger(args.days, 30),
    workspaceId: optionalString(args.workspaceId),
    hourlyRate,
  });
  return [
    "CorpusWire value rollup:",
    `- period: ${rollup.period}`,
    `- days: ${rollup.days}`,
    `- hourlyRate: ${rollup.hourly_rate ?? "not configured"}`,
    `- buckets: ${JSON.stringify(rollup.buckets)}`,
  ].join("\n");
}

function qualityDimension(value, name) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5) {
    throw new JsonRpcError(-32602, `${name} must be a number between 1 and 5.`);
  }
  return parsed;
}

function formatAgentContextPackets(packets) {
  if (!Array.isArray(packets) || packets.length === 0) {
    return [];
  }
  return ["", "Agent context packets:", ...packets.map(formatAgentContextPacket)];
}

async function enhanceWithLocalFallback(client, request) {
  try {
    return { result: await client.enhance(request), usedLocalFallback: false };
  } catch (error) {
    if (request.localOnly || !isGenerationSetupError(error)) {
      throw error;
    }
    return {
      result: await client.enhance({ ...request, localOnly: true }),
      usedLocalFallback: true,
    };
  }
}

function isGenerationSetupError(error) {
  const message = [
    error?.errorMessage,
    error?.message,
    error?.responseBody,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");

  return message.includes("Prompt rewriting requires a configured generation backend")
    || message.includes("Unsupported GENERATION_PROVIDER");
}

function formatWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return [];
  }
  return warnings
    .filter((warning) => typeof warning === "string" && warning.trim())
    .map((warning) => `- indexWarning: ${warning.trim()}`);
}

function retrievalRecoveryAdvice({ result, context, retrievalWarning }) {
  const backend = optionalString(result?.retrieval_backend);
  const warning = retrievalWarning ?? optionalString(result?.retrieval_warning);
  if (backend !== "none" || !warning) {
    return "";
  }

  const resolvedContext = optionalString(context?.repo_path) ?? optionalString(context?.workspace_id) ?? "this workspace";
  if (/stale remote index/i.test(warning) || /filtered \d+ stale/i.test(warning)) {
    return `Reindex or sync ${resolvedContext}; the configured API collection exists, but all candidate hits were filtered as stale.`;
  }

  return `Check that ${resolvedContext} is indexed and that the requested repoPath/workspaceId matches the intended workspace.`;
}

function buildClient() {
  const policy = resolveBackendPolicy();
  const { basicAuth, bearerToken } = resolveAuthConfiguration();
  const observabilityEnabled = optionalBoolean(
    process.env.CORPUSWIRE_INDEX_OBSERVABILITY_ENABLED,
    false,
  );
  const traceCollector = createMcpServerTraceCollector();
  const client = new sdk.CorpusWireClient({
    baseUrl: policy.baseUrl,
    basicAuth,
    bearerToken,
    endpointMode: "v1-only",
    defaultHeaders: observabilityEnabled
      ? { [INDEX_OBSERVABILITY_HEADER]: "1" }
      : undefined,
    fetchFn: async (input, init = {}) => {
      try {
        const response = await fetch(input, { ...init, redirect: "error" });
        if (observabilityEnabled) {
          traceCollector.observe(response);
        }
        return response;
      } catch (error) {
        if (observabilityEnabled) {
          traceCollector.recordClientError("client_transport_error");
        }
        throw error;
      }
    },
  });
  Object.defineProperty(client, "indexObservability", {
    value: observabilityEnabled ? traceCollector : null,
    enumerable: false,
  });
  return client;
}

function createMcpServerTraceCollector() {
  const stageTimingsMs = {};
  let modelState = "unknown";
  let errorState = "none";
  return {
    observe(response) {
      if (response?.headers?.get?.("x-corpuswire-index-trace") !== INDEX_OBSERVABILITY_SCHEMA_VERSION) {
        return;
      }
      for (const item of (response.headers.get("server-timing") ?? "").split(",")) {
        const match = item.match(/^\s*cw_([a-z_]+)\s*;\s*dur=([0-9]+(?:\.[0-9]+)?)/i);
        if (!match || !INDEX_OBSERVABILITY_STAGES.has(match[1])) {
          continue;
        }
        const duration = Number(match[2]);
        if (Number.isFinite(duration) && duration >= 0) {
          stageTimingsMs[match[1]] = (stageTimingsMs[match[1]] ?? 0) + Math.round(duration);
        }
      }
      const observedModelState = response.headers.get("x-corpuswire-index-model-state");
      if (modelState === "unknown" && ["warm", "cold", "disabled"].includes(observedModelState)) {
        modelState = observedModelState;
      }
      const observedErrorState = response.headers.get("x-corpuswire-index-error-state");
      if (observedErrorState && observedErrorState !== "none") {
        errorState = /^http_[45][0-9]{2}$/.test(observedErrorState)
          ? observedErrorState
          : "server_error";
      }
    },
    recordClientError(state = "client_error") {
      if (errorState === "none") {
        errorState = state;
      }
    },
    snapshot() {
      return { stageTimingsMs: { ...stageTimingsMs }, modelState, errorState };
    },
  };
}

function buildMcpIndexTrace({
  client = null,
  response = null,
  totalDurationMs,
  fileDiscoveryDurationMs = null,
  fileReadDurationMs = null,
}) {
  const collector = client?.indexObservability;
  if (!collector && !optionalBoolean(process.env.CORPUSWIRE_INDEX_OBSERVABILITY_ENABLED, false)) {
    return undefined;
  }
  const stagesMs = Object.fromEntries(
    [...INDEX_OBSERVABILITY_STAGES].map((stage) => [stage, null]),
  );
  const addTimings = (timings) => {
    if (!timings || typeof timings !== "object") {
      return;
    }
    for (const [stage, duration] of Object.entries(timings)) {
      if (!(stage in stagesMs) || typeof duration !== "number" || !Number.isFinite(duration)) {
        continue;
      }
      stagesMs[stage] = (stagesMs[stage] ?? 0) + Math.max(0, Math.round(duration));
    }
  };
  const collected = collector?.snapshot() ?? {
    stageTimingsMs: {},
    modelState: "unknown",
    errorState: "none",
  };
  addTimings(collected.stageTimingsMs);
  addTimings(response?.status?.progress?.phase_timings_ms);
  if (typeof fileDiscoveryDurationMs === "number") {
    stagesMs.file_discovery = Math.max(0, Math.round(fileDiscoveryDurationMs));
  }
  if (typeof fileReadDurationMs === "number") {
    stagesMs.file_read = Math.max(0, Math.round(fileReadDurationMs));
  }
  stagesMs.mcp_receipt = Math.max(0, Math.round(totalDurationMs));
  return {
    schema_version: INDEX_OBSERVABILITY_SCHEMA_VERSION,
    stages_ms: stagesMs,
    total_duration_ms: Math.max(0, Math.round(totalDurationMs)),
    error_state: collected.errorState,
    model_state: collected.modelState,
    sensitive_payloads_captured: false,
  };
}

function resolveEnhancedPrompt(result) {
  return firstNonEmptyString(
    result?.enhanced_prompt,
    result?.rewritten_prompt,
    result?.augmented_prompt,
    result?.enhancement_prompt,
  );
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function requiredString(args, key) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new JsonRpcError(-32602, `Invalid params: ${key} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOutputMode(value) {
  const normalized = typeof value === "string" ? value.trim() : DEFAULT_OUTPUT_MODE;
  if (OUTPUT_MODES.has(normalized)) {
    return normalized;
  }
  throw new JsonRpcError(-32602, `Invalid outputMode: ${value}. Expected one of: ${[...OUTPUT_MODES].join(", ")}.`);
}

function optionalPositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new JsonRpcError(-32602, `Invalid topK: ${value}. Expected a positive integer.`);
  }
  return parsed;
}

function optionalNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new JsonRpcError(-32602, `Invalid integer: ${value}. Expected a non-negative integer.`);
  }
  return parsed;
}

function optionalScore(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new JsonRpcError(-32602, `Invalid minScore: ${value}. Expected a number from 0 to 1.`);
  }
  return parsed;
}

function optionalBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  throw new JsonRpcError(-32602, `Invalid boolean value: ${value}. Expected a boolean.`);
}

function optionalStringArray(args, ...keys) {
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null) {
      continue;
    }
    return normalizeStringArray(value, key);
  }
  return [];
}

function resolveSyncGlobList(args, envValue, ...keys) {
  const argumentValue = optionalStringArray(args, ...keys);
  if (argumentValue.length > 0) {
    return argumentValue;
  }
  return normalizeStringArray(envValue, keys[0], { allowString: true });
}

function normalizeStringArray(value, label, { allowString = false } = {}) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim());
  }
  if (allowString && typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.startsWith("[")) {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new JsonRpcError(-32602, `Invalid ${label}: expected a JSON array or comma-separated glob list.`);
      }
      return normalizeStringArray(parsed, label);
    }
    return trimmed
      .split(/[,\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  throw new JsonRpcError(-32602, `Invalid ${label}: expected an array of strings.`);
}

function syncContextKey(context) {
  return [
    context.sourceRoot,
    context.workspaceId,
    JSON.stringify(context.includeGlobs ?? []),
    JSON.stringify(context.excludeGlobs ?? []),
  ].join("\0");
}

function isSyncIndexableRelativePath(relativePath, context) {
  return classifySyncRelativePath(relativePath, context).accepted;
}

function classifySyncRelativePath(relativePath, context) {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (isSensitiveTerraformRelativePath(normalized)) {
    return { accepted: false, reason: "sensitive_terraform_artifact" };
  }
  if (isDiscoveryOnlyRelativePath(normalized)) {
    return { accepted: false, reason: "discovery_only_metadata" };
  }
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment) || segment.startsWith("."))
    && !SAFE_INDEXABLE_PATHS.has(normalized)
  ) {
    return { accepted: false, reason: "excluded_segment" };
  }
  const effectivePath = effectiveIndexableRelativePath(normalized);
  const effectiveName = path.posix.basename(effectivePath).toLowerCase();
  const extensions = context.indexableExtensions ?? INDEXABLE_EXTENSIONS;
  const filenames = context.indexableFilenames ?? INDEXABLE_FILENAMES;
  if (
    !extensions.has(path.posix.extname(effectivePath).toLowerCase())
    && !filenames.has(effectiveName)
  ) {
    return { accepted: false, reason: "unsupported_extension" };
  }
  const includeGlobs = context.includeGlobs ?? [];
  if (includeGlobs.length > 0 && !matchesAnySyncGlob(normalized, includeGlobs)) {
    return { accepted: false, reason: "include_filter" };
  }
  const excludeGlobs = context.excludeGlobs ?? [];
  if (excludeGlobs.length > 0 && matchesAnySyncGlob(normalized, excludeGlobs)) {
    return { accepted: false, reason: "exclude_filter" };
  }
  return { accepted: true, reason: "accepted" };
}

function effectiveIndexableRelativePath(relativePath) {
  const loweredPath = relativePath.toLowerCase();
  for (const suffix of CONFIG_EXAMPLE_SUFFIXES) {
    if (loweredPath.endsWith(suffix)) {
      return relativePath.slice(0, -".example".length);
    }
  }
  return relativePath;
}

function isSensitiveTerraformRelativePath(relativePath) {
  const name = path.posix.basename(relativePath).toLowerCase();
  return name.endsWith(".tfvars")
    || name.endsWith(".tfvars.json")
    || name.includes(".tfstate")
    || name === "crash.log"
    || name === "tfplan"
    || name.endsWith(".tfplan")
    || name.endsWith(".plan")
    || name.endsWith(".plan.json");
}

function isDiscoveryOnlyRelativePath(relativePath) {
  const name = path.posix.basename(relativePath).toLowerCase();
  return DISCOVERY_ONLY_FILENAMES.has(name)
    || (name.startsWith("tsconfig") && name.endsWith(".json"))
    || (name.endsWith(".txt") && (
      name === "requirements.txt"
      || name === "constraints.txt"
      || name.startsWith("requirements-")
      || name.startsWith("requirements_")
      || name.startsWith("constraints-")
      || name.startsWith("constraints_")
    ));
}

function isSafeIndexableDirectoryAncestor(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\/+|\/+$/g, "");
  return [...SAFE_INDEXABLE_PATHS].some((safePath) => safePath.startsWith(`${normalized}/`));
}

function matchesAnySyncGlob(relativePath, patterns) {
  if (matchesAnyGlob(relativePath, patterns)) {
    return true;
  }
  const effectivePath = effectiveIndexableRelativePath(relativePath);
  return effectivePath !== relativePath && matchesAnyGlob(effectivePath, patterns);
}

function isExcludedDirectory(relativePath, excludeGlobs) {
  if (!relativePath || !Array.isArray(excludeGlobs) || excludeGlobs.length === 0) {
    return false;
  }
  const normalized = relativePath.replaceAll("\\", "/").replace(/\/+$/, "");
  return matchesAnyGlob(normalized, excludeGlobs)
    || matchesAnyGlob(`${normalized}/`, excludeGlobs)
    || matchesAnyGlob(`${normalized}/${DIRECTORY_GLOB_PROBE}`, excludeGlobs);
}

function matchesAnyGlob(relativePath, patterns) {
  const normalizedPath = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalizedPath));
}

const globRegExpCache = new Map();

function globToRegExp(pattern) {
  const normalizedPattern = String(pattern).trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  const cacheKey = normalizedPattern;
  const cached = globRegExpCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const effectivePattern = normalizedPattern.includes("/") ? normalizedPattern : `**/${normalizedPattern}`;
  let source = "^";
  for (let index = 0; index < effectivePattern.length; index += 1) {
    const character = effectivePattern[index];
    if (character === "*") {
      const nextCharacter = effectivePattern[index + 1];
      if (nextCharacter === "*") {
        index += 1;
        if (effectivePattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(character);
  }
  source += "$";
  const regexp = new RegExp(source);
  globRegExpCache.set(cacheKey, regexp);
  return regexp;
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function isIndexableRelativePath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (isSensitiveTerraformRelativePath(normalized)) {
    return false;
  }
  if (isDiscoveryOnlyRelativePath(normalized)) {
    return false;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment) || segment.startsWith("."))
    && !SAFE_INDEXABLE_PATHS.has(normalized)
  ) {
    return false;
  }
  const effectivePath = effectiveIndexableRelativePath(normalized);
  return INDEXABLE_EXTENSIONS.has(path.posix.extname(effectivePath).toLowerCase())
    || INDEXABLE_FILENAMES.has(path.posix.basename(effectivePath).toLowerCase());
}

function isMissingFileError(error) {
  return isRecord(error) && ["ENOENT", "ENOTDIR"].includes(error.code);
}

function removeUndefinedValues(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

async function runGit(cwd, args, { timeoutMs, maxBuffer }) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer,
  });
  return typeof stdout === "string" ? stdout.trimEnd() : String(stdout).trimEnd();
}

function parseGitStatusPorcelainZ(output) {
  if (!output) {
    return [];
  }
  const fields = output.split("\0");
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) {
      continue;
    }
    if (record.length < 4) {
      continue;
    }
    const status = record.slice(0, 2);
    const relativePath = normalizeGitStatusPath(record.slice(3));
    if (!relativePath) {
      continue;
    }
    if (status.includes("R") || status.includes("C")) {
      const oldPath = normalizeGitStatusPath(fields[index + 1] ?? "");
      index += 1;
      entries.push({
        status,
        path: relativePath,
        oldPath,
        kind: status.includes("R") ? "rename" : "copy",
      });
      continue;
    }
    entries.push({
      status,
      path: relativePath,
      kind: status === "??" ? "untracked" : "change",
    });
  }
  return entries;
}

function normalizeGitStatusPath(value) {
  return typeof value === "string"
    ? value.trim().replaceAll("\\", "/").replace(/^\.\/+/, "")
    : "";
}

function gitStatusEntriesToDelta(entries) {
  const changedPaths = new Set();
  const deletedPaths = new Set();
  let renamed = 0;
  let copied = 0;
  let untracked = 0;

  for (const entry of entries) {
    if (!entry.path || entry.status === "!!") {
      continue;
    }
    if (entry.kind === "rename") {
      renamed += 1;
      changedPaths.add(entry.path);
      if (entry.oldPath) {
        deletedPaths.add(entry.oldPath);
      }
      continue;
    }
    if (entry.kind === "copy") {
      copied += 1;
      changedPaths.add(entry.path);
      continue;
    }
    if (entry.kind === "untracked" || entry.status === "??") {
      untracked += 1;
      changedPaths.add(entry.path);
      continue;
    }
    const indexStatus = entry.status[0];
    const worktreeStatus = entry.status[1];
    if (indexStatus === "D" || worktreeStatus === "D") {
      deletedPaths.add(entry.path);
      continue;
    }
    if ([indexStatus, worktreeStatus].some((status) => status && status !== " ")) {
      changedPaths.add(entry.path);
    }
  }

  for (const deletedPath of deletedPaths) {
    changedPaths.delete(deletedPath);
  }

  return {
    changedPaths: [...changedPaths].sort(),
    deletedPaths: [...deletedPaths].sort(),
    renamed,
    copied,
    untracked,
  };
}

function isActiveSessionConflictError(error) {
  const message = errorMessage(error);
  if (!/409\b/.test(message) && error?.status !== 409) {
    return false;
  }
  return /index session is already active/i.test(message)
    || /already active for workspace_id/i.test(message);
}

function calculateSessionConflictRetryDelayMs(error, { attempt, baseDelayMs, maxDelayMs }) {
  const retryAfterMs = retryAfterMsFromError(error);
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, maxDelayMs);
  }
  return Math.min(baseDelayMs * (attempt + 1), maxDelayMs);
}

function retryAfterMsFromError(error) {
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) {
    return Math.trunc(error.retryAfterMs);
  }
  if (Number.isFinite(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0) {
    return Math.trunc(error.retryAfterSeconds * 1000);
  }

  const detail = parseErrorDetail(error);
  const retryAfterSeconds = Number(detail?.retry_after_seconds);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.trunc(retryAfterSeconds * 1000);
  }
  return null;
}

function parseErrorDetail(error) {
  const candidates = [
    error?.errorDetail,
    parseJsonObject(error?.responseBody),
    parseJsonObject(errorMessage(error).replace(/^\d{3}\s+\w+:\s*/, "")),
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const detail = candidate.detail;
    if (isRecord(detail)) {
      return detail;
    }
    return candidate;
  }
  return null;
}

function parseJsonObject(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function errorMessage(error) {
  return [
    error?.errorMessage,
    error?.message,
    error?.responseBody,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    || String(error);
}

async function sleepMs(delayMs) {
  if (delayMs <= 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function awaitWithTimeout(promise, timeoutMs) {
  if (timeoutMs <= 0) {
    return { timedOut: true };
  }

  let timer;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function formatPathProbePayload(payload) {
  const lines = [
    "CorpusWire sync path probe:",
    `- enabled: ${payload.enabled ?? "unknown"}`,
    `- sourceRoot: ${payload.sourceRoot ?? "unknown"}`,
    `- workspaceId: ${payload.workspaceId ?? "unknown"}`,
    `- requestedPaths: ${payload.requestedPaths ?? 0}`,
    `- probedPaths: ${payload.probedPaths ?? 0}`,
    `- truncated: ${payload.truncated ?? false}`,
    `- includeHash: ${payload.includeHash ?? false}`,
    `- maxFileSizeBytes: ${payload.maxFileSizeBytes ?? "unknown"}`,
  ];
  if (payload.reason) {
    lines.push(`- reason: ${payload.reason}`);
  }

  const results = Array.isArray(payload.results) ? payload.results.filter(isRecord) : [];
  if (results.length === 0) {
    lines.push("", "Paths:", "- none");
    return lines.join("\n");
  }

  lines.push("", "Paths:");
  for (const [index, result] of results.entries()) {
    const parts = [
      `${index + 1}. rawPath: ${result.rawPath ?? "unknown"}`,
      `   relativePath: ${result.relativePath ?? "unknown"}`,
      `   pathAccepted: ${result.pathAccepted ?? false}`,
      `   decision: ${result.decision ?? "unknown"}`,
      `   reason: ${result.reason ?? "unknown"}`,
      `   exists: ${result.exists ?? "unknown"}`,
      `   isFile: ${result.isFile ?? "unknown"}`,
      `   sizeBytes: ${result.sizeBytes ?? "unknown"}`,
      `   mtimeNs: ${result.mtimeNs ?? "unknown"}`,
    ];
    if (result.sha256) {
      parts.push(`   sha256: ${result.sha256}`);
    }
    lines.push(parts.join("\n"));
  }

  return lines.join("\n");
}

function formatSyncPayload(payload) {
  const status = payload.status ?? payload.flush?.status ?? {};
  const lines = [
    "CorpusWire sync:",
    `- enabled: ${status.enabled ?? payload.enabled ?? "unknown"}`,
    `- watcherActive: ${status.watcherActive ?? false}`,
    `- bootstrapActive: ${status.bootstrapActive ?? false}`,
    `- gitDeltaActive: ${status.gitDeltaActive ?? false}`,
    `- flushActive: ${status.flushActive ?? false}`,
    `- reconcileActive: ${status.reconcileActive ?? false}`,
    `- timerActive: ${status.timerActive ?? false}`,
    `- reconcileTimerActive: ${status.reconcileTimerActive ?? false}`,
    `- cacheEnabled: ${status.cacheEnabled ?? false}`,
    `- cacheUsable: ${status.cacheUsable ?? false}`,
    `- cachePath: ${status.cachePath ?? "not_loaded"}`,
    `- cacheEntries: ${status.cacheEntries ?? 0}`,
    `- cacheLoadedAt: ${status.cacheLoadedAt ?? "never"}`,
    `- cacheUpdatedAt: ${status.cacheUpdatedAt ?? "never"}`,
    `- cacheDecisions: ${formatSyncCountMap(status.cacheDecisionCounts)}`,
    `- pendingChanged: ${status.pendingChanged ?? 0}`,
    `- pendingDeleted: ${status.pendingDeleted ?? 0}`,
    `- pendingTotal: ${status.pendingTotal ?? 0}`,
    `- pendingSourceRoot: ${status.pendingSourceRoot ?? "none"}`,
    `- pendingWorkspaceId: ${status.pendingWorkspaceId ?? "none"}`,
    `- pendingOldestAgeMs: ${status.pendingOldestAgeMs ?? 0}`,
    `- firstQueuedAt: ${status.firstQueuedAt ?? "never"}`,
    `- lastEventAt: ${status.lastEventAt ?? "never"}`,
    `- lastFlushStartedAt: ${status.lastFlushStartedAt ?? "never"}`,
    `- lastFlushFinishedAt: ${status.lastFlushFinishedAt ?? "never"}`,
    `- lastFlushDurationMs: ${status.lastFlushDurationMs ?? "none"}`,
    `- averageFlushDurationMs: ${status.averageFlushDurationMs ?? "none"}`,
    `- lastReconcileStartedAt: ${status.lastReconcileStartedAt ?? "never"}`,
    `- lastReconcileFinishedAt: ${status.lastReconcileFinishedAt ?? "never"}`,
    `- lastReconcileDurationMs: ${status.lastReconcileDurationMs ?? "none"}`,
    `- lastGitScanStartedAt: ${status.lastGitScanStartedAt ?? "never"}`,
    `- lastGitScanFinishedAt: ${status.lastGitScanFinishedAt ?? "never"}`,
    `- lastGitScanDurationMs: ${status.lastGitScanDurationMs ?? "none"}`,
    `- lastGitHead: ${status.lastGitHead ?? "unknown"}`,
    `- lastGitBranch: ${status.lastGitBranch ?? "unknown"}`,
    `- lastGitDeltaCounts: ${formatSyncCountMap(status.lastGitDeltaCounts, ["statusEntries", "changed", "deleted", "renamed", "copied", "untracked"])}`,
    `- lastError: ${status.lastError ?? "none"}`,
    `- sessionConflictRetries: ${formatSyncCountMap(status.sessionConflictRetryCounts, ["retries", "exhausted"])}`,
    `- lastSessionConflictAt: ${status.lastSessionConflictAt ?? "never"}`,
    `- lastSessionConflictOperation: ${status.lastSessionConflictOperation ?? "none"}`,
    `- lastSessionConflictAttempt: ${status.lastSessionConflictAttempt ?? "none"}`,
    `- lastSessionConflictRetryDelayMs: ${status.lastSessionConflictRetryDelayMs ?? "none"}`,
    `- lastSessionConflictMessage: ${status.lastSessionConflictMessage ?? "none"}`,
    `- bootstrapState: ${status.bootstrapState ?? "not_checked"}`,
    `- needsReconcile: ${status.needsReconcile ?? false}`,
    `- bootstrapCheckedAt: ${status.bootstrapCheckedAt ?? "never"}`,
    `- bootstrapReason: ${status.bootstrapReason ?? "none"}`,
    `- bootstrapDiagnosisStatus: ${status.bootstrapStatus ?? "unknown"}`,
    `- bootstrapCanRetrieve: ${status.bootstrapCanRetrieve ?? "unknown"}`,
    `- bootstrapCollection: ${status.bootstrapCollection ?? "unknown"}`,
    `- bootstrapIndexHealthStatus: ${status.bootstrapIndexHealthStatus ?? "unknown"}`,
    `- bootstrapIndexedAt: ${status.bootstrapIndexedAt ?? "unknown"}`,
    `- bootstrapIndexedCommit: ${status.bootstrapIndexedCommit ?? "unknown"}`,
    `- bootstrapManifestRevision: ${status.bootstrapManifestRevision ?? "unknown"}`,
    `- bootstrapLastError: ${status.bootstrapLastError ?? "none"}`,
    `- acceptedEvents: ${formatSyncCountMap(status.acceptedEventCounts, ["changed", "deleted"])}`,
    `- skippedEvents: ${formatSyncCountMap(status.skippedEventCounts)}`,
  ];

  if (payload.reason) {
    lines.push(`- reason: ${payload.reason}`);
  }
  if (Array.isArray(payload.acceptedChanged)) {
    lines.push(`- acceptedChanged: ${payload.acceptedChanged.length}`);
  }
  if (Array.isArray(payload.acceptedDeleted)) {
    lines.push(`- acceptedDeleted: ${payload.acceptedDeleted.length}`);
  }
  if (Array.isArray(payload.skipped)) {
    lines.push(`- skipped: ${payload.skipped.length}`);
  }
  if (payload.flushReason) {
    lines.push(`- flushReason: ${payload.flushReason}`);
  }
  if (payload.git) {
    lines.push(`- gitStatusEntries: ${payload.git.statusEntries ?? 0}`);
    lines.push(`- gitChanged: ${payload.git.changedPaths?.length ?? 0}`);
    lines.push(`- gitDeleted: ${payload.git.deletedPaths?.length ?? 0}`);
    lines.push(`- gitRenamed: ${payload.git.renamed ?? 0}`);
    lines.push(`- gitCopied: ${payload.git.copied ?? 0}`);
    lines.push(`- gitUntracked: ${payload.git.untracked ?? 0}`);
    lines.push(`- gitHead: ${payload.git.head ?? "unknown"}`);
    lines.push(`- gitBranch: ${payload.git.branch ?? "unknown"}`);
  }
  if (payload.sync?.acceptedChanged) {
    lines.push(`- acceptedChanged: ${payload.sync.acceptedChanged.length}`);
  }
  if (payload.sync?.acceptedDeleted) {
    lines.push(`- acceptedDeleted: ${payload.sync.acceptedDeleted.length}`);
  }
  if (payload.sync?.skipped) {
    lines.push(`- skipped: ${payload.sync.skipped.length}`);
  }
  if (payload.sync?.flushReason) {
    lines.push(`- flushReason: ${payload.sync.flushReason}`);
  }
  const flushPayload = payload.flush ?? payload.sync?.flush;
  if (flushPayload) {
    lines.push(`- flushTimedOut: ${flushPayload.timedOut ?? false}`);
    lines.push(`- flushRan: ${flushPayload.flushed ?? false}`);
    if (Array.isArray(flushPayload.summaries) && flushPayload.summaries.length > 0) {
      lines.push("", "Flush summaries:");
      for (const [index, summary] of flushPayload.summaries.entries()) {
        lines.push(formatSyncSummary(summary, index + 1));
      }
    }
  } else if (Array.isArray(payload.summaries) && payload.summaries.length > 0) {
    lines.push("", "Flush summaries:");
    for (const [index, summary] of payload.summaries.entries()) {
      lines.push(formatSyncSummary(summary, index + 1));
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, "reconciled")
    || Object.prototype.hasOwnProperty.call(payload, "timedOut")) {
    lines.push(`- reconcileTimedOut: ${payload.timedOut ?? false}`);
    lines.push(`- reconcileRan: ${payload.reconciled ?? false}`);
  }
  if (payload.backendContinues !== undefined) {
    lines.push(`- backendContinues: ${payload.backendContinues}`);
  }
  if (payload.sessionId) {
    lines.push(`- sessionId: ${payload.sessionId}`);
  }
  if (payload.reattach) {
    lines.push(`- reattach: ${payload.reattach}`);
  }
  if (payload.reconcile) {
    lines.push("", "Reconciliation summary:", formatSyncSummary(payload.reconcile, 1));
  }
  if (Array.isArray(status.bootstrapRecoveryActions) && status.bootstrapRecoveryActions.length > 0) {
    lines.push("", "Bootstrap recovery:");
    for (const action of status.bootstrapRecoveryActions) {
      if (typeof action === "string" && action.trim()) {
        lines.push(`- ${action.trim()}`);
      }
    }
  }

  if (status.lastResult) {
    lines.push("", "Last result:", indentSnippet(JSON.stringify(status.lastResult, null, 2)));
  }
  if (Array.isArray(status.recentEvents) && status.recentEvents.length > 0) {
    lines.push("", "Recent sync events:");
    for (const event of status.recentEvents.slice(0, 10)) {
      if (!isRecord(event)) {
        continue;
      }
      lines.push(formatSyncEvent(event));
    }
  }

  return lines.join("\n");
}

function formatSyncCountMap(value, preferredKeys = []) {
  if (!isRecord(value)) {
    return "none";
  }
  const keys = [
    ...preferredKeys,
    ...Object.keys(value).filter((key) => !preferredKeys.includes(key)).sort(),
  ];
  const parts = [];
  for (const key of keys) {
    const count = value[key];
    if (typeof count === "number" && count > 0) {
      parts.push(`${key}=${count}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "none";
}

function formatSyncEvent(event) {
  const pathLabel = event.relativePath ?? event.rawPath ?? "unknown";
  return [
    `- ${event.occurredAt ?? "unknown"}`,
    `${event.source ?? "unknown"}`,
    `${event.eventType ?? "event"}`,
    `${event.decision ?? "unknown"}`,
    `${event.reason ?? "unknown"}`,
    pathLabel,
  ].join(" ");
}

function formatSyncSummary(summary, ordinal) {
  const compact = summarizeSyncResult(summary);
  const observability = asRecord(compact?.observability);
  const observabilityStages = asRecord(observability.stages_ms);
  const measuredStages = Object.entries(observabilityStages)
    .filter(([, duration]) => typeof duration === "number" && Number.isFinite(duration))
    .map(([stage, duration]) => `${stage}=${Math.max(0, Math.round(duration))}ms`);
  return [
    `${ordinal}. filesQueued: ${compact?.filesQueued ?? 0}`,
    `   filesUploaded: ${compact?.filesUploaded ?? 0}`,
    `   filesDeleted: ${compact?.filesDeleted ?? 0}`,
    `   filesSkipped: ${compact?.filesSkipped ?? 0}`,
    `   reconcile: ${compact?.reconcile ?? false}`,
    `   noOp: ${compact?.noOp ?? false}`,
    ...(compact?.error ? [`   error: ${compact.error}`] : []),
    ...(compact?.detached ? ["   detached: true"] : []),
    ...(compact?.backendContinues ? ["   backendContinues: true"] : []),
    ...(compact?.sessionId ? [`   sessionId: ${compact.sessionId}`] : []),
    ...(compact?.collection ? [`   collection: ${compact.collection}`] : []),
    ...(compact?.manifestRevision ? [`   manifestRevision: ${compact.manifestRevision}`] : []),
    ...(observability.schema_version === INDEX_OBSERVABILITY_SCHEMA_VERSION
      ? [
        `   observability: ${observability.schema_version} model=${observability.model_state ?? "unknown"} error=${observability.error_state ?? "unknown"} total=${observability.total_duration_ms ?? 0}ms`,
        `   stages: ${measuredStages.length > 0 ? measuredStages.join(", ") : "none"}`,
      ]
      : []),
  ].join("\n");
}

function summarizeSyncResult(result) {
  if (!result) {
    return null;
  }
  const response = asRecord(result.response);
  const responseResult = asRecord(response.result);
  const responseStatus = asRecord(response.status);
  return {
    noOp: Boolean(result.noOp),
    filesQueued: result.filesQueued ?? 0,
    filesUploaded: result.filesUploaded ?? 0,
    filesDeleted: result.filesDeleted ?? 0,
    filesSkipped: result.filesSkipped ?? 0,
    durationMs: result.durationMs,
    reconcile: Boolean(result.reconcile),
    detached: Boolean(result.detached),
    backendContinues: Boolean(result.backendContinues),
    sessionId: result.sessionId,
    error: result.error,
    collection: responseResult.collection,
    documentsIndexed: responseResult.documents_indexed,
    filesAdded: responseResult.files_added,
    filesUpdated: responseResult.files_updated,
    manifestRevision: responseStatus.manifest_revision,
    observability: result.observability,
  };
}

function textToolResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function formatToolError(error, operation = "request") {
  const message = error instanceof Error ? error.message : String(error);
  if (isConnectionError(message)) {
    const baseUrl = process.env.CORPUSWIRE_BASE_URL ?? DEFAULT_BASE_URL;
    return `Could not connect to corpuswire at ${baseUrl} while handling the ${operation}. Start the FastAPI server and try again. ${message}`;
  }
  if (sdk.CorpusWireHttpError && error instanceof sdk.CorpusWireHttpError) {
    const guidance = boundedRecoveryGuidance(error.recoveryGuidance);
    const suffix = guidance.length > 0
      ? ` Recovery guidance: ${guidance.join(" ")}`
      : "";
    return `corpuswire rejected the ${operation}: ${error.errorMessage ?? message}${suffix}`;
  }
  return `corpuswire ${operation} failed: ${message}`;
}

function boundedRecoveryGuidance(value) {
  return Array.isArray(value)
    ? value.filter((item) => (
      typeof item === "string"
      && item.length > 0
      && item.length <= 256
      && !item.includes("\\n")
      && !item.includes("\\r")
    )).slice(0, 4)
    : [];
}

function boundedSupportedFileValues(value, pattern) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0 && item.length <= 64 && pattern.test(item)))]
    .sort()
    .slice(0, 256);
}

function isConnectionError(message) {
  return message.includes("fetch failed")
    || message.includes("ECONNREFUSED")
    || message.includes("ECONNRESET")
    || message.includes("ENOTFOUND");
}

function normalizeError(error, fallbackCode, fallbackMessage) {
  if (error instanceof JsonRpcError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new JsonRpcError(fallbackCode, fallbackMessage, message);
}

function errorResponse(id, error) {
  const payload = {
    code: error.code,
    message: error.message,
  };
  if (error.data !== undefined) {
    payload.data = error.data;
  }
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: payload,
  };
}

function asRecord(value) {
  return isRecord(value) ? value : {};
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
