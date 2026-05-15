const DEFAULT_BASE_URL = process.env.CORPUSWIRE_BASE_URL ?? "http://127.0.0.1:8000";
const DEFAULT_BASIC_AUTH = process.env.CORPUSWIRE_BASIC_AUTH ?? "";
const DEFAULT_REPO_PATH = process.env.CORPUSWIRE_REPO_PATH ?? "";
const DEFAULT_WORKSPACE_ID = process.env.CORPUSWIRE_WORKSPACE_ID ?? "";
const SUPPORTED_OUTPUT_MODES = new Set(["generic", "copilot", "claude-code", "sequential"]);

export function printHelp(write = console.log) {
  write(`corpuswire

Usage:
  corpuswire "<prompt>" [options]
  corpuswire enhance "<prompt>" [options]
  corpuswire search "<query>" [options]
  corpuswire health [options]
  corpuswire index-events [options]
  corpuswire index-activity [options]

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
  ) {
    command = args.shift();
  }

  const options = {
    help: false,
    command,
    apiBaseUrl: DEFAULT_BASE_URL,
    outputMode: "generic",
    repoPath: DEFAULT_REPO_PATH,
    workspaceId: DEFAULT_WORKSPACE_ID,
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
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--api-base-url":
        options.apiBaseUrl = requireValue(args, index, arg);
        index += 1;
        break;
      case "--repo-path":
        options.repoPath = requireValue(args, index, arg);
        index += 1;
        break;
      case "--workspace-id":
        options.workspaceId = requireValue(args, index, arg);
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
  const client =
    dependencies.client ??
    new sdk.CorpusWireClient({
      baseUrl: options.apiBaseUrl,
      basicAuth: options.basicAuth,
    });

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
  if (options.help) {
    printHelp(dependencies.write ?? console.log);
    return;
  }

  await runCliCommand(options, dependencies);
}
