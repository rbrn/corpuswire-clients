import { isRetrievalExcludedPath } from "@corpuswire/sdk";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline/promises";

const DEFAULT_BASE_URL = process.env.CORPUSWIRE_BASE_URL ?? "http://127.0.0.1:8000";
const DEFAULT_BASIC_AUTH = process.env.CORPUSWIRE_BASIC_AUTH ?? "";
const DEFAULT_REPO_PATH = process.env.CORPUSWIRE_REPO_PATH ?? "";
const DEFAULT_WORKSPACE_ID = process.env.CORPUSWIRE_WORKSPACE_ID ?? "";
const SUPPORTED_OUTPUT_MODES = new Set(["generic", "copilot", "claude-code", "sequential"]);
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git", ".mypy_cache", ".pytest_cache", ".qdrant", ".ruff_cache", ".venv",
  "__pycache__", "build", "dist", "node_modules", "target", "venv",
]);
const INDEX_PROGRESS_SCHEMA_VERSION = "index-progress/v1";
const INDEX_OBSERVABILITY_SCHEMA_VERSION = "index-observability/v1";
const INDEX_OBSERVABILITY_HEADER = "X-CorpusWire-Index-Observability";
const INDEX_TRACE_STAGES = new Set([
  "mcp_receipt", "server_receipt", "queue_wait", "file_discovery", "file_read",
  "filtering_hashing", "parsing_chunking", "model_wait", "embedding_batch",
  "vector_writes", "cleanup", "total",
]);
const CLI_VERSION = "0.1.3";

export function printHelp(write = console.log) {
  write(`corpuswire

Usage:
  corpuswire "<prompt>" [options]
  corpuswire enhance "<prompt>" [options]
  corpuswire search "<query>" [options]
  corpuswire health [options]
  corpuswire index-events [options]
  corpuswire index-activity [options]
  corpuswire index [options]

Options:
  --api-base-url <url>     Backend base URL. Default: ${DEFAULT_BASE_URL}
  --workspace-id <id>      Remote workspace ID to query/enhance
  --repo-path <path>       Service-local repo path for compatibility
  --output-mode <mode>     generic | copilot | claude-code | sequential
  --top-k <number>         Override retrieval top-k
  --min-score <number>     Override retrieval score threshold
  --collection <name>      Filter index event/activity queries by collection
  --status <status>        Filter index events by status
  --operation <operation>  Filter index events by operation
  --limit <number>         Maximum index events to print
  --local-only             Use deterministic local rewrite on the backend
  --basic-auth <user:pass> Send HTTP Basic auth credentials
  --json                   Print the full JSON payload
  --ndjson                 Stream index-progress/v1 events as NDJSON
  --trace                  Add a content-free index-observability/v1 breakdown
  --source-root <path>     Workspace to index. Default: current folder
  --profile <name>         local | hosted. Default: local
  --mode <name>            full | incremental. Default: full
  --include <glob>         Include glob; repeatable
  --exclude <glob>         Exclude glob; repeatable
  --max-file-size <bytes>  Maximum file size to read
  --yes                    Accept the indexing confirmation non-interactively
  --non-interactive        Never prompt; requires --yes to mutate
  --timeout-ms <number>    Explicit caller wait budget; backend continues on expiry
  --rebuild                Allow destructive collection recreation (second confirmation)
  --confirm-rebuild <id>   Required in non-interactive mode; must equal workspace ID
  --attach <session-id>    Follow an existing index session
  -V, --version            Show the installed CLI version
  -h, --help               Show this help

Environment:
  CORPUSWIRE_BASE_URL
  CORPUSWIRE_BASIC_AUTH
  CORPUSWIRE_WORKSPACE_ID
  CORPUSWIRE_REPO_PATH
`);
}

function parseNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function parseCliArgs(argv) {
  if (argv.length === 1 && (argv[0] === "-V" || argv[0] === "--version")) {
    return { version: true };
  }
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    return { help: true };
  }

  const args = [...argv];
  let command = "enhance";
  if (
    args[0] === "enhance" ||
    args[0] === "search" ||
    args[0] === "query" ||
    args[0] === "health" ||
    args[0] === "index-events" ||
    args[0] === "index-activity"
    || args[0] === "index"
  ) {
    command = args.shift();
  }

  const options = {
    help: false,
    command,
    apiBaseUrl: DEFAULT_BASE_URL,
    apiBaseUrlExplicit: Boolean(process.env.CORPUSWIRE_BASE_URL),
    outputMode: "generic",
    repoPath: DEFAULT_REPO_PATH,
    workspaceId: DEFAULT_WORKSPACE_ID,
    workspaceIdExplicit: Boolean(process.env.CORPUSWIRE_WORKSPACE_ID),
    topK: undefined,
    minScore: undefined,
    collection: undefined,
    status: undefined,
    operation: undefined,
    limit: undefined,
    localOnly: false,
    json: false,
    basicAuth: DEFAULT_BASIC_AUTH,
    promptParts: [],
    ndjson: false,
    sourceRoot: process.cwd(),
    profile: process.env.CORPUSWIRE_PROFILE ?? "local",
    mode: "full",
    includeGlobs: [],
    excludeGlobs: [],
    maxFileSizeBytes: undefined,
    yes: false,
    nonInteractive: false,
    timeoutMs: undefined,
    rebuild: false,
    confirmRebuild: undefined,
    attachSessionId: undefined,
    trace: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--api-base-url":
        options.apiBaseUrl = requireValue(args, index, arg);
        options.apiBaseUrlExplicit = true;
        index += 1;
        break;
      case "--repo-path":
        options.repoPath = requireValue(args, index, arg);
        index += 1;
        break;
      case "--workspace-id":
        options.workspaceId = requireValue(args, index, arg);
        options.workspaceIdExplicit = true;
        index += 1;
        break;
      case "--output-mode":
        options.outputMode = requireValue(args, index, arg);
        if (!SUPPORTED_OUTPUT_MODES.has(options.outputMode)) {
          throw new Error(`Unsupported output mode: ${options.outputMode}`);
        }
        index += 1;
        break;
      case "--top-k":
        options.topK = parseNumber(requireValue(args, index, arg), "top-k");
        index += 1;
        break;
      case "--min-score":
        options.minScore = parseNumber(requireValue(args, index, arg), "min-score");
        index += 1;
        break;
      case "--collection":
        options.collection = requireValue(args, index, arg);
        index += 1;
        break;
      case "--status":
        options.status = requireValue(args, index, arg);
        index += 1;
        break;
      case "--operation":
        options.operation = requireValue(args, index, arg);
        index += 1;
        break;
      case "--limit":
        options.limit = parseNumber(requireValue(args, index, arg), "limit");
        index += 1;
        break;
      case "--local-only":
        options.localOnly = true;
        break;
      case "--basic-auth":
        options.basicAuth = requireValue(args, index, arg);
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--ndjson":
        options.ndjson = true;
        break;
      case "--trace":
        options.trace = true;
        break;
      case "--source-root":
        options.sourceRoot = requireValue(args, index, arg);
        index += 1;
        break;
      case "--profile":
        options.profile = requireValue(args, index, arg);
        if (!["local", "hosted"].includes(options.profile)) {
          throw new Error(`Unsupported profile: ${options.profile}`);
        }
        index += 1;
        break;
      case "--mode":
        options.mode = requireValue(args, index, arg);
        if (!["full", "incremental"].includes(options.mode)) {
          throw new Error(`Unsupported index mode: ${options.mode}`);
        }
        index += 1;
        break;
      case "--include":
        options.includeGlobs.push(requireValue(args, index, arg));
        index += 1;
        break;
      case "--exclude":
        options.excludeGlobs.push(requireValue(args, index, arg));
        index += 1;
        break;
      case "--max-file-size":
        options.maxFileSizeBytes = parseNumber(requireValue(args, index, arg), "max-file-size");
        index += 1;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--non-interactive":
        options.nonInteractive = true;
        break;
      case "--timeout-ms":
        options.timeoutMs = parseNumber(requireValue(args, index, arg), "timeout-ms");
        index += 1;
        break;
      case "--rebuild":
        options.rebuild = true;
        break;
      case "--confirm-rebuild":
        options.confirmRebuild = requireValue(args, index, arg);
        index += 1;
        break;
      case "--attach":
        options.attachSessionId = requireValue(args, index, arg);
        index += 1;
        break;
      default:
        options.promptParts.push(arg);
        break;
    }
  }

  return options;
}

export async function runCliCommand(options, dependencies = {}) {
  const write = dependencies.write ?? console.log;
  const sdk = dependencies.client ? undefined : await loadSdk();
  const traceCollector = createIndexTraceCollector();
  const client =
    dependencies.client ??
    new sdk.CorpusWireClient({
      baseUrl: options.apiBaseUrl,
      basicAuth: options.basicAuth,
      defaultHeaders: options.trace
        ? { [INDEX_OBSERVABILITY_HEADER]: "1" }
        : undefined,
      fetchFn: options.trace
        ? traceCollector.wrapFetch(dependencies.fetchFn ?? globalThis.fetch)
        : dependencies.fetchFn,
    });

  if (options.command === "index") {
    return runIndexCommand(options, {
      ...dependencies,
      client,
      sdk,
      write,
      traceCollector,
    });
  }

  if (options.command === "health") {
    const payload = await client.health({
      repoPath: options.repoPath || undefined,
      workspaceId: options.workspaceId || undefined,
    });

    if (options.json) {
      write(JSON.stringify(payload, null, 2));
      return;
    }

    const runtime = payload.runtime ?? {};
    const qdrant = payload.qdrant ?? {};
    write(`status: ${payload.ok ? "ok" : "unknown"}`);
    write(`corpuswire: ${runtime.corpuswire_enabled ? "enabled" : "disabled"}`);
    write(`qdrant collection: ${qdrant.collection ?? "unknown"}`);
    return;
  }

  if (options.command === "index-events") {
    const events = await client.getIndexEvents({
      workspaceId: options.workspaceId || undefined,
      collection: options.collection || undefined,
      status: options.status || undefined,
      operation: options.operation || undefined,
      limit: options.limit,
    });

    if (options.json) {
      write(JSON.stringify({ ok: true, events }, null, 2));
      return;
    }

    if (events.length === 0) {
      write("No index events found.");
      return;
    }

    for (const event of events) {
      write(formatIndexEvent(event));
    }
    return;
  }

  if (options.command === "index-activity") {
    const activity = await client.getIndexActivity({
      workspaceId: options.workspaceId || undefined,
      collection: options.collection || undefined,
    });

    if (options.json) {
      write(JSON.stringify({ ok: true, activity }, null, 2));
      return;
    }

    write(`available: ${activity.available}`);
    write(`events in window: ${activity.events_in_window ?? "unknown"}`);
    write(`last attempt: ${activity.last_attempt_at ?? "never"} (${activity.last_attempt_status ?? "unknown"})`);
    write(`last success: ${activity.last_success_at ?? "never"}`);
    write(`consecutive failures: ${activity.consecutive_failures ?? "unknown"}`);
    write(`gap detected: ${activity.gap_detected ?? "unknown"}`);
    return;
  }

  const prompt = options.promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error("Missing prompt. Pass a prompt directly or use the enhance/search command.");
  }

  if (options.command === "search" || options.command === "query") {
    const response = await client.queryRaw({
      query: prompt,
      repoPath: options.repoPath || undefined,
      workspaceId: options.workspaceId || undefined,
      topK: options.topK,
      minScore: options.minScore,
      includeAnswer: false,
    });

    if (options.json) {
      write(JSON.stringify(response, null, 2));
      return;
    }

    const chunks = response.result?.retrieved_chunks ?? [];
    if (chunks.length === 0) {
      write("No context found.");
      return;
    }

    for (const [index, chunk] of chunks.entries()) {
      const metadata = chunk.metadata ?? {};
      const sourcePath = metadata.source_path ?? "unknown source";
      const heading = metadata.section_heading ? ` > ${metadata.section_heading}` : "";
      const score = typeof chunk.score === "number" ? chunk.score.toFixed(3) : "n/a";
      write(`${index + 1}. ${sourcePath}${heading} [score ${score}]\n${String(chunk.text ?? "").trim()}`);
    }
    return;
  }

  const response = await client.enhanceRaw({
    prompt,
    repoPath: options.repoPath || undefined,
    workspaceId: options.workspaceId || undefined,
    outputMode: options.outputMode,
    topK: options.topK,
    minScore: options.minScore,
    localOnly: options.localOnly,
  });

  if (options.json) {
    write(JSON.stringify(response, null, 2));
    return;
  }

  write((sdk?.requireEnhancedPrompt ?? requireEnhancedPromptFallback)(response.result));
}

export async function runIndexCommand(options, dependencies) {
  const write = dependencies.write ?? console.log;
  const writeRaw = dependencies.writeRaw ?? ((value) => process.stdout.write(value));
  const isTTY = dependencies.isTTY ?? Boolean(process.stdout.isTTY);
  const sourceRoot = path.resolve(options.sourceRoot || process.cwd());
  const traceCollector = dependencies.traceCollector ?? createIndexTraceCollector();
  const sourceStats = await stat(sourceRoot);
  if (!sourceStats.isDirectory()) {
    throw new Error(`Index source root is not a directory: ${sourceRoot}`);
  }

  const configuration = await resolveIndexConfiguration(options, sourceRoot);
  validateIndexDestination(configuration);
  const renderer = createProgressRenderer({
    write,
    writeRaw,
    isTTY,
    ndjson: options.ndjson || options.json,
  });
  const startedAt = Date.now();
  const emitTrace = ({ scan = null, status = null, lastProgress = null, errorState = null } = {}) => {
    if (!options.trace) {
      return;
    }
    printIndexTrace(write, {
      scan,
      status,
      lastProgress,
      collector: traceCollector,
      totalDurationMs: Date.now() - startedAt,
      errorState,
      ndjson: options.ndjson || options.json,
    });
  };
  renderer.render(localProgressEvent({
    phase: "resolving_configuration",
    message: "Resolved workspace, profile, and service configuration",
    workspaceId: configuration.workspaceId,
    startedAt,
  }));

  if (options.attachSessionId) {
    const status = await followExistingSession(
      dependencies.client,
      options.attachSessionId,
      renderer,
      options,
      dependencies,
    );
    renderer.finish();
    printIndexTerminalSummary(write, {
      status,
      preview: null,
      scan: null,
      wallTimeMs: Date.now() - startedAt,
    });
    emitTrace({ status });
    return status;
  }

  const capabilities = await dependencies.client.getIndexCapabilities();
  const scan = await scanWorkspace(sourceRoot, {
    capabilities,
    includeGlobs: options.includeGlobs ?? [],
    excludeGlobs: options.excludeGlobs ?? [],
    maxFileSizeBytes: Math.min(options.maxFileSizeBytes ?? capabilities.max_file_size_bytes, capabilities.max_file_size_bytes),
    onProgress: renderer.render,
    signal: dependencies.signal,
    workspaceId: configuration.workspaceId,
    startedAt,
  });
  const request = {
    workspace: {
      workspaceId: configuration.workspaceId,
      displayRoot: sourceRoot,
      name: path.basename(sourceRoot),
    },
    mode: options.mode ?? "full",
    client: {
      name: "@corpuswire/cli",
      transport: options.ndjson || options.json ? "cli-ndjson" : "cli-terminal",
    },
    includeGlobs: options.includeGlobs ?? [],
    excludeGlobs: options.excludeGlobs ?? [],
    maxFileSizeBytes: Math.min(options.maxFileSizeBytes ?? capabilities.max_file_size_bytes, capabilities.max_file_size_bytes),
    recreateCollection: options.rebuild === true,
    files: scan.files,
    inventoryScan: (options.mode ?? "full") === "full" ? scan.inventoryScan : undefined,
    deletedPaths: [],
  };
  const preview = await dependencies.client.previewIndexWorkspace(request);
  renderer.finish();
  printIndexPreview(write, {
    configuration,
    sourceRoot,
    scan,
    preview,
    ndjson: options.ndjson || options.json,
  });

  const approved = options.yes === true
    ? true
    : options.nonInteractive === true
    ? false
    : await confirmIndexing(dependencies, "Start indexing this workspace? [y/N]");
  if (!approved) {
    write(options.ndjson || options.json
      ? JSON.stringify({ type: "cancelled_before_mutation", mutated: false })
      : "Indexing not started. No index mutation was made.");
    emitTrace({ scan });
    return { ok: true, started: false, mutated: false, preview };
  }
  if (options.rebuild === true) {
    const rebuildApproved = options.nonInteractive === true
      ? options.confirmRebuild === configuration.workspaceId
      : await confirmIndexing(
        dependencies,
        `Rebuild will recreate ${configuration.workspaceId}. Continue destructive rebuild? [y/N]`,
      );
    if (!rebuildApproved) {
      write(
        options.nonInteractive
          ? `Destructive rebuild not started. Pass --confirm-rebuild ${sanitizeTerminalText(configuration.workspaceId)} to acknowledge the exact workspace. No index mutation was made.`
          : "Destructive rebuild not started. No index mutation was made.",
      );
      emitTrace({ scan });
      return { ok: true, started: false, mutated: false, preview };
    }
  }

  const mutationStartedAt = Date.now();
  let lastProgress = null;
  request.processingTimeoutMs = options.timeoutMs;
  request.processingPollMs = options.processingPollMs ?? 250;
  request.signal = dependencies.signal;
  request.detachSignal = dependencies.detachSignal;
  request.onProgress = (event) => {
    lastProgress = event;
    renderer.render(event);
  };
  try {
    const result = await dependencies.client.indexWorkspace(request);
    renderer.finish();
    const status = result.status ?? {};
    printIndexTerminalSummary(write, {
      status,
      preview,
      scan,
      wallTimeMs: Date.now() - mutationStartedAt,
      lastProgress,
      result,
      ndjson: options.ndjson || options.json,
    });
    emitTrace({ scan, status, lastProgress });
    return result;
  } catch (error) {
    renderer.finish();
    if (error?.name === "RemoteIndexDetachedError") {
      write(
        `Detached from session ${sanitizeTerminalText(error.sessionId)}; backend work continues. `
        + `Reattach with: corpuswire index --attach ${sanitizeTerminalText(error.sessionId)}`,
      );
      emitTrace({ scan, status: error.status, lastProgress, errorState: "detached" });
      throw error;
    }
    if (error?.name === "RemoteIndexCancelledError") {
      printIndexTerminalSummary(write, {
        status: error.status,
        preview,
        scan,
        wallTimeMs: Date.now() - mutationStartedAt,
        lastProgress,
        ndjson: options.ndjson || options.json,
      });
      emitTrace({ scan, status: error.status, lastProgress, errorState: "cancelled" });
      return { ok: false, cancelled: true, status: error.status };
    }
    const conflict = activeSessionFromError(error);
    if (conflict) {
      const handled = await handleSessionConflict({
        error,
        conflict,
        client: dependencies.client,
        renderer,
        options,
        dependencies,
        write,
      });
      renderer.finish();
      if (handled?.phase) {
        printIndexTerminalSummary(write, {
          status: handled,
          preview,
          scan,
          wallTimeMs: Date.now() - mutationStartedAt,
          ndjson: options.ndjson || options.json,
        });
      }
      emitTrace({ scan, status: handled, lastProgress, errorState: "session_conflict" });
      return handled;
    }
    write(`Indexing failed. ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`);
    traceCollector.recordClientError();
    emitTrace({ scan, lastProgress, errorState: "client_error" });
    throw error;
  }
}

async function resolveIndexConfiguration(options, sourceRoot) {
  const workspaceSettings = await readJsonIfPresent(path.join(sourceRoot, ".vscode", "settings.json"));
  const userSettings = await readFirstJson([
    path.join(homedir(), ".config", "corpuswire", "vscode-extension.json"),
    path.join(homedir(), ".corpuswire", "vscode-extension.json"),
  ]);
  const configuredWorkspaceId = nestedString(workspaceSettings, "corpuswire.remoteIndexing.workspaceId")
    || nestedString(userSettings, "remoteIndexing.workspaceId");
  const configuredBaseUrl = nestedString(workspaceSettings, "corpuswire.services.indexer.url")
    || nestedString(workspaceSettings, "corpuswire.serviceDefaults.url")
    || nestedString(workspaceSettings, "corpuswire.baseUrl")
    || nestedString(userSettings, "services.indexer.url")
    || nestedString(userSettings, "serviceDefaults.url")
    || nestedString(userSettings, "baseUrl");
  return {
    profile: options.profile ?? "local",
    workspaceId: options.workspaceIdExplicit || options.workspaceId
      ? options.workspaceId || deriveWorkspaceId(sourceRoot)
      : configuredWorkspaceId || deriveWorkspaceId(sourceRoot),
    baseUrl: options.apiBaseUrlExplicit
      ? options.apiBaseUrl
      : configuredBaseUrl || options.apiBaseUrl || DEFAULT_BASE_URL,
    source: configuredWorkspaceId || configuredBaseUrl ? "workspace/profile configuration" : "folder defaults",
  };
}

function validateIndexDestination(configuration) {
  let url;
  try {
    url = new URL(configuration.baseUrl);
  } catch {
    throw new Error(`Invalid CorpusWire base URL: ${configuration.baseUrl}`);
  }
  if (configuration.profile === "hosted" && url.protocol !== "https:") {
    throw new Error("Hosted indexing profiles require an https:// base URL.");
  }
  if (configuration.profile === "local" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("Local indexing profiles require a loopback CorpusWire service. Use --profile hosted for HTTPS services.");
  }
}

function deriveWorkspaceId(sourceRoot) {
  const slug = path.basename(sourceRoot)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error("Could not derive a workspace identity; pass --workspace-id explicitly.");
  }
  return `local-docker://${slug}#main`;
}

async function scanWorkspace(sourceRoot, options) {
  try { return await scanWorkspaceComplete(sourceRoot, options); }
  catch (error) { throw Object.assign(error, { code: "scan_incomplete" }); }
}

async function scanWorkspaceComplete(sourceRoot, options) {
  const scanStartedAt = new Date().toISOString();
  const scannedPaths = [];
  let scanned = 0;
  const discoveryStartedAt = performance.now();
  async function walk(directory) {
    if (options.signal?.aborted) throw Object.assign(new Error("Workspace scan cancelled"), { code: "scan_incomplete" });
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(sourceRoot, absolutePath).split(path.sep).join("/");
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!DEFAULT_EXCLUDED_DIRECTORIES.has(entry.name) && !matchesAnyGlob(relativePath, options.excludeGlobs)) {
          await walk(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      scanned += 1;
      scannedPaths.push({ absolutePath, relativePath });
      options.onProgress(localProgressEvent({
        phase: "scanning",
        message: "Scanning workspace files",
        workspaceId: options.workspaceId,
        startedAt: options.startedAt,
        completed: scanned,
        total: null,
        unit: "files",
      }));
    }
  }
  await walk(sourceRoot);
  const fileDiscoveryMs = Math.max(0, Math.round(performance.now() - discoveryStartedAt));

  const filteringStartedAt = performance.now();
  const supportedExtensions = new Set(options.capabilities.supported_extensions ?? []);
  const supportedNames = new Set(options.capabilities.supported_filenames ?? []);
  const selected = [];
  let excluded = 0;
  let candidateBytes = 0;
  for (const [index, candidate] of scannedPaths.entries()) {
    const extension = path.posix.extname(candidate.relativePath).toLowerCase();
    const basename = path.posix.basename(candidate.relativePath).toLowerCase();
    const includedByType = supportedExtensions.has(extension) || supportedNames.has(basename);
    const includedByGlob = options.includeGlobs.length === 0 || matchesAnyGlob(candidate.relativePath, options.includeGlobs);
    const excludedByGlob = matchesAnyGlob(candidate.relativePath, options.excludeGlobs);
    const fileStats = await lstat(candidate.absolutePath);
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) throw Object.assign(new Error("Workspace changed during scan"), { code: "scan_incomplete" });
    if (isRetrievalExcludedPath(candidate.relativePath) || !includedByType || !includedByGlob || excludedByGlob || fileStats.size > options.maxFileSizeBytes) {
      excluded += 1;
      continue;
    }
    selected.push({ ...candidate, fileStats });
    candidateBytes += fileStats.size;
    options.onProgress(localProgressEvent({
      phase: "filtering_hashing",
      message: "Filtering candidate files",
      workspaceId: options.workspaceId,
      startedAt: options.startedAt,
      completed: index + 1,
      total: scannedPaths.length,
      unit: "files",
    }));
  }
  let filteringHashingMs = Math.max(0, performance.now() - filteringStartedAt);

  const files = [];
  let fileReadMs = 0;
  for (const [index, candidate] of selected.entries()) {
    const readStartedAt = performance.now();
    const content = await readFile(candidate.absolutePath);
    fileReadMs += performance.now() - readStartedAt;
    const after = await lstat(candidate.absolutePath);
    if (options.signal?.aborted || !after.isFile() || after.isSymbolicLink()
      || after.size !== candidate.fileStats.size || after.mtimeMs !== candidate.fileStats.mtimeMs
      || content.length !== candidate.fileStats.size) {
      throw Object.assign(new Error("Workspace changed during scan"), { code: "scan_incomplete" });
    }
    const hashingStartedAt = performance.now();
    const sha256 = createHash("sha256").update(content).digest("hex");
    filteringHashingMs += performance.now() - hashingStartedAt;
    files.push({
      relativePath: candidate.relativePath,
      content,
      sha256,
      mtimeNs: Math.trunc(candidate.fileStats.mtimeMs * 1_000_000),
    });
    options.onProgress(localProgressEvent({
      phase: "filtering_hashing",
      message: "Hashing candidate files",
      workspaceId: options.workspaceId,
      startedAt: options.startedAt,
      completed: index + 1,
      total: selected.length,
      unit: "files",
    }));
  }
  return {
    inventoryScan: {
      complete: true, startedAt: scanStartedAt, completedAt: new Date().toISOString(),
      excludedFileCount: excluded, producer: "corpuswire-cli-scan/v1",
      ignoreDigest: createHash("sha256").update(JSON.stringify({ directories: [...DEFAULT_EXCLUDED_DIRECTORIES].sort(), hiddenPaths: "exclude", retrievalExclusions: "discovery-and-terraform/v1" })).digest("hex"),
    },
    files,
    scanned,
    included: selected.length,
    excluded,
    candidateBytes,
    stageTimingsMs: {
      file_discovery: fileDiscoveryMs,
      filtering_hashing: Math.max(0, Math.round(filteringHashingMs)),
      file_read: Math.max(0, Math.round(fileReadMs)),
    },
  };
}

export function createIndexTraceCollector() {
  const stageTimingsMs = {};
  let modelState = "unknown";
  let errorState = "none";

  const observe = (response) => {
    if (response?.headers?.get?.("x-corpuswire-index-trace") !== INDEX_OBSERVABILITY_SCHEMA_VERSION) {
      return;
    }
    const serverTiming = response.headers.get("server-timing") ?? "";
    for (const item of serverTiming.split(",")) {
      const match = item.match(/^\s*cw_([a-z_]+)\s*;\s*dur=([0-9]+(?:\.[0-9]+)?)/i);
      if (!match || !INDEX_TRACE_STAGES.has(match[1]) || match[1] === "total") {
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
  };

  return {
    wrapFetch(fetchFn) {
      if (typeof fetchFn !== "function") {
        throw new Error("A fetch implementation is required for --trace.");
      }
      return async (input, init) => {
        try {
          const response = await fetchFn(input, init);
          observe(response);
          return response;
        } catch (error) {
          errorState = "client_transport_error";
          throw error;
        }
      };
    },
    recordClientError() {
      if (errorState === "none") {
        errorState = "client_error";
      }
    },
    snapshot() {
      return {
        stageTimingsMs: { ...stageTimingsMs },
        modelState,
        errorState,
      };
    },
  };
}

function buildIndexTrace({
  scan,
  status,
  lastProgress,
  collector,
  totalDurationMs,
  errorState,
}) {
  const stagesMs = Object.fromEntries(
    [...INDEX_TRACE_STAGES]
      .filter((stage) => stage !== "total")
      .map((stage) => [stage, null]),
  );
  const addTimings = (timings) => {
    if (!timings || typeof timings !== "object") {
      return;
    }
    for (const [stage, rawDuration] of Object.entries(timings)) {
      if (!(stage in stagesMs) || typeof rawDuration !== "number" || !Number.isFinite(rawDuration)) {
        continue;
      }
      stagesMs[stage] = (stagesMs[stage] ?? 0) + Math.max(0, Math.round(rawDuration));
    }
  };
  const collected = collector.snapshot();
  addTimings(scan?.stageTimingsMs);
  addTimings(collected.stageTimingsMs);
  addTimings((status?.progress ?? lastProgress)?.phase_timings_ms);
  return {
    schema_version: INDEX_OBSERVABILITY_SCHEMA_VERSION,
    stages_ms: stagesMs,
    total_duration_ms: Math.max(0, Math.round(totalDurationMs)),
    error_state: errorState ?? collected.errorState,
    model_state: collected.modelState,
    sensitive_payloads_captured: false,
  };
}

function printIndexTrace(write, options) {
  const trace = buildIndexTrace(options);
  if (options.ndjson) {
    write(JSON.stringify({ type: "index_trace", trace }));
    return;
  }
  const measuredStages = Object.entries(trace.stages_ms)
    .filter(([, duration]) => typeof duration === "number")
    .map(([stage, duration]) => `${stage}=${formatDuration(duration)}`);
  write([
    `Index observability (${trace.schema_version})`,
    `  Model/error: ${trace.model_state}/${trace.error_state}`,
    `  Stages: ${measuredStages.length > 0 ? measuredStages.join(", ") : "no server stages reported"}`,
    `  Total: ${formatDuration(trace.total_duration_ms)}`,
    "  Sensitive payloads captured: no",
  ].join("\n"));
}

function localProgressEvent({
  phase,
  message,
  workspaceId,
  startedAt,
  completed = 0,
  total = null,
  unit = "items",
}) {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const phasePercent = total && total > 0 ? (completed / total) * 100 : null;
  return {
    schema_version: INDEX_PROGRESS_SCHEMA_VERSION,
    sequence: elapsedMs,
    session_id: "pending",
    workspace_id: workspaceId,
    occurred_at: new Date().toISOString(),
    phase,
    state: "running",
    message,
    overall_completed: 0,
    overall_total: null,
    overall_percent: null,
    overall_indeterminate: true,
    phase_completed: completed,
    phase_total: total,
    phase_percent: phasePercent,
    unit,
    elapsed_ms: elapsedMs,
    phase_elapsed_ms: elapsedMs,
    throughput_per_second: elapsedMs > 0 && completed > 0 ? completed / (elapsedMs / 1_000) : null,
    queue_depth: 0,
    retries: 0,
    warnings: [],
    eta_seconds: null,
    eta_confidence: "unknown",
    heartbeat: false,
    last_progress_at: new Date().toISOString(),
    last_heartbeat_at: null,
    active_heartbeat: false,
    counts: {},
    phase_timings_ms: {},
    verification_status: "pending",
  };
}

export function createProgressRenderer({ write, writeRaw, isTTY, ndjson }) {
  let lastKey = "";
  let ttyActive = false;
  let completedEmitted = false;
  const render = (rawEvent) => {
    const event = redactProgressEvent(rawEvent);
    if (event.state === "completed") {
      if (completedEmitted) {
        return;
      }
      completedEmitted = true;
    }
    const key = `${event.session_id}:${event.sequence}:${event.phase}:${event.phase_completed}:${event.heartbeat}`;
    if (key === lastKey) {
      return;
    }
    lastKey = key;
    if (ndjson) {
      write(JSON.stringify({ type: "index_progress", event }));
      return;
    }
    const line = formatProgressLine(event);
    if (isTTY) {
      writeRaw(`\r\u001b[2K${line}`);
      ttyActive = true;
    } else {
      write(line);
    }
  };
  const finish = () => {
    if (ttyActive) {
      writeRaw("\n");
      ttyActive = false;
    }
  };
  return { render, finish };
}

export function formatProgressLine(event) {
  const overall = numericPercent(event.overall_percent);
  const progressLabel = overall === null
    ? "[indeterminate]"
    : `${progressBar(overall)} ${overall.toFixed(1)}%`;
  const work = event.phase_total === null || event.phase_total === undefined
    ? `${event.phase_completed ?? 0} ${event.unit ?? "items"}`
    : `${event.phase_completed ?? 0}/${event.phase_total} ${event.unit ?? "items"}`;
  const throughput = typeof event.throughput_per_second === "number"
    ? ` ${event.throughput_per_second.toFixed(1)}/${event.unit ?? "items"}/s`
    : "";
  const eta = typeof event.eta_seconds === "number"
    ? ` eta ${formatDuration(event.eta_seconds * 1_000)} (${event.eta_confidence})`
    : " eta -- (unknown)";
  const heartbeat = event.active_heartbeat || event.heartbeat ? " heartbeat active" : "";
  return sanitizeTerminalText(
    `${event.phase} ${progressLabel} elapsed ${formatDuration(event.elapsed_ms)} `
    + `phase ${formatDuration(event.phase_elapsed_ms)} ${work}${throughput} `
    + `queue ${event.queue_depth ?? 0} retries ${event.retries ?? 0}${eta}${heartbeat}`,
  );
}

function progressBar(percent) {
  const width = 24;
  const filled = Math.min(width, Math.max(0, Math.floor((percent / 100) * width)));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function numericPercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Number(milliseconds ?? 0)) / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds % 60).toFixed(0)}s`;
}

function printIndexPreview(write, { configuration, sourceRoot, scan, preview, ndjson }) {
  const payload = {
    workspace: configuration.workspaceId,
    source_root: sourceRoot,
    service: displayServiceUrl(configuration.baseUrl),
    profile: configuration.profile,
    configuration_source: configuration.source,
    files_scanned: scan.scanned,
    candidate_files: preview.included,
    excluded_files: scan.excluded + preview.excluded,
    candidate_bytes: preview.candidate_bytes,
    expected_mode: preview.expected_mode,
    changed_files: preview.changed,
    unchanged_files: preview.unchanged,
    deleted_files: preview.deleted,
    destructive_risk: preview.destructive_risk,
  };
  if (ndjson) {
    write(JSON.stringify({ type: "index_preview", preview: payload }));
    return;
  }
  write([
    "CorpusWire indexing preview",
    `  Workspace: ${sanitizeTerminalText(payload.workspace)}`,
    `  Source root: ${sanitizeTerminalText(payload.source_root)}`,
    `  Service/profile: ${sanitizeTerminalText(payload.service)} (${payload.profile})`,
    `  Configuration: ${payload.configuration_source}`,
    `  Files: ${payload.candidate_files} candidate, ${payload.excluded_files} excluded, ${payload.files_scanned} scanned`,
    `  Candidate bytes: ${formatBytes(payload.candidate_bytes)}`,
    `  Expected mode: ${payload.expected_mode} (${payload.changed_files} changed, ${payload.unchanged_files} unchanged, ${payload.deleted_files} deleted)`,
    `  Destructive risk: ${payload.destructive_risk ? "YES — collection recreation requested" : "none"}`,
  ].join("\n"));
}

function printIndexTerminalSummary(write, {
  status,
  preview,
  scan,
  wallTimeMs,
  lastProgress,
  result,
  ndjson = false,
}) {
  const progress = status?.progress ?? lastProgress ?? {};
  const counts = progress.counts ?? {};
  const resultCounts = result?.result ?? {};
  const summary = {
    coverage_state: status?.coverage?.state ?? "unknown",
    files_submitted: result?.transfer?.files_submitted ?? null,
    files_transferred: result?.transfer?.files_transferred ?? null,
    source_bytes_transferred: result?.transfer?.source_bytes_transferred ?? null,
    upload_attempts: result?.transfer?.upload_attempts ?? null,
    session_id: status?.session_id ?? progress.session_id ?? null,
    state: progress.state ?? status?.phase ?? "unknown",
    wall_time_ms: wallTimeMs,
    phase_timings_ms: progress.phase_timings_ms ?? {},
    files_scanned: scan?.scanned ?? null,
    files_included: preview?.included ?? scan?.included ?? null,
    files_excluded: scan
      ? scan.excluded + (preview?.excluded ?? 0)
      : preview?.excluded ?? null,
    files_changed: preview?.changed ?? null,
    files_indexed: counts.files_indexed ?? resultCounts.documents_indexed ?? status?.files_indexed ?? 0,
    files_skipped: counts.files_skipped ?? status?.files_skipped ?? 0,
    files_unchanged: counts.files_unchanged ?? resultCounts.files_unchanged ?? status?.files_unchanged ?? 0,
    files_deleted: counts.files_deleted ?? resultCounts.files_deleted ?? status?.files_deleted ?? 0,
    bytes: counts.bytes_uploaded ?? resultCounts.bytes_uploaded ?? status?.bytes_uploaded ?? 0,
    chunks: counts.chunks_indexed ?? 0,
    embedding_batches: counts.embedding_batches ?? 0,
    vector_writes: counts.vector_writes ?? 0,
    retries: progress.retries ?? 0,
    warnings: progress.warnings ?? [],
    verification: progress.verification_status ?? "unknown",
  };
  if (ndjson) {
    write(JSON.stringify({ type: "index_result", result: summary }));
    return;
  }
  write([
    `Index ${summary.state}: session ${sanitizeTerminalText(summary.session_id ?? "unknown")}`,
    `  Wall time: ${formatDuration(summary.wall_time_ms)}`,
    `  Files: scanned=${summary.files_scanned ?? "unknown"} included=${summary.files_included ?? "unknown"} excluded=${summary.files_excluded ?? "unknown"} changed=${summary.files_changed ?? "unknown"} indexed=${summary.files_indexed} unchanged=${summary.files_unchanged} skipped=${summary.files_skipped} deleted=${summary.files_deleted}`,
    `  Data: ${formatBytes(summary.bytes)}; chunks=${summary.chunks}; embedding batches=${summary.embedding_batches}; vector writes=${summary.vector_writes}`,
    `  Retries/warnings: ${summary.retries}/${summary.warnings.length}`,
    `  Verification: ${summary.verification}; inventory coverage: ${summary.coverage_state}`,
    `  Transfer: ${summary.files_transferred ?? "unknown"} acknowledged files; ${summary.source_bytes_transferred ?? "unknown"} source bytes; ${summary.upload_attempts ?? "unknown"} attempts`,
    `  Phase timings: ${formatPhaseTimings(summary.phase_timings_ms)}`,
  ].join("\n"));
}

async function confirmIndexing(dependencies, prompt) {
  if (typeof dependencies.confirm === "function") {
    const answer = await dependencies.confirm(prompt);
    return /^y(es)?$/i.test(String(answer ?? "").trim());
  }
  const input = dependencies.input ?? process.stdin;
  const output = dependencies.output ?? process.stdout;
  const readline = createInterface({ input, output });
  try {
    const answer = await Promise.race([
      readline.question(`${prompt} `),
      new Promise((resolve) => readline.once("close", () => resolve(""))),
    ]);
    return /^y(es)?$/i.test(answer.trim());
  } catch (error) {
    if (error?.code === "ERR_USE_AFTER_CLOSE" || error?.name === "AbortError") {
      return false;
    }
    throw error;
  } finally {
    readline.close();
  }
}

function activeSessionFromError(error) {
  if (error?.status !== 409) {
    return null;
  }
  const detail = error.errorDetail;
  return detail && typeof detail === "object" ? detail.active_session ?? null : null;
}

async function handleSessionConflict({ conflict, client, renderer, options, dependencies, write }) {
  write([
    `Workspace lock is owned by session ${sanitizeTerminalText(conflict.session_id ?? "unknown")}.`,
    `Age: ${conflict.age_seconds ?? "unknown"}s; phase: ${conflict.progress?.phase ?? conflict.phase ?? "unknown"}; last progress: ${conflict.last_progress_seconds ?? "unknown"}s ago.`,
    "Safe choices: attach/follow, cancel with confirmation, or exit.",
  ].join("\n"));
  if (options.nonInteractive) {
    return { ok: false, conflict, attached: false };
  }
  const choice = await readChoice(dependencies, "Choose [a]ttach, [c]ancel, or [e]xit:");
  if (choice === "a") {
    return followExistingSession(client, conflict.session_id, renderer, options, dependencies);
  }
  if (choice === "c") {
    const approved = await confirmIndexing(
      dependencies,
      `Cancel active session ${conflict.session_id}? [y/N]`,
    );
    if (approved) {
      await client.abortIndexSession(conflict.session_id);
      return followExistingSession(client, conflict.session_id, renderer, options, dependencies);
    }
  }
  return { ok: false, conflict, attached: false };
}

async function readChoice(dependencies, prompt) {
  if (typeof dependencies.confirm === "function") {
    return String(await dependencies.confirm(prompt)).trim().toLowerCase().slice(0, 1);
  }
  const readline = createInterface({
    input: dependencies.input ?? process.stdin,
    output: dependencies.output ?? process.stdout,
  });
  try {
    const answer = await Promise.race([
      readline.question(`${prompt} `),
      new Promise((resolve) => readline.once("close", () => resolve(""))),
    ]);
    return answer.trim().toLowerCase().slice(0, 1);
  } finally {
    readline.close();
  }
}

async function followExistingSession(client, sessionId, renderer, options, dependencies) {
  if (typeof client.followIndexSession === "function") {
    return client.followIndexSession(sessionId, {
      timeoutMs: options.timeoutMs,
      pollMs: options.processingPollMs ?? 250,
      signal: dependencies.signal,
      detachSignal: dependencies.detachSignal,
      onProgress: renderer.render,
    });
  }
  for (;;) {
    const status = await client.getIndexSessionStatus(sessionId);
    if (status.progress) {
      renderer.render(status.progress);
    }
    if (["completed", "aborted", "failed", "expired"].includes(status.phase)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, options.processingPollMs ?? 250));
  }
}

function matchesAnyGlob(relativePath, globs) {
  return globs.some((glob) => globToRegExp(glob).test(relativePath));
}

function globToRegExp(glob) {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`);
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(stripJsonCommentsAndTrailingCommas(await readFile(filePath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    return {};
  }
}

function stripJsonCommentsAndTrailingCommas(source) {
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      withoutComments += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutComments += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      withoutComments += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") {
          withoutComments += "\n";
        }
        index += 1;
      }
      index += 1;
      continue;
    }
    withoutComments += char;
  }

  let result = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const char = withoutComments[index];
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(withoutComments[lookahead] ?? "")) {
        lookahead += 1;
      }
      if (withoutComments[lookahead] === "}" || withoutComments[lookahead] === "]") {
        continue;
      }
    }
    result += char;
  }
  return result;
}

async function readFirstJson(paths) {
  for (const filePath of paths) {
    const value = await readJsonIfPresent(filePath);
    if (Object.keys(value).length > 0) {
      return value;
    }
  }
  return {};
}

function nestedString(record, dottedPath) {
  if (record && typeof record[dottedPath] === "string") {
    return record[dottedPath].trim();
  }
  let value = record;
  for (const key of dottedPath.split(".")) {
    value = value && typeof value === "object" ? value[key] : undefined;
  }
  return typeof value === "string" ? value.trim() : "";
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes ?? 0));
  if (value < 1_024) {
    return `${value} B`;
  }
  if (value < 1_048_576) {
    return `${(value / 1_024).toFixed(1)} KiB`;
  }
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function displayServiceUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/(authorization|token|api[_-]?key|password|secret|signature)/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return sanitizeTerminalText(value);
  }
}

function formatPhaseTimings(value) {
  const entries = Object.entries(value ?? {});
  return entries.length === 0
    ? "unavailable"
    : entries.map(([phase, duration]) => `${phase}=${formatDuration(duration)}`).join(", ");
}

function redactProgressEvent(event) {
  const copy = JSON.parse(JSON.stringify(event));
  copy.message = sanitizeTerminalText(copy.message ?? "");
  copy.warnings = Array.isArray(copy.warnings)
    ? copy.warnings.map((warning) => sanitizeTerminalText(warning))
    : [];
  return copy;
}

export function sanitizeTerminalText(value) {
  return String(value ?? "")
    .replace(/\b(authorization|token|api[_-]?key|password)\s*[:=]\s*[^\r\n]+/gi, "$1=[redacted]")
    .replace(/\b(bearer|basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/[\r\n\u001b]/g, " ")
    .slice(0, 2_000);
}

async function loadSdk() {
  try {
    return await import("@corpuswire/sdk");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") {
      throw error;
    }
    return import("../../corpuswire-sdk/dist/index.js");
  }
}

function requireEnhancedPromptFallback(result) {
  const prompt =
    result?.enhanced_prompt ??
    result?.rewritten_prompt ??
    result?.augmented_prompt ??
    result?.enhancement_prompt;
  if (typeof prompt === "string" && prompt.trim()) {
    return prompt;
  }
  throw new Error(result?.generation_error ?? "The service returned no enhanced prompt.");
}

function formatIndexEvent(event) {
  const source = event.workspace_id ?? event.source_root ?? event.collection ?? "unknown";
  const counts = [
    `files=${event.files_indexed ?? 0}`,
    `deleted=${event.files_deleted ?? 0}`,
    `skipped=${event.files_skipped ?? 0}`,
    `chunks=${event.chunks_indexed ?? 0}`,
  ].join(" ");
  return `${event.occurred_at} ${event.status} ${event.operation} ${source} ${counts}`;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseCliArgs(argv);
  if (options.version) {
    (dependencies.write ?? console.log)(CLI_VERSION);
    return;
  }
  if (options.help) {
    printHelp(dependencies.write ?? console.log);
    return;
  }

  if (options.command !== "index" || dependencies.signal) {
    await runCliCommand(options, dependencies);
    return;
  }

  const controller = new AbortController();
  const detachController = new AbortController();
  let interrupts = 0;
  const runtimeProcess = dependencies.process ?? process;
  const onInterrupt = () => {
    interrupts += 1;
    if (interrupts === 1) {
      (dependencies.writeError ?? console.error)(
        "Cancelling: requesting backend abort and waiting for acknowledgement…",
      );
      controller.abort();
      return;
    }
    (dependencies.writeError ?? console.error)(
      "Detaching after second interrupt. Output will state whether backend work continues and how to reattach.",
    );
    detachController.abort();
  };
  runtimeProcess.on("SIGINT", onInterrupt);
  try {
    await runCliCommand(options, {
      ...dependencies,
      signal: controller.signal,
      detachSignal: detachController.signal,
      output: options.ndjson || options.json ? runtimeProcess.stderr : dependencies.output,
    });
  } finally {
    runtimeProcess.off("SIGINT", onInterrupt);
  }
}
