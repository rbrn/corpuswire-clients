import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  CorpusWireClient,
  CorpusWireHttpError,
  RemoteIndexCancelledError,
  RemoteIndexDetachedError,
  ReviewContextPollingCancelledError,
  ReviewContextPollingTimeoutError,
  WorkspaceScanIncompleteError,
  createBasicAuthHeader,
  createBearerAuthHeader,
  manifestEntriesToJsonl,
  requestJson,
  requireEnhancedPrompt,
  toEnhancePayload,
  toGitHubProviderBindingPayload,
  toQueryPayload,
  toQualityEventPayload,
  toReviewContextPayload,
  toReviewContextPayloadV2,
  toStartIndexSessionPayload,
  assertReviewContextV2Result,
  ingestionPriority,
} from "../dist/index.js";

const REVIEW_CONTEXT_V2_SCHEMA = JSON.parse(readFileSync(
  new URL("../../../schemas/review-context/v2/review-context.schema.json", import.meta.url),
  "utf8",
));

test("WorkspaceCoverage declares embedding and collection schema fingerprints", () => {
  const declarations = readFileSync(
    new URL("../dist/types.d.ts", import.meta.url),
    "utf8",
  );
  const workspaceCoverage = declarations.match(
    /export interface WorkspaceCoverage \{[\s\S]*?\n\}/,
  );
  assert.ok(workspaceCoverage);
  assert.match(workspaceCoverage[0], /embedding_fingerprint\?: string \| null;/);
  assert.match(
    workspaceCoverage[0],
    /collection_schema_fingerprint\?: string \| null;/,
  );
});

function canonicalExtentId(changeId, side, instance) {
  const values = [changeId, side, instance.symbol_instance_id, instance.repository_id,
    instance.revision, instance.path, String(instance.source_range.start_line),
    String(instance.source_range.end_line), instance.source_content_sha256,
    instance.symbol_extent_sha256];
  return `symbol-extent:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;
}

function canonicalJsonForTest(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForTest).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJsonForTest(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? "OK" : "ERROR",
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("toEnhancePayload maps camelCase request fields to backend payload fields", () => {
  assert.deepEqual(
    toEnhancePayload({
      repoPath: "/workspace/project",
      workspaceId: "vscode-remote://ssh/project",
      prompt: "fix the bug",
      topK: 7,
      minScore: 0.4,
      outputMode: "claude-code",
      localOnly: true,
    }),
    {
      repo_path: "/workspace/project",
      workspace_id: "vscode-remote://ssh/project",
      prompt: "fix the bug",
      top_k: 7,
      min_score: 0.4,
      output_mode: "claude-code",
      local_only: true,
    },
  );
});

test("review sidecar payloads preserve omitted, null, empty, and selected values", () => {
  const omitted = toGitHubProviderBindingPayload({
    installationId: "installation-42",
    displayName: "Acme GitHub",
  });
  const explicitNull = toGitHubProviderBindingPayload({
    installationId: "installation-42",
    displayName: "Acme GitHub",
    repositoryAllowlist: null,
  });
  const empty = toGitHubProviderBindingPayload({
    installationId: "installation-42",
    displayName: "Acme GitHub",
    repositoryAllowlist: [],
  });
  const selected = toGitHubProviderBindingPayload({
    installationId: "installation-42",
    displayName: "Acme GitHub",
    repositoryAllowlist: ["repo-2", "repo-1"],
  });

  assert.equal(Object.hasOwn(omitted, "repository_allowlist"), false);
  assert.equal(explicitNull.repository_allowlist, null);
  assert.deepEqual(empty.repository_allowlist, []);
  assert.deepEqual(selected.repository_allowlist, ["repo-2", "repo-1"]);
  assert.deepEqual(
    toReviewContextPayload({
      codebaseId: "codebase-1",
      targetRepositoryId: "repo-1",
      providerReviewId: "42",
      expectedHeadSha: null,
      objective: "Find affected consumers",
      strictFreshness: false,
      budgets: { graphHops: 0, evidenceItems: 20, waitMs: 0 },
      outputCharacterLimit: null,
    }),
    {
      codebase_id: "codebase-1",
      target_repository_id: "repo-1",
      provider_review_id: "42",
      expected_head_sha: null,
      objective: "Find affected consumers",
      strict_freshness: false,
      budgets: { graph_hops: 0, evidence_items: 20, wait_ms: 0 },
      output_character_limit: null,
    },
  );
});

test("review context v2 payloads are isolated and map all deterministic evidence budgets", () => {
  assert.deepEqual(
    toReviewContextPayloadV2({
      codebaseId: "codebase-1",
      targetRepositoryId: "repo-1",
      providerReviewId: "42",
      expectedHeadSha: null,
      objective: "Compare exact BASE and HEAD symbols",
      strictFreshness: false,
      budgets: {
        graphHops: 0,
        candidateRepositories: 3,
        preRankCandidates: 11,
        evidenceItems: 20,
        serializedTokens: 4_000,
        serializedCharacters: 50_000,
        serializedUtf8Bytes: 100_000,
        waitMs: 0,
      },
    }),
    {
      schema_version: "review-context/v2",
      codebase_id: "codebase-1",
      target_repository_id: "repo-1",
      provider_review_id: "42",
      expected_head_sha: null,
      objective: "Compare exact BASE and HEAD symbols",
      strict_freshness: false,
      budgets: {
        graph_hops: 0,
        candidate_repositories: 3,
        pre_rank_candidates: 11,
        evidence_items: 20,
        serialized_tokens: 4_000,
        serialized_characters: 50_000,
        serialized_utf8_bytes: 100_000,
        wait_ms: 0,
      },
    },
  );
});

test("toQueryPayload maps workspace-aware semantic search requests", () => {
  assert.deepEqual(
    toQueryPayload({
      workspaceId: "vscode-remote://ssh/project",
      query: "where is remote indexing handled?",
      topK: 4,
      minScore: 0.25,
      includeAnswer: false,
    }),
    {
      workspace_id: "vscode-remote://ssh/project",
      prompt: "where is remote indexing handled?",
      top_k: 4,
      min_score: 0.25,
      include_answer: false,
    },
  );
});

test("toQualityEventPayload maps central scorecards to API fields", () => {
  assert.deepEqual(
    toQualityEventPayload({
      workspaceId: "local-docker://demo#main",
      workType: "review_context",
      engine: "augment",
      query: "find the exact implementation",
      roundId: "round-1",
      scorecard: {
        relevance: 5,
        fileSpecificity: 5,
        coverage: 4,
        freshness: 5,
        actionability: 5,
      },
      resultPaths: ["src/example.ts"],
      improvement: "Improve test coverage.",
    }),
    {
      workspace_id: "local-docker://demo#main",
      work_type: "review_context",
      engine: "augment",
      query: "find the exact implementation",
      round_id: "round-1",
      scorecard: {
        relevance: 5,
        file_specificity: 5,
        coverage: 4,
        freshness: 5,
        actionability: 5,
      },
      result_paths: ["src/example.ts"],
      improvement: "Improve test coverage.",
      metadata: {},
    },
  );
});

test("quality ledger helpers call central event and review endpoints", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      calls.push({ input, init });
      if (init?.method === "POST") {
        return jsonResponse(200, {
          ok: true,
          event: { event_id: "quality-1", engine: "corpuswire", overall: 4.2 },
        });
      }
      return jsonResponse(200, {
        ok: true,
        review: { event_count: 1, overall_average: 4.2, recommended_actions: [] },
      });
    },
  });

  const event = await client.recordQualityEvent({
    workspaceId: "local-docker://demo#main",
    workType: "prompt_enhancement",
    engine: "corpuswire",
    scorecard: {
      relevance: 4,
      fileSpecificity: 4,
      coverage: 4,
      freshness: 5,
      actionability: 4,
    },
  });
  const review = await client.reviewQuality({
    workspaceId: "local-docker://demo#main",
    workType: "review_context",
    days: 14,
  });

  assert.equal(event.event_id, "quality-1");
  assert.equal(review.event_count, 1);
  assert.equal(calls[0].input, "http://example.test/v1/quality/events");
  assert.equal(calls[1].input, "http://example.test/v1/quality/review?workspace_id=local-docker%3A%2F%2Fdemo%23main&work_type=review_context&days=14");
});

test("toStartIndexSessionPayload maps remote indexing session fields", () => {
  assert.deepEqual(
    toStartIndexSessionPayload({
      workspace: {
        workspaceId: "vscode-remote://ssh/project",
        displayRoot: "remote project",
        name: "project",
      },
      mode: "full",
      includeGlobs: ["**/*.ts"],
      excludeGlobs: ["**/node_modules/**"],
      maxFileSizeBytes: 1234,
      recreateCollection: true,
    }),
    {
      workspace: {
        workspace_id: "vscode-remote://ssh/project",
        display_root: "remote project",
        name: "project",
      },
      mode: "full",
      client: {},
      include_globs: ["**/*.ts"],
      exclude_globs: ["**/node_modules/**"],
      max_file_size_bytes: 1234,
      recreate_collection: true,
    },
  );
});

test("toStartIndexSessionPayload preserves v2 scope omission and null semantics", () => {
  const omitted = toStartIndexSessionPayload({
    workspace: { workspaceId: "workspace-1" },
  });
  const explicitNull = toStartIndexSessionPayload({
    workspace: { workspaceId: "workspace-1" },
    snapshotScope: null,
  });
  const scoped = toStartIndexSessionPayload({
    workspace: { workspaceId: "workspace-1" },
    snapshotScope: {
      tenantId: null,
      codebaseId: "codebase-1",
      repositoryId: "repository-1",
      repositorySetId: "repository-set-1",
      snapshotId: "snapshot-1",
      layer: "snapshot",
      revision: "a".repeat(40),
      generation: 7,
    },
  });

  assert.equal(Object.hasOwn(omitted, "snapshot_scope"), false);
  assert.equal(explicitNull.snapshot_scope, null);
  assert.deepEqual(scoped.snapshot_scope, {
    tenant_id: null,
    codebase_id: "codebase-1",
    repository_id: "repository-1",
    repository_set_id: "repository-set-1",
    snapshot_id: "snapshot-1",
    layer: "snapshot",
    revision: "a".repeat(40),
    generation: 7,
  });
});

test("toStartIndexSessionPayload binds evaluation inventory without changing omission", () => {
  const ordinary = toStartIndexSessionPayload({
    workspace: { workspaceId: "ordinary-workspace" },
  });
  assert.equal(Object.hasOwn(ordinary, "evaluation_inventory_attestation"), false);

  const attestation = {
    schema_version: "evaluation-inventory-attestation/v1",
    full_manifest_digest: "1".repeat(64),
    eligible_manifest_digest: "2".repeat(64),
    excluded_manifest_digest: "3".repeat(64),
    allowlist_digest: "4".repeat(64),
    required_evidence_digest: "5".repeat(64),
    selection_policy_digest: "6".repeat(64),
    complete_file_count: 2,
    complete_source_bytes: 7,
    excluded_file_count: 1,
    excluded_source_bytes: 3,
    excluded_entries: [{ relative_path: "excluded.bin", sha256: "7".repeat(64), size: 3 }],
    allowlist_entries: [{ relative_path: "package.json", sha256: "8".repeat(64), size: 4 }],
    required_evidence_entries: [{ relative_path: "package.json", sha256: "8".repeat(64), size: 4 }],
  };
  const payload = toStartIndexSessionPayload({
    workspace: { workspaceId: "local-docker://rqt-fixture#frozen" },
    mode: "full",
    evaluationInventoryAttestation: attestation,
  });
  assert.deepEqual(payload.evaluation_inventory_attestation, attestation);
});

test("manifestEntriesToJsonl serializes camelCase manifest entries as backend JSONL", () => {
  assert.equal(
    manifestEntriesToJsonl([
      {
        relativePath: "src/index.ts",
        op: "upsert",
        size: 9,
        mtimeNs: 123,
        sha256: "abc",
        docTypeHint: "code",
      },
    ]),
    '{"relative_path":"src/index.ts","op":"upsert","size":9,"mtime_ns":123,"sha256":"abc","doc_type_hint":"code"}\n',
  );
});

test("enhance prefers versioned endpoint and returns the prompt rewrite result", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(200, {
        ok: true,
        request_id: "req-123",
        duration_ms: 8,
        result: {
          user_prompt: "fix the bug",
          retrieval_query: "fix the bug",
          retrieval_backend: "corpuswire_qdrant_vector",
          retrieval_warning: null,
          retrieved_chunks: [],
          task_type: "bug_fix",
          task_type_source: "llm",
          task_type_classification_error: null,
          output_mode: "claude-code",
          context_summary: "summary",
          summary_generation_error: null,
          enhancement_prompt: "rewrite prompt",
          citations: [],
          enhanced_prompt: "enhanced prompt",
          enhancement_backend: "llm",
          generation_error: null,
        },
      });
    },
  });

  const result = await client.enhance({
    prompt: "fix the bug",
    outputMode: "claude-code",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "http://example.test/v1/enhance");
  assert.equal(result.task_type, "bug_fix");
  assert.equal(requireEnhancedPrompt(result), "enhanced prompt");
});

test("enhance falls back to unversioned endpoint when the versioned route returns 404", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input) => {
      calls.push(input);
      if (calls.length === 1) {
        return jsonResponse(404, { detail: "Not found" });
      }

      return jsonResponse(200, {
        ok: true,
        request_id: "req-456",
        duration_ms: 5,
        result: {
          user_prompt: "fix the bug",
          retrieval_query: "fix the bug",
          retrieval_backend: "qdrant_vector",
          retrieval_warning: null,
          retrieved_chunks: [],
          task_type: "bug_fix",
          task_type_source: "heuristic",
          task_type_classification_error: null,
          output_mode: "generic",
          context_summary: "summary",
          summary_generation_error: null,
          enhancement_prompt: "fallback prompt",
          citations: [],
          enhanced_prompt: null,
          enhancement_backend: "local-deterministic",
          generation_error: null,
        },
      });
    },
  });

  const result = await client.enhance("fix the bug");

  assert.deepEqual(calls, ["http://example.test/v1/enhance", "http://example.test/enhance"]);
  assert.equal(requireEnhancedPrompt(result), "fallback prompt");
});

test("enhance surfaces request metadata from the stable error envelope", async () => {
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async () =>
      jsonResponse(400, {
        ok: false,
        request_id: "req-error",
        duration_ms: 11,
        error: {
          code: "bad_request",
          message: "prompt is not specific enough",
        },
      }),
  });

  await assert.rejects(
    async () => {
      await client.enhance("help");
    },
    (error) => {
      assert.ok(error instanceof CorpusWireHttpError);
      assert.equal(error.requestId, "req-error");
      assert.equal(error.durationMs, 11);
      assert.equal(error.errorCode, "bad_request");
      assert.equal(error.errorMessage, "prompt is not specific enough");
      return true;
    },
  );
});

test("requestJson retries transient gateway responses before returning JSON", async () => {
  const calls = [];
  const result = await requestJson({
    baseUrl: "http://example.test",
    paths: ["/query"],
    retryDelayMs: 0,
    fetchFn: async (input) => {
      calls.push(input);
      if (calls.length < 3) {
        return jsonResponse(502, { detail: "Bad Gateway" });
      }
      return jsonResponse(200, { ok: true, result: { value: "ready" } });
    },
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(result, { ok: true, result: { value: "ready" } });
});

test("requestJson does not retry stable request errors", async () => {
  let calls = 0;
  await assert.rejects(
    async () => {
      await requestJson({
        baseUrl: "http://example.test",
        paths: ["/v1/enhance"],
        retryDelayMs: 0,
        fetchFn: async () => {
          calls += 1;
          return jsonResponse(400, {
            ok: false,
            request_id: "req-stable",
            duration_ms: 3,
            error: {
              code: "bad_request",
              message: "prompt is required",
            },
          });
        },
      });
    },
    (error) => {
      assert.ok(error instanceof CorpusWireHttpError);
      assert.equal(error.status, 400);
      assert.equal(error.errorMessage, "prompt is required");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("health falls back to the legacy endpoint when needed", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input) => {
      calls.push(input);
      if (calls.length === 1) {
        return jsonResponse(404, { detail: "Not found" });
      }

      return jsonResponse(200, {
        ok: true,
        docs_source_dir: "/tmp/docs",
        runtime: {
          embedding_provider_preference: "auto",
          generation_provider_preference: "openai",
          openai_compat_profile: "auto",
          openai_base_url: null,
          basic_auth_enabled: false,
          basic_auth_uses_fallback: false,
          embedding_order: ["hash:local-fallback"],
          generation_order: ["openai:gpt-4.1-mini"],
          ollama_base_url: null,
          corpuswire_enabled: true,
        },
        ollama: {},
        corpuswire: {
          enabled: true,
          reachable: true,
          base_url: "http://context-engine.test",
        },
        qdrant: {
          collection: "corpuswire",
          collection_exists: true,
          point_count: 42,
        },
        auth: {
          available: false,
          providers: [],
        },
        ui: "/ui",
      });
    },
  });

  const result = await client.health();

  assert.deepEqual(calls, ["http://example.test/v1/health", "http://example.test/health"]);
  assert.equal(result.runtime.generation_provider_preference, "openai");
});

test("diagnoseWorkspace calls versioned diagnosis endpoint with workspace scope", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input) => {
      calls.push(input);
      return jsonResponse(200, {
        ok: true,
        diagnosis: {
          status: "blocked",
          can_retrieve: false,
          requested_repo_path: null,
          requested_workspace_id: "github://rbrn/corpuswire#main",
          resolved_context: "github://rbrn/corpuswire#main",
          resolved_workspace_id: "github://rbrn/corpuswire#main",
          resolution_mode: "remote",
          collection: "local-doc-rag-poc--corpuswire-main--ad8994dc8a6e",
          collection_exists: false,
          point_count: 0,
          qdrant_error: null,
          index: {
            path: "github://rbrn/corpuswire#main",
            collection: "local-doc-rag-poc--corpuswire-main--ad8994dc8a6e",
            indexed: false,
            health_status: "degraded",
            health_warnings: ["No indexed Qdrant points were found for this context."],
          },
          active_backend: {
            default_repo_path: "/Users/constantinaldea/clawd",
            default_collection: "local-doc-rag-poc--clawd--d0730c35d7ae",
            requested_context: "github://rbrn/corpuswire#main",
            matches_requested_context: false,
          },
          checks: [
            {
              name: "collection",
              status: "error",
              message: "Collection does not exist.",
            },
          ],
          recovery_actions: ["Index or sync workspace 'github://rbrn/corpuswire#main'."],
        },
      });
    },
  });

  const diagnosis = await client.diagnoseWorkspace({
    workspaceId: "github://rbrn/corpuswire#main",
  });

  assert.deepEqual(calls, [
    "http://example.test/v1/context/diagnose?workspace_id=github%3A%2F%2Frbrn%2Fcorpuswire%23main",
  ]);
  assert.equal(diagnosis.status, "blocked");
  assert.equal(diagnosis.collection_exists, false);
  assert.match(diagnosis.recovery_actions[0], /Index or sync workspace/);
});

test("query posts workspace_id to semantic retrieval endpoint", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      calls.push({ input, body: JSON.parse(init.body) });
      return jsonResponse(200, {
        ok: true,
        result: {
          user_prompt: "find remote indexer",
          retrieval_query: "find remote indexer",
          retrieval_backend: "qdrant_hybrid",
          retrieval_warning: null,
          retrieved_chunks: [],
          agent_context_packets: [
            {
              source_path: "clients/corpuswire-mcp/bin/corpuswire-mcp.js",
              role: "integration",
              inspection_order: 1,
              score: 1.23,
              reasons: ["integration context"],
              symbols: ["function searchContext"],
              line_ranges: ["1200-1240"],
              chunk_ids: ["chunk-1"],
              doc_type: "code",
              package_name: "corpuswire-mcp",
              tags: ["source-code"],
            },
          ],
          augmented_prompt: "Use remote indexer context.",
          citations: [],
          answer: null,
          generation_error: null,
        },
        context: {
          request_id: "request-123",
          tenant_id: "tenant-a",
          user_id: "user-123",
          actor_kind: "human",
          workspace_id: "vscode-remote://ssh/project",
          membership_role: "viewer",
          collection: "remote-project",
        },
      });
    },
  });

  const response = await client.queryRaw({
    workspaceId: "vscode-remote://ssh/project",
    query: "find remote indexer",
  });
  const result = response.result;

  assert.equal(calls[0].input, "http://example.test/query");
  assert.equal(calls[0].body.workspace_id, "vscode-remote://ssh/project");
  assert.equal(calls[0].body.include_answer, false);
  assert.equal(result.augmented_prompt, "Use remote indexer context.");
  assert.equal(result.agent_context_packets[0].role, "integration");
  assert.deepEqual(result.agent_context_packets[0].line_ranges, ["1200-1240"]);
  assert.equal(response.context.tenant_id, "tenant-a");
  assert.equal(response.context.user_id, "user-123");
  assert.equal(response.context.workspace_id, "vscode-remote://ssh/project");
});

test("remote indexWorkspace runs session, manifest, upload, and commit requests", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      calls.push({ input, init });
      if (input.endsWith("/v1/index/sessions")) {
        return jsonResponse(200, {
          ok: true,
          result: {
            session_id: "sess-1",
            workspace_id: "workspace-1",
            collection_name: "collection-1",
            mode: "incremental",
            manifest_revision: 1,
            max_batch_bytes: 1024,
            max_file_size_bytes: 1024,
            max_concurrent_uploads: 4,
          },
        });
      }
      if (input.endsWith("/manifest/batch")) {
        return jsonResponse(200, {
          ok: true,
          result: {
            accepted: 1,
            upload_required: ["README.md"],
            unchanged: 0,
            deletes: 0,
            skipped: 0,
            errors: [],
          },
        });
      }
      if (input.endsWith("/files/batch")) {
        assert.match(new Headers(init.headers).get("content-type"), /^multipart\/mixed; boundary=/);
        return jsonResponse(200, {
          ok: true,
          result: {
            files_received: 1,
            files_indexed: 1,
            bytes_uploaded: 8,
            bytes_skipped: 0,
            errors: [],
          },
        });
      }
      return jsonResponse(200, {
        ok: true,
        result: { documents_indexed: 1 },
        status: {
          session_id: "sess-1",
          workspace_id: "workspace-1",
          collection_name: "collection-1",
          mode: "incremental",
          phase: "completed",
          files_manifested: 1,
          files_indexed: 1,
          files_deleted: 0,
          files_unchanged: 0,
          files_skipped: 0,
          bytes_uploaded: 8,
          bytes_skipped: 0,
          queue_depth: 0,
          errors: [],
        },
      });
    },
  });

  const result = await client.indexWorkspace({
    workspace: { workspaceId: "workspace-1" },
    files: [{ relativePath: "README.md", content: "# Demo\n" }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.input), [
    "http://example.test/v1/index/sessions",
    "http://example.test/v1/index/sessions/sess-1/manifest/batch",
    "http://example.test/v1/index/sessions/sess-1/files/batch",
    "http://example.test/v1/index/sessions/sess-1/commit",
  ]);
  assert.equal(new Headers(calls[1].init.headers).get("content-encoding"), "identity");
  assert.match(String(calls[1].init.body), /"relative_path":"README.md"/);
  assert.equal(new Headers(calls[2].init.headers).get("prefer"), "respond-async");
});

test("remote indexWorkspace polls queued background batches before commit", async () => {
  const calls = [];
  let statusReads = 0;
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      calls.push({ input, init });
      if (input.endsWith("/v1/index/sessions")) {
        return jsonResponse(200, {
          ok: true,
          result: {
            session_id: "sess-async",
            workspace_id: "workspace-1",
            collection_name: "collection-1",
            mode: "incremental",
            manifest_revision: 1,
            max_batch_bytes: 1024,
            max_file_size_bytes: 1024,
            max_concurrent_uploads: 1,
          },
        });
      }
      if (input.endsWith("/manifest/batch")) {
        return jsonResponse(200, {
          ok: true,
          result: {
            accepted: 1,
            upload_required: ["README.md"],
            unchanged: 0,
            deletes: 0,
            skipped: 0,
            errors: [],
          },
        });
      }
      if (input.endsWith("/files/batch")) {
        assert.equal(new Headers(init.headers).get("prefer"), "respond-async");
        return jsonResponse(202, {
          ok: true,
          result: {
            files_received: 1,
            files_indexed: 0,
            bytes_uploaded: 0,
            bytes_skipped: 0,
            errors: [],
            queued: true,
            job_id: "job-1",
            phase: "queued",
          },
        });
      }
      if (input.endsWith("/status")) {
        statusReads += 1;
        return jsonResponse(200, {
          ok: true,
          result: {
            session_id: "sess-async",
            workspace_id: "workspace-1",
            collection_name: "collection-1",
            mode: "incremental",
            phase: statusReads === 1 ? "indexing" : "ready_to_commit",
            files_manifested: 1,
            files_indexed: statusReads === 1 ? 0 : 1,
            files_deleted: 0,
            files_unchanged: 0,
            files_skipped: 0,
            bytes_uploaded: statusReads === 1 ? 0 : 8,
            bytes_skipped: 0,
            queue_depth: statusReads === 1 ? 1 : 0,
            pending_batches: 0,
            active_batches: statusReads === 1 ? 1 : 0,
            completed_batches: statusReads === 1 ? 0 : 1,
            failed_batches: 0,
            errors: [],
          },
        });
      }
      if (input.endsWith("/commit")) {
        return jsonResponse(200, {
          ok: true,
          result: { documents_indexed: 1 },
          status: { phase: "completed" },
        });
      }
      throw new Error(`Unexpected request: ${input}`);
    },
  });

  const result = await client.indexWorkspace({
    workspace: { workspaceId: "workspace-1" },
    files: [{ relativePath: "README.md", content: "# Demo\n" }],
    processingPollMs: 10,
    processingTimeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  // Drain the documentation tier, then verify no manifest uploads remain.
  assert.equal(statusReads, 3);
  assert.equal(calls.at(-1).input, "http://example.test/v1/index/sessions/sess-async/commit");
});

test("remote indexWorkspace splits uploads at the server-advertised file cap", async () => {
  const uploadBatchSizes = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      if (input.endsWith("/v1/index/sessions")) {
        return jsonResponse(200, {
          ok: true,
          result: {
            session_id: "sess-file-cap",
            workspace_id: "workspace-1",
            collection_name: "collection-1",
            mode: "incremental",
            manifest_revision: 1,
            max_batch_bytes: 1024,
            max_batch_files: 2,
            max_file_size_bytes: 1024,
            max_concurrent_uploads: 1,
          },
        });
      }
      if (input.endsWith("/manifest/batch")) {
        return jsonResponse(200, {
          ok: true,
          result: {
            accepted: 3,
            upload_required: ["one.md", "two.md", "three.md"],
            unchanged: 0,
            deletes: 0,
            skipped: 0,
            errors: [],
          },
        });
      }
      if (input.endsWith("/files/batch")) {
        const body = Buffer.from(await init.body.arrayBuffer());
        uploadBatchSizes.push(
          ["one.md", "two.md", "three.md"].filter((path) => body.includes(path)).length,
        );
        return jsonResponse(200, {
          ok: true,
          result: {
            files_received: uploadBatchSizes.at(-1),
            files_indexed: uploadBatchSizes.at(-1),
            bytes_uploaded: 1,
            bytes_skipped: 0,
            errors: [],
          },
        });
      }
      return jsonResponse(200, {
        ok: true,
        result: { documents_indexed: 3 },
        status: {
          session_id: "sess-file-cap",
          workspace_id: "workspace-1",
          collection_name: "collection-1",
          mode: "incremental",
          phase: "completed",
          files_manifested: 3,
          files_indexed: 3,
          files_deleted: 0,
          files_unchanged: 0,
          files_skipped: 0,
          bytes_uploaded: 3,
          bytes_skipped: 0,
          queue_depth: 0,
          errors: [],
        },
      });
    },
  });

  await client.indexWorkspace({
    workspace: { workspaceId: "workspace-1" },
    files: [
      { relativePath: "one.md", content: "1" },
      { relativePath: "two.md", content: "2" },
      { relativePath: "three.md", content: "3" },
    ],
  });

  assert.deepEqual(uploadBatchSizes, [2, 1]);
});

test("remote indexWorkspace aborts a started session when indexing fails", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      calls.push({ input, init });
      if (input.endsWith("/v1/index/sessions")) {
        return jsonResponse(200, {
          ok: true,
          result: {
            session_id: "sess-failed",
            workspace_id: "workspace-1",
            collection_name: "collection-1",
            mode: "incremental",
            manifest_revision: 1,
            max_batch_bytes: 1024,
            max_file_size_bytes: 1024,
            max_concurrent_uploads: 4,
          },
        });
      }
      if (input.endsWith("/manifest/batch")) {
        return jsonResponse(400, { detail: "bad manifest" });
      }
      if (input.endsWith("/v1/index/sessions/sess-failed")) {
        return jsonResponse(200, { ok: true, session_id: "sess-failed", phase: "aborted" });
      }
      throw new Error(`Unexpected request: ${input}`);
    },
  });

  await assert.rejects(
    client.indexWorkspace({
      workspace: { workspaceId: "workspace-1" },
      files: [{ relativePath: "README.md", content: "# Demo\n" }],
    }),
    CorpusWireHttpError,
  );

  assert.deepEqual(calls.map((call) => call.input), [
    "http://example.test/v1/index/sessions",
    "http://example.test/v1/index/sessions/sess-failed/manifest/batch",
    "http://example.test/v1/index/sessions/sess-failed",
  ]);
  assert.equal(calls[2].init.method, "DELETE");
});

test("manifest rejection preserves bounded details and session identity", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      calls.push({ input, init });
      if (input.endsWith("/v1/index/sessions")) {
        return jsonResponse(200, { ok: true, result: {
          session_id: "sess-manifest", workspace_id: "workspace-1",
          collection_name: "collection-1", mode: "full", manifest_revision: 1,
          max_batch_bytes: 1024, max_batch_files: 1,
          max_file_size_bytes: 1024, max_concurrent_uploads: 1,
        } });
      }
      if (input.endsWith("/manifest/batch")) {
        return jsonResponse(200, { ok: true, result: {
          accepted: 1, upload_required: [], unchanged: 0, deletes: 0, skipped: 1,
          errors: ["line 1:\tinvalid_inventory_entry\nignored"],
        } });
      }
      if (input.endsWith("/v1/index/sessions/sess-manifest")) {
        return jsonResponse(200, { ok: true, session_id: "sess-manifest", phase: "aborted" });
      }
      throw new Error(`Unexpected request: ${input}`);
    },
  });

  await assert.rejects(
    client.indexWorkspace({
      workspace: { workspaceId: "workspace-1" },
      files: [{ relativePath: "README.md", content: "# Demo\n" }],
    }),
    (error) => {
      assert.ok(error instanceof WorkspaceScanIncompleteError);
      assert.equal(error.sessionId, "sess-manifest");
      assert.equal(error.manifestSkipped, 1);
      assert.deepEqual(error.manifestErrors, ["line 1: invalid_inventory_entry ignored"]);
      assert.match(error.message, /line 1: invalid_inventory_entry ignored/);
      assert.equal(error.transfer.files_submitted, 1);
      assert.equal(error.transfer.complete, false);
      return true;
    },
  );
  assert.equal(calls.at(-1).init.method, "DELETE");
});

test("previewIndexWorkspace compares a hashed manifest without starting a session", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(200, {
        ok: true,
        result: {
          workspace_id: "workspace-1",
          collection_name: "collection-1",
          requested_mode: "full",
          expected_mode: "no_change",
          candidates: 1,
          included: 1,
          excluded: 0,
          changed: 0,
          unchanged: 1,
          deleted: 0,
          candidate_bytes: 7,
          destructive_risk: false,
        },
      });
    },
  });

  const result = await client.previewIndexWorkspace({
    workspace: { workspaceId: "workspace-1" },
    mode: "full",
    files: [{ relativePath: "README.md", content: "# Demo\n" }],
  });

  assert.equal(result.expected_mode, "no_change");
  assert.deepEqual(calls.map((call) => call.input), ["http://example.test/v1/index/preview"]);
  const payload = JSON.parse(calls[0].init.body);
  assert.match(payload.manifest[0].sha256, /^[0-9a-f]{64}$/);
});

test("remote indexWorkspace emits monotonic semantic progress and 100 once", async () => {
  const progress = [];
  let statusCalls = 0;
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input) => {
      if (input.endsWith("/v1/index/sessions")) {
        return jsonResponse(200, { ok: true, result: {
          session_id: "sess-progress", workspace_id: "workspace-1", collection_name: "collection-1",
          mode: "full", manifest_revision: 1, max_batch_bytes: 1024, max_batch_files: 1,
          max_file_size_bytes: 1024, max_concurrent_uploads: 1,
        } });
      }
      if (input.endsWith("/manifest/batch")) {
        return jsonResponse(200, { ok: true, result: {
          accepted: 1, upload_required: ["README.md"], unchanged: 0, deletes: 0, skipped: 0, errors: [],
        } });
      }
      if (input.endsWith("/files/batch")) {
        return jsonResponse(202, { ok: true, result: {
          files_received: 1, files_indexed: 0, bytes_uploaded: 0, bytes_skipped: 0,
          errors: [], queued: true, job_id: "job-1", phase: "queued",
        } });
      }
      if (input.endsWith("/status")) {
        statusCalls += 1;
        const completed = statusCalls > 1;
        return jsonResponse(200, { ok: true, result: {
          session_id: "sess-progress", workspace_id: "workspace-1", collection_name: "collection-1",
          mode: "full", phase: completed ? "ready_to_commit" : "indexing",
          files_manifested: 1, files_indexed: completed ? 1 : 0, files_deleted: 0,
          files_unchanged: 0, files_skipped: 0, bytes_uploaded: completed ? 7 : 0,
          bytes_skipped: 0, queue_depth: completed ? 0 : 1, pending_batches: 0,
          active_batches: completed ? 0 : 1, errors: [],
          progress: progressEvent(statusCalls, completed ? 99 : 25, completed ? "vector_writes" : "embedding"),
        } });
      }
      if (input.endsWith("/commit")) {
        return jsonResponse(200, { ok: true, result: { documents_indexed: 1 }, status: {
          session_id: "sess-progress", workspace_id: "workspace-1", collection_name: "collection-1",
          mode: "full", phase: "completed", files_manifested: 1, files_indexed: 1,
          files_deleted: 0, files_unchanged: 0, files_skipped: 0, bytes_uploaded: 7,
          bytes_skipped: 0, queue_depth: 0, errors: [],
          progress: { ...progressEvent(3, 100, "completed"), state: "completed", verification_status: "verified" },
        } });
      }
      throw new Error(`Unexpected request: ${input}`);
    },
  });

  await client.indexWorkspace({
    workspace: { workspaceId: "workspace-1" },
    files: [{ relativePath: "README.md", content: "# Demo\n" }],
    processingPollMs: 1,
    onProgress: (event) => progress.push(event),
  });

  const percentages = progress.map((event) => event.overall_percent).filter((value) => value !== null);
  assert.deepEqual(percentages, [...percentages].sort((left, right) => left - right));
  assert.equal(percentages.filter((value) => value === 100).length, 1);
  assert.ok(progress.some((event) => event.phase === "uploading"));
  assert.ok(progress.some((event) => event.phase === "embedding"));
});

test("explicit processing timeout detaches without aborting backend work", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input) => {
      calls.push(input);
      if (input.endsWith("/v1/index/sessions")) {
        return jsonResponse(200, { ok: true, result: {
          session_id: "sess-timeout", workspace_id: "workspace-1", collection_name: "collection-1",
          mode: "full", manifest_revision: 1, max_batch_bytes: 1024, max_batch_files: 1,
          max_file_size_bytes: 1024, max_concurrent_uploads: 1,
        } });
      }
      if (input.endsWith("/manifest/batch")) {
        return jsonResponse(200, { ok: true, result: {
          accepted: 1, upload_required: ["README.md"], unchanged: 0, deletes: 0, skipped: 0, errors: [],
        } });
      }
      if (input.endsWith("/files/batch")) {
        return jsonResponse(202, { ok: true, result: {
          files_received: 1, files_indexed: 0, bytes_uploaded: 0, bytes_skipped: 0, errors: [], queued: true,
        } });
      }
      if (input.endsWith("/status")) {
        return jsonResponse(200, { ok: true, result: {
          session_id: "sess-timeout", workspace_id: "workspace-1", collection_name: "collection-1",
          mode: "full", phase: "indexing", files_manifested: 1, files_indexed: 0,
          files_deleted: 0, files_unchanged: 0, files_skipped: 0, bytes_uploaded: 0,
          bytes_skipped: 0, queue_depth: 1, pending_batches: 0, active_batches: 1, errors: [],
        } });
      }
      throw new Error(`Unexpected request: ${input}`);
    },
  });

  await assert.rejects(client.indexWorkspace({
    workspace: { workspaceId: "workspace-1" },
    files: [{ relativePath: "README.md", content: "# Demo\n" }],
    processingTimeoutMs: 1,
    processingPollMs: 1,
  }), RemoteIndexDetachedError);
  assert.equal(calls.some((input) => input.endsWith("/sess-timeout")), false);
});

test("AbortSignal sends a backend abort and waits for terminal acknowledgement", async () => {
  const calls = [];
  let aborted = false;
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init = {}) => {
      calls.push({ input, method: init.method ?? "GET" });
      if (input.endsWith("/v1/index/sessions")) {
        return jsonResponse(200, { ok: true, result: {
          session_id: "sess-cancel", workspace_id: "workspace-1", collection_name: "collection-1",
          mode: "full", manifest_revision: 1, max_batch_bytes: 1024, max_batch_files: 1,
          max_file_size_bytes: 1024, max_concurrent_uploads: 1,
        } });
      }
      if (input.endsWith("/manifest/batch")) {
        return jsonResponse(200, { ok: true, result: {
          accepted: 1, upload_required: ["README.md"], unchanged: 0, deletes: 0, skipped: 0, errors: [],
        } });
      }
      if (input.endsWith("/files/batch")) {
        return jsonResponse(202, { ok: true, result: {
          files_received: 1, files_indexed: 0, bytes_uploaded: 0, bytes_skipped: 0, errors: [], queued: true,
        } });
      }
      if (input.endsWith("/status")) {
        return jsonResponse(200, { ok: true, result: {
          session_id: "sess-cancel", workspace_id: "workspace-1", collection_name: "collection-1",
          mode: "full", phase: aborted ? "aborted" : "indexing", files_manifested: 1,
          files_indexed: 0, files_deleted: 0, files_unchanged: 0, files_skipped: 0,
          bytes_uploaded: 0, bytes_skipped: 0, queue_depth: aborted ? 0 : 1,
          pending_batches: 0, active_batches: aborted ? 0 : 1, errors: [],
        } });
      }
      if (input.endsWith("/sess-cancel") && init.method === "DELETE") {
        aborted = true;
        return jsonResponse(200, { ok: true, session_id: "sess-cancel", phase: "cancelling" });
      }
      throw new Error(`Unexpected request: ${input}`);
    },
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(client.indexWorkspace({
    workspace: { workspaceId: "workspace-1" },
    files: [{ relativePath: "README.md", content: "# Demo\n" }],
    processingPollMs: 1,
    signal: controller.signal,
  }), RemoteIndexCancelledError);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
  assert.equal(calls.some((call) => call.input.endsWith("/commit")), false);
});

test("a second-interrupt detach cannot overtake the first backend abort", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init = {}) => {
      calls.push({ input, method: init.method ?? "GET" });
      if (input.endsWith("/status")) {
        return jsonResponse(200, { ok: true, result: {
          session_id: "sess-double-interrupt", workspace_id: "workspace-1",
          collection_name: "collection-1", mode: "full", phase: "indexing",
          files_manifested: 1, files_indexed: 0, files_deleted: 0,
          files_unchanged: 0, files_skipped: 0, bytes_uploaded: 0,
          bytes_skipped: 0, queue_depth: 1, pending_batches: 0,
          active_batches: 1, errors: [],
        } });
      }
      if (input.endsWith("/sess-double-interrupt") && init.method === "DELETE") {
        return jsonResponse(200, {
          ok: true,
          session_id: "sess-double-interrupt",
          phase: "cancelling",
        });
      }
      throw new Error(`Unexpected request: ${input}`);
    },
  });
  const cancelController = new AbortController();
  const detachController = new AbortController();
  cancelController.abort();
  detachController.abort();

  await assert.rejects(client.followIndexSession("sess-double-interrupt", {
    signal: cancelController.signal,
    detachSignal: detachController.signal,
    pollMs: 1,
  }), RemoteIndexDetachedError);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
});

function progressEvent(sequence, percent, phase) {
  return {
    schema_version: "index-progress/v1", sequence, session_id: "sess-progress", workspace_id: "workspace-1",
    occurred_at: new Date().toISOString(), phase, state: "running", message: phase,
    overall_completed: percent, overall_total: 100, overall_percent: percent, overall_indeterminate: false,
    phase_completed: percent, phase_total: 100, unit: "items", elapsed_ms: sequence * 10,
    phase_elapsed_ms: sequence * 10, throughput_per_second: 1, queue_depth: 0, retries: 0,
    warnings: [], eta_seconds: null, eta_confidence: "unknown", heartbeat: false,
    last_progress_at: new Date().toISOString(), last_heartbeat_at: null, active_heartbeat: false,
    counts: {}, phase_timings_ms: {}, verification_status: "pending",
  };
}

test("index event helpers query activity endpoints", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input) => {
      calls.push(input);
      if (input.includes("/events")) {
        return jsonResponse(200, {
          ok: true,
          events: [
            {
              event_id: "evt-1",
              occurred_at: "2026-05-10T09:00:00+00:00",
              operation: "local_ingest",
              status: "completed",
              files_manifested: 1,
              files_indexed: 1,
              files_deleted: 0,
              files_unchanged: 0,
              files_skipped: 0,
              chunks_indexed: 2,
              bytes_uploaded: 0,
              bytes_skipped: 0,
            },
          ],
        });
      }
      return jsonResponse(200, {
        ok: true,
        activity: {
          available: true,
          events_in_window: 1,
          last_attempt_status: "completed",
          gap_detected: false,
        },
      });
    },
  });

  const events = await client.getIndexEvents({ workspaceId: "workspace-1", limit: 5 });
  const activity = await client.getIndexActivity({ workspaceId: "workspace-1", windowHours: 12 });

  assert.deepEqual(calls, [
    "http://example.test/v1/index/events?workspace_id=workspace-1&limit=5",
    "http://example.test/v1/index/activity?workspace_id=workspace-1&window_hours=12",
  ]);
  assert.equal(events[0].event_id, "evt-1");
  assert.equal(activity.last_attempt_status, "completed");
});

test("listIndexSessions queries active remote index sessions", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input) => {
      calls.push(input);
      return jsonResponse(200, {
        ok: true,
        sessions: [
          {
            session_id: "sess-1",
            workspace_id: "workspace-1",
            collection_name: "collection-1",
            mode: "incremental",
            manifest_revision: 1,
            phase: "receiving_manifest",
            files_manifested: 0,
            files_indexed: 0,
            files_deleted: 0,
            files_unchanged: 0,
            files_skipped: 0,
            bytes_uploaded: 0,
            bytes_skipped: 0,
            queue_depth: 0,
            age_seconds: 4,
            idle_seconds: 2,
            idle_timeout_seconds: 900,
            errors: [],
          },
        ],
      });
    },
  });

  const sessions = await client.listIndexSessions({ workspaceId: "workspace-1" });

  assert.deepEqual(calls, ["http://example.test/v1/index/sessions?workspace_id=workspace-1"]);
  assert.equal(sessions[0].session_id, "sess-1");
  assert.equal(sessions[0].phase, "receiving_manifest");
  assert.equal(sessions[0].age_seconds, 4);
  assert.equal(sessions[0].idle_seconds, 2);
});

test("createBasicAuthHeader encodes credentials for backend auth", () => {
  assert.equal(createBasicAuthHeader("user:pass"), "Basic dXNlcjpwYXNz");
});

test("createBearerAuthHeader formats service and OIDC tokens", () => {
  assert.equal(createBearerAuthHeader(" service-token "), "Bearer service-token");
  assert.throws(() => createBearerAuthHeader("   "), /must not be empty/);
});

test("CorpusWireClient sends bearer authorization and rejects ambiguous auth", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "https://corpuswire.example",
    bearerToken: "service-token",
    fetchFn: async (input, init) => {
      calls.push({ input, headers: new Headers(init?.headers) });
      return jsonResponse(200, { ok: true });
    },
  });

  await client.health();

  assert.equal(calls[0].headers.get("authorization"), "Bearer service-token");
  assert.throws(
    () => new CorpusWireClient({ basicAuth: "user:pass", bearerToken: "service-token" }),
    /exactly one CorpusWire authorization method/,
  );
});

test("Codebase and provider management methods use dedicated operational endpoints", async () => {
  const calls = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      calls.push({ input, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
      if (input.endsWith("/repositories")) {
        return jsonResponse(200, { repositories: [] });
      }
      if (input.includes("provider-bindings/github")) {
        return jsonResponse(200, init?.method === "DELETE"
          ? { binding: { status: "revoked" } }
          : { container: {}, binding: {} });
      }
      return jsonResponse(init?.method === "POST" ? 201 : 200, {
        codebase_id: "codebase-1",
        display_name: "Payments",
      });
    },
  });

  await client.createCodebase({ displayName: "Payments" });
  await client.updateCodebase("codebase-1", { displayName: "Payment Platform" });
  await client.listCodebaseRepositories("codebase-1");
  await client.bindGitHubProvider("codebase-1", {
    installationId: "installation-42",
    displayName: "Acme GitHub",
    repositoryAllowlist: [],
  });
  await client.revokeGitHubProvider("codebase-1", "installation-42");

  assert.deepEqual(calls, [
    {
      input: "http://example.test/v1/codebases",
      method: "POST",
      body: { display_name: "Payments" },
    },
    {
      input: "http://example.test/v1/codebases/codebase-1",
      method: "PATCH",
      body: { display_name: "Payment Platform" },
    },
    {
      input: "http://example.test/v1/codebases/codebase-1/repositories",
      method: "GET",
      body: null,
    },
    {
      input: "http://example.test/v1/codebases/codebase-1/provider-bindings/github",
      method: "POST",
      body: {
        installation_id: "installation-42",
        display_name: "Acme GitHub",
        repository_allowlist: [],
      },
    },
    {
      input: "http://example.test/v1/codebases/codebase-1/provider-bindings/github"
        + "?installation_id=installation-42&provider_host=github.com",
      method: "DELETE",
      body: null,
    },
  ]);
});

test("review context request polling, timeout, and cancellation are typed", async () => {
  let polls = 0;
  const job = {
    schema_version: "review-context/v1",
    job_id: "job-1",
    request_id: "request-1",
    tenant_id: "tenant-a",
    codebase_id: "codebase-1",
    state: "running",
    attempts: 1,
    status_url: "/v1/review-context/jobs/job-1",
    retry_after_seconds: 0,
    created_at: "2026-08-02T15:00:00Z",
    updated_at: "2026-08-02T15:00:00Z",
    partial_reasons: [],
  };
  const complete = {
    schema_version: "review-context/v1",
    request_id: "request-1",
    telemetry_id: "telemetry-1",
    review_id: "42",
    target_repository_id: "repo-1",
    freshness: "exact",
    evidence: [],
  };
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      if (init?.method === "POST") {
        return jsonResponse(202, job, { "Retry-After": "0" });
      }
      polls += 1;
      return jsonResponse(200, complete);
    },
  });

  const result = await client.requestReviewContextAndWait(
    {
      codebaseId: "codebase-1",
      targetRepositoryId: "repo-1",
      providerReviewId: "42",
      objective: "Find affected consumers",
    },
    { timeoutMs: 1_000, pollIntervalMs: 0 },
  );
  assert.equal(result.freshness, "exact");
  assert.equal(polls, 1);

  await assert.rejects(
    client.pollReviewContextJob(job, { timeoutMs: 0 }),
    ReviewContextPollingTimeoutError,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.pollReviewContextJob(job, { signal: controller.signal }),
    ReviewContextPollingCancelledError,
  );
});

function completeReviewResponseV2({ withBundle = false } = {}) {
  const baseSha = "1".repeat(40);
  const headSha = "2".repeat(40);
  const digest = "a".repeat(64);
  const diffDigest = "6".repeat(64);
  const sourceRange = {
    schema_version: "review-context/v2", start_line: 1, end_line: 1,
    start_column: null, end_column: null,
  };
  const provenance = {
    schema_version: "review-context/v2", extractor_id: "test-extractor",
    extractor_version: "1", evidence_tier: "compiler", resolution_status: "exact",
    confidence: 1, reason_codes: [], artifact_digest: null,
  };
  const makeInstance = (side, text) => ({
    schema_version: "review-context/v2", symbol_id: "symbol-a",
    symbol_instance_id: `${side}-instance`, repository_id: "repo-1",
    revision: side === "base" ? baseSha : headSha,
    layer: side === "base" ? "snapshot" : "overlay", path: "src/example.py",
    source_range: sourceRange, language: "python", project_root: ".",
    qualified_name: "example.target", display_name: "target", kind: "function",
    signature: "()", source_content_sha256: digest,
    symbol_extent_sha256: createHash("sha256").update(text).digest("hex"),
    stable_declaration_identity: null, provenance,
  });
  const baseText = "BASE\n";
  const headText = "HEAD\n";
  const base = makeInstance("base", baseText);
  const head = makeInstance("head", headText);
  const makeExtent = (side, instance, text) => ({
    schema_version: "review-context/v2", side,
    evidence_id: canonicalExtentId("change-a", side, instance),
    symbol_instance_id: instance.symbol_instance_id, repository_id: instance.repository_id,
    revision: instance.revision, layer: instance.layer, path: instance.path,
    symbol_source_range: sourceRange, extent_start_line: 1, extent_end_line: 1,
    source_content_sha256: instance.source_content_sha256,
    symbol_extent_sha256: instance.symbol_extent_sha256, text, token_count: 1,
  });
  const bundle = {
    schema_version: "review-context/v2", ordinal: 0,
    change_record: {
      schema_version: "review-context/v2", change_id: "change-a",
      logical_identity: "logical-a", base, head, change_kind: "modified",
      pairing_status: "exact_symbol_id", continuity_status: "proven",
      pairing_confidence: 1, pairing_group: null,
      diff_evidence: {
        schema_version: "review-context/v2", normalized_diff_hash: diffDigest,
        path: "src/example.py", previous_path: null, change_kind: "modified",
        content_kind: "text", patch_status: "complete", additions: 0, deletions: 0,
      },
      normalized_hunks: [], relationship_deltas: [],
      base_observation: {
        schema_version: "review-context/v2", path: "src/example.py",
        path_role: "modified_base", source_state: "present", analyzer_state: "complete",
        analyzed_scope_complete: true, source_content_sha256: digest, reason_codes: [],
      },
      head_observation: {
        schema_version: "review-context/v2", path: "src/example.py",
        path_role: "modified_head", source_state: "present", analyzer_state: "complete",
        analyzed_scope_complete: true, source_content_sha256: digest, reason_codes: [],
      },
      completeness: {
        schema_version: "review-context/v2", symbol_pair_complete: true,
        normalized_hunks_complete: true, relationship_deltas_complete: true,
        complete: true, reason_codes: [],
      },
    },
    base_evidence: makeExtent("base", base, baseText),
    head_evidence: makeExtent("head", head, headText), related_evidence: [],
    completeness: {
      schema_version: "review-context/v2", required_sides_complete: true,
      related_evidence_complete: true, reason_codes: [],
    },
    evidence_item_count: 2, serialized_tokens: 2,
    serialized_characters: 10, serialized_utf8_bytes: 10,
  };
  return {
    schema_version: "review-context/v2", request_id: "request-v2",
    telemetry_id: "telemetry-v2", job_id: "job-v2", review_id: "42",
    target_repository_id: "repo-1",
    review_scope: {
      schema_version: "review-context/v2", tenant_id: "tenant-a", actor_id: "actor-a",
      codebase_id: "codebase-1", target_repository_id: "repo-1",
      authorized_repository_ids: ["repo-1"], repository_set_id: "set-1",
      repository_selection_digest: digest, base_snapshot_id: "snapshot-v2",
      base_snapshot_generation: 3, base_snapshot_refresh_sequence: 0,
      overlay_id: "overlay-v2", overlay_generation: 4, overlay_refresh_sequence: 0,
    },
    base_sha: baseSha, head_sha: headSha, base_snapshot_id: "snapshot-v2",
    base_snapshot_generation: 3, base_snapshot_refresh_sequence: 0,
    base_artifact_contract_version: "snapshot-artifacts/v2",
    base_snapshot_builder_version: "snapshot-builder-v2", base_build_policy_digest: digest,
    overlay_id: "overlay-v2", overlay_generation: 4, overlay_refresh_sequence: 0,
    artifact_contract_version: "review-artifacts/v2",
    evidence_builder_version: "evidence-builder-v2", overlay_build_policy_digest: digest,
    normalized_diff_hash: diffDigest, freshness: "exact",
    bundles: withBundle ? [bundle] : [], omitted_bundles: [],
    serialized_token_count: withBundle ? 2 : 0,
    serialized_character_count: withBundle ? 10 : 0,
    serialized_utf8_byte_count: withBundle ? 10 : 0,
    partial: false, partial_reasons: [], retry_guidance: null,
  };
}

function completeReviewJobV2() {
  return {
    schema_version: "review-context/v2", contract_version: "review-context/v2",
    job_id: "job-v2", request_id: "request-v2", tenant_id: "tenant-a",
    codebase_id: "codebase-1", repository_set_id: "set-1",
    repository_selection_digest: "a".repeat(64), state: "running", attempts: 1,
    status_url: "/v2/review-context/jobs/job-v2", retry_after_seconds: 0,
    created_at: "2026-08-19T12:00:00Z", updated_at: "2026-08-19T12:00:01Z",
    overlay_id: null, overlay_generation: null, overlay_refresh_sequence: null,
    partial_reasons: [],
  };
}

function completeReviewCapabilitiesV2() {
  return {
    schema_version: "review-context/v2", contract_version: "review-context/v2",
    enabled: true, service_available: true, construction_enabled: true,
    publication_enabled: true, read_enabled: true, routes_enabled: true,
    supports_polling: true, supports_cancellation: true,
    supports_repository_set_scoped_status: true,
    snapshot_artifact_contract_version: "snapshot-artifacts/v2",
    snapshot_builder_version: "snapshot-builder-v2",
    artifact_contract_version: "review-artifacts/v2",
    evidence_builder_version: "evidence-builder-v2", build_policy_digest: "a".repeat(64),
    limits: {
      schema_version: "review-context/v2", max_records: 200,
      max_symbol_extent_utf8_bytes_per_side: 131072,
      max_symbol_extent_utf8_bytes_per_overlay: 8388608,
      max_serialized_bundle_bytes: 524288, max_serialized_response_bytes: 2097152,
      construction_timeout_ms: 2000, base_rebuild_timeout_ms: 300000,
      max_refresh_sequences_per_lineage: 3,
    },
  };
}

function completeReviewStatusV2() {
  return {
    schema_version: "review-context/v2", contract_version: "review-context/v2",
    codebase_id: "codebase-1", review_id: "42", target_repository_id: "repo-1",
    head_sha: "2".repeat(40),
    publications: [{
      schema_version: "review-context/v2", repository_set_id: "set-1",
      repository_selection_digest: "a".repeat(64), target_repository_id: "repo-1",
      base_sha: "1".repeat(40), head_sha: "2".repeat(40),
      base_snapshot_id: "snapshot-v2", base_snapshot_generation: 3,
      base_snapshot_refresh_sequence: 0, overlay_id: "overlay-v2",
      overlay_generation: 4, overlay_refresh_sequence: 0, state: "ready",
      freshness: "exact", evidence_state: "ready", warning_count: 0,
      published_at: "2026-08-19T12:00:02Z",
    }],
    latest_jobs: [],
  };
}

test("review context v2 uses only v2 request, poll, status, capability, and cancellation routes", async () => {
  const calls = [];
  let polls = 0;
  const job = {
    schema_version: "review-context/v2",
    contract_version: "review-context/v2",
    job_id: "job-v2",
    request_id: "request-v2",
    tenant_id: "tenant-a",
    codebase_id: "codebase-1",
    repository_set_id: "set-1",
    repository_selection_digest: "a".repeat(64),
    state: "running",
    attempts: 1,
    status_url: "/v2/review-context/jobs/job-v2",
    retry_after_seconds: 0,
    created_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:01Z",
    overlay_id: null,
    overlay_generation: null,
    overlay_refresh_sequence: null,
    partial_reasons: [],
  };
  const response = completeReviewResponseV2();
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      calls.push({ input, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
      if (input.endsWith("/capabilities")) return jsonResponse(200, {
        schema_version: "review-context/v2",
        contract_version: "review-context/v2",
        enabled: true, service_available: true, construction_enabled: true,
        publication_enabled: true, read_enabled: true, routes_enabled: true,
        supports_polling: true, supports_cancellation: true,
        supports_repository_set_scoped_status: true,
        snapshot_artifact_contract_version: "snapshot-artifacts/v2",
        snapshot_builder_version: "snapshot-builder-v2",
        artifact_contract_version: "review-artifacts/v2",
        evidence_builder_version: "evidence-builder-v2",
        build_policy_digest: "a".repeat(64),
        limits: {
          schema_version: "review-context/v2", max_records: 200,
          max_symbol_extent_utf8_bytes_per_side: 131072,
          max_symbol_extent_utf8_bytes_per_overlay: 8388608,
          max_serialized_bundle_bytes: 524288, max_serialized_response_bytes: 2097152,
          construction_timeout_ms: 2000, base_rebuild_timeout_ms: 300000,
          max_refresh_sequences_per_lineage: 3,
        },
      });
      if (input.endsWith("/reviews/42/status")) return jsonResponse(200, {
        schema_version: "review-context/v2",
        contract_version: "review-context/v2",
        codebase_id: "codebase-1", review_id: "42", target_repository_id: "repo-1",
        head_sha: "2".repeat(40),
        publications: [],
        latest_jobs: [],
      });
      if (init?.method === "DELETE") return jsonResponse(200, { ...job, state: "cancelled", retry_after_seconds: null });
      if (init?.method === "POST") return jsonResponse(202, job);
      polls += 1;
      return jsonResponse(200, response);
    },
  });

  await client.getReviewContextCapabilitiesV2();
  const result = await client.requestReviewContextV2AndWait({
    codebaseId: "codebase-1",
    targetRepositoryId: "repo-1",
    providerReviewId: "42",
    objective: "Compare exact symbol changes",
  }, { timeoutMs: 1_000, pollIntervalMs: 0 });
  assert.equal(result.freshness, "exact");
  await client.getReviewStatusV2("codebase-1", "42");
  const cancelled = await client.cancelReviewContextJobV2("job-v2");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(polls, 1);
  assert.deepEqual(calls.map(({ input, method }) => ({ input, method })), [
    { input: "http://example.test/v2/review-context/capabilities", method: "GET" },
    { input: "http://example.test/v2/codebases/codebase-1/reviews/context", method: "POST" },
    { input: "http://example.test/v2/review-context/jobs/job-v2", method: "GET" },
    { input: "http://example.test/v2/codebases/codebase-1/reviews/42/status", method: "GET" },
    { input: "http://example.test/v2/review-context/jobs/job-v2", method: "DELETE" },
  ]);
  assert.equal(calls[1].body.schema_version, "review-context/v2");
  assert.equal(calls.some((call) => call.input.includes("/v1/")), false);
});

test("review context v2 fails closed on an unknown future response contract", async () => {
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async () => jsonResponse(200, {
      schema_version: "review-context/v3",
      request_id: "future-request",
      bundles: [],
    }),
  });

  await assert.rejects(
    client.requestReviewContextV2({
      codebaseId: "codebase-1",
      targetRepositoryId: "repo-1",
      providerReviewId: "42",
      objective: "Compare exact symbol changes",
    }),
    /Unsupported request result schema_version: review-context\/v3/,
  );
});

test("review context v2 rejects mismatched contract versions on capabilities and jobs", async () => {
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input) => jsonResponse(200, input.endsWith("/capabilities")
      ? {
          schema_version: "review-context/v2",
          contract_version: "review-context/v3",
        }
      : {
          schema_version: "review-context/v2",
          contract_version: "review-context/v3",
          job_id: "future-job",
          state: "running",
        }),
  });

  await assert.rejects(
    client.getReviewContextCapabilitiesV2(),
    /Unsupported capabilities contract_version: review-context\/v3/,
  );
  await assert.rejects(
    client.requestReviewContextV2({
      codebaseId: "codebase-1",
      targetRepositoryId: "repo-1",
      providerReviewId: "42",
      objective: "Compare exact symbol changes",
    }),
    /Unsupported request result contract_version: review-context\/v3/,
  );
});

test("review context v2 fails closed on unknown nested discriminants and malformed bundles", async () => {
  const validResponse = completeReviewResponseV2({ withBundle: true });
  const cases = [
    [
      { ...validResponse, bundles: validResponse.bundles.map((bundle) => ({
        ...bundle,
        change_record: { ...bundle.change_record, change_kind: "future_kind" },
      })) },
      /Unsupported v2 symbol change_kind: future_kind/,
    ],
    [
      { ...validResponse, bundles: validResponse.bundles.map((bundle) => ({
        ...bundle,
        change_record: { ...bundle.change_record, pairing_status: "future_pairing" },
      })) },
      /Unsupported v2 symbol pairing_status: future_pairing/,
    ],
    [
      { ...validResponse, bundles: validResponse.bundles.map((bundle) => ({
        ...bundle,
        change_record: { ...bundle.change_record, continuity_status: "future_continuity" },
      })) },
      /Unsupported v2 symbol continuity_status: future_continuity/,
    ],
    [
      { ...validResponse, bundles: validResponse.bundles.map((bundle) => ({
        ...bundle,
        change_record: {
          ...bundle.change_record,
          relationship_deltas: [{
            schema_version: "review-context/v2",
            status: "future_delta",
            direction: "outgoing",
            base_fact: null,
            head_fact: null,
          }],
        },
      })) },
      /Malformed request result v2 response contract/,
    ],
    [
      { ...validResponse, bundles: null },
      /Malformed request result v2 response contract/,
    ],
    [
      {
        ...validResponse,
        bundles: [],
        omitted_bundles: [{
          schema_version: "review-context/v2",
          change_id: "change-v2",
          ordinal: 0,
          change_kind: "added",
          pairing_status: "one_sided",
          reason: "future_reason",
          omitted_sides: ["head"],
          minimum_required_budget: null,
          model_evidence_available: false,
        }],
      },
      /Unsupported v2 omission reason: future_reason/,
    ],
  ];

  for (const [response, expected] of cases) {
    const client = new CorpusWireClient({
      baseUrl: "http://example.test",
      fetchFn: async () => jsonResponse(200, response),
    });
    await assert.rejects(
      client.requestReviewContextV2({
        codebaseId: "codebase-1",
        targetRepositoryId: "repo-1",
        providerReviewId: "42",
        objective: "Compare exact symbol changes",
      }),
      expected,
    );
  }
});

test("review context v2 validates cancellation jobs and nested status jobs", async () => {
  for (const path of ["cancel", "status"]) {
    const client = new CorpusWireClient({
      baseUrl: "http://example.test",
      fetchFn: async () => jsonResponse(200, path === "cancel"
        ? {
            schema_version: "review-context/v2",
            contract_version: "review-context/v2",
            job_id: "job-v2",
            state: "future_state",
            partial_reasons: [],
          }
        : {
            schema_version: "review-context/v2",
            contract_version: "review-context/v2",
            publications: [],
            latest_jobs: [{
              schema_version: "review-context/v2",
              contract_version: "review-context/v2",
              job_id: "job-v2",
              state: "future_state",
              partial_reasons: [],
            }],
          }),
    });
    await assert.rejects(
      path === "cancel"
        ? client.cancelReviewContextJobV2("job-v2")
        : client.getReviewStatusV2("codebase-1", "42"),
      /(?:Unsupported .* state: future_state|Malformed status result v2 status envelope)/,
    );
  }
});

test("review context v2 exhaustive validator rejects required-field, enum, and extent drift", () => {
  const valid = completeReviewResponseV2({ withBundle: true });
  assert.doesNotThrow(() => assertReviewContextV2Result(valid));
  const schemaObjects = [
    ["ReviewContextResponseV2", []],
    ["ReviewScopeV2", ["review_scope"]],
    ["AdmittedSymbolChangeEvidenceBundleV2", ["bundles", 0]],
    ["SymbolChangeRecordV2", ["bundles", 0, "change_record"]],
    ["SymbolInstanceEvidenceV2", ["bundles", 0, "change_record", "base"]],
    ["SourceRangeV2", ["bundles", 0, "change_record", "base", "source_range"]],
    ["ExtractorProvenanceV2", ["bundles", 0, "change_record", "base", "provenance"]],
    ["NormalizedFileDiffEvidenceV2", ["bundles", 0, "change_record", "diff_evidence"]],
    ["ReviewSidePathObservationV2", ["bundles", 0, "change_record", "base_observation"]],
    ["ChangeEvidenceCompletenessV2", ["bundles", 0, "change_record", "completeness"]],
    ["SymbolExtentEvidenceV2", ["bundles", 0, "base_evidence"]],
    ["BundleCompletenessV2", ["bundles", 0, "completeness"]],
  ];
  for (const [modelName, objectPath] of schemaObjects) {
    for (const field of REVIEW_CONTEXT_V2_SCHEMA.$defs[modelName].required) {
      const candidate = structuredClone(valid);
      let owner = candidate;
      for (const segment of objectPath) owner = owner[segment];
      delete owner[field];
      assert.throws(() => assertReviewContextV2Result(candidate), /Malformed/,
        `accepted missing required ${modelName}.${field}`);
    }
  }
  const requiredPaths = [
    ["request_id"], ["telemetry_id"], ["review_scope"], ["base_sha"], ["head_sha"],
    ["base_snapshot_id"], ["overlay_id"], ["normalized_diff_hash"], ["bundles"],
    ["omitted_bundles"], ["serialized_token_count"], ["partial"], ["partial_reasons"],
    ["review_scope", "tenant_id"], ["review_scope", "actor_id"],
    ["review_scope", "authorized_repository_ids"], ["review_scope", "repository_set_id"],
    ["bundles", 0, "change_record"], ["bundles", 0, "base_evidence"],
    ["bundles", 0, "head_evidence"], ["bundles", 0, "evidence_item_count"],
    ["bundles", 0, "change_record", "logical_identity"],
    ["bundles", 0, "change_record", "diff_evidence"],
    ["bundles", 0, "change_record", "base_observation"],
    ["bundles", 0, "change_record", "head_observation"],
    ["bundles", 0, "change_record", "completeness"],
    ["bundles", 0, "change_record", "base", "repository_id"],
    ["bundles", 0, "change_record", "base", "revision"],
    ["bundles", 0, "change_record", "base", "source_range"],
    ["bundles", 0, "change_record", "base", "provenance"],
    ["bundles", 0, "base_evidence", "evidence_id"],
    ["bundles", 0, "base_evidence", "repository_id"],
    ["bundles", 0, "base_evidence", "revision"],
    ["bundles", 0, "base_evidence", "path"],
    ["bundles", 0, "base_evidence", "symbol_source_range"],
    ["bundles", 0, "base_evidence", "source_content_sha256"],
    ["bundles", 0, "base_evidence", "symbol_extent_sha256"],
  ];
  for (const path of requiredPaths) {
    const candidate = structuredClone(valid);
    let owner = candidate;
    for (const segment of path.slice(0, -1)) owner = owner[segment];
    delete owner[path.at(-1)];
    assert.throws(() => assertReviewContextV2Result(candidate), /Malformed/,
      `accepted missing ${path.join(".")}`);
  }
  for (const [path, replacement] of [
    [["freshness"], "future_freshness"],
    [["base_artifact_contract_version"], "snapshot-artifacts/v3"],
    [["artifact_contract_version"], "review-artifacts/v3"],
    [["bundles", 0, "change_record", "change_kind"], "future_change"],
    [["bundles", 0, "change_record", "pairing_status"], "future_pairing"],
    [["bundles", 0, "change_record", "continuity_status"], "future_continuity"],
    [["bundles", 0, "change_record", "diff_evidence", "change_kind"], "future_diff"],
    [["bundles", 0, "change_record", "diff_evidence", "content_kind"], "future_content"],
    [["bundles", 0, "change_record", "diff_evidence", "patch_status"], "future_patch"],
    [["bundles", 0, "change_record", "base_observation", "path_role"], "future_role"],
    [["bundles", 0, "change_record", "base_observation", "source_state"], "future_source"],
    [["bundles", 0, "change_record", "base_observation", "analyzer_state"], "future_analyzer"],
    [["bundles", 0, "change_record", "base", "layer"], "future_layer"],
    [["bundles", 0, "change_record", "base", "provenance", "evidence_tier"], "future_tier"],
    [["bundles", 0, "change_record", "base", "provenance", "resolution_status"], "future_resolution"],
  ]) {
    const candidate = structuredClone(valid);
    let owner = candidate;
    for (const segment of path.slice(0, -1)) owner = owner[segment];
    owner[path.at(-1)] = replacement;
    assert.throws(() => assertReviewContextV2Result(candidate),
      `accepted enum drift ${path.join(".")}`);
  }
  for (const [field, replacement] of [
    ["evidence_id", "symbol-extent:" + "0".repeat(64)], ["repository_id", "repo-other"],
    ["revision", "3".repeat(40)], ["layer", "overlay"], ["path", "src/other.py"],
    ["source_content_sha256", "b".repeat(64)], ["symbol_extent_sha256", "c".repeat(64)],
    ["text", "tampered\n"],
  ]) {
    const candidate = structuredClone(valid);
    candidate.bundles[0].base_evidence[field] = replacement;
    assert.throws(() => assertReviewContextV2Result(candidate),
      `accepted extent drift ${field}`);
  }
});

test("review context v2 semantic validator matches authoritative cross-field invariants", () => {
  const interleaved = completeReviewResponseV2({ withBundle: true });
  interleaved.bundles[0].ordinal = 1;
  interleaved.omitted_bundles = [{
    schema_version: "review-context/v2", change_id: "change-omitted", ordinal: 0,
    change_kind: "added", pairing_status: "one_sided",
    reason: "required_evidence_unavailable", omitted_sides: ["head"],
    minimum_required_budget: null, model_evidence_available: false,
  }];
  interleaved.freshness = "partial";
  interleaved.partial = true;
  assert.doesNotThrow(() => assertReviewContextV2Result(interleaved));

  const reorderedRange = completeReviewResponseV2({ withBundle: true });
  const range = reorderedRange.bundles[0].base_evidence.symbol_source_range;
  reorderedRange.bundles[0].base_evidence.symbol_source_range = {
    end_column: range.end_column, start_column: range.start_column,
    end_line: range.end_line, start_line: range.start_line,
    schema_version: range.schema_version,
  };
  assert.doesNotThrow(() => assertReviewContextV2Result(reorderedRange));

  const invalidLf = completeReviewResponseV2({ withBundle: true });
  const lfExtent = invalidLf.bundles[0].base_evidence;
  lfExtent.text = "first\nsecond\n";
  lfExtent.symbol_extent_sha256 = createHash("sha256").update(lfExtent.text).digest("hex");
  invalidLf.bundles[0].change_record.base.symbol_extent_sha256 = lfExtent.symbol_extent_sha256;
  lfExtent.evidence_id = canonicalExtentId(
    invalidLf.bundles[0].change_record.change_id,
    "base",
    invalidLf.bundles[0].change_record.base,
  );
  assert.throws(() => assertReviewContextV2Result(invalidLf), /Malformed/);

  const invalidColumn = completeReviewResponseV2({ withBundle: true });
  for (const candidateRange of [
    invalidColumn.bundles[0].change_record.base.source_range,
    invalidColumn.bundles[0].base_evidence.symbol_source_range,
  ]) {
    candidateRange.start_column = 8;
    candidateRange.end_column = 2;
  }
  invalidColumn.bundles[0].base_evidence.evidence_id = canonicalExtentId(
    invalidColumn.bundles[0].change_record.change_id,
    "base",
    invalidColumn.bundles[0].change_record.base,
  );
  assert.throws(() => assertReviewContextV2Result(invalidColumn), /Malformed/);

  const invalidClassification = completeReviewResponseV2({ withBundle: true });
  invalidClassification.bundles[0].change_record.change_kind = "ambiguous";
  assert.throws(() => assertReviewContextV2Result(invalidClassification), /Malformed/);

  const invalidObservationHash = completeReviewResponseV2({ withBundle: true });
  invalidObservationHash.bundles[0].change_record.base_observation.source_content_sha256 = "b".repeat(64);
  assert.throws(() => assertReviewContextV2Result(invalidObservationHash), /Malformed/);

  const invalidHunkOrder = completeReviewResponseV2({ withBundle: true });
  invalidHunkOrder.bundles[0].change_record.normalized_hunks = [1, 0].map((ordinal) => {
    const hunk = {
      path: "src/example.py", ordinal, old_start: 1, old_count: 0,
      new_start: 1, new_count: 0, section: null, lines: [],
    };
    return {
      schema_version: "review-context/v2", ...hunk,
      hunk_sha256: createHash("sha256").update(canonicalJsonForTest(hunk)).digest("hex"),
    };
  });
  assert.throws(() => assertReviewContextV2Result(invalidHunkOrder), /Malformed/);
});

test("review context v2 relationship facts stay incident, comparable, published, and authorized", () => {
  const valid = completeReviewResponseV2({ withBundle: true });
  const record = valid.bundles[0].change_record;
  const makeFact = (side, instance, generation) => ({
    schema_version: "review-context/v2", fact_type: "resolved", edge_id: `${side}-edge`,
    direction: "outgoing", relationship_kind: "CALLS",
    changed_logical_identity: record.logical_identity,
    endpoint_logical_identity: "logical-endpoint",
    source_repository_id: instance.repository_id, source_snapshot_id: valid.base_snapshot_id,
    source_generation: generation, source_symbol_id: instance.symbol_id,
    source_symbol_instance_id: instance.symbol_instance_id, source_language: instance.language,
    target_repository_id: instance.repository_id, target_snapshot_id: valid.base_snapshot_id,
    target_generation: generation, target_symbol_id: "target-symbol",
    target_symbol_instance_id: `${side}-target-instance`, target_language: instance.language,
    path: instance.path, source_range: instance.source_range, provenance: instance.provenance,
    resolution_precedence: "local", contract_evidence_id: null,
    contract_coordinate: null, contract_artifact_digest: null,
    revision: instance.revision, layer: instance.layer,
  });
  record.relationship_deltas = [{
    schema_version: "review-context/v2", status: "preserved", relationship_kind: "CALLS",
    direction: "outgoing", changed_logical_identity: record.logical_identity,
    endpoint_logical_identity: "logical-endpoint",
    base_fact: makeFact("base", record.base, valid.base_snapshot_generation),
    head_fact: makeFact("head", record.head, valid.overlay_generation),
    comparison_attributes_changed: [],
    completeness: {
      schema_version: "review-context/v2", base_declaring_unit_observed: true,
      head_declaring_unit_observed: true, incoming_dependents_reanalyzed: false,
      reason_codes: [],
    },
  }];
  assert.doesNotThrow(() => assertReviewContextV2Result(valid));
  const mutations = [
    (value) => { value.bundles[0].change_record.relationship_deltas[0].base_fact.source_generation = 99; },
    (value) => { value.bundles[0].change_record.relationship_deltas[0].head_fact.target_repository_id = "repo-unauthorized"; },
    (value) => { value.bundles[0].change_record.relationship_deltas[0].base_fact.source_symbol_instance_id = "wrong-instance"; },
    (value) => { value.bundles[0].change_record.relationship_deltas[0].base_fact.endpoint_logical_identity = "wrong-endpoint"; },
    (value) => { value.bundles[0].change_record.relationship_deltas[0].completeness.base_declaring_unit_observed = false; },
    (value) => {
      const delta = value.bundles[0].change_record.relationship_deltas[0];
      delta.status = "evidence_changed";
      delta.comparison_attributes_changed = ["zeta", "alpha"];
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.throws(() => assertReviewContextV2Result(candidate), /Malformed/);
  }
});

test("review context v2 capability, job, and status roots reject every required-field deletion", async () => {
  const cases = [
    ["ReviewContextCapabilitiesV2", completeReviewCapabilitiesV2(), [], "capabilities"],
    ["ReviewContextLimitsV2", completeReviewCapabilitiesV2(), ["limits"], "capabilities"],
    ["ReviewContextJobV2", completeReviewJobV2(), [], "job"],
    ["ReviewStatusV2", completeReviewStatusV2(), [], "status"],
    ["ReviewPublicationStatusV2", completeReviewStatusV2(), ["publications", 0], "status"],
  ];
  for (const [modelName, fixture, objectPath, route] of cases) {
    for (const field of REVIEW_CONTEXT_V2_SCHEMA.$defs[modelName].required) {
      const candidate = structuredClone(fixture);
      let owner = candidate;
      for (const segment of objectPath) owner = owner[segment];
      delete owner[field];
      const client = new CorpusWireClient({
        baseUrl: "http://example.test",
        fetchFn: async () => jsonResponse(200, candidate),
      });
      const call = route === "capabilities"
        ? client.getReviewContextCapabilitiesV2()
        : route === "job"
          ? client.cancelReviewContextJobV2("job-v2")
          : client.getReviewStatusV2("codebase-1", "42");
      await assert.rejects(call, /Malformed|Unsupported/,
        `accepted missing required ${modelName}.${field}`);
    }
  }

  for (const mutate of [
    (value) => { value.publication_enabled = true; value.construction_enabled = false; },
    (value) => { value.service_available = true; value.read_enabled = false; },
    (value) => { value.limits.max_refresh_sequences_per_lineage = 11; },
  ]) {
    const candidate = completeReviewCapabilitiesV2();
    mutate(candidate);
    const client = new CorpusWireClient({
      baseUrl: "http://example.test", fetchFn: async () => jsonResponse(200, candidate),
    });
    await assert.rejects(client.getReviewContextCapabilitiesV2(), /Malformed/);
  }

  const invalidJob = completeReviewJobV2();
  invalidJob.retry_after_seconds = 3601;
  const jobClient = new CorpusWireClient({
    baseUrl: "http://example.test", fetchFn: async () => jsonResponse(200, invalidJob),
  });
  await assert.rejects(jobClient.cancelReviewContextJobV2("job-v2"), /Malformed/);

  const unsortedJob = completeReviewJobV2();
  unsortedJob.state = "partial";
  unsortedJob.partial_reasons = [
    { schema_version: "review-context/v2", code: "z_reason", retryable: true, affected_side: "head" },
    { schema_version: "review-context/v2", code: "a_reason", retryable: false, affected_side: "base" },
  ];
  const unsortedJobClient = new CorpusWireClient({
    baseUrl: "http://example.test", fetchFn: async () => jsonResponse(200, unsortedJob),
  });
  await assert.rejects(unsortedJobClient.cancelReviewContextJobV2("job-v2"), /Malformed/);

  const timezoneAwareJob = completeReviewJobV2();
  timezoneAwareJob.created_at = "2024-02-29T12:34:56.123456789+02:30";
  timezoneAwareJob.updated_at = "2024-02-29t10:04:56.5z";
  const timezoneAwareClient = new CorpusWireClient({
    baseUrl: "http://example.test", fetchFn: async () => jsonResponse(200, timezoneAwareJob),
  });
  await assert.doesNotReject(timezoneAwareClient.cancelReviewContextJobV2("job-v2"));
  for (const createdAt of ["2026-02-30T12:00:00Z", "2026-01-01Z"]) {
    const invalidTimestampJob = completeReviewJobV2();
    invalidTimestampJob.created_at = createdAt;
    const invalidTimestampClient = new CorpusWireClient({
      baseUrl: "http://example.test", fetchFn: async () => jsonResponse(200, invalidTimestampJob),
    });
    await assert.rejects(invalidTimestampClient.cancelReviewContextJobV2("job-v2"), /Malformed/);
  }

  const extractorMismatch = completeReviewResponseV2({ withBundle: true });
  extractorMismatch.bundles[0].change_record.base.stable_declaration_identity = {
    schema_version: "review-context/v2", extractor_id: "other-extractor",
    scheme_version: "1", value: "declaration-a",
  };
  assert.throws(() => assertReviewContextV2Result(extractorMismatch), /Malformed/);
});

test("review telemetry summary uses the operator endpoint and returns typed aggregates", async () => {
  const calls = [];
  const summary = {
    schema_version: "review-context/v1",
    event_count: 1_001,
    by_operation: { retrieval: 1_001 },
    by_status: { failed: 1_001 },
    by_failure_category: { backend_unavailable: 1_001 },
    metric_totals: { evidence_items: 3_003 },
    p95_duration_ms: 25,
  };
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (input, init) => {
      calls.push({ input, method: init?.method });
      return jsonResponse(200, summary);
    },
  });

  const result = await client.getReviewTelemetrySummary();

  assert.deepEqual(result, summary);
  assert.deepEqual(calls, [{
    input: "http://example.test/v1/review-context/telemetry/summary",
    method: "GET",
  }]);
});

test("requestJson honors explicit nonretryable errors before generic transient retries", { timeout: 1000 }, async () => {
  for (const status of [429, 503]) {
    let attempts = 0;
    await assert.rejects(requestJson({
      baseUrl: "http://fixture.test", paths: ["/v1/index/sessions"], retryAttempts: 2,
      init: { signal: AbortSignal.timeout(500) },
      fetchFn: async () => {
        attempts++;
        return jsonResponse(status, { detail: {
          code: "index_quota_exceeded", message: "Active session limit reached", retryable: false,
        } }, { "Retry-After": "60" });
      },
    }), (error) => error instanceof CorpusWireHttpError
      && error.status === status && error.errorCode === "index_quota_exceeded"
      && error.retryable === false && error.errorMessage === "Active session limit reached");
    assert.equal(attempts, 1);
  }
});

test("requestJson preserves legacy transient retries when retryability is omitted", async () => {
  const cases = [
    [429, { detail: "Tenant session limit reached" }],
    [503, { detail: { code: "embedding_not_ready", message: "Warming up" } }],
    [503, { ok: false, request_id: "legacy", duration_ms: 1, error: { code: "unavailable", message: "Try later" } }],
    [503, { schema_version: "review-context/v2", error_code: "unavailable", message: "Try later", request_id: "legacy" }],
  ];
  for (const [status, payload] of cases) {
    let attempts = 0;
    const result = await requestJson({
      baseUrl: "http://fixture.test", paths: ["/legacy"], retryDelayMs: 0,
      fetchFn: async () => ++attempts === 1
        ? jsonResponse(status, payload, { "Retry-After": "0" }) : jsonResponse(200, { ok: true }),
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(attempts, 2);
    await assert.rejects(requestJson({
      baseUrl: "http://fixture.test", paths: ["/legacy"], retryAttempts: 0,
      fetchFn: async () => jsonResponse(status, payload),
    }), (error) => error instanceof CorpusWireHttpError && error.retryable === true);
  }
});

test("requestJson exposes stable review errors and Retry-After metadata", async () => {
  await assert.rejects(
    requestJson({
      baseUrl: "http://example.test",
      paths: ["/v1/review-context/jobs/job-1"],
      retryAttempts: 0,
      fetchFn: async () => jsonResponse(
        410,
        {
          schema_version: "review-context/v1",
          error_code: "review_overlay_expired",
          message: "The closed ReviewOverlay has expired",
          request_id: "request-410",
          retryable: false,
          retry_after_seconds: 9,
          recovery_guidance: ["Request context again to rebuild the overlay."],
          details: {},
        },
        { "Retry-After": "9" },
      ),
    }),
    (error) => {
      assert.ok(error instanceof CorpusWireHttpError);
      assert.equal(error.status, 410);
      assert.equal(error.requestId, "request-410");
      assert.equal(error.errorCode, "review_overlay_expired");
      assert.equal(error.retryable, false);
      assert.equal(error.retryAfterSeconds, 9);
      assert.deepEqual(error.recoveryGuidance, [
        "Request context again to rebuild the overlay.",
      ]);
      assert.deepEqual(error.errorDetail, {});
      return true;
    },
  );
});

test("requestJson rejects unknown future review error schemas without trusting their payload", async () => {
  await assert.rejects(
    requestJson({
      baseUrl: "http://example.test",
      paths: ["/v2/review-context/jobs/job-future"],
      retryAttempts: 0,
      fetchFn: async () => jsonResponse(409, {
        schema_version: "review-context/v3",
        error_code: "future_error",
        message: "untrusted future detail",
        request_id: "request-v3",
        retryable: true,
        retry_after_seconds: 30,
        recovery_guidance: ["untrusted guidance"],
        details: { source: "must-not-be-trusted" },
      }),
    }),
    (error) => {
      assert.ok(error instanceof CorpusWireHttpError);
      assert.equal(error.requestId, "request-v3");
      assert.equal(error.errorCode, "unsupported_review_context_contract");
      assert.equal(error.retryable, false);
      assert.equal(error.retryAfterSeconds, null);
      assert.equal(error.errorEnvelope, null);
      assert.equal(error.errorDetail, undefined);
      assert.doesNotMatch(error.errorMessage, /untrusted future detail/);
      assert.deepEqual(error.recoveryGuidance, []);
      return true;
    },
  );
});

test("inventory canonicalization matches Python UTF-8 vectors and rejects ambiguous paths", async () => {
  const { inventoryDigest } = await import("../dist/inventory.js");
  assert.equal(await inventoryDigest([]), "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  const entries = [["z.py", "0".repeat(64), 0], ["é.py", "0".repeat(64), 1], ["😀.py", "0".repeat(64), 2], ["a\\b.py", "0".repeat(64), 3]];
  const { createHash } = await import("node:crypto");
  const canonical = JSON.stringify([["a/b.py", "0".repeat(64), 3], ...entries.slice(0, 3)]);
  assert.equal(await inventoryDigest(entries), createHash("sha256").update(canonical).digest("hex"));
  for (const path of ["/abs.py", "../a.py", "a//b.py", "C:\\a.py", "\ud800.py"]) {
    await assert.rejects(inventoryDigest([[path, "0".repeat(64), 0]]), { code: "scan_incomplete" });
  }
  await assert.rejects(inventoryDigest([["a.py", "0".repeat(64), true]]));
});

for (const supportsInventory of [true, false]) {
  test(`full scan capability negotiation and independently observed cold/warm transfer (${supportsInventory})`, async () => {
    let warm = false, attempts = 0;
    const starts = [], bodies = [];
    const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (url, init) => {
      if (url.endsWith("/capabilities")) return jsonResponse(200, { ok: true,
        inventory_coverage_versions: supportsInventory ? ["workspace-inventory/v1"] : [],
        supported_file_registry_version: "fixture/v1", max_file_size_bytes: 1024,
      });
      if (url.endsWith("/sessions")) {
        starts.push(JSON.parse(init.body));
        return jsonResponse(200, { ok: true, result: { session_id: "fixture", max_batch_bytes: 1024, max_concurrent_uploads: 1 } });
      }
      if (url.endsWith("/manifest/batch")) return jsonResponse(200, { ok: true, result: {
        accepted: 1, upload_required: warm ? [] : ["a.py"], unchanged: warm ? 1 : 0, deletes: 0, skipped: 0, errors: [],
      }});
      if (url.endsWith("/files/batch")) {
        attempts += 1;
        bodies.push(await init.body.text());
        if (attempts === 1) return jsonResponse(503, { detail: "synthetic retry" });
        return jsonResponse(200, { ok: true, result: { files_received: 1, errors: [] }});
      }
      if (url.endsWith("/commit")) return jsonResponse(200, { ok: true, result: {}, status: { phase: "completed" }});
      throw new Error(`Unexpected fixture request ${url}`);
    }});
    const request = { workspace: { workspaceId: "fixture" }, mode: "full", files: [{ relativePath: "a.py", content: "x=1" }],
      inventoryScan: { complete: true, startedAt: "2026-09-08T00:00:00Z", completedAt: "2026-09-08T00:00:01Z",
        excludedFileCount: 0, ignoreDigest: "0".repeat(64), producer: "fixture/v1" },
    };
    const cold = await client.indexWorkspace(request);
    assert.equal(Boolean(starts[0].inventory), supportsInventory);
    assert.equal(cold.transfer.files_submitted, 1);
    assert.equal(cold.transfer.files_transferred, 1);
    assert.equal(cold.transfer.source_bytes_transferred, 3);
    assert.equal(cold.transfer.upload_attempts, 2);
    assert.equal(cold.transfer.source_bytes_attempted, 6);
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((body) => body.includes("x=1")));
    warm = true;
    const reused = await client.indexWorkspace(request);
    assert.equal(reused.transfer.files_transferred, 0);
    assert.equal(reused.transfer.files_reused, 1);
    assert.equal(reused.transfer.source_bytes_attempted, 0);
    assert.equal(bodies.length, 2);
    assert.equal(reused.transfer.acknowledged_files[0].disposition, "confirmed_reused");
  });
}

test("evaluation inventory keeps full manifest while excluding only attested coverage entries", async () => {
  const starts = [], manifests = [];
  const attestation = {
    schema_version: "evaluation-inventory-attestation/v1",
    full_manifest_digest: "1".repeat(64),
    eligible_manifest_digest: "2".repeat(64),
    excluded_manifest_digest: "3".repeat(64),
    allowlist_digest: "4".repeat(64),
    required_evidence_digest: "5".repeat(64),
    selection_policy_digest: "6".repeat(64),
    complete_file_count: 3,
    complete_source_bytes: 9,
    excluded_file_count: 1,
    excluded_source_bytes: 3,
    excluded_entries: [{ relative_path: "package-lock.json", sha256: "7".repeat(64), size: 3 }],
    allowlist_entries: [{ relative_path: "package.json", sha256: "8".repeat(64), size: 3 }],
    required_evidence_entries: [{ relative_path: "package.json", sha256: "8".repeat(64), size: 3 }],
  };
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (url, init) => {
    if (url.endsWith("/capabilities")) return jsonResponse(200, { ok: true,
      inventory_coverage_versions: ["workspace-inventory/v1"],
      supported_file_registry_version: "fixture/v1", max_file_size_bytes: 1024,
    });
    if (url.endsWith("/sessions")) {
      starts.push(JSON.parse(init.body));
      return jsonResponse(200, { ok: true, result: { session_id: "evaluation", max_batch_bytes: 4096, max_concurrent_uploads: 1 } });
    }
    if (url.endsWith("/manifest/batch")) {
      manifests.push(init.body);
      return jsonResponse(200, { ok: true, result: {
        accepted: 3, upload_required: ["main.py", "package.json"], unchanged: 0,
        deletes: 0, skipped: 1, errors: [],
      }});
    }
    if (url.endsWith("/files/batch")) return jsonResponse(200, { ok: true, result: { files_received: 2, errors: [] }});
    if (url.endsWith("/commit")) return jsonResponse(200, { ok: true, result: {}, status: { phase: "completed" }});
    throw new Error(`Unexpected fixture request ${url}`);
  }});
  await client.indexWorkspace({
    workspace: { workspaceId: "local-docker://rqt-fixture#frozen" },
    mode: "full",
    files: [
      { relativePath: "main.py", content: "a=1" },
      { relativePath: "package.json", content: "{}\n" },
      { relativePath: "package-lock.json", content: "{}\n" },
    ],
    inventoryScan: { complete: true, startedAt: "2026-09-13T00:00:00Z", completedAt: "2026-09-13T00:00:01Z",
      excludedFileCount: 1, ignoreDigest: "0".repeat(64), producer: "fixture/v1" },
    evaluationInventoryAttestation: attestation,
  });
  assert.equal(starts[0].inventory.eligible_file_count, 2);
  assert.deepEqual(starts[0].evaluation_inventory_attestation, attestation);
  assert.equal(manifests[0].trim().split("\n").length, 3);
});

test("evaluation inventory refuses a service without inventory coverage", async () => {
  let sessions = 0;
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (url) => {
    if (url.endsWith("/capabilities")) return jsonResponse(200, { ok: true, inventory_coverage_versions: [] });
    sessions += 1;
    return jsonResponse(500, {});
  }});
  await assert.rejects(client.indexWorkspace({
    workspace: { workspaceId: "local-docker://rqt-fixture#frozen" }, mode: "full",
    files: [{ relativePath: "main.py", content: "a=1" }],
    inventoryScan: { complete: true, startedAt: "2026-09-13T00:00:00Z", completedAt: "2026-09-13T00:00:01Z",
      excludedFileCount: 0, ignoreDigest: "0".repeat(64), producer: "fixture/v1" },
    evaluationInventoryAttestation: {
      schema_version: "evaluation-inventory-attestation/v1",
      full_manifest_digest: "1".repeat(64), eligible_manifest_digest: "2".repeat(64),
      excluded_manifest_digest: "3".repeat(64), allowlist_digest: "4".repeat(64),
      required_evidence_digest: "5".repeat(64), selection_policy_digest: "6".repeat(64),
      complete_file_count: 1, complete_source_bytes: 3, excluded_file_count: 0,
      excluded_source_bytes: 0, excluded_entries: [], allowlist_entries: [], required_evidence_entries: [],
    },
  }), { code: "scan_incomplete" });
  assert.equal(sessions, 0);
});

test("incomplete scan, supplied hash mismatch and duplicate files cannot allocate a session", async () => {
  let mutations = 0;
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (_, init) => {
    if (init.method === "POST") mutations += 1;
    return jsonResponse(200, { ok: true, inventory_coverage_versions: [] });
  }});
  await assert.rejects(client.indexWorkspace({ workspace: { workspaceId: "f" }, mode: "full",
    files: [{ relativePath: "a.py", content: "x", sha256: "0".repeat(64) }],
  }), { code: "scan_incomplete" });
  await assert.rejects(client.indexWorkspace({ workspace: { workspaceId: "f" }, mode: "full",
    files: [{ relativePath: "a.py", content: "x" }, { relativePath: "a.py", content: "x" }],
  }), { code: "scan_incomplete" });
  await assert.rejects(client.indexWorkspace({ workspace: { workspaceId: "f" }, mode: "full", files: [],
    inventoryScan: { complete: false },
  }), { code: "scan_incomplete" });
  assert.equal(mutations, 0);
});

test("partial upload error retains acknowledgements observed before sibling cancellation", async () => {
  let attempts = 0;
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (url, init) => {
    if (url.endsWith("/sessions")) return jsonResponse(200, {ok:true,result:{session_id:"partial",max_batch_bytes:1000,max_batch_files:1,max_concurrent_uploads:2}});
    if (url.endsWith("/manifest/batch")) return jsonResponse(200, {ok:true,result:{accepted:2,upload_required:["a.py","b.py"],unchanged:0,deletes:0,skipped:0,errors:[]}});
    if (url.endsWith("/files/batch")) {
      attempts += 1;
      const body = await init.body.text();
      if (body.includes("synth_fail")) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonResponse(400, {detail:"synthetic rejection"});
      }
      return jsonResponse(200, {ok:true,result:{files_received:1,errors:[]}});
    }
    if (url.endsWith("/abort")) return jsonResponse(200, {ok:true});
    throw new Error(`Unexpected request ${url}`);
  }});
  await assert.rejects(client.indexWorkspace({workspace:{workspaceId:"partial"},files:[
    {relativePath:"a.py",content:"synth_fail"},{relativePath:"b.py",content:"ok"},
  ]}), (error) => {
    assert.equal(error.transfer.complete, false);
    assert.equal(error.transfer.upload_attempts, 2);
    assert.equal(error.transfer.files_transferred, 1);
    assert.equal(error.transfer.source_bytes_transferred, 2);
    return true;
  });
  assert.equal(attempts, 2);
});

test("retrieval exclusions preserve source while rejecting discovery and Terraform inputs", async () => {
  const { isRetrievalExcludedPath } = await import("../dist/index.js");
  for (const path of ["package.json", "src/tsconfig.build.json", "requirements.txt", "requirements-dev.txt", "constraints_prod.txt", "SETUP.PY", "nx.json", "project.json", "state.tfstate.json", "values.tfvars.json", "out.plan.json", "pom.xml"]) {
    assert.equal(isRetrievalExcludedPath(path), true, path);
  }
  for (const path of ["src/main.py", "README.md", "settings.json", "requirements-guide.md", "main.tf", "model.tf.json"]) {
    assert.equal(isRetrievalExcludedPath(path), false, path);
  }
});

test("ingestion priority matches canonical code, documentation and other categories", () => {
  for (const extension of ["bat", "scala", "sh", "cjs", "js", "jsx", "mjs", "cts", "mts", "ts", "tsx", "java", "kt", "kts", "py", "pyi", "hcl", "tf", "html", "htm"]) {
    assert.equal(ingestionPriority(`src/main.${extension.toUpperCase()}`), 1);
  }
  for (const path of ["scripts/mvnw", "scripts/gradlew", "infra/main.tf.json"]) assert.equal(ingestionPriority(path), 1);
  for (const path of ["README.md", "guide.txt", "manual.pdf"]) assert.equal(ingestionPriority(path), 2);
  for (const path of ["settings.json", "data.csv", "config.yml"]) assert.equal(ingestionPriority(path), 3);
});

function priorityIndexFixture({ files, unchanged = [], capability = true, batchBytes = 1024, concurrency = 1, onUpload } = {}) {
  const calls = [], uploaded = new Set(), uploadRequired = files.map((file) => file.relativePath).filter((path) => !unchanged.includes(path));
  let released = false;
  const status = (coverage) => ({
    session_id: "priority", workspace_id: "fixture", collection_name: "fixture", mode: "full",
    phase: released ? "aborted" : "indexing", files_manifested: files.length, files_indexed: uploaded.size,
    files_deleted: 0, files_unchanged: unchanged.length, files_skipped: 0, bytes_uploaded: 0,
    bytes_skipped: 0, queue_depth: uploadRequired.length - uploaded.size,
    pending_batches: 0, active_batches: 0, errors: [], coverage,
  });
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (url, init) => {
    if (url.endsWith("/capabilities")) return jsonResponse(200, {
      ok: true, inventory_coverage_versions: ["workspace-inventory/v1"],
      supported_file_registry_version: "fixture/v1", max_file_size_bytes: 1024,
    });
    if (url.endsWith("/sessions")) return jsonResponse(200, { ok: true, result: {
      session_id: "priority", workspace_id: "fixture", collection_name: "fixture", manifest_revision: 1,
      mode: "full", max_batch_bytes: batchBytes,
      max_concurrent_uploads: concurrency, code_checkpoint: capability,
    } });
    if (url.endsWith("/manifest/batch")) return jsonResponse(200, { ok: true, result: {
      accepted: files.length, upload_required: uploadRequired, unchanged: unchanged.length,
      deletes: 0, skipped: 0, errors: [],
    } });
    if (url.endsWith("/files/batch")) {
      const body = await init.body.text();
      const paths = files.filter((file) => body.includes(`"relative_path":"${file.relativePath}"`)).map((file) => file.relativePath);
      calls.push({ type: "upload", paths });
      await onUpload?.(paths, init);
      for (const path of paths) uploaded.add(path);
      return jsonResponse(202, { ok: true, result: { files_received: paths.length, queued: true, errors: [] } });
    }
    if (url.endsWith("/status")) { calls.push({ type: "status" }); return jsonResponse(200, { ok: true, result: status() }); }
    if (url.endsWith("/checkpoint/code")) {
      calls.push({ type: "checkpoint" });
      return jsonResponse(200, { ok: true, result: { ...status({
        schema_version: "workspace-coverage/v1", state: "pending", reason_codes: [], session_id: "priority",
        code_ready: true, documentation_pending: files.some((file) => ingestionPriority(file.relativePath) === 2),
        other_pending: files.some((file) => ingestionPriority(file.relativePath) === 3),
      }), phase: "ready_to_commit" } });
    }
    if (url.endsWith("/commit")) { calls.push({ type: "commit" }); return jsonResponse(200, { ok: true, result: {}, status: { ...status(), phase: "completed" } }); }
    if (init.method === "DELETE") { released = true; calls.push({ type: "abort" }); return jsonResponse(200, { ok: true }); }
    throw new Error(`Unexpected request ${url}`);
  } });
  const request = {
    workspace: { workspaceId: "fixture" }, mode: "full", files, processingTimeoutMs: 100, processingPollMs: 10,
    inventoryScan: { complete: true, startedAt: "2026-10-09T00:00:00Z", completedAt: "2026-10-09T00:00:01Z",
      excludedFileCount: 0, ignoreDigest: "0".repeat(64), producer: "fixture/v1" },
  };
  return { client, request, calls };
}

test("code drains and publishes while documentation remains missing, before later tiers upload", async () => {
  const fixture = priorityIndexFixture({ files: [
    { relativePath: "data.json", content: "{}" }, { relativePath: "README.md", content: "guide" },
    { relativePath: "src/main.py", content: "x=1" },
  ] });
  let ready;
  const result = await fixture.client.indexWorkspace({ ...fixture.request, onCodeReady: (status) => { ready = status; fixture.calls.push({ type: "callback" }); } });
  assert.deepEqual(fixture.calls.filter((call) => call.type !== "status"), [
    { type: "upload", paths: ["src/main.py"] }, { type: "checkpoint" }, { type: "callback" },
    { type: "upload", paths: ["README.md"] }, { type: "upload", paths: ["data.json"] }, { type: "commit" },
  ]);
  assert.equal(ready.queue_depth, 2);
  assert.equal(ready.coverage.code_ready, true);
  assert.equal(ready.coverage.documentation_pending, true);
  assert.equal(ready.coverage.other_pending, true);
  assert.equal(result.transfer.files_transferred, 3);
});

test("unchanged code still checkpoints before documentation uploads", async () => {
  const fixture = priorityIndexFixture({ files: [
    { relativePath: "README.md", content: "guide" }, { relativePath: "main.ts", content: "x" },
  ], unchanged: ["main.ts"] });
  await fixture.client.indexWorkspace(fixture.request);
  assert.equal(fixture.calls[0].type, "checkpoint");
  assert.deepEqual(fixture.calls.find((call) => call.type === "upload").paths, ["README.md"]);
});

test("cancel and detach interrupt a stalled code checkpoint and preserve transfer semantics", { timeout: 1000 }, async () => {
  for (const mode of ["cancel", "incomplete detach", "complete detach"]) {
    const controller = new AbortController();
    const files = [{ relativePath: "main.py", content: "x" }];
    if (mode !== "complete detach") files.push({ relativePath: "README.md", content: "guide" });
    const fixture = priorityIndexFixture({ files });
    const originalFetch = fixture.client.fetchFn;
    let checkpointSignal;
    fixture.client.fetchFn = async (url, init) => {
      if (url.endsWith("/checkpoint/code")) {
        checkpointSignal = init.signal;
        queueMicrotask(() => controller.abort());
        return new Promise(() => {});
      }
      const response = await originalFetch(url, init);
      if (url.endsWith("/status") && fixture.calls.some((call) => call.type === "abort")) {
        const payload = await response.json();
        payload.result.phase = "aborted";
        return jsonResponse(200, payload);
      }
      return response;
    };
    await assert.rejects(fixture.client.indexWorkspace({ ...fixture.request,
      ...(mode === "cancel" ? { signal: controller.signal } : { detachSignal: controller.signal }),
    }), (error) => {
      if (mode === "cancel") assert.ok(error instanceof RemoteIndexCancelledError);
      else {
        assert.equal(error instanceof RemoteIndexDetachedError,false);
        assert.match(error.message,/Start a new index operation/);
        assert.equal(error.transfer.files_transferred,1);
        assert.equal(error.transfer.complete,false);
        if (mode === "complete detach") assert.match(error.message,/client-owned code checkpoint/);
      }
      return true;
    });
    assert.equal(checkpointSignal.aborted, true, mode);
    assert.equal(fixture.calls.some((call) => call.type === "abort"), true, mode);
    assert.equal(fixture.calls.some((call) => call.type === "upload" && call.paths.includes("README.md")), false);
    assert.equal(fixture.calls.some((call) => call.type === "commit"), false);
  }
});

test("a checkpoint without confirmed code readiness cannot call the ready callback", async () => {
  const fixture = priorityIndexFixture({ files: [
    { relativePath: "main.py", content: "x" }, { relativePath: "README.md", content: "guide" },
  ] });
  const originalFetch = fixture.client.fetchFn;
  fixture.client.fetchFn = async (url, init) => {
    const response = await originalFetch(url, init);
    if (!url.endsWith("/checkpoint/code")) return response;
    const payload = await response.json();
    payload.result.coverage.code_ready = false;
    return jsonResponse(200, payload);
  };
  let callbacks = 0;
  await assert.rejects(fixture.client.indexWorkspace({ ...fixture.request, onCodeReady: () => callbacks++ }), /did not confirm code readiness/);
  assert.equal(callbacks, 0);
  assert.equal(fixture.calls.filter((call) => call.type === "upload").length, 1);
  assert.equal(fixture.calls.at(-1).type, "abort");
});

test("tier draining waits for legacy background work without optional batch counters", async () => {
  const fixture = priorityIndexFixture({ files: [
    { relativePath: "main.py", content: "x" }, { relativePath: "README.md", content: "guide" },
  ] });
  const originalFetch = fixture.client.fetchFn;
  let statusReads = 0;
  fixture.client.fetchFn = async (url, init) => {
    const response = await originalFetch(url, init);
    if (!url.endsWith("/status")) return response;
    const payload = await response.json();
    delete payload.result.pending_batches;
    delete payload.result.active_batches;
    if (++statusReads === 1) payload.result.queue_depth++;
    return jsonResponse(200, payload);
  };
  await fixture.client.indexWorkspace(fixture.request);
  const beforeCheckpoint = fixture.calls.slice(0, fixture.calls.findIndex((call) => call.type === "checkpoint"));
  assert.equal(beforeCheckpoint.filter((call) => call.type === "status").length, 2);
});

test("final completeness still waits for missing uploads after all tiers drain", async () => {
  const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }], capability: false });
  const originalFetch = fixture.client.fetchFn;
  fixture.client.fetchFn = async (url, init) => {
    const response = await originalFetch(url, init);
    if (!url.endsWith("/status")) return response;
    const payload = await response.json();
    payload.result.queue_depth = 1;
    return jsonResponse(200, payload);
  };
  await assert.rejects(fixture.client.indexWorkspace({ ...fixture.request, processingTimeoutMs: 20 }), RemoteIndexDetachedError);
  assert.equal(fixture.calls.some((call) => call.type === "commit" || call.type === "abort"), false);
});

test("a code-tier processing timeout aborts while documentation uploads are still unsent", async () => {
  const fixture = priorityIndexFixture({ files: [
    { relativePath: "main.py", content: "x" }, { relativePath: "README.md", content: "guide" },
  ] });
  const originalFetch = fixture.client.fetchFn;
  fixture.client.fetchFn = async (url, init) => {
    const response = await originalFetch(url, init);
    if (!url.endsWith("/status")) return response;
    const payload = await response.json();
    payload.result.active_batches = 1;
    return jsonResponse(200, payload);
  };
  await assert.rejects(fixture.client.indexWorkspace({ ...fixture.request, processingTimeoutMs: 20 }), (error) => {
    assert.equal(error instanceof RemoteIndexDetachedError, false);
    assert.match(error.message, /abort was requested for the incomplete session/);
    assert.equal(error.transfer.files_transferred, 1);
    assert.equal(error.transfer.complete, false);
    return true;
  });
  assert.deepEqual(fixture.calls.filter((call) => call.type === "upload").map((call) => call.paths), [["main.py"]]);
  assert.equal(fixture.calls.at(-1).type, "abort");
  assert.equal(fixture.calls.some((call) => call.type === "checkpoint" || call.type === "commit"), false);
});

test("tier processing waits share one deadline instead of restarting the caller budget", async (t) => {
  let now = 0, codeReads = 0, documentationReads = 0;
  t.mock.method(Date, "now", () => now);
  const fixture = priorityIndexFixture({ files: [
    { relativePath: "main.py", content: "x" }, { relativePath: "README.md", content: "guide" },
    { relativePath: "data.json", content: "{}" },
  ] });
  const originalFetch = fixture.client.fetchFn;
  fixture.client.fetchFn = async (url, init) => {
    const response = await originalFetch(url, init);
    if (!url.endsWith("/status")) return response;
    const payload = await response.json();
    if (payload.result.queue_depth === 2) {
      now = ++codeReads === 1 ? 60 : 90;
      payload.result.active_batches = codeReads === 1 ? 1 : 0;
    } else {
      now = ++documentationReads === 1 ? 110 : 220;
      payload.result.active_batches = 1;
    }
    return jsonResponse(200, payload);
  };
  await assert.rejects(fixture.client.indexWorkspace(fixture.request), /abort was requested for the incomplete session/);
  assert.equal(codeReads, 2);
  assert.equal(documentationReads, 1);
  assert.equal(fixture.calls.at(-1).type, "abort");
  assert.equal(fixture.calls.some((call) => call.type === "upload" && call.paths.includes("data.json")), false);
});

test("an incomplete detach reports an unconfirmed abort without claiming reattachment", async () => {
  const controller = new AbortController();
  const fixture = priorityIndexFixture({ files: [
    { relativePath: "main.py", content: "x" }, { relativePath: "README.md", content: "guide" },
  ], onUpload: () => controller.abort() });
  const originalFetch = fixture.client.fetchFn;
  fixture.client.fetchFn = (url, init) => {
    if (init.method === "DELETE") throw new Error("Synthetic abort rejection");
    return originalFetch(url, init);
  };
  await assert.rejects(fixture.client.indexWorkspace({ ...fixture.request, detachSignal: controller.signal }), (error) => {
    assert.equal(error instanceof RemoteIndexDetachedError, false);
    assert.match(error.message, /abort could not be confirmed/);
    assert.equal(error.transfer.complete, false);
    return true;
  });
  assert.equal(fixture.calls.some((call) => call.type === "upload" && call.paths.includes("README.md")), false);
});

test("expiry after code publication prevents the next tier from uploading", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const fixture = priorityIndexFixture({ files: [
    { relativePath: "main.py", content: "x" }, { relativePath: "README.md", content: "guide" },
  ] });
  await assert.rejects(fixture.client.indexWorkspace({ ...fixture.request, onCodeReady: () => { now = 110; } }), /abort was requested for the incomplete session/);
  assert.deepEqual(fixture.calls.filter((call) => call.type === "upload").map((call) => call.paths), [["main.py"]]);
  assert.equal(fixture.calls.at(-1).type, "abort");
});

test("old server capability and zero-code inventories skip code publication", async () => {
  for (const options of [
    { files: [{ relativePath: "main.py", content: "x" }], capability: false },
    { files: [{ relativePath: "README.md", content: "guide" }] },
  ]) {
    const fixture = priorityIndexFixture(options);
    let callbacks = 0;
    await fixture.client.indexWorkspace({ ...fixture.request, onCodeReady: () => callbacks++ });
    assert.equal(callbacks, 0);
    assert.equal(fixture.calls.some((call) => call.type === "checkpoint"), false);
  }
});

test("upload batches and concurrency are clamped to the server limits", async () => {
  let active = 0, maximum = 0;
  const fixture = priorityIndexFixture({ files: [
    { relativePath: "a.py", content: "abc" }, { relativePath: "b.py", content: "def" }, { relativePath: "c.py", content: "ghi" },
  ], batchBytes: 4, concurrency: 1, onUpload: async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5)); active--;
  } });
  await fixture.client.indexWorkspace({ ...fixture.request, batchBytes: 1000, maxConcurrentUploads: 20 });
  assert.equal(maximum, 1);
  assert.deepEqual(fixture.calls.filter((call) => call.type === "upload").map((call) => call.paths.length), [1, 1, 1]);
});

test("an empty inventory commits without requiring unused upload capacity", async () => {
  const fixture = priorityIndexFixture({ files: [], batchBytes: 0, concurrency: 0 });
  const result = await fixture.client.indexWorkspace(fixture.request);
  assert.equal(result.transfer.complete, true);
  assert.equal(result.transfer.files_upload_required, 0);
  assert.equal(result.transfer.files_transferred, 0);
  assert.equal(fixture.calls.some((call) => call.type === "upload" || call.type === "checkpoint" || call.type === "abort"), false);
  assert.equal(fixture.calls.at(-1).type, "commit");
});

test("all-reused code checkpoints and commits without requiring upload capacity", async () => {
  const fixture = priorityIndexFixture({ files: [
    { relativePath: "main.py", content: "x" }, { relativePath: "README.md", content: "guide" },
  ], unchanged: ["main.py", "README.md"], batchBytes: 0, concurrency: 0 });
  let codeReady = false;
  const result = await fixture.client.indexWorkspace({ ...fixture.request,
    onCodeReady: (status) => { codeReady = status.coverage.code_ready; },
  });
  assert.equal(codeReady, true);
  assert.equal(result.transfer.complete, true);
  assert.equal(result.transfer.files_upload_required, 0);
  assert.equal(result.transfer.files_reused, 2);
  assert.equal(result.transfer.files_transferred, 0);
  assert.deepEqual(fixture.calls, [{ type: "checkpoint" }, { type: "commit" }]);
});

test("actual upload payloads still reject zero byte or concurrency capacity", async () => {
  for (const limits of [{ batchBytes: 0 }, { concurrency: 0 }]) {
    const fixture = priorityIndexFixture({ files: [{ relativePath: "README.md", content: "guide" }], ...limits });
    await assert.rejects(fixture.client.indexWorkspace(fixture.request), /positive finite limit/);
    assert.equal(fixture.calls.some((call) => call.type === "upload" || call.type === "commit"), false);
    assert.equal(fixture.calls.at(-1).type, "abort");
  }
});

function queueBusy(retryAfter = "0") {
  const response = jsonResponse(429, { detail: { error_code: "index_queue_full", message: "Queue busy", retryable: true } });
  response.headers.set("Retry-After", retryAfter);
  return response;
}

const QUEUE_TEST_FILE = { descriptor: { relativePath: "main.py", contentId: "file-0", size: 1, sha256: "0".repeat(64), mtimeNs: 0 }, content: "x" };

test("typed queue pressure bypasses generic retries and admission retries identical bytes losslessly", async () => {
  let genericCalls = 0;
  await assert.rejects(requestJson({ baseUrl: "http://fixture.test", paths: ["/busy"], retryDelayMs: 0,
    fetchFn: async () => { genericCalls++; return queueBusy(); },
  }), (error) => error.errorCode === "index_queue_full" && error.retryable && error.retryAfterSeconds === 0);
  assert.equal(genericCalls, 1);
  const bodies = [];
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (_, init) => {
    bodies.push(await init.body.text());
    return bodies.length < 3 ? queueBusy() : jsonResponse(202, { ok: true, result: { files_received: 1, errors: [], queued: true } });
  } });
  let attempts = 0;
  const result = await client.uploadFileBatch("queue", { files: [QUEUE_TEST_FILE.descriptor] }, [QUEUE_TEST_FILE], () => attempts++, { queueWaitTimeoutMs: 200 });
  assert.equal(result.files_received, 1);
  assert.equal(attempts, 3);
  assert.equal(new Set(bodies).size, 1);
});

test("admission timeout is finite and permanent quota responses fail without retries", async () => {
  for (const busy of [true, false]) {
    let attempts = 0;
    const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async () => {
      attempts++;
      return busy ? queueBusy("1") : jsonResponse(429, { detail: "permanent workspace byte quota exceeded" });
    } });
    await assert.rejects(client.uploadFileBatch("queue", { files: [QUEUE_TEST_FILE.descriptor] }, [QUEUE_TEST_FILE], undefined, { queueWaitTimeoutMs: 15 }), CorpusWireHttpError);
    assert.equal(attempts, 1);
  }
});

test("admission budget bounds stalled fetch and response bodies even when transport ignores abort", { timeout: 1000 }, async () => {
  for (const stalled of ["fetch", "success body", "error body"]) {
    let transportSignal, attempts = 0;
    const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (_, init) => {
      transportSignal = init.signal;
      attempts++;
      const never = new Promise(() => {});
      if (stalled === "fetch") return never;
      const response = jsonResponse(stalled === "success body" ? 202 : 429, {});
      if (stalled === "success body") response.json = () => never;
      else response.text = () => never;
      return response;
    } });
    await assert.rejects(client.uploadFileBatch("queue", { files: [QUEUE_TEST_FILE.descriptor] }, [QUEUE_TEST_FILE], undefined,
      { queueWaitTimeoutMs: 10 }), /Upload admission timeout elapsed/);
    assert.equal(attempts, 1, stalled);
    assert.equal(transportSignal.aborted, true, stalled);
  }
});

test("caller cancellation bounds an uncooperative admission fetch", { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let transportSignal;
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (_, init) => {
    transportSignal = init.signal;
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  } });
  await assert.rejects(client.uploadFileBatch("queue", { files: [QUEUE_TEST_FILE.descriptor] }, [QUEUE_TEST_FILE], undefined,
    { queueWaitTimeoutMs: 500, signal: controller.signal }), { name: "AbortError" });
  assert.equal(transportSignal.aborted, true);
});

test("generic HTTP retry backoff stays inside the admission budget", { timeout: 1000 }, async () => {
  let attempts = 0, transportSignal;
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (_, init) => {
    transportSignal = init.signal;
    attempts++;
    return jsonResponse(503, { detail: "Synthetic transient gateway failure" });
  } });
  await assert.rejects(client.uploadFileBatch("queue", { files: [QUEUE_TEST_FILE.descriptor] }, [QUEUE_TEST_FILE], undefined,
    { queueWaitTimeoutMs: 10 }), /Upload admission timeout elapsed/);
  assert.equal(attempts, 1);
  assert.equal(transportSignal.aborted, true);
});

test("zero admission budget permits one initial attempt without queue retries", async () => {
  for (const mode of ["success", "queue", "gateway", "network"]) {
    let attempts = 0;
    const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async () => {
      attempts++;
      if (mode === "network") throw new TypeError("fetch failed");
      if (mode === "queue") return queueBusy();
      if (mode === "gateway") return jsonResponse(503, { detail: "Synthetic gateway failure" });
      return jsonResponse(202, { ok: true, result: { files_received: 1, errors: [] } });
    } });
    const upload = client.uploadFileBatch("queue", { files: [QUEUE_TEST_FILE.descriptor] }, [QUEUE_TEST_FILE], undefined,
      { queueWaitTimeoutMs: 0 });
    if (mode === "success") assert.equal((await upload).files_received, 1);
    else await assert.rejects(upload, mode === "network" ? TypeError : CorpusWireHttpError);
    assert.equal(attempts, 1, mode);
  }
});

test("cancellation and incomplete detach interrupt admission waits and abort unsent inventories", async () => {
  for (const detach of [false, true]) {
    const controller = new AbortController();
    let uploads = 0, aborts = 0;
    const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (url, init) => {
      if (url.endsWith("/sessions")) return jsonResponse(200, { ok: true, result: { session_id: "queue", max_batch_bytes: 1000, max_concurrent_uploads: 1 } });
      if (url.endsWith("/manifest/batch")) return jsonResponse(200, { ok: true, result: { accepted: 1, upload_required: ["main.py"], unchanged: 0, deletes: 0, skipped: 0, errors: [] } });
      if (url.endsWith("/files/batch")) { uploads++; setTimeout(() => controller.abort(), 5); return queueBusy("60"); }
      if (init.method === "DELETE") { aborts++; return jsonResponse(200, { ok: true }); }
      if (url.endsWith("/status")) return jsonResponse(200, { ok: true, result: { phase: aborts ? "aborted" : "indexing" } });
      throw new Error(`Unexpected request ${url}`);
    } });
    const started = Date.now();
    await assert.rejects(client.indexWorkspace({ workspace: { workspaceId: "fixture" }, files: [{ relativePath: "main.py", content: "x" }],
      signal: detach ? undefined : controller.signal, detachSignal: detach ? controller.signal : undefined,
    }), (error) => detach
      ? !(error instanceof RemoteIndexDetachedError) && /abort was requested for the incomplete session/.test(error.message)
      : error instanceof RemoteIndexCancelledError);
    assert.ok(Date.now() - started < 1000);
    assert.equal(uploads, 1);
    assert.equal(aborts, 1);
  }
});

test("explicit detach preserves backend work after every required upload is acknowledged", async () => {
  const controller = new AbortController();
  const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }] });
  await assert.rejects(fixture.client.indexWorkspace({ ...fixture.request, detachSignal: controller.signal,
    onProgress: (event) => { if (event.phase === "uploading") controller.abort(); },
  }), RemoteIndexDetachedError);
  assert.equal(fixture.calls.some((call) => call.type === "abort"), false);
});

test("one failing upload stops sibling queue retries and prevents the next batch", async () => {
  let uploads = 0, aborts = 0;
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (url, init) => {
    if (url.endsWith("/sessions")) return jsonResponse(200, { ok: true, result: { session_id: "queue", max_batch_bytes: 1000, max_batch_files: 1, max_concurrent_uploads: 2 } });
    if (url.endsWith("/manifest/batch")) return jsonResponse(200, { ok: true, result: { accepted: 3, upload_required: ["a.py", "b.py", "c.py"], unchanged: 0, deletes: 0, skipped: 0, errors: [] } });
    if (url.endsWith("/files/batch")) {
      uploads++;
      const body = await init.body.text();
      if (body.includes("a.py")) { await new Promise((resolve) => setTimeout(resolve, 10)); return jsonResponse(400, { detail: "rejected" }); }
      return queueBusy("60");
    }
    if (init.method === "DELETE") { aborts++; return jsonResponse(200, { ok: true }); }
    throw new Error(`Unexpected request ${url}`);
  } });
  await assert.rejects(client.indexWorkspace({ workspace: { workspaceId: "fixture" }, files: ["a.py", "b.py", "c.py"].map((relativePath) => ({ relativePath, content: "x" })) }), (error) => error instanceof CorpusWireHttpError && error.status === 400);
  assert.equal(uploads, 2);
  assert.equal(aborts, 1);
});


test("detach in and after the code-ready callback aborts a fully uploaded checkpoint awaiting client commit", async () => {
  for (const deferred of [false,true]) {
  const controller = new AbortController();
  const fixture = priorityIndexFixture({files:[{relativePath:"main.py",content:"x"}]});
  await assert.rejects(fixture.client.indexWorkspace({...fixture.request,detachSignal:controller.signal,
    onCodeReady:()=>deferred ? queueMicrotask(()=>controller.abort()) : controller.abort()}),(error)=>{
    assert.equal(error instanceof RemoteIndexDetachedError,false);
    assert.match(error.message,/client-owned code checkpoint/);
    assert.equal(error.transfer.files_transferred,1);
    return true;
  });
  assert.equal(fixture.calls.some(call=>call.type==="abort"),true);
  assert.equal(fixture.calls.some(call=>call.type==="commit"),false);
  }
});

for (const interruption of ["processing timeout", "detach during drain", "cancel during drain", "detach after drained callback", "timeout after drained callback"]) {
  test(`queued documentation retains owned checkpoint through ${interruption}`, async (t) => {
    let now = 0;
    t.mock.method(Date, "now", () => now);
    const controller = new AbortController();
    const fixture = priorityIndexFixture({ files: [
      { relativePath: "main.py", content: "x" }, { relativePath: "README.md", content: "guide" },
    ] });
    const originalFetch = fixture.client.fetchFn;
    const afterDrainedCallback = interruption.includes("after drained callback");
    let drainedCallbacks = 0, readyCallbacks = 0;
    fixture.client.fetchFn = async (url, init) => {
      const response = await originalFetch(url, init);
      const documentationUploaded = fixture.calls.some((call) => call.type === "upload" && call.paths.includes("README.md"));
      if (!url.endsWith("/status") || !documentationUploaded || fixture.calls.some((call) => call.type === "abort")) return response;
      const payload = await response.json();
      payload.result.phase = afterDrainedCallback ? "ready_to_commit" : "indexing";
      payload.result.pending_batches = afterDrainedCallback ? 0 : 1;
      if (afterDrainedCallback) {
        payload.result.progress = { ...progressEvent(700, 80, "queued"), session_id: "priority", workspace_id: "fixture" };
      } else if (interruption === "processing timeout") {
        now = 101;
      } else {
        controller.abort();
      }
      return jsonResponse(200, payload);
    };
    await assert.rejects(fixture.client.indexWorkspace({ ...fixture.request,
      signal: interruption === "cancel during drain" ? controller.signal : undefined,
      detachSignal: interruption.includes("detach") ? controller.signal : undefined,
      onCodeReady: () => { readyCallbacks += 1; },
      onProgress: (event) => {
        if (!afterDrainedCallback || event.sequence !== 700 || drainedCallbacks++) return;
        queueMicrotask(() => {
          if (interruption.includes("detach")) controller.abort();
          else now = 101;
        });
      },
    }), (error) => {
      assert.equal(error instanceof RemoteIndexDetachedError, false, "Client-owned commit cannot be resumed by status polling");
      if (interruption === "cancel during drain") assert.ok(error instanceof RemoteIndexCancelledError);
      else {
        assert.match(error.message, /client-owned code checkpoint/);
        assert.match(error.message, /Start a new index operation/);
      }
      assert.equal(error.transfer.files_transferred, 2);
      assert.equal(error.transfer.complete, false);
      return true;
    });
    assert.equal(readyCallbacks, 1);
    if (afterDrainedCallback) assert.ok(drainedCallbacks > 0);
    assert.deepEqual(fixture.calls.filter((call) => call.type === "upload").map((call) => call.paths), [["main.py"], ["README.md"]]);
    assert.equal(fixture.calls.filter((call) => call.type === "abort").length, 1);
    assert.equal(fixture.calls.some((call) => call.type === "commit"), false);
  });
}

test("upload counters separate eleven queue cooldown retries from transport retries", { timeout: 4000 }, async () => {
  let attempts = 0;
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (url) => {
    if (url.endsWith("/sessions")) return jsonResponse(200, { ok: true, result: { session_id: "metrics", max_batch_bytes: 1024, max_concurrent_uploads: 1 } });
    if (url.endsWith("/manifest/batch")) return jsonResponse(200, { ok: true, result: { accepted: 1, upload_required: ["a.py"], unchanged: 0, deletes: 0, skipped: 0, errors: [] } });
    if (url.endsWith("/files/batch")) {
      attempts += 1;
      if (attempts <= 11) return jsonResponse(429, { detail: { code: "index_queue_full", retryable: true, retry_after_seconds: 0 } });
      if (attempts === 12) return jsonResponse(503, { detail: "synthetic gateway failure" });
      return jsonResponse(200, { ok: true, result: { files_received: 1, errors: [] } });
    }
    if (url.endsWith("/commit")) return jsonResponse(200, { ok: true, result: {}, status: { phase: "completed", progress: { ...progressEvent(77, 100, "completed"), retries: 3 } } });
    throw new Error("Unexpected fixture route");
  } });
  const result = await client.indexWorkspace({ workspace: { workspaceId: "fixture" }, files: [{ relativePath: "a.py", content: "x" }], queueWaitTimeoutMs: 3000 });
  assert.equal(result.transfer.upload_attempts, 13);
  assert.equal(result.transfer.queue_full_responses, 11);
  assert.equal(result.transfer.queue_retries, 11);
  assert.equal(result.transfer.transport_retries, 1);
  assert.ok(result.transfer.queue_wait_ms >= 90 && result.transfer.queue_wait_ms < 1000);
  assert.equal(result.status.progress.retries, 3);
});

test("cancelled queue cooldown records rejection and actual wait without a fabricated retry", { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let waits = 0, rejections = 0, retries = 0, attempts = 0;
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async () => {
    attempts += 1;
    setTimeout(() => controller.abort(), 20);
    return jsonResponse(429, { detail: { code: "index_queue_full", retryable: true, retry_after_seconds: 1 } });
  } });
  await assert.rejects(client.uploadFileBatch("fixture", { files: [] }, [], undefined, {
    signal: controller.signal, queueWaitTimeoutMs: 500, onQueueFull: () => rejections++,
    onQueueRetry: () => retries++, onQueueWait: (elapsed) => { waits += elapsed; },
  }), { name: "AbortError" });
  assert.equal(attempts, 1); assert.equal(rejections, 1); assert.equal(retries, 0);
  assert.ok(waits >= 10 && waits < 200);
});

test("client phase timing begins before hashing and excludes earlier manifest work", async () => {
  const events = [];
  const fixture = priorityIndexFixture({ files: [{ relativePath: "a.py", content: "x" }], capability: false });
  const originalManifest = fixture.client.sendManifestBatch.bind(fixture.client);
  fixture.client.sendManifestBatch = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 35));
    return originalManifest(...args);
  };
  const file = { relativePath: "a.py", get content() {
    assert.ok(events.some((event) => event.phase === "filtering_hashing" && event.phase_completed === 0));
    return "x";
  } };
  const result = await fixture.client.indexWorkspace({ ...fixture.request, files: [file], onProgress: (event) => events.push(event) });
  const uploadStart = events.find((event) => event.phase === "uploading");
  assert.ok(uploadStart.elapsed_ms >= 30);
  assert.ok(uploadStart.phase_elapsed_ms < 20);
  assert.ok(result.transfer.client_phase_timings_ms.manifest_comparison >= 30);
  assert.ok(result.transfer.client_phase_timings_ms.uploading < result.transfer.client_phase_timings_ms.manifest_comparison);
});

test("same-sequence queued status emits bounded heartbeats with stable identity", { timeout: 3000 }, async () => {
  const events = [];
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test" });
  const started = Date.now();
  client.getIndexSessionStatus = async () => ({ phase: Date.now() - started >= 1150 ? "completed" : "queued", queue_depth: 1, files_indexed: 0,
    progress: { ...progressEvent(42, 0, "queued"), occurred_at: "2026-10-09T00:00:00Z", elapsed_ms: Date.now() - started + 10, phase_elapsed_ms: Date.now() - started + 5 } });
  await client.followIndexSession("fixture", { pollMs: 10, onProgress: (event) => events.push(event) });
  const heartbeats = events.filter((event) => event.heartbeat);
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].sequence, 42);
  assert.equal(heartbeats[0].event_origin, "server");
  assert.ok(heartbeats[0].phase_elapsed_ms >= 1000);
  assert.ok(heartbeats[0].phase_elapsed_ms < 1250, "Fresh server elapsed is not counted twice");
  assert.ok(heartbeats[0].last_heartbeat_at);
});

test("adaptive polling resets after progress and detach interrupts its delay", { timeout: 2000 }, async () => {
  const times = [];
  const controller = new AbortController();
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test" });
  client.getIndexSessionStatus = async () => {
    times.push(Date.now());
    const count = times.length;
    if (count === 5) setTimeout(() => controller.abort(), 5);
    return { phase: "queued", queue_depth: 1, files_indexed: 0, progress: progressEvent(count >= 4 ? 2 : 1, 0, "queued") };
  };
  await assert.rejects(client.followIndexSession("fixture", { pollMs: 40, detachSignal: controller.signal }), RemoteIndexDetachedError);
  assert.ok(times[3] - times[2] >= 80, "Idle polling backs off");
  assert.ok(times[4] - times[3] < times[3] - times[2], "Progress resets the poll interval");
  assert.ok(times[5] - times[4] < 35, "Detach wakes the pending delay");
});


test("large polling intervals respect absolute follow deadlines", { timeout: 1000 }, async () => {
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test" });
  client.getIndexSessionStatus = async () => ({ phase: "queued", queue_depth: 1, files_indexed: 0, progress: progressEvent(1, 0, "queued") });
  const startedAt = Date.now();
  await assert.rejects(client.followIndexSession("fixture", { pollMs: 30_000, timeoutMs: 30 }), RemoteIndexDetachedError);
  assert.ok(Date.now() - startedAt < 200);
});


test("configuration delay is excluded from hashing and queue heartbeat callback failure is awaited", { timeout: 3000 }, async () => {
  const fixture = priorityIndexFixture({ files: [{ relativePath: "a.py", content: "x" }], capability: false });
  const originalStart = fixture.client.startIndexSession.bind(fixture.client);
  fixture.client.startIndexSession = async (...args) => { await new Promise((resolve) => setTimeout(resolve, 40)); return originalStart(...args); };
  const result = await fixture.client.indexWorkspace(fixture.request);
  assert.ok(result.transfer.client_phase_timings_ms.resolving_configuration >= 35);
  assert.ok(result.transfer.client_phase_timings_ms.filtering_hashing < 30);
  let attempts = 0, retries = 0;
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async () => {
    attempts += 1;
    return jsonResponse(429, { detail: { code: "index_queue_full", retryable: true, retry_after_seconds: 2 } });
  } });
  await assert.rejects(client.uploadFileBatch("fixture", { files: [] }, [], undefined, {
    queueWaitTimeoutMs: 2500, onQueueRetry: () => retries++,
    onQueueHeartbeat: (_elapsed, heartbeat) => { if (heartbeat) throw new Error("Synthetic observer failure"); },
  }), /Synthetic observer failure/);
  assert.equal(attempts, 1); assert.equal(retries, 0);
});


test("synchronous upload tiers exclude delayed code checkpoint from upload timing", { timeout: 2000 }, async () => {
  const fixture = priorityIndexFixture({ files: [
    { relativePath: "main.py", content: "x" }, { relativePath: "README.md", content: "guide" },
  ], onUpload: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); } });
  const originalUpload = fixture.client.uploadFileBatch.bind(fixture.client);
  fixture.client.uploadFileBatch = async (...args) => ({ ...await originalUpload(...args), queued: false });
  const originalCheckpoint = fixture.client.checkpointIndexSessionCode.bind(fixture.client);
  let checkpointWaitMs = 0;
  fixture.client.checkpointIndexSessionCode = async (...args) => {
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const status = await originalCheckpoint(...args);
    checkpointWaitMs = Date.now() - startedAt;
    return status;
  };
  const result = await fixture.client.indexWorkspace(fixture.request);
  assert.equal(result.transfer.files_transferred, 2);
  assert.equal(fixture.calls.filter((call) => call.type === "checkpoint").length, 1);
  const uploadMs = result.transfer.client_phase_timings_ms.uploading;
  assert.ok(uploadMs >= 15, "Both synchronous upload tiers remain measured");
  assert.ok(uploadMs < checkpointWaitMs, "Checkpoint wait must not inflate upload time");
  assert.deepEqual(fixture.calls.filter((call) => call.type === "upload").map((call) => call.paths), [["main.py"], ["README.md"]]);
});

test("failed upload timing stops before delayed abort response cleanup", { timeout: 2000 }, async () => {
  const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }], capability: false });
  fixture.client.uploadFileBatch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw new Error("Synthetic upload rejection");
  };
  const originalAbort = fixture.client.abortIndexSession.bind(fixture.client);
  let abortWaitMs = 0;
  fixture.client.abortIndexSession = async (...args) => {
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const response = await originalAbort(...args);
    abortWaitMs = Date.now() - startedAt;
    return response;
  };
  await assert.rejects(fixture.client.indexWorkspace(fixture.request), (error) => {
    assert.match(error.message, /Synthetic upload rejection/);
    assert.equal(error.transfer.complete, false);
    assert.equal(error.transfer.files_transferred, 0);
    const uploadMs = error.transfer.client_phase_timings_ms.uploading;
    assert.ok(uploadMs >= 15, "Time spent attempting the upload remains measured");
    assert.ok(uploadMs < abortWaitMs, "Abort cleanup must not inflate upload time");
    return true;
  });
  assert.equal(fixture.calls.filter((call) => call.type === "abort").length, 1);
});


test("explicit code stage submits the complete manifest, publishes only code and confirms drained release", async () => {
  const fixture = priorityIndexFixture({ files: [
    { relativePath: "main.py", content: "x" }, { relativePath: "README.md", content: "guide" },
    { relativePath: "settings.json", content: "{}" },
  ] });
  let manifestPaths, checkpoint;
  const originalManifest = fixture.client.sendManifestBatch.bind(fixture.client);
  fixture.client.sendManifestBatch = async (session, entries) => { manifestPaths = entries.map((entry) => entry.relativePath); return originalManifest(session, entries); };
  const result = await fixture.client.indexWorkspaceCodeStage({ ...fixture.request, onCodeReady: (status) => { checkpoint = status; } });
  assert.equal(result.outcome, "code_ready");
  assert.equal(result.full_inventory_complete, false);
  assert.equal(result.transfer.complete, false);
  assert.equal(result.transfer.files_submitted, 3);
  assert.equal(result.transfer.files_transferred, 1);
  assert.equal(result.checkpoint, checkpoint);
  assert.equal(result.checkpoint.coverage.code_ready, true);
  assert.equal(result.checkpoint.coverage.documentation_pending, true);
  assert.equal(result.release_status.phase, "aborted");
  assert.equal(result.release_status.pending_batches, 0);
  assert.equal(result.release_status.active_batches, 0);
  assert.deepEqual(manifestPaths.sort(), ["README.md", "main.py", "settings.json"]);
  assert.deepEqual(fixture.calls.filter((call) => call.type !== "status"), [
    { type: "upload", paths: ["main.py"] }, { type: "checkpoint" }, { type: "abort" },
  ]);
});

test("code stage defers documentation-only roots and fully commits empty or unsupported roots", async () => {
  const docs = priorityIndexFixture({ files: [{ relativePath: "README.md", content: "guide" }] });
  assert.deepEqual(await docs.client.indexWorkspaceCodeStage(docs.request), {
    outcome: "deferred", reason: "no_code", full_inventory_complete: false, files_submitted: 1,
  });
  assert.deepEqual(docs.calls, []);
  for (const empty of [true, false]) {
    const fixture = priorityIndexFixture({ files: empty ? [] : [{ relativePath: "main.py", content: "x" }], capability: false });
    const result = await fixture.client.indexWorkspaceCodeStage(fixture.request);
    assert.equal(result.outcome, "full");
    assert.equal(result.reason, empty ? "empty_inventory" : "checkpoint_unsupported");
    assert.equal(result.committed.transfer.complete, true);
    assert.equal(fixture.calls.filter((call) => call.type === "commit").length, 1);
    assert.equal(fixture.calls.some((call) => call.type === "abort"), false);
  }
});

test("code-stage cancellation preserves published code without uploading documentation or claiming completion", async () => {
  const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }, { relativePath: "README.md", content: "guide" }] });
  const controller = new AbortController();
  let ready;
  await assert.rejects(fixture.client.indexWorkspaceCodeStage({ ...fixture.request, signal: controller.signal,
    onCodeReady: (status) => { ready = status; controller.abort(); },
  }), (error) => {
    assert.ok(error instanceof RemoteIndexCancelledError);
    assert.equal(error.transfer.complete, false);
    assert.equal(error.transfer.files_transferred, 1);
    return true;
  });
  assert.equal(ready.coverage.code_ready, true);
  assert.equal(fixture.calls.filter((call) => call.type === "checkpoint").length, 1);
  assert.deepEqual(fixture.calls.filter((call) => call.type === "upload").map((call) => call.paths), [["main.py"]]);
  assert.equal(fixture.calls.some((call) => call.type === "commit"), false);
});

for (const stall of ["headers", "body"]) {
  for (const interruption of ["deadline", "cancel", "detach"]) {
    test(`code-stage release bounds stalled ${stall} on ${interruption} and confirms cleanup separately`, { timeout: 2000 }, async (t) => {
      let now = 0;
      t.mock.method(Date, "now", () => now);
      const delays = [], signals = [];
      const nativeSetTimeout = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
        delays.push(delay); return nativeSetTimeout(callback, delay, ...args);
      });
      const controller = new AbortController();
      const fixture = priorityIndexFixture({ files: [
        { relativePath: "main.py", content: "x" }, { relativePath: "README.md", content: "guide" },
      ] });
      const originalFetch = fixture.client.fetchFn;
      let deletes = 0, ready;
      fixture.client.fetchFn = async (url, init) => {
        if (init.method !== "DELETE") return originalFetch(url, init);
        signals.push(init.signal);
        if (++deletes > 1) return originalFetch(url, init);
        const stallForever = () => {
          if (interruption !== "deadline") queueMicrotask(() => controller.abort());
          return new Promise(() => {}); // Deliberately ignore transport abort.
        };
        if (stall === "headers") return stallForever();
        const response = await originalFetch(url, init);
        response.json = stallForever;
        return response;
      };
      await assert.rejects(fixture.client.indexWorkspaceCodeStage({ ...fixture.request,
        signal: interruption === "cancel" ? controller.signal : undefined,
        detachSignal: interruption === "detach" ? controller.signal : undefined,
        onCodeReady: (status) => { ready = status; now = 80; },
      }), (error) => {
        assert.equal(error instanceof RemoteIndexDetachedError, false);
        if (interruption === "cancel") {
          assert.ok(error instanceof RemoteIndexCancelledError);
          assert.equal(error.status.phase, "aborted");
          assert.equal(error.status.pending_batches, 0);
          assert.equal(error.status.active_batches, 0);
        } else {
          assert.match(error.message, /owned session abort was confirmed/);
          if (interruption === "deadline") assert.match(error.cause.message, /release timed out/);
        }
        assert.equal(error.transfer.complete, false);
        assert.equal(error.transfer.files_transferred, 1);
        return true;
      });
      assert.equal(ready.coverage.code_ready, true);
      assert.equal(deletes, 2, "Cleanup uses a new request after the stalled request is bounded");
      assert.ok(signals.every((signal) => signal instanceof AbortSignal && signal.aborted));
      assert.ok(delays.includes(20), "Release retains only the unspent processing budget");
      assert.ok(delays.includes(1000), "Best-effort cleanup has an independent capped reserve");
      assert.equal(fixture.calls.some((call) => call.type === "commit"), false);
      assert.deepEqual(fixture.calls.filter((call) => call.type === "upload").map((call) => call.paths), [["main.py"]]);
    });
  }
}

test("code-stage cancellation bounds uncooperative release and cleanup without claiming slot release", { timeout: 2500 }, async () => {
  const controller = new AbortController();
  const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }] });
  const originalFetch = fixture.client.fetchFn;
  const signals = [];
  fixture.client.fetchFn = (url, init) => {
    if (init.method !== "DELETE") return originalFetch(url, init);
    signals.push(init.signal);
    if (signals.length === 1) queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  };
  await assert.rejects(fixture.client.indexWorkspaceCodeStage({ ...fixture.request,
    processingTimeoutMs: undefined, signal: controller.signal,
  }), (error) => {
    assert.equal(error instanceof RemoteIndexCancelledError, false);
    assert.equal(error instanceof RemoteIndexDetachedError, false);
    assert.match(error.message, /release could not be confirmed/);
    assert.equal(error.transfer.complete, false);
    return true;
  });
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(fixture.calls.some((call) => call.type === "commit"), false);
});

for (const stall of ["headers", "body"]) {
  for (const interruption of ["deadline", "cancel"]) {
    test(`terminal release ${stall} receives transport signal and bounds ignored abort on ${interruption}`, { timeout: 2000 }, async (t) => {
      let now = 0;
      t.mock.method(Date, "now", () => now);
      const controller = new AbortController();
      const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }] });
      const originalFetch = fixture.client.fetchFn;
      const statusSignals = [], deleteSignals = [];
      fixture.client.fetchFn = async (url, init) => {
        if (init.method === "DELETE") deleteSignals.push(init.signal);
        const response = await originalFetch(url, init);
        if (!url.endsWith("/status") || deleteSignals.length === 0) return response;
        statusSignals.push(init.signal);
        if (deleteSignals.length > 1) return response;
        const stallForever = () => {
          if (interruption === "cancel") queueMicrotask(() => controller.abort());
          return new Promise(() => {});
        };
        if (stall === "headers") return stallForever();
        response.json = stallForever;
        return response;
      };
      await assert.rejects(fixture.client.indexWorkspaceCodeStage({ ...fixture.request,
        signal: interruption === "cancel" ? controller.signal : undefined,
        onCodeReady: () => { now = 80; },
      }), (error) => {
        if (interruption === "cancel") assert.ok(error instanceof RemoteIndexCancelledError);
        else assert.match(error.message, /owned session abort was confirmed/);
        assert.equal(error.transfer.complete, false);
        return true;
      });
      assert.equal(statusSignals.length, 2);
      assert.equal(statusSignals[0], deleteSignals[0]);
      assert.equal(statusSignals[1], deleteSignals[1]);
      assert.ok(statusSignals.every((signal) => signal instanceof AbortSignal && signal.aborted));
    });
  }
}

test("cooperative terminal GET is aborted on caller cancellation before cleanup uses a fresh signal", async () => {
  const controller = new AbortController();
  const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }] });
  const originalFetch = fixture.client.fetchFn;
  let deletes = 0, abortedReads = 0;
  fixture.client.fetchFn = async (url, init) => {
    if (init.method === "DELETE") deletes += 1;
    if (!url.endsWith("/status") || deletes !== 1) return originalFetch(url, init);
    assert.ok(init.signal instanceof AbortSignal);
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => { abortedReads += 1; reject(new DOMException("Stopped", "AbortError")); }, { once: true });
      queueMicrotask(() => controller.abort());
    });
  };
  await assert.rejects(fixture.client.indexWorkspaceCodeStage({ ...fixture.request, signal: controller.signal }), RemoteIndexCancelledError);
  assert.equal(abortedReads, 1);
  assert.equal(deletes, 2);
});

test("terminal polling cancellation removes its pending delay without another abandoned GET", async (t) => {
  const controller = new AbortController();
  const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }] });
  const originalFetch = fixture.client.fetchFn;
  const nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
  const timers = new Map(), clearedDelays = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const timer = nativeSetTimeout(callback, delay, ...args); timers.set(timer, delay); return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    clearedDelays.push(timers.get(timer)); return nativeClearTimeout(timer);
  });
  let deletes = 0, terminalReads = 0;
  fixture.client.fetchFn = async (url, init) => {
    const response = await originalFetch(url, init);
    if (init.method === "DELETE") deletes += 1;
    if (!url.endsWith("/status") || deletes === 0) return response;
    terminalReads += 1;
    if (deletes > 1) return response;
    const payload = await response.json();
    payload.result.phase = "indexing";
    payload.result.progress = { ...progressEvent(991, 80, "queued"), session_id: "priority" };
    return jsonResponse(200, payload);
  };
  await assert.rejects(fixture.client.indexWorkspaceCodeStage({ ...fixture.request,
    processingTimeoutMs: 2000, processingPollMs: 500, signal: controller.signal,
    onProgress: (event) => { if (event.sequence === 991) queueMicrotask(() => controller.abort()); },
  }), RemoteIndexCancelledError);
  assert.ok(clearedDelays.includes(500), "Transport cancellation removes the pending terminal poll delay");
  assert.equal(terminalReads, 2, "Only the original attempt and independent cleanup read status");
});

test("late terminal response cannot extend the absolute release deadline after DELETE", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }] });
  const originalFetch = fixture.client.fetchFn;
  let deletes = 0;
  fixture.client.fetchFn = async (url, init) => {
    const response = await originalFetch(url, init);
    if (init.method === "DELETE") { if (++deletes === 1) now = 90; }
    if (url.endsWith("/status") && deletes === 1) now = 101;
    return response;
  };
  await assert.rejects(fixture.client.indexWorkspaceCodeStage({ ...fixture.request,
    onCodeReady: () => { now = 80; },
  }), (error) => {
    assert.match(error.message, /release was interrupted/);
    assert.match(error.cause.message, /timed out/);
    assert.equal(error.transfer.complete, false);
    return true;
  });
  assert.equal(deletes, 2, "Late terminal evidence enters independently bounded cleanup instead of stage success");
});

test("code-stage failed checkpoint, release or incomplete scan cannot masquerade as full success", async () => {
  for (const failure of ["checkpoint", "release", "active release", "unknown release"]) {
    const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }] });
    if (failure === "checkpoint") fixture.client.checkpointIndexSessionCode = async () => ({ coverage: { code_ready: false } });
    else if (failure === "release") fixture.client.abortIndexSession = async () => { throw new Error("Synthetic abort outage"); };
    else fixture.client.getIndexSessionStatus = async () => ({ phase: fixture.calls.some((call) => call.type === "abort") ? "aborted" : "indexing",
      pending_batches: failure === "unknown release" && fixture.calls.some((call) => call.type === "abort") ? undefined : 0,
      active_batches: failure === "active release" && fixture.calls.some((call) => call.type === "abort") ? 1 : 0, queue_depth: 0, errors: [] });
    await assert.rejects(fixture.client.indexWorkspaceCodeStage(fixture.request));
    assert.equal(fixture.calls.some((call) => call.type === "commit"), false);
  }
  const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }] });
  await assert.rejects(fixture.client.indexWorkspaceCodeStage({ ...fixture.request, inventoryScan: undefined }), { code: "scan_incomplete" });
  assert.deepEqual(fixture.calls, []);
});

test("public capability and health declarations retain additive code-readiness fields", () => {
  const declarations = readFileSync(new URL("../dist/types.d.ts", import.meta.url), "utf8");
  assert.match(declarations, /file_batch_priorities\?:\s*\{\s*code: number;\s*documentation: number;\s*other: number;/);
  const indexHealth = declarations.slice(declarations.indexOf("interface IndexHealth"), declarations.indexOf("interface IndexHealth") + 1600);
  for (const flag of ["code_ready", "documentation_pending", "other_pending"]) assert.match(indexHealth, new RegExp(`${flag}\\?: boolean`));
});


test("health and indexing capabilities preserve server code readiness and processing quantum metadata", async () => {
  const metadata = { file_batch_priorities: { code: 1, documentation: 2, other: 3 },
    max_processing_files: 4, max_processing_source_bytes: 1000,
    processing_quantum_boundary: "complete_files", chunk_stream_preemption: false };
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (url) =>
    jsonResponse(200, url.endsWith("/capabilities") ? { ok: true, ...metadata }
      : { ok: true, index: { code_ready: true, documentation_pending: true, other_pending: false } }) });
  const capabilities = await client.getIndexCapabilities();
  for (const [key, value] of Object.entries(metadata)) assert.deepEqual(capabilities[key], value);
  assert.deepEqual((await client.health()).index, { code_ready: true, documentation_pending: true, other_pending: false });
});


test("code stage rejects malformed pending checkpoint evidence before release success", async () => {
  for (const change of [
    { coverage: { code_ready: true, state: "verified" } },
    { pending_batches: 1 }, { active_batches: 1 }, { pending_batches: undefined },
    { phase: "failed" }, { errors: ["synthetic worker failure"] },
  ]) {
    const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }] });
    const checkpoint = fixture.client.checkpointIndexSessionCode.bind(fixture.client);
    fixture.client.checkpointIndexSessionCode = async (...args) => ({ ...await checkpoint(...args), ...change });
    let readyCallbacks = 0;
    await assert.rejects(fixture.client.indexWorkspaceCodeStage({ ...fixture.request, onCodeReady: () => readyCallbacks++ }), /drained pending code publication/);
    assert.equal(readyCallbacks, 0);
    assert.equal(fixture.calls.some((call) => call.type === "commit"), false);
  }
});

test("code-stage full fallback distinguishes verified coverage from legacy unknown and rejects pending commit", async () => {
  for (const state of ["verified", "pending", undefined]) {
    const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }], capability: false });
    const commit = fixture.client.commitIndexSession.bind(fixture.client);
    fixture.client.commitIndexSession = async (...args) => {
      const result = await commit(...args);
      return { ...result, status: { ...result.status, coverage: state ? { state } : undefined } };
    };
    const result = await fixture.client.indexWorkspaceCodeStage(fixture.request);
    assert.equal(result.outcome, "full");
    assert.equal(result.full_inventory_complete, state === "verified");
    assert.equal(result.committed.transfer.complete, true);
  }
  const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }], capability: false });
  fixture.client.commitIndexSession = async () => ({ ok: true, result: {}, status: { phase: "indexing", coverage: { state: "pending" } } });
  await assert.rejects(fixture.client.indexWorkspaceCodeStage(fixture.request), (error) => {
    assert.equal(error.code, "scan_incomplete");
    assert.equal(error.transfer.complete, false);
    return true;
  });
});


test("code-stage checkpoint proof is bound to owned identity before readiness callback", async () => {
  for (const change of [
    { session_id: "another-session" }, { workspace_id: "another-workspace" },
    { mode: "incremental" }, { collection_name: "another-collection" }, { phase: undefined },
    { phase: "indexing" }, { errors: undefined }, { errors: "synthetic failure" }, { failed_batches: 1 },
    { coverage: { state: "pending", code_ready: true, session_id: "another-session" } },
    { coverage: { state: "pending", code_ready: true } },
  ]) {
    const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }] });
    const checkpoint = fixture.client.checkpointIndexSessionCode.bind(fixture.client);
    fixture.client.checkpointIndexSessionCode = async (...args) => ({ ...await checkpoint(...args), ...change });
    let callbacks = 0;
    await assert.rejects(fixture.client.indexWorkspaceCodeStage({ ...fixture.request, onCodeReady: () => callbacks++ }), /drained pending code publication/);
    assert.equal(callbacks, 0, `Malformed checkpoint must not publish callback: ${JSON.stringify(change)}`);
    assert.equal(fixture.calls.some((call) => call.type === "commit"), false);
  }
});

test("code-stage release proof cannot confirm another session or conflicting scope", async () => {
  for (const change of [
    { session_id: "another-session" }, { workspace_id: "another-workspace" },
    { mode: "incremental" }, { collection_name: "another-collection" },
    { errors: undefined }, { errors: ["synthetic abort error"] }, { failed_batches: 1 },
    { coverage: { state: "pending", code_ready: true, session_id: "another-session" } },
  ]) {
    const fixture = priorityIndexFixture({ files: [{ relativePath: "main.py", content: "x" }] });
    const getStatus = fixture.client.getIndexSessionStatus.bind(fixture.client);
    fixture.client.getIndexSessionStatus = async (...args) => {
      const status = await getStatus(...args);
      return status.phase === "aborted" ? { ...status, ...change } : status;
    };
    let callbacks = 0;
    await assert.rejects(fixture.client.indexWorkspaceCodeStage({ ...fixture.request, onCodeReady: () => callbacks++ }), /session release was not confirmed/);
    assert.equal(callbacks, 1, "Owned publication may precede failed release proof; it never becomes stage success");
    assert.equal(fixture.calls.some((call) => call.type === "commit"), false);
  }
});
