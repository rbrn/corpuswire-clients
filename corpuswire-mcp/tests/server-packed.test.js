import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  groupServerSpans,
  renderServerSpans,
  serverPackingMode,
  serverSpanCitations,
  shouldUseServerPacking,
} from "../lib/server-packed.mjs";

const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const HASH_A = digest("synthetic file a");
const HASH_B = digest("synthetic file b");

function span(sourcePath, sourceHash, startLine, text, reason = "selected", ids = ["chunk-1"]) {
  return {
    source_path: sourcePath,
    source_hash: sourceHash,
    start_line: startLine,
    end_line: startLine + text.split("\n").length - 1,
    text,
    from_chunk_ids: ids,
    reason,
  };
}

// Fixed fixture: the engine regression compares its server-side render against
// FIXTURE_SHA256. Change both together, never one alone.
const FIXTURE_SPANS = Object.freeze([
  span("docs/guide.md", HASH_A, 3, "## Install\n\nRun `npm install`.", "heading"),
  span("src/app.js", HASH_B, 10, "export function main() {\n  return start();\n}"),
  span("docs/guide.md", HASH_A, 20, "## Configure\nSet CORPUSWIRE_BASE_URL.", "sibling", ["chunk-2", "chunk-3"]),
]);
const FIXTURE_RENDER = [
  "Path: docs/guide.md",
  "3\t## Install",
  "4\t",
  "5\tRun `npm install`.",
  "Path: docs/guide.md",
  "20\t## Configure",
  "21\tSet CORPUSWIRE_BASE_URL.",
  "Path: src/app.js",
  "10\texport function main() {",
  "11\t  return start();",
  "12\t}",
  "",
].join("\n");
const FIXTURE_SHA256 = "83d9615dcc86dad0a6ca5a4fc34c2cd36eb4e61c9d9424e1c6646d3d366b1daa";

function packed(overrides = {}, spans = FIXTURE_SPANS) {
  return {
    evidence_spans: spans,
    packing: {
      policy: "server-v1", budget_chars: 12000, used_chars: 120, spans_total: 3,
      spans_dropped_budget: 0, spans_dropped_conflict: 0, files: 2, fallback_reason: null, complete: true, unverified_hits: 0,
      ...overrides,
    },
  };
}

test("renders spans in the harness layout, grouped by path in first-seen order", () => {
  assert.equal(renderServerSpans(FIXTURE_SPANS), FIXTURE_RENDER);
});

test("rendered fixture text has a stable sha256 for the engine regression", () => {
  const rendered = renderServerSpans(FIXTURE_SPANS);
  assert.equal(digest(rendered), FIXTURE_SHA256);
});

test("groupByPath=false keeps the received order", () => {
  const rendered = renderServerSpans(FIXTURE_SPANS, { groupByPath: false });
  assert.deepEqual(rendered.match(/^Path: .*$/gm), [
    "Path: docs/guide.md", "Path: src/app.js", "Path: docs/guide.md",
  ]);
  assert.equal(rendered.length, FIXTURE_RENDER.length);
});

test("groups and citations follow the rendered order", () => {
  const groups = groupServerSpans(FIXTURE_SPANS);
  assert.deepEqual(groups.map((group) => [group.sourcePath, group.spans.length]),
    [["docs/guide.md", 2], ["src/app.js", 1]]);
  assert.deepEqual(serverSpanCitations(FIXTURE_SPANS),
    ["docs/guide.md:3-5", "docs/guide.md:20-21", "src/app.js:10-12"]);
});

test("a single-line span and an empty line render one row each", () => {
  assert.equal(renderServerSpans([span("a.txt", HASH_A, 7, "")]), "Path: a.txt\n7\t\n");
  assert.equal(renderServerSpans([span("a.txt", HASH_A, 1, "x")]), "Path: a.txt\n1\tx\n");
});

test("empty or invalid spans return null so the caller keeps the old path", () => {
  const good = FIXTURE_SPANS[1];
  const cases = [
    undefined, null, [], "spans", [null], [{}],
    [{ ...good, source_path: "" }],
    [{ ...good, source_path: "/abs/app.js" }],
    [{ ...good, source_path: "../escape.js" }],
    [{ ...good, source_path: "src/a\nb.js" }],
    [{ ...good, source_hash: "abc" }],
    [{ ...good, start_line: 0 }],
    [{ ...good, start_line: 1.5 }],
    [{ ...good, end_line: good.start_line - 1 }],
    [{ ...good, end_line: good.end_line + 1 }], // line count does not match text
    [{ ...good, text: 42 }],
    [{ ...good, reason: "guess" }],
    [{ ...good, from_chunk_ids: "chunk-1" }],
    [{ ...good, from_chunk_ids: [""] }],
    [good, { ...good, source_hash: HASH_A }], // one path, two revisions
    [good, span("src/app.js", HASH_B, 12, "}\n")], // overlapping spans
  ];
  for (const spans of cases) {
    assert.equal(renderServerSpans(spans), null, JSON.stringify(spans));
    assert.deepEqual(serverSpanCitations(spans), []);
  }
});

test("shouldUseServerPacking: complete packing with spans and mode auto", () => {
  assert.equal(shouldUseServerPacking(packed(), {}), true);
  assert.equal(shouldUseServerPacking(packed(), { CORPUSWIRE_SERVER_PACKING: "auto" }), true);
  assert.equal(shouldUseServerPacking(packed(), { CORPUSWIRE_SERVER_PACKING: " AUTO " }), true);
  assert.equal(shouldUseServerPacking({ result: packed(), context: {} }, {}), true);
});

test("shouldUseServerPacking: packing absent", () => {
  assert.equal(shouldUseServerPacking({ retrieved_chunks: [] }, {}), false);
  assert.equal(shouldUseServerPacking({ evidence_spans: FIXTURE_SPANS }, {}), false);
  assert.equal(shouldUseServerPacking({ ...packed(), packing: null }, {}), false);
  assert.equal(shouldUseServerPacking(null, {}), false);
});

test("shouldUseServerPacking: incomplete packing or fallback_reason set", () => {
  assert.equal(shouldUseServerPacking(packed({ complete: false }), {}), false);
  assert.equal(shouldUseServerPacking(packed({ complete: undefined }), {}), false);
  assert.equal(shouldUseServerPacking(packed({ complete: "true" }), {}), false);
  assert.equal(shouldUseServerPacking(packed({ fallback_reason: "sibling_timeout" }), {}), false);
});

test("shouldUseServerPacking: missing, empty or non-array spans", () => {
  assert.equal(shouldUseServerPacking(packed({}, []), {}), false);
  assert.equal(shouldUseServerPacking({ packing: packed().packing }, {}), false);
  assert.equal(shouldUseServerPacking(packed({}, { 0: FIXTURE_SPANS[0] }), {}), false);
});

test("shouldUseServerPacking: CORPUSWIRE_SERVER_PACKING=off, or an unknown value, disables it", () => {
  assert.equal(serverPackingMode({}), "auto");
  assert.equal(serverPackingMode({ CORPUSWIRE_SERVER_PACKING: "" }), "auto");
  assert.equal(serverPackingMode({ CORPUSWIRE_SERVER_PACKING: "off" }), "off");
  assert.equal(serverPackingMode({ CORPUSWIRE_SERVER_PACKING: "ofv" }), "off");
  assert.equal(shouldUseServerPacking(packed(), { CORPUSWIRE_SERVER_PACKING: "off" }), false);
  assert.equal(shouldUseServerPacking(packed(), { CORPUSWIRE_SERVER_PACKING: "false" }), false);
});

// End-to-end through the MCP server with a mock SDK: spans replace the hit
// excerpts only when packing is complete; otherwise output is byte-identical
// to a response without packing fields.
const SERVER_BIN = fileURLToPath(new URL("../bin/corpuswire-mcp.js", import.meta.url));

const BASE_RESULT = Object.freeze({
  retrieval_query: "how do I install",
  retrieval_backend: "qdrant_hybrid",
  retrieval_evidence_policy: "generic-v2",
  retrieved_chunks: [{
    chunk_id: "chunk-1",
    score: 0.9,
    text: "Run `npm install`.",
    metadata: { source_path: "docs/guide.md", chunk_index: 0, start_line: 5, end_line: 5 },
  }],
  citations: ["docs/guide.md:5-5"],
});

async function startServer(root, env) {
  const sdkPath = path.join(root, "mock-sdk.mjs");
  await writeFile(sdkPath, `
import { appendFileSync, readFileSync } from "node:fs";
const fixture = () => JSON.parse(readFileSync(process.env.MOCK_FIXTURE_PATH, "utf8"));
export class CorpusWireClient {
  constructor(options = {}) { this.baseUrl = options.baseUrl; }
  async queryRaw(request) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify(request) + "\\n");
    return { result: fixture(), context: { workspace_id: request.workspaceId, collection: "fixture" } };
  }
  async enhance(request) {
    appendFileSync(process.env.MOCK_REQUESTS_PATH, JSON.stringify(request) + "\\n");
    return { ...fixture(), enhanced_prompt: "Install the package." };
  }
}
`);
  const childEnv = {
    ...process.env,
    CORPUSWIRE_SDK_PATH: sdkPath,
    CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000",
    CORPUSWIRE_IDENTITY_RESOLUTION: "env-only",
    CORPUSWIRE_RETRIEVAL_LOG_DIR: "",
    CORPUSWIRE_SYNC_ENABLED: "false",
    CORPUSWIRE_WORKSPACE_ID: "fixture-packed",
    MOCK_FIXTURE_PATH: path.join(root, "fixture.json"),
    MOCK_REQUESTS_PATH: path.join(root, "requests.jsonl"),
    ...env,
  };
  for (const key of ["CORPUSWIRE_SERVER_PACKING", "CORPUSWIRE_EVIDENCE_BUDGET_CHARS"]) {
    if (!(key in env)) delete childEnv[key];
  }
  const child = spawn(process.execPath, [SERVER_BIN], { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
  let buffer = "";
  const waiters = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    }
  });
  let id = 0;
  const call = async (name, args, fixture) => {
    await writeFile(childEnv.MOCK_FIXTURE_PATH, JSON.stringify(fixture));
    id += 1;
    const reply = new Promise((resolve) => waiters.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    const message = await reply;
    assert.equal(message.result?.isError, false, JSON.stringify(message));
    return message.result.content[0].text;
  };
  const requests = async () => (await readFile(childEnv.MOCK_REQUESTS_PATH, "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { call, requests, stop: () => child.kill() };
}

test("MCP search and enhance render complete server spans and fall back byte-for-byte otherwise", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cw-server-packed-"));
  const auto = await startServer(root, {});
  const off = await startServer(await mkdtemp(path.join(tmpdir(), "cw-server-packed-off-")),
    { CORPUSWIRE_SERVER_PACKING: "off" });
  try {
    const searchArgs = { query: "how do I install" };
    const enhanceArgs = { prompt: "how do I install", localOnly: true };
    const packedResult = { ...BASE_RESULT, ...packed() };
    for (const [tool, args] of [["corpuswire_search", searchArgs], ["corpuswire_enhance_prompt", enhanceArgs]]) {
      const plain = await auto.call(tool, args, BASE_RESULT);
      const rendered = await auto.call(tool, args, packedResult);
      assert.match(rendered, /- evidencePacking: server-v1\n- evidenceSpans: 3 in 2 file\(s\)\n- evidenceBudget: used 120 of 12000 chars; 0 span\(s\) dropped/);
      assert.ok(rendered.includes(`Evidence:\n${FIXTURE_RENDER.replace(/\n$/, "")}`), rendered);
      assert.equal(plain.includes("Evidence:"), false);
      if (tool === "corpuswire_search") {
        assert.match(rendered, /Hits:\n\n1\. docs\/guide\.md\n {3}score: 0\.9000\n {3}chunk: 0\n {3}lines: 5-5\n {3}chunkId: chunk-1\n/);
        assert.doesNotMatch(rendered, / {3}text:/);
        assert.match(rendered, /Citations:\n- docs\/guide\.md:3-5\n- docs\/guide\.md:20-21\n- src\/app\.js:10-12$/);
      }
      // Incomplete packing, a fallback reason, malformed spans and env off: unchanged output.
      for (const fallback of [
        { ...BASE_RESULT, ...packed({ complete: false }) },
        { ...BASE_RESULT, ...packed({ fallback_reason: "sibling_timeout" }) },
        { ...BASE_RESULT, ...packed({}, [{ ...FIXTURE_SPANS[0], end_line: 99 }]) },
      ]) {
        assert.equal(await auto.call(tool, args, fallback), plain);
      }
      assert.equal(await off.call(tool, args, packedResult), await off.call(tool, args, BASE_RESULT));
      assert.equal(await off.call(tool, args, BASE_RESULT), plain);
    }

    // maxChars still bounds the server-packed evidence (the header stays whole).
    const clipped = await auto.call("corpuswire_search", { ...searchArgs, maxChars: 200 }, packedResult);
    assert.match(clipped, /Evidence truncated: \d+ of \d+ server-packed line\(s\) omitted to stay within maxChars \(200\)\./);
    assert.equal(clipped.includes(FIXTURE_RENDER.replace(/\n$/, "")), false);
    const roomy = await auto.call("corpuswire_search", { ...searchArgs, maxChars: 50000 }, packedResult);
    assert.ok(roomy.includes(`Evidence:\n${FIXTURE_RENDER.replace(/\n$/, "")}`));
    assert.equal(roomy.includes("Evidence truncated"), false);

    // Copilot output mode shares the same render path.
    const copilot = await auto.call("corpuswire_enhance_prompt", { ...enhanceArgs, outputMode: "copilot" }, packedResult);
    assert.ok(copilot.includes(`Evidence:\n${FIXTURE_RENDER.replace(/\n$/, "")}`));
    assert.match(copilot, /- outputMode: copilot/);

    await auto.call("corpuswire_search", { ...searchArgs, max_evidence_chars: 20000 }, BASE_RESULT);
    await auto.call("corpuswire_enhance_prompt", { ...enhanceArgs, max_evidence_chars: 1 }, BASE_RESULT);
    const sent = (await auto.requests()).map((request) => request.maxEvidenceChars);
    assert.deepEqual(sent.slice(0, -2), sent.slice(0, -2).map(() => undefined));
    assert.deepEqual(sent.slice(-2), [20000, 1]);
  } finally {
    auto.stop();
    off.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("CORPUSWIRE_EVIDENCE_BUDGET_CHARS is sent when set and the tool argument wins", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cw-server-packed-budget-"));
  const server = await startServer(root, { CORPUSWIRE_EVIDENCE_BUDGET_CHARS: "15000" });
  try {
    await server.call("corpuswire_search", { query: "q" }, BASE_RESULT);
    await server.call("corpuswire_search", { query: "q", max_evidence_chars: 9000 }, BASE_RESULT);
    assert.deepEqual((await server.requests()).map((request) => request.maxEvidenceChars), [15000, 9000]);
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
