import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_BIN = fileURLToPath(new URL("../bin/corpuswire-mcp.js", import.meta.url));

test("corpuswire-mcp exposes tools and maps search requests to the SDK", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://mock-corpuswire",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_WORKSPACE_ID: "workspace-from-env",
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const tools = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      assert.equal(tools.result.tools.some((tool) => tool.name === "corpuswire_search"), true);
      assert.equal(tools.result.tools.some((tool) => tool.name === "corpuswire_diagnose_workspace"), true);

      const search = await rpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "corpuswire_search",
          arguments: {
            query: "remote index API router",
            topK: 3,
            workspaceId: "workspace-explicit",
          },
        },
      });

      assert.equal(search.result.isError, false);
      assert.match(search.result.content[0].text, /corpuswire_remote_indexer\/router\.py/);
      assert.match(search.result.content[0].text, /Agent context packets:/);
      assert.match(search.result.content[0].text, /role: integration/);
    } finally {
      child.kill();
    }

    const requests = (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.deepEqual(requests, [
      {
        query: "remote index API router",
        workspaceId: "workspace-explicit",
        topK: 3,
        includeAnswer: false,
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp diagnoses workspace collection mismatches", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://mock-corpuswire",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_WORKSPACE_ID: "workspace-from-env",
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const diagnosis = await rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "corpuswire_diagnose_workspace",
          arguments: {
            workspaceId: "workspace-explicit",
          },
        },
      });

      assert.equal(diagnosis.result.isError, false);
      assert.match(diagnosis.result.content[0].text, /status: blocked/);
      assert.match(diagnosis.result.content[0].text, /collectionExists: false/);
      assert.match(diagnosis.result.content[0].text, /activeDefaultRepoPath: \/Users\/constantinaldea\/clawd/);
      assert.match(diagnosis.result.content[0].text, /Index or sync workspace/);
    } finally {
      child.kill();
    }

    const requests = (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.deepEqual(requests, [
      {
        kind: "diagnoseWorkspace",
        workspaceId: "workspace-explicit",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp keeps empty search output focused on recovery instead of packets", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://mock-corpuswire",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_WORKSPACE_ID: "workspace-from-env",
        MOCK_REQUESTS_PATH: requestsPath,
        MOCK_QUERY_EMPTY: "true",
      },
    });
    const rpc = createRpc(child);

    try {
      const search = await rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "corpuswire_search",
          arguments: {
            query: "missing workspace context",
            workspaceId: "workspace-explicit",
          },
        },
      });

      const text = search.result.content[0].text;
      assert.equal(search.result.isError, false);
      assert.match(text, /No hits returned/);
      assert.match(text, /Recovery:/);
      assert.doesNotMatch(text, /Agent context packets:/);
    } finally {
      child.kill();
    }

    const requests = (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.deepEqual(requests, [
      {
        query: "missing workspace context",
        workspaceId: "workspace-explicit",
        topK: 5,
        includeAnswer: false,
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp retries prompt enhancement with localOnly when generation setup is unavailable", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://mock-corpuswire",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_WORKSPACE_ID: "workspace-from-env",
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const enhance = await rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "corpuswire_enhance_prompt",
          arguments: {
            prompt: "fix enhancer fallback",
            localOnly: false,
          },
        },
      });

      assert.equal(enhance.result.isError, false);
      assert.match(enhance.result.content[0].text, /Local deterministic rewrite/);
      assert.match(enhance.result.content[0].text, /localFallback: retried with localOnly=true/);
      assert.match(enhance.result.content[0].text, /Agent context packets:/);
    } finally {
      child.kill();
    }

    const requests = (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.deepEqual(requests, [
      {
        prompt: "fix enhancer fallback",
        outputMode: "generic",
        workspaceId: "workspace-from-env",
        topK: 5,
        localOnly: false,
      },
      {
        prompt: "fix enhancer fallback",
        outputMode: "generic",
        workspaceId: "workspace-from-env",
        topK: 5,
        localOnly: true,
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function writeMockSdk(tempDir) {
  const sdkPath = path.join(tempDir, "mock-sdk.mjs");
  const requestsPath = path.join(tempDir, "requests.jsonl");
  await writeFile(requestsPath, "", "utf8");
  await writeFile(
    sdkPath,
    `
import { appendFileSync } from "node:fs";

export class CorpusWireClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? "http://mock-corpuswire";
  }

  async queryRaw(request) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify(request) + "\\n", "utf8");
    if (process.env.MOCK_QUERY_EMPTY === "true") {
      return {
        result: {
          retrieval_query: request.query,
          retrieval_backend: "none",
          retrieval_warning: "No indexed Qdrant points were found for this context.",
          retrieved_chunks: [],
          agent_context_packets: []
        },
        context: {
          workspace_id: request.workspaceId,
          collection: "corpuswire-test",
          index: {
            manifest_revision: 7,
            health_status: "degraded",
            health_warnings: ["No indexed Qdrant points were found for this context."]
          }
        }
      };
    }
    return {
      result: {
        retrieval_query: request.query,
        retrieval_backend: "qdrant_hybrid",
        retrieved_chunks: [
          {
            chunk_id: "chunk-router",
            score: 0.91,
            text: "def start_session(request):\\n    return service.start_session(request)",
            metadata: {
              source_path: "packages/remote-indexer/src/corpuswire_remote_indexer/router.py",
              title: "router.py",
              start_line: 30,
              end_line: 36,
              indexed_commit: "72f945f"
            }
          }
        ],
        agent_context_packets: [
          {
            source_path: "clients/corpuswire-mcp/bin/corpuswire-mcp.js",
            role: "integration",
            inspection_order: 1,
            score: 1.23,
            reasons: ["integration context", "matches prompt terms"],
            symbols: ["function searchContext"],
            line_ranges: ["1200-1240"],
            chunk_ids: ["chunk-router"],
            doc_type: "code",
            package_name: "corpuswire-mcp",
            tags: ["source-code"]
          }
        ]
      },
      context: {
        workspace_id: request.workspaceId,
        collection: "corpuswire-test",
        index: { manifest_revision: 7 }
      }
    };
  }

  async diagnoseWorkspace(request) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "diagnoseWorkspace",
      repoPath: request.repoPath,
      workspaceId: request.workspaceId,
    }) + "\\n", "utf8");
    return {
      status: "blocked",
      can_retrieve: false,
      requested_repo_path: request.repoPath ?? null,
      requested_workspace_id: request.workspaceId ?? null,
      resolved_context: request.workspaceId ?? request.repoPath ?? "workspace-test",
      resolved_workspace_id: request.workspaceId ?? null,
      resolution_mode: request.workspaceId ? "remote" : "local",
      collection: "local-doc-rag-poc--corpuswire-main--ad8994dc8a6e",
      collection_exists: false,
      point_count: 0,
      qdrant_error: null,
      index: {
        path: request.workspaceId ?? "workspace-test",
        collection: "local-doc-rag-poc--corpuswire-main--ad8994dc8a6e",
        indexed: false,
        health_status: "degraded",
        health_warnings: ["No indexed Qdrant points were found for this context."],
      },
      active_backend: {
        default_repo_path: "/Users/constantinaldea/clawd",
        default_collection: "local-doc-rag-poc--clawd--d0730c35d7ae",
        requested_context: request.workspaceId ?? request.repoPath ?? "workspace-test",
        matches_requested_context: false,
      },
      checks: [
        {
          name: "collection",
          status: "error",
          message: "Collection does not exist: local-doc-rag-poc--corpuswire-main--ad8994dc8a6e",
        },
      ],
      recovery_actions: ["Index or sync workspace 'workspace-explicit'; expected collection 'local-doc-rag-poc--corpuswire-main--ad8994dc8a6e'."],
    };
  }

  async enhance(request) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify(request) + "\\n", "utf8");
    if (request.localOnly !== true) {
      const error = new CorpusWireHttpError("Prompt rewriting requires a configured generation backend");
      error.errorMessage = "Prompt rewriting requires a configured generation backend";
      throw error;
    }

    return {
      retrieval_query: request.prompt,
      retrieval_backend: "qdrant_hybrid",
      retrieved_chunks: [],
      agent_context_packets: [
        {
          source_path: "clients/corpuswire-mcp/bin/corpuswire-mcp.js",
          role: "integration",
          inspection_order: 1,
          score: 1.23,
          reasons: ["integration context"],
          symbols: ["function enhancePrompt"],
          line_ranges: ["1300-1340"],
          chunk_ids: ["chunk-enhance"],
          doc_type: "code",
          package_name: "corpuswire-mcp",
          tags: ["source-code"]
        }
      ],
      task_type: "bug_fix",
      output_mode: request.outputMode,
      enhancement_prompt: "prompt",
      enhanced_prompt: "Local deterministic rewrite",
      enhancement_backend: "local-deterministic",
      generation_error: "Prompt rewriting requires a configured generation backend"
    };
  }
}

export class CorpusWireHttpError extends Error {
  errorMessage = null;
}
`.trimStart(),
    "utf8",
  );
  return { sdkPath, requestsPath };
}

function createRpc(process) {
  let buffer = "";
  const responses = [];
  const waiters = [];

  process.stdout.setEncoding("utf8");
  process.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        responses.push(JSON.parse(line));
      }
      newlineIndex = buffer.indexOf("\n");
    }
    flushWaiters();
  });

  function flushWaiters() {
    while (responses.length > 0 && waiters.length > 0) {
      waiters.shift()(responses.shift());
    }
  }

  return (message) => new Promise((resolve, reject) => {
    waiters.push(resolve);
    process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        reject(error);
      }
    });
    flushWaiters();
  });
}
