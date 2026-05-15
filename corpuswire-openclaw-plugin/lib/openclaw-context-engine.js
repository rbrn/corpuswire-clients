import {
  estimateMessagesTokens,
  estimateTextTokens,
  extractLastUserMessageText,
  getContextPayload,
  getResultPayload,
  formatPromptContext,
} from "./format.js";

export function createOpenClawContextEngine({ client, config, logger }) {
  async function runIncrementalIngest(params = {}) {
    try {
      const input = asRecord(params);
      const payload = await client.ingest({
        repoPath: readOptionalString(input, "repoPath"),
        workspaceId: readOptionalString(input, "workspaceId"),
        sourceDir: readOptionalString(input, "sourceDir"),
        recreateCollection: readOptionalBoolean(input, "recreateCollection") ?? false,
        includeGlobs: readOptionalStringArray(input, "includeGlobs"),
        excludeGlobs: readOptionalStringArray(input, "excludeGlobs"),
        maxFileSizeBytes: readOptionalNumber(input, "maxFileSizeBytes"),
      });
      return summarizeIngestPayload(payload);
    } catch (error) {
      logger?.warn?.(`corpuswire: incremental ingest failed: ${formatError(error)}`);
      return {
        ingested: false,
        error: formatError(error),
      };
    }
  }

  return {
    info: {
      id: "corpuswire",
      name: "CorpusWire",
      version: "0.1.2",
      ownsCompaction: false,
      turnMaintenanceMode: "background",
    },

    async bootstrap() {
      return {
        bootstrapped: false,
        reason: "CorpusWire uses an external API/index and does not bootstrap OpenClaw transcripts.",
      };
    },

    async maintain() {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "Transcript maintenance is left to OpenClaw.",
      };
    },

    async ingest(params = {}) {
      return runIncrementalIngest(params);
    },

    async ingestBatch(params = {}) {
      const items = Array.isArray(params) ? params : Array.isArray(params?.items) ? params.items : [];
      const request = Array.isArray(params) ? {} : asRecord(params);
      const result = await runIncrementalIngest(request);
      return {
        ingestedCount: result.ingested ? Math.max(items.length, 1) : 0,
        result,
      };
    },

    async afterTurn() {},

    async assemble(params) {
      const messages = Array.isArray(params.messages) ? params.messages : [];
      const estimatedTokens = estimateMessagesTokens(messages);
      if (!config.contextEngineAutoContext) {
        return { messages, estimatedTokens };
      }

      const prompt = typeof params.prompt === "string" && params.prompt.trim()
        ? params.prompt.trim()
        : extractLastUserMessageText(messages);
      if (prompt.length < 8) {
        return { messages, estimatedTokens };
      }

      try {
        const payload = await client.query({ query: prompt });
        const systemPromptAddition = formatPromptContext(payload, { maxChars: config.maxContextChars });
        if (!systemPromptAddition) {
          return { messages, estimatedTokens };
        }
        return {
          messages,
          estimatedTokens: estimatedTokens + estimateTextTokens(systemPromptAddition),
          systemPromptAddition,
        };
      } catch (error) {
        logger?.warn?.(`corpuswire: context assemble failed: ${formatError(error)}`);
        return { messages, estimatedTokens };
      }
    },

    async compact() {
      return {
        ok: true,
        compacted: false,
        reason: "CorpusWire does not compact OpenClaw transcripts.",
      };
    },

    async dispose() {},
  };
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function summarizeIngestPayload(payload) {
  const result = getResultPayload(payload);
  const context = getContextPayload(payload);
  return {
    ingested: true,
    collection: context?.collection ?? result.collection ?? null,
    repoPath: context?.repo_path ?? result.source_dir ?? null,
    workspaceId: context?.workspace_id ?? result.workspace_id ?? null,
    documentsIndexed: readNumber(result.documents_indexed),
    chunksIndexed: readNumber(result.chunks_indexed),
    filesAdded: readNumber(result.files_added),
    filesUpdated: readNumber(result.files_updated),
    filesDeleted: readNumber(result.files_deleted),
    vectorSize: typeof result.vector_size === "number" ? result.vector_size : null,
  };
}

function readOptionalString(record, key) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalBoolean(record, key) {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalNumber(record, key) {
  const value = record[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
