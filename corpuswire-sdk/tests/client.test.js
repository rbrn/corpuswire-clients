import test from "node:test";
import assert from "node:assert/strict";

import {
  CorpusWireClient,
  CorpusWireHttpError,
  createBasicAuthHeader,
  createBearerAuthHeader,
  manifestEntriesToJsonl,
  requestJson,
  requireEnhancedPrompt,
  toEnhancePayload,
  toQueryPayload,
  toQualityEventPayload,
  toStartIndexSessionPayload,
} from "../dist/index.js";

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? "OK" : "ERROR",
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
      workType: "semantic_retrieval",
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
      work_type: "semantic_retrieval",
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
    days: 14,
  });

  assert.equal(event.event_id, "quality-1");
  assert.equal(review.event_count, 1);
  assert.equal(calls[0].input, "http://example.test/v1/quality/events");
  assert.equal(calls[1].input, "http://example.test/v1/quality/review?workspace_id=local-docker%3A%2F%2Fdemo%23main&days=14");
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
          workspace_id: "vscode-remote://ssh/project",
          collection: "remote-project",
        },
      });
    },
  });

  const result = await client.query({
    workspaceId: "vscode-remote://ssh/project",
    query: "find remote indexer",
  });

  assert.equal(calls[0].input, "http://example.test/query");
  assert.equal(calls[0].body.workspace_id, "vscode-remote://ssh/project");
  assert.equal(calls[0].body.include_answer, false);
  assert.equal(result.augmented_prompt, "Use remote indexer context.");
  assert.equal(result.agent_context_packets[0].role, "integration");
  assert.deepEqual(result.agent_context_packets[0].line_ranges, ["1200-1240"]);
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
