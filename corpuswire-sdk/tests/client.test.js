import test from "node:test";
import assert from "node:assert/strict";

import {
  CorpusWireClient,
  CorpusWireHttpError,
  createBasicAuthHeader,
  manifestEntriesToJsonl,
  requestJson,
  requireEnhancedPrompt,
  toEnhancePayload,
  toQueryPayload,
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
          generation_provider_preference: "openclaw",
          openai_compat_profile: "auto",
          openai_base_url: null,
          basic_auth_enabled: false,
          basic_auth_uses_fallback: false,
          embedding_order: ["hash:local-fallback"],
          generation_order: ["openclaw:openai-codex/gpt-5.3-codex"],
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
  assert.equal(result.runtime.generation_provider_preference, "openclaw");
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

test("createBasicAuthHeader encodes credentials for backend auth", () => {
  assert.equal(createBasicAuthHeader("user:pass"), "Basic dXNlcjpwYXNz");
});
