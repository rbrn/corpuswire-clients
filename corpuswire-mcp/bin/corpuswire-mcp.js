#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, watch as watchFileSystem } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const JSONRPC_VERSION = "2.0";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "corpuswire-context-engine";
const SERVER_VERSION = "0.1.2";
const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_OUTPUT_MODE = "generic";
const DEFAULT_TOP_K = 5;
const DEFAULT_SYNC_DEBOUNCE_MS = 1000;
const DEFAULT_SYNC_READ_FLUSH_TIMEOUT_MS = 250;
const DEFAULT_SYNC_FLUSH_TIMEOUT_MS = 60000;
const DEFAULT_SYNC_MAX_FILE_SIZE_BYTES = 512 * 1024;
const DEFAULT_SYNC_MAX_PENDING_PATHS = 100;
const DEFAULT_SYNC_RECONCILE_MAX_FILES = 5000;
const DIRECTORY_GLOB_PROBE = "__corpuswire_directory_probe__";
const OUTPUT_MODES = new Set(["generic", "copilot", "claude-code", "sequential"]);
const INDEXABLE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".csv",
  ".pdf",
  ".java",
  ".py",
  ".sh",
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
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
    this.watcher = null;
    this.reconcileTimer = null;
    this.lastResult = null;
    this.lastError = null;
    this.lastFlushStartedAt = null;
    this.lastFlushFinishedAt = null;
    this.lastReconcileStartedAt = null;
    this.lastReconcileFinishedAt = null;
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

  isEnabled() {
    return optionalBoolean(this.env.CORPUSWIRE_SYNC_ENABLED, false);
  }

  async addDelta(args) {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        reason: "Set CORPUSWIRE_SYNC_ENABLED=true to enable incremental sync.",
        status: this.snapshot(),
      };
    }

    const context = this.resolveContext(args);
    const changedPaths = optionalStringArray(args, "changedPaths", "changed_paths");
    const deletedPaths = optionalStringArray(args, "deletedPaths", "deleted_paths");
    const acceptedChanged = [];
    const acceptedDeleted = [];
    const skipped = [];

    this.ensurePendingContext(context);

    for (const rawPath of changedPaths) {
      const normalized = this.normalizePath(rawPath, context);
      if (normalized === null) {
        skipped.push(rawPath);
        continue;
      }
      this.pendingChangedPaths.set(normalized.relativePath, normalized.absolutePath);
      this.pendingDeletedPaths.delete(normalized.relativePath);
      acceptedChanged.push(normalized.relativePath);
    }

    for (const rawPath of deletedPaths) {
      const normalized = this.normalizePath(rawPath, context);
      if (normalized === null) {
        skipped.push(rawPath);
        continue;
      }
      this.pendingChangedPaths.delete(normalized.relativePath);
      this.pendingDeletedPaths.add(normalized.relativePath);
      acceptedDeleted.push(normalized.relativePath);
    }

    const shouldFlush = optionalBoolean(args.flush, false);
    if (shouldFlush) {
      const flush = await this.flushAll({
        maxWaitMs: optionalPositiveInteger(args.maxWaitMs, DEFAULT_SYNC_FLUSH_TIMEOUT_MS),
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

  async flushExplicit(args = {}) {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        reason: "Set CORPUSWIRE_SYNC_ENABLED=true to enable incremental sync.",
        status: this.snapshot(),
      };
    }
    return this.flushAll({ maxWaitMs: optionalPositiveInteger(args.maxWaitMs, DEFAULT_SYNC_FLUSH_TIMEOUT_MS) });
  }

  async flushBeforeRead() {
    if (!this.isEnabled() || !optionalBoolean(this.env.CORPUSWIRE_SYNC_FLUSH_BEFORE_READ, true)) {
      return;
    }
    try {
      await this.flushAll({
        maxWaitMs: optionalPositiveInteger(
          this.env.CORPUSWIRE_SYNC_READ_FLUSH_TIMEOUT_MS,
          DEFAULT_SYNC_READ_FLUSH_TIMEOUT_MS,
        ),
      });
    } catch (error) {
      this.recordError(error);
    }
  }

  async reconcileExplicit(args = {}) {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        reason: "Set CORPUSWIRE_SYNC_ENABLED=true to enable reconciliation.",
        status: this.snapshot(),
      };
    }

    const maxWaitMs = optionalPositiveInteger(args.maxWaitMs, DEFAULT_SYNC_FLUSH_TIMEOUT_MS);
    const reconciliation = this.reconcileAll(args);
    const waited = await awaitWithTimeout(reconciliation, maxWaitMs);
    if (waited.timedOut) {
      return {
        enabled: true,
        reconciled: false,
        timedOut: true,
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

  async reconcileAll(args = {}) {
    if (this.activeReconcile) {
      return this.activeReconcile;
    }

    const context = this.resolveContext(args);
    this.activeReconcile = this.runReconcile(context, args)
      .catch((error) => {
        this.recordError(error);
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
      });
    return this.activeReconcile;
  }

  async flushAll({ maxWaitMs }) {
    const summaries = [];
    const deadline = Date.now() + maxWaitMs;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    while (true) {
      if (this.activeFlush) {
        const waited = await awaitWithTimeout(this.activeFlush, Math.max(0, deadline - Date.now()));
        if (waited.timedOut) {
          return {
            enabled: true,
            flushed: false,
            timedOut: true,
            summaries,
            status: this.snapshot(),
          };
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
        return {
          enabled: true,
          flushed: summaries.length > 0,
          timedOut: true,
          summaries,
          status: this.snapshot(),
        };
      }

      const batch = this.takePendingBatch();
      const flush = this.runBatch(batch)
        .catch((error) => {
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
        return {
          enabled: true,
          flushed: summaries.length > 0,
          timedOut: true,
          summaries,
          status: this.snapshot(),
        };
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

  async runBatch(batch) {
    this.lastFlushStartedAt = new Date().toISOString();
    const files = [];
    const deletedPaths = new Set(batch.deletedPaths);
    const skippedPaths = [];

    for (const entry of batch.changedPaths) {
      try {
        const remoteFile = await this.readRemoteFile(entry);
        if (remoteFile.file) {
          files.push(remoteFile.file);
        } else if (remoteFile.deleted) {
          deletedPaths.add(entry.relativePath);
        } else {
          skippedPaths.push(entry.relativePath);
        }
      } catch (error) {
        if (isMissingFileError(error)) {
          deletedPaths.add(entry.relativePath);
        } else {
          throw error;
        }
      }
    }

    if (files.length === 0 && deletedPaths.size === 0) {
      const result = {
        ok: true,
        noOp: true,
        filesQueued: batch.changedPaths.length,
        filesUploaded: 0,
        filesDeleted: 0,
        filesSkipped: skippedPaths.length,
        skippedPaths,
      };
      this.recordResult(result);
      return result;
    }

    const client = buildClient();
    if (typeof client.indexWorkspace !== "function") {
      throw new Error("@corpuswire/sdk does not expose indexWorkspace; update the SDK before enabling sync.");
    }

    const response = await client.indexWorkspace({
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
        indexed_commit: optionalString(this.env.CORPUSWIRE_SYNC_INDEXED_COMMIT),
      }),
      maxConcurrentUploads: optionalPositiveInteger(
        this.env.CORPUSWIRE_SYNC_MAX_CONCURRENT_UPLOADS,
        undefined,
      ),
      batchBytes: optionalPositiveInteger(this.env.CORPUSWIRE_SYNC_BATCH_BYTES, undefined),
      maxFileSizeBytes: optionalPositiveInteger(
        this.env.CORPUSWIRE_SYNC_MAX_FILE_SIZE_BYTES,
        DEFAULT_SYNC_MAX_FILE_SIZE_BYTES,
      ),
      files,
      deletedPaths: [...deletedPaths].sort(),
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
    };
    this.recordResult(result);
    return result;
  }

  async runReconcile(context, args) {
    this.lastReconcileStartedAt = new Date().toISOString();
    await this.flushAll({ maxWaitMs: optionalPositiveInteger(args.flushMaxWaitMs, DEFAULT_SYNC_FLUSH_TIMEOUT_MS) });

    const maxFiles = optionalPositiveInteger(
      args.maxFiles ?? this.env.CORPUSWIRE_SYNC_RECONCILE_MAX_FILES,
      DEFAULT_SYNC_RECONCILE_MAX_FILES,
    );
    const changedPaths = await this.collectWorkspaceFileEntries(context, maxFiles);
    const files = [];
    const skippedPaths = [];
    for (const entry of changedPaths) {
      try {
        const remoteFile = await this.readRemoteFile(entry);
        if (remoteFile.file) {
          files.push(remoteFile.file);
        } else {
          skippedPaths.push(entry.relativePath);
        }
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }

    const client = buildClient();
    if (typeof client.indexWorkspace !== "function") {
      throw new Error("@corpuswire/sdk does not expose indexWorkspace; update the SDK before enabling reconciliation.");
    }

    const response = await client.indexWorkspace({
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
        indexed_commit: optionalString(this.env.CORPUSWIRE_SYNC_INDEXED_COMMIT),
      }),
      maxConcurrentUploads: optionalPositiveInteger(
        this.env.CORPUSWIRE_SYNC_MAX_CONCURRENT_UPLOADS,
        undefined,
      ),
      batchBytes: optionalPositiveInteger(this.env.CORPUSWIRE_SYNC_BATCH_BYTES, undefined),
      maxFileSizeBytes: optionalPositiveInteger(
        this.env.CORPUSWIRE_SYNC_MAX_FILE_SIZE_BYTES,
        DEFAULT_SYNC_MAX_FILE_SIZE_BYTES,
      ),
      files,
      deletedPaths: [],
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
      response,
    };
    this.recordResult(result);
    this.lastReconcileFinishedAt = new Date().toISOString();
    return result;
  }

  async readRemoteFile(entry) {
    const fileStat = await stat(entry.absolutePath);
    if (!fileStat.isFile()) {
      return { skipped: true };
    }

    const maxFileSizeBytes = optionalPositiveInteger(
      this.env.CORPUSWIRE_SYNC_MAX_FILE_SIZE_BYTES,
      DEFAULT_SYNC_MAX_FILE_SIZE_BYTES,
    );
    if (fileStat.size > maxFileSizeBytes) {
      return { skipped: true };
    }

    const content = await readFile(entry.absolutePath);
    return {
      file: {
        relativePath: entry.relativePath,
        content,
        sha256: createHash("sha256").update(content).digest("hex"),
        mtimeNs: Math.trunc(fileStat.mtimeMs * 1_000_000),
      },
    };
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
        if (EXCLUDED_PATH_SEGMENTS.has(entry.name)) {
          continue;
        }
        const absolutePath = path.join(directory, entry.name);
        const relativePath = path.relative(sourceRoot, absolutePath).split(path.sep).join("/");
        if (entry.isDirectory()) {
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

  normalizePath(rawPath, context) {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return null;
    }
    const absolutePath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(context.sourceRoot, rawPath);
    const relativePath = path.relative(context.sourceRoot, absolutePath);
    if (!relativePath || relativePath === "." || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new JsonRpcError(-32602, `Path is outside sourceRoot: ${rawPath}`);
    }
    const posixRelativePath = relativePath.split(path.sep).join("/");
    if (!isSyncIndexableRelativePath(posixRelativePath, context)) {
      return null;
    }
    return { absolutePath, relativePath: posixRelativePath };
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
      }
    }
    for (const relativePath of batch.deletedPaths) {
      if (!this.pendingChangedPaths.has(relativePath) && !this.pendingDeletedPaths.has(relativePath)) {
        this.pendingDeletedPaths.add(relativePath);
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

    return {
      sourceRoot: context.sourceRoot,
      workspaceId: context.workspaceId,
      includeGlobs: context.includeGlobs,
      excludeGlobs: context.excludeGlobs,
      changedPaths,
      deletedPaths,
    };
  }

  requeueBatch(batch) {
    this.pendingRetryBatches.unshift(batch);
  }

  recordResult(result) {
    this.lastResult = result;
    this.lastError = null;
    this.lastFlushFinishedAt = new Date().toISOString();
  }

  recordError(error) {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.lastFlushFinishedAt = new Date().toISOString();
  }

  snapshot() {
    return {
      enabled: this.isEnabled(),
      watcherActive: this.watcher !== null,
      flushActive: this.activeFlush !== null,
      reconcileActive: this.activeReconcile !== null,
      timerActive: this.timer !== null,
      reconcileTimerActive: this.reconcileTimer !== null,
      pendingChanged: this.pendingChangedPaths.size,
      pendingDeleted: this.pendingDeletedPaths.size,
      pendingRetryBatches: this.pendingRetryBatches.length,
      pendingTotal: this.pendingSize(),
      pendingSourceRoot: this.pendingContext?.sourceRoot ?? null,
      pendingWorkspaceId: this.pendingContext?.workspaceId ?? null,
      lastFlushStartedAt: this.lastFlushStartedAt,
      lastFlushFinishedAt: this.lastFlushFinishedAt,
      lastReconcileStartedAt: this.lastReconcileStartedAt,
      lastReconcileFinishedAt: this.lastReconcileFinishedAt,
      lastError: this.lastError,
      lastResult: summarizeSyncResult(this.lastResult),
    };
  }
}

const syncManager = new SyncManager();
syncManager.startWatcherIfConfigured();
syncManager.startScheduledReconcileIfConfigured();

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
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
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
      return { tools: toolDefinitions() };
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
  if (name === "corpuswire_search") {
    try {
      return textToolResult(await searchContext(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "search request"), true);
    }
  }
  if (name === "corpuswire_enhance_prompt") {
    try {
      return textToolResult(await enhancePrompt(args));
    } catch (error) {
      return textToolResult(formatToolError(error, "enhancement request"), true);
    }
  }
  if (name === "corpuswire_health") {
    try {
      return textToolResult(await health());
    } catch (error) {
      return textToolResult(formatToolError(error, "health request"), true);
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
      return textToolResult(formatSyncPayload(await syncManager.flushExplicit(args)));
    } catch (error) {
      return textToolResult(formatToolError(error, "sync flush request"), true);
    }
  }
  if (name === "corpuswire_sync_reconcile") {
    try {
      return textToolResult(formatSyncPayload(await syncManager.reconcileExplicit(args)));
    } catch (error) {
      return textToolResult(formatToolError(error, "sync reconcile request"), true);
    }
  }
  if (name === "corpuswire_sync_status") {
    try {
      return textToolResult(formatSyncPayload({ status: syncManager.snapshot() }));
    } catch (error) {
      return textToolResult(formatToolError(error, "sync status request"), true);
    }
  }

  throw new JsonRpcError(-32602, `Unknown tool: ${name}`);
}

function toolDefinitions() {
  return [
    {
      name: "corpuswire_search",
      description: "Search the CorpusWire index for repository or remote workspace context using corpuswire /query without answer generation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Semantic retrieval query to run against a local or remote workspace index.",
          },
          repoPath: {
            type: "string",
            description: "Service-local repository root used to scope retrieval. Defaults to CORPUSWIRE_REPO_PATH when set.",
          },
          workspaceId: {
            type: "string",
            description: "Remote workspace id used to scope retrieval. Defaults to CORPUSWIRE_WORKSPACE_ID when set.",
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
        },
        required: ["query"],
      },
    },
    {
      name: "corpuswire_enhance_prompt",
      description: "Enhance a base Codex prompt with repository or remote workspace context using corpuswire /v1/enhance.",
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
            description: "Remote workspace id used to scope retrieval. Defaults to CORPUSWIRE_WORKSPACE_ID when set.",
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
        },
        required: ["prompt"],
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
      name: "corpuswire_sync_delta",
      description: "Queue changed and deleted workspace paths for incremental CorpusWire remote indexing.",
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
            description: "Remote workspace id used by the CorpusWire index. Defaults to CORPUSWIRE_WORKSPACE_ID.",
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
      description: "Flush queued CorpusWire incremental sync changes to the remote indexer.",
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
            description: "Maximum time to wait for reconciliation to finish.",
          },
          maxFiles: {
            type: "integer",
            minimum: 1,
            default: DEFAULT_SYNC_RECONCILE_MAX_FILES,
            description: "Maximum number of indexable files to include in one reconciliation scan.",
          },
        },
      },
    },
    {
      name: "corpuswire_sync_status",
      description: "Report CorpusWire incremental sync queue, watcher, and last flush status.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  ];
}

async function searchContext(args) {
  const query = requiredString(args, "query");
  const topK = optionalPositiveInteger(args.topK ?? process.env.CORPUSWIRE_TOP_K, DEFAULT_TOP_K);
  const minScore = optionalScore(args.minScore ?? process.env.CORPUSWIRE_MIN_SCORE);
  const repoPath = optionalString(args.repoPath ?? process.env.CORPUSWIRE_REPO_PATH);
  const workspaceId = optionalString(args.workspaceId ?? process.env.CORPUSWIRE_WORKSPACE_ID);
  const maxChars = Math.min(
    Math.max(optionalPositiveInteger(args.maxChars ?? process.env.CORPUSWIRE_MAX_SEARCH_CHARS, 12000), 200),
    50000,
  );

  await syncManager.flushBeforeRead();
  const client = buildClient();
  const request = {
    query,
    repoPath,
    workspaceId,
    topK,
    minScore,
    includeAnswer: false,
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

  return [
    "corpuswire health:",
    `- status: ${response.ok ? "ok" : "unknown"}`,
    `- baseUrl: ${client.baseUrl}`,
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

function formatSearchResult({ baseUrl, query, repoPath, workspaceId, topK, minScore, maxChars, result, context, hits }) {
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
    `- collection: ${context.collection ?? "unknown"}`,
    `- indexedAt: ${index.indexed_at ?? "unknown"}`,
    `- indexedCommit: ${index.indexed_commit ?? "unknown"}`,
    `- manifestRevision: ${index.manifest_revision ?? "unknown"}`,
    `- sourceFileCount: ${index.source_file_count ?? index.source_files ?? "unknown"}`,
    `- topK: ${topK}`,
    `- minScore: ${minScore ?? "none"}`,
    `- retrievalBackend: ${result.retrieval_backend ?? "unknown"}`,
    `- hits: ${hits.length}`,
    ...(retrievalWarning ? [`- retrievalWarning: ${retrievalWarning}`] : []),
    ...formatWarnings(index.health_warnings),
  ];

  if (hits.length === 0) {
    lines.push("", "No hits returned.");
    const advice = retrievalRecoveryAdvice({ result, context, retrievalWarning });
    if (advice) {
      lines.push("", "Recovery:", advice);
    }
    return lines.join("\n");
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
  return `${text.slice(0, Math.max(0, maxChars - 15)).trimEnd()}\n   ... truncated`;
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

  await syncManager.flushBeforeRead();
  const client = buildClient();
  const request = {
    prompt,
    outputMode,
    repoPath,
    workspaceId,
    topK,
    minScore,
    localOnly,
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

  return [
    "Enhanced prompt:",
    enhancedPrompt,
    "",
    "Retrieval metadata:",
    `- baseUrl: ${client.baseUrl}`,
    `- repoPath: ${repoPath ?? "backend default"}`,
    `- workspaceId: ${workspaceId ?? result.workspace_id ?? "backend default"}`,
    `- outputMode: ${result.output_mode ?? outputMode}`,
    `- topK: ${topK}`,
    `- taskType: ${result.task_type ?? "unknown"}`,
    `- retrievalBackend: ${result.retrieval_backend ?? "unknown"}`,
    ...(result.retrieval_warning ? [`- retrievalWarning: ${result.retrieval_warning}`] : []),
    `- enhancementBackend: ${result.enhancement_backend ?? "unknown"}`,
    ...(usedLocalFallback ? ["- localFallback: retried with localOnly=true after generation setup failed"] : []),
    ...(result.generation_error ? [`- generationError: ${result.generation_error}`] : []),
    ...(recoveryAdvice ? ["", "Recovery:", recoveryAdvice] : []),
    ...(Array.isArray(result.citations) && result.citations.length > 0
      ? ["", "Citations:", ...result.citations.map((citation) => `- ${citation}`)]
      : []),
  ].join("\n");
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
    return `Reindex or sync ${resolvedContext}; the remote collection exists, but all candidate hits were filtered as stale.`;
  }

  return `Check that ${resolvedContext} is indexed and that the requested repoPath/workspaceId matches the intended workspace.`;
}

function buildClient() {
  return new sdk.CorpusWireClient({
    baseUrl: process.env.CORPUSWIRE_BASE_URL ?? DEFAULT_BASE_URL,
    basicAuth: process.env.CORPUSWIRE_BASIC_AUTH ?? "",
    endpointMode: "v1-only",
  });
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
  if (!isIndexableRelativePath(relativePath)) {
    return false;
  }
  const includeGlobs = context.includeGlobs ?? [];
  if (includeGlobs.length > 0 && !matchesAnyGlob(relativePath, includeGlobs)) {
    return false;
  }
  const excludeGlobs = context.excludeGlobs ?? [];
  return excludeGlobs.length === 0 || !matchesAnyGlob(relativePath, excludeGlobs);
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
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment))) {
    return false;
  }
  return INDEXABLE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase());
}

function isMissingFileError(error) {
  return isRecord(error) && ["ENOENT", "ENOTDIR"].includes(error.code);
}

function removeUndefinedValues(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
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

function formatSyncPayload(payload) {
  const status = payload.status ?? payload.flush?.status ?? {};
  const lines = [
    "CorpusWire sync:",
    `- enabled: ${status.enabled ?? payload.enabled ?? "unknown"}`,
    `- watcherActive: ${status.watcherActive ?? false}`,
    `- flushActive: ${status.flushActive ?? false}`,
    `- reconcileActive: ${status.reconcileActive ?? false}`,
    `- timerActive: ${status.timerActive ?? false}`,
    `- reconcileTimerActive: ${status.reconcileTimerActive ?? false}`,
    `- pendingChanged: ${status.pendingChanged ?? 0}`,
    `- pendingDeleted: ${status.pendingDeleted ?? 0}`,
    `- pendingTotal: ${status.pendingTotal ?? 0}`,
    `- pendingSourceRoot: ${status.pendingSourceRoot ?? "none"}`,
    `- pendingWorkspaceId: ${status.pendingWorkspaceId ?? "none"}`,
    `- lastFlushStartedAt: ${status.lastFlushStartedAt ?? "never"}`,
    `- lastFlushFinishedAt: ${status.lastFlushFinishedAt ?? "never"}`,
    `- lastReconcileStartedAt: ${status.lastReconcileStartedAt ?? "never"}`,
    `- lastReconcileFinishedAt: ${status.lastReconcileFinishedAt ?? "never"}`,
    `- lastError: ${status.lastError ?? "none"}`,
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
  if (payload.flush) {
    lines.push(`- flushTimedOut: ${payload.flush.timedOut ?? false}`);
    lines.push(`- flushRan: ${payload.flush.flushed ?? false}`);
    if (Array.isArray(payload.flush.summaries) && payload.flush.summaries.length > 0) {
      lines.push("", "Flush summaries:");
      for (const [index, summary] of payload.flush.summaries.entries()) {
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
  if (payload.reconcile) {
    lines.push("", "Reconciliation summary:", formatSyncSummary(payload.reconcile, 1));
  }

  if (status.lastResult) {
    lines.push("", "Last result:", indentSnippet(JSON.stringify(status.lastResult, null, 2)));
  }

  return lines.join("\n");
}

function formatSyncSummary(summary, ordinal) {
  const compact = summarizeSyncResult(summary);
  return [
    `${ordinal}. filesQueued: ${compact?.filesQueued ?? 0}`,
    `   filesUploaded: ${compact?.filesUploaded ?? 0}`,
    `   filesDeleted: ${compact?.filesDeleted ?? 0}`,
    `   filesSkipped: ${compact?.filesSkipped ?? 0}`,
    `   reconcile: ${compact?.reconcile ?? false}`,
    `   noOp: ${compact?.noOp ?? false}`,
    ...(compact?.error ? [`   error: ${compact.error}`] : []),
    ...(compact?.collection ? [`   collection: ${compact.collection}`] : []),
    ...(compact?.manifestRevision ? [`   manifestRevision: ${compact.manifestRevision}`] : []),
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
    reconcile: Boolean(result.reconcile),
    error: result.error,
    collection: responseResult.collection,
    documentsIndexed: responseResult.documents_indexed,
    filesAdded: responseResult.files_added,
    filesUpdated: responseResult.files_updated,
    manifestRevision: responseStatus.manifest_revision,
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
    return `corpuswire rejected the ${operation}: ${error.errorMessage ?? message}`;
  }
  return `corpuswire ${operation} failed: ${message}`;
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
