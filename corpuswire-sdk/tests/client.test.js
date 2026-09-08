import test from "node:test";
import assert from "node:assert/strict";

import {
  CorpusWireClient,
  CorpusWireHttpError,
  RemoteIndexCancelledError,
  RemoteIndexDetachedError,
  ReviewContextPollingCancelledError,
  ReviewContextPollingTimeoutError,
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
  toStartIndexSessionPayload,
} from "../dist/index.js";

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
  assert.equal(statusReads, 2);
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

test("partial upload error waits for in-flight acknowledgements and retains truthful counts", async () => {
  let attempts = 0;
  const client = new CorpusWireClient({ baseUrl: "http://fixture.test", fetchFn: async (url, init) => {
    if (url.endsWith("/sessions")) return jsonResponse(200, {ok:true,result:{session_id:"partial",max_batch_bytes:1000,max_batch_files:1,max_concurrent_uploads:2}});
    if (url.endsWith("/manifest/batch")) return jsonResponse(200, {ok:true,result:{accepted:2,upload_required:["a.py","b.py"],unchanged:0,deletes:0,skipped:0,errors:[]}});
    if (url.endsWith("/files/batch")) {
      attempts += 1;
      const body = await init.body.text();
      if (body.includes("synth_fail")) return jsonResponse(400, {detail:"synthetic rejection"});
      await new Promise((resolve) => setTimeout(resolve, 10));
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
