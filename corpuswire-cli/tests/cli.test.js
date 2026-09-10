import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import {
  createIndexTraceCollector,
  createProgressRenderer,
  formatProgressLine,
  main,
  parseCliArgs,
  runCliCommand,
  sanitizeTerminalText,
} from "../lib/cli.js";

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

test("main prints the installed CLI version", async () => {
  const writes = [];
  await main(["--version"], { write: (line) => writes.push(line) });
  assert.deepEqual(writes, ["0.1.3"]);
});

test("parseCliArgs supports the interactive index command", () => {
  const parsed = parseCliArgs([
    "index", "--source-root", "/tmp/demo", "--mode", "incremental",
    "--include", "**/*.ts", "--exclude", "dist/**", "--ndjson", "--trace", "--yes",
  ]);

  assert.equal(parsed.command, "index");
  assert.equal(parsed.sourceRoot, "/tmp/demo");
  assert.equal(parsed.mode, "incremental");
  assert.deepEqual(parsed.includeGlobs, ["**/*.ts"]);
  assert.deepEqual(parsed.excludeGlobs, ["dist/**"]);
  assert.equal(parsed.ndjson, true);
  assert.equal(parsed.trace, true);
  assert.equal(parsed.yes, true);
});

test("index confirmation defaults to no and makes no mutation", async () => {
  const fixture = await syntheticWorkspace();
  const writes = [];
  const prompts = [];
  let mutations = 0;
  const client = fakeIndexClient({
    indexWorkspace: async () => {
      mutations += 1;
      throw new Error("must not mutate");
    },
  });
  try {
    const result = await runCliCommand(indexOptions(fixture), {
      client,
      write: (line) => writes.push(line),
      writeRaw: () => {},
      isTTY: false,
      confirm: async (prompt) => {
        prompts.push(prompt);
        return "";
      },
    });

    assert.equal(result.mutated, false);
    assert.equal(mutations, 0);
    assert.deepEqual(prompts, ["Start indexing this workspace? [y/N]"]);
    assert.match(writes.join("\n"), /No index mutation was made/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("index confirmation treats an actual stdin EOF as no and reports no mutation", async () => {
  const fixture = await syntheticWorkspace();
  const writes = [];
  let mutations = 0;
  try {
    const result = await runCliCommand(indexOptions(fixture), {
      client: fakeIndexClient({
        indexWorkspace: async () => {
          mutations += 1;
          throw new Error("must not mutate");
        },
      }),
      write: (line) => writes.push(line),
      writeRaw: () => {},
      isTTY: false,
      input: Readable.from([]),
      output: new PassThrough(),
    });

    assert.equal(result.mutated, false);
    assert.equal(mutations, 0);
    assert.match(writes.join("\n"), /No index mutation was made/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("index preview redacts credentials from the service URL", async () => {
  const fixture = await syntheticWorkspace();
  const writes = [];
  try {
    await runCliCommand({
      ...indexOptions(fixture),
      apiBaseUrl: "http://user:password@127.0.0.1:18080/?token=sensitive",
    }, {
      client: fakeIndexClient(),
      write: (line) => writes.push(line),
      writeRaw: () => {},
      isTTY: false,
      confirm: async () => "",
    });
    const output = writes.join("\n");
    assert.equal(output.includes("password"), false);
    assert.equal(output.includes("sensitive"), false);
    assert.match(output, /token=\[redacted\]/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("recursive include glob also matches files at the workspace root", async () => {
  const fixture = await syntheticWorkspace();
  let previewRequest;
  const client = fakeIndexClient({
    previewIndexWorkspace: async (request) => {
      previewRequest = request;
      return {
        workspace_id: request.workspace.workspaceId,
        collection_name: "collection-cli",
        requested_mode: request.mode,
        expected_mode: "full",
        candidates: request.files.length,
        included: request.files.length,
        excluded: 0,
        changed: request.files.length,
        unchanged: 0,
        deleted: 0,
        candidate_bytes: 12,
        destructive_risk: false,
      };
    },
  });
  try {
    await runCliCommand({ ...indexOptions(fixture), includeGlobs: ["**/*.md"] }, {
      client,
      write: () => {},
      writeRaw: () => {},
      isTTY: false,
      confirm: async () => "",
    });
    assert.deepEqual(previewRequest.files.map((file) => file.relativePath), ["README.md"]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("index resolves JSONC workspace settings before deriving folder defaults", async () => {
  const fixture = await syntheticWorkspace();
  await mkdir(path.join(fixture, ".vscode"));
  await writeFile(path.join(fixture, ".vscode", "settings.json"), `{
    // A normal VS Code JSONC settings file.
    "corpuswire.remoteIndexing.workspaceId": "demo://settings-workspace#main",
    "corpuswire.services.indexer.url": "http://127.0.0.1:19090",
  }\n`);
  let previewRequest;
  const writes = [];
  const client = fakeIndexClient({
    previewIndexWorkspace: async (request) => {
      previewRequest = request;
      return {
        workspace_id: request.workspace.workspaceId,
        collection_name: "collection-cli",
        requested_mode: request.mode,
        expected_mode: "full",
        candidates: request.files.length,
        included: request.files.length,
        excluded: 0,
        changed: request.files.length,
        unchanged: 0,
        deleted: 0,
        candidate_bytes: 12,
        destructive_risk: false,
      };
    },
  });
  try {
    await runCliCommand({
      ...indexOptions(fixture),
      workspaceId: "",
      workspaceIdExplicit: false,
      apiBaseUrl: "http://127.0.0.1:8000",
      apiBaseUrlExplicit: false,
    }, {
      client,
      write: (line) => writes.push(line),
      writeRaw: () => {},
      isTTY: false,
      confirm: async () => "",
    });
    assert.equal(previewRequest.workspace.workspaceId, "demo://settings-workspace#main");
    assert.match(writes.join("\n"), /http:\/\/127\.0\.0\.1:19090/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("non-interactive rebuild requires an exact workspace acknowledgement", async () => {
  const fixture = await syntheticWorkspace();
  let mutations = 0;
  const client = fakeIndexClient({
    indexWorkspace: async () => {
      mutations += 1;
      return { ok: true, result: {}, status: {} };
    },
  });
  try {
    const result = await runCliCommand({
      ...indexOptions(fixture),
      yes: true,
      nonInteractive: true,
      rebuild: true,
      confirmRebuild: "different-workspace",
    }, {
      client,
      write: () => {},
      writeRaw: () => {},
      isTTY: false,
    });
    assert.equal(result.mutated, false);
    assert.equal(mutations, 0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("workspace lock conflict can attach to and follow the owning session", async () => {
  const fixture = await syntheticWorkspace();
  const prompts = [];
  let followedSession;
  const client = fakeIndexClient({
    indexWorkspace: async () => {
      const error = new Error("Workspace already has an active session");
      error.status = 409;
      error.errorDetail = {
        active_session: {
          session_id: "session-owner",
          age_seconds: 12,
          phase: "indexing",
          last_progress_seconds: 1,
          progress: { phase: "embedding" },
        },
      };
      throw error;
    },
    followIndexSession: async (sessionId, options) => {
      followedSession = sessionId;
      options.onProgress(progressEvent(7, "completed", 100, "completed"));
      return {
        session_id: sessionId,
        phase: "completed",
        progress: progressEvent(7, "completed", 100, "completed"),
      };
    },
  });
  try {
    const result = await runCliCommand(indexOptions(fixture), {
      client,
      write: () => {},
      writeRaw: () => {},
      isTTY: false,
      confirm: async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1 ? "y" : "a";
      },
    });
    assert.equal(followedSession, "session-owner");
    assert.equal(result.phase, "completed");
    assert.deepEqual(prompts, [
      "Start indexing this workspace? [y/N]",
      "Choose [a]ttach, [c]ancel, or [e]xit:",
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("index yes path streams NDJSON and reports verified terminal measurements", async () => {
  const fixture = await syntheticWorkspace();
  const writes = [];
  let requests = 0;
  const client = fakeIndexClient({
    indexWorkspace: async (request) => {
      requests += 1;
      request.onProgress(progressEvent(1, "embedding", 40, "running"));
      request.onProgress(progressEvent(2, "completed", 100, "completed"));
      return {
        ok: true,
        result: { documents_indexed: 2, bytes_uploaded: 20 },
        status: {
          session_id: "sess-cli",
          phase: "completed",
          files_indexed: 2,
          progress: progressEvent(2, "completed", 100, "completed"),
        },
      };
    },
  });
  try {
    await runCliCommand({ ...indexOptions(fixture), ndjson: true, yes: true }, {
      client,
      write: (line) => writes.push(line),
      writeRaw: () => {},
      isTTY: false,
    });

    assert.equal(requests, 1);
    const records = writes.map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.type === "index_preview"));
    assert.ok(records.some((record) => record.type === "index_progress" && record.event.phase === "embedding"));
    assert.equal(records.filter((record) => record.type === "index_progress" && record.event.overall_percent === 100).length, 1);
    const terminal = records.find((record) => record.type === "index_result");
    assert.equal(terminal.result.verification, "verified");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("index trace emits safe client and durable stage timings as NDJSON", async () => {
  const fixture = await syntheticWorkspace();
  const writes = [];
  const completed = progressEvent(2, "completed", 100, "completed");
  completed.phase_timings_ms = {
    queue_wait: 3,
    file_read: 5,
    parsing_chunking: 7,
    embedding_batch: 11,
    vector_writes: 13,
    cleanup: 17,
  };
  const client = fakeIndexClient({
    indexWorkspace: async (request) => {
      request.onProgress(completed);
      return {
        ok: true,
        status: {
          session_id: "sess-trace",
          phase: "completed",
          progress: completed,
        },
      };
    },
  });
  try {
    await runCliCommand({
      ...indexOptions(fixture),
      ndjson: true,
      trace: true,
      yes: true,
    }, {
      client,
      write: (line) => writes.push(line),
      writeRaw: () => {},
      isTTY: false,
    });

    const traceRecord = writes
      .map((line) => JSON.parse(line))
      .find((record) => record.type === "index_trace");
    assert.equal(traceRecord.trace.schema_version, "index-observability/v1");
    assert.equal(traceRecord.trace.stages_ms.embedding_batch, 11);
    assert.equal(traceRecord.trace.stages_ms.vector_writes, 13);
    assert.equal(traceRecord.trace.stages_ms.cleanup, 17);
    assert.equal(traceRecord.trace.sensitive_payloads_captured, false);
    assert.doesNotMatch(JSON.stringify(traceRecord), /const password|secret prompt/i);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("index trace collector accepts only the fixed safe server timing contract", async () => {
  const collector = createIndexTraceCollector();
  const fetchWithTrace = collector.wrapFetch(async () => new Response("{}", {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-corpuswire-index-trace": "index-observability/v1",
      "x-corpuswire-index-model-state": "cold",
      "x-corpuswire-index-error-state": "none",
      "server-timing": "cw_server_receipt;dur=4, cw_model_wait;dur=9, secret_prompt;dur=999",
    },
  }));

  await fetchWithTrace("http://127.0.0.1:8000/v1/index/capabilities");
  const snapshot = collector.snapshot();
  assert.deepEqual(snapshot.stageTimingsMs, { server_receipt: 4, model_wait: 9 });
  assert.equal(snapshot.modelState, "cold");
  assert.equal(snapshot.errorState, "none");
  assert.equal("secret_prompt" in snapshot.stageTimingsMs, false);
});

test("progress formatting preserves unknown denominators, ETA confidence, heartbeat, and redaction", () => {
  const unknown = progressEvent(1, "embedding", null, "running");
  unknown.phase_total = null;
  unknown.overall_percent = null;
  unknown.eta_seconds = 12;
  unknown.eta_confidence = "low";
  unknown.active_heartbeat = true;
  unknown.message = "Authorization: Bearer secret-value";

  const line = formatProgressLine(unknown);
  assert.match(line, /indeterminate/);
  assert.match(line, /eta 12\.0s \(low\)/);
  assert.match(line, /heartbeat active/);
  assert.equal(sanitizeTerminalText(unknown.message).includes("secret-value"), false);
});

test("progress renderer emits verified 100 percent exactly once", () => {
  const writes = [];
  const renderer = createProgressRenderer({
    write: (line) => writes.push(line),
    writeRaw: () => {},
    isTTY: false,
    ndjson: true,
  });
  const completed = progressEvent(9, "completed", 100, "completed");
  renderer.render(completed);
  renderer.render({ ...completed, sequence: 10 });
  assert.equal(writes.length, 1);
});

test("TTY progress renderer draws a live numeric bar and clears it on finish", () => {
  const rawWrites = [];
  const renderer = createProgressRenderer({
    write: () => {},
    writeRaw: (value) => rawWrites.push(value),
    isTTY: true,
    ndjson: false,
  });
  renderer.render(progressEvent(4, "embedding", 50, "running"));
  renderer.finish();
  assert.match(rawWrites[0], /\[████████████░░░░░░░░░░░░\]/);
  assert.match(rawWrites[0], /50\.0%/);
  assert.equal(rawWrites.at(-1), "\n");
});

function indexOptions(sourceRoot) {
  return {
    command: "index",
    apiBaseUrl: "http://127.0.0.1:18080",
    apiBaseUrlExplicit: true,
    workspaceId: "demo://cli-synthetic#main",
    workspaceIdExplicit: true,
    sourceRoot,
    profile: "local",
    mode: "full",
    includeGlobs: [],
    excludeGlobs: [],
    maxFileSizeBytes: 1024 * 1024,
    yes: false,
    nonInteractive: false,
    timeoutMs: undefined,
    rebuild: false,
    attachSessionId: undefined,
    json: false,
    ndjson: false,
    basicAuth: "",
    promptParts: [],
  };
}

function fakeIndexClient(overrides = {}) {
  return {
    getIndexCapabilities: async () => ({
      supported_extensions: [".md", ".js"],
      supported_filenames: ["package.json"],
      max_file_size_bytes: 1024 * 1024,
    }),
    previewIndexWorkspace: async (request) => ({
      workspace_id: request.workspace.workspaceId,
      collection_name: "collection-cli",
      requested_mode: request.mode,
      expected_mode: "full",
      candidates: request.files.length,
      included: request.files.length,
      excluded: 0,
      changed: request.files.length,
      unchanged: 0,
      deleted: 0,
      candidate_bytes: request.files.reduce((total, file) => total + file.content.byteLength, 0),
      destructive_risk: false,
    }),
    indexWorkspace: async () => ({ ok: true, result: {}, status: {} }),
    ...overrides,
  };
}

async function syntheticWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "corpuswire-cli-test-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "README.md"), "# Synthetic\n");
  await writeFile(path.join(root, "src", "index.js"), "export const value = 1;\n");
  await writeFile(path.join(root, "node_modules", "secret.js"), "ignored\n");
  return root;
}

function progressEvent(sequence, phase, percent, state) {
  return {
    schema_version: "index-progress/v1",
    sequence,
    session_id: "sess-cli",
    workspace_id: "demo://cli-synthetic#main",
    occurred_at: new Date().toISOString(),
    phase,
    state,
    message: phase,
    overall_completed: percent ?? 0,
    overall_total: percent === null ? null : 100,
    overall_percent: percent,
    overall_indeterminate: percent === null,
    phase_completed: percent ?? 0,
    phase_total: percent === null ? null : 100,
    unit: "chunks",
    elapsed_ms: sequence * 100,
    phase_elapsed_ms: sequence * 50,
    throughput_per_second: 4,
    queue_depth: 0,
    retries: 0,
    warnings: [],
    eta_seconds: null,
    eta_confidence: "unknown",
    heartbeat: false,
    last_progress_at: new Date().toISOString(),
    last_heartbeat_at: null,
    active_heartbeat: false,
    counts: { files_indexed: 2, chunks_indexed: 4, embedding_batches: 1, vector_writes: 4 },
    phase_timings_ms: { embedding: 100 },
    verification_status: state === "completed" ? "verified" : "pending",
  };
}

test("CLI complete scan carries inventory evidence and cancellation cannot reach a session", async () => {
  const fixture = await syntheticWorkspace();
  await writeFile(path.join(fixture, "package.json"), "{}");
  await writeFile(path.join(fixture, "requirements-dev.txt"), "private");
  await writeFile(path.join(fixture, "values.tfvars.json"), "{}");
  await mkdir(path.join(fixture, ".github"));
  await writeFile(path.join(fixture, ".github", "workflow.yml"), "private: true");
  await writeFile(path.join(fixture, "src", ".hidden.json"), "{}");
  let requests = 0;
  const client = fakeIndexClient({ indexWorkspace: async (request) => {
    requests += 1;
    assert.equal(request.inventoryScan.complete, true);
    assert.equal(request.inventoryScan.producer, "corpuswire-cli-scan/v1");
    assert.ok(Date.parse(request.inventoryScan.completedAt) >= Date.parse(request.inventoryScan.startedAt));
    assert.deepEqual(request.files.map((f) => f.relativePath).sort(), ["README.md", "src/index.js"]);
    return { ok: true, result: {}, status: {} };
  }});
  try {
    const dependencies = { client, write: () => {}, writeRaw: () => {}, isTTY: false };
    await runCliCommand({ ...indexOptions(fixture), yes: true }, dependencies);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runCliCommand({ ...indexOptions(fixture), yes: true }, { ...dependencies, signal: controller.signal }), { code: "scan_incomplete" });
    assert.equal(requests, 1);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
