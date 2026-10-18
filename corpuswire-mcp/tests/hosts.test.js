// Conformance checks for the MCP hosts CorpusWire serves: Claude Code, GitHub
// Copilot (VS Code and the CLI) and Codex. Each test replays the handshake a host
// performs and asserts the host-facing contract, not retrieval quality.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveWorkspaceId } from "../vendor/corpuswire-sdk/dist/workspace-identity.js";

const SERVER_BIN = fileURLToPath(new URL("../bin/corpuswire-mcp.js", import.meta.url));

const MOCK_SDK = `
import { appendFileSync } from "node:fs";
const log = (entry) => appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify(entry) + "\\n");
export class CorpusWireHttpError extends Error {}
export class CorpusWireClient {
  constructor(options = {}) { this.baseUrl = options.baseUrl ?? "http://mock"; }
  async queryRaw(request) {
    log({ kind: "query", workspaceId: request.workspaceId ?? null, repoPath: request.repoPath ?? null });
    return { result: { retrieval_query: request.query, retrieved_chunks: [{ text: "export const x = 1;",
      score: 0.9, metadata: { source_path: "src/x.ts", start_line: 1, end_line: 1 } }] },
      context: { workspace_id: request.workspaceId, tenant_id: "tenant-1", user_id: "user-1",
        actor_kind: "user", membership_role: "owner", collection: "c1", index: { manifest_revision: 7 } } };
  }
  async enhance(request) {
    log({ kind: "enhance", workspaceId: request.workspaceId ?? null, outputMode: request.outputMode });
    return { enhanced_prompt: "Do the thing in src/x.ts.", output_mode: request.outputMode, agent_context_packets: [] };
  }
  async diagnoseWorkspace(request) {
    log({ kind: "diagnose", workspaceId: request.workspaceId ?? null });
    const indexed = (process.env.MOCK_INDEXED_WORKSPACES ?? "").split(",").includes(request.workspaceId);
    return { status: indexed ? "ready" : "blocked", can_retrieve: indexed, point_count: indexed ? 3 : 0, checks: [] };
  }
  async recordQualityEvent(request) {
    log({ kind: "rate", workspaceId: request.workspaceId ?? null, surface: request.surface });
    return { event_id: "q1", workspace_id: request.workspaceId, work_type: request.workType, engine: request.engine,
      relevance: 4, file_specificity: 4, coverage: 4, freshness: 4, actionability: 4, overall: 4, query: "sha256:x" };
  }
}
`;

async function fixture() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cw-hosts-")));
  const sdkPath = path.join(dir, "mock-sdk.mjs");
  const requestsPath = path.join(dir, "requests.jsonl");
  await writeFile(sdkPath, MOCK_SDK);
  await writeFile(requestsPath, "");
  const repo = path.join(dir, "Sample Repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return {
    dir, repo, requestsPath, sdkPath,
    requests: async () => (await readFile(requestsPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function startServer(context, { cwd, env = {}, roots } = {}) {
  const baseEnv = { ...process.env };
  for (const key of ["CORPUSWIRE_WORKSPACE_ID", "CORPUSWIRE_REPO_PATH", "CORPUSWIRE_SYNC_ROOT", "CORPUSWIRE_OUTPUT_MODE",
    "CORPUSWIRE_HOST", "CORPUSWIRE_IDENTITY_RESOLUTION", "CORPUSWIRE_TOOL_PROFILE", "CORPUSWIRE_RESULT_HEADER",
    "CORPUSWIRE_RETRIEVAL_LOG_DIR", "CLAUDE_PROJECT_DIR"]) delete baseEnv[key];
  const child = spawn("node", [SERVER_BIN], {
    cwd: cwd ?? context.repo,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...baseEnv, HOME: context.dir, CORPUSWIRE_SDK_PATH: context.sdkPath, MOCK_REQUESTS_PATH: context.requestsPath,
      CORPUSWIRE_BASE_URL: "http://127.0.0.1:9", ...env },
  });
  let buffer = "";
  const waiters = new Map();
  const serverRequests = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) {
        // A request from the server to the host, such as roots/list.
        serverRequests.push(message.method);
        const result = message.method === "roots/list" ? { roots: roots ?? [] } : {};
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      } else if (message.id !== undefined) {
        waiters.get(message.id)?.(message);
        waiters.delete(message.id);
      }
    }
  });
  let nextId = 1;
  const rpc = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    waiters.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  const initialize = (clientName, capabilities = {}, protocolVersion = "2025-06-18") =>
    rpc("initialize", { protocolVersion, capabilities, clientInfo: { name: clientName, version: "1.0.0" } });
  return { rpc, call, initialize, serverRequests, stop: () => child.kill() };
}

test("initialize negotiates supported protocol versions and gives server instructions", async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  const server = startServer(context);
  try {
    for (const [requested, expected] of [["2025-06-18", "2025-06-18"], ["2025-03-26", "2025-03-26"],
      ["2024-11-05", "2024-11-05"], ["2099-01-01", "2025-06-18"]]) {
      const response = await server.initialize("claude-code", {}, requested);
      assert.equal(response.result.protocolVersion, expected);
      assert.match(response.result.instructions, /corpuswire_search/);
      assert.ok(response.result.instructions.length < 1024);
    }
  } finally { server.stop(); }
});

test("every built-in tool carries a title and annotations; writers are never read-only", async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  const server = startServer(context);
  try {
    await server.initialize("Visual Studio Code");
    const { tools } = (await server.rpc("tools/list")).result;
    assert.equal(tools.length, 23);
    const writers = new Set(["corpuswire_review_context", "corpuswire_review_context_v2", "corpuswire_rate_result", "corpuswire_confirm_value", "corpuswire_sync_delta",
      "corpuswire_sync_flush", "corpuswire_sync_reconcile", "corpuswire_sync_git_delta", "corpuswire_sync_bootstrap",
      "corpuswire_sync_abort_session"]);
    for (const tool of tools) {
      assert.equal(typeof tool.title, "string", tool.name);
      assert.equal(tool.annotations.readOnlyHint, !writers.has(tool.name), tool.name);
      assert.equal(tool.annotations.openWorldHint, false, tool.name);
    }
    assert.equal(tools.find((tool) => tool.name === "corpuswire_sync_abort_session").annotations.destructiveHint, true);
    assert.doesNotMatch(JSON.stringify(tools.find((tool) => tool.name === "corpuswire_enhance_prompt")), /Codex/);
  } finally { server.stop(); }

  const core = startServer(context, { env: { CORPUSWIRE_TOOL_PROFILE: "core" } });
  try {
    const { tools } = (await core.rpc("tools/list")).result;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["corpuswire_doctor", "corpuswire_enhance_prompt",
      "corpuswire_rate_result", "corpuswire_search", "corpuswire_sync_delta", "corpuswire_sync_flush"]);
  } finally { core.stop(); }
});

test("Claude Code: the project's .mcp.json identity scopes search from the server's working folder", async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  await writeFile(path.join(context.repo, ".mcp.json"), JSON.stringify({ mcpServers: {
    "corpuswire-context-engine": { command: "cw", env: { CORPUSWIRE_WORKSPACE_ID: "local-docker://sample#main" } } } }));
  const nested = path.join(context.repo, "src");
  await mkdir(nested);
  const server = startServer(context, { cwd: nested });
  try {
    await server.initialize("claude-code");
    const result = await server.call("corpuswire_search", { query: "where is x" });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /- requestedWorkspaceId: local-docker:\/\/sample#main/);
    assert.match(result.content[0].text, /- workspaceIdentity: host-config \(.*\.mcp\.json\)/);
    const enhance = await server.call("corpuswire_enhance_prompt", { prompt: "fix x" });
    assert.equal(enhance.isError, false);
    await server.call("corpuswire_rate_result", { workType: "semantic_retrieval", engine: "corpuswire",
      relevance: 4, fileSpecificity: 4, coverage: 4, freshness: 4, actionability: 4 });
  } finally { server.stop(); }
  assert.deepEqual(await context.requests(), [
    { kind: "query", workspaceId: "local-docker://sample#main", repoPath: null },
    { kind: "enhance", workspaceId: "local-docker://sample#main", outputMode: "claude-code" },
    { kind: "rate", workspaceId: "local-docker://sample#main", surface: "claude-code" },
  ]);
});

test("Claude Code: CLAUDE_PROJECT_DIR names the project when the server starts elsewhere", async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  await writeFile(path.join(context.repo, ".mcp.json"), JSON.stringify({ mcpServers: {
    "corpuswire-context-engine": { env: { CORPUSWIRE_WORKSPACE_ID: "local-docker://sample#main" } } } }));
  const server = startServer(context, { cwd: context.dir, env: { CLAUDE_PROJECT_DIR: context.repo } });
  try {
    await server.initialize("claude-code");
    const result = await server.call("corpuswire_search", { query: "where is x" });
    assert.match(result.content[0].text, /- requestedWorkspaceId: local-docker:\/\/sample#main/);
  } finally { server.stop(); }
});

test("VS Code Copilot: workspace roots from the host pick the folder's settings", async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  const other = path.join(context.dir, "other");
  await mkdir(path.join(other, ".vscode"), { recursive: true });
  // VS Code settings allow comments and trailing commas.
  await writeFile(path.join(other, ".vscode", "settings.json"),
    '{\n  // CorpusWire\n  "corpuswire.remoteIndexing.workspaceId": "local-docker://other#main",\n}\n');
  // VS Code may start the server outside any project; roots name the folder.
  const server = startServer(context, { cwd: context.dir,
    roots: [{ uri: pathToFileURL(other).href, name: "other" }, { uri: pathToFileURL(context.repo).href }] });
  try {
    await server.initialize("Visual Studio Code", { roots: { listChanged: true } });
    const result = await server.call("corpuswire_search", { query: "where is x" });
    assert.match(result.content[0].text, /- workspaceIdentity: host-config/);
    assert.match(result.content[0].text, /identityWarning: host offered 2 workspace roots; using the first/);
    await server.call("corpuswire_enhance_prompt", { prompt: "fix x" });
    assert.deepEqual(server.serverRequests, ["roots/list"]);
  } finally { server.stop(); }
  assert.deepEqual(await context.requests(), [
    { kind: "query", workspaceId: "local-docker://other#main", repoPath: null },
    { kind: "enhance", workspaceId: "local-docker://other#main", outputMode: "copilot" },
  ]);
});

test("Copilot CLI: an indexed folder default is used, an unindexed one falls back to the backend default", async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  const derived = await deriveWorkspaceId(context.repo);
  const indexed = startServer(context, { env: { MOCK_INDEXED_WORKSPACES: derived } });
  try {
    await indexed.initialize("github-copilot-developer");
    const result = await indexed.call("corpuswire_search", { query: "where is x" });
    assert.match(result.content[0].text, /- workspaceIdentity: derived \(git-toplevel: /);
    await indexed.call("corpuswire_search", { query: "again" });
  } finally { indexed.stop(); }
  assert.deepEqual(await context.requests(), [
    { kind: "diagnose", workspaceId: derived },
    { kind: "query", workspaceId: derived, repoPath: null },
    { kind: "query", workspaceId: derived, repoPath: null },
  ]);

  await writeFile(context.requestsPath, "");
  const unindexed = startServer(context);
  try {
    await unindexed.initialize("github-copilot-developer");
    const result = await unindexed.call("corpuswire_search", { query: "where is x" });
    assert.match(result.content[0].text, /- requestedWorkspaceId: backend default/);
    assert.match(result.content[0].text, /- workspaceIdentity: backend-default/);
    assert.match(result.content[0].text, /identityWarning: no index found for the folder default/);
  } finally { unindexed.stop(); }
  assert.deepEqual(await context.requests(), [
    { kind: "diagnose", workspaceId: derived },
    { kind: "query", workspaceId: null, repoPath: null },
  ]);
});

test("Codex with an env-configured workspace sees unchanged output and generic defaults", async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  await writeFile(path.join(context.repo, ".mcp.json"), JSON.stringify({ mcpServers: {
    "corpuswire-context-engine": { env: { CORPUSWIRE_WORKSPACE_ID: "ignored" } } } }));
  const server = startServer(context, { env: { CORPUSWIRE_WORKSPACE_ID: "local-docker://from-env#main" } });
  try {
    await server.initialize("codex-mcp-client");
    const result = await server.call("corpuswire_search", { query: "where is x" });
    assert.doesNotMatch(result.content[0].text, /workspaceIdentity|identityWarning/);
    assert.match(result.content[0].text, /- tenantId: tenant-1/);
    await server.call("corpuswire_enhance_prompt", { prompt: "fix x" });
    await server.call("corpuswire_rate_result", { workType: "semantic_retrieval", engine: "corpuswire",
      relevance: 4, fileSpecificity: 4, coverage: 4, freshness: 4, actionability: 4 });
  } finally { server.stop(); }
  assert.deepEqual(await context.requests(), [
    { kind: "query", workspaceId: "local-docker://from-env#main", repoPath: null },
    { kind: "enhance", workspaceId: "local-docker://from-env#main", outputMode: "generic" },
    { kind: "rate", workspaceId: "local-docker://from-env#main", surface: "codex" },
  ]);
});

test("rollback switches restore pre-detection behavior", async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  await writeFile(path.join(context.repo, ".mcp.json"), JSON.stringify({ mcpServers: {
    corpuswire: { env: { CORPUSWIRE_WORKSPACE_ID: "local-docker://sample#main" } } } }));
  const server = startServer(context, { env: { CORPUSWIRE_IDENTITY_RESOLUTION: "env-only", CORPUSWIRE_HOST: "unknown" } });
  try {
    await server.initialize("claude-code");
    await server.call("corpuswire_search", { query: "where is x" });
    await server.call("corpuswire_enhance_prompt", { prompt: "fix x" });
  } finally { server.stop(); }
  assert.deepEqual(await context.requests(), [
    { kind: "query", workspaceId: null, repoPath: null },
    { kind: "enhance", workspaceId: null, outputMode: "generic" },
  ]);
});

test("compact result header drops tenancy and storage lines only", async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  const server = startServer(context, { env: { CORPUSWIRE_WORKSPACE_ID: "w", CORPUSWIRE_RESULT_HEADER: "compact" } });
  try {
    await server.initialize("claude-code");
    const text = (await server.call("corpuswire_search", { query: "where is x" })).content[0].text;
    assert.doesNotMatch(text, /tenantId|userId|actorKind|membershipRole|- collection:|manifestRevision/);
    assert.match(text, /- requestedWorkspaceId: w/);
    assert.match(text, /src\/x\.ts/);
    const enhance = (await server.call("corpuswire_enhance_prompt", { prompt: "fix x" })).content[0].text;
    assert.doesNotMatch(enhance, /tenantId|membershipRole/);
    assert.match(enhance, /Do the thing in src\/x\.ts\./);
  } finally { server.stop(); }
});
