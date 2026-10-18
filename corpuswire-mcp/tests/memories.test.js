// CRP-001 L3.2: workspace memory tools behind CORPUSWIRE_MEMORIES_ENABLED.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const SERVER_BIN = fileURLToPath(new URL("../bin/corpuswire-mcp.js", import.meta.url));
const MEMORY_TOOLS = ["corpuswire_remember", "corpuswire_memories", "corpuswire_forget"];
// Built at runtime so no credential-shaped literal sits in the source.
const FAKE_TOKEN = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";

function startBackend({ memoriesEnabled = true } = {}) {
  const requests = [];
  const memories = new Map();
  let nextId = 1;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const url = new URL(request.url, "http://127.0.0.1");
      requests.push({ method: request.method, path: url.pathname, query: url.search, body,
        authorization: request.headers.authorization ?? null });
      const send = (status, payload) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (!url.pathname.startsWith("/v1/memories") || !memoriesEnabled) {
        send(404, { detail: "Not Found" });
        return;
      }
      const workspaceId = url.searchParams.get("workspace_id");
      if (request.method === "POST") {
        const payload = JSON.parse(body);
        if (payload.text.includes("forbidden")) {
          send(400, { detail: "Memory text is longer than 500 characters" });
          return;
        }
        const memory = { memory_id: `mem_${nextId++}`, workspace_id: payload.workspace_id, text: payload.text };
        memories.set(memory.memory_id, memory);
        send(201, { ok: true, created: true, memory });
        return;
      }
      if (request.method === "GET") {
        send(200, { ok: true, memories: [...memories.values()].filter((m) => m.workspace_id === workspaceId) });
        return;
      }
      if (request.method === "DELETE") {
        const memoryId = decodeURIComponent(url.pathname.split("/").pop());
        const memory = memories.get(memoryId);
        if (!memory || memory.workspace_id !== workspaceId) {
          send(404, { detail: "Memory was not found" });
          return;
        }
        memories.delete(memoryId);
        send(200, { ok: true, deleted: true, memory_id: memoryId });
        return;
      }
      send(405, { detail: "Method Not Allowed" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });
}

function startMcp(port, extraEnv = {}) {
  const child = spawn("node", [SERVER_BIN], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CORPUSWIRE_BASE_URL: `http://127.0.0.1:${port}`,
      CORPUSWIRE_WORKSPACE_ID: "local-docker://demo#main",
      CORPUSWIRE_BEARER_TOKEN: "test-bearer",
      CORPUSWIRE_SYNC_ENABLED: "false",
      CORPUSWIRE_RETRIEVAL_LOG_DIR: "",
      ...extraEnv,
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let buffer = "";
  const waiters = [];
  const responses = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const message = JSON.parse(line);
        if (message.id !== undefined) responses.push(message);
      }
      index = buffer.indexOf("\n");
    }
    while (responses.length && waiters.length) waiters.shift()(responses.shift());
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    waiters.push(resolve);
    id += 1;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    while (responses.length && waiters.length) waiters.shift()(responses.shift());
  });
  const call = (name, args) => rpc("tools/call", { name, arguments: args });
  return { child, rpc, call, stderr: () => stderr };
}

test("memory tools are absent while CORPUSWIRE_MEMORIES_ENABLED is off", async () => {
  const backend = await startBackend();
  const mcp = startMcp(backend.port);
  try {
    const tools = await mcp.rpc("tools/list", {});
    const names = tools.result.tools.map((tool) => tool.name);
    for (const name of MEMORY_TOOLS) assert.equal(names.includes(name), false);
    const result = await mcp.call("corpuswire_remember", { text: "Use pnpm." });
    assert.match(result.error.message, /Unknown tool: corpuswire_remember/);
    assert.equal(backend.requests.filter((r) => r.path.startsWith("/v1/memories")).length, 0);
  } finally {
    mcp.child.kill();
    await new Promise((resolve) => backend.server.close(resolve));
  }
});

test("remember, list and forget round-trip through /v1/memories", async () => {
  const backend = await startBackend();
  const mcp = startMcp(backend.port, { CORPUSWIRE_MEMORIES_ENABLED: "true" });
  try {
    const tools = await mcp.rpc("tools/list", {});
    const byName = new Map(tools.result.tools.map((tool) => [tool.name, tool]));
    for (const name of MEMORY_TOOLS) assert.ok(byName.has(name), name);
    assert.equal(byName.get("corpuswire_remember").inputSchema.properties.text.maxLength, 500);
    assert.deepEqual(byName.get("corpuswire_forget").inputSchema.required, ["memoryId"]);

    const remembered = await mcp.call("corpuswire_remember", { text: "  Integration tests need\n the local Qdrant. " });
    assert.equal(remembered.result.isError, false);
    assert.match(remembered.result.content[0].text, /memoryId: mem_1/);
    const post = backend.requests.find((r) => r.method === "POST" && r.path === "/v1/memories");
    assert.equal(post.path, "/v1/memories");
    assert.equal(post.authorization, "Bearer test-bearer");
    assert.deepEqual(JSON.parse(post.body), {
      workspace_id: "local-docker://demo#main",
      text: "Integration tests need the local Qdrant.",
      source: "mcp",
    });

    const listed = await mcp.call("corpuswire_memories", {});
    assert.match(listed.result.content[0].text, /mem_1: Integration tests need the local Qdrant\./);
    const get = backend.requests.find((r) => r.method === "GET" && r.path === "/v1/memories");
    assert.equal(get.query, "?workspace_id=local-docker%3A%2F%2Fdemo%23main");

    const otherWorkspace = await mcp.call("corpuswire_memories", { workspaceId: "local-docker://other#main" });
    assert.match(otherWorkspace.result.content[0].text, /no remembered facts/);

    const forgotten = await mcp.call("corpuswire_forget", { memoryId: "mem_1" });
    assert.equal(forgotten.result.isError, false);
    const again = await mcp.call("corpuswire_forget", { memoryId: "mem_1" });
    assert.equal(again.result.isError, true);
    assert.match(again.result.content[0].text, /Memory was not found/);
  } finally {
    mcp.child.kill();
    await new Promise((resolve) => backend.server.close(resolve));
  }
});

test("secrets and over-long text are refused before any request, without echo", async () => {
  const backend = await startBackend();
  const mcp = startMcp(backend.port, { CORPUSWIRE_MEMORIES_ENABLED: "true" });
  try {
    for (const text of [`deploy with ${FAKE_TOKEN}`, "password=hunter2", "x".repeat(501), "   "]) {
      const result = await mcp.call("corpuswire_remember", { text });
      const message = result.error?.message ?? result.result.content[0].text;
      assert.ok(result.error || result.result.isError, text.slice(0, 20));
      assert.equal(message.includes(FAKE_TOKEN), false);
      assert.equal(message.includes("hunter2"), false);
    }
    assert.equal(backend.requests.filter((r) => r.path.startsWith("/v1/memories")).length, 0);

    const rejected = await mcp.call("corpuswire_remember", { text: "a forbidden fact" });
    assert.equal(rejected.result.isError, true);
    assert.equal(rejected.result.content[0].text.includes("forbidden fact"), false);
    assert.equal(mcp.stderr().includes("forbidden fact"), false);
  } finally {
    mcp.child.kill();
    await new Promise((resolve) => backend.server.close(resolve));
  }
});

test("a server with memories off gives a clear error", async () => {
  const backend = await startBackend({ memoriesEnabled: false });
  const mcp = startMcp(backend.port, { CORPUSWIRE_MEMORIES_ENABLED: "true" });
  try {
    const result = await mcp.call("corpuswire_memories", {});
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /memories turned off/);
  } finally {
    mcp.child.kill();
    await new Promise((resolve) => backend.server.close(resolve));
  }
});
