import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_BIN = fileURLToPath(new URL("../bin/corpuswire-mcp.js", import.meta.url));
const WRAPPER_BIN = fileURLToPath(new URL("../../../plugins/corpuswire-context-engine/scripts/mcp-server.mjs", import.meta.url));
const REVIEW_SCHEMA_PATH = fileURLToPath(
  new URL("../../../schemas/review-context/v1/review-context.schema.json", import.meta.url),
);
const REVIEW_V2_SCHEMA_PATH = fileURLToPath(
  new URL("../../../schemas/review-context/v2/review-context.schema.json", import.meta.url),
);
const VENDORED_SDK_INDEX = new URL(
  "../vendor/corpuswire-sdk/dist/index.js",
  import.meta.url,
);

test("MCP version flags work offline before SDK loading through both entrypoints", async () => {
  const expected = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  for (const entrypoint of [SERVER_BIN, WRAPPER_BIN]) {
    for (const argument of ["version", "--version", "-V"]) {
      const child = spawn("node", [entrypoint, argument], {
        env: { ...process.env, CORPUSWIRE_SDK_PATH: "/missing-sdk-for-offline-version.mjs", CORPUSWIRE_BASE_URL: "invalid" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 0, stderr);
      assert.equal(stdout.trim(), expected);
      assert.equal(stderr, "");
    }
  }
});

test("MCP version tool preserves client identity offline and uses the local Docker default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cw-version-offline-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(root);
    for (const entrypoint of [SERVER_BIN, WRAPPER_BIN]) {
      const env = { ...process.env, CORPUSWIRE_SDK_PATH: sdkPath, MOCK_REQUESTS_PATH: requestsPath,
        CORPUSWIRE_SYNC_ENABLED: "false", CORPUSWIRE_RETRIEVAL_LOG_DIR: "" };
      delete env.CORPUSWIRE_BASE_URL;
      const child = spawn("node", [entrypoint], { env, stdio: ["pipe", "pipe", "pipe"] });
      const rpc = createRpc(child);
      try {
        const initialize = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        const result = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "corpuswire_version", arguments: {} } });
        assert.equal(result.result.isError, false);
        const info = JSON.parse(result.result.content[0].text);
        assert.equal(info.schemaVersion, "corpuswire-version/v1");
        assert.equal(info.mcp.version, initialize.result.serverInfo.version);
        assert.deepEqual(info.backend, { origin: "http://127.0.0.1:18080", status: "not_checked", version: null });
        assert.match(info.nodeVersion, /^v\d+\./);
        assert.equal(await readFile(requestsPath, "utf8"), "");
      } finally { child.kill(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP version tool distinguishes backend version, auth rejection, and unavailability", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cw-version-health-"));
  let status = 200, requests = 0, backendVersion = "0.1.33b1", fullHealth = false;
  const server = createServer((request, response) => {
    requests += 1;
    assert.equal(request.url, "/health");
    assert.equal(request.headers.authorization, "Bearer synthetic-version-test");
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(fullHealth
      ? { ok: true, build: { app_version: backendVersion } }
      : { ok: true, version: backendVersion }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const closeServer = () => new Promise((resolve) => server.close(resolve));
  const { sdkPath, requestsPath } = await writeMockSdk(root);
  const child = spawn("node", [SERVER_BIN], {
    env: { ...process.env, CORPUSWIRE_SDK_PATH: sdkPath, MOCK_REQUESTS_PATH: requestsPath,
      CORPUSWIRE_SYNC_ENABLED: "false", CORPUSWIRE_RETRIEVAL_LOG_DIR: "",
      CORPUSWIRE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      CORPUSWIRE_BASIC_AUTH: "", CORPUSWIRE_BEARER_TOKEN: "synthetic-version-test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = createRpc(child);
  const inspect = async (id, checkBackend = true) => {
    const response = await rpc({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "corpuswire_version", arguments: { checkBackend } } });
    assert.equal(response.result.isError, false);
    return JSON.parse(response.result.content[0].text);
  };
  try {
    assert.equal((await inspect(0, false)).backend.status, "not_checked");
    assert.equal(requests, 0); // Count real HTTP, not only mocked SDK calls.
    const healthy = await inspect(1);
    assert.equal(healthy.backend.status, "available");
    assert.equal(healthy.backend.version, "0.1.33b1");
    assert.notEqual(healthy.mcp.version, healthy.backend.version);
    fullHealth = true;
    assert.equal((await inspect(5)).backend.version, "0.1.33b1");
    status = 401;
    assert.equal((await inspect(2)).backend.status, "authentication_rejected");
    status = 200;
    backendVersion = "token=synthetic-secret\nunsafe";
    assert.equal((await inspect(4)).backend.version, null);
    await closeServer();
    const unavailable = await inspect(3);
    assert.equal(unavailable.mcp.version, healthy.mcp.version);
    assert.equal(unavailable.backend.status, "unavailable");
    assert.equal(unavailable.backend.version, null);
    assert.equal(requests, 4);
  } finally {
    child.kill();
    if (server.listening) await closeServer();
    await rm(root, { recursive: true, force: true });
  }
});

function withDisplayProjection(hit, { text = hit.text, startLine = hit.metadata.start_line,
  endLine = hit.metadata.end_line, sourceText = text } = {}) {
  const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  const sourceHash = digest(sourceText);
  return {
    ...hit,
    metadata: {
      ...hit.metadata,
      source_hash: sourceHash,
      extras: {
        ...hit.metadata.extras,
        corpuswire_display_lines: {
          schema_version: "corpuswire-complete-source-lines/v1",
          start_line: startLine,
          end_line: endLine,
          text,
          text_sha256: digest(text),
          source_hash: sourceHash,
        },
      },
    },
  };
}

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
      assert.equal(tools.result.tools.some((tool) => tool.name === "corpuswire_version"), true);
      assert.equal(tools.result.tools.some((tool) => tool.name === "corpuswire_diagnose_workspace"), true);
      assert.equal(tools.result.tools.some((tool) => tool.name === "corpuswire_rate_result"), true);
      assert.equal(tools.result.tools.some((tool) => tool.name === "corpuswire_quality_review"), true);
      for (const name of ["corpuswire_rate_result", "corpuswire_quality_review"]) {
        const tool = tools.result.tools.find((candidate) => candidate.name === name);
        assert.deepEqual(tool.inputSchema.properties.workType.enum, [
          "semantic_retrieval",
          "prompt_enhancement",
          "review_context",
        ]);
      }
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

test("CorpusWire search writes a redacted retrieval-failure report when it has no context", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-failure-report-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  await mkdir(workspaceRoot);
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_SYNC_ENABLED: "false",
        CORPUSWIRE_SYNC_READ_FRESHNESS_CHECK: "false",
        CORPUSWIRE_SYNC_ROOT: workspaceRoot,
        CORPUSWIRE_WORKSPACE_ID: "local-docker://report-test#main",
        MOCK_QUERY_EMPTY: "true",
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const result = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "corpuswire_search",
          arguments: {
            query: "find token=synthetic-secret-placeholder in local config",
          },
        },
      });
      assert.equal(result.result.isError, false, result.result.content[0].text);
      assert.match(result.result.content[0].text, /failureReport: reports\/retrieval-failures\//);
    } finally {
      child.kill();
    }

    const reportDirectory = path.join(workspaceRoot, "reports", "retrieval-failures");
    const [reportName] = await readdir(reportDirectory);
    const report = JSON.parse(await readFile(path.join(reportDirectory, reportName), "utf8"));
    assert.equal(report.schemaVersion, "corpuswire-retrieval-failure/v1");
    assert.equal(report.workspaceId, "local-docker://report-test#main");
    assert.equal(report.workType, "semantic_retrieval");
    assert.equal(report.failureMode, "no_retrieval_context");
    assert.equal(report.details.hitCount, 0);
    assert.equal(report.query, "[redacted: automatic retrieval diagnostic]");
    assert.equal(report.queryRedacted, true);
    assert.doesNotMatch(JSON.stringify(report), /synthetic-secret-placeholder/);
    assert.equal(report.scores.corpuswire.status, "not_rated");
    assert.equal(report.scores.augment.status, "not_compared");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CorpusWire search writes failure reports under the resolved working directory", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-failure-report-cwd-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  await mkdir(workspaceRoot);
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const env = {
      ...globalThis.process.env,
      CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
      CORPUSWIRE_SDK_PATH: sdkPath,
      CORPUSWIRE_SYNC_ENABLED: "false",
      CORPUSWIRE_WORKSPACE_ID: "local-docker://report-cwd-test#main",
      MOCK_QUERY_EMPTY: "true",
      MOCK_REQUESTS_PATH: requestsPath,
    };
    delete env.CORPUSWIRE_SYNC_ROOT;
    delete env.CORPUSWIRE_REPO_PATH;
    const child = spawn("node", [SERVER_BIN], {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const rpc = createRpc(child);

    try {
      const result = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "corpuswire_search",
          arguments: { query: "find workspace configuration" },
        },
      });
      assert.equal(result.result.isError, false, result.result.content[0].text);
      assert.match(result.result.content[0].text, /failureReport: reports\/retrieval-failures\//);
    } finally {
      child.kill();
    }

    const reportDirectory = path.join(workspaceRoot, "reports", "retrieval-failures");
    const [reportName] = await readdir(reportDirectory);
    const report = JSON.parse(await readFile(path.join(reportDirectory, reportName), "utf8"));
    assert.equal(report.workspaceId, "local-docker://report-cwd-test#main");
    assert.equal(report.failureMode, "no_retrieval_context");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CorpusWire prompt enhancement failures create a local diagnostic report", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-enhance-failure-report-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  await mkdir(workspaceRoot);
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_SYNC_ENABLED: "false",
        CORPUSWIRE_SYNC_ROOT: workspaceRoot,
        CORPUSWIRE_WORKSPACE_ID: "local-docker://report-test#main",
        MOCK_ENHANCE_EMPTY: "true",
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const result = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "corpuswire_enhance_prompt",
          arguments: { prompt: "ground this task in the workspace" },
        },
      });
      assert.equal(result.result.isError, true);
      assert.match(result.result.content[0].text, /failureReport: reports\/retrieval-failures\//);
    } finally {
      child.kill();
    }

    const reportDirectory = path.join(workspaceRoot, "reports", "retrieval-failures");
    const [reportName] = await readdir(reportDirectory);
    const report = JSON.parse(await readFile(path.join(reportDirectory, reportName), "utf8"));
    assert.equal(report.workType, "prompt_enhancement");
    assert.equal(report.failureMode, "no_enhanced_prompt");
    assert.equal(report.query, "[redacted: automatic retrieval diagnostic]");
    assert.equal(report.queryRedacted, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CorpusWire ratings create a report when a shared round is materially weaker than Augment", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-comparison-report-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  await mkdir(workspaceRoot);
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_SYNC_ENABLED: "false",
        CORPUSWIRE_SYNC_ROOT: workspaceRoot,
        CORPUSWIRE_WORKSPACE_ID: "local-docker://report-test#main",
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);
    const rating = (id, engine, score) => rpc({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "corpuswire_rate_result",
        arguments: {
          workspaceId: "local-docker://report-test#main",
          workType: "semantic_retrieval",
          engine,
          relevance: score,
          fileSpecificity: score,
          coverage: score,
          freshness: score,
          actionability: score,
          query: "find configuration generator",
          resultPaths: ["src/corpuswire/onboarding.py"],
          roundId: "comparison-test-r1",
        },
      },
    });

    try {
      const corpuswire = await rating(1, "corpuswire", 2);
      assert.equal(corpuswire.result.isError, false);
      assert.doesNotMatch(corpuswire.result.content[0].text, /failureReport:/);
      const augment = await rating(2, "augment", 4);
      assert.equal(augment.result.isError, false);
      assert.match(augment.result.content[0].text, /failureReport: reports\/retrieval-failures\//);
    } finally {
      child.kill();
    }

    const reportDirectory = path.join(workspaceRoot, "reports", "retrieval-failures");
    const [reportName] = await readdir(reportDirectory);
    const report = JSON.parse(await readFile(path.join(reportDirectory, reportName), "utf8"));
    assert.equal(report.roundId, "comparison-test-r1");
    assert.equal(report.failureMode, "corpuswire_materially_weaker_than_augment");
    assert.equal(report.scores.corpuswire.overall, 2);
    assert.equal(report.scores.augment.overall, 4);
    assert.deepEqual(report.resultPaths, ["src/corpuswire/onboarding.py"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("both Node entry points cite only delivered complete source lines", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-delivery-"));
  try {
    const { sdkPath } = await writeMockSdk(tempDir);
    const fixturePath = path.join(tempDir, "selected-hits.json");
    const hitTexts = [
      `RQT_DELIVERED_1 ${"e".repeat(24)}`,
      `RQT_DELIVERED_2 ${"b".repeat(244)}`,
      `RQT_DELIVERED_3 ${"c".repeat(18)}\n${"t".repeat(24)}`,
      `RQT_DELIVERED_4 ${"d".repeat(40)}\nRQT_TAIL_4 ${"d".repeat(96)}`,
      `RQT_DELIVERED_5 ${"e".repeat(4)}`,
    ];
    const hits = [1, 2, 3, 4, 5].map((number) => withDisplayProjection({
      chunk_id: `selected-${number}`,
      score: 1 - number / 10,
      text: hitTexts[number - 1],
      metadata: {
        source_path: `src/source-${number}.py`,
        start_line: number * 10,
        end_line: number * 10 + (number === 3 || number === 4 ? 1 : 0),
        indexed_commit: "fixture-commit",
      },
    }));
    await writeFile(fixturePath, JSON.stringify({
      result: {
        retrieval_query: "synthetic delivery check",
        retrieval_backend: "fixture",
        retrieval_evidence_policy: "generic-v2",
        retrieved_chunks: hits,
        agent_context_packets: [{
          source_path: "src/source-5.py",
          role: "implementation",
          inspection_order: 1,
          score: 1,
          reasons: ["synthetic fixture"],
          line_ranges: ["50-50"],
        }],
        citations: hits.map((hit) => `${hit.metadata.source_path}:${hit.metadata.start_line}-${hit.metadata.end_line}`),
      },
      context: { workspace_id: "fixture-delivery", collection: "fixture", index: { manifest_revision: 1 } },
    }), "utf8");

    for (const server of [SERVER_BIN, WRAPPER_BIN]) {
      const child = spawn("node", [server], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...globalThis.process.env,
          CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
          CORPUSWIRE_SDK_PATH: sdkPath,
          CORPUSWIRE_SYNC_ENABLED: "false",
          CORPUSWIRE_WORKSPACE_ID: "fixture-delivery",
          MOCK_QUERY_FIXTURE_PATH: fixturePath,
          MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl"),
        },
      });
      const rpc = createRpc(child);
      try {
        for (const [id, maxChars] of [[1, 12000], [2, 200]]) {
          const response = await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: {
            name: "corpuswire_search",
            arguments: { query: "synthetic delivery check", workspaceId: "fixture-delivery", topK: 5, maxChars },
          } });
          assert.equal(response.result.isError, false);
          const rendered = response.result.content[0].text;
          assert.match(rendered, /manifestRevision: 1/);
          assert.match(rendered, /contextWorkspaceId: fixture-delivery/);
          assert.match(rendered, /1\. src\/source-1\.py[\s\S]*?lines: 10-10[\s\S]*?RQT_DELIVERED_1/);
          if (maxChars === 12000) {
            for (const number of [2, 3, 4, 5]) {
              assert.match(rendered, new RegExp(`RQT_DELIVERED_${number}`));
            }
            assert.ok(rendered.indexOf("RQT_DELIVERED_1") < rendered.indexOf("RQT_DELIVERED_5"));
            for (const number of [1, 2, 3, 4, 5]) {
              assert.match(rendered, new RegExp(`src/source-${number}\\.py:${number * 10}-${hits[number - 1].metadata.end_line}`));
            }
          } else {
            assert.match(rendered, /Response truncated: 2 selected hit\(s\) clipped or omitted/);
            for (const number of [1, 3, 4, 5]) {
              assert.match(rendered, new RegExp(`RQT_DELIVERED_${number}`));
            }
            assert.match(rendered, /lines: 40-40/);
            assert.doesNotMatch(rendered, /RQT_TAIL_4/);
            for (const number of [1, 3, 5]) {
              assert.match(rendered, new RegExp(`src/source-${number}\\.py:${number * 10}-${hits[number - 1].metadata.end_line}`));
            }
            assert.doesNotMatch(rendered, /RQT_DELIVERED_2/);
            assert.doesNotMatch(rendered, /src\/source-2\.py:20-21/);
            assert.doesNotMatch(rendered, /src\/source-4\.py:40-41/);
            assert.match(rendered, /src\/source-4\.py:40-40/);
            assert.ok(rendered.indexOf("RQT_DELIVERED_1") < rendered.indexOf("RQT_DELIVERED_5"));
          }
        }
      } finally {
        child.kill();
      }
    }

    const legacyHits = hits.map((hit, index) => ({
      ...hit,
      metadata: { ...hit.metadata, end_line: (index + 1) * 10 + 1 },
    }));
    await writeFile(fixturePath, JSON.stringify({
      result: {
        retrieval_query: "synthetic delivery check",
        retrieval_backend: "fixture",
        retrieval_evidence_policy: "legacy",
        retrieved_chunks: legacyHits,
        agent_context_packets: [{
          source_path: "src/source-5.py",
          role: "implementation",
          inspection_order: 1,
          score: 1,
          reasons: ["synthetic fixture"],
          line_ranges: ["50-51"],
        }],
        citations: legacyHits.map((hit) => `${hit.metadata.source_path}:${hit.metadata.start_line}-${hit.metadata.end_line}`),
      },
      context: { workspace_id: "fixture-delivery", collection: "fixture", index: { manifest_revision: 1 } },
    }), "utf8");
    const legacyOutputs = [];
    for (const server of [SERVER_BIN, WRAPPER_BIN]) {
      const child = spawn("node", [server], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...globalThis.process.env,
          CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
          CORPUSWIRE_SDK_PATH: sdkPath,
          CORPUSWIRE_SYNC_ENABLED: "false",
          CORPUSWIRE_WORKSPACE_ID: "fixture-delivery",
          MOCK_QUERY_FIXTURE_PATH: fixturePath,
          MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl"),
        },
      });
      const rpc = createRpc(child);
      try {
        const response = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
          name: "corpuswire_search",
          arguments: { query: "synthetic delivery check", workspaceId: "fixture-delivery", topK: 5, maxChars: 200 },
        } });
        assert.equal(response.result.isError, false);
        legacyOutputs.push(response.result.content[0].text);
      } finally {
        child.kill();
      }
    }
    assert.equal(legacyOutputs[0], legacyOutputs[1]);
    assert.equal(
      createHash("sha256").update(legacyOutputs[0], "utf8").digest("hex"),
      "515d349f792e892a04cec0b8923785f8faf27109d90148ad4df82b46f73d07cc",
    );

    const unicodeHits = [{
      chunk_id: "unicode-boundary",
      score: 1,
      text: `${"x".repeat(185)}😀${"y".repeat(20)}`,
      metadata: { source_path: "src/unicode.py", start_line: 1, end_line: 2 },
    }];
    await writeFile(fixturePath, JSON.stringify({
      result: {
        retrieval_query: "synthetic unicode boundary",
        retrieval_backend: "fixture",
        retrieval_evidence_policy: "generic-v2",
        retrieved_chunks: unicodeHits,
        agent_context_packets: [{
          source_path: "src/unicode.py",
          role: "implementation",
          inspection_order: 1,
          score: 1,
          reasons: ["synthetic fixture"],
          line_ranges: ["1-2"],
        }],
        citations: ["src/unicode.py:1-2"],
      },
      context: { workspace_id: "fixture-delivery", collection: "fixture", index: { manifest_revision: 1 } },
    }), "utf8");
    for (const server of [SERVER_BIN, WRAPPER_BIN]) {
      const child = spawn("node", [server], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...globalThis.process.env,
          CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
          CORPUSWIRE_SDK_PATH: sdkPath,
          CORPUSWIRE_SYNC_ENABLED: "false",
          CORPUSWIRE_WORKSPACE_ID: "fixture-delivery",
          MOCK_QUERY_FIXTURE_PATH: fixturePath,
          MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl"),
        },
      });
      const rpc = createRpc(child);
      try {
        const response = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
          name: "corpuswire_search",
          arguments: { query: "synthetic unicode boundary", workspaceId: "fixture-delivery", topK: 5, maxChars: 200 },
        } });
        const rendered = response.result.content[0].text;
        assert.equal(response.result.isError, false);
        assert.doesNotMatch(rendered, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
        assert.doesNotMatch(rendered, /[\uDC00-\uDFFF](?<![\uD800-\uDBFF])/);
        assert.doesNotMatch(rendered, /lines: 1-2/);
        assert.doesNotMatch(rendered, /Citations:/);
      } finally {
        child.kill();
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("generic-v2 hides unproven ranges and never clips an oversized source line", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-source-lines-"));
  try {
    const { sdkPath } = await writeMockSdk(tempDir);
    const fixturePath = path.join(tempDir, "source-lines.json");
    const scenarios = [
      {
        maxChars: 12000,
        hits: [
          (() => {
            const source = "alpha\r\nbeta\r\n";
            const hit = withDisplayProjection({
              chunk_id: "source-windows-v1-direct", score: 1, text: source,
              metadata: { source_path: "src/treatment.py", start_line: 10, end_line: 11,
                extras: { corpuswire_chunk_policy: {
                  mode: "embedding_tokens_v1", boundary_strategy: "source_windows_v1",
                } } },
            }, { text: "alpha\r\nbeta\r", sourceText: source });
            return hit;
          })(),
          (() => {
            const hit = withDisplayProjection({
              chunk_id: "source-windows-v1-stale", score: 0.5, text: "stale\n",
              metadata: { source_path: "src/stale-treatment.py", start_line: 20,
                end_line: 20, extras: { corpuswire_chunk_policy: {
                  mode: "embedding_tokens_v1", boundary_strategy: "source_windows_v1",
                } } },
            }, { text: "stale", sourceText: "stale\n" });
            hit.metadata.extras.corpuswire_display_lines.text_sha256 = "0".repeat(64);
            return hit;
          })(),
        ],
        check(rendered) {
          assert.match(rendered, /src\/treatment\.py[\s\S]*?lines: 10-11[\s\S]*?alpha/);
          assert.match(rendered, /- src\/treatment\.py:10-11/);
          assert.match(rendered, /src\/stale-treatment\.py[\s\S]*?sourceRange: unavailable/);
          assert.doesNotMatch(rendered, /- src\/stale-treatment\.py:/);
        },
      },
      {
        maxChars: 12000,
        hits: [(() => {
          const hit = withDisplayProjection({
            chunk_id: "marked-partial-line", score: 1, text: "partial excerpt",
            metadata: { source_path: "src/long.py", start_line: 42, end_line: 42 },
          }, { text: "partial excerpt with withheld remainder" });
          hit.metadata.extras.corpuswire_partial_source_line = {
            schema_version: "v1", source_line: 42, start_char: 100,
            end_char: 115, text_sha256: "a".repeat(64), line_sha256: "b".repeat(64),
          };
          return hit;
        })()],
        check(rendered) {
          assert.match(rendered, /src\/long\.py[\s\S]*?sourceRange: unavailable/);
          assert.match(rendered, /excerptStatus: partial source line/);
          assert.doesNotMatch(rendered, /- src\/long\.py:42-42/);
          assert.doesNotMatch(rendered, /   lines: 42-42/);
        },
      },
      {
        maxChars: 12000,
        policy: "legacy",
        citations: ["src/legacy-long.py#partial-source", "src/legacy-long.py#full-source",
          "src/legacy-long.py#short-source", "src/normal.py#normal-source"],
        packets: [{ source_path: "src/legacy-long.py", inspection_order: 1,
          line_ranges: ["42-42", "43-43"] },
          { source_path: "src/normal.py", inspection_order: 2, line_ranges: ["5-5"] }],
        hits: [{
          chunk_id: "legacy-marked-partial", score: 1, text: "partial excerpt",
          metadata: { source_path: "src/legacy-long.py", start_line: 42,
            end_line: 42, extras: { corpuswire_partial_source_line: {
              schema_version: "v1", source_line: 42, start_char: 100,
              end_char: 115, text_sha256: "a".repeat(64), line_sha256: "b".repeat(64),
            } } },
        }, (() => withDisplayProjection({
          chunk_id: "legacy-complete-same-path", score: 0.9, text: "complete line",
          metadata: { source_path: "src/legacy-long.py", title: "Full Source",
            start_line: 43, end_line: 43 },
        }, { text: "complete line", sourceText: "complete line\n" }))(),
        (() => withDisplayProjection({
          chunk_id: "legacy-short-same-path", score: 0.85, text: "value",
          metadata: { source_path: "src/legacy-long.py", title: "Short Source",
            start_line: 44, end_line: 44 },
        }, { text: "value = 1", sourceText: "value = 1\n" }))(), {
          chunk_id: "legacy-complete-other-path", score: 0.8, text: "other line",
          metadata: { source_path: "src/normal.py", start_line: 5, end_line: 5 },
        }],
        check(rendered) {
          assert.match(rendered, /src\/legacy-long\.py[\s\S]*?sourceRange: unavailable/);
          assert.match(rendered, /excerptStatus: partial source line/);
          assert.doesNotMatch(rendered, /   lines: 42-42/);
          assert.match(rendered, /Agent context packets:[\s\S]*?lines: 43-43/);
          assert.match(rendered, /Citations:[\s\S]*?- src\/legacy-long\.py:43-43/);
          assert.match(rendered, /- src\/normal\.py#normal-source/);
          assert.doesNotMatch(rendered, /- src\/legacy-long\.py:42-42/);
          assert.doesNotMatch(rendered, /- src\/legacy-long\.py:44-44/);
          assert.doesNotMatch(rendered, /- src\/legacy-long\.py#partial-source/);
          assert.doesNotMatch(rendered, /- src\/legacy-long\.py#short-source/);
        },
      },
      {
        maxChars: 12000,
        hits: [
          withDisplayProjection({
            chunk_id: "outer-blank-lines",
            score: 1,
            text: " \n  alpha  \n\n",
            metadata: { source_path: "src/outer.py", start_line: 10, end_line: 12 },
          }, { text: "  alpha  ", startLine: 11, endLine: 11, sourceText: " \n  alpha  \n\n" }),
          withDisplayProjection({
            chunk_id: "crlf-lines",
            score: 0.9,
            text: "one\r\ntwo\r\n",
            metadata: { source_path: "src/crlf.py", start_line: 20, end_line: 21 },
          }, { text: "one\r\ntwo\r", sourceText: "one\r\ntwo\r\n" }),
          {
            chunk_id: "wrong-range",
            score: 0.8,
            text: "gamma\ndelta",
            metadata: { source_path: "src/mismatch.py", start_line: 30, end_line: 32 },
          },
          {
            chunk_id: "unproved-single-line",
            score: 0.7,
            text: "middle of a source line",
            metadata: { source_path: "src/unproved.py", start_line: 40, end_line: 40 },
          },
          (() => {
            const hit = withDisplayProjection({
              chunk_id: "tampered-projection",
              score: 0.6,
              text: "trusted-looking line",
              metadata: { source_path: "src/tampered.py", start_line: 50, end_line: 50 },
            });
            hit.metadata.extras.corpuswire_display_lines.text_sha256 = "0".repeat(64);
            return hit;
          })(),
        ],
        check(rendered) {
          assert.match(rendered, /src\/outer\.py[\s\S]*?lines: 11-11[\s\S]*?alpha/);
          assert.match(rendered, /src\/crlf\.py[\s\S]*?lines: 20-21[\s\S]*?one\r/);
          assert.match(rendered, /src\/mismatch\.py[\s\S]*?sourceRange: unavailable[\s\S]*?gamma/);
          assert.match(rendered, /src\/unproved\.py[\s\S]*?sourceRange: unavailable/);
          assert.match(rendered, /src\/tampered\.py[\s\S]*?sourceRange: unavailable/);
          assert.match(rendered, /- src\/outer\.py:11-11/);
          assert.match(rendered, /- src\/crlf\.py:20-21/);
          assert.doesNotMatch(rendered, /- src\/mismatch\.py/);
          assert.doesNotMatch(rendered, /- src\/unproved\.py/);
          assert.doesNotMatch(rendered, /- src\/tampered\.py/);
          assert.doesNotMatch(rendered, /lines: 30-32/);
        },
      },
      {
        maxChars: 200,
        hits: [{
          chunk_id: "oversized-line",
          score: 1,
          text: "😀".repeat(120),
          metadata: { source_path: "src/oversized.py", start_line: 40, end_line: 40 },
        }],
        check(rendered) {
          assert.match(rendered, /Response truncated: 1 selected hit\(s\) clipped or omitted/);
          assert.doesNotMatch(rendered, /   lines: 40-40/);
          assert.doesNotMatch(rendered, /Citations:/);
          assert.doesNotMatch(rendered, /😀/);
        },
      },
      {
        maxChars: 12000,
        hits: [
          (() => {
            const source = "# Heading\n\nalpha beta\n";
            const hit = withDisplayProjection({
              chunk_id: "markdown-source-context", score: 1, text: "alpha beta",
              metadata: { source_path: "docs/context.md", start_line: 3, end_line: 3 },
            }, { text: "# Heading\n\nalpha beta", startLine: 1, endLine: 3, sourceText: source });
            hit.metadata.extras.corpuswire_display_lines.mapping_kind = "source-context/v1";
            hit.metadata.extras.corpuswire_display_lines.chunk_text_sha256 = createHash("sha256").update(hit.text).digest("hex");
            return hit;
          })(),
          (() => {
            const source = "ordinary code\n\nalpha beta\n";
            const hit = withDisplayProjection({
              chunk_id: "invalid-source-context", score: 0.5, text: "alpha beta",
              metadata: { source_path: "src/context.py", start_line: 3, end_line: 3 },
            }, { text: "ordinary code\n\nalpha beta", startLine: 1, endLine: 3, sourceText: source });
            hit.metadata.extras.corpuswire_display_lines.mapping_kind = "source-context/v1";
            hit.metadata.extras.corpuswire_display_lines.chunk_text_sha256 = createHash("sha256").update(hit.text).digest("hex");
            return hit;
          })(),
          (() => {
            const source = "last line\n\n";
            const hit = withDisplayProjection({
              chunk_id: "trailing-blank-context", score: 0.4, text: "last line",
              metadata: { source_path: "src/trailing.py", start_line: 1, end_line: 1 },
            }, { text: "last line\n", startLine: 1, endLine: 2, sourceText: source });
            hit.metadata.extras.corpuswire_display_lines.mapping_kind = "source-context/v1";
            hit.metadata.extras.corpuswire_display_lines.chunk_text_sha256 = createHash("sha256").update(hit.text).digest("hex");
            return hit;
          })(),
        ],
        check(rendered) {
          assert.match(rendered, /- docs\/context\.md:1-3/);
          assert.match(rendered, /- src\/trailing\.py:1-2/);
          assert.match(rendered, /# Heading/);
          assert.match(rendered, /src\/context\.py[\s\S]*?sourceRange: unavailable/);
          assert.doesNotMatch(rendered, /- src\/context\.py:/);
        },
      },
      {
        maxChars: 200,
        hits: [(() => {
          const heading = `# ${"H".repeat(190)}`;
          const hit = withDisplayProjection({
            chunk_id: "budgeted-source-context", score: 1, text: "alpha beta",
            metadata: { source_path: "docs/budget.md", start_line: 3, end_line: 3 },
          }, { text: `${heading}\n\nalpha beta`, startLine: 1, endLine: 3 });
          hit.metadata.extras.corpuswire_display_lines.mapping_kind = "source-context/v1";
          hit.metadata.extras.corpuswire_display_lines.chunk_text_sha256 = createHash("sha256").update(hit.text).digest("hex");
          return hit;
        })()],
        check(rendered) {
          assert.match(rendered, /docs\/budget\.md[\s\S]*?lines: 3-3[\s\S]*?alpha beta/);
          assert.match(rendered, /- docs\/budget\.md:3-3/);
          assert.doesNotMatch(rendered, /# H{20}/);
        },
      },
      {
        maxChars: 200,
        hits: [(() => {
          const heading = `# ${"H".repeat(190)}`;
          const hit = withDisplayProjection({
            chunk_id: "clipped-authenticated-blank", score: 1, text: "alpha beta",
            metadata: { source_path: "docs/blank-after-core.md", start_line: 2, end_line: 2 },
          }, { text: `${heading}\nalpha beta\n`, startLine: 1, endLine: 3,
            sourceText: `${heading}\nalpha beta\n\n` });
          hit.metadata.extras.corpuswire_display_lines.mapping_kind = "source-context/v1";
          hit.metadata.extras.corpuswire_display_lines.chunk_text_sha256 =
            createHash("sha256").update(hit.text).digest("hex");
          return hit;
        })()],
        check(rendered) {
          assert.match(rendered, /docs\/blank-after-core\.md[\s\S]*?lines: 2-2[\s\S]*?alpha beta/);
          assert.match(rendered, /- docs\/blank-after-core\.md:2-2/);
          assert.doesNotMatch(rendered, /- docs\/blank-after-core\.md:1-3/);
          assert.doesNotMatch(rendered, /# H{20}/);
        },
      },
      {
        maxChars: 12000,
        hits: [(() => {
          const hit = withDisplayProjection({
            chunk_id: "misplaced-chunk-text", score: 1, text: "trusted-looking line",
            metadata: { source_path: "docs/tampered.md", start_line: 3, end_line: 3 },
          }, { text: "# trusted-looking line\n\nunrelated", startLine: 1, endLine: 3 });
          hit.metadata.extras.corpuswire_display_lines.mapping_kind = "source-context/v1";
          hit.metadata.extras.corpuswire_display_lines.chunk_text_sha256 = createHash("sha256").update(hit.text).digest("hex");
          return hit;
        })()],
        check(rendered) {
          assert.match(rendered, /docs\/tampered\.md[\s\S]*?sourceRange: unavailable/);
          assert.doesNotMatch(rendered, /- docs\/tampered\.md:/);
        },
      },
    ];

    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      await writeFile(fixturePath, JSON.stringify({
        result: {
          retrieval_query: "synthetic source line check",
          retrieval_backend: "fixture",
          retrieval_evidence_policy: scenario.policy ?? "generic-v2",
          retrieved_chunks: scenario.hits,
          agent_context_packets: scenario.packets ?? [],
          citations: scenario.citations ?? scenario.hits.map((hit) =>
            `${hit.metadata.source_path}:${hit.metadata.start_line}-${hit.metadata.end_line}`),
        },
        context: { workspace_id: "fixture-delivery", collection: "fixture", index: { manifest_revision: 1 } },
      }), "utf8");
      const outputs = [];
      for (const server of [SERVER_BIN, WRAPPER_BIN]) {
        const child = spawn("node", [server], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...globalThis.process.env,
            CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
            CORPUSWIRE_SDK_PATH: sdkPath,
            CORPUSWIRE_SYNC_ENABLED: "false",
            CORPUSWIRE_WORKSPACE_ID: "fixture-delivery",
            MOCK_QUERY_FIXTURE_PATH: fixturePath,
            MOCK_REQUESTS_PATH: path.join(tempDir, `requests-${scenarioIndex}.jsonl`),
          },
        });
        const rpc = createRpc(child);
        try {
          const response = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
            name: "corpuswire_search",
            arguments: {
              query: "synthetic source line check",
              workspaceId: "fixture-delivery",
              topK: 5,
              maxChars: scenario.maxChars,
            },
          } });
          assert.equal(response.result.isError, false);
          outputs.push(response.result.content[0].text);
        } finally {
          child.kill();
        }
      }
      assert.equal(outputs[0], outputs[1]);
      scenario.check(outputs[0]);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("both Node hosts validate transformed JSON source mappings before citing", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-json-mapping-"));
  try {
    const { sdkPath } = await writeMockSdk(tempDir);
    const fixturePath = path.join(tempDir, "transformed.json");
    const ndjsonSource = '{"event":"ready","count":2}\n';
    const configSource = '{\n  "service": {"enabled": true, "port": 8080}\n}\n';
    const mapped = [
      withDisplayProjection({
        chunk_id: "json-record",
        score: 1,
        text: JSON.stringify(JSON.parse(ndjsonSource), null, 2),
        metadata: {
          source_path: "events.ndjson", symbol_kind: "data_record",
          section_heading: "record line 1", start_line: 1, end_line: 4,
        },
      }, { text: ndjsonSource.trimEnd(), startLine: 1, endLine: 1, sourceText: ndjsonSource }),
      withDisplayProjection({
        chunk_id: "json-value",
        score: 0.9,
        text: JSON.stringify(JSON.parse(configSource).service, null, 2),
        metadata: {
          source_path: "settings.json.example", symbol_kind: "config_section",
          section_heading: "service", start_line: 2, end_line: 5,
        },
      }, { text: configSource.trimEnd(), startLine: 1, endLine: 3, sourceText: configSource }),
    ];
    for (const [index, hit] of mapped.entries()) {
      const projection = hit.metadata.extras.corpuswire_display_lines;
      projection.mapping_kind = index === 0 ? "json-record/v1" : "json-top-level-value/v1";
      projection.chunk_text_sha256 = createHash("sha256").update(hit.text).digest("hex");
    }
    const tampered = structuredClone(mapped[0]);
    tampered.chunk_id = "tampered-json-record";
    tampered.metadata.source_path = "tampered.ndjson";
    tampered.metadata.extras.corpuswire_display_lines.chunk_text_sha256 = "0".repeat(64);
    await writeFile(fixturePath, JSON.stringify({
      result: {
        retrieval_query: "synthetic JSON mapping",
        retrieval_backend: "fixture",
        retrieval_evidence_policy: "generic-v2",
        retrieved_chunks: [...mapped, tampered],
        citations: ["stale:1-999"],
      },
      context: { workspace_id: "fixture-delivery", collection: "fixture", index: { manifest_revision: 1 } },
    }), "utf8");
    const outputs = [];
    for (const server of [SERVER_BIN, WRAPPER_BIN]) {
      const child = spawn("node", [server], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...globalThis.process.env,
          CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
          CORPUSWIRE_SDK_PATH: sdkPath,
          CORPUSWIRE_SYNC_ENABLED: "false",
          CORPUSWIRE_WORKSPACE_ID: "fixture-delivery",
          MOCK_QUERY_FIXTURE_PATH: fixturePath,
          MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl"),
        },
      });
      const rpc = createRpc(child);
      try {
        const response = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name: "corpuswire_search",
          arguments: { query: "synthetic JSON mapping", workspaceId: "fixture-delivery", topK: 3, maxChars: 12000 },
        } });
        assert.equal(response.result.isError, false);
        outputs.push(response.result.content[0].text);
      } finally {
        child.kill();
      }
    }
    assert.equal(outputs[0], outputs[1]);
    assert.match(outputs[0], /- events\.ndjson:1-1/);
    assert.match(outputs[0], /- settings\.json\.example:1-3/);
    assert.match(outputs[0], /tampered\.ndjson[\s\S]*?sourceRange: unavailable/);
    assert.doesNotMatch(outputs[0], /- tampered\.ndjson:/);
    assert.doesNotMatch(outputs[0], /stale:1-999/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("selected neighbors add only verified local lines and fall back on source drift", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-selected-neighbor-"));
  try {
    const { sdkPath } = await writeMockSdk(tempDir);
    const sourceRoot = path.join(tempDir, "workspace");
    const sourceDir = path.join(sourceRoot, "src");
    await mkdir(sourceDir, { recursive: true });
    const sourcePath = path.join(sourceDir, "evidence.py");
    const source = "anchor line\nrequired neighboring evidence\nend line\n";
    await writeFile(sourcePath, source, "utf8");
    const hit = withDisplayProjection({
      chunk_id: "selected-source", score: 1, text: "anchor line",
      metadata: {
        source_path: "src/evidence.py", start_line: 1, end_line: 1,
        source_generation: 1,
      },
    }, { text: "anchor line", startLine: 1, endLine: 1, sourceText: source });
    const fixturePath = path.join(tempDir, "response.json");
    await writeFile(fixturePath, JSON.stringify({
      result: {
        retrieval_query: "synthetic selected neighbor",
        retrieval_backend: "fixture",
        retrieval_evidence_policy: "generic-v2",
        retrieval_not_found: false,
        retrieved_chunks: [hit],
      },
      context: { workspace_id: "fixture-neighbor", collection: "fixture", index: { manifest_revision: 1 } },
    }), "utf8");

    for (const server of [SERVER_BIN, WRAPPER_BIN]) {
      const invoke = async (policy, id) => {
        const child = spawn("node", [server], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...globalThis.process.env,
            CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
            CORPUSWIRE_SDK_PATH: sdkPath,
            CORPUSWIRE_SYNC_ENABLED: "false",
            CORPUSWIRE_WORKSPACE_ID: "fixture-neighbor",
            CORPUSWIRE_SYNC_ROOT: sourceRoot,
            CORPUSWIRE_SELECTED_NEIGHBOR_POLICY: policy,
            MOCK_QUERY_FIXTURE_PATH: fixturePath,
            MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl"),
          },
        });
        try {
          const response = await createRpc(child)({
            jsonrpc: "2.0", id, method: "tools/call", params: {
              name: "corpuswire_search",
              arguments: {
                query: "synthetic selected neighbor", workspaceId: "fixture-neighbor",
                topK: 5, maxChars: 12000,
              },
            },
          });
          assert.equal(response.result.isError, false);
          return response.result.content[0].text;
        } finally {
          child.kill();
        }
      };
      const control = await invoke("off", 1);
      const treatment = await invoke("selected-neighbor-v1", 2);
      assert.match(control, /- src\/evidence\.py:1-1/);
      assert.doesNotMatch(control, /required neighboring evidence/);
      assert.match(treatment, /required neighboring evidence/);
      assert.match(treatment, /- src\/evidence\.py:1-3/);
      assert.doesNotMatch(treatment, new RegExp(sourceRoot));
      await writeFile(sourcePath, "changed source\n", "utf8");
      assert.equal(await invoke("selected-neighbor-v1", 3), control);
      assert.equal(await invoke("selected-neighbor-v2", 6), control);
      await rm(sourcePath);
      const external = path.join(tempDir, "external.py");
      await writeFile(external, source, "utf8");
      await symlink(external, sourcePath);
      assert.equal(await invoke("selected-neighbor-v1", 4), control);
      assert.equal(await invoke("selected-neighbor-v2", 7), control);
      await rm(sourcePath);
      await writeFile(sourcePath, "x".repeat(1024 * 1024 + 1), "utf8");
      assert.equal(await invoke("selected-neighbor-v1", 5), control);
      assert.equal(await invoke("selected-neighbor-v2", 8), control);
      await rm(sourcePath);
      await writeFile(sourcePath, source, "utf8");
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("selected-neighbor-v2 extends twenty lines with direct and wrapper byte parity", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-selected-neighbor-v2-"));
  try {
    const { sdkPath } = await writeMockSdk(tempDir);
    const sourceRoot = path.join(tempDir, "workspace");
    const sourceDir = path.join(sourceRoot, "src");
    await mkdir(sourceDir, { recursive: true });
    const lines = Array.from({ length: 50 }, (_, index) => index === 41
      ? "required evidence at line 42" : `physical-source-${String(index + 1).padStart(2, "0")}`);
    const source = `${lines.join("\n")}\n`;
    await writeFile(path.join(sourceDir, "radius.py"), source, "utf8");
    const hit = withDisplayProjection({
      chunk_id: "radius-anchor", score: 1, text: lines[24],
      metadata: {
        source_path: "src/radius.py", start_line: 25, end_line: 25,
        source_generation: 1,
      },
    }, { text: lines[24], startLine: 25, endLine: 25, sourceText: source });
    const secondSource = "other before\nother anchor\nother after";
    await writeFile(path.join(sourceDir, "other.py"), secondSource, "utf8");
    const secondHit = withDisplayProjection({
      chunk_id: "other-anchor", score: 0.8, text: "other anchor",
      metadata: {
        source_path: "src/other.py", start_line: 2, end_line: 2,
        source_generation: 7,
      },
    }, { text: "other anchor", startLine: 2, endLine: 2, sourceText: secondSource });
    const fixturePath = path.join(tempDir, "response.json");
    await writeFile(fixturePath, JSON.stringify({
      result: {
        retrieval_query: "synthetic radius question", retrieval_backend: "fixture",
        retrieval_evidence_policy: "generic-v2", retrieval_not_found: false,
        retrieved_chunks: [hit, secondHit],
      },
      context: { workspace_id: "fixture-radius", collection: "fixture",
        index: { manifest_revision: 1 } },
    }), "utf8");
    const invoke = async (server, policy) => {
      const child = spawn("node", [server], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...globalThis.process.env,
          CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
          CORPUSWIRE_SDK_PATH: sdkPath,
          CORPUSWIRE_SYNC_ENABLED: "false",
          CORPUSWIRE_WORKSPACE_ID: "fixture-radius",
          CORPUSWIRE_SYNC_ROOT: sourceRoot,
          ...(policy === "default" ? { CORPUSWIRE_SELECTED_NEIGHBOR_POLICY: undefined }
            : { CORPUSWIRE_SELECTED_NEIGHBOR_POLICY: policy }),
          MOCK_QUERY_FIXTURE_PATH: fixturePath,
          MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl"),
        },
      });
      try {
        const response = await createRpc(child)({
          jsonrpc: "2.0", id: 1, method: "tools/call", params: {
            name: "corpuswire_search",
            arguments: { query: "synthetic radius question", workspaceId: "fixture-radius",
              topK: 5, maxChars: 12000 },
          },
        });
        assert.equal(response.result.isError, false);
        return response.result.content[0].text;
      } finally {
        child.kill();
      }
    };
    const direct = {};
    for (const policy of ["off", "unknown", "selected-neighbor-v1", "selected-neighbor-v2", "default"]) {
      direct[policy] = await invoke(SERVER_BIN, policy);
      assert.equal(await invoke(WRAPPER_BIN, policy), direct[policy]);
    }
    assert.equal(direct.unknown, direct.off);
    assert.equal(direct.default, direct["selected-neighbor-v2"]);
    assert.match(direct["selected-neighbor-v1"], /src\/radius\.py:17-33/);
    assert.doesNotMatch(direct["selected-neighbor-v1"], /required evidence at line 42/);
    assert.match(direct["selected-neighbor-v2"], /src\/radius\.py:5-45/);
    assert.match(direct["selected-neighbor-v2"], /required evidence at line 42/);
    assert.doesNotMatch(direct["selected-neighbor-v2"], new RegExp(sourceRoot));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("both Node hosts default to source-verified Markdown heading prefixes with explicit rollback", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-heading-default-"));
  try {
    const { sdkPath } = await writeMockSdk(tempDir);
    const sourceRoot = path.join(tempDir, "workspace");
    await mkdir(path.join(sourceRoot, "docs"), { recursive: true });
    const lines = Array.from({ length: 60 }, (_, index) => `document line ${index + 1}`);
    lines[2] = "## Authenticated section heading";
    lines[3] = "";
    const source = `${lines.join("\n")}\n`;
    const sourcePath = path.join(sourceRoot, "docs/section.md");
    await writeFile(sourcePath, source, "utf8");
    const selected = withDisplayProjection({
      chunk_id: "heading-anchor", score: 1, text: lines[24],
      metadata: {
        source_path: "docs/section.md", start_line: 25, end_line: 25,
        source_generation: 1,
      },
    }, { text: lines[24], startLine: 25, endLine: 25, sourceText: source });
    const fixturePath = path.join(tempDir, "response.json");
    await writeFile(fixturePath, JSON.stringify({
      result: {
        retrieval_query: "synthetic section question", retrieval_backend: "fixture",
        retrieval_evidence_policy: "generic-v2", retrieval_not_found: false,
        retrieved_chunks: [selected],
      },
      context: { workspace_id: "fixture-heading", collection: "fixture",
        index: { manifest_revision: 1 } },
    }), "utf8");
    const invoke = async (server, headingPrefix, policy = undefined) => {
      const child = spawn("node", [server], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...globalThis.process.env,
          CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
          CORPUSWIRE_SDK_PATH: sdkPath,
          CORPUSWIRE_SYNC_ENABLED: "false",
          CORPUSWIRE_WORKSPACE_ID: "fixture-heading",
          CORPUSWIRE_SYNC_ROOT: sourceRoot,
          CORPUSWIRE_SELECTED_NEIGHBOR_ROOT: sourceRoot,
          CORPUSWIRE_SELECTED_NEIGHBOR_POLICY: policy,
          CORPUSWIRE_SELECTED_HEADING_PREFIX: headingPrefix,
          CORPUSWIRE_SOURCE_ROOT_COALESCING: "off",
          MOCK_QUERY_FIXTURE_PATH: fixturePath,
          MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl"),
        },
      });
      try {
        const response = await createRpc(child)({
          jsonrpc: "2.0", id: 1, method: "tools/call", params: {
            name: "corpuswire_search", arguments: {
              query: "synthetic section question", workspaceId: "fixture-heading",
              topK: 5, maxChars: 12000,
            },
          },
        });
        assert.equal(response.result.isError, false);
        return response.result.content[0].text;
      } finally {
        child.kill();
      }
    };
    const directDefault = await invoke(SERVER_BIN, undefined);
    const directRollback = await invoke(SERVER_BIN, "false");
    assert.match(directDefault, /## Authenticated section heading/);
    assert.match(directDefault, /docs\/section\.md:3-45/);
    assert.match(directRollback, /docs\/section\.md:5-45/);
    assert.doesNotMatch(directRollback, /Authenticated section heading/);
    // All lines from the prior twenty-line neighbor window remain delivered.
    for (const line of lines.slice(4, 45)) assert.ok(directDefault.includes(line));
    assert.equal(await invoke(WRAPPER_BIN, undefined), directDefault);
    assert.equal(await invoke(WRAPPER_BIN, "false"), directRollback);
    assert.equal(await invoke(SERVER_BIN, "true"), directDefault);
    assert.equal(await invoke(WRAPPER_BIN, "true"), directDefault);
    for (const server of [SERVER_BIN, WRAPPER_BIN]) {
      const v1 = await invoke(server, "true", "selected-neighbor-v1");
      assert.match(v1, /docs\/section\.md:17-33/);
      assert.doesNotMatch(v1, /Authenticated section heading/);
    }
    // The new default still fails closed when the authenticated source changes.
    const control = await invoke(SERVER_BIN, "false", "off");
    await writeFile(sourcePath, "changed Markdown bytes\n", "utf8");
    assert.equal(await invoke(SERVER_BIN, undefined), control);
    assert.equal(await invoke(WRAPPER_BIN, undefined), control);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("source-verified neighbor restores a definition line just before a selected class", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-definition-boundary-"));
  try {
    const { sdkPath } = await writeMockSdk(tempDir);
    const sourceRoot = path.join(tempDir, "workspace");
    const relativePath = "src/corpuswire/artifacts/models.py";
    const sourcePath = path.join(sourceRoot, relativePath);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    const lines = Array.from({ length: 65 }, (_, index) => `source line ${index + 1}`);
    lines[36] = "@dataclass(frozen=True, slots=True)";
    lines[37] = "class DiscoveryLimits:";
    lines[38] = "    max_files: int = 100_000";
    const source = `${lines.join("\n")}\n`;
    await writeFile(sourcePath, source, "utf8");
    const selected = withDisplayProjection({
      chunk_id: "definition-boundary", score: 1,
      text: lines.slice(37, 60).join("\n"),
      metadata: {
        source_path: relativePath, start_line: 38, end_line: 60,
        source_generation: 1,
      },
    }, {
      text: lines.slice(37, 60).join("\n"), startLine: 38, endLine: 60,
      sourceText: source,
    });
    const fixturePath = path.join(tempDir, "response.json");
    await writeFile(fixturePath, JSON.stringify({
      result: {
        retrieval_query: "synthetic definition boundary",
        retrieval_backend: "fixture",
        retrieval_evidence_policy: "generic-v2",
        retrieval_not_found: false,
        retrieved_chunks: [selected],
      },
      context: {
        workspace_id: "fixture-definition-boundary", collection: "fixture",
        index: { manifest_revision: 1 },
      },
    }), "utf8");
    const invoke = async (server, policy) => {
      const child = spawn("node", [server], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...globalThis.process.env,
          CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
          CORPUSWIRE_SDK_PATH: sdkPath,
          CORPUSWIRE_SYNC_ENABLED: "false",
          CORPUSWIRE_WORKSPACE_ID: "fixture-definition-boundary",
          CORPUSWIRE_SYNC_ROOT: sourceRoot,
          CORPUSWIRE_SELECTED_NEIGHBOR_POLICY: policy,
          MOCK_QUERY_FIXTURE_PATH: fixturePath,
          MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl"),
        },
      });
      try {
        const response = await createRpc(child)({
          jsonrpc: "2.0", id: 1, method: "tools/call", params: {
            name: "corpuswire_search",
            arguments: {
              query: "synthetic definition boundary",
              workspaceId: "fixture-definition-boundary", topK: 5, maxChars: 12000,
            },
          },
        });
        assert.equal(response.result.isError, false);
        return response.result.content[0].text;
      } finally {
        child.kill();
      }
    };
    const control = await invoke(SERVER_BIN, "off");
    assert.match(control, /src\/corpuswire\/artifacts\/models\.py:38-60/);
    assert.doesNotMatch(control, /@dataclass\(frozen=True, slots=True\)/);
    const direct = await invoke(SERVER_BIN, "selected-neighbor-v2");
    const wrapper = await invoke(WRAPPER_BIN, "selected-neighbor-v2");
    assert.equal(wrapper, direct);
    assert.match(direct, /@dataclass\(frozen=True, slots=True\)/);
    assert.match(direct, /class DiscoveryLimits:/);
    assert.match(direct, /src\/corpuswire\/artifacts\/models\.py:18-65/);
    assert.match(direct, /- src\/corpuswire\/artifacts\/models\.py:18-65/);
    await writeFile(sourcePath, "changed source\n", "utf8");
    assert.equal(await invoke(SERVER_BIN, "selected-neighbor-v2"), control);
    assert.equal(await invoke(WRAPPER_BIN, "selected-neighbor-v2"), control);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("private search telemetry records only timings and does not alter MCP results", async () => {
  const tempDir = await mkdtemp("/private/tmp/corpuswire-search-telemetry-");
  await chmod(tempDir, 0o700);
  try {
    const { sdkPath } = await writeMockSdk(tempDir);
    const sourceRoot = path.join(tempDir, "workspace");
    await mkdir(path.join(sourceRoot, "src"), { recursive: true });
    const source = "anchor line\nneighbor line\n";
    await writeFile(path.join(sourceRoot, "src", "evidence.py"), source, "utf8");
    const hit = withDisplayProjection({
      chunk_id: "selected-source", score: 1, text: "anchor line",
      metadata: {
        source_path: "src/evidence.py", start_line: 1, end_line: 1,
        source_generation: 1,
      },
    }, { text: "anchor line", startLine: 1, endLine: 1, sourceText: source });
    const fixturePath = path.join(tempDir, "fixture.json");
    await writeFile(fixturePath, JSON.stringify({
      result: {
        retrieval_query: "synthetic timing question",
        retrieval_backend: "fixture",
        retrieval_evidence_policy: "generic-v2",
        retrieval_not_found: false,
        retrieved_chunks: [hit],
      },
      context: { workspace_id: "fixture-timing", collection: "fixture", index: { manifest_revision: 1 } },
    }), "utf8");
    const eventFile = path.join(tempDir, "events.jsonl");
    await writeFile(eventFile, "", { mode: 0o600 });
    await chmod(eventFile, 0o600);
    const invoke = async (server, telemetryPath, policy) => {
      const child = spawn("node", [server], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...globalThis.process.env,
          CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
          CORPUSWIRE_SDK_PATH: sdkPath,
          CORPUSWIRE_SYNC_ENABLED: "false",
          CORPUSWIRE_WORKSPACE_ID: "fixture-timing",
          CORPUSWIRE_SYNC_ROOT: sourceRoot,
          CORPUSWIRE_SELECTED_NEIGHBOR_POLICY: policy,
          CORPUSWIRE_PRIVATE_SEARCH_TELEMETRY_PATH: telemetryPath,
          MOCK_QUERY_FIXTURE_PATH: fixturePath,
          MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl"),
        },
      });
      try {
        const response = await createRpc(child)({
          jsonrpc: "2.0", id: 1, method: "tools/call", params: {
            name: "corpuswire_search",
            arguments: {
              query: "synthetic timing question", workspaceId: "fixture-timing",
              topK: 5, maxChars: 12000,
            },
          },
        });
        assert.equal(response.result.isError, false);
        return response.result.content[0].text;
      } finally {
        child.kill();
      }
    };
    const control = await invoke(SERVER_BIN, eventFile, "off");
    const treatment = await invoke(WRAPPER_BIN, tempDir, "selected-neighbor-v1");
    assert.match(treatment, /neighbor line/);
    assert.doesNotMatch(control, /neighbor line/);
    const fileEvents = (await readFile(eventFile, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(fileEvents.length, 1);
    const directoryEvents = (await readdir(tempDir)).filter((name) =>
      /^cw-search-timing-.*\.json$/.test(name));
    assert.equal(directoryEvents.length, 1);
    const event = JSON.parse(await readFile(path.join(tempDir, directoryEvents[0]), "utf8"));
    assert.equal(fileEvents[0].treatmentProduced, false);
    assert.equal(fileEvents[0].selectedNeighborEntered, false);
    assert.equal(event.treatmentProduced, true);
    assert.equal(event.selectedNeighborEntered, true);
    for (const item of [...fileEvents, event]) {
      assert.deepEqual(Object.keys(item).sort(), [
        "backendQueryRawMs", "outcome", "schema_version", "selectedNeighborEntered",
        "selectedNeighborEntryMs", "selectedNeighborMs", "selectedNeighborProposalMs",
        "selectedNeighborSourceReadMs", "totalHandlerMs", "treatmentProduced",
      ].sort());
      assert.equal(item.schema_version, "rqt110g-search-timing/v1");
      assert.equal(item.outcome, "ok");
      assert.ok(Number.isFinite(item.totalHandlerMs) && item.totalHandlerMs >= 0);
      assert.ok(Number.isFinite(item.backendQueryRawMs) && item.backendQueryRawMs >= 0);
      assert.doesNotMatch(JSON.stringify(item), /synthetic timing question|fixture-timing|evidence\.py|anchor line/);
    }
    assert.ok(Number.isFinite(event.selectedNeighborSourceReadMs));
    assert.ok(Number.isFinite(event.selectedNeighborProposalMs));
    const saturated = `${Array.from({ length: 1000 }, () => JSON.stringify({
      schema_version: "rqt110g-search-timing/v1",
    })).join("\n")}\n`;
    await writeFile(eventFile, saturated, "utf8");
    assert.equal(await invoke(SERVER_BIN, eventFile, "off"), control);
    assert.equal(await readFile(eventFile, "utf8"), saturated);
    await chmod(tempDir, 0o755);
    assert.equal(await invoke(SERVER_BIN, tempDir, "selected-neighbor-v1"), treatment);
    assert.equal((await readdir(tempDir)).filter((name) =>
      /^cw-search-timing-.*\.json$/.test(name)).length, 1);
  } finally {
    await chmod(tempDir, 0o700).catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("generic-v2 bounds a line-aligned donor trim before reserving a short successor", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-successor-reservation-"));
  try {
    const { sdkPath } = await writeMockSdk(tempDir);
    const fixturePath = path.join(tempDir, "selected-hits.json");
    const fixture = (donorFirstLineLength) => {
      const anchorText = "a".repeat(1800);
      const donorText = `${"d".repeat(donorFirstLineLength)}\n${"e".repeat(9394 - donorFirstLineLength)}`;
      const successorText = "s".repeat(883);
      const hits = [
        {
          chunk_id: "anchor",
          score: 1,
          text: anchorText,
          metadata: { source_path: "src/anchor.py", start_line: 1, end_line: 1 },
        },
        {
          chunk_id: "donor",
          score: 0.9,
          text: donorText,
          metadata: { source_path: "src/donor.py", start_line: 10, end_line: 11 },
        },
        {
          chunk_id: "successor",
          score: 0.8,
          text: successorText,
          metadata: { source_path: "src/successor.py", start_line: 20, end_line: 20 },
        },
      ].map((hit) => withDisplayProjection(hit));
      return {
        result: {
          retrieval_query: "synthetic bounded successor reservation",
          retrieval_backend: "fixture",
          retrieval_evidence_policy: "generic-v2",
          retrieved_chunks: hits,
          citations: hits.map(
            (hit) => `${hit.metadata.source_path}:${hit.metadata.start_line}-${hit.metadata.end_line}`,
          ),
        },
        context: {
          workspace_id: "fixture-delivery",
          collection: "fixture",
          index: { manifest_revision: 1 },
        },
      };
    };

    for (const server of [SERVER_BIN, WRAPPER_BIN]) {
      await writeFile(fixturePath, JSON.stringify(fixture(9000)), "utf8");
      let child = spawn("node", [server], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...globalThis.process.env,
          CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
          CORPUSWIRE_SDK_PATH: sdkPath,
          CORPUSWIRE_SYNC_ENABLED: "false",
          CORPUSWIRE_WORKSPACE_ID: "fixture-delivery",
          MOCK_QUERY_FIXTURE_PATH: fixturePath,
          MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl"),
        },
      });
      let rpc = createRpc(child);
      try {
        const response = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name: "corpuswire_search",
          arguments: {
            query: "synthetic bounded successor reservation",
            workspaceId: "fixture-delivery",
            topK: 3,
            maxChars: 12000,
          },
        } });
        const rendered = response.result.content[0].text;
        assert.equal(response.result.isError, false);
        assert.match(rendered, /2\. src\/donor\.py[\s\S]*?lines: 10-10[\s\S]*?excerptStatus: shortened/);
        assert.match(rendered, /3\. src\/successor\.py[\s\S]*?lines: 20-20/);
        assert.doesNotMatch(rendered, /src\/donor\.py:10-11/);
        assert.match(rendered, /src\/successor\.py:20-20/);
      } finally {
        child.kill();
      }

      await writeFile(fixturePath, JSON.stringify(fixture(8000)), "utf8");
      child = spawn("node", [server], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...globalThis.process.env,
          CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
          CORPUSWIRE_SDK_PATH: sdkPath,
          CORPUSWIRE_SYNC_ENABLED: "false",
          CORPUSWIRE_WORKSPACE_ID: "fixture-delivery",
          MOCK_QUERY_FIXTURE_PATH: fixturePath,
          MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl"),
        },
      });
      rpc = createRpc(child);
      try {
        const response = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
          name: "corpuswire_search",
          arguments: {
            query: "synthetic bounded successor reservation",
            workspaceId: "fixture-delivery",
            topK: 3,
            maxChars: 12000,
          },
        } });
        const rendered = response.result.content[0].text;
        assert.equal(response.result.isError, false);
        assert.match(rendered, /2\. src\/donor\.py[\s\S]*?lines: 10-11/);
        assert.doesNotMatch(rendered, /3\. src\/successor\.py/);
        assert.match(rendered, /src\/donor\.py:10-11/);
        assert.doesNotMatch(rendered, /src\/successor\.py:20-20/);
      } finally {
        child.kill();
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("five-hit rendering preserves a short terminal source chunk within twelve thousand excerpt characters", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-terminal-reservation-"));
  try {
    const { sdkPath } = await writeMockSdk(tempDir);
    const sourceRoot = path.join(tempDir, "workspace");
    const sizedLines = (length, count, character) => {
      const contentLength = length - count + 1;
      const width = Math.floor(contentLength / count);
      const extra = contentLength % count;
      return Array.from({ length: count }, (_, index) => character.repeat(width + (index < extra ? 1 : 0)));
    };
    const head = sizedLines(5429, 97, "c");
    const tail = ["t".repeat(15), "t".repeat(15), "t".repeat(15), "t".repeat(15), "TAIL_REQUIRED_102"];
    const donor = [...sizedLines(3947, 97, "d"), ...Array(3).fill("e".repeat(75))];
    const sources = {
      "src/anchor.py": "a".repeat(673),
      "src/review.yml": "b".repeat(1840),
      "docker-compose.yml": [...head, ...tail].join("\n"),
      "scripts/check.py": donor.join("\n"),
    };
    for (const [relativePath, source] of Object.entries(sources)) {
      const sourcePath = path.join(sourceRoot, relativePath);
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, source, "utf8");
    }
    const selected = [
      ["anchor", "src/anchor.py", 1, 1, sources["src/anchor.py"]],
      ["review", "src/review.yml", 1, 1, sources["src/review.yml"]],
      ["compose-head", "docker-compose.yml", 1, 97, head.join("\n")],
      ["donor", "scripts/check.py", 1, 100, sources["scripts/check.py"]],
      ["compose-tail", "docker-compose.yml", 98, 102, tail.join("\n")],
    ].map(([id, relativePath, startLine, endLine, text]) => withDisplayProjection({
      chunk_id: id, score: 1, text,
      metadata: { source_path: relativePath, start_line: startLine,
        end_line: endLine, source_generation: 1 },
    }, { sourceText: sources[relativePath] }));
    assert.equal(selected.reduce((total, hit) => total + hit.text.length, 0), 12198);
    const fixturePath = path.join(tempDir, "response.json");
    await writeFile(fixturePath, JSON.stringify({
      result: { retrieval_query: "synthetic terminal source boundary",
        retrieval_backend: "fixture", retrieval_evidence_policy: "generic-v2",
        retrieval_not_found: false, retrieved_chunks: selected },
      context: { workspace_id: "fixture-terminal", collection: "fixture",
        index: { manifest_revision: 1 } },
    }), "utf8");
    for (const server of [SERVER_BIN, WRAPPER_BIN]) {
      for (const policy of ["off", "selected-neighbor-v2"]) {
        const child = spawn("node", [server], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...globalThis.process.env, CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
            CORPUSWIRE_SDK_PATH: sdkPath, CORPUSWIRE_SYNC_ENABLED: "false",
            CORPUSWIRE_WORKSPACE_ID: "fixture-terminal",
            CORPUSWIRE_SYNC_ROOT: sourceRoot,
            CORPUSWIRE_SELECTED_NEIGHBOR_POLICY: policy,
            MOCK_QUERY_FIXTURE_PATH: fixturePath,
            MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl") },
        });
        try {
          const response = await createRpc(child)({ jsonrpc: "2.0", id: 1,
            method: "tools/call", params: { name: "corpuswire_search",
              arguments: { query: "synthetic terminal source boundary",
                workspaceId: "fixture-terminal", topK: 5, maxChars: 12000 } } });
          assert.equal(response.result.isError, false);
          const rendered = response.result.content[0].text;
          assert.ok(rendered.includes("TAIL_REQUIRED_102"), `terminal line missing for ${server} ${policy}`);
          assert.ok(rendered.includes("docker-compose.yml:98-102"), `terminal citation missing for ${server} ${policy}`);
          assert.ok(!rendered.includes("docker-compose.yml:98-100"), `terminal citation clipped for ${server} ${policy}`);
        } finally {
          child.kill();
        }
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("opt-in per-file source coalescing preserves exact lines and falls back on source drift", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-per-file-coalescing-"));
  try {
    const { sdkPath } = await writeMockSdk(tempDir);
    const sourceRoot = path.join(tempDir, "workspace");
    const relativePath = "src/source.ts";
    const sourcePath = path.join(sourceRoot, relativePath);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    const lines = Array.from({ length: 50 }, (_, index) => `const source_${index + 1} = ${index + 1};`);
    const source = lines.join("\n") + "\n";
    await writeFile(sourcePath, source, "utf8");
    const selected = [["first", 25, 30], ["second", 30, 35]].map(([id, start, end]) =>
      withDisplayProjection({
        chunk_id: id, score: 1,
        text: lines.slice(start - 1, end).join("\n"),
        metadata: { source_path: relativePath, start_line: start,
          end_line: end, source_generation: 1, index_scope: null },
      }, { sourceText: source }));
    const fixturePath = path.join(tempDir, "response.json");
    const makeResponse = (hits, notFound = false) => ({
      result: { retrieval_query: "synthetic source boundary", retrieval_backend: "fixture",
        retrieval_evidence_policy: "generic-v2", retrieval_not_found: notFound,
        retrieved_chunks: hits },
      context: { workspace_id: "fixture-per-file", collection: "fixture",
        index: { manifest_revision: 1 } },
    });
    const render = async (server, mode) => {
      const child = spawn("node", [server], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...globalThis.process.env, CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
          CORPUSWIRE_SDK_PATH: sdkPath, CORPUSWIRE_SYNC_ENABLED: "false",
          CORPUSWIRE_WORKSPACE_ID: "fixture-per-file", CORPUSWIRE_SYNC_ROOT: sourceRoot,
          CORPUSWIRE_SELECTED_NEIGHBOR_POLICY: "selected-neighbor-v2",
          CORPUSWIRE_SOURCE_ROOT_COALESCING: mode,
          MOCK_QUERY_FIXTURE_PATH: fixturePath,
          MOCK_REQUESTS_PATH: path.join(tempDir, "requests.jsonl") },
      });
      try {
        const response = await createRpc(child)({ jsonrpc: "2.0", id: 1,
          method: "tools/call", params: { name: "corpuswire_search",
            arguments: { query: "synthetic source boundary", workspaceId: "fixture-per-file",
              topK: 5, maxChars: 12000 } } });
        assert.equal(response.result.isError, false);
        return response.result.content[0].text;
      } finally {
        child.kill();
      }
    };
    await writeFile(fixturePath, JSON.stringify(makeResponse(selected)), "utf8");
    for (const server of [SERVER_BIN, WRAPPER_BIN]) {
      const control = await render(server, "off");
      const treatment = await render(server, "per-file-v1");
      assert.match(treatment, /src\/source\.ts:1-50/);
      assert.doesNotMatch(treatment, /\n2\. src\/source\.ts/);
      assert.match(treatment, /const source_1 = 1;/);
      assert.match(treatment, /const source_50 = 50;/);
      for (const line of lines.slice(24, 35)) assert.ok(treatment.includes(line));
      assert.ok(treatment.length > control.length / 2);

      await writeFile(sourcePath, source + "changed", "utf8");
      assert.equal(await render(server, "per-file-v1"), await render(server, "off"));
      await writeFile(sourcePath, source, "utf8");
      const withoutHash = structuredClone(selected);
      delete withoutHash[0].metadata.source_hash;
      await writeFile(fixturePath, JSON.stringify(makeResponse(withoutHash)), "utf8");
      assert.equal(await render(server, "per-file-v1"), await render(server, "off"));
      await writeFile(fixturePath, JSON.stringify(makeResponse(selected)), "utf8");
      await writeFile(fixturePath, JSON.stringify(makeResponse(selected, true)), "utf8");
      const negativeTreatment = await render(server, "per-file-v1");
      const negativeControl = await render(server, "off");
      assert.equal(negativeTreatment.split("\nDiagnostics:\n")[0],
        negativeControl.split("\nDiagnostics:\n")[0]);
      await writeFile(fixturePath, JSON.stringify(makeResponse(selected)), "utf8");
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp exposes review context and Codebase status with complete provenance", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-review-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_SDK_PATH: sdkPath,
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const tools = await rpc({ jsonrpc: "2.0", id: 20, method: "tools/list", params: {} });
      for (const name of ["corpuswire_review_context", "corpuswire_codebase_status"]) {
        const tool = tools.result.tools.find((candidate) => candidate.name === name);
        assert.ok(tool);
        assert.equal(tool.inputSchema.additionalProperties, false);
      }
      const reviewTool = tools.result.tools.find(
        (tool) => tool.name === "corpuswire_review_context",
      );
      const checkedSchema = JSON.parse(await readFile(REVIEW_SCHEMA_PATH, "utf8"));
      assertReviewToolSchemaParity(reviewTool.inputSchema, checkedSchema.$defs);

      const review = await rpc({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "corpuswire_review_context",
          arguments: {
            codebaseId: "codebase-1",
            targetRepositoryId: "repo-kotlin",
            providerReviewId: "42",
            expectedHeadSha: null,
            objective: "Find affected implementations",
            strictFreshness: true,
            budgets: { graphHops: 2, evidenceItems: 20, waitMs: 0 },
            outputCharacterLimit: 4000,
            timeoutMs: 5000,
            pollIntervalMs: 0,
          },
        },
      });
      assert.equal(review.result.isError, false);
      assert.match(review.result.content[0].text, /repository: repo-kotlin/);
      assert.match(review.result.content[0].text, /revision: 2222222222222222222222222222222222222222/);
      assert.match(review.result.content[0].text, /relationship: IMPLEMENTS:/);
      assert.match(review.result.content[0].text, /provenance: scip-java@1.0 tier=scip/);
      assert.match(review.result.content[0].text, /freshness: exact/);
      assert.match(review.result.content[0].text, /selectionReason: direct-implementation/);
      assert.ok(review.result.content[0].text.length <= 4000);

      const status = await rpc({
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "corpuswire_codebase_status",
          arguments: { codebaseId: "codebase-1", reviewId: "42" },
        },
      });
      assert.equal(status.result.isError, false);
      assert.match(status.result.content[0].text, /repositorySelection: all/);
      assert.match(status.result.content[0].text, /repo-kotlin github:repository-42 state=active/);
      assert.match(status.result.content[0].text, /analyzers: java, kotlin/);
      assert.match(status.result.content[0].text, /Review status:/);
      assert.match(status.result.content[0].text, /overlay-1@4/);
    } finally {
      child.kill();
    }

    const requests = (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const reviewRequest = requests.find((request) => request.kind === "requestReviewContextAndWait");
    assert.deepEqual(reviewRequest, {
      kind: "requestReviewContextAndWait",
      request: {
        codebaseId: "codebase-1",
        targetRepositoryId: "repo-kotlin",
        providerReviewId: "42",
        expectedHeadSha: null,
        objective: "Find affected implementations",
        strictFreshness: true,
        budgets: { graphHops: 2, evidenceItems: 20, waitMs: 0 },
        outputCharacterLimit: 4000,
      },
      options: { timeoutMs: 5000, pollIntervalMs: 0 },
    });
    assert.deepEqual(
      requests.filter((request) => request.kind !== "requestReviewContextAndWait")
        .map((request) => request.kind)
        .sort(),
      [
        "getCodebase",
        "getReviewContextCapabilities",
        "getReviewStatus",
        "listCodebaseRepositories",
      ],
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp exposes isolated v2 review context and never splits atomic BASE/HEAD evidence", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-review-v2-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_SDK_PATH: sdkPath,
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);
    try {
      const tools = await rpc({ jsonrpc: "2.0", id: 30, method: "tools/list", params: {} });
      const v1Tool = tools.result.tools.find((tool) => tool.name === "corpuswire_review_context");
      const v2Tool = tools.result.tools.find((tool) => tool.name === "corpuswire_review_context_v2");
      assert.ok(v1Tool);
      assert.ok(v2Tool);
      const v1Schema = JSON.parse(await readFile(REVIEW_SCHEMA_PATH, "utf8"));
      const v2Schema = JSON.parse(await readFile(REVIEW_V2_SCHEMA_PATH, "utf8"));
      assertReviewToolSchemaParity(v1Tool.inputSchema, v1Schema.$defs);
      assertReviewToolSchemaParityV2(v2Tool.inputSchema, v2Schema.$defs);

      const sufficient = await rpc({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "corpuswire_review_context_v2",
          arguments: {
            codebaseId: "codebase-1",
            targetRepositoryId: "repo-kotlin",
            providerReviewId: "42",
            expectedHeadSha: null,
            objective: "Compare exact BASE and HEAD symbols",
            budgets: {
              graphHops: 1,
              evidenceItems: 20,
              serializedCharacters: 100000,
              serializedUtf8Bytes: 100000,
              waitMs: 0,
            },
            outputCharacterLimit: 100000,
            timeoutMs: 5000,
            pollIntervalMs: 0,
          },
        },
      });
      assert.equal(sufficient.result.isError, false);
      const sufficientText = sufficient.result.content[0].text;
      assert.match(sufficientText, /CorpusWire deterministic symbol-change evidence v2/);
      assert.match(sufficientText, /BASE_EXACT_SYMBOL_BODY/);
      assert.match(sufficientText, /HEAD_EXACT_SYMBOL_BODY/);
      assert.match(sufficientText, /each serialized bundle is atomic/);
      assert.match(sufficientText, /language-model conclusions remain probabilistic/);
      assert.match(sufficientText, /repositorySelectionDigest: 9{64}/);
      assert.match(sufficientText, /baseBuild: snapshot-artifacts\/v2/);
      assert.match(sufficientText, /overlayBuild: review-artifacts\/v2/);
      assert.match(sufficientText, /normalizedDiffHash: 6{64}/);
      assert.match(sufficientText, /serializedCounts: tokens=18 characters=100 utf8Bytes=100/);

      const exactBoundary = await rpc({
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: {
          name: "corpuswire_review_context_v2",
          arguments: {
            codebaseId: "codebase-1",
            targetRepositoryId: "repo-kotlin",
            providerReviewId: "42",
            objective: "Compare exact BASE and HEAD symbols",
            outputCharacterLimit: sufficientText.length,
          },
        },
      });
      assert.equal(exactBoundary.result.isError, false);
      assert.match(exactBoundary.result.content[0].text, /BASE_EXACT_SYMBOL_BODY/);
      assert.match(exactBoundary.result.content[0].text, /HEAD_EXACT_SYMBOL_BODY/);
      assert.equal(exactBoundary.result.content[0].text.length, sufficientText.length);

      const constrained = await rpc({
        jsonrpc: "2.0",
        id: 33,
        method: "tools/call",
        params: {
          name: "corpuswire_review_context_v2",
          arguments: {
            codebaseId: "codebase-1",
            targetRepositoryId: "repo-kotlin",
            providerReviewId: "42",
            objective: "Compare exact BASE and HEAD symbols",
            outputCharacterLimit: sufficientText.length - 1,
          },
        },
      });
      assert.equal(constrained.result.isError, false);
      const constrainedText = constrained.result.content[0].text;
      assert.doesNotMatch(constrainedText, /BASE_EXACT_SYMBOL_BODY/);
      assert.doesNotMatch(constrainedText, /HEAD_EXACT_SYMBOL_BODY/);
      assert.match(constrainedText, /mcpOmittedBundles: 1|omission summary item/);
      assert.ok(constrainedText.length <= sufficientText.length - 1);

      const multipleFull = await rpc({
        jsonrpc: "2.0",
        id: 34,
        method: "tools/call",
        params: {
          name: "corpuswire_review_context_v2",
          arguments: {
            codebaseId: "codebase-1",
            targetRepositoryId: "repo-kotlin",
            providerReviewId: "42",
            objective: "Compare multiple symbols with simultaneous omissions",
            outputCharacterLimit: 100000,
          },
        },
      });
      const multipleFullText = multipleFull.result.content[0].text;
      assert.match(multipleFullText, /BASE_EXACT_SYMBOL_BODY/);
      assert.match(multipleFullText, /HEAD_EXACT_SYMBOL_BODY/);
      assert.match(multipleFullText, /BASE_UNICODE_Δ😀/u);
      assert.match(multipleFullText, /HEAD_UNICODE_Δ😀/u);
      assert.match(multipleFullText, /"change_id":"server-omitted-change"/);
      assert.match(multipleFullText, /"minimum_required_budget":\{"schema_version":"review-context\/v2","evidence_items":2,"tokens":123,"characters":456,"utf8_bytes":789\}/);
      assert.match(multipleFullText, /"model_evidence_available":false/);

      const multipleConstrained = await rpc({
        jsonrpc: "2.0",
        id: 35,
        method: "tools/call",
        params: {
          name: "corpuswire_review_context_v2",
          arguments: {
            codebaseId: "codebase-1",
            targetRepositoryId: "repo-kotlin",
            providerReviewId: "42",
            objective: "Compare multiple symbols with simultaneous omissions",
            outputCharacterLimit: multipleFullText.length - 1,
          },
        },
      });
      const multipleConstrainedText = multipleConstrained.result.content[0].text;
      assert.match(multipleConstrainedText, /BASE_EXACT_SYMBOL_BODY/);
      assert.match(multipleConstrainedText, /HEAD_EXACT_SYMBOL_BODY/);
      assert.doesNotMatch(multipleConstrainedText, /BASE_UNICODE_Δ😀/u);
      assert.doesNotMatch(multipleConstrainedText, /HEAD_UNICODE_Δ😀/u);
      assert.match(multipleConstrainedText, /"change_id":"server-omitted-change"/);
      assert.match(multipleConstrainedText, /"reason":"mcp_output_character_limit"/);

      for (const [id, objective, expected] of [
        [36, "missing collections", /malformed v2 atomic bundle evidence/],
        [37, "malformed bundle", /malformed v2 atomic bundle evidence/],
        [38, "malformed omission", /malformed v2 omission metadata/],
        [40, "half pair", /malformed v2 atomic bundle evidence/],
        [41, "mismatched instance", /malformed v2 atomic bundle evidence/],
        [42, "unknown change kind", /malformed v2 atomic bundle evidence/],
        [43, "unknown pairing status", /malformed v2 atomic bundle evidence/],
        [45, "unknown continuity status", /malformed v2 atomic bundle evidence/],
        [44, "unknown delta status", /malformed v2 atomic bundle evidence/],
      ]) {
        const malformed = await rpc({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "corpuswire_review_context_v2",
            arguments: {
              codebaseId: "codebase-1",
              targetRepositoryId: "repo-kotlin",
              providerReviewId: "42",
              objective,
            },
          },
        });
        assert.equal(malformed.result.isError, true);
        assert.match(malformed.result.content[0].text, expected);
        assert.doesNotMatch(malformed.result.content[0].text, /EXACT_SYMBOL_BODY/);
      }

      const futureJob = await rpc({
        jsonrpc: "2.0",
        id: 39,
        method: "tools/call",
        params: {
          name: "corpuswire_review_context_v2",
          arguments: {
            codebaseId: "codebase-1",
            targetRepositoryId: "repo-kotlin",
            providerReviewId: "42",
            objective: "future contract",
            waitForCompletion: false,
          },
        },
      });
      assert.equal(futureJob.result.isError, true);
      assert.match(futureJob.result.content[0].text, /unsupported v2 job contract/);

      for (const [id, state] of [
        [45, "succeeded"],
        [46, "partial"],
        [47, "failed"],
        [48, "cancelled"],
        [49, "superseded"],
      ]) {
        const terminal = await rpc({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "corpuswire_review_context_v2",
            arguments: {
              codebaseId: "codebase-1",
              targetRepositoryId: "repo-kotlin",
              providerReviewId: "42",
              objective: `job ${state}`,
              waitForCompletion: false,
              outputCharacterLimit: 1000,
            },
          },
        });
        assert.equal(terminal.result.isError, false);
        assert.match(terminal.result.content[0].text, new RegExp(`state: ${state}`));
        assert.match(
          terminal.result.content[0].text,
          state === "succeeded" ? /partialReasons: none/ : new RegExp(`job_${state}_reason`),
        );
      }

      const maximumIdentifiers = await rpc({
        jsonrpc: "2.0",
        id: 50,
        method: "tools/call",
        params: {
          name: "corpuswire_review_context_v2",
          arguments: {
            codebaseId: "codebase-1",
            targetRepositoryId: "repo-kotlin",
            providerReviewId: "42",
            objective: "job failed max ids",
            waitForCompletion: false,
            outputCharacterLimit: 256,
          },
        },
      });
      assert.equal(maximumIdentifiers.result.isError, false);
      assert.match(maximumIdentifiers.result.content[0].text, /state: failed/);
      assert.match(maximumIdentifiers.result.content[0].text, /job_failed_reason/);

      const minimumLimit = await rpc({
        jsonrpc: "2.0",
        id: 51,
        method: "tools/call",
        params: {
          name: "corpuswire_review_context_v2",
          arguments: {
            codebaseId: "codebase-1",
            targetRepositoryId: "repo-kotlin",
            providerReviewId: "42",
            objective: "Compare exact BASE and HEAD symbols",
            outputCharacterLimit: 256,
          },
        },
      });
      assert.equal(minimumLimit.result.isError, true);
      assert.match(minimumLimit.result.content[0].text, /too small for mandatory v2 omission metadata; required=/);
      assert.doesNotMatch(minimumLimit.result.content[0].text, /EXACT_SYMBOL_BODY/);
      const requiredLimit = Number(
        minimumLimit.result.content[0].text.match(/required=(\d+)/)?.[1],
      );
      assert.ok(Number.isInteger(requiredLimit) && requiredLimit > 256);
      const exactMinimum = await rpc({
        jsonrpc: "2.0", id: 54, method: "tools/call",
        params: { name: "corpuswire_review_context_v2", arguments: {
          codebaseId: "codebase-1", targetRepositoryId: "repo-kotlin",
          providerReviewId: "42", objective: "Compare exact BASE and HEAD symbols",
          outputCharacterLimit: requiredLimit,
        } },
      });
      assert.equal(exactMinimum.result.isError, false);
      assert.equal(exactMinimum.result.content[0].text.length, requiredLimit);
      assert.match(exactMinimum.result.content[0].text, /"schema_version":"review-context\/v2"/);
      assert.match(exactMinimum.result.content[0].text, /"change_kind":"modified"/);
      assert.match(exactMinimum.result.content[0].text, /"pairing_status":"exact_symbol_id"/);
      assert.match(exactMinimum.result.content[0].text, /"omitted_sides":\["base","head"\]/);
      assert.match(exactMinimum.result.content[0].text, /"minimum_required_budget":null/);
      assert.match(exactMinimum.result.content[0].text, /"model_evidence_available":false/);
      const belowMinimum = await rpc({
        jsonrpc: "2.0", id: 55, method: "tools/call",
        params: { name: "corpuswire_review_context_v2", arguments: {
          codebaseId: "codebase-1", targetRepositoryId: "repo-kotlin",
          providerReviewId: "42", objective: "Compare exact BASE and HEAD symbols",
          outputCharacterLimit: requiredLimit - 1,
        } },
      });
      assert.equal(belowMinimum.result.isError, true);
      assert.match(belowMinimum.result.content[0].text, new RegExp(`required=${requiredLimit}`));

      const httpFailure = await rpc({
        jsonrpc: "2.0",
        id: 53,
        method: "tools/call",
        params: {
          name: "corpuswire_review_context_v2",
          arguments: {
            codebaseId: "codebase-1",
            targetRepositoryId: "repo-kotlin",
            providerReviewId: "42",
            objective: "http error",
          },
        },
      });
      assert.equal(httpFailure.result.isError, true);
      assert.match(httpFailure.result.content[0].text, /errorCode=review_reads_disabled/);
      assert.match(httpFailure.result.content[0].text, /requestId=request-http-v2/);
      assert.match(httpFailure.result.content[0].text, /retryable=true/);
      assert.match(httpFailure.result.content[0].text, /retryAfterSeconds=7/);
      assert.match(httpFailure.result.content[0].text, /Recovery guidance: Retry after rollout enablement\./);

      const scaleStarted = performance.now();
      const scale = await rpc({
        jsonrpc: "2.0",
        id: 52,
        method: "tools/call",
        params: {
          name: "corpuswire_review_context_v2",
          arguments: {
            codebaseId: "codebase-1",
            targetRepositoryId: "repo-kotlin",
            providerReviewId: "42",
            objective: "scale 200",
            outputCharacterLimit: 2_000_000,
          },
        },
      });
      const scaleDurationMs = performance.now() - scaleStarted;
      assert.equal(scale.result.isError, false);
      assert.match(scale.result.content[0].text, /scale-change-199/);
      assert.ok(scaleDurationMs < 2_000, `200-bundle formatting took ${scaleDurationMs}ms`);
    } finally {
      child.kill();
    }

    const requests = (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const v2Requests = requests.filter((request) => request.kind === "requestReviewContextV2AndWait");
    assert.equal(v2Requests.length, 19);
    assert.deepEqual(v2Requests[0].request.budgets, {
      graphHops: 1,
      evidenceItems: 20,
      serializedCharacters: 100000,
      serializedUtf8Bytes: 100000,
      waitMs: 0,
    });
    assert.equal(Object.hasOwn(v2Requests[0].request, "outputCharacterLimit"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("v2 MCP admission uses one append-only pass with no middle-array removals", async () => {
  const source = await readFile(SERVER_BIN, "utf8");
  const admission = source.slice(
    source.indexOf("function formatReviewContextResultV2"),
    source.indexOf("function formatReviewContextV2BundleBlock"),
  );
  assert.match(admission, /const admittedMask = new Uint8Array\(bundles\.length\)/);
  assert.doesNotMatch(admission, /\.indexOf\(|\.splice\(/);
  assert.equal((admission.match(/for \(let index = 0; index < bundles\.length/g) ?? []).length, 1);
});

test("vendored SDK rejects skeletal current-v2 evidence before MCP rendering", async () => {
  const sdk = await import(VENDORED_SDK_INDEX.href);
  assert.throws(
    () => sdk.assertReviewContextV2Result({
      schema_version: "review-context/v2",
      request_id: "request-v2",
      bundles: [{
        schema_version: "review-context/v2",
        change_record: { schema_version: "review-context/v2" },
      }],
      omitted_bundles: [],
    }),
    /Malformed review response v2 response contract/,
  );
});

function assertReviewToolSchemaParity(toolSchema, definitions) {
  const requestSchema = definitions.ReviewContextRequestV1;
  const requestFields = {
    codebase_id: "codebaseId",
    target_repository_id: "targetRepositoryId",
    provider_review_id: "providerReviewId",
    expected_head_sha: "expectedHeadSha",
    objective: "objective",
    strict_freshness: "strictFreshness",
    budgets: "budgets",
    output_character_limit: "outputCharacterLimit",
  };
  const controlFields = new Set(["waitForCompletion", "timeoutMs", "pollIntervalMs"]);
  const domainFields = Object.keys(toolSchema.properties)
    .filter((name) => !controlFields.has(name))
    .sort();
  assert.deepEqual(domainFields, Object.values(requestFields).sort());
  assert.deepEqual(
    [...toolSchema.required].sort(),
    requestSchema.required.map((name) => requestFields[name]).sort(),
  );

  for (const [wireName, toolName] of Object.entries(requestFields)) {
    if (wireName === "budgets") continue;
    assertSchemaBoundsEqual(
      toolSchema.properties[toolName],
      requestSchema.properties[wireName],
    );
  }

  const budgetFields = {
    graph_hops: "graphHops",
    candidate_repositories: "candidateRepositories",
    pre_rank_candidates: "preRankCandidates",
    evidence_items: "evidenceItems",
    serialized_tokens: "serializedTokens",
    wait_ms: "waitMs",
  };
  const budgetSchema = definitions.ReviewBudgetsV1;
  const toolBudgets = toolSchema.properties.budgets;
  assert.equal(toolBudgets.additionalProperties, false);
  assert.deepEqual(Object.keys(toolBudgets.properties).sort(), Object.values(budgetFields).sort());
  for (const [wireName, toolName] of Object.entries(budgetFields)) {
    assertSchemaBoundsEqual(toolBudgets.properties[toolName], budgetSchema.properties[wireName]);
  }
}

function assertReviewToolSchemaParityV2(toolSchema, definitions) {
  const requestSchema = definitions.ReviewContextRequestV2;
  const requestFields = {
    codebase_id: "codebaseId",
    target_repository_id: "targetRepositoryId",
    provider_review_id: "providerReviewId",
    expected_head_sha: "expectedHeadSha",
    objective: "objective",
    strict_freshness: "strictFreshness",
    budgets: "budgets",
  };
  const controlFields = new Set([
    "outputCharacterLimit",
    "waitForCompletion",
    "timeoutMs",
    "pollIntervalMs",
  ]);
  assert.deepEqual(
    Object.keys(toolSchema.properties).filter((name) => !controlFields.has(name)).sort(),
    Object.values(requestFields).sort(),
  );
  assert.deepEqual(
    [...toolSchema.required].sort(),
    requestSchema.required.map((name) => requestFields[name]).sort(),
  );
  for (const [wireName, toolName] of Object.entries(requestFields)) {
    if (wireName === "budgets") continue;
    assertSchemaBoundsEqual(toolSchema.properties[toolName], requestSchema.properties[wireName]);
  }
  const budgetFields = {
    graph_hops: "graphHops",
    candidate_repositories: "candidateRepositories",
    pre_rank_candidates: "preRankCandidates",
    evidence_items: "evidenceItems",
    serialized_tokens: "serializedTokens",
    serialized_characters: "serializedCharacters",
    serialized_utf8_bytes: "serializedUtf8Bytes",
    wait_ms: "waitMs",
  };
  const toolBudgets = toolSchema.properties.budgets;
  const budgetSchema = definitions.ReviewBudgetsV2;
  assert.equal(toolBudgets.additionalProperties, false);
  assert.deepEqual(Object.keys(toolBudgets.properties).sort(), Object.values(budgetFields).sort());
  for (const [wireName, toolName] of Object.entries(budgetFields)) {
    assertSchemaBoundsEqual(toolBudgets.properties[toolName], budgetSchema.properties[wireName]);
  }
}

function assertSchemaBoundsEqual(actual, authoritative) {
  for (const keyword of [
    "type",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "default",
  ]) {
    if (!(keyword in authoritative) || authoritative[keyword] === null) continue;
    assert.deepEqual(actual[keyword], authoritative[keyword]);
  }
  if (Array.isArray(authoritative.anyOf)) {
    const nonNull = authoritative.anyOf.find((candidate) => candidate.type !== "null");
    const acceptsNull = authoritative.anyOf.some((candidate) => candidate.type === "null");
    assert.ok(nonNull);
    assert.equal(acceptsNull, true);
    assert.deepEqual(actual.type, [nonNull.type, "null"]);
    assertSchemaBoundsEqual({ ...actual, type: nonNull.type }, nonNull);
  }
}

test("corpuswire-mcp passes bearer authentication to the SDK", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const clientOptionsPath = path.join(tempDir, "client-options.jsonl");
    await writeFile(clientOptionsPath, "", "utf8");
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_BEARER_TOKEN: "scoped-test-token",
        CORPUSWIRE_BASIC_AUTH: "",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_WORKSPACE_ID: "workspace-from-env",
        MOCK_CLIENT_OPTIONS_PATH: clientOptionsPath,
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const search = await rpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "corpuswire_search",
          arguments: { query: "bearer authentication" },
        },
      });
      assert.equal(search.result.isError, false);
    } finally {
      child.kill();
    }

    const options = (await readFile(clientOptionsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(options, [
      {
        basicAuth: "",
        bearerToken: "scoped-test-token",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp rejects conflicting authentication methods", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-"));
  try {
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_BEARER_TOKEN: "scoped-test-token",
        CORPUSWIRE_BASIC_AUTH: "user:pass",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_WORKSPACE_ID: "workspace-from-env",
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);

    try {
      const search = await rpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "corpuswire_search",
          arguments: { query: "conflicting authentication" },
        },
      });
      assert.equal(search.result.isError, true);
      assert.match(
        search.result.content[0].text,
        /Configure only one of CORPUSWIRE_BASIC_AUTH or CORPUSWIRE_BEARER_TOKEN/,
      );
    } finally {
      child.kill();
    }
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
            workType: "review_context",
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
          arguments: { workType: "review_context", days: 14 },
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
    assert.equal(requests[0].workType, "review_context");
    assert.deepEqual(requests[1], {
      kind: "reviewQuality",
      workType: "review_context",
      days: 14,
    });
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
    await writeFile(path.join(tempDir, "main.tf"), "resource \"null_resource\" \"main\" {}\n", "utf8");
    await writeFile(path.join(tempDir, "mvnw"), "#!/bin/sh\n", "utf8");
    await mkdir(path.join(tempDir, ".tmp-context-engine"));
    await writeFile(path.join(tempDir, ".tmp-context-engine", "hidden.tf"), "hidden = true\n", "utf8");
    await mkdir(path.join(tempDir, ".vscode"));
    await writeFile(
      path.join(tempDir, ".vscode", "mcp.json.example"),
      '{"servers":{"corpuswire":{"command":"node"}}}\n',
      "utf8",
    );
    await writeFile(
      path.join(tempDir, ".vscode", "mcp.json"),
      '{"servers":{"private":{}}}\n',
      "utf8",
    );
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
        CORPUSWIRE_INDEX_OBSERVABILITY_ENABLED: "true",
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
          _meta: { progressToken: "reconcile-progress-1" },
          arguments: {
            includeGlobs: ["README.md", "*.kt", "*.kts", "*.scala", "*.tf", "mvnw", "**/*.json"],
            maxFiles: 10,
            maxWaitMs: 10000,
            recreateCollection: true,
          },
        },
      });

      assert.equal(reconcile.result.isError, false);
      assert.match(reconcile.result.content[0].text, /reconcileRan: true/);
      assert.match(reconcile.result.content[0].text, /Reconciliation summary:/);
      assert.match(reconcile.result.content[0].text, /observability: index-observability\/v1/);
      assert.match(reconcile.result.content[0].text, /mcp_receipt=\d+ms/);
      assert.match(reconcile.result.content[0].text, /file_discovery=\d+ms/);
      assert.doesNotMatch(
        reconcile.result.content[0].text,
        /CorpusWire rebuild test|class Bridge/,
        "trace should not contain indexed file contents",
      );
      assert.ok(rpc.notifications.some((notification) => (
        notification.method === "notifications/progress"
        && notification.params.progressToken === "reconcile-progress-1"
        && notification.params.corpuswire_event?.schema_version === "index-progress/v1"
      )));
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
        files: [
          ".vscode/mcp.json.example",
          "Bridge.kt",
          "health-check.kts",
          "main.tf",
          "mvnw",
          "Reader.scala",
          "README.md",
        ],
        deletedPaths: [],
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("corpuswire-mcp caller timeout reports continued backend work and reattachment", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-timeout-"));
  try {
    await writeFile(path.join(tempDir, "README.md"), "# Synthetic timeout fixture\n", "utf8");
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
        CORPUSWIRE_SDK_PATH: sdkPath,
        CORPUSWIRE_WORKSPACE_ID: "workspace-timeout",
        CORPUSWIRE_REPO_PATH: tempDir,
        CORPUSWIRE_SYNC_ENABLED: "true",
        MOCK_INDEX_DELAY_MS: "100",
        MOCK_REQUESTS_PATH: requestsPath,
      },
    });
    const rpc = createRpc(child);
    try {
      const response = await rpc({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "corpuswire_sync_reconcile",
          arguments: { includeGlobs: ["README.md"], maxFiles: 10, maxWaitMs: 30 },
        },
      });
      assert.equal(response.result.isError, false);
      assert.match(response.result.content[0].text, /reconcileTimedOut: true/);
      assert.match(response.result.content[0].text, /backendContinues: true/);
      assert.match(response.result.content[0].text, /sessionId: session-mcp/);
      assert.match(response.result.content[0].text, /corpuswire index --attach session-mcp/);
    } finally {
      child.kill();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("sync path probe applies leading globstar, basename, and exclusion semantics", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-globs-"));
  try {
    await mkdir(path.join(tempDir, "docs"), { recursive: true });
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "README.md"), "# Root\n", "utf8");
    await writeFile(path.join(tempDir, "docs", "guide.md"), "# Guide\n", "utf8");
    await writeFile(path.join(tempDir, "docs", "README.md"), "# Nested root\n", "utf8");
    await writeFile(path.join(tempDir, "main.py"), "value = 1\n", "utf8");
    await writeFile(path.join(tempDir, "src", "main.py"), "value = 2\n", "utf8");
    await writeFile(path.join(tempDir, "skip.py"), "skip = True\n", "utf8");
    await writeFile(path.join(tempDir, "src", "skip.py"), "skip = True\n", "utf8");
    await mkdir(path.join(tempDir, "data"), { recursive: true });
    await mkdir(path.join(tempDir, "src", "data"), { recursive: true });
    await writeFile(path.join(tempDir, "data", "root.py"), "data = True\n", "utf8");
    await writeFile(path.join(tempDir, "src", "data", "nested.py"), "data = True\n", "utf8");
    await writeFile(path.join(tempDir, "notes.txt"), "not selected\n", "utf8");
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], { stdio: ["pipe", "pipe", "pipe"], env: {
      ...globalThis.process.env,
      CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
      CORPUSWIRE_SDK_PATH: sdkPath,
      CORPUSWIRE_WORKSPACE_ID: "workspace-globs",
      CORPUSWIRE_REPO_PATH: tempDir,
      CORPUSWIRE_SYNC_ENABLED: "true",
      MOCK_REQUESTS_PATH: requestsPath,
    } });
    const rpc = createRpc(child);
    try {
      const globstar = await rpc({ jsonrpc: "2.0", id: 31, method: "tools/call", params: {
        name: "corpuswire_sync_probe_paths",
        arguments: {
          paths: ["README.md", "docs/guide.md", "main.py", "src/main.py", "skip.py", "src/skip.py", "notes.txt", "reports/retrieval-failures/failure.json"],
          includeGlobs: ["**/*.md", "**/*.py", "**/*.json"],
          excludeGlobs: ["**/skip.py"],
        },
      } });
      const globstarText = globstar.result.content[0].text;
      assert.equal((globstarText.match(/pathAccepted: true/g) ?? []).length, 4);
      assert.equal((globstarText.match(/reason: exclude_filter/g) ?? []).length, 2);
      assert.equal((globstarText.match(/reason: include_filter/g) ?? []).length, 1);
      assert.match(globstarText, /reports\/retrieval-failures\/failure\.json[\s\S]*?reason: protected_diagnostic/);

      const basename = await rpc({ jsonrpc: "2.0", id: 32, method: "tools/call", params: {
        name: "corpuswire_sync_probe_paths",
        arguments: {
          paths: ["README.md", "docs/README.md", "docs/guide.md"],
          includeGlobs: ["README.md"],
        },
      } });
      const basenameText = basename.result.content[0].text;
      assert.equal((basenameText.match(/pathAccepted: true/g) ?? []).length, 2);
      assert.equal((basenameText.match(/reason: include_filter/g) ?? []).length, 1);

      const directories = await rpc({ jsonrpc: "2.0", id: 34, method: "tools/call", params: {
        name: "corpuswire_sync_probe_paths",
        arguments: {
          paths: ["main.py", "data/root.py", "src/data/nested.py"],
          includeGlobs: ["**/*.py"],
          excludeGlobs: ["**/data/**"],
        },
      } });
      const directoryText = directories.result.content[0].text;
      assert.equal((directoryText.match(/pathAccepted: true/g) ?? []).length, 1);
      assert.equal((directoryText.match(/reason: exclude_filter/g) ?? []).length, 2);
    } finally {
      child.kill();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reconcile includes root and nested files using only leading globstar patterns", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-glob-reconcile-"));
  try {
    await mkdir(path.join(tempDir, "docs"), { recursive: true });
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "README.md"), "# Root\n", "utf8");
    await writeFile(path.join(tempDir, "docs", "guide.md"), "# Guide\n", "utf8");
    await writeFile(path.join(tempDir, "main.py"), "value = 1\n", "utf8");
    await writeFile(path.join(tempDir, "src", "main.py"), "value = 2\n", "utf8");
    await writeFile(path.join(tempDir, "notes.txt"), "not selected\n", "utf8");
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], { stdio: ["pipe", "pipe", "pipe"], env: {
      ...globalThis.process.env,
      CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
      CORPUSWIRE_SDK_PATH: sdkPath,
      CORPUSWIRE_WORKSPACE_ID: "workspace-glob-reconcile",
      CORPUSWIRE_REPO_PATH: tempDir,
      CORPUSWIRE_SYNC_ENABLED: "true",
      MOCK_REQUESTS_PATH: requestsPath,
    } });
    const rpc = createRpc(child);
    try {
      const response = await rpc({ jsonrpc: "2.0", id: 35, method: "tools/call", params: {
        name: "corpuswire_sync_reconcile",
        arguments: { includeGlobs: ["**/*.md", "**/*.py"], maxFiles: 10, maxWaitMs: 5000 },
      } });
      assert.equal(response.result.isError, false);
      assert.match(response.result.content[0].text, /filesSubmitted: 4/);
    } finally {
      child.kill();
    }
    const calls = (await readFile(requestsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(
      new Set(calls.at(-1).files),
      new Set(["README.md", "docs/guide.md", "main.py", "src/main.py"]),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reconcile reports manifest rejection details and session identity", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "corpuswire-mcp-manifest-error-"));
  try {
    await writeFile(path.join(tempDir, "README.md"), "# Root\n", "utf8");
    const { sdkPath, requestsPath } = await writeMockSdk(tempDir);
    const child = spawn("node", [SERVER_BIN], { stdio: ["pipe", "pipe", "pipe"], env: {
      ...globalThis.process.env,
      CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
      CORPUSWIRE_SDK_PATH: sdkPath,
      CORPUSWIRE_WORKSPACE_ID: "workspace-manifest-error",
      CORPUSWIRE_REPO_PATH: tempDir,
      CORPUSWIRE_SYNC_ENABLED: "true",
      MOCK_MANIFEST_FAILURE: "true",
      MOCK_REQUESTS_PATH: requestsPath,
    } });
    const rpc = createRpc(child);
    try {
      const response = await rpc({ jsonrpc: "2.0", id: 33, method: "tools/call", params: {
        name: "corpuswire_sync_reconcile",
        arguments: { includeGlobs: ["**/*.md"], maxFiles: 10, maxWaitMs: 5000 },
      } });
      const output = response.result.content[0].text;
      assert.equal(response.result.isError, true);
      assert.match(output, /sessionId: session-manifest-error/);
      assert.match(output, /manifestSkipped: 1/);
      assert.match(output, /manifestErrors: line 1: invalid_inventory_entry/);
    } finally {
      child.kill();
    }
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

async function withRetrievalJournalFixture(run) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cw-private-journal-")));
  const workspace = path.join(root, "workspace");
  const journal = path.join(root, "journal");
  await mkdir(workspace);
  const { sdkPath, requestsPath } = await writeMockSdk(root);
  const children = [];
  const launch = (env = {}, server = SERVER_BIN) => {
    const child = spawn("node", [server], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"], env: {
      ...process.env, CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
      CORPUSWIRE_SDK_PATH: sdkPath, MOCK_REQUESTS_PATH: requestsPath,
      CORPUSWIRE_SYNC_ENABLED: "false", CORPUSWIRE_SYNC_ROOT: workspace,
      CORPUSWIRE_SYNC_READ_FRESHNESS_CHECK: "false", CORPUSWIRE_REPO_PATH: workspace,
      CORPUSWIRE_SELECTED_NEIGHBOR_POLICY: "off",
      CORPUSWIRE_PRIVATE_SEARCH_TELEMETRY_PATH: "",
      CORPUSWIRE_WORKSPACE_ID: "local-docker://journal-test#main",
      CORPUSWIRE_RETRIEVAL_LOG_DIR: journal, CORPUSWIRE_RETRIEVAL_LOG_MODE: "full",
      CORPUSWIRE_RETRIEVAL_LOG_MAX_INPUT_BYTES: "65536",
      CORPUSWIRE_RETRIEVAL_LOG_MAX_RESULT_BYTES: "1048576",
      CORPUSWIRE_RETRIEVAL_LOG_MAX_EVENTS: "10000",
      CORPUSWIRE_RETRIEVAL_LOG_MAX_BYTES: "268435456", ...env,
    } });
    children.push(child);
    const state = { stdout: "", stderr: "", child };
    child.stdout.on("data", (chunk) => { state.stdout += chunk; });
    child.stderr.on("data", (chunk) => { state.stderr += chunk; });
    const rpc = createRpc(child);
    state.call = (id, name = "corpuswire_search", args = { query: "retrieve routing evidence" }) =>
      rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return state;
  };
  const readEvents = async (directory = journal) => {
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    return Promise.all(names.map(async (name) => ({
      event: JSON.parse(await readFile(path.join(directory, name), "utf8")),
      info: await lstat(path.join(directory, name)),
    })));
  };
  try { await run({ root, workspace, journal, launch, readEvents }); }
  finally {
    for (const child of children) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

test("private retrieval journal captures exact delivered search and enhancement with private permissions", async () => {
  await withRetrievalJournalFixture(async ({ journal, launch, readEvents }) => {
    for (const server of [SERVER_BIN, WRAPPER_BIN]) {
      const host = launch({}, server);
      for (const [id, tool, args] of [[1, "corpuswire_search", { query: "routing evidence", topK: 3 }],
        [2, "corpuswire_enhance_prompt", { prompt: "Improve routing evidence", localOnly: true }]]) {
        const response = await host.call(id, tool, args);
        assert.equal(response.result.isError, false);
        const rows = await readEvents();
        // Match by timestamp-independent delivered bytes rather than the random event id.
        const captured = rows.filter(({ event }) => event.tool === tool && event.input.text === (args.query ?? args.prompt));
        assert.ok(captured.length >= 1);
        const saved = captured.at(-1).event;
        assert.deepEqual(JSON.parse(saved.result.text), response.result);
        assert.equal(saved.result.rawSha256, createHash("sha256").update(JSON.stringify(response.result)).digest("hex"));
        assert.equal(saved.result.storedSha256, saved.result.rawSha256);
        assert.equal(saved.workspaceId, "local-docker://journal-test#main");
        assert.match(saved.server.executableSha256, /^[a-f0-9]{64}$/);
        assert.equal(saved.server.executableHashSemantics,
          "entry_file_on_disk_at_first_capture_not_loaded_dependency_identity");
        assert.ok(saved.elapsedMs >= 0);
        assert.equal(saved.result.truncated, false);
        assert.equal(saved.backendOrigin, "http://127.0.0.1:8000");
        assert.ok(rows.every(({ info }) => (info.mode & 0o777) === 0o600 && info.nlink === 1));
      }
      const lines = host.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(lines.length, 2);
      assert.equal(host.stderr, "");
    }
    assert.equal((await lstat(journal)).mode & 0o777, 0o700);
    assert.equal((await readEvents()).length, 4);
  });
});

test("private retrieval journal disables capture and metadata omits private text", async () => {
  await withRetrievalJournalFixture(async ({ journal, launch, readEvents }) => {
    for (const env of [{ CORPUSWIRE_RETRIEVAL_LOG_DIR: "" }, { CORPUSWIRE_RETRIEVAL_LOG_MODE: "off" }]) {
      const response = await launch(env).call(1);
      assert.equal(response.result.isError, false);
      await assert.rejects(lstat(journal), { code: "ENOENT" });
    }
    const host = launch({ CORPUSWIRE_RETRIEVAL_LOG_MODE: "metadata" });
    const response = await host.call(1, "corpuswire_search", { query: "my baby has symptom private-fact" });
    assert.equal(response.result.isError, false);
    const [{ event }] = await readEvents();
    assert.equal(event.mode, "metadata");
    assert.equal(event.input.text, null);
    assert.equal(event.result.text, null);
    assert.doesNotMatch(JSON.stringify(event), /private-fact|symptom/);
    assert.match(event.input.rawSha256, /^[a-f0-9]{64}$/);
  });
});

test("private retrieval journal redacts credentials while preserving explicitly authorized health text", async () => {
  await withRetrievalJournalFixture(async ({ launch, readEvents }) => {
    const query = "my baby symptom; Bearer abc123token; Basic dXNlcjpwYXNz; token='secret with spaces'; "
      + "https://user:privatepass@example.com/path; configured-secret; "
      + "-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----";
    const host = launch({ CORPUSWIRE_BEARER_TOKEN: "configured-secret", CORPUSWIRE_BASIC_AUTH: "" });
    const response = await host.call(1, "corpuswire_search", { query });
    assert.equal(response.result.isError, false);
    const [{ event }] = await readEvents();
    assert.match(event.input.text, /my baby symptom/);
    assert.equal(event.input.redacted, true);
    const saved = JSON.stringify(event);
    assert.doesNotMatch(saved, /abc123token|dXNlcjpwYXNz|secret with spaces|privatepass|configured-secret|private material/);
    assert.match(saved, /REDACTED/);
    assert.doesNotThrow(() => JSON.parse(event.result.text));
    assert.equal(event.input.rawSha256, createHash("sha256").update(query).digest("hex"));
    assert.notEqual(event.input.storedSha256, event.input.rawSha256);
    assert.match(response.result.content[0].text, /configured-secret/);
  });
});

test("private retrieval journal errors omit unsafe exception text and cannot change MCP errors", async () => {
  await withRetrievalJournalFixture(async ({ root, launch, readEvents }) => {
    const sdkPath = path.join(root, "throw-sdk.mjs");
    await writeFile(sdkPath, 'export class CorpusWireClient { async queryRaw(){throw new Error("unsafe-error-private-material");} }');
    const host = launch({ CORPUSWIRE_SDK_PATH: sdkPath });
    const response = await host.call(1);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /unsafe-error-private-material/);
    const [{ event }] = await readEvents();
    assert.equal(event.outcome, "error");
    assert.equal(event.result.capture, "omitted_unsafe_error");
    assert.equal(event.result.text, null);
    assert.doesNotMatch(JSON.stringify(event), /unsafe-error-private-material/);
  });
});

test("private retrieval journal rejects workspace, symlink, broad permissions, and existing unsafe contents", async () => {
  await withRetrievalJournalFixture(async ({ root, workspace, journal, launch }) => {
    const outside = path.join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    const alias = path.join(root, "alias");
    await symlink(outside, alias);
    const cases = [
      { directory: path.join(workspace, "capture"), reason: "workspace_directory" },
      { directory: alias, reason: "unsafe_directory" },
      { directory: path.join(alias, "nested"), reason: "unsafe_directory" },
    ];
    await mkdir(journal, { mode: 0o755 });
    await chmod(journal, 0o755);
    cases.push({ directory: journal, reason: "unsafe_permissions" });
    for (const { directory, reason } of cases) {
      const host = launch({ CORPUSWIRE_RETRIEVAL_LOG_DIR: directory });
      const response = await host.call(1);
      assert.equal(response.result.isError, false);
      assert.match(host.stderr, new RegExp(reason));
      assert.doesNotMatch(host.stderr, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(host.stdout, /private retrieval journal|capture skipped/);
    }
    assert.deepEqual(await readdir(outside), []);
    await assert.rejects(lstat(path.join(workspace, "capture")), { code: "ENOENT" });
    await chmod(journal, 0o700);
    await symlink(path.join(root, "private-target"), path.join(journal, "cw-retrieval-malicious.json"));
    const host = launch();
    assert.equal((await host.call(2)).result.isError, false);
    assert.match(host.stderr, /unsafe_contents/);
  });
});

test("private retrieval journal bounds UTF8 bytes and shared event and disk quotas", async () => {
  await withRetrievalJournalFixture(async ({ journal, launch, readEvents }) => {
    const host = launch({ CORPUSWIRE_RETRIEVAL_LOG_MAX_INPUT_BYTES: "5",
      CORPUSWIRE_RETRIEVAL_LOG_MAX_RESULT_BYTES: "17", CORPUSWIRE_RETRIEVAL_LOG_MAX_EVENTS: "2" });
    for (let id = 1; id <= 3; id += 1) assert.equal((await host.call(id, "corpuswire_search", {
      query: "🙂🙂🙂 unicode input",
    })).result.isError, false);
    const events = await readEvents();
    assert.equal(events.length, 2);
    for (const { event } of events) {
      assert.equal(event.input.text, "🙂");
      assert.ok(Buffer.byteLength(event.input.text) <= 5);
      assert.ok(Buffer.byteLength(event.result.text) <= 17);
      assert.equal(event.input.truncated, true);
      assert.equal(event.result.truncated, true);
      assert.doesNotMatch(event.input.text, /\uFFFD/);
    }
    assert.match(host.stderr, /capacity_reached/);
    assert.equal(host.stderr.match(/capacity_reached/g).length, 1);
    const tiny = launch({ CORPUSWIRE_RETRIEVAL_LOG_MAX_BYTES: "1" });
    assert.equal((await tiny.call(4)).result.isError, false);
    assert.match(tiny.stderr, /capacity_reached/);
    assert.equal((await readEvents()).length, 2);
    assert.equal((await readdir(journal)).length, 2);
  });
});

test("private retrieval journal serializes races across independent MCP hosts", async () => {
  await withRetrievalJournalFixture(async ({ launch, readEvents }) => {
    const hosts = Array.from({ length: 5 }, () => launch({ CORPUSWIRE_RETRIEVAL_LOG_MAX_EVENTS: "3" }));
    const responses = await Promise.all(hosts.map((host, i) => host.call(i + 1)));
    assert.ok(responses.every((response) => response.result.isError === false));
    const events = await readEvents();
    assert.equal(events.length, 3);
    assert.equal(new Set(events.map(({ event }) => event.eventId)).size, 3);
    assert.ok(events.every(({ info }) => (info.mode & 0o777) === 0o600 && info.nlink === 1));
  });
});

test("private retrieval journal records effective replay defaults and bounds source filters", async () => {
  await withRetrievalJournalFixture(async ({ launch, readEvents }) => {
    const host = launch({ CORPUSWIRE_TOP_K: "8", CORPUSWIRE_MAX_SEARCH_CHARS: "16000",
      CORPUSWIRE_MIN_SCORE: "0.25", CORPUSWIRE_SELECTED_NEIGHBOR_POLICY: "selected-neighbor-v2",
      CORPUSWIRE_SELECTED_HEADING_PREFIX: "unexpected", CORPUSWIRE_LOCAL_ONLY: "false" });
    const filters = Array.from({ length: 40 }, (_, i) => `${i}-${"🙂".repeat(100)}`);
    assert.equal((await host.call(1, "corpuswire_search", { query: "replay defaults", sourceFilter: filters })).result.isError, false);
    const [{ event }] = await readEvents();
    assert.equal(event.request.topK, 8);
    assert.equal(event.request.maxChars, 16000);
    assert.equal(event.request.minScore, 0.25);
    assert.equal(event.profile.headingPrefix, false);
    assert.equal(event.profile.localOnly, false);
    assert.equal(event.profile.semantics, "configured_or_requested_not_delivery_proof");
    assert.equal(event.request.sourceFilter.length, 32);
    assert.ok(event.request.sourceFilter.every((value) => Buffer.byteLength(value) <= 256));
    assert.equal(event.request.sourceFilterTruncated, true);
    assert.equal(event.request.sourceFilterCount, 40);
  });
});

test("private retrieval journal distinguishes requested profile from applied enhancement fallback", async () => {
  await withRetrievalJournalFixture(async ({ launch, readEvents }) => {
    const host = launch({ CORPUSWIRE_OUTPUT_MODE: " copilot ", CORPUSWIRE_LOCAL_ONLY: "false",
      CORPUSWIRE_SELECTED_NEIGHBOR_POLICY: "selected-neighbor-v2", CORPUSWIRE_SOURCE_ROOT_COALESCING: "per-file-v1" });
    assert.equal((await host.call(1, "corpuswire_enhance_prompt", { prompt: "Honest fallback metadata" })).result.isError, false);
    const [{ event }] = await readEvents();
    assert.equal(event.profile.outputMode, "copilot");
    assert.equal(event.profile.localOnly, false);
    assert.equal(event.profile.selectedNeighborPolicy, "selected-neighbor-v2");
    assert.equal(event.deliveryBehavior.searchPostprocessingApplicable, false);
    assert.equal(event.deliveryBehavior.selectedNeighborChangedResult, false);
    assert.equal(event.deliveryBehavior.headingPrefixAdded, false);
    assert.equal(event.deliveryBehavior.sourceRootCoalescingChangedResult, false);
    assert.equal(event.deliveryBehavior.enhancementLocalFallback, true);
    assert.equal(event.deliveryBehavior.enhancementLocalOnlyUsed, true);
  });
});

async function writeMockSdk(tempDir) {
  const sdkPath = path.join(tempDir, "mock-sdk.mjs");
  const requestsPath = path.join(tempDir, "requests.jsonl");
  await writeFile(requestsPath, "", "utf8");
  await writeFile(
    sdkPath,
    `
import { appendFileSync, readFileSync } from "node:fs";

export function assertReviewContextV2Result(value) {
  if (!value || value.schema_version !== "review-context/v2") {
    throw new Error("invalid mock v2 result");
  }
}

export class CorpusWireClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? "http://mock-corpuswire";
    if (process.env.MOCK_MISSING_VALUE_ROLLUP === "true") {
      this.valueRollup = undefined;
    }
    if (process.env.MOCK_CLIENT_OPTIONS_PATH) {
      appendFileSync(process.env.MOCK_CLIENT_OPTIONS_PATH, JSON.stringify({
        basicAuth: options.basicAuth ?? "",
        bearerToken: options.bearerToken ?? "",
      }) + "\\n", "utf8");
    }
  }

  async queryRaw(request) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify(request) + "\\n", "utf8");
    if (process.env.MOCK_QUERY_FIXTURE_PATH) {
      return JSON.parse(readFileSync(process.env.MOCK_QUERY_FIXTURE_PATH, "utf8"));
    }
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

  async requestReviewContextAndWait(request, options = {}) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "requestReviewContextAndWait",
      request,
      options,
    }) + "\\n", "utf8");
    return {
      request_id: "request-review-1",
      telemetry_id: "telemetry-review-1",
      job_id: "job-review-1",
      review_id: request.providerReviewId,
      target_repository_id: request.targetRepositoryId,
      base_sha: "1".repeat(40),
      head_sha: "2".repeat(40),
      snapshot_id: "snapshot-1",
      snapshot_generation: 3,
      overlay_id: "overlay-1",
      overlay_generation: 4,
      freshness: "exact",
      changed_symbols: ["java:OrdersApi#getOrder"],
      related_symbols: ["kotlin:OrdersService#getOrder"],
      repository_count: 2,
      candidate_count: 1,
      serialized_token_count: 42,
      truncated: false,
      omissions: [],
      warnings: [],
      evidence: [{
        evidence_id: "evidence-1",
        repository_id: "repo-kotlin",
        revision: "2".repeat(40),
        layer: "snapshot",
        path: "src/OrdersService.kt",
        source_range: { start_line: 12, end_line: 18 },
        content_hash: "a".repeat(64),
        text: "override fun getOrder(id: String) = api.getOrder(id)",
        symbol_id: "kotlin:OrdersService#getOrder",
        relationship_path: [{
          relationship_kind: "IMPLEMENTS",
          source_symbol_id: "kotlin:OrdersService#getOrder",
          target_symbol_id: "java:OrdersApi#getOrder",
          graph_distance: 1,
        }],
        graph_distance: 1,
        provenance: {
          extractor_id: "scip-java",
          extractor_version: "1.0",
          evidence_tier: "scip",
          resolution_status: "exact",
          confidence: 0.99,
        },
        freshness: "exact",
        confidence: 0.99,
        score: { total: 10, graph: 4, freshness: 2, semantic: 1 },
        selection_reason: "direct-implementation",
      }],
    };
  }

  async requestReviewContext(request) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "requestReviewContext",
      request,
    }) + "\\n", "utf8");
    return {
      job_id: "job-review-1",
      request_id: "request-review-1",
      codebase_id: request.codebaseId,
      state: "running",
      attempts: 1,
      status_url: "/v1/review-context/jobs/job-review-1",
      retry_after_seconds: 2,
      partial_reasons: [],
    };
  }

  async requestReviewContextV2AndWait(request, options = {}) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "requestReviewContextV2AndWait",
      request,
      options,
    }) + "\\n", "utf8");
    if (request.objective.includes("http error")) {
      throw new CorpusWireHttpError();
    }
    const baseRange = {
      schema_version: "review-context/v2",
      start_line: 10,
      end_line: 12,
      start_column: 1,
      end_column: 2,
    };
    const headRange = { ...baseRange, start_line: 14, end_line: 16 };
    const response = {
      schema_version: "review-context/v2",
      request_id: "request-review-v2",
      telemetry_id: "telemetry-review-v2",
      job_id: "job-review-v2",
      review_id: request.providerReviewId,
      target_repository_id: request.targetRepositoryId,
      review_scope: {
        schema_version: "review-context/v2",
        repository_set_id: "set-v2",
        repository_selection_digest: "9".repeat(64),
      },
      base_sha: "1".repeat(40),
      head_sha: "2".repeat(40),
      base_snapshot_id: "snapshot-v2",
      base_snapshot_generation: 3,
      base_snapshot_refresh_sequence: 0,
      base_artifact_contract_version: "snapshot-artifacts/v2",
      base_snapshot_builder_version: "snapshot-builder-v2",
      base_build_policy_digest: "7".repeat(64),
      overlay_id: "overlay-v2",
      overlay_generation: 4,
      overlay_refresh_sequence: 0,
      artifact_contract_version: "review-artifacts/v2",
      evidence_builder_version: "evidence-builder-v2",
      overlay_build_policy_digest: "8".repeat(64),
      normalized_diff_hash: "6".repeat(64),
      freshness: "exact",
      partial: false,
      partial_reasons: [],
      bundles: [{
        schema_version: "review-context/v2",
        ordinal: 0,
        change_record: {
          schema_version: "review-context/v2",
          change_id: "change-v2",
          logical_identity: "logical-v2",
          change_kind: "modified",
          pairing_status: "exact_symbol_id",
          continuity_status: "proven",
          base: {
            schema_version: "review-context/v2",
            symbol_instance_id: "base-instance",
            path: "src/service.py",
            source_range: baseRange,
          },
          head: {
            schema_version: "review-context/v2",
            symbol_instance_id: "head-instance",
            path: "src/service.py",
            source_range: headRange,
          },
          normalized_hunks: [],
          relationship_deltas: [],
        },
        base_evidence: {
          schema_version: "review-context/v2",
          side: "base",
          evidence_id: "extent-base",
          symbol_instance_id: "base-instance",
          repository_id: request.targetRepositoryId,
          revision: "1".repeat(40),
          layer: "snapshot",
          path: "src/service.py",
          symbol_source_range: baseRange,
          extent_start_line: 10,
          extent_end_line: 12,
          source_content_sha256: "a".repeat(64),
          symbol_extent_sha256: "b".repeat(64),
          text: "BASE_EXACT_SYMBOL_BODY\\nline two\\nline three\\n",
          token_count: 9,
        },
        head_evidence: {
          schema_version: "review-context/v2",
          side: "head",
          evidence_id: "extent-head",
          symbol_instance_id: "head-instance",
          repository_id: request.targetRepositoryId,
          revision: "2".repeat(40),
          layer: "overlay",
          path: "src/service.py",
          symbol_source_range: headRange,
          extent_start_line: 14,
          extent_end_line: 16,
          source_content_sha256: "c".repeat(64),
          symbol_extent_sha256: "d".repeat(64),
          text: "HEAD_EXACT_SYMBOL_BODY\\nline two\\nline three\\n",
          token_count: 9,
        },
        related_evidence: [],
        completeness: {
          schema_version: "review-context/v2",
          required_sides_complete: true,
          related_evidence_complete: true,
          reason_codes: [],
        },
        evidence_item_count: 2,
        serialized_tokens: 18,
        serialized_characters: 100,
        serialized_utf8_bytes: 100,
      }],
      omitted_bundles: [],
      serialized_token_count: 18,
      serialized_character_count: 100,
      serialized_utf8_byte_count: 100,
      retry_guidance: null,
    };
    if (request.objective.includes("multiple")) {
      const second = structuredClone(response.bundles[0]);
      second.ordinal = 1;
      second.change_record.change_id = "change-v2-unicode";
      second.change_record.logical_identity = "logical-v2-unicode";
      second.change_record.base.symbol_instance_id = "base-instance-unicode";
      second.change_record.head.symbol_instance_id = "head-instance-unicode";
      second.base_evidence.evidence_id = "extent-base-unicode";
      second.base_evidence.symbol_instance_id = "base-instance-unicode";
      second.base_evidence.text = "BASE_UNICODE_Δ😀\\nline two\\nline three\\n";
      second.head_evidence.evidence_id = "extent-head-unicode";
      second.head_evidence.symbol_instance_id = "head-instance-unicode";
      second.head_evidence.text = "HEAD_UNICODE_Δ😀\\nline two\\nline three\\n";
      response.bundles.push(second);
      response.omitted_bundles.push({
        schema_version: "review-context/v2",
        change_id: "server-omitted-change",
        ordinal: 2,
        change_kind: "modified",
        pairing_status: "exact_symbol_id",
        reason: "required_pair_budget_exceeded",
        omitted_sides: ["base", "head"],
        minimum_required_budget: {
          schema_version: "review-context/v2",
          evidence_items: 2,
          tokens: 123,
          characters: 456,
          utf8_bytes: 789,
        },
        model_evidence_available: false,
      });
    }
    if (request.objective.includes("scale 200")) {
      const template = response.bundles[0];
      response.bundles = [];
      for (let index = 0; index < 200; index += 1) {
        const item = structuredClone(template);
        item.ordinal = index;
        item.change_record.change_id = "scale-change-" + index;
        item.change_record.logical_identity = "scale-logical-" + index;
        item.change_record.base.symbol_instance_id = "scale-base-" + index;
        item.change_record.head.symbol_instance_id = "scale-head-" + index;
        item.base_evidence.evidence_id = "scale-base-evidence-" + index;
        item.base_evidence.symbol_instance_id = "scale-base-" + index;
        item.base_evidence.text = "BASE_SCALE_" + index + "\\nline two\\nline three\\n";
        item.head_evidence.evidence_id = "scale-head-evidence-" + index;
        item.head_evidence.symbol_instance_id = "scale-head-" + index;
        item.head_evidence.text = "HEAD_SCALE_" + index + "\\nline two\\nline three\\n";
        response.bundles.push(item);
      }
    }
    if (request.objective.includes("missing collections")) {
      delete response.bundles;
    }
    if (request.objective.includes("malformed bundle")) {
      response.bundles = [null];
    }
    if (request.objective.includes("malformed omission")) {
      response.omitted_bundles = [{}];
    }
    if (request.objective.includes("half pair")) {
      response.bundles[0].head_evidence = null;
    }
    if (request.objective.includes("mismatched instance")) {
      response.bundles[0].head_evidence.symbol_instance_id = "wrong-head-instance";
    }
    if (request.objective.includes("unknown change kind")) {
      response.bundles[0].change_record.change_kind = "future_change_kind";
    }
    if (request.objective.includes("unknown pairing status")) {
      response.bundles[0].change_record.pairing_status = "future_pairing_status";
    }
    if (request.objective.includes("unknown continuity status")) {
      response.bundles[0].change_record.continuity_status = "future_continuity_status";
    }
    if (request.objective.includes("unknown delta status")) {
      response.bundles[0].change_record.relationship_deltas = [{
        schema_version: "review-context/v2",
        status: "future_delta_status",
        direction: "outgoing",
        base_fact: null,
        head_fact: null,
      }];
    }
    return response;
  }

  async requestReviewContextV2(request) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "requestReviewContextV2",
      request,
    }) + "\\n", "utf8");
    const state = ["succeeded", "partial", "failed", "cancelled", "superseded"]
      .find((candidate) => request.objective.includes("job " + candidate)) ?? "running";
    return {
      schema_version: "review-context/v2",
      contract_version: request.objective.includes("future contract")
        ? "review-context/v3"
        : "review-context/v2",
      job_id: request.objective.includes("max ids") ? "j".repeat(256) : "job-review-v2",
      request_id: "request-review-v2",
      tenant_id: "tenant-a",
      codebase_id: request.codebaseId,
      repository_set_id: "set-v2",
      repository_selection_digest: "e".repeat(64),
      state,
      attempts: 1,
      status_url: "/v2/review-context/jobs/job-review-v2",
      retry_after_seconds: ["queued", "running"].includes(state) ? 1 : null,
      created_at: "2026-08-19T12:00:00Z",
      updated_at: "2026-08-19T12:00:01Z",
      partial_reasons: state === "succeeded" ? [] : [{
        schema_version: "review-context/v2",
        code: "job_" + state + "_reason",
        retryable: false,
        affected_side: "response",
      }],
    };
  }

  async getCodebase(codebaseId) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "getCodebase",
      codebaseId,
    }) + "\\n", "utf8");
    return {
      tenant_id: "tenant-a",
      codebase_id: codebaseId,
      display_name: "Payments",
      status: "active",
      repository_selection: { mode: "all", provider_repository_ids: [] },
      created_at: "2026-08-02T15:00:00Z",
      updated_at: "2026-08-02T15:00:00Z",
    };
  }

  async listCodebaseRepositories(codebaseId) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "listCodebaseRepositories",
      codebaseId,
    }) + "\\n", "utf8");
    return {
      repositories: [{
        repository_id: "repo-kotlin",
        provider: "github",
        provider_external_id: "repository-42",
        canonical_path: "services/orders",
        state: "active",
      }],
    };
  }

  async getReviewContextCapabilities() {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "getReviewContextCapabilities",
    }) + "\\n", "utf8");
    return {
      enabled: true,
      service_available: true,
      symbol_graph: true,
      review_overlays: true,
      providers: { github: true },
      analyzers: { java: true, kotlin: true, python: false },
    };
  }

  async getReviewStatus(codebaseId, reviewId) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({
      kind: "getReviewStatus",
      codebaseId,
      reviewId,
    }) + "\\n", "utf8");
    return {
      review_id: reviewId,
      state: "ready",
      target_repository_id: "repo-kotlin",
      head_sha: "2".repeat(40),
      overlay_id: "overlay-1",
      overlay_generation: 4,
      freshness: "exact",
      latest_job: { job_id: "job-review-1", state: "succeeded" },
      purge_after: null,
      warnings: [],
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
    if (process.env.MOCK_ENHANCE_EMPTY === "true") {
      return {
        retrieval_query: request.prompt,
        retrieval_not_found: true,
        retrieved_chunks: [],
        agent_context_packets: [],
        output_mode: request.outputMode,
        enhanced_prompt: "",
      };
    }
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
    request.onProgress?.({
      schema_version: "index-progress/v1",
      sequence: 1,
      session_id: "session-mcp",
      workspace_id: request.workspace.workspaceId,
      occurred_at: new Date().toISOString(),
      phase: "embedding",
      state: "running",
      message: "Embedding synthetic chunks",
      overall_completed: 1,
      overall_total: 2,
      overall_percent: 50,
      overall_indeterminate: false,
      phase_completed: 1,
      phase_total: 2,
      unit: "chunks",
      elapsed_ms: 100,
      phase_elapsed_ms: 50,
      throughput_per_second: 20,
      queue_depth: 0,
      retries: 0,
      warnings: [],
      eta_seconds: 0.05,
      eta_confidence: "medium",
      heartbeat: false,
      last_progress_at: new Date().toISOString(),
      last_heartbeat_at: null,
      active_heartbeat: false,
      counts: {},
      phase_timings_ms: {},
      verification_status: "pending",
    });
    if (process.env.MOCK_MANIFEST_FAILURE === "true") {
      const error = new Error("Server rejected manifest entries: line 1: invalid_inventory_entry");
      error.code = "scan_incomplete";
      error.sessionId = "session-manifest-error";
      error.manifestSkipped = 1;
      error.manifestErrors = ["line 1: invalid_inventory_entry"];
      throw error;
    }
    const delayMs = Number(process.env.MOCK_INDEX_DELAY_MS ?? 0);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
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
  errorMessage = "Review-context reads are disabled";
  errorCode = "review_reads_disabled";
  requestId = "request-http-v2";
  retryable = true;
  retryAfterSeconds = 7;
  recoveryGuidance = ["Retry after rollout enablement."];
}
`.trimStart(),
    "utf8",
  );
  return { sdkPath, requestsPath };
}

function createRpc(process) {
  let buffer = "";
  const responses = [];
  const notifications = [];
  const waiters = [];

  process.stdout.setEncoding("utf8");
  process.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const message = JSON.parse(line);
        if (message.id === undefined && typeof message.method === "string") {
          notifications.push(message);
        } else {
          responses.push(message);
        }
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

  const rpc = (message) => new Promise((resolve, reject) => {
    waiters.push(resolve);
    process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        reject(error);
      }
    });
    flushWaiters();
  });
  rpc.notifications = notifications;
  return rpc;
}

test("reconcile reports acknowledged transfers, rejects caps, and leaves legacy coverage unknown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cw-inventory-"));
  const sdkPath = path.join(root, "mock-sdk.mjs"), requestsPath = path.join(root, "calls.jsonl");
  const sourceRoot = path.join(root, "repo");
  await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, "a.py"), "a=1");
  await writeFile(path.join(sourceRoot, "empty.py"), "");
  await writeFile(sdkPath, `import { appendFileSync } from 'node:fs';
    export class CorpusWireClient {
      async indexWorkspace(request) {
        appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify({ scan: request.inventoryScan, count: request.files.length }) + '\\n');
        return {ok: true, result: {}, status: {phase: 'completed'}, transfer: {
          complete: true, files_submitted: request.files.length, files_reused: request.files.length,
          files_transferred: 0, acknowledged_files: [],
        }};
      }
    }`);
  const child = spawn("node", [SERVER_BIN], { stdio: ["pipe", "pipe", "pipe"], env: {
    ...process.env, CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000", CORPUSWIRE_SDK_PATH: sdkPath,
    CORPUSWIRE_SYNC_ENABLED: "true", CORPUSWIRE_SYNC_ROOT: sourceRoot, CORPUSWIRE_WORKSPACE_ID: "fixture",
    CORPUSWIRE_SYNC_STATE_DIR: path.join(root, "cache"), MOCK_REQUESTS_PATH: requestsPath,
  }});
  const rpc = createRpc(child);
  try {
    const invoke = (id, maxFiles) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: {
      name: "corpuswire_sync_reconcile", arguments: { maxFiles },
    }});
    const full = await invoke(1, 10);
    assert.equal(full.result.isError, false);
    assert.match(full.result.content[0].text, /filesUploaded: 0/);
    assert.match(full.result.content[0].text, /filesSubmitted: 2/);
    assert.match(full.result.content[0].text, /coverage: unknown/);
    const capped = await invoke(2, 1);
    assert.equal(capped.result.isError, true);
    assert.match(capped.result.content[0].text, /exceeded max file count/);
    const calls = (await readFile(requestsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scan.complete, true);
    assert.equal(calls[0].count, 2);
  } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
});

test("verified cache rehashes content and refuses lineage adopted from another client", async () => {
  const { utimes } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "cw-coverage-cache-"));
  const sdkPath = path.join(root, "sdk.mjs"), requestsPath = path.join(root, "calls.jsonl");
  const sourceRoot = path.join(root, "repo"), foreign = path.join(root, "foreign");
  await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, "a.py"), "old");
  const stamp = new Date("2026-09-08T00:00:00Z");
  await utimes(path.join(sourceRoot, "a.py"), stamp, stamp);
  await writeFile(sdkPath, `import {appendFileSync,existsSync} from 'node:fs';
    let token='baseline';
    export class CorpusWireClient {
      async diagnoseWorkspace() { return {status:'ready',can_retrieve:true,collection:'fixture',collection_exists:true,point_count:1,
        index:{health_status:'ok',coverage:{state:'verified',coverage_token:existsSync(process.env.FOREIGN_MARKER)?'foreign':token,selection_policy_digest:'policy'}},checks:[],recovery_actions:[]}; }
      async indexWorkspace(request) {
        appendFileSync(process.env.MOCK_REQUESTS_PATH,JSON.stringify({mode:request.mode,token:request.baseCoverageToken,policy:request.selectionPolicyDigest,files:request.files.map(f=>f.relativePath)})+'\\n');
        token+='x';
        return {ok:true,result:{collection:'fixture'},status:{collection_name:'fixture',coverage:{state:'verified',coverage_token:token,selection_policy_digest:'policy'}},
          transfer:{complete:true,files_submitted:request.files.length,files_transferred:request.files.length,files_reused:0,
            acknowledged_files:request.files.map(f=>({relative_path:f.relativePath,sha256:f.sha256,disposition:'uploaded'}))}};
      }
    }`);
  const child = spawn('node', [SERVER_BIN], {stdio:['pipe','pipe','pipe'],env:{...process.env,
    CORPUSWIRE_BASE_URL:'http://127.0.0.1:8000',CORPUSWIRE_SDK_PATH:sdkPath,CORPUSWIRE_SYNC_ENABLED:'true',
    CORPUSWIRE_SYNC_MTIME_CACHE_ENABLED:'true',CORPUSWIRE_SYNC_ROOT:sourceRoot,CORPUSWIRE_WORKSPACE_ID:'fixture',
    CORPUSWIRE_SYNC_STATE_DIR:path.join(root,'cache'),MOCK_REQUESTS_PATH:requestsPath,FOREIGN_MARKER:foreign}});
  const rpc = createRpc(child);
  const invoke = (id, name, args={}) => rpc({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
  try {
    const full = await invoke(1,'corpuswire_sync_reconcile');
    assert.equal(full.result.isError,false);
    const unchanged = await invoke(2,'corpuswire_sync_delta',{changedPaths:['a.py'],flush:true});
    assert.match(unchanged.result.content[0].text,/unchanged_hash/);
    assert.match(unchanged.result.content[0].text,/filesUploaded: 0/);
    await writeFile(path.join(sourceRoot,'a.py'),'new');
    await utimes(path.join(sourceRoot,'a.py'),stamp,stamp);
    const changed = await invoke(3,'corpuswire_sync_delta',{changedPaths:['a.py'],flush:true});
    assert.match(changed.result.content[0].text,/filesUploaded: 1/);
    await writeFile(foreign,'1');
    const mismatch = await invoke(4,'corpuswire_sync_delta',{changedPaths:['a.py'],flush:true});
    assert.match(mismatch.result.content[0].text,/needsReconcile: true/);
    const calls = (await readFile(requestsPath,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length,2);
    assert.equal(calls[1].token,'baselinex');
    assert.equal(calls[1].policy,'policy');
  } finally {child.kill();await rm(root,{recursive:true,force:true});}
});

test("fresh MCP process defers incremental writes, including backend no-op candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cw-fresh-coverage-"));
  const sourceRoot = path.join(root, "repo");
  const sdkPath = path.join(root, "sdk.mjs");
  const requestsPath = path.join(root, "calls.jsonl");
  await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, "a.py"), "unchanged");
  await writeFile(sdkPath, `import {appendFileSync} from 'node:fs';
    export class CorpusWireClient {
      async diagnoseWorkspace() { return {status:'ready',can_retrieve:true,collection:'fixture',collection_exists:true,point_count:1,
        index:{health_status:'ok',coverage:{state:'verified',coverage_token:'existing',selection_policy_digest:'policy'}},
        checks:[],recovery_actions:[]}; }
      async indexWorkspace(request) {
        appendFileSync(process.env.MOCK_REQUESTS_PATH,JSON.stringify({mode:request.mode,token:request.baseCoverageToken})+'\\n');
        return {ok:true,status:{coverage:{state:'verified',coverage_token:'new',selection_policy_digest:'policy'}},
          transfer:{complete:true,files_submitted:request.files.length,files_transferred:0,files_reused:request.files.length}};
      }
    }`);
  const child = spawn("node", [SERVER_BIN], { stdio: ["pipe", "pipe", "pipe"], env: {
    ...process.env, CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000", CORPUSWIRE_SDK_PATH: sdkPath,
    CORPUSWIRE_SYNC_ENABLED: "true", CORPUSWIRE_SYNC_ROOT: sourceRoot,
    CORPUSWIRE_WORKSPACE_ID: "fixture", MOCK_REQUESTS_PATH: requestsPath,
  }});
  const rpc = createRpc(child);
  const invoke = (id, name, args = {}) => rpc({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:args}});
  try {
    const empty = await invoke(1, "corpuswire_sync_delta", {flush:true});
    assert.equal(empty.result.isError, false);
    const checked = await invoke(2, "corpuswire_sync_bootstrap");
    assert.match(checked.result.content[0].text, /bootstrapState: ready/);
    const deferred = await invoke(3, "corpuswire_sync_delta", {changedPaths:["a.py"],flush:true});
    assert.equal(deferred.result.isError, false);
    assert.match(deferred.result.content[0].text, /needsReconcile: true/);
    const status = await invoke(4, "corpuswire_sync_status");
    assert.match(status.result.content[0].text, /needs_reconcile/);
    await assert.rejects(readFile(requestsPath, "utf8"), {code:"ENOENT"});
  } finally {child.kill();await rm(root,{recursive:true,force:true});}
});

test("incremental sync defers when the verified selection policy digest changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cw-policy-drift-"));
  const sourceRoot = path.join(root, "repo");
  const sdkPath = path.join(root, "sdk.mjs");
  const requestsPath = path.join(root, "calls.jsonl");
  const policyMarker = path.join(root, "policy-drift");
  await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, "a.py"), "a=1");
  await writeFile(sdkPath, `import {appendFileSync,existsSync} from 'node:fs';
    export class CorpusWireClient {
      async diagnoseWorkspace() { return {status:'ready',can_retrieve:true,collection:'fixture',collection_exists:true,point_count:1,
        index:{health_status:'ok',coverage:{state:'verified',coverage_token:'baseline',
          selection_policy_digest:existsSync(process.env.POLICY_MARKER)?'changed-policy':'policy'}},
        checks:[],recovery_actions:[]}; }
      async indexWorkspace(request) {
        appendFileSync(process.env.MOCK_REQUESTS_PATH,JSON.stringify({mode:request.mode,token:request.baseCoverageToken})+'\\n');
        return {ok:true,result:{collection:'fixture'},status:{collection_name:'fixture',coverage:{state:'verified',
          coverage_token:'baseline',selection_policy_digest:'policy'}},
          transfer:{complete:true,files_submitted:request.files.length,files_transferred:request.files.length,
            files_reused:0,acknowledged_files:[]}};
      }
    }`);
  const child = spawn("node", [SERVER_BIN], {stdio:["pipe","pipe","pipe"],env:{...process.env,
    CORPUSWIRE_BASE_URL:"http://127.0.0.1:8000",CORPUSWIRE_SDK_PATH:sdkPath,
    CORPUSWIRE_SYNC_ENABLED:"true",CORPUSWIRE_SYNC_ROOT:sourceRoot,
    CORPUSWIRE_WORKSPACE_ID:"fixture",MOCK_REQUESTS_PATH:requestsPath,POLICY_MARKER:policyMarker}});
  const rpc = createRpc(child);
  const invoke = (id, name, args={}) => rpc({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:args}});
  try {
    const full = await invoke(1,"corpuswire_sync_reconcile");
    assert.equal(full.result.isError,false);
    await writeFile(policyMarker,"1");
    const deferred = await invoke(2,"corpuswire_sync_delta",{changedPaths:["a.py"],flush:true});
    assert.match(deferred.result.content[0].text,/needsReconcile: true/);
    const calls = (await readFile(requestsPath,"utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls,[{mode:"full"}]);
  } finally {child.kill();await rm(root,{recursive:true,force:true});}
});

test("MCP recognizes code readiness without certifying full inventory", async () => {
  const source = await readFile(SERVER_BIN, 'utf8');
  const start = source.indexOf('function bootstrapStatusFromDiagnosis(');
  const end = source.indexOf('\nfunction compactStringArray', start);
  assert.ok(start >= 0 && end > start);
  const freshnessStart = source.indexOf('function hasBootstrapFreshnessSignal(');
  const freshnessEnd = source.indexOf('\nfunction formatWorkspaceDiagnosis', freshnessStart);
  assert.ok(freshnessStart >= 0 && freshnessEnd > freshnessStart);
  const freshnessSignal = new Function(source.slice(freshnessStart, freshnessEnd)
    + '; return hasBootstrapFreshnessSignal;')();
  const stringStart = source.indexOf('function optionalString(');
  const stringEnd = source.indexOf('\nfunction readOutputMode', stringStart);
  assert.ok(stringStart >= 0 && stringEnd > stringStart);
  const optionalString = new Function(source.slice(stringStart, stringEnd)
    + '; return optionalString;')();
  const readBootstrap = new Function('asRecord', 'compactStringArray', 'isRecord',
    'optionalString', 'hasBootstrapFreshnessSignal', 'firstNonEmptyString',
    source.slice(start, end) + '; return bootstrapStatusFromDiagnosis;')(
      (value) => value ?? {}, (value) => Array.isArray(value) ? value : [],
      (value) => value && typeof value === 'object',
      optionalString, freshnessSignal,
      (...values) => values.find(Boolean));
  const diagnosis = {status:'ready',can_retrieve:true,collection_exists:true,point_count:2,
    checks:[],recovery_actions:[],index:{health_status:'ok',readiness:'code_ready',
      coverage:{state:'pending',code_ready:true,documentation_pending:true,
        other_pending:true,reason_codes:['background_ingestion_pending']}}};
  const ready = readBootstrap(diagnosis, {workspaceId:'fixture'});
  assert.equal(ready.state, 'ready');
  assert.equal(ready.documentationPending, true);
  assert.equal(ready.coverage.state, 'pending');
  assert.equal(ready.needsReconcile, false);
  for (const change of [
    {index:{...diagnosis.index,health_status:'error'}},
    {index:{...diagnosis.index,health_warnings:['vector connection failed']}},
    {qdrant_error:'vector connection failed'},
    {checks:[{name:'vectors',status:'error',message:'vector connection failed'}]},
    {checks:[{name:'vectors',status:'warning',message:'vector connection failed'}]},
    {collection_exists:false},
    {point_count:0},
    {index:{...diagnosis.index,health_status:undefined}},
  ]) {
    const rejected = readBootstrap({...diagnosis,...change},{});
    assert.equal(rejected.codeReady,false);
    assert.equal(rejected.state,'needs_reconcile');
  }
  diagnosis.index.coverage.reason_codes = ['mirror_pending'];
  assert.equal(readBootstrap(diagnosis, {}).state, 'needs_reconcile');
  diagnosis.index.coverage.reason_codes = ['background_ingestion_pending'];
  diagnosis.index.health_status = 'degraded';
  assert.equal(readBootstrap(diagnosis, {}).state, 'needs_reconcile');
  for (const state of ['pending', 'verified']) {
    const healthy = {...diagnosis, index:{...diagnosis.index, health_status:'ok',
      coverage:{...diagnosis.index.coverage, state}}};
    assert.equal(readBootstrap(healthy, {}).state, 'ready');
    for (const change of [
      {status:'blocked'}, {status:'degraded'}, {can_retrieve:false},
      {index:{...healthy.index, health_status:'error'}},
      {index:{...healthy.index, health_warnings:['vector connection failed']}},
      {qdrant_error:'vector connection failed'},
      {checks:[{name:'vectors', status:'error', message:'vector connection failed'}]},
      {checks:[{name:'vectors', status:'warning', message:'vector connection failed'}]},
      {checks:[{name:'vectors', status:'blocked', message:'vector connection failed'}]},
      {checks:[{name:'vectors', status:'failed', message:'vector connection failed'}]},
    ]) {
      const rejected = readBootstrap({...healthy, ...change}, {});
      assert.notEqual(rejected.state, 'ready', `${state}: ${JSON.stringify(change)}`);
      assert.equal(rejected.codeReady, false);
    }
  }
  const legacy = {can_retrieve:true, index:{coverage:{state:'verified'}}};
  assert.equal(readBootstrap(legacy, {}).state, 'ready');
  assert.equal(readBootstrap({...legacy, status:'ready'}, {}).state, 'ready');
});
