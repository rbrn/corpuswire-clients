import test from "node:test";
import assert from "node:assert/strict";

import { main, parseCliArgs, runCliCommand } from "../lib/cli.js";

test("parseCliArgs handles enhance flags", () => {
  const parsed = parseCliArgs([
    "enhance",
    "fix",
    "the",
    "bug",
    "--output-mode",
    "claude-code",
    "--top-k",
    "7",
    "--min-score",
    "0.3",
    "--local-only",
  ]);

  assert.equal(parsed.command, "enhance");
  assert.equal(parsed.outputMode, "claude-code");
  assert.equal(parsed.topK, 7);
  assert.equal(parsed.minScore, 0.3);
  assert.equal(parsed.localOnly, true);
  assert.equal(parsed.workspaceId, "");
  assert.equal(parsed.repoPath, "");
  assert.deepEqual(parsed.promptParts, ["fix", "the", "bug"]);
});

test("parseCliArgs handles remote workspace selectors", () => {
  const parsed = parseCliArgs([
    "search",
    "remote",
    "indexer",
    "--workspace-id",
    "vscode-remote://ssh/project",
    "--repo-path",
    "/service/repo",
  ]);

  assert.equal(parsed.command, "search");
  assert.equal(parsed.workspaceId, "vscode-remote://ssh/project");
  assert.equal(parsed.repoPath, "/service/repo");
  assert.deepEqual(parsed.promptParts, ["remote", "indexer"]);
});

test("parseCliArgs handles index event filters", () => {
  const parsed = parseCliArgs([
    "index-events",
    "--workspace-id",
    "workspace-1",
    "--collection",
    "collection-1",
    "--status",
    "failed",
    "--operation",
    "remote_index_commit",
    "--limit",
    "20",
  ]);

  assert.equal(parsed.command, "index-events");
  assert.equal(parsed.workspaceId, "workspace-1");
  assert.equal(parsed.collection, "collection-1");
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.operation, "remote_index_commit");
  assert.equal(parsed.limit, 20);
});

test("runCliCommand prints the enhanced prompt by default", async () => {
  const writes = [];
  const calls = [];
  const fakeClient = {
    enhanceRaw: async (request) => {
      calls.push(request);
      return {
      ok: true,
      result: {
        enhanced_prompt: "enhanced prompt",
        enhancement_prompt: "fallback prompt",
      },
      };
    },
  };

  await runCliCommand(
    {
      command: "enhance",
      apiBaseUrl: "http://127.0.0.1:8000",
      outputMode: "generic",
      repoPath: "",
      workspaceId: "workspace-1",
      topK: undefined,
      minScore: undefined,
      localOnly: false,
      json: false,
      basicAuth: "",
      promptParts: ["fix", "the", "bug"],
    },
    {
      client: fakeClient,
      write: (line) => writes.push(line),
    },
  );

  assert.deepEqual(writes, ["enhanced prompt"]);
  assert.equal(calls[0].workspaceId, "workspace-1");
});

test("runCliCommand prints semantic search results", async () => {
  const writes = [];
  const fakeClient = {
    queryRaw: async (request) => ({
      ok: true,
      result: {
        retrieved_chunks: [
          {
            score: 0.88,
            text: "remote indexing uses workspace_id",
            metadata: {
              source_path: "src/corpuswire/api/app.py",
              section_heading: "query_documents",
            },
          },
        ],
      },
      context: {
        workspace_id: request.workspaceId,
        collection: "remote-project",
      },
    }),
  };

  await runCliCommand(
    {
      command: "search",
      apiBaseUrl: "http://127.0.0.1:8000",
      outputMode: "generic",
      repoPath: "",
      workspaceId: "workspace-1",
      topK: undefined,
      minScore: undefined,
      localOnly: false,
      json: false,
      basicAuth: "",
      promptParts: ["remote", "indexer"],
    },
    {
      client: fakeClient,
      write: (line) => writes.push(line),
    },
  );

  assert.match(writes[0], /src\/corpuswire\/api\/app\.py/);
  assert.match(writes[0], /remote indexing uses workspace_id/);
});

test("runCliCommand prints index activity", async () => {
  const writes = [];
  const fakeClient = {
    getIndexActivity: async () => ({
      available: true,
      events_in_window: 3,
      last_attempt_at: "2026-05-10T09:00:00+00:00",
      last_attempt_status: "completed",
      last_success_at: "2026-05-10T09:00:00+00:00",
      consecutive_failures: 0,
      gap_detected: false,
    }),
  };

  await runCliCommand(
    {
      command: "index-activity",
      apiBaseUrl: "http://127.0.0.1:8000",
      outputMode: "generic",
      repoPath: "",
      workspaceId: "workspace-1",
      collection: undefined,
      topK: undefined,
      minScore: undefined,
      localOnly: false,
      json: false,
      basicAuth: "",
      promptParts: [],
    },
    {
      client: fakeClient,
      write: (line) => writes.push(line),
    },
  );

  assert.match(writes.join("\n"), /events in window: 3/);
  assert.match(writes.join("\n"), /gap detected: false/);
});

test("runCliCommand prints index events", async () => {
  const writes = [];
  const calls = [];
  const fakeClient = {
    getIndexEvents: async (request) => {
      calls.push(request);
      return [
        {
          occurred_at: "2026-05-10T09:00:00+00:00",
          status: "completed",
          operation: "local_ingest",
          source_root: "/repo",
          files_indexed: 2,
          files_deleted: 0,
          files_skipped: 0,
          chunks_indexed: 4,
        },
      ];
    },
  };

  await runCliCommand(
    {
      command: "index-events",
      apiBaseUrl: "http://127.0.0.1:8000",
      outputMode: "generic",
      repoPath: "",
      workspaceId: "workspace-1",
      collection: "collection-1",
      status: "completed",
      operation: "local_ingest",
      limit: 5,
      topK: undefined,
      minScore: undefined,
      localOnly: false,
      json: false,
      basicAuth: "",
      promptParts: [],
    },
    {
      client: fakeClient,
      write: (line) => writes.push(line),
    },
  );

  assert.deepEqual(calls[0], {
    workspaceId: "workspace-1",
    collection: "collection-1",
    status: "completed",
    operation: "local_ingest",
    limit: 5,
  });
  assert.match(writes[0], /completed local_ingest/);
});

test("main prints help when no argv are provided", async () => {
  const writes = [];
  await main([], {
    write: (line) => writes.push(line),
  });

  assert.equal(writes.length, 1);
  assert.match(writes[0], /corpuswire/);
  assert.match(writes[0], /Usage:/);
});
