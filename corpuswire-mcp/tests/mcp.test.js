import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_BIN = fileURLToPath(new URL("../bin/corpuswire-mcp.js", import.meta.url));
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
        appendFileSync(process.env.MOCK_REQUESTS_PATH,JSON.stringify({mode:request.mode,token:request.baseCoverageToken,files:request.files.map(f=>f.relativePath)})+'\\n');
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
    await invoke(4,'corpuswire_sync_delta',{changedPaths:['a.py'],flush:true});
    const calls = (await readFile(requestsPath,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length,3);
    assert.equal(calls[1].token,'baselinex');
    assert.equal(calls[2].token,undefined);
  } finally {child.kill();await rm(root,{recursive:true,force:true});}
});
