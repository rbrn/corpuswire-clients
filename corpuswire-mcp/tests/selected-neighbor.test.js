import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { planSelectedNeighbor } from "../lib/selected-neighbor.mjs";

const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function physicalLines(source) {
  const lines = source.split("\n");
  if (source.endsWith("\n")) lines.pop();
  return lines;
}

function hit(id, {
  source = "alpha\nbeta\ngamma", path = "src/sample.py", start = 2, end = start,
  projectionStart = start, projectionEnd = end, generation = 3,
  mappingKind = undefined,
} = {}) {
  const lines = physicalLines(source);
  const text = lines.slice(start - 1, end).join("\n");
  const projectionText = lines.slice(projectionStart - 1, projectionEnd).join("\n");
  return {
    chunk_id: id, score: 1, text,
    metadata: {
      source_path: path, source_hash: digest(source), source_generation: generation,
      index_scope: null, start_line: start, end_line: end,
      extras: {
        corpuswire_display_lines: {
          schema_version: "corpuswire-complete-source-lines/v1",
          source_hash: digest(source),
          start_line: projectionStart, end_line: projectionEnd,
          text: projectionText, text_sha256: digest(projectionText),
          ...(mappingKind ? {
            mapping_kind: mappingKind, chunk_text_sha256: digest(text),
          } : {}),
        },
      },
    },
  };
}

function run(item, { start = item.metadata.start_line, end = item.metadata.end_line,
  source = undefined } = {}) {
  const projection = item.metadata.extras.corpuswire_display_lines;
  const lines = source ? physicalLines(source) : projection.text.split("\n");
  const offset = source ? 1 : projection.start_line;
  return {
    chunkId: item.chunk_id, startLine: start, endLine: end,
    text: lines.slice(start - offset, end - offset + 1).join("\n"),
  };
}

function plan(item, source, overrides = {}) {
  return planSelectedNeighbor({
    baselineHits: [item], deliveredRuns: [run(item, { source })],
    sourceTexts: { [item.metadata.source_path]: source },
    query: "where is beta", maxChars: 12_000, generation: 3,
    ...overrides,
  });
}

test("expands whole LF source lines at most eight on each side", () => {
  const source = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n");
  const anchor = hit("anchor", { source, start: 13 });
  const input = {
    baselineHits: [anchor], deliveredRuns: [run(anchor, { source })],
    sourceTexts: { "src/sample.py": source }, query: "where", maxChars: 12_000, generation: 3,
  };
  const original = structuredClone(input);
  const result = planSelectedNeighbor(input);
  assert.equal(result.usedNeighbor, true);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].metadata.start_line, 5);
  assert.equal(result.hits[0].metadata.end_line, 21);
  assert.equal(result.hits[0].text, physicalLines(source).slice(4, 21).join("\n"));
  assert.match(result.hits[0].chunk_id, /^bundle:[0-9a-f]{64}$/);
  assert.deepEqual(result.hits[0].metadata.extras.evidence_bundle.contributing_chunk_ids,
    ["anchor"]);
  assert.equal(planSelectedNeighbor(input).hits[0].chunk_id, result.hits[0].chunk_id);
  assert.notEqual(planSelectedNeighbor({ ...input, query: "another question" }).hits[0].chunk_id,
    result.hits[0].chunk_id);
  assert.deepEqual(input, original);
});

test("v2 reaches twenty physical neighbors while explicit v1 stays byte-identical", () => {
  const source = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
  const anchor = hit("anchor", { source, start: 25 });
  const options = {
    baselineHits: [anchor], deliveredRuns: [run(anchor, { source })],
    sourceTexts: { "src/sample.py": source }, query: "where", maxChars: 12_000,
    generation: 3,
  };
  const defaultV1 = planSelectedNeighbor(options);
  const explicitV1 = planSelectedNeighbor({ ...options, maxRadius: 8 });
  const v2 = planSelectedNeighbor({ ...options, maxRadius: 20 });
  assert.deepEqual(defaultV1, explicitV1);
  assert.equal(defaultV1.hits[0].metadata.start_line, 17);
  assert.equal(defaultV1.hits[0].metadata.end_line, 33);
  assert.equal(v2.hits[0].metadata.start_line, 5);
  assert.equal(v2.hits[0].metadata.end_line, 45);
  assert.equal(v2.hits[0].text, physicalLines(source).slice(4, 45).join("\n"));
  assert.equal(v2.hits[0].metadata.extras.corpuswire_display_lines.text_sha256,
    digest(v2.hits[0].text));
  assert.equal(planSelectedNeighbor({ ...options, maxRadius: 21 }).reason, "invalid_input");
});

test("accepts source-verified files from different incremental generations", () => {
  const firstSource = "first before\nfirst anchor\nfirst after";
  const secondSource = "second before\nsecond anchor\nsecond after";
  const first = hit("first", { source: firstSource, path: "src/first.py", generation: 3 });
  const second = hit("second", { source: secondSource, path: "src/second.py", generation: 7 });
  const options = {
    baselineHits: [first, second],
    deliveredRuns: [run(first, { source: firstSource }), run(second, { source: secondSource })],
    sourceTexts: { "src/first.py": firstSource, "src/second.py": secondSource },
    query: "where are the anchors", maxChars: 12_000, generation: null, maxRadius: 20,
  };
  const result = planSelectedNeighbor(options);
  assert.equal(result.usedNeighbor, true);
  assert.deepEqual(result.hits.map((item) => item.metadata.source_generation), [3, 7]);
  assert.equal(planSelectedNeighbor({ ...options, generation: 3 }).reason,
    "generation_or_scope_mismatch");

  const scoped = structuredClone(second);
  scoped.metadata.index_scope = {
    identity_version: "v2", publication_state: "published", generation: 7,
  };
  assert.equal(planSelectedNeighbor({ ...options, baselineHits: [first, scoped] }).reason,
    "generation_or_scope_mismatch");
  assert.equal(planSelectedNeighbor({ ...options, baselineHits: [scoped],
    deliveredRuns: [run(scoped, { source: secondSource })],
    sourceTexts: { "src/second.py": secondSource } }).reason,
  "generation_or_scope_mismatch");
});

test("preserves an authenticated terminal blank source line with source-context mapping", () => {
  const source = "alpha\n\n";
  const anchor = hit("anchor", { source, start: 1 });
  const result = plan(anchor, source);
  assert.equal(result.usedNeighbor, true);
  const proposal = result.hits[0];
  assert.equal(proposal.text, "alpha");
  assert.equal(proposal.metadata.start_line, 1);
  assert.equal(proposal.metadata.end_line, 1);
  assert.equal(proposal.metadata.extras.corpuswire_display_lines.start_line, 1);
  assert.equal(proposal.metadata.extras.corpuswire_display_lines.end_line, 2);
  assert.equal(proposal.metadata.extras.corpuswire_display_lines.text, "alpha\n");
  assert.equal(proposal.metadata.extras.corpuswire_display_lines.mapping_kind, "source-context/v1");
  assert.equal(proposal.metadata.extras.corpuswire_display_lines.chunk_text_sha256,
    digest("alpha"));
});

test("keeps a delivered physical blank line and extends beyond it", () => {
  const source = "alpha\n\nbeta";
  const anchor = hit("anchor", {
    source, start: 1, end: 1, projectionStart: 1, projectionEnd: 2,
    mappingKind: "source-context/v1",
  });
  const result = plan(anchor, source, {
    deliveredRuns: [run(anchor, { start: 1, end: 2, source })],
  });
  assert.equal(result.usedNeighbor, true);
  assert.equal(result.hits[0].text, source);
  assert.equal(result.hits[0].metadata.start_line, 1);
  assert.equal(result.hits[0].metadata.end_line, 3);
});

test("left neighbor wins before right neighbor under a shared UTF-16 budget", () => {
  const left = `left ${"😀".repeat(75)}`;
  const center = "center";
  const right = `right ${"😀".repeat(75)}`;
  const source = [left, center, right].join("\n");
  const anchor = hit("anchor", { source, start: 2 });
  for (const maxRadius of [8, 20]) {
    const result = plan(anchor, source, { maxChars: 200, maxRadius });
    assert.equal(result.usedNeighbor, true);
    assert.equal(result.hits[0].metadata.start_line, 1);
    assert.equal(result.hits[0].metadata.end_line, 2);
    assert.equal(result.hits[0].text, `${left}\n${center}`);
    assert.ok(result.hits[0].text.length <= 200);
  }
});

test("rejects source mismatch, unverified projection, and false delivered bytes", () => {
  const source = "alpha\nbeta\ngamma";
  const anchor = hit("anchor", { source });
  const baselineHits = [anchor];
  const wrongSource = planSelectedNeighbor({
    baselineHits, deliveredRuns: [run(anchor, { source })],
    sourceTexts: { "src/sample.py": "alpha\nchanged\ngamma" },
    query: "beta", maxChars: 12_000, generation: 3,
  });
  assert.equal(wrongSource.reason, "source_mismatch");
  assert.strictEqual(wrongSource.hits, baselineHits);
  const badProjection = structuredClone(anchor);
  badProjection.metadata.extras.corpuswire_display_lines.text = "invented";
  assert.equal(plan(badProjection, source).reason, "projection_mismatch");
  const badRun = plan(anchor, source, {
    deliveredRuns: [{ chunkId: "anchor", startLine: 2, endLine: 2, text: "invented" }],
  });
  assert.equal(badRun.reason, "delivered_run_mismatch");
});

test("fails closed for generation, traversal, invalid UTF-8, and CRLF", () => {
  const source = "alpha\nbeta\ngamma";
  const anchor = hit("anchor", { source });
  assert.equal(plan(anchor, source, { generation: 4 }).reason, "generation_or_scope_mismatch");
  const traversal = hit("traversal", { source, path: "../secrets.py" });
  assert.equal(plan(traversal, source).reason, "invalid_selected_hit");
  const absolute = hit("absolute", { source, path: "/tmp/secrets.py" });
  assert.equal(plan(absolute, source).reason, "invalid_selected_hit");
  const invalidUtf8 = "alpha\n\ud800\ngamma";
  const badUtf8Hit = hit("bad", { source: invalidUtf8 });
  assert.equal(plan(badUtf8Hit, invalidUtf8).reason, "source_mismatch");
  const crlf = "alpha\r\nbeta\r\ngamma";
  const crlfHit = hit("crlf", { source: crlf });
  assert.equal(plan(crlfHit, crlf).reason, "source_mismatch");
});

test("retains control if request or a neighboring projection exceeds a cap", () => {
  const source = "alpha\nbeta\ngamma";
  const anchor = hit("anchor", { source });
  const baselineHits = [anchor];
  const oversized = plan(anchor, source, { maxChars: 12_001 });
  assert.equal(oversized.usedNeighbor, false);
  assert.strictEqual(oversized.hits[0], anchor);
  const long = `alpha\n${"x".repeat(16_001)}\ngamma`;
  const longAnchor = hit("long", { source: long, start: 1 });
  const blocked = plan(longAnchor, long);
  assert.equal(blocked.usedNeighbor, false);
  assert.strictEqual(blocked.hits[0], longAnchor);
  const badProjection = structuredClone(anchor);
  badProjection.metadata.extras.corpuswire_display_lines.text = "x".repeat(16_001);
  badProjection.metadata.extras.corpuswire_display_lines.text_sha256 = digest(
    badProjection.metadata.extras.corpuswire_display_lines.text,
  );
  assert.equal(plan(badProjection, source).reason, "projection_mismatch");
  assert.strictEqual(baselineHits[0], anchor);
  assert.equal(plan(anchor, source, { maxChars: 12_001, maxRadius: 20 }).reason,
    "request_exceeds_budget");
});

test("never adds a sixth contributor or changes selected-hit membership", () => {
  const sourceTexts = {};
  const baselineHits = [];
  const deliveredRuns = [];
  for (let index = 0; index < 5; index += 1) {
    const path = `src/file-${index}.py`;
    const source = `first-${index}\nsecond-${index}`;
    sourceTexts[path] = source;
    const item = hit(`hit-${index}`, { path, source, start: 1 });
    baselineHits.push(item);
    deliveredRuns.push(run(item, { source }));
  }
  const options = {
    baselineHits, deliveredRuns, sourceTexts, query: "anything",
    maxChars: 12_000, generation: 3,
  };
  const result = planSelectedNeighbor(options);
  assert.equal(result.usedNeighbor, true);
  assert.equal(result.hits.length, 5);
  assert.deepEqual(result.hits.map((item) => item.metadata.extras.evidence_bundle.contributing_chunk_ids),
    baselineHits.map((item) => [item.chunk_id]));
  const sixth = hit("sixth", { path: "src/sixth.py", source: "one\ntwo", start: 1 });
  const denied = planSelectedNeighbor({
    ...options, baselineHits: [...baselineHits, sixth],
    deliveredRuns: [...deliveredRuns, run(sixth, { source: "one\ntwo" })],
    sourceTexts: { ...sourceTexts, "src/sixth.py": "one\ntwo" },
  });
  assert.equal(denied.reason, "invalid_input");
  assert.strictEqual(denied.hits[0], baselineHits[0]);
});
