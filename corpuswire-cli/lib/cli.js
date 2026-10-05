import { isRetrievalExcludedPath } from "@corpuswire/sdk";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, stat, lstat, mkdir, writeFile, open, realpath } from "node:fs/promises";
import { constants as fsConstants, watch as watchFiles } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

const DEFAULT_BASE_URL = "http://127.0.0.1:18080";
const execFileAsync = promisify(execFile);
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
const CLI_VERSION = "0.1.4-beta.4";

export function printHelp(write = console.log) {
  write(`cw

Usage:
  cw                         Index and watch this folder in an interactive terminal
  cw watch [options]         Index and keep reconciling local source changes
  cw --once                  Index once and exit
  cw init [--index] [--verify] Configure this workspace
  cw doctor [options]        Check service and verified inventory (read-only)
  cw reconcile [options]     Full workspace indexing with confirmation
  cw "<prompt>" [options]
  cw enhance "<prompt>" [options]
  cw search "<query>" [options]
  cw health [options]
  cw index-events [options]
  cw index-activity [options]
  cw index [options]
  cw version                 Show the installed CLI version (offline)

Options:
  --api-base-url <url>     Backend base URL. Default: ${DEFAULT_BASE_URL}
  --workspace-id <id>      Stable workspace identity to index/query/check
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
  --watch                  Stay open watching (also works without a TTY)
  --once                   Index once and exit
  --debounce-ms <number>   Quiet-edit delay. Default: 500
  --poll-ms <number>       Fallback scan interval. Default: 10000
  --yes                    Accept the indexing confirmation non-interactively
  --index                  Index after init (uses normal indexing confirmation)
  --verify                 Run doctor after init
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

export function parseCliArgs(argv, env = process.env, currentFolder = process.cwd()) {
  if (argv.length === 1 && ["version", "-V", "--version"].includes(argv[0])) {
    return { version: true };
  }
  if (argv.includes("-h") || argv.includes("--help")) {
    return { help: true };
  }

  const args = [...argv];
  let command = argv.length === 0 || argv[0]?.startsWith("-") ? "index" : "enhance";
  if (
    args[0] === "enhance" ||
    args[0] === "search" ||
    args[0] === "query" ||
    args[0] === "health" ||
    args[0] === "index-events" ||
    args[0] === "index-activity"
    || ["index", "init", "doctor", "reconcile", "watch"].includes(args[0])
  ) {
    command = args.shift();
  }

  const options = {
    help: false,
    command,
    apiBaseUrl: env.CORPUSWIRE_BASE_URL || DEFAULT_BASE_URL,
    apiBaseUrlExplicit: Boolean(env.CORPUSWIRE_BASE_URL),
    outputMode: "generic",
    repoPath: env.CORPUSWIRE_REPO_PATH || "",
    workspaceId: env.CORPUSWIRE_WORKSPACE_ID || "",
    workspaceIdExplicit: Boolean(env.CORPUSWIRE_WORKSPACE_ID),
    topK: undefined,
    minScore: undefined,
    collection: undefined,
    status: undefined,
    operation: undefined,
    limit: undefined,
    localOnly: false,
    json: false,
    basicAuth: env.CORPUSWIRE_BASIC_AUTH || "",
    promptParts: [],
    ndjson: false,
    sourceRoot: currentFolder,
    profile: env.CORPUSWIRE_PROFILE ?? "local",
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
    implicitIndex: argv.length === 0 || argv[0]?.startsWith("-"),
    watch: command === "watch",
    once: false,
    debounceMs: 500,
    pollMs: 10000,
    indexAfterInit: false,
    verifyAfterInit: false,
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
      case "--watch":
        options.watch = true;
        break;
      case "--once":
        options.once = true;
        break;
      case "--debounce-ms":
      case "--poll-ms": {
        const value = parseNumber(requireValue(args, index, arg), arg);
        const minimum = arg === "--poll-ms" ? 100 : 10;
        if (!Number.isInteger(value) || value < minimum || value > 60000) throw new Error(`${arg} must be an integer between ${minimum} and 60000.`);
        options[arg === "--poll-ms" ? "pollMs" : "debounceMs"] = value;
        index += 1;
        break;
      }
      case "--yes":
        options.yes = true;
        break;
      case "--index":
        options.indexAfterInit = true;
        break;
      case "--verify":
        options.verifyAfterInit = true;
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
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        options.promptParts.push(arg);
        break;
    }
  }

  if (command !== "init" && (options.indexAfterInit || options.verifyAfterInit)) {
    throw new Error("--index and --verify are only supported with init.");
  }
  if (!["enhance", "search", "query"].includes(command) && options.promptParts.length) {
    throw new Error(`Unexpected argument for ${command}: ${options.promptParts[0]}`);
  }
  if (command === "reconcile" && options.mode !== "full") {
    throw new Error("reconcile requires --mode full.");
  }
  if (options.watch && options.once) throw new Error("--watch and --once cannot be combined.");
  if (options.watch && !["watch", "index", "reconcile"].includes(command)) throw new Error("Watching requires an indexing command.");
  return options;
}

export async function runCliCommand(options, dependencies = {}) {
  const write = dependencies.write ?? console.log;
  const configurationInputs = { ...options };
  if (["index", "reconcile", "init", "doctor", "watch"].includes(options.command)) {
    const sourceRoot = path.resolve(options.sourceRoot || process.cwd());
    const sourceStats = await stat(sourceRoot);
    if (!sourceStats.isDirectory()) throw new Error(`Workspace root is not a directory: ${sourceRoot}`);
    const configuration = await resolveIndexConfiguration(options, sourceRoot, dependencies);
    validateIndexDestination(configuration);
    options = { ...options, ...configuration, apiBaseUrl: configuration.baseUrl, sourceRoot, configuration };
    if (options.command === "init") {
      const result = await initializeWorkspace(options, dependencies);
      if (!options.indexAfterInit && !options.verifyAfterInit) return result;
    }
  }
  const sdk = dependencies.client ? undefined : dependencies.sdk ?? await loadSdk();
  const authorization = dependencies.client ? {} : await resolveServiceAuthorization(options, dependencies);
  const traceCollector = createIndexTraceCollector();
  const serviceFetch = createServiceFetch(dependencies.fetchFn ?? globalThis.fetch, options.apiBaseUrl);
  const fetchFn = options.watch
    ? createWatchFetch(serviceFetch, {
      signal: dependencies.signal, detachSignal: dependencies.detachSignal,
      timeoutMs: dependencies.watchRequestTimeoutMs ?? 30000,
    }) : serviceFetch;
  const client =
    dependencies.client ??
    new sdk.CorpusWireClient({
      baseUrl: options.apiBaseUrl,
      basicAuth: options.basicAuth,
      ...authorization,
      defaultHeaders: options.trace
        ? { [INDEX_OBSERVABILITY_HEADER]: "1" }
        : undefined,
      fetchFn: options.trace
        ? traceCollector.wrapFetch(fetchFn ?? globalThis.fetch)
        : fetchFn,
    });

  if (options.watch) return runWatchCommand(options, { ...dependencies, client, sdk, write, traceCollector, configurationInputs });

  if (["index", "reconcile"].includes(options.command) || (options.command === "init" && options.indexAfterInit)) {
    const result = await runIndexCommand(options, {
      ...dependencies,
      client,
      sdk,
      write,
      traceCollector,
    });
    if (options.command !== "init" || !options.verifyAfterInit) return result;
  }

  if (options.command === "doctor" || (options.command === "init" && options.verifyAfterInit)) {
    return runDoctorCommand(options, { ...dependencies, client, write });
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

// Keep mutation calls alive long enough for the SDK to identify and cancel its own session.
// Read-only preflight calls may stop immediately; a second interrupt aborts any request.
export function createWatchFetch(fetchFn, { signal, detachSignal, timeoutMs = 30000 } = {}) {
  return async (input, init = {}) => {
    const controller = new AbortController();
    const pathname = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname;
    const signals = [init.signal, detachSignal];
    if (["/v1/index/capabilities", "/v1/index/preview"].includes(pathname)) signals.push(signal);
    const abort = () => controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    for (const linked of signals.filter(Boolean)) {
      linked.addEventListener("abort", abort, { once: true });
      if (linked.aborted) abort();
    }
    try {
      const response = await fetchFn(input, { ...init, signal: controller.signal });
      const body = await response.arrayBuffer();
      return new Response([101, 204, 205, 304].includes(response.status) ? null : body, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    } catch (error) {
      if (timedOut) throw Object.assign(new Error("Watch HTTP request timed out."), { name: "AbortError", code: "ETIMEDOUT" });
      throw error;
    } finally {
      clearTimeout(timer);
      for (const linked of signals.filter(Boolean)) linked.removeEventListener("abort", abort);
    }
  };
}

function createServiceFetch(fetchFn, baseUrl) {
  return async (input, init) => {
    try { return await fetchFn(input, init); }
    catch (error) {
      if (error?.name === "AbortError" || error?.status || error?.statusCode) throw error;
      const code = error?.code ?? error?.cause?.code;
      const networkCodes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"];
      if (!networkCodes.includes(code) && !/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|UND_ERR_SOCKET/i.test(error?.message ?? "")) throw error;
      const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(baseUrl).hostname);
      const guidance = local
        ? "Start Docker Desktop and your existing CorpusWire service, then run cw doctor."
        : "Check the service address and network access, then retry.";
      throw Object.assign(new Error(
        `CorpusWire API unavailable at ${displayServiceUrl(baseUrl)} (fetch failed).\n${guidance}\nIf this URL is unexpected, check CORPUSWIRE_BASE_URL, workspace .vscode/settings.json, .vscode/mcp.json or .mcp.json, and your CorpusWire user profile. Use --api-base-url <url> to explicitly select the intended service.`,
        { cause: error },
      ), { name: error.name, code });
    }
  };
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function watchConfigurationIdentity(configuration) {
  return JSON.stringify({
    profile: configuration.profile, baseUrl: configuration.baseUrl, workspaceId: configuration.workspaceId,
    includeGlobs: [...configuration.includeGlobs].sort(), excludeGlobs: [...configuration.excludeGlobs].sort(),
    maxFileSizeBytes: configuration.maxFileSizeBytes,
  });
}

function watchRetryable(error) {
  const status = error.status ?? error.statusCode;
  return error.code === "scan_incomplete" || error.code === "watch_unavailable" || status >= 500
    || error.name === "TypeError" || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOENT"].includes(error.code);
}

function watchFailure(message, code = "watch_fence") {
  return Object.assign(new Error(message), { code });
}

async function validateWatchFiles(root, scan) {
  for (const identity of scan.fileIdentities) {
    const filePath = path.join(root, identity.relativePath);
    const current = await lstat(filePath);
    if (!current.isFile() || current.isSymbolicLink() || !isWithinRoot(root, await realpath(filePath))
      || ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some((key) => current[key] !== identity[key])) {
      throw watchFailure("Source changed before publication; rescanning.", "scan_incomplete");
    }
  }
}

// The watcher is a wake-up hint; complete, content-hashed scans are the source of truth.
export async function runWatchCommand(options, dependencies) {
  if (options.configuration.profile !== "local" || options.mode !== "full" || options.rebuild || options.attachSessionId) {
    throw new Error("Watching supports local full reconciliation only, without --rebuild or --attach.");
  }
  const output = dependencies.write ?? console.log;
  const write = (message) => output(options.json || options.ndjson
    ? JSON.stringify({ schema_version: "watch-progress/v1", type: "watch_status", workspaceId: options.workspaceId, message })
    : message);
  const signal = dependencies.signal;
  const requestedRoot = options.sourceRoot;
  const root = await realpath(requestedRoot);
  const rootIdentity = await stat(root);
  const configurationInputs = dependencies.configurationInputs ?? options;
  const configurationIdentity = watchConfigurationIdentity(options.configuration);
  const readAuthorization = () => dependencies.client && !dependencies.sdk ? Promise.resolve({}) : resolveServiceAuthorization(options, dependencies);
  const authorizationIdentity = createHash("sha256").update(JSON.stringify(await readAuthorization())).digest("hex");
  let watcher;
  let generation = 0;
  let lastEventAt = 0;
  let wake;
  let publishedDigest = null;
  let failures = 0;
  let publications = 0;
  let stopped = false;
  let watcherErrorReported = false;

  const onChange = (_event, filename) => {
    if (stopped) return;
    const relative = filename?.toString().split(path.sep).join("/");
    const controlPath = [".vscode/settings.json", ".vscode/mcp.json", ".mcp.json"].includes(relative);
    if (relative && !controlPath && (relative.split("/").some((part) => part.startsWith(".") || DEFAULT_EXCLUDED_DIRECTORIES.has(part))
      || matchesAnyGlob(relative, options.excludeGlobs) || isRetrievalExcludedPath(relative))) return;
    generation += 1;
    lastEventAt = Date.now();
    wake?.();
  };
  const closeWatcher = () => {
    if (stopped) return;
    stopped = true;
    watcher?.close();
    wake?.();
  };
  signal?.addEventListener("abort", closeWatcher, { once: true });
  const wait = dependencies.waitForWatch ?? ((ms, waitSignal) => new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      waitSignal?.removeEventListener("abort", finish);
      if (wake === finish) wake = undefined;
      resolve();
    };
    wake = finish;
    timer = setTimeout(finish, ms);
    waitSignal?.addEventListener("abort", finish, { once: true });
    if (waitSignal?.aborted) finish();
  }));
  const assertFence = async () => {
    let currentRoot;
    let currentIdentity;
    try {
      currentRoot = await realpath(requestedRoot);
      currentIdentity = await stat(currentRoot);
    } catch { throw watchFailure("Workspace root disappeared. Watch stopped; no empty deletion inventory was published."); }
    if (currentRoot !== root || currentIdentity.dev !== rootIdentity.dev || currentIdentity.ino !== rootIdentity.ino) {
      throw watchFailure("Workspace root was replaced. Restart cw to select the new folder.");
    }
    const configuration = await resolveIndexConfiguration(configurationInputs, requestedRoot, dependencies);
    if (watchConfigurationIdentity(configuration) !== configurationIdentity) {
      throw watchFailure("Workspace, service, or indexing filters changed. Restart cw to apply the new configuration.");
    }
    const authorization = createHash("sha256").update(JSON.stringify(await readAuthorization())).digest("hex");
    if (authorization !== authorizationIdentity) throw watchFailure("Service credentials changed. Restart cw to use the new credentials.");
  };
  try {
    if (signal?.aborted) return { ok: true, stopped: true, publications, exitCode: 0 };
    try {
      watcher = (dependencies.watchFactory ?? watchFiles)(root, { recursive: true }, onChange);
      watcher.on?.("error", () => {
        watcher?.close();
        if (!watcherErrorReported) write("Filesystem notifications unavailable; periodic complete scans remain active.");
        watcherErrorReported = true;
        onChange("change", null);
      });
    } catch {
      write("Filesystem notifications unavailable; using periodic complete scans.");
    }
    let capabilities;
    for (let attempt = 0; ; attempt += 1) {
      try { capabilities = await dependencies.client.getIndexCapabilities(); break; }
      catch (error) {
        if (signal?.aborted || attempt >= 3 || !watchRetryable(error)) throw error;
        write(`Service temporarily unavailable; retry ${attempt + 1}/3.`);
        await wait(1000 * 2 ** attempt, signal);
        if (signal?.aborted) break;
      }
    }
    if (signal?.aborted) return { ok: true, stopped: true, publications, exitCode: 0 };
    write(`Watching ${sanitizeTerminalText(root)} → ${sanitizeTerminalText(options.workspaceId)} at ${displayServiceUrl(options.apiBaseUrl)}. Press Ctrl+C to stop.`);
    while (!signal?.aborted) {
      try {
        await assertFence();
        const quietDelay = lastEventAt + options.debounceMs - Date.now();
        if (quietDelay > 0) {
          await wait(quietDelay, signal);
          continue;
        }
        const scanGeneration = generation;
        const scan = await scanWorkspace(root, {
          capabilities, includeGlobs: options.includeGlobs, excludeGlobs: options.excludeGlobs,
          maxFileSizeBytes: Math.min(options.maxFileSizeBytes ?? capabilities.max_file_size_bytes, capabilities.max_file_size_bytes),
          onProgress: () => {}, signal, workspaceId: options.workspaceId, startedAt: Date.now(),
        });
        await assertFence();
        await validateWatchFiles(root, scan);
        if (generation !== scanGeneration) continue;
        const digest = createHash("sha256").update(JSON.stringify(scan.files.map((file) => [file.relativePath, file.sha256]).sort((a, b) => a[0].localeCompare(b[0])))).digest("hex");
        if (digest !== publishedDigest) {
          const result = await runIndexCommand({ ...options, sourceRoot: root, yes: true, nonInteractive: true }, {
            ...dependencies, capabilities, preparedScan: scan,
            write: (line) => {
              if (!options.json && !options.ndjson) return output(line);
              try { JSON.parse(line); } catch { return write(line); }
              output(line);
            },
            beforeIndex: async () => {
              await assertFence();
              await validateWatchFiles(root, scan);
              if (signal?.aborted || generation !== scanGeneration) throw watchFailure("Source changed before publication; rescanning.", "scan_incomplete");
            },
          });
          if (signal?.aborted) break;
          if (result.ok === false || result.cancelled || result.conflict || result.started === false || result.status?.phase !== "completed"
            || result.status?.coverage?.state !== "verified" || result.transfer?.complete !== true) {
            throw watchFailure("Reconciliation did not complete. Watch stopped; run cw doctor before restarting.");
          }
          let diagnosisEvidence;
          const doctor = await runDoctorCommand(options, { ...dependencies, write: () => {}, onDiagnosis: (evidence) => { diagnosisEvidence = evidence; } });
          const diagnosedIndex = diagnosisEvidence?.diagnosis?.index;
          if (diagnosedIndex?.coverage?.session_id && result.status.coverage.session_id
            && diagnosedIndex.coverage.session_id !== result.status.coverage.session_id) {
            throw watchFailure("The verified publication changed before the readiness check. Restart cw to reconcile again.");
          }
          const verifiedEmpty = scan.files.length === 0 && doctor.coverage.state === "verified"
            && diagnosedIndex?.coverage?.eligible_file_count === 0
            && (diagnosedIndex.health_warnings ?? []).every((warning) => warning === "No indexed Qdrant points were found for this context.")
            && doctor.reasons.every((reason) => ["retrieval_blocked", "index_health_degraded", "index_health_warnings"].includes(reason));
          if (!doctor.ok && !verifiedEmpty) {
            const authFailure = doctor.reasons.includes("authentication_rejected");
            const unavailable = doctor.checks.some((check) => check.code === "unavailable");
            throw watchFailure(`Reconciliation could not be verified (${doctor.reasons.join(", ")}).`, authFailure ? "authentication_rejected" : unavailable ? "watch_unavailable" : "watch_fence");
          }
          publishedDigest = digest;
          publications += 1;
          write(`Index verified (${scan.files.length} files). Watching for the next change.`);
        }
        failures = 0;
        if (generation !== scanGeneration) continue;
        await wait(options.pollMs, signal);
      } catch (error) {
        if (signal?.aborted) break;
        if (!watchRetryable(error) || ++failures > 3) throw error;
        write(`Reconciliation temporarily interrupted; retry ${failures}/3. The last verified inventory is unchanged.`);
        await wait(Math.min(30000, 1000 * 2 ** (failures - 1)), signal);
      }
    }
    write("Watch stopped.");
    return { ok: true, stopped: true, publications, exitCode: 0 };
  } catch (error) {
    if (signal?.aborted) {
      write("Watch stopped.");
      return { ok: true, stopped: true, publications, exitCode: 0 };
    }
    throw error;
  } finally {
    closeWatcher();
    signal?.removeEventListener("abort", closeWatcher);
  }
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

  const configuration = options.configuration ?? await resolveIndexConfiguration(options, sourceRoot, dependencies);
  options = { ...options, ...configuration };
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

  const capabilities = dependencies.capabilities ?? await dependencies.client.getIndexCapabilities();
  const scan = dependencies.preparedScan ?? await scanWorkspace(sourceRoot, {
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

  const approved = options.yes === true || (options.implicitIndex === true && configuration.profile === "local" && options.rebuild !== true)
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

  await dependencies.beforeIndex?.(scan);
  if (dependencies.signal?.aborted) return { ok: false, cancelled: true };
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
        + `Reattach with: cw index --attach ${sanitizeTerminalText(error.sessionId)}`,
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

async function resolveIndexConfiguration(options, sourceRoot, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const workspaceSettings = await readJsonIfPresent(path.join(sourceRoot, ".vscode", "settings.json"));
  const mcpConfigurations = await Promise.all([
    readJsonIfPresent(path.join(sourceRoot, ".vscode", "mcp.json")),
    readJsonIfPresent(path.join(sourceRoot, ".mcp.json")),
  ]);
  const mcpEnvironments = mcpConfigurations.map((config) =>
    (config.servers ?? config.mcpServers ?? {})["corpuswire-context-engine"]?.env
    ?? (config.servers ?? config.mcpServers ?? {}).corpuswire?.env ?? {});
  const mcpValue = (key) => mcpEnvironments.find((values) => values[key] !== undefined)?.[key];
  const userHome = dependencies.homeDirectory ?? homedir();
  const userSettings = await readFirstJson([
    path.join(userHome, ".config", "corpuswire", "vscode-extension.json"),
    path.join(userHome, ".corpuswire", "vscode-extension.json"),
  ]);
  const configuredWorkspaceId = nestedString(workspaceSettings, "corpuswire.remoteIndexing.workspaceId")
    || mcpValue("CORPUSWIRE_WORKSPACE_ID")
    || nestedString(userSettings, "remoteIndexing.workspaceId");
  const configuredBaseUrl = nestedString(workspaceSettings, "corpuswire.services.indexer.url")
    || nestedString(workspaceSettings, "corpuswire.serviceDefaults.url")
    || nestedString(workspaceSettings, "corpuswire.baseUrl")
    || mcpValue("CORPUSWIRE_BASE_URL")
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
    includeGlobs: options.includeGlobs?.length ? options.includeGlobs : globList(
      env.CORPUSWIRE_SYNC_INCLUDE_GLOBS
      ?? nestedValue(workspaceSettings, "corpuswire.remoteIndexing.includeGlobs")
      ?? mcpValue("CORPUSWIRE_SYNC_INCLUDE_GLOBS")
      ?? nestedValue(userSettings, "remoteIndexing.includeGlobs")),
    excludeGlobs: options.excludeGlobs?.length ? options.excludeGlobs : globList(
      env.CORPUSWIRE_SYNC_EXCLUDE_GLOBS
      ?? nestedValue(workspaceSettings, "corpuswire.remoteIndexing.excludeGlobs")
      ?? mcpValue("CORPUSWIRE_SYNC_EXCLUDE_GLOBS")
      ?? nestedValue(userSettings, "remoteIndexing.excludeGlobs")),
    maxFileSizeBytes: options.maxFileSizeBytes ?? configuredPositiveInteger(
      env.CORPUSWIRE_SYNC_MAX_FILE_SIZE_BYTES
      ?? nestedValue(workspaceSettings, "corpuswire.remoteIndexing.maxFileSizeBytes")
      ?? mcpValue("CORPUSWIRE_SYNC_MAX_FILE_SIZE_BYTES")
      ?? nestedValue(userSettings, "remoteIndexing.maxFileSizeBytes")),
  };
}

function nestedValue(record, dottedPath) {
  if (Object.hasOwn(record ?? {}, dottedPath)) return record[dottedPath];
  let value = record;
  for (const key of dottedPath.split(".")) value = value?.[key];
  return value;
}

function globList(value) {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    value = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split(/[,\n]+/);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("CorpusWire indexing filters must be arrays or comma-separated glob lists.");
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function configuredPositiveInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Maximum file size must be a positive integer.");
  return number;
}

async function resolveServiceAuthorization(options, dependencies) {
  const env = dependencies.env ?? process.env;
  const basicAuth = options.basicAuth || env.CORPUSWIRE_BASIC_AUTH || "";
  const bearerToken = env.CORPUSWIRE_BEARER_TOKEN?.trim() || "";
  if (basicAuth || bearerToken) return { basicAuth, bearerToken };
  const url = new URL(options.apiBaseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
    return { basicAuth: "", bearerToken: "" };
  }
  const account = `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  const credentialFile = dependencies.credentialFile ?? path.join(
    dependencies.homeDirectory ?? homedir(), ".local", "share", "corpuswire", "cli-credentials.json",
  );
  const fileToken = await readPrivateServiceToken(credentialFile, account, dependencies);
  if (fileToken) return { basicAuth: "", bearerToken: fileToken };
  if ((dependencies.platform ?? process.platform) !== "darwin") return { basicAuth: "", bearerToken: "" };
  try {
    const result = await (dependencies.execFile ?? execFileAsync)("/usr/bin/security", [
      "find-generic-password", "-s", "corpuswire-service-auth-v1", "-a", account, "-w",
    ], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
    return { basicAuth: "", bearerToken: result.stdout.trim() };
  } catch {
    // Missing credentials are resolved by the service's normal authorization response.
    return { basicAuth: "", bearerToken: "" };
  }
}

async function readPrivateServiceToken(filePath, account, dependencies) {
  const failure = () => new Error("CorpusWire CLI credential file is invalid or insecure. Require a regular owner-only file with schemaVersion 1 and service bearer tokens.");
  let fileStats;
  try { fileStats = await lstat(filePath); }
  catch (error) {
    if (error?.code === "ENOENT") return "";
    throw failure();
  }
  const uid = (dependencies.getuid ?? process.getuid)?.();
  const isPrivate = (value) => value.isFile() && !value.isSymbolicLink()
    && (value.mode & 0o7177) === 0 && (uid === undefined || value.uid === uid);
  if (!isPrivate(fileStats)) throw failure();
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const openedStats = await handle.stat();
    if (!isPrivate(openedStats) || openedStats.size > 64 * 1024) throw failure();
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > 64 * 1024) throw failure();
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (value?.schemaVersion !== 1 || !value.services || typeof value.services !== "object" || Array.isArray(value.services)) throw failure();
    for (const [service, credential] of Object.entries(value.services)) {
      const serviceUrl = new URL(service);
      const normalized = `${serviceUrl.protocol}//${serviceUrl.host.toLowerCase()}${serviceUrl.pathname.replace(/\/+$/, "")}`;
      if (!["http:", "https:"].includes(serviceUrl.protocol) || serviceUrl.username || serviceUrl.password
        || serviceUrl.search || serviceUrl.hash || service !== normalized
        || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(serviceUrl.hostname)) throw failure();
      if (!credential || typeof credential !== "object" || Array.isArray(credential)
        || typeof credential.bearerToken !== "string" || !credential.bearerToken.trim()
        || /[\r\n]/.test(credential.bearerToken)) throw failure();
    }
    return value.services[account]?.bearerToken.trim() || "";
  } catch {
    throw failure();
  } finally {
    await handle?.close();
  }
}

async function initializeWorkspace(options, dependencies) {
  const settingsPath = path.join(options.sourceRoot, ".vscode", "settings.json");
  const settings = await readJsonIfPresent(settingsPath);
  const url = new URL(options.apiBaseUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const additions = {
    "corpuswire.remoteIndexing.workspaceId": options.workspaceId,
    "corpuswire.serviceDefaults.url": url.toString().replace(/\/$/, ""),
    "corpuswire.remoteIndexing.includeGlobs": options.includeGlobs,
    "corpuswire.remoteIndexing.excludeGlobs": options.excludeGlobs,
  };
  if (options.maxFileSizeBytes !== undefined) additions["corpuswire.remoteIndexing.maxFileSizeBytes"] = options.maxFileSizeBytes;
  const changed = Object.entries(additions).some(([key, value]) => JSON.stringify(nestedValue(settings, key)) !== JSON.stringify(value));
  if (changed) {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify({ ...settings, ...additions }, null, 2)}\n`);
  }
  const result = {
    schema_version: "workspace-init/v1", ok: true, changed,
    workspaceId: options.workspaceId, serviceUrl: displayServiceUrl(options.apiBaseUrl),
    settingsPath,
  };
  const write = dependencies.write ?? console.log;
  write(options.json ? JSON.stringify(result, null, 2)
    : `${changed ? "Configured" : "Already configured"}: ${sanitizeTerminalText(options.workspaceId)}\nSettings: ${settingsPath}`);
  return result;
}

async function runDoctorCommand(options, dependencies) {
  const request = { workspaceId: options.workspaceId, repoPath: options.repoPath || undefined };
  const results = await Promise.allSettled([
    Promise.resolve().then(() => dependencies.client.health(request)),
    Promise.resolve().then(() => dependencies.client.diagnoseWorkspace(request)),
  ]);
  const health = results[0].status === "fulfilled" ? results[0].value : null;
  const diagnosis = results[1].status === "fulfilled" ? results[1].value : null;
  const checks = results.map((result, index) => {
    const name = index === 0 ? "health" : "diagnosis";
    if (result.status === "fulfilled") return { name, status: "available" };
    const httpStatus = Number.isInteger(result.reason?.status) ? result.reason.status : undefined;
    const code = httpStatus === 401 || httpStatus === 403 ? "authentication_rejected" : "unavailable";
    return { name, status: "error", code, ...(httpStatus === undefined ? {} : { httpStatus }) };
  });
  dependencies.onDiagnosis?.({ health, diagnosis });
  const coverage = diagnosis?.index?.coverage ?? health?.index?.coverage;
  const reasons = [];
  if (!health) reasons.push("health_unavailable");
  else if (health.ok !== true) reasons.push("service_unhealthy");
  if (!diagnosis) reasons.push("diagnosis_unavailable");
  else {
    if (diagnosis.can_retrieve !== true || diagnosis.status === "blocked") reasons.push("retrieval_blocked");
    else if (diagnosis.status !== "ready") reasons.push("workspace_degraded");
    if (diagnosis.resolved_workspace_id && diagnosis.resolved_workspace_id !== options.workspaceId) reasons.push("workspace_identity_mismatch");
    if (diagnosis.index?.read_needs_reconcile === true || diagnosis.index?.readNeedsReconcile === true) reasons.push("needs_reconcile");
    if (diagnosis.index?.health_status && !["ok", "ready", "healthy"].includes(diagnosis.index.health_status)) reasons.push("index_health_degraded");
    if (diagnosis.index?.health_warnings?.length) reasons.push("index_health_warnings");
  }
  if (coverage?.state !== "verified") reasons.push("inventory_not_verified");
  if (checks.some((check) => check.code === "authentication_rejected")) reasons.push("authentication_rejected");
  const blocked = reasons.some((reason) => ["health_unavailable", "service_unhealthy", "diagnosis_unavailable", "retrieval_blocked", "workspace_identity_mismatch"].includes(reason));
  const status = blocked ? "blocked" : reasons.length ? "attention" : "ready";
  const result = {
    schema_version: "workspace-doctor/v1", ok: status === "ready", status,
    exitCode: status === "ready" ? 0 : blocked ? 2 : 1,
    workspaceId: options.workspaceId, serviceUrl: displayServiceUrl(options.apiBaseUrl),
    coverage: { state: coverage?.state ?? "unavailable", reasonCodes: coverage?.reason_codes ?? [] },
    reasons, checks,
    recoveryActions: status === "ready" ? [] : ["Check service/authentication, then run cw reconcile --yes and cw doctor."],
  };
  dependencies.write(options.json ? JSON.stringify(result, null, 2)
    : `status: ${status}\nworkspace: ${sanitizeTerminalText(result.workspaceId)}\nservice: ${result.serviceUrl}\ninventory coverage: ${result.coverage.state}${reasons.length ? `\nchecks: ${reasons.join(", ")}` : ""}${checks.filter((check) => check.status === "error").map((check) => `\n${check.name}: ${check.code}${check.httpStatus === undefined ? "" : ` (HTTP ${check.httpStatus})`}`).join("")}`);
  return result;
}

function validateIndexDestination(configuration) {
  let url;
  try {
    url = new URL(configuration.baseUrl);
  } catch {
    throw new Error("Invalid CorpusWire base URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("CorpusWire base URL must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("CorpusWire base URLs must not contain credentials. Use environment authentication or the service credential store.");
  if (url.search || url.hash) throw new Error("CorpusWire base URLs must not contain a query string or fragment.");
  if (configuration.profile === "hosted" && url.protocol !== "https:") {
    throw new Error("Hosted indexing profiles require an https:// base URL.");
  }
  if (configuration.profile === "local" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
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
  const suffix = createHash("sha256").update(path.resolve(sourceRoot)).digest("hex").slice(0, 12);
  return `local-docker://${slug}-${suffix}#main`;
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
    const directoryStats = await lstat(directory);
    const resolvedDirectory = await realpath(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() || !isWithinRoot(sourceRoot, resolvedDirectory)) throw new Error("Workspace directory changed during scan");
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
    if (!isWithinRoot(sourceRoot, await realpath(candidate.absolutePath))) throw new Error("Workspace file escaped the source root");
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
    fileIdentities: selected.map(({ relativePath, fileStats }) => ({ relativePath, dev: fileStats.dev, ino: fileStats.ino, size: fileStats.size, mtimeMs: fileStats.mtimeMs, ctimeMs: fileStats.ctimeMs })),
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
  const phase = Number.isSafeInteger(event.phase_completed) && event.phase_completed >= 0
    && Number.isSafeInteger(event.phase_total) && event.phase_total > 0
    && event.phase_completed <= event.phase_total
    ? (event.phase_completed / event.phase_total) * 100
    : null;
  const progressLabel = phase === null
    ? "phase [indeterminate]"
    : `${progressBar(phase)} phase ${phase.toFixed(1)}%`;
  const overallLabel = overall === null ? "overall [indeterminate]" : `overall ${overall.toFixed(1)}%`;
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
    `${event.phase} ${progressLabel} ${overallLabel} elapsed ${formatDuration(event.elapsed_ms)} `
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
    const value = JSON.parse(stripJsonCommentsAndTrailingCommas(await readFile(filePath, "utf8")));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw new Error(`Cannot read CorpusWire configuration: ${filePath}`);
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
  const options = parseCliArgs(argv, dependencies.env ?? process.env, dependencies.cwd ?? process.cwd());
  if (options.version) {
    (dependencies.write ?? console.log)(CLI_VERSION);
    return;
  }
  if (options.help) {
    printHelp(dependencies.write ?? console.log);
    return;
  }

  const recordExitCode = (result) => {
    if (result?.exitCode !== undefined) {
      if (dependencies.process) dependencies.process.exitCode = result.exitCode;
      else if (Object.keys(dependencies).length === 0) process.exitCode = result.exitCode;
    }
    return result;
  };
  const interactive = dependencies.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (options.implicitIndex && interactive && !options.once && !options.nonInteractive && !options.json && !options.ndjson) options.watch = true;
  const indexingCommand = ["index", "reconcile", "watch"].includes(options.command)
    || (options.command === "init" && options.indexAfterInit);
  if (!indexingCommand || dependencies.signal) {
    return recordExitCode(await runCliCommand(options, dependencies));
  }

  const controller = new AbortController();
  const detachController = new AbortController();
  let interrupts = 0;
  const runtimeProcess = dependencies.process ?? process;
  const onInterrupt = () => {
    interrupts += 1;
    if (interrupts === 1) {
      (dependencies.writeError ?? console.error)(
        options.watch ? "Stopping watch; cancelling any indexing owned by this process…" : "Cancelling: requesting backend abort and waiting for acknowledgement…",
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
  runtimeProcess.on("SIGTERM", onInterrupt);
  try {
    return recordExitCode(await runCliCommand(options, {
      ...dependencies,
      signal: controller.signal,
      detachSignal: detachController.signal,
      output: options.ndjson || options.json ? runtimeProcess.stderr : dependencies.output,
    }));
  } finally {
    runtimeProcess.off("SIGINT", onInterrupt);
    runtimeProcess.off("SIGTERM", onInterrupt);
  }
}
