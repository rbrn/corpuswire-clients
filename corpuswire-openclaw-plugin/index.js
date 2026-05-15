import { buildCorpusWireClient, normalizePluginConfig } from "./lib/client.js";
import {
  formatEnhanceToolResult,
  formatIngestToolResult,
  formatPromptContext,
  formatSearchToolResult,
  extractPromptText,
} from "./lib/format.js";
import { createOpenClawContextEngine } from "./lib/openclaw-context-engine.js";

const PLUGIN_ID = "corpuswire";

const SEARCH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Search query to run against the configured CorpusWire index." },
    repoPath: { type: "string", description: "Optional service-local repository path to scope retrieval." },
    workspaceId: { type: "string", description: "Optional remote workspace id to scope retrieval." },
    topK: { type: "number", description: "Maximum context chunks to return." },
    minScore: { type: "number", description: "Minimum retrieval score from 0 to 1." },
  },
  required: ["query"],
};

const ENHANCE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: { type: "string", description: "Prompt to rewrite with workspace context." },
    repoPath: { type: "string", description: "Optional service-local repository path to scope retrieval." },
    workspaceId: { type: "string", description: "Optional remote workspace id to scope retrieval." },
    topK: { type: "number", description: "Maximum context chunks to use." },
    minScore: { type: "number", description: "Minimum retrieval score from 0 to 1." },
    outputMode: {
      type: "string",
      enum: ["generic", "copilot", "claude-code", "sequential"],
      description: "Target prompt style.",
    },
    localOnly: { type: "boolean", description: "Disable LLM generation and return deterministic local rewrite output." },
  },
  required: ["prompt"],
};

const INGEST_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    repoPath: { type: "string", description: "Optional service-local repository path to incrementally index." },
    sourceDir: { type: "string", description: "Optional service-local source directory override." },
    workspaceId: {
      type: "string",
      description: "Rejected for local /ingest; remote workspaces must be uploaded through /v1/index.",
    },
    recreateCollection: { type: "boolean", description: "Recreate the target collection instead of incremental update." },
    includeGlobs: {
      type: "array",
      items: { type: "string" },
      description: "Optional glob filters for files to include.",
    },
    excludeGlobs: {
      type: "array",
      items: { type: "string" },
      description: "Optional glob filters for files to exclude.",
    },
    maxFileSizeBytes: { type: "number", description: "Optional maximum file size to index." },
  },
};

const configSchema = {
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      baseUrl: { type: "string", default: "http://127.0.0.1:8000" },
      basicAuth: { type: "string", description: "Optional username:password for CorpusWire Basic Auth." },
      repoPath: { type: "string", description: "Optional repository root used for repo-scoped retrieval." },
      workspaceId: { type: "string", description: "Optional remote workspace id used for remote-indexed retrieval." },
      topK: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      minScore: { type: "number", minimum: 0, maximum: 1, default: 0.15 },
      maxContextChars: { type: "integer", minimum: 500, maximum: 50000, default: 6000 },
      requestTimeoutMs: { type: "integer", minimum: 1000, maximum: 120000, default: 30000 },
      requestRetryAttempts: { type: "integer", minimum: 0, maximum: 5, default: 2 },
      requestRetryDelayMs: { type: "integer", minimum: 0, maximum: 5000, default: 250 },
      autoContext: { type: "boolean", default: false },
      contextEngineAutoContext: { type: "boolean", default: true },
      localOnly: {
        type: "boolean",
        default: true,
        description: "Use deterministic CorpusWire prompt rewriting unless a generated rewrite is explicitly requested.",
      },
    },
  },
  parse(value) {
    const { config, errors } = normalizePluginConfig(value);
    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
    return config;
  },
  safeParse(value) {
    const { config, errors } = normalizePluginConfig(value);
    if (errors.length > 0) {
      return {
        success: false,
        error: {
          issues: errors.map((message) => ({ path: [], message })),
        },
      };
    }
    return { success: true, data: config };
  },
  validate(value) {
    const { errors } = normalizePluginConfig(value);
    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },
};

const plugin = {
  id: PLUGIN_ID,
  name: "CorpusWire",
  description: "CorpusWire retrieval, prompt enhancement, and OpenClaw context-engine adapter.",
  kind: "context-engine",
  configSchema,

  register(api) {
    const { config, errors } = normalizePluginConfig(api.pluginConfig ?? {});
    for (const error of errors) {
      api.logger?.warn?.(`corpuswire: ${error}; using fallback where possible`);
    }

    const client = buildCorpusWireClient(config);
    api.logger?.info?.(
      `corpuswire: registered (baseUrl=${config.baseUrl}, workspaceId=${config.workspaceId ?? "default"}, repoPath=${config.repoPath ?? "default"})`,
    );

    api.registerTool(
      {
        name: "corpuswire_search",
        label: "CorpusWire Search",
        description: "Search the CorpusWire index for repository or workspace context.",
        parameters: SEARCH_PARAMETERS,
        async execute(_toolCallId, params, signal) {
          try {
            const input = asRecord(params);
            const query = readRequiredString(input, "query");
            const payload = await client.query(
              {
                query,
                repoPath: readOptionalString(input, "repoPath"),
                workspaceId: readOptionalString(input, "workspaceId"),
                topK: readOptionalNumber(input, "topK"),
                minScore: readOptionalNumber(input, "minScore"),
              },
              { signal },
            );
            const formatted = formatSearchToolResult(payload, { maxChars: config.maxContextChars });
            return textResult(formatted.text, formatted.details);
          } catch (error) {
            return failedResult(`CorpusWire search failed: ${formatError(error)}`, error);
          }
        },
      },
      { name: "corpuswire_search" },
    );

    api.registerTool(
      {
        name: "corpuswire_enhance",
        label: "CorpusWire Enhance",
        description: "Rewrite a prompt with CorpusWire retrieval context.",
        parameters: ENHANCE_PARAMETERS,
        async execute(_toolCallId, params, signal) {
          try {
            const input = asRecord(params);
            const prompt = readRequiredString(input, "prompt");
            const { payload, usedLocalFallback } = await enhanceWithLocalFallback(client, {
              prompt,
              repoPath: readOptionalString(input, "repoPath"),
              workspaceId: readOptionalString(input, "workspaceId"),
              topK: readOptionalNumber(input, "topK"),
              minScore: readOptionalNumber(input, "minScore"),
              outputMode: readOptionalString(input, "outputMode"),
              localOnly: readOptionalBoolean(input, "localOnly"),
            }, { signal });
            const formatted = formatEnhanceToolResult(payload, { maxChars: config.maxContextChars * 2 });
            formatted.details.usedLocalFallback = usedLocalFallback;
            return textResult(formatted.text, formatted.details);
          } catch (error) {
            return failedResult(`CorpusWire enhancement failed: ${formatError(error)}`, error);
          }
        },
      },
      { name: "corpuswire_enhance" },
    );

    api.registerTool(
      {
        name: "corpuswire_ingest",
        label: "CorpusWire Ingest",
        description: "Incrementally update a service-local CorpusWire Qdrant index for a repository.",
        parameters: INGEST_PARAMETERS,
        async execute(_toolCallId, params, signal) {
          try {
            const input = asRecord(params);
            const payload = await client.ingest(
              {
                repoPath: readOptionalString(input, "repoPath"),
                workspaceId: readOptionalString(input, "workspaceId"),
                sourceDir: readOptionalString(input, "sourceDir"),
                recreateCollection: readOptionalBoolean(input, "recreateCollection") ?? false,
                includeGlobs: readOptionalStringArray(input, "includeGlobs"),
                excludeGlobs: readOptionalStringArray(input, "excludeGlobs"),
                maxFileSizeBytes: readOptionalInteger(input, "maxFileSizeBytes"),
              },
              { signal },
            );
            const formatted = formatIngestToolResult(payload);
            return textResult(formatted.text, formatted.details);
          } catch (error) {
            return failedResult(`CorpusWire ingest failed: ${formatError(error)}`, error);
          }
        },
      },
      { name: "corpuswire_ingest" },
    );

    api.registerCli?.(({ program }) => {
      const root = program.command("corpuswire").description("Local CorpusWire integration");

      root
        .command("health")
        .description("Check the configured CorpusWire API")
        .option("--json", "Print raw JSON")
        .action(async (options) => {
          const payload = await client.health();
          printCliResult(payload, options.json);
        });

      root
        .command("search")
        .description("Search context")
        .argument("<query>", "Search query")
        .option("--repo <path>", "Repository path")
        .option("--workspace-id <id>", "Remote workspace id")
        .option("--top-k <n>", "Maximum result count")
        .option("--min-score <n>", "Minimum score from 0 to 1")
        .option("--json", "Print raw JSON")
        .action(async (query, options) => {
          const payload = await client.query({
            query,
            repoPath: options.repo,
            workspaceId: options.workspaceId,
            topK: parseOptionalNumber(options.topK),
            minScore: parseOptionalNumber(options.minScore),
          });
          if (options.json) {
            printCliResult(payload, true);
            return;
          }
          const formatted = formatSearchToolResult(payload, { maxChars: config.maxContextChars });
          console.log(formatted.text);
        });

      root
        .command("enhance")
        .description("Rewrite a prompt with context")
        .argument("<prompt>", "Prompt to enhance")
        .option("--repo <path>", "Repository path")
        .option("--workspace-id <id>", "Remote workspace id")
        .option("--mode <mode>", "Output mode: generic, copilot, claude-code, or sequential", "generic")
        .option("--local-only", "Disable LLM generation")
        .option("--json", "Print raw JSON")
        .action(async (prompt, options) => {
          const { payload, usedLocalFallback } = await enhanceWithLocalFallback(client, {
            prompt,
            repoPath: options.repo,
            workspaceId: options.workspaceId,
            outputMode: options.mode,
            localOnly: options.localOnly ? true : undefined,
          });
          if (options.json) {
            printCliResult(payload, true);
            return;
          }
          const formatted = formatEnhanceToolResult(payload, { maxChars: config.maxContextChars * 2 });
          console.log(formatted.text);
          if (usedLocalFallback) {
            console.log("\nCorpusWire retried with localOnly=true because backend generation setup was unavailable.");
          }
        });

      root
        .command("ingest")
        .description("Incrementally update service-local context for a repository")
        .option("--repo <path>", "Repository path")
        .option("--source-dir <path>", "Source directory override")
        .option("--recreate", "Recreate the target collection instead of incremental update")
        .option("--include-glob <glob>", "Restrict ingest to a glob (repeatable or comma-separated)", collectCliListOption, [])
        .option("--exclude-glob <glob>", "Skip files matching a glob (repeatable or comma-separated)", collectCliListOption, [])
        .option("--max-file-size-bytes <n>", "Skip files larger than this many bytes")
        .option("--json", "Print raw JSON")
        .action(async (options) => {
          const payload = await client.ingest({
            repoPath: options.repo,
            sourceDir: options.sourceDir,
            recreateCollection: Boolean(options.recreate),
            includeGlobs: normalizeCliListOption(options.includeGlob),
            excludeGlobs: normalizeCliListOption(options.excludeGlob),
            maxFileSizeBytes: parseOptionalInteger(options.maxFileSizeBytes),
          });
          if (options.json) {
            printCliResult(payload, true);
            return;
          }
          const formatted = formatIngestToolResult(payload);
          console.log(formatted.text);
        });
    }, { commands: ["corpuswire"] });

    api.on?.("before_prompt_build", async (event) => {
      if (!config.autoContext) {
        return undefined;
      }

      const prompt = extractPromptText(event);
      if (prompt.length < 8) {
        return undefined;
      }

      try {
        const payload = await client.query({ query: prompt });
        const prependContext = formatPromptContext(payload, { maxChars: config.maxContextChars });
        return prependContext ? { prependContext } : undefined;
      } catch (error) {
        api.logger?.warn?.(`corpuswire: auto context failed: ${formatError(error)}`);
        return undefined;
      }
    });

    api.registerContextEngine?.(PLUGIN_ID, () => createOpenClawContextEngine({ client, config, logger: api.logger }));

    api.registerService?.({
      id: PLUGIN_ID,
      start: () => {
        api.logger?.info?.(`corpuswire: service active (${config.baseUrl})`);
      },
      stop: () => {
        api.logger?.info?.("corpuswire: service stopped");
      },
    });
  },
};

export default plugin;
export { configSchema, createOpenClawContextEngine, normalizePluginConfig };
export * from "./lib/client.js";
export * from "./lib/format.js";

function textResult(text, details) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function failedResult(text, error) {
  return textResult(text, {
    status: "failed",
    error: formatError(error),
  });
}

async function enhanceWithLocalFallback(client, request, options = {}) {
  try {
    return { payload: await client.enhance(request, options), usedLocalFallback: false };
  } catch (error) {
    if (request.localOnly === true || !isGenerationSetupError(error)) {
      throw error;
    }
    return {
      payload: await client.enhance({ ...request, localOnly: true }, options),
      usedLocalFallback: true,
    };
  }
}

function isGenerationSetupError(error) {
  const message = [
    error?.responseBody,
    error?.message,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");

  return message.includes("OPENCLAW_MODEL or LLM_MODEL is required")
    || message.includes("Prompt rewriting requires a configured generation backend")
    || message.includes("Unsupported GENERATION_PROVIDER")
    || message.includes("Unsupported OPENCLAW_EXECUTION_MODE");
}

function printCliResult(payload, asJson) {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const runtime = payload.runtime ?? {};
  const qdrant = payload.qdrant ?? {};
  console.log(`status: ${payload.ok ? "ok" : "unknown"}`);
  console.log(`corpuswire: ${runtime.corpuswire_enabled ? "enabled" : "disabled"}`);
  console.log(`qdrant collection: ${qdrant.collection ?? "unknown"}`);
}

function readRequiredString(record, key) {
  const value = readOptionalString(record, key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function readOptionalString(record, key) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(record, key) {
  const value = record[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readOptionalBoolean(record, key) {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalStringArray(record, key) {
  const value = record[key];
  if (Array.isArray(value)) {
    const items = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const items = value.split(",").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function readOptionalInteger(record, key) {
  const value = readOptionalNumber(record, key);
  return value === undefined ? undefined : Math.trunc(value);
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalInteger(value) {
  const parsed = parseOptionalNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function collectCliListOption(value, previous = []) {
  return [...previous, ...String(value).split(",").map((item) => item.trim()).filter(Boolean)];
}

function normalizeCliListOption(value) {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
