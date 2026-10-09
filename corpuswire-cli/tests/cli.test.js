import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, chmod, symlink, rename } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import {
  createIndexTraceCollector,
  createProgressRenderer,
  createWatchFetch,
  formatProgressLine,
  main,
  parseCliArgs,
  runCliCommand,
  sanitizeTerminalText,
} from "../lib/cli.js";

test("workspace commands are parsed and unknown flags fail before contacting the backend", async () => {
  for (const command of ["init", "doctor", "reconcile"]) assert.equal(parseCliArgs([command]).command, command);
  let requests = 0;
  await assert.rejects(main(["doctor", "--unknown"], {
    client: { health: async () => { requests += 1; } }, write: () => {},
  }), /Unknown option/);
  assert.equal(requests, 0);
  assert.equal(parseCliArgs(["--yes"]).command, "index");
  assert.equal(parseCliArgs([], {}).apiBaseUrl, "http://127.0.0.1:18080");
});

test("repair words remain valid in explicit enhancement and ordinary bare prompts", () => {
  for (const word of ["init", "doctor", "reconcile", "version"]) {
    const parsed = parseCliArgs(["enhance", word, "the", "workspace"]);
    assert.equal(parsed.command, "enhance");
    assert.deepEqual(parsed.promptParts, [word, "the", "workspace"]);
  }
  assert.deepEqual(parseCliArgs(["reconcile the workspace"]).promptParts,
    ["reconcile the workspace"]);
});

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

test("main indexes the current folder with no arguments after printing the preview", async () => {
  const fixture = await syntheticWorkspace();
  const writes = [];
  let request;
  try {
    await main([], {
      cwd: fixture, homeDirectory: fixture, env: {},
      client: fakeIndexClient({ indexWorkspace: async (value) => {
        request = value;
        assert.match(writes.join("\n"), /Preview|preview/);
        return { ok: true, result: {}, status: {} };
      } }),
      write: (line) => writes.push(line), writeRaw: () => {},
      confirm: () => { throw new Error("Implicit local indexing must not ask confirmation"); },
    });
    assert.equal(request.workspace.displayRoot, fixture);
    assert.equal(request.mode, "full");
    assert.match(request.workspace.workspaceId, /^local-docker:\/\/corpuswire-cli-test-.*-[a-f0-9]{12}#main$/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("main prints the installed CLI version offline for command and flags", async () => {
  const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(metadata.version, "0.1.4-beta.5");
  assert.deepEqual(metadata.bin, { cw: "bin/corpuswire.js" });
  assert.equal(lock.version, metadata.version);
  assert.equal(lock.packages[""].version, metadata.version);
  assert.deepEqual(lock.packages[""].bin, metadata.bin);
  for (const argument of ["version", "--version", "-V"]) {
    const writes = [];
    await main([argument], {
      write: (line) => writes.push(line), cwd: "/missing/corpuswire-version-workspace",
      env: { CORPUSWIRE_BASE_URL: "invalid-url" },
      fetchFn: () => { throw new Error("Version must not contact the backend"); },
      sdk: { CorpusWireClient: class { constructor() { throw new Error("Version must not load a client"); } } },
    });
    assert.deepEqual(writes, ["0.1.4-beta.5"]);
  }
  const help = [];
  await main(["--help"], { write: (line) => help.push(line) });
  assert.match(help[0], /^cw\n/);
  assert.match(help[0], /cw version/);
  assert.equal(help[0].includes("corpuswire "), false);
});

test("one-shot startup explains a failed connection at the resolved or explicitly selected service", async () => {
  const fixture = await syntheticWorkspace();
  await mkdir(path.join(fixture, ".vscode"));
  const settingsPath = path.join(fixture, ".vscode", "settings.json");
  const settings = JSON.stringify({ "corpuswire.serviceDefaults.url": "http://127.0.0.1:19090" });
  await writeFile(settingsPath, settings);
  try {
    for (const explicit of [false, true]) {
      const requests = [];
      const selectedUrl = explicit ? "http://127.0.0.1:18080" : "http://127.0.0.1:19090";
      await assert.rejects(main(explicit ? ["--once", "--api-base-url", selectedUrl] : ["--once"], {
        cwd: fixture, homeDirectory: fixture, env: {}, platform: "linux", isTTY: false,
        signal: new AbortController().signal, write: () => {}, writeRaw: () => {},
        fetchFn: async (input) => {
          requests.push(input);
          throw new TypeError("fetch failed: private connection detail", { cause: { code: "ECONNREFUSED" } });
        },
      }), (error) => {
        assert.ok(error.message.includes(`CorpusWire API unavailable at ${selectedUrl}`));
        assert.match(error.message, /Start Docker Desktop and your existing CorpusWire service/);
        assert.match(error.message, /cw doctor/);
        assert.match(error.message, /CORPUSWIRE_BASE_URL.*\.vscode\/settings\.json/);
        assert.match(error.message, /--api-base-url <url>/);
        assert.equal(error.message.includes("private connection detail"), false);
        assert.equal(error.code, "ECONNREFUSED");
        return true;
      });
      assert.equal(requests.length, 3); // Existing SDK retry policy remains active.
      assert.ok(requests.every((input) => input === `${selectedUrl}/v1/index/capabilities`));
      assert.equal(await readFile(settingsPath, "utf8"), settings);
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("connection guidance redacts secrets, distinguishes hosted services, and preserves other fetch failures", async () => {
  await assert.rejects(main(["health", "--api-base-url", "https://user:password@example.test/api?token=secret"], {
    env: {}, write: () => {}, fetchFn: async () => { throw Object.assign(new Error("offline"), { code: "ENOTFOUND" }); },
  }), (error) => {
    assert.match(error.message, /Check the service address and network access/);
    assert.equal(/Docker Desktop|user:password|token=secret/.test(error.message), false);
    return true;
  });
  for (const failure of [new DOMException("Stopped", "AbortError"), new TypeError("Invalid synthetic request")]) {
    await assert.rejects(main(["health"], {
      env: {}, platform: "linux", write: () => {}, fetchFn: async () => { throw failure; },
    }), (error) => error === failure);
  }
  await assert.rejects(main(["health"], {
    env: {}, platform: "linux", write: () => {},
    fetchFn: async () => new Response('{"detail":"Authentication required"}', { status: 401, statusText: "Unauthorized" }),
  }), (error) => error.status === 401 && !error.message.includes("API unavailable"));
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

test("index rejects credentials embedded in service URLs before contacting the service", async () => {
  const fixture = await syntheticWorkspace();
  const writes = [];
  try {
    await assert.rejects(runCliCommand({
      ...indexOptions(fixture),
      apiBaseUrl: "http://user:password@127.0.0.1:18080/?token=sensitive",
    }, {
      client: fakeIndexClient(),
      write: (line) => writes.push(line),
      writeRaw: () => {},
      isTTY: false,
      confirm: async () => "",
    }), /base URLs must not contain credentials/);
    const output = writes.join("\n");
    assert.equal(output.includes("password"), false);
    assert.equal(output.includes("sensitive"), false);
    assert.equal(output, "");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("index rejects query strings and fragments before contacting the service", async () => {
  const fixture = await syntheticWorkspace();
  try {
    for (const suffix of ["?token=private", "#private"]) {
      await assert.rejects(runCliCommand({
        ...indexOptions(fixture),
        apiBaseUrl: `http://127.0.0.1:18080/${suffix}`,
      }, {
        client: fakeIndexClient(),
        write: () => assert.fail("Must reject before producing output"),
        writeRaw: () => {},
        isTTY: false,
      }), /base URLs must not contain a query string or fragment/);
    }
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

for (const ndjson of [false, true]) {
  test(`index reports code readiness with pending flags in ${ndjson ? "NDJSON" : "terminal"} output`, async () => {
    const fixture = await syntheticWorkspace();
    const writes = [];
    const client = fakeIndexClient({
      indexWorkspace: async (request) => {
        request.onProgress(progressEvent(1, "embedding", 40, "running"));
        request.onCodeReady({
          session_id: "code-session",
          coverage: { state: "pending", code_ready: true, documentation_pending: true, other_pending: false },
        });
        request.onProgress(progressEvent(2, "embedding", 60, "running"));
        request.onProgress(progressEvent(3, "completed", 100, "completed"));
        return { ok: true, result: {}, status: {
          phase: "completed", coverage: { state: "verified" },
          progress: progressEvent(3, "completed", 100, "completed"),
        } };
      },
    });
    try {
      await runCliCommand({ ...indexOptions(fixture), yes: true, ndjson }, {
        client, write: (line) => writes.push(line), writeRaw: () => {}, isTTY: false,
      });
      if (ndjson) {
        const events = writes.map((line) => JSON.parse(line));
        assert.deepEqual(events.filter((event) => event.type === "code_ready"), [{
          type: "code_ready", session_id: "code-session", workspace_id: "demo://cli-synthetic#main",
          code_ready: true, documentation_pending: true, other_pending: false,
        }]);
        const published = events.findIndex((event) => event.type === "code_ready");
        const completed = events.findIndex((event) => event.event?.overall_percent === 100);
        assert.ok(published >= 0 && completed > published);
      } else {
        assert.equal(writes.filter((line) => line === "Code ready; documentation pending.").length, 1);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

test("index does not report code readiness when publication is still pending", async () => {
  const fixture = await syntheticWorkspace();
  const writes = [];
  try {
    await runCliCommand({ ...indexOptions(fixture), yes: true, ndjson: true }, {
      client: fakeIndexClient({ indexWorkspace: async (request) => {
        request.onCodeReady({ coverage: { code_ready: false, documentation_pending: true } });
        return { ok: true, result: {}, status: { phase: "completed" } };
      } }),
      write: (line) => writes.push(line), writeRaw: () => {}, isTTY: false,
    });
    assert.ok(writes.map((line) => JSON.parse(line)).every((event) => event.type !== "code_ready"));
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

test("phase percentages advance independently of file-level progress", () => {
  const event = progressEvent(1, "embedding", 89.1, "running");
  event.phase_total = 1455;
  event.phase_completed = 580;
  assert.match(formatProgressLine(event), /phase 39\.9%/);
  assert.match(formatProgressLine(event), /overall 89\.1%/);
  event.phase_completed = 744;
  assert.match(formatProgressLine(event), /phase 51\.1%/);
  assert.match(formatProgressLine(event), /overall 89\.1%/);
  event.phase_completed = 1455;
  assert.match(formatProgressLine(event), /phase 100\.0%/);
  assert.match(formatProgressLine(event), /overall 89\.1%/);
  for (const [completed, total] of [[0, null], [0, 0], [1, -1], [NaN, 1455], [Infinity, 1455], [-1, 1455], [1456, 1455], [1, Infinity], ["744", 1455]]) {
    const invalid = formatProgressLine({ ...event, phase_completed: completed, phase_total: total });
    assert.match(invalid, /phase \[indeterminate\]/);
    assert.match(invalid, /overall 89\.1%/);
    assert.doesNotMatch(invalid, /phase (?:NaN|Infinity|100\.0)%/);
  }
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

test("init is idempotent, preserves unrelated settings and MCP config, and writes no credentials", async () => {
  const fixture = await syntheticWorkspace();
  await mkdir(path.join(fixture, ".vscode"));
  const settingsPath = path.join(fixture, ".vscode", "settings.json");
  const mcpPath = path.join(fixture, ".vscode", "mcp.json");
  const mcpText = JSON.stringify({ servers: {
    unrelated: { command: "keep-me" },
    "corpuswire-context-engine": { command: "existing-server", env: {
      CORPUSWIRE_WORKSPACE_ID: "local-docker://pinned#branch",
      CORPUSWIRE_BASE_URL: "http://127.0.0.1:19090",
      CORPUSWIRE_SYNC_INCLUDE_GLOBS: '["**/*.md"]',
      CORPUSWIRE_SYNC_EXCLUDE_GLOBS: "private/**,reports/**",
      CORPUSWIRE_SYNC_MAX_FILE_SIZE_BYTES: "128",
    } },
  } });
  await writeFile(settingsPath, '{ // Preserve semantic unrelated configuration.\n"editor.fontSize": 15, "other": {"value": true},\n}\n');
  await writeFile(mcpPath, mcpText);
  try {
    const dependencies = { cwd: fixture, homeDirectory: fixture,
      env: { CORPUSWIRE_BEARER_TOKEN: "must-never-be-saved" }, write: () => {},
      client: { health: () => { throw new Error("init must not call backend"); } },
    };
    const first = await main(["init"], dependencies);
    const firstText = await readFile(settingsPath, "utf8");
    const second = await main(["init"], dependencies);
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(await readFile(settingsPath, "utf8"), firstText);
    assert.equal(await readFile(mcpPath, "utf8"), mcpText);
    const settings = JSON.parse(firstText);
    assert.equal(settings["editor.fontSize"], 15);
    assert.deepEqual(settings.other, { value: true });
    assert.equal(settings["corpuswire.remoteIndexing.workspaceId"], "local-docker://pinned#branch");
    assert.equal(settings["corpuswire.serviceDefaults.url"], "http://127.0.0.1:19090");
    assert.deepEqual(settings["corpuswire.remoteIndexing.includeGlobs"], ["**/*.md"]);
    assert.equal(settings["corpuswire.remoteIndexing.maxFileSizeBytes"], 128);
    assert.equal(firstText.includes("must-never-be-saved"), false);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("reconcile reuses full indexing and configured MCP identity and file selection", async () => {
  const fixture = await syntheticWorkspace();
  await writeFile(path.join(fixture, ".mcp.json"), JSON.stringify({ mcpServers: {
    "corpuswire-context-engine": { env: {
      CORPUSWIRE_WORKSPACE_ID: "local-docker://existing#main",
      CORPUSWIRE_SYNC_INCLUDE_GLOBS: "**/*.md",
      CORPUSWIRE_SYNC_EXCLUDE_GLOBS: "private/**",
      CORPUSWIRE_SYNC_MAX_FILE_SIZE_BYTES: "256",
    } },
  } }));
  let request;
  try {
    await main(["reconcile", "--yes"], {
      cwd: fixture, env: {}, homeDirectory: fixture,
      client: fakeIndexClient({ indexWorkspace: async (value) => {
        request = value; return { ok: true, result: {}, status: {} };
      } }), write: () => {}, writeRaw: () => {},
    });
    assert.equal(request.mode, "full");
    assert.equal(request.workspace.workspaceId, "local-docker://existing#main");
    assert.deepEqual(request.files.map((file) => file.relativePath), ["README.md"]);
    assert.deepEqual(request.includeGlobs, ["**/*.md"]);
    assert.deepEqual(request.excludeGlobs, ["private/**"]);
    assert.equal(request.maxFileSizeBytes, 256);
    assert.equal(request.inventoryScan.complete, true);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("explicit reconcile retains confirmation and hosted implicit indexing never autoaccepts", async () => {
  const fixture = await syntheticWorkspace();
  let mutations = 0;
  let confirmations = 0;
  try {
    const dependencies = {
      cwd: fixture, env: {}, homeDirectory: fixture,
      client: fakeIndexClient({ indexWorkspace: async () => { mutations += 1; } }),
      write: () => {}, writeRaw: () => {}, confirm: async () => { confirmations += 1; return ""; },
    };
    await main(["reconcile"], dependencies);
    await main([], { ...dependencies, env: { CORPUSWIRE_PROFILE: "hosted", CORPUSWIRE_BASE_URL: "https://example.invalid" } });
    assert.equal(confirmations, 2);
    assert.equal(mutations, 0);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("doctor accepts healthy published code and keeps incomplete or degraded coverage unhealthy", async () => {
  const fixture = await syntheticWorkspace();
  const coverage = { state: "pending", reason_codes: ["background_ingestion_pending"],
    code_ready: true, documentation_pending: true, other_pending: false };
  const cases = [
    { name: "code-ready", coverage, status: "ready" },
    { name: "explicitly unindexed", coverage, indexed: false, status: "attention" },
    { name: "still publishing", coverage: { ...coverage, code_ready: false }, status: "attention" },
    { name: "mirror pending", coverage: { ...coverage, reason_codes: ["mirror_pending"] }, status: "attention" },
    { name: "invalidated", coverage: { ...coverage, state: "invalidated" }, status: "attention" },
    { name: "vector error", coverage, health_status: "degraded", status: "attention" },
    { name: "real warning", coverage, health_warnings: ["vector_store_error"], status: "attention" },
    { name: "reconcile needed", coverage, read_needs_reconcile: true, status: "attention" },
    { name: "missing diagnosis readiness", coverage, readiness: "incomplete", status: "attention" },
    { name: "unhealthy service", coverage, healthOk: false, status: "blocked" },
    { name: "wrong identity", coverage, workspaceId: "local-docker://other#main", status: "blocked" },
  ];
  try {
    for (const entry of cases) {
      const writes = [];
      const dependencies = {
        cwd: fixture, env: {}, homeDirectory: fixture, write: (line) => writes.push(line),
        client: { health: async () => ({ ok: entry.healthOk ?? true }), diagnoseWorkspace: async () => ({
          status: "ready", can_retrieve: true, resolved_workspace_id: entry.workspaceId ?? "local-docker://code#main",
          index: { indexed: entry.indexed ?? true, health_status: entry.health_status ?? "ok", readiness: entry.readiness ?? "code_ready",
            coverage: entry.coverage, health_warnings: entry.health_warnings ?? [],
            read_needs_reconcile: entry.read_needs_reconcile ?? false },
        }) },
      };
      const result = await main(["doctor", "--workspace-id", "local-docker://code#main", "--json"], dependencies);
      assert.equal(result.status, entry.status, entry.name);
      assert.equal(result.exitCode, entry.status === "ready" ? 0 : entry.status === "blocked" ? 2 : 1, entry.name);
      assert.equal(result.coverage.codeReady, entry.status === "ready", entry.name);
      const serialized = JSON.parse(writes.at(-1));
      assert.equal(serialized.coverage.codeReady, entry.status === "ready", entry.name);
      assert.equal(serialized.coverage.documentationPending, true);
      assert.equal(serialized.coverage.otherPending, false);
      writes.length = 0;
      await main(["doctor", "--workspace-id", "local-docker://code#main"], dependencies);
      assert.equal(writes.join("\n").includes("\ncode ready: true"), entry.status === "ready", entry.name);
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("doctor requires verified inventory, reports unavailable service, and never writes files", async () => {
  const fixture = await syntheticWorkspace();
  const initialEntries = await readdir(fixture);
  const priorExitCode = process.exitCode;
  try {
    const writes = [];
    const baseDiagnosis = { status: "ready", can_retrieve: true,
      resolved_workspace_id: "local-docker://verified#main", index: { health_status: "ok" } };
    for (const [state, status, exitCode, indexed] of [["verified", "attention", 1, false], ["verified", "ready", 0, true], ["verified", "ready", 0], ["unknown", "attention", 1], ["invalidated", "attention", 1], [undefined, "attention", 1]]) {
      const result = await main(["doctor", "--workspace-id", "local-docker://verified#main", "--json"], {
        cwd: fixture, env: {}, homeDirectory: fixture, write: (line) => writes.push(line),
        client: {
          health: async () => ({ ok: true }),
          diagnoseWorkspace: async () => ({ ...baseDiagnosis, index: { indexed, health_status: "ok", coverage: state ? { state } : undefined } }),
        },
      });
      assert.equal(result.status, status);
      assert.equal(result.exitCode, exitCode);
      assert.equal(JSON.parse(writes.at(-1)).schema_version, "workspace-doctor/v1");
    }
    const unavailable = await main(["doctor"], {
      cwd: fixture, env: {}, homeDirectory: fixture, write: () => {},
      client: { health: async () => { throw new Error("secret error must not print"); },
        diagnoseWorkspace: async () => { throw new Error("unavailable"); } },
    });
    assert.equal(unavailable.status, "blocked");
    assert.equal(unavailable.exitCode, 2);
    const rejectedWrites = [];
    const rejected = await main(["doctor", "--json"], {
      cwd: fixture, env: {}, homeDirectory: fixture, write: (line) => rejectedWrites.push(line),
      client: { health: async () => { throw Object.assign(new Error("private-token must not print"), { status: 401 }); },
        diagnoseWorkspace: async () => { throw Object.assign(new Error("private backend detail"), { status: 403 }); } },
    });
    assert.equal(rejected.status, "blocked");
    assert.deepEqual(rejected.checks, [
      { name: "health", status: "error", code: "authentication_rejected", httpStatus: 401 },
      { name: "diagnosis", status: "error", code: "authentication_rejected", httpStatus: 403 },
    ]);
    assert.equal(rejectedWrites.join("\n").includes("private"), false);
    assert.deepEqual(await readdir(fixture), initialEntries);
    assert.equal(process.exitCode, priorExitCode);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("doctor rejects explicit vector errors and diagnosis checks even with ready coverage", async () => {
  const fixture = await syntheticWorkspace();
  try {
    for (const state of ["pending", "verified"]) {
      for (const entry of [
        { name: "vector error", qdrant_error: "Synthetic vector outage", checks: [], reason: "vector_store_error", status: "blocked", exitCode: 2 },
        { name: "check warning", checks: [{ name: "publication", status: "warning", message: "Synthetic publication warning" }], reason: "diagnosis_check_warning", status: "attention", exitCode: 1 },
        { name: "check error", checks: [{ name: "vector_probe", status: "error", message: "Synthetic probe error" }], reason: "diagnosis_check_error", status: "blocked", exitCode: 2 },
      ]) {
        const writes = [];
        const result = await main(["doctor", "--workspace-id", "local-docker://signals#main", "--json"], {
          cwd: fixture, env: {}, homeDirectory: fixture, write: (line) => writes.push(line),
          client: {
            health: async () => ({ ok: true }),
            diagnoseWorkspace: async () => ({
              status: "ready", can_retrieve: true, resolved_workspace_id: "local-docker://signals#main",
              qdrant_error: entry.qdrant_error ?? null, checks: entry.checks,
              index: { health_status: "ok", health_warnings: [], readiness: state === "pending" ? "code_ready" : "ready",
                coverage: { state, reason_codes: state === "pending" ? ["background_ingestion_pending"] : [],
                  code_ready: true, documentation_pending: state === "pending", other_pending: false } },
            }),
          },
        });
        const label = `${state}: ${entry.name}`;
        assert.equal(result.ok, false, label);
        assert.equal(result.status, entry.status, label);
        assert.equal(result.exitCode, entry.exitCode, label);
        assert.ok(result.reasons.includes(entry.reason), label);
        assert.equal(result.coverage.codeReady, false, label);
        const serialized = JSON.parse(writes.at(-1));
        assert.equal(serialized.status, entry.status, label);
        assert.equal(serialized.coverage.codeReady, false, label);
        assert.equal(serialized.coverage.documentationPending, state === "pending", label);
      }
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("doctor uses resolved service URL before constructing client and reads native credentials privately", async () => {
  const fixture = await syntheticWorkspace();
  await mkdir(path.join(fixture, ".vscode"));
  await writeFile(path.join(fixture, ".vscode", "settings.json"), JSON.stringify({
    "corpuswire.remoteIndexing.workspaceId": "local-docker://auth-synthetic#main",
    "corpuswire.serviceDefaults.url": "http://127.0.0.1:19090/",
  }));
  let constructorOptions;
  let credentialLookups = 0;
  const writes = [];
  class FakeClient {
    constructor(options) { constructorOptions = options; }
    async health() { return { ok: true }; }
    async diagnoseWorkspace() { return { status: "ready", can_retrieve: true, index: { coverage: { state: "verified" } } }; }
  }
  const dependencies = {
    cwd: fixture, homeDirectory: fixture, env: {}, platform: "darwin", sdk: { CorpusWireClient: FakeClient },
    execFile: async (command, args) => {
      credentialLookups += 1;
      assert.equal(command, "/usr/bin/security");
      assert.deepEqual(args, ["find-generic-password", "-s", "corpuswire-service-auth-v1", "-a", "http://127.0.0.1:19090", "-w"]);
      return { stdout: "private-stored-token\n" };
    }, write: (line) => writes.push(line),
  };
  try {
    await main(["doctor"], dependencies);
    assert.equal(constructorOptions.baseUrl, "http://127.0.0.1:19090/");
    assert.equal(constructorOptions.bearerToken, "private-stored-token");
    assert.equal(writes.join("\n").includes("private-stored-token"), false);
    await main(["doctor"], { ...dependencies, env: { CORPUSWIRE_BEARER_TOKEN: "env-token" } });
    assert.equal(constructorOptions.bearerToken, "env-token");
    assert.equal(credentialLookups, 1);
    await main(["doctor"], { ...dependencies, env: { CORPUSWIRE_BASIC_AUTH: "user:password" } });
    assert.equal(constructorOptions.basicAuth, "user:password");
    assert.equal(constructorOptions.bearerToken, "");
    assert.equal(credentialLookups, 1);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("malformed configuration fails closed before indexing and init preserves original bytes", async () => {
  const fixture = await syntheticWorkspace();
  await mkdir(path.join(fixture, ".vscode"));
  const settingsPath = path.join(fixture, ".vscode", "settings.json");
  const original = '{"corpuswire.remoteIndexing.includeGlobs": [ broken';
  await writeFile(settingsPath, original);
  let calls = 0;
  try {
    for (const command of ["init", "index", "reconcile", "doctor", "watch"]) {
      await assert.rejects(main([command, "--yes"], {
        cwd: fixture, env: {}, homeDirectory: fixture, write: () => {},
        client: fakeIndexClient({ getIndexCapabilities: async () => { calls += 1; } }),
      }), /Cannot read CorpusWire configuration/);
    }
    assert.equal(calls, 0);
    assert.equal(await readFile(settingsPath, "utf8"), original);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("private CLI credentials are scoped by URL, permission checked, and overridden by environment", async () => {
  const fixture = await syntheticWorkspace();
  const credentialFile = path.join(fixture, "cli-credentials.json");
  const linkPath = path.join(fixture, "linked-credentials.json");
  let constructorOptions;
  let nativeLookups = 0;
  let backendCalls = 0;
  const writes = [];
  class FakeClient {
    constructor(options) { constructorOptions = options; }
    async health() { backendCalls += 1; return { ok: true }; }
    async diagnoseWorkspace() { backendCalls += 1; return { status: "ready", can_retrieve: true, index: { coverage: { state: "verified" } } }; }
  }
  const dependencies = {
    cwd: fixture, homeDirectory: fixture, credentialFile, env: {}, platform: "darwin", sdk: { CorpusWireClient: FakeClient },
    execFile: async () => { nativeLookups += 1; return { stdout: "native-fallback-token\n" }; },
    write: (line) => writes.push(line),
  };
  const writeCredentials = async (value, mode = 0o600) => {
    await writeFile(credentialFile, typeof value === "string" ? value : JSON.stringify(value), { mode });
    await chmod(credentialFile, mode);
  };
  try {
    const valid = { schemaVersion: 1, services: { "http://127.0.0.1:18080": { bearerToken: "private-file-token" } } };
    await writeCredentials(valid);
    await main(["doctor"], dependencies);
    assert.equal(constructorOptions.bearerToken, "private-file-token");
    assert.equal(nativeLookups, 0);
    await main(["doctor"], { ...dependencies, env: { CORPUSWIRE_BEARER_TOKEN: "environment-token" } });
    assert.equal(constructorOptions.bearerToken, "environment-token");
    await main(["doctor", "--api-base-url", "http://127.0.0.1:19588"], dependencies);
    assert.equal(constructorOptions.bearerToken, "native-fallback-token");
    assert.equal(nativeLookups, 1);
    await main(["doctor"], { ...dependencies, platform: "linux" });
    assert.equal(constructorOptions.bearerToken, "private-file-token");
    const precedingBackendCalls = backendCalls;
    for (const [value, mode] of [[valid, 0o644], ["malformed private-token", 0o600],
      [{ schemaVersion: 1, services: { "http://127.0.0.1:18080/?token=private": { bearerToken: "private-token" } } }, 0o600],
      [{ schemaVersion: 1, services: { "http://127.0.0.1:18080": { bearerToken: "token\nheader" } } }, 0o600]]) {
      await writeCredentials(value, mode);
      await assert.rejects(main(["doctor"], dependencies), /credential file is invalid or insecure/);
    }
    assert.equal(backendCalls, precedingBackendCalls);
    await writeCredentials(valid);
    await assert.rejects(main(["doctor"], { ...dependencies, getuid: () => -1 }), /credential file is invalid or insecure/);
    await symlink(credentialFile, linkPath);
    await assert.rejects(main(["doctor"], { ...dependencies, credentialFile: linkPath }), /credential file is invalid or insecure/);
    await chmod(credentialFile, 0o644);
    await main(["doctor"], { ...dependencies, env: { CORPUSWIRE_BASIC_AUTH: "env-user:env-password" } });
    assert.equal(constructorOptions.basicAuth, "env-user:env-password");
    assert.equal(writes.join("\n").includes("token"), false);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

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

async function watchFixture({ argv = ["watch"], isTTY = false, onWait, onIndex, onPreview, onDiagnosis, onSetup, watcherUnavailable = false } = {}) {
  const root = await syntheticWorkspace();
  const controller = new AbortController();
  const state = {
    root, controller, requests: [], calls: { capabilities: 0, preview: 0, health: 0, diagnosis: 0 },
    writes: [], waits: 0, opened: 0, closed: 0, active: 0, maximumActive: 0,
    notify: () => {}, extraPaths: [],
  };
  const client = fakeIndexClient({
    getIndexCapabilities: async () => {
      state.calls.capabilities += 1;
      return { supported_extensions: [".md", ".js"], supported_filenames: ["package.json"], max_file_size_bytes: 1048576 };
    },
    previewIndexWorkspace: async (request) => {
      state.calls.preview += 1;
      await onPreview?.(state, request);
      return { workspace_id: request.workspace.workspaceId, collection_name: "synthetic-watch", requested_mode: "full", expected_mode: "full", included: request.files.length, candidates: request.files.length, changed: request.files.length, unchanged: 0, deleted: 0, excluded: 0, candidate_bytes: 0, destructive_risk: false };
    },
    indexWorkspace: async (request) => {
      state.requests.push({
        workspaceId: request.workspace.workspaceId, mode: request.mode,
        files: request.files.map((file) => ({ path: file.relativePath, content: Buffer.from(file.content).toString("utf8") })),
        inventoryScan: request.inventoryScan, signal: request.signal,
      });
      state.active += 1;
      state.maximumActive = Math.max(state.maximumActive, state.active);
      try {
        const result = await onIndex?.(state, request);
        return result ?? { ok: true, result: {}, status: { phase: "completed", coverage: { state: "verified" } }, transfer: { complete: true } };
      } finally { state.active -= 1; }
    },
    health: async () => { state.calls.health += 1; return { ok: true, index: { coverage: { state: "verified" } } }; },
    diagnoseWorkspace: async (request) => {
      state.calls.diagnosis += 1;
      return await onDiagnosis?.(state, request) ?? { status: "ready", can_retrieve: true, resolved_workspace_id: request.workspaceId, index: { health_status: "ok", coverage: { state: "verified" } } };
    },
  });
  try {
    await onSetup?.(state);
    const args = argv.includes("watch") || argv.includes("--watch")
      ? [...argv, "--poll-ms", "100", "--debounce-ms", "10"] : argv;
    state.result = await main(args, {
      cwd: root, homeDirectory: root, env: {}, client, signal: controller.signal, isTTY,
      write: (line) => state.writes.push(line), writeRaw: () => {},
      confirm: () => { throw new Error("Local watch must not request indexing confirmation"); },
      watchFactory: (sourceRoot, options, callback) => {
        assert.equal(sourceRoot, root);
        assert.equal(options.recursive, true);
        if (watcherUnavailable) throw new Error("Synthetic recursive watcher unavailable");
        state.opened += 1;
        const watcher = new EventEmitter();
        state.notify = (filename = "README.md", event = "change") => callback(event, filename);
        watcher.close = () => { state.closed += 1; watcher.removeAllListeners(); };
        return watcher;
      },
      waitForWatch: async (_ms, signal) => {
        state.waits += 1;
        if (state.waits > 50) controller.abort();
        await onWait?.(state);
        if (!signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 15));
      },
    });
  } catch (error) { state.error = error; }
  finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
    for (const extra of state.extraPaths) await rm(extra, { recursive: true, force: true });
  }
  assert.equal(state.closed, state.opened, "Every created watcher must close");
  assert.equal(state.maximumActive <= 1, true, "Index sessions must never overlap");
  return state;
}

test("watch cannot establish a full baseline from a code-ready partial diagnosis", async () => {
  const state = await watchFixture({
    onDiagnosis: async (_current, request) => ({
      status: "ready", can_retrieve: true, resolved_workspace_id: request.workspaceId,
      index: { indexed: true, health_status: "ok", readiness: "code_ready", coverage: {
        state: "pending", code_ready: true, documentation_pending: true,
        reason_codes: ["background_ingestion_pending"],
      } },
    }),
  });
  assert.match(state.error?.message ?? "", /inventory_not_verified/);
  assert.equal(state.waits, 0);
  assert.equal(state.requests.length, 1);
});

test("watch timing flags reject unsafe or ambiguous values", () => {
  for (const args of [["watch", "--poll-ms", "99"], ["watch", "--poll-ms", "1.5"],
    ["watch", "--debounce-ms", "9"], ["watch", "--debounce-ms", "-10"], ["watch", "--poll-ms", "NaN"]]) {
    assert.throws(() => parseCliArgs(args));
  }
});

test("explicit watch and --watch cache capabilities and perform no idle API calls", { timeout: 5000 }, async () => {
  for (const argv of [["watch"], ["--watch"]]) {
    let initialCalls;
    const state = await watchFixture({ argv, onWait: async (current) => {
      initialCalls ??= { ...current.calls };
      assert.deepEqual(current.calls, initialCalls, "Idle waits must not contact backend");
      if (current.waits === 8) current.controller.abort();
    } });
    assert.ifError(state.error);
    assert.equal(state.requests.length, 1);
    assert.equal(state.calls.capabilities, 1);
    assert.equal(state.calls.preview, 1);
    assert.equal(state.calls.diagnosis, 1);
    assert.equal(state.opened, 1);
  }
});

test("bare TTY invocation watches while --once and non-TTY invocations finish after one index", { timeout: 5000 }, async () => {
  const tty = await watchFixture({ argv: [], isTTY: true, onWait: (state) => state.controller.abort() });
  assert.ifError(tty.error);
  assert.equal(tty.opened, 1);
  for (const options of [{ argv: [], isTTY: false }, { argv: ["--once"], isTTY: true }]) {
    const state = await watchFixture(options);
    assert.ifError(state.error);
    assert.equal(state.requests.length, 1);
    assert.equal(state.opened, 0);
    assert.equal(state.waits, 0);
  }
});

test("excluded edits, unknown watcher filenames, and unchanged bytes do not trigger indexing", { timeout: 5000 }, async () => {
  let modified = false;
  const state = await watchFixture({ argv: ["watch", "--include", "**/*.md", "--exclude", "private/**"],
    onWait: async (current) => {
      if (!modified) {
        modified = true;
        await writeFile(path.join(current.root, "README.md"), "# Synthetic\n");
        await writeFile(path.join(current.root, "node_modules", "secret.js"), "excluded update\n");
        await mkdir(path.join(current.root, "private"));
        await writeFile(path.join(current.root, "private", "notes.md"), "excluded synthetic\n");
        current.notify("private/notes.md"); current.notify(null); current.notify("README.md");
      }
      if (current.waits === 12) current.controller.abort();
    },
  });
  assert.ifError(state.error);
  assert.equal(state.requests.length, 1);
  assert.equal(state.calls.capabilities, 1);
  assert.equal(state.calls.preview, 1);
  assert.deepEqual(state.requests[0].files.map((file) => file.path), ["README.md"]);
});

test("watch reconciles add, delete, and rename with complete full inventories", { timeout: 5000 }, async () => {
  let stage = 0;
  const state = await watchFixture({ onWait: async (current) => {
    if (stage === 0 && current.requests.length === 1) {
      stage = 1; await writeFile(path.join(current.root, "src", "added.js"), "export const added = true;\n"); current.notify("src/added.js", "rename");
    } else if (stage === 1 && current.requests.length === 2) {
      stage = 2; await rm(path.join(current.root, "README.md")); current.notify("README.md", "rename");
    } else if (stage === 2 && current.requests.length === 3) {
      stage = 3; await rename(path.join(current.root, "src", "added.js"), path.join(current.root, "src", "renamed.js")); current.notify("src/added.js", "rename"); current.notify("src/renamed.js", "rename");
    } else if (stage === 3 && current.requests.length === 4) current.controller.abort();
  } });
  assert.ifError(state.error);
  assert.equal(state.requests.length, 4);
  const paths = state.requests.map((request) => request.files.map((file) => file.path).sort());
  assert.deepEqual(paths, [["README.md", "src/index.js"], ["README.md", "src/added.js", "src/index.js"], ["src/added.js", "src/index.js"], ["src/index.js", "src/renamed.js"]]);
  assert.equal(new Set(state.requests.map((request) => request.workspaceId)).size, 1);
  assert.equal(state.calls.capabilities, 1);
  assert.equal(state.calls.diagnosis, 4);
  for (const request of state.requests) { assert.equal(request.mode, "full"); assert.equal(request.inventoryScan.complete, true); }
});

test("changes during an active index produce one serial follow-up", { timeout: 5000 }, async () => {
  const state = await watchFixture({ onIndex: async (current) => {
    if (current.requests.length === 1) {
      await writeFile(path.join(current.root, "README.md"), "# Updated during indexing\n");
      current.notify("README.md");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }, onWait: (current) => { if (current.requests.length === 2) current.controller.abort(); } });
  assert.ifError(state.error);
  assert.equal(state.requests.length, 2);
  assert.equal(state.maximumActive, 1);
  assert.equal(state.requests[1].files.find((file) => file.path === "README.md").content, "# Updated during indexing\n");
});

test("watch falls back to bounded polling when recursive file watching is unavailable", { timeout: 5000 }, async () => {
  let modified = false;
  const state = await watchFixture({ watcherUnavailable: true, onWait: async (current) => {
    if (!modified) { modified = true; await writeFile(path.join(current.root, "README.md"), "# Polling update\n"); }
    if (current.requests.length === 2) current.controller.abort();
  } });
  assert.ifError(state.error);
  assert.equal(state.requests.length, 2);
  assert.equal(state.calls.capabilities, 1);
});

test("watch fences root replacement before a second index", { timeout: 5000 }, async () => {
  let replaced = false;
  const state = await watchFixture({ onWait: async (current) => {
    if (!replaced) {
      replaced = true;
      const oldRoot = `${current.root}-original`;
      current.extraPaths.push(oldRoot);
      await rename(current.root, oldRoot); await mkdir(current.root);
      await writeFile(path.join(current.root, "README.md"), "# Replacement root\n");
      current.notify("README.md", "rename");
    }
  } });
  assert.equal(state.requests.length, 1);
  assert.equal(state.waits < 50, true, "Root replacement must stop promptly rather than poll indefinitely");
  assert.equal(state.opened, 1);
});

test("watch fences workspace configuration changes before a second index", { timeout: 5000 }, async () => {
  let configured = false;
  const state = await watchFixture({ onWait: async (current) => {
    if (!configured) {
      configured = true; await mkdir(path.join(current.root, ".vscode"));
      await writeFile(path.join(current.root, ".vscode", "settings.json"), JSON.stringify({ "corpuswire.remoteIndexing.workspaceId": "local-docker://different#main" }));
      current.notify(".vscode/settings.json");
    }
  } });
  assert.equal(state.requests.length, 1);
  assert.equal(state.waits < 50, true, "Changed destination configuration must stop promptly");
});

test("watch retries transient failures serially but stops on authentication rejection", { timeout: 5000 }, async () => {
  let modified = false;
  const transient = await watchFixture({ onWait: async (current) => {
    if (!modified) { modified = true; await writeFile(path.join(current.root, "README.md"), "# Retry update\n"); current.notify("README.md"); }
    if (current.requests.length === 3) current.controller.abort();
  }, onIndex: (current) => { if (current.requests.length === 2) throw Object.assign(new Error("Synthetic transient failure"), { status: 503 }); } });
  assert.ifError(transient.error);
  assert.equal(transient.requests.length, 3);
  assert.equal(transient.maximumActive, 1);
  assert.deepEqual(transient.requests[1].files, transient.requests[2].files);
  const rejected = await watchFixture({ onIndex: () => { throw Object.assign(new Error("Synthetic authentication rejection"), { status: 401 }); } });
  assert.equal(rejected.requests.length, 1);
  assert.equal(rejected.waits, 0);
});

test("abort closes watcher and prevents follow-up mutation", { timeout: 5000 }, async () => {
  const state = await watchFixture({ onWait: async (current) => {
    await writeFile(path.join(current.root, "README.md"), "# Aborted update\n");
    current.notify("README.md"); current.controller.abort();
  } });
  assert.equal(state.requests.length, 1);
  assert.equal(state.opened, 1);
  assert.equal(state.closed, 1);
});

test("a disappeared watch root never publishes an empty deletion inventory", { timeout: 5000 }, async () => {
  let removed = false;
  const state = await watchFixture({ onWait: async (current) => {
    if (!removed) { removed = true; await rm(current.root, { recursive: true }); current.notify(null, "rename"); }
  } });
  assert.equal(state.requests.length, 1);
  assert.equal(state.error?.code, "watch_fence");
  assert.match(state.error.message, /disappeared/);
  assert.equal(state.waits < 50, true);
});

test("an intact watch root with zero eligible files publishes a complete empty inventory", { timeout: 5000 }, async () => {
  let cleared = false;
  const state = await watchFixture({ onWait: async (current) => {
    if (!cleared) {
      cleared = true; await rm(path.join(current.root, "README.md"));
      await rm(path.join(current.root, "src", "index.js")); current.notify(null, "rename");
    }
    if (current.requests.length === 2) current.controller.abort();
  } });
  assert.ifError(state.error);
  assert.equal(state.requests.length, 2);
  assert.deepEqual(state.requests[1].files, []);
  assert.equal(state.requests[1].inventoryScan.complete, true);
  assert.equal(state.calls.diagnosis, 2);
});

test("an edit after scan during preview is rescanned before any index mutation", { timeout: 5000 }, async () => {
  let changed = false;
  const state = await watchFixture({ onPreview: async (current) => {
    if (!changed) {
      changed = true; await writeFile(path.join(current.root, "README.md"), "# Changed between scan and publication\n");
      current.notify("README.md");
    }
  }, onWait: (current) => { if (current.requests.length === 1) current.controller.abort(); } });
  assert.ifError(state.error);
  assert.equal(state.calls.preview, 2);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].files.find((file) => file.path === "README.md").content, "# Changed between scan and publication\n");
});

test("watch stops without a verified baseline when doctor coverage is unverified", { timeout: 5000 }, async () => {
  const state = await watchFixture({ onDiagnosis: (_current, request) => ({
    status: "ready", can_retrieve: true, resolved_workspace_id: request.workspaceId,
    index: { health_status: "ok", coverage: { state: "unknown" } },
  }) });
  assert.equal(state.requests.length, 1);
  assert.equal(state.calls.diagnosis, 1);
  assert.equal(state.waits, 0);
  assert.equal(state.error?.code, "watch_fence");
  assert.equal(state.writes.some((line) => line.includes("Index verified")), false);
});

test("watch stops when an SDK index result has not reached completed", { timeout: 5000 }, async () => {
  const state = await watchFixture({ onIndex: () => ({ ok: true, result: {}, status: { phase: "processing" } }) });
  assert.equal(state.requests.length, 1);
  assert.equal(state.calls.diagnosis, 0);
  assert.equal(state.waits, 0);
  assert.equal(state.error?.code, "watch_fence");
  assert.equal(state.writes.some((line) => line.includes("Index verified")), false);
});

test("unsupported, malformed, and destructive watch options fail before any API call", { timeout: 5000 }, async () => {
  for (const argv of [["watch", "--profile", "hosted", "--api-base-url", "https://example.invalid"],
    ["watch", "--mode", "incremental"], ["watch", "--rebuild"], ["watch", "--attach", "synthetic-session"],
    ["watch", "--unrecognized"], ["watch", "--once"], ["watch", "--api-base-url", "file:///private/tmp/invalid"]]) {
    const state = await watchFixture({ argv });
    assert.ok(state.error, `Invalid watch options must fail: ${argv.join(" ")}`);
    assert.equal(state.requests.length, 0);
    assert.deepEqual(state.calls, { capabilities: 0, preview: 0, health: 0, diagnosis: 0 });
    assert.equal(state.opened, 0);
  }
});

test("watch passes the active abort signal to the SDK and closes the watcher after cancellation", { timeout: 5000 }, async () => {
  let observedAbort = false;
  const state = await watchFixture({ onIndex: async (current, request) => {
    assert.equal(request.signal, current.controller.signal);
    await new Promise((resolve) => {
      request.signal.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true });
      queueMicrotask(() => current.controller.abort());
    });
    return { ok: false, cancelled: true, status: { phase: "cancelled" } };
  } });
  assert.ifError(state.error);
  assert.equal(observedAbort, true);
  assert.equal(state.requests.length, 1);
  assert.equal(state.calls.diagnosis, 0);
  assert.equal(state.opened, 1);
  assert.equal(state.closed, 1);
});

test("excluded MCP configuration paths still fence destination changes", { timeout: 5000 }, async () => {
  let changed = false;
  const state = await watchFixture({ argv: ["watch", "--exclude", "**/.vscode/**"],
    onSetup: async (current) => {
      await mkdir(path.join(current.root, ".vscode"));
      await writeFile(path.join(current.root, ".vscode", "mcp.json"), JSON.stringify({ servers: { "corpuswire-context-engine": { env: {} } } }));
    },
    onWait: async (current) => {
      if (!changed) {
        changed = true;
        await writeFile(path.join(current.root, ".vscode", "mcp.json"), JSON.stringify({ servers: { "corpuswire-context-engine": { env: { CORPUSWIRE_BASE_URL: "http://127.0.0.1:19999" } } } }));
        current.notify(".vscode/mcp.json");
      }
    },
  });
  assert.equal(state.requests.length, 1);
  assert.equal(state.error?.code, "watch_fence");
  assert.equal(state.waits < 50, true);
});

test("watch rejects unsuccessful SDK results even when their phase says completed", { timeout: 5000 }, async () => {
  const state = await watchFixture({ onIndex: () => ({ ok: false, result: {}, status: { phase: "completed" } }) });
  assert.equal(state.requests.length, 1);
  assert.equal(state.calls.diagnosis, 0);
  assert.equal(state.waits, 0);
  assert.equal(state.error?.code, "watch_fence");
});

test("NDJSON watch output stays parseable through fallback, retry, publication, and abort", { timeout: 5000 }, async () => {
  const state = await watchFixture({ argv: ["--watch", "--ndjson"], watcherUnavailable: true,
    onIndex: (current) => {
      if (current.requests.length === 1) throw Object.assign(new Error("Synthetic retryable NDJSON failure"), { status: 503 });
    },
    onWait: (current) => { if (current.requests.length === 2) current.controller.abort(); },
  });
  assert.ifError(state.error);
  assert.equal(state.requests.length, 2);
  const records = state.writes.map((line) => JSON.parse(line));
  const lifecycle = records.filter((record) => record.schema_version === "watch-progress/v1");
  assert.ok(lifecycle.some((record) => /periodic complete scans/.test(record.message)));
  assert.ok(lifecycle.some((record) => /retry 1\/3/.test(record.message)));
  assert.ok(lifecycle.some((record) => /Index verified/.test(record.message)));
  assert.ok(lifecycle.some((record) => /Watch stopped/.test(record.message)));
});

test("current-session inventory and transfer must be verified even when doctor is ready", { timeout: 5000 }, async () => {
  for (const result of [
    { ok: true, result: {}, status: { phase: "completed", coverage: { state: "unknown" } }, transfer: { complete: true } },
    { ok: true, result: {}, status: { phase: "completed", coverage: { state: "verified" } }, transfer: { complete: false } },
    { ok: true, result: {}, status: { phase: "completed", coverage: { state: "verified" } } },
  ]) {
    const state = await watchFixture({ onIndex: () => result });
    assert.equal(state.requests.length, 1);
    assert.equal(state.waits, 0);
    assert.equal(state.error?.code, "watch_fence");
    assert.equal(state.writes.some((line) => line.includes("Index verified")), false);
  }
});

test("hanging read-only watch fetch aborts on the first stop signal", { timeout: 1000 }, async () => {
  const stop = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const fetchFn = async (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Synthetic abort", "AbortError")), { once: true });
    entered();
  });
  const wrapped = createWatchFetch(fetchFn, { signal: stop.signal, timeoutMs: 500 });
  const pending = wrapped("http://127.0.0.1:18080/v1/index/capabilities");
  const rejection = assert.rejects(pending, { name: "AbortError" });
  await started;
  stop.abort();
  await rejection;
});

test("a hanging mutation response body survives first stop but settles on detach or timeout", { timeout: 1000 }, async () => {
  for (const reason of ["detach", "timeout"]) {
    const stop = new AbortController();
    const detach = new AbortController();
    let entered;
    let receivedSignal;
    const started = new Promise((resolve) => { entered = resolve; });
    const fetchFn = async (_input, init) => {
      receivedSignal = init.signal;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        init.signal.addEventListener("abort", () => controller.error(new DOMException("Synthetic body abort", "AbortError")), { once: true });
        entered();
      } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const wrapped = createWatchFetch(fetchFn, { signal: stop.signal, detachSignal: detach.signal, timeoutMs: reason === "timeout" ? 10 : 500 });
    const pending = wrapped("http://127.0.0.1:18080/v1/index/sessions", { method: "POST" });
    const rejection = assert.rejects(pending, { name: "AbortError" });
    await started;
    stop.abort();
    await Promise.resolve();
    assert.equal(receivedSignal.aborted, false, "First interruption must leave mutation transport available for SDK cancellation");
    if (reason === "detach") detach.abort();
    await rejection;
    assert.equal(receivedSignal.aborted, true);
  }
});

test("verified empty backend diagnosis permits watching and a later source addition", { timeout: 5000 }, async () => {
  let added = false;
  const state = await watchFixture({
    onSetup: async (current) => { await rm(path.join(current.root, "README.md")); await rm(path.join(current.root, "src", "index.js")); },
    onDiagnosis: (current, request) => current.requests.at(-1).files.length === 0 ? {
      status: "blocked", can_retrieve: false, resolved_workspace_id: request.workspaceId,
      index: { health_status: "degraded", health_warnings: ["No indexed Qdrant points were found for this context."], coverage: { state: "verified", eligible_file_count: 0 } },
    } : undefined,
    onWait: async (current) => {
      if (!added) { added = true; await writeFile(path.join(current.root, "README.md"), "# Added after verified empty inventory\n"); current.notify("README.md"); }
      if (current.requests.length === 2) current.controller.abort();
    },
  });
  assert.ifError(state.error);
  assert.equal(state.requests.length, 2);
  assert.deepEqual(state.requests[0].files, []);
  assert.deepEqual(state.requests[1].files.map((file) => file.path), ["README.md"]);
  assert.equal(state.result.publications, 2);
});

test("empty inventory never excuses divergent warnings, authorization failure, or another session", { timeout: 5000 }, async () => {
  for (const failure of ["warning", "authentication", "session"]) {
    const state = await watchFixture({
      onSetup: async (current) => { await rm(path.join(current.root, "README.md")); await rm(path.join(current.root, "src", "index.js")); },
      onIndex: () => ({ ok: true, result: {}, status: { phase: "completed", coverage: { state: "verified", session_id: "synthetic-current" } }, transfer: { complete: true } }),
      onDiagnosis: (_current, request) => {
        if (failure === "authentication") throw Object.assign(new Error("Synthetic rejected auth"), { status: 403 });
        return { status: "blocked", can_retrieve: false, resolved_workspace_id: request.workspaceId,
          index: { health_status: "degraded", health_warnings: [failure === "warning" ? "Unexpected synthetic index failure" : "No indexed Qdrant points were found for this context."],
            coverage: { state: "verified", eligible_file_count: 0, session_id: failure === "session" ? "synthetic-previous" : "synthetic-current" } },
        };
      },
    });
    assert.equal(state.requests.length, 1);
    assert.equal(state.waits, 0);
    assert.ok(state.error, `Empty ${failure} must stop watch`);
    assert.equal(state.writes.some((line) => line.includes("Index verified")), false);
  }
});

test("watch retries startup capabilities and stops cleanly when startup is interrupted", { timeout: 2000 }, async () => {
  for (const interruption of [false, true]) {
    const root = await syntheticWorkspace();
    const controller = new AbortController();
    let capabilities = 0;
    let closed = 0;
    try {
      const client = fakeIndexClient({
        getIndexCapabilities: async () => {
          capabilities += 1;
          if (interruption) {
            queueMicrotask(() => controller.abort());
            return new Promise((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }));
          }
          throw Object.assign(new Error("Synthetic startup unavailable"), { status: 503 });
        },
      });
      const result = await main(["watch"], { cwd: root, homeDirectory: root, env: {}, client,
        signal: controller.signal, write: () => {}, writeRaw: () => {},
        watchFactory: () => ({ close: () => { closed += 1; } }),
        waitForWatch: async () => controller.abort(),
      });
      assert.equal(result.stopped, true);
      assert.equal(result.exitCode, 0);
      assert.equal(capabilities, 1);
      assert.equal(closed, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});


test("watch rejects explicitly unindexed verified diagnosis", async () => {
  const state = await watchFixture({onDiagnosis:async (_current,request)=>({status:"ready",can_retrieve:true,
    resolved_workspace_id:request.workspaceId,index:{indexed:false,health_status:"ok",coverage:{state:"verified"}}})});
  assert.match(state.error?.message ?? "",/index_not_indexed/);
  assert.equal(state.waits,0);
  assert.equal(state.writes.some(line=>line.includes("Index verified")),false);
});
