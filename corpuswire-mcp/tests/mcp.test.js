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
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
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
      assert.equal(tools.result.tools.some((tool) => tool.name === "corpuswire_rate_result"), true);
      assert.equal(tools.result.tools.some((tool) => tool.name === "corpuswire_quality_review"), true);
      assert.equal(tools.result.tools.some((tool) => tool.name === "corpuswire_value_rollup"), true);
      for (const name of ["corpuswire_search", "corpuswire_enhance_prompt"]) {
        const tool = tools.result.tools.find((candidate) => candidate.name === name);
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert.equal("tenantId" in tool.inputSchema.properties, false);
        assert.equal("userId" in tool.inputSchema.properties, false);
      }

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

      const valueRollup = await rpc({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "corpuswire_value_rollup",
          arguments: {
            period: "week",
            days: 30,
            workspaceId: "workspace-explicit",
            hourlyRate: 100,
          },
        },
      });
      assert.equal(valueRollup.result.isError, false);
      assert.match(valueRollup.result.content[0].text, /CorpusWire value rollup:/);
      assert.match(valueRollup.result.content[0].text, /period: week/);
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
      {
        kind: "valueRollup",
        period: "week",
        days: 30,
        workspaceId: "workspace-explicit",
        hourlyRate: 100,
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
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
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
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
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
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
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

test("corpuswire-mcp records and reviews central quality ratings", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_WORKSPACE_ID: "workspace-from-env",
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const recorded = await rpc({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "corpuswire_rate_result",
          arguments: {
            workType: "semantic_retrieval",
            engine: "augment",
            relevance: 5,
            fileSpecificity: 5,
            coverage: 4,
            freshness: 5,
            actionability: 5,
            roundId: "round-mcp-1",
            query: "find exact quality ledger files",
            resultPaths: ["src/corpuswire/observability/quality_ledger.py"],
          },
        },
      });
      assert.equal(recorded.result.isError, false);
      assert.match(recorded.result.content[0].text, /overall: 4.8/);
      assert.match(recorded.result.content[0].text, /queryStoredAs: sha256:/);

      const review = await rpc({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "corpuswire_quality_review",
          arguments: { days: 14 },
        },
      });
      assert.equal(review.result.isError, false);
      assert.match(review.result.content[0].text, /eventCount: 1/);
      assert.match(review.result.content[0].text, /augment: 4.8/);
      assert.match(review.result.content[0].text, /Recommended actions:/);
    } finally {
      child.kill();
    }

    const requests = (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(requests[0].kind, "recordQualityEvent");
    assert.equal(requests[0].workspaceId, "workspace-from-env");
    assert.deepEqual(requests[1], { kind: "reviewQuality", days: 14 });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp health tool checks backend reachability", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_WORKSPACE_ID: "workspace-from-env",
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const health = await rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "corpuswire_health",
          arguments: {},
        },
      });

      assert.equal(health.result.isError, false);
      const text = health.result.content[0].text;
      assert.match(text, /corpuswire health:/);
      assert.match(text, /status: ok/);
      assert.match(text, /baseUrl: http:\/\/127\.0\.0\.1:8000/);
      assert.match(text, /qdrant_collection:/);
    } finally {
      child.kill();
    }

    const requests = (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.deepEqual(requests, [
      {
        kind: "health",
        workspaceId: "workspace-from-env",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp doctor tool combines health diagnosis and activity", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_WORKSPACE_ID: "workspace-from-env",
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const doctor = await rpc({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "corpuswire_doctor",
          arguments: {},
        },
      });

      assert.equal(doctor.result.isError, false);
      const text = doctor.result.content[0].text;
      assert.match(text, /CorpusWire doctor:/);
      assert.match(text, /verdict: blocked/);
      assert.match(text, /backendOk: true/);
      assert.match(text, /diagnosisStatus: blocked/);
      assert.match(text, /canRetrieve: false/);
      assert.match(text, /Recovery:/);
    } finally {
      child.kill();
    }

    const requests = (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    // Doctor calls health, diagnoseWorkspace, potentially sessions and activity
    assert.ok(requests.some(r => r.kind === "health"));
    assert.ok(requests.some(r => r.kind === "diagnoseWorkspace"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp reconcile can request a clean collection rebuild", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    await writeFile(path.join(tempDir, "README.md"), "# Reconcile\n\nCorpusWire rebuild test.\n", "utf8");
    await writeFile(path.join(tempDir, "Bridge.kt"), "class Bridge { fun readSteps() = 0 }\n", "utf8");
    await writeFile(path.join(tempDir, "health-check.kts"), "fun verifyReadOnly() = true\n", "utf8");
    await writeFile(path.join(tempDir, "Reader.scala"), "object Reader { def readSteps(): Int = 0 }\n", "utf8");
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_WORKSPACE_ID: "workspace-from-env",
        CORPUSWIRE_REPO_PATH: tempDir,
        CORPUSWIRE_SYNC_ENABLED: "true",
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const reconcile = await rpc({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "corpuswire_sync_reconcile",
          arguments: {
            includeGlobs: ["README.md", "*.kt", "*.kts", "*.scala"],
            maxFiles: 5,
            maxWaitMs: 10000,
            recreateCollection: true,
          },
        },
      });

      assert.equal(reconcile.result.isError, false);
      assert.match(reconcile.result.content[0].text, /reconcileRan: true/);
      assert.match(reconcile.result.content[0].text, /Reconciliation summary:/);
    } finally {
      child.kill();
    }

    const requests = (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.deepEqual(requests, [
      {
        kind: "indexWorkspace",
        workspaceId: "workspace-from-env",
        mode: "full",
        recreateCollection: true,
        processingTimeoutMs: 10000,
        files: ["Bridge.kt", "health-check.kts", "Reader.scala", "README.md"],
        deletedPaths: [],
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp sends basic auth to plugin discovery and calls", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  const expectedAuth = "Basic dXNlcjpwYXNz";
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const fetchRequestsPath = path.join(tempDir, "fetch-requests.jsonl");
    const fetchMockPath = path.join(tempDir, "mock-fetch.mjs");
    await writeFile(fetchRequestsPath, "", "utf8");
    await writeFile(
      fetchMockPath,
      `
import { appendFileSync } from "node:fs";

globalThis.fetch = async (url, init = {}) => {
  const headers = {};
  new Headers(init.headers ?? {}).forEach((value, key) => {
    headers[key] = value;
  });
  appendFileSync(process.env.MOCK_FETCH_REQUESTS_PATH, JSON.stringify({
    url: String(url),
    method: init.method ?? "GET",
    authorization: headers.authorization ?? "",
  }) + "\\n", "utf8");

  if (String(url).endsWith("/v1/plugins/mcp-tools")) {
    return new Response(JSON.stringify({
      tools: [
        {
          name: "corpuswire_plugin_echo",
          description: "Echo from a plugin.",
          input_schema: { type: "object", additionalProperties: true },
          plugin: "test-plugin",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (String(url).endsWith("/v1/plugins/mcp-call")) {
    return new Response(JSON.stringify({ ok: true, text: "plugin-ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ detail: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
};
`.trimStart(),
      "utf8",
    );
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        NODE_OPTIONS: `${globalThis.process.env.NODE_OPTIONS ?? ""} --import ${fetchMockPath}`.trim(),
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_BASIC_AUTH: "user:pass",
        CORPUSWIRE_SDK_PATH: sdkPath,
        MOCK_FETCH_REQUESTS_PATH: fetchRequestsPath,
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const tools = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
      assert.equal(tools.result.tools.some((tool) => tool.name === "corpuswire_plugin_echo"), true);

      const result = await rpc({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "corpuswire_plugin_echo",
          arguments: { message: "hello" },
        },
      });
      assert.equal(result.result.isError, false);
      assert.match(result.result.content[0].text, /plugin-ok/);
    } finally {
      child.kill();
    }

    const seenRequests = (await readFile(fetchRequestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(seenRequests.map(({ method, url, authorization }) => ({ method, url, authorization })), [
      { method: "GET", url: "http://127.0.0.1:8000/v1/plugins/mcp-tools", authorization: expectedAuth },
      { method: "POST", url: "http://127.0.0.1:8000/v1/plugins/mcp-call", authorization: expectedAuth },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp rejects non-local backend URLs", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "https://corpuswire.onrender.com",
        CORPUSWIRE_REMOTE_ENABLED: "false",
        CORPUSWIRE_BASIC_AUTH: "",
        CORPUSWIRE_BEARER_TOKEN: "",
        CORPUSWIRE_SDK_PATH: sdkPath,
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const result = await rpc({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "corpuswire_search",
          arguments: { query: "should stay local" },
        },
      });
      assert.equal(result.result.isError, true);
      assert.match(result.result.content[0].text, /Remote CorpusWire access is disabled/);
    } finally {
      child.kill();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp permits an authenticated allow-listed remote backend", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "https://corpuswire.onrender.com",
        CORPUSWIRE_REMOTE_ENABLED: "true",
        CORPUSWIRE_ALLOWED_ORIGINS: "https://corpuswire.onrender.com",
        CORPUSWIRE_BASIC_AUTH: "",
        CORPUSWIRE_BEARER_TOKEN: "scoped-service-token",
        CORPUSWIRE_SDK_PATH: sdkPath,
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const result = await rpc({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "corpuswire_search",
          arguments: { query: "remote indexing policy" },
        },
      });
      assert.equal(result.result.isError, false);
      assert.match(result.result.content[0].text, /router\.py/);
    } finally {
      child.kill();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp blocks remote workspace sync without its explicit capability flag", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "https://corpuswire.onrender.com",
        CORPUSWIRE_REMOTE_ENABLED: "true",
        CORPUSWIRE_ALLOWED_ORIGINS: "https://corpuswire.onrender.com",
        CORPUSWIRE_BASIC_AUTH: "",
        CORPUSWIRE_BEARER_TOKEN: "scoped-service-token",
        CORPUSWIRE_SYNC_ENABLED: "true",
        CORPUSWIRE_REMOTE_SYNC_ENABLED: "false",
        CORPUSWIRE_SDK_PATH: sdkPath,
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const result = await rpc({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "corpuswire_sync_delta",
          arguments: {},
        },
      });
      assert.equal(result.result.isError, false);
      assert.match(result.result.content[0].text, /CORPUSWIRE_REMOTE_SYNC_ENABLED=true/);
    } finally {
      child.kill();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp reports explicit SDK skew for a missing valueRollup capability", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_SDK_PATH: sdkPath,
        MOCK_REQUESTS_PATH: requestsPath,
        MOCK_MISSING_VALUE_ROLLUP: "true",
      },
    });
    const rpc = createRpc(child);

    try {
      const result = await rpc({
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name: "corpuswire_value_rollup", arguments: {} },
      });
      assert.equal(result.result.isError, true);
      assert.match(result.result.content[0].text, /does not expose valueRollup/);
      assert.match(result.result.content[0].text, /rebuild and re-vendor the SDK/);
      assert.doesNotMatch(result.result.content[0].text, /is not a function/);
    } finally {
      child.kill();
    }
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
    if (process.env.MOCK_MISSING_VALUE_ROLLUP === "true") {
      this.valueRollup = undefined;
    }
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

  async health(request = {}) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "health",
      repoPath: request.repoPath,
      workspaceId: request.workspaceId,
    }) + "\\n", "utf8");
    return {
      ok: true,
      build: { version: "0.1.0" },
      docs_source_dir: "/workspace",
      runtime: { generation_provider_preference: "openai" },
      ollama: {},
      corpuswire: { enabled: true, reachable: true },
      qdrant: {
        collection: "corpuswire-test",
        collection_exists: true,
        point_count: 42,
        indexed: true,
        indexed_at: "2025-01-15T10:00:00Z",
        indexed_commit: "abc123",
        manifest_revision: 7,
      },
      index: {
        collection: "corpuswire-test",
        indexed: true,
        health_status: "ready",
        manifest_revision: 7,
      },
      active_project: {
        path: request.repoPath ?? "/workspace",
        workspace_id: request.workspaceId ?? null,
        collection: "corpuswire-test",
      },
      auth: { enabled: false },
      ui: "http://localhost:8000",
    };
  }

  async valueRollup(request = {}) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "valueRollup",
      ...request,
    }) + "\\n", "utf8");
    return {
      period: request.period ?? "day",
      days: request.days ?? 30,
      workspace_id: request.workspaceId ?? null,
      hourly_rate: request.hourlyRate ?? null,
      totals: { queries: 7, estimated_value: 125 },
      buckets: [],
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

  async listIndexSessions(request = {}) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "listIndexSessions",
      workspaceId: request.workspaceId,
    }) + "\\n", "utf8");
    return [];
  }

  async getIndexActivity(request = {}) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "getIndexActivity",
      workspaceId: request.workspaceId,
      windowHours: request.windowHours,
    }) + "\\n", "utf8");
    return {
      workspace_id: request.workspaceId ?? null,
      collection: "corpuswire-test",
      window_hours: request.windowHours ?? 24,
      last_attempt_at: "2025-01-15T10:00:00Z",
      last_attempt_status: "completed",
      consecutive_failures: 0,
      gap_detected: false,
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

  async recordQualityEvent(request) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "recordQualityEvent",
      ...request,
    }) + "\\n", "utf8");
    return {
      event_id: "quality-1",
      workspace_id: request.workspaceId,
      work_type: request.workType,
      engine: request.engine,
      relevance: request.scorecard.relevance,
      file_specificity: request.scorecard.fileSpecificity,
      coverage: request.scorecard.coverage,
      freshness: request.scorecard.freshness,
      actionability: request.scorecard.actionability,
      overall: 4.8,
      query: "sha256:abc123",
    };
  }

  async reviewQuality(request) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "reviewQuality",
      ...request,
    }) + "\\n", "utf8");
    return {
      window_days: request.days ?? 30,
      event_count: 1,
      overall_average: 4.8,
      dimension_averages: {
        relevance: 5,
        file_specificity: 5,
        coverage: 4,
        freshness: 5,
        actionability: 5,
      },
      by_engine: { augment: { count: 1, overall_average: 4.8 } },
      recommended_actions: [],
      recurring_improvements: [],
      low_score_events: [],
    };
  }

  async indexWorkspace(request) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "indexWorkspace",
      workspaceId: request.workspace.workspaceId,
      mode: request.mode,
      recreateCollection: request.recreateCollection,
      processingTimeoutMs: request.processingTimeoutMs,
      files: request.files.map((file) => file.relativePath),
      deletedPaths: request.deletedPaths ?? [],
    }) + "\\n", "utf8");
    return {
      result: {
        collection: "corpuswire-test",
        documents_indexed: request.files.length,
        files_added: request.files.length,
        files_updated: 0,
      },
      status: {
        manifest_revision: 12,
        files_indexed: request.files.length,
        files_deleted: 0,
      },
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
