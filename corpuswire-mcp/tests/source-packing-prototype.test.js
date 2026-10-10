import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  planAuthenticatedNewlinePacking, planRendererAwarePacking, planSourcePacking,
} from "../lib/source-packing-prototype.mjs";

const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function scope(snapshot = "snapshot-a") {
  return {
    identity_version: "v2", tenant_id: "tenant-a", codebase_id: "codebase-a",
    repository_id: "repository-a", repository_set_id: "set-a",
    authorized_repository_ids: ["repository-a"], snapshot_id: snapshot,
    overlay_id: null, generation: 1, content_layer: "snapshot",
    revision: "a".repeat(40), publication_state: "published",
  };
}

function publicationFence() {
  return {
    schema_version: "rqt110-frozen-publication-fence/v1",
    tenant_id: "tenant-a", served_workspace_id: "served-a",
    storage_workspace_id: "stored-a", collection: "collection-a",
    manifest_revision: 1, repository_id: "repository-a",
    source_snapshot_digest: "b".repeat(64), publication_digest: "c".repeat(64),
    generation: 3, overlay_id: null,
  };
}

function fencedHit(id, options) {
  const result = hit(id, options);
  result.metadata.index_scope = null;
  result.metadata.source_generation = 3;
  return result;
}

function hit(id, { text, start, source = text, indexScope = scope(), path = "src/sample.py" }) {
  const sourceHash = digest(source);
  return {
    chunk_id: id, score: 1, text,
    metadata: {
      source_path: path, source_hash: sourceHash, index_scope: indexScope,
      start_line: start, end_line: start + text.split("\n").length - 1,
      extras: {
        corpuswire_display_lines: {
          schema_version: "corpuswire-complete-source-lines/v1",
          source_hash: sourceHash,
          start_line: start, end_line: start + text.split("\n").length - 1,
          text, text_sha256: digest(text),
        },
      },
    },
  };
}

function delivered(hitValue, startLine = hitValue.metadata.start_line, text = hitValue.text) {
  return {
    chunkId: hitValue.chunk_id,
    startLine,
    endLine: startLine + text.split("\n").length - 1,
    text,
  };
}

function rendererPlan({ baselineHits, candidateHits, deliveredRuns, query = "evidence", ...options }) {
  return planRendererAwarePacking({
    baselineHits, candidateHits,
    deliveredRuns: deliveredRuns ?? baselineHits.map((item) => delivered(item)),
    query, ...options,
  });
}

function newlineInput({ source = "alpha\n\nbeta", blankLines = [2] } = {}) {
  const anchor = fencedHit("anchor", { text: "alpha", start: 1, source });
  Object.assign(anchor.metadata.extras.corpuswire_display_lines, {
    mapping_kind: "source-context/v1", chunk_text_sha256: digest(anchor.text),
    end_line: 2, text: "alpha\n", text_sha256: digest("alpha\n"),
  });
  const fence = publicationFence();
  return {
    baselineHits: [anchor], candidateHits: [anchor],
    deliveredRuns: [{ chunkId: "anchor", startLine: 1, endLine: 2, text: "alpha\n" }],
    query: "alpha", publicationFence: fence,
    sourceProofs: {
      publicationFence: fence,
      records: [{ path: "src/sample.py", sourceHash: digest(source),
        physicalLineCount: source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length,
        blankLfTerminatedLines: blankLines }],
    },
  };
}

test("joins adjacent exact source lines and produces a stable distinct bundle ID", () => {
  const source = "alpha\r\nbeta\r\ngamma";
  const first = hit("first", { text: "alpha\r", start: 1, source });
  const second = hit("second", { text: "beta\r\ngamma", start: 2, source });
  const input = { baselineHits: [first], candidateHits: [first, second] };
  const original = structuredClone(input);
  const one = planSourcePacking(input);
  const two = planSourcePacking(input);
  assert.equal(one.usedPacking, true);
  assert.equal(one.hits.length, 1);
  assert.equal(one.hits[0].text, source);
  assert.match(one.hits[0].chunk_id, /^bundle:[0-9a-f]{64}$/);
  assert.equal(one.hits[0].chunk_id, two.hits[0].chunk_id);
  assert.deepEqual(one.hits[0].metadata.extras.evidence_bundle.contributing_chunk_ids, ["first", "second"]);
  assert.equal(one.hits[0].metadata.extras.corpuswire_display_lines.text_sha256, digest(source));
  assert.strictEqual(one.fallbackHits, input.baselineHits);
  assert.deepEqual(input, original);
});

test("keeps identical paths in different publication scopes separate", () => {
  const source = "one\ntwo";
  const first = hit("first", { text: "one", start: 1, source });
  const second = hit("second", { text: "two", start: 2, source, indexScope: scope("snapshot-b") });
  const result = planSourcePacking({ baselineHits: [first], candidateHits: [first, second], topK: 2 });
  assert.equal(result.usedPacking, true);
  assert.equal(result.hits.length, 2);
  assert.deepEqual(result.hits.map((item) => item.chunk_id), ["first", "second"]);
  assert.notEqual(result.hits[0].metadata.index_scope.snapshot_id, result.hits[1].metadata.index_scope.snapshot_id);
});

test("preserves verified markdown source context without reading a file", () => {
  const source = "# Heading\n\nalpha\nbeta";
  const first = hit("first", { text: "alpha", start: 3, source, path: "docs/sample.md" });
  Object.assign(first.metadata.extras.corpuswire_display_lines, {
    mapping_kind: "source-context/v1", chunk_text_sha256: digest(first.text),
    start_line: 1, end_line: 3, text: "# Heading\n\nalpha",
    text_sha256: digest("# Heading\n\nalpha"),
  });
  const second = hit("second", { text: "beta", start: 4, source, path: "docs/sample.md" });
  const result = planSourcePacking({ baselineHits: [first], candidateHits: [first, second] });
  assert.equal(result.usedPacking, true);
  assert.equal(result.hits[0].text, source);
  assert.equal(result.hits[0].metadata.start_line, 1);
  assert.equal(result.hits[0].metadata.end_line, 4);
  assert.equal(result.hits[0].metadata.extras.corpuswire_display_lines.mapping_kind, undefined);
});

test("rejects conflicting overlapping lines and retains the exact control", () => {
  const source = "a\nb\nc";
  const first = hit("first", { text: "a\nb", start: 1, source });
  const second = hit("second", { text: "different\nc", start: 2, source });
  const baselineHits = [first];
  const result = planSourcePacking({ baselineHits, candidateHits: [first, second] });
  assert.equal(result.usedPacking, false);
  assert.strictEqual(result.hits, baselineHits);
  assert.deepEqual(result.rejected, [{ rank: 1, reason: "conflicting_source_lines" }]);
});

test("keeps the original when an addition exceeds the excerpt budget", () => {
  const first = hit("first", { text: "aaaa", start: 1 });
  const second = hit("second", { text: "bbbbb", start: 1, path: "src/other.py" });
  const baselineHits = [first];
  const result = planSourcePacking({ baselineHits, candidateHits: [first, second], maxChars: 8 });
  assert.equal(result.usedPacking, false);
  assert.strictEqual(result.hits, baselineHits);
  assert.deepEqual(result.rejected, [{ rank: 1, reason: "character_budget" }]);
  assert.equal(result.excerptChars, 4);
});

test("falls back deterministically when control provenance is unavailable", () => {
  const first = hit("first", { text: "alpha", start: 1 });
  delete first.metadata.index_scope;
  const baselineHits = [first];
  const input = { baselineHits, candidateHits: [first] };
  const firstPlan = planSourcePacking(input);
  const secondPlan = planSourcePacking(input);
  assert.strictEqual(firstPlan.hits, baselineHits);
  assert.strictEqual(secondPlan.hits, baselineHits);
  assert.equal(firstPlan.reason, "baseline_invalid_source_identity");
  assert.deepEqual(firstPlan.rejected, secondPlan.rejected);
});

test("rejects transformed projections and respects the per-source constituent cap", () => {
  const source = "one\ntwo\nthree";
  const first = hit("first", { text: "one", start: 1, source });
  const second = hit("second", { text: "two", start: 2, source });
  const third = hit("third", { text: "three", start: 3, source });
  third.metadata.extras.corpuswire_display_lines.mapping_kind = "json-record/v1";
  const transformed = planSourcePacking({ baselineHits: [first], candidateHits: [first, third] });
  assert.deepEqual(transformed.rejected, [{ rank: 1, reason: "unsupported_mapping" }]);
  delete third.metadata.extras.corpuswire_display_lines.mapping_kind;
  const capped = planSourcePacking({ baselineHits: [first], candidateHits: [first, second, third] });
  assert.equal(capped.hits[0].text, "one\ntwo");
  assert.deepEqual(capped.rejected, [{ rank: 2, reason: "source_cap" }]);
});

test("uses generic-v2's adaptive cap when the first ten candidates span five sources", () => {
  const source = "one\ntwo\nthree";
  const first = hit("first", { text: "one", start: 1, source });
  const second = hit("second", { text: "two", start: 2, source });
  const third = hit("third", { text: "three", start: 3, source });
  const others = ["a", "b", "c", "d"].map((name) => hit(name, {
    text: name, start: 1, path: `src/${name}.py`,
  }));
  const result = planSourcePacking({
    baselineHits: [first], candidateHits: [first, second, third, ...others],
  });
  assert.equal(result.hits[0].text, source);
  assert.deepEqual(result.hits[0].metadata.extras.evidence_bundle.contributing_chunk_ids,
    ["first", "second", "third"]);
  assert.equal(result.rejected.some((item) => item.reason === "source_cap"), false);
});

test("joins frozen v1 hits only under a complete trusted publication fence", () => {
  const source = "first\nsecond";
  const first = fencedHit("first", { text: "first", start: 1, source });
  const second = fencedHit("second", { text: "second", start: 2, source });
  const baselineHits = [first];
  const candidateHits = [first, second];
  const withoutFence = planSourcePacking({ baselineHits, candidateHits });
  assert.equal(withoutFence.usedPacking, false);
  assert.equal(withoutFence.reason, "baseline_invalid_source_identity");
  const result = planSourcePacking({ baselineHits, candidateHits, publicationFence: publicationFence() });
  assert.equal(result.usedPacking, true);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].text, source);
  assert.equal(result.hits[0].metadata.index_scope, null);
  assert.equal(result.hits[0].metadata.source_generation, 3);
  assert.strictEqual(result.fallbackHits, baselineHits);
});

test("frozen v1 rejects missing or mismatched generations and mixed v2 scope", () => {
  const first = fencedHit("first", { text: "first", start: 1 });
  const second = fencedHit("second", { text: "second", start: 2, source: "first\nsecond" });
  const baselineHits = [first];
  const options = { baselineHits, candidateHits: [first, second], publicationFence: publicationFence() };
  second.metadata.source_generation = 4;
  const mismatch = planSourcePacking(options);
  assert.strictEqual(mismatch.hits, baselineHits);
  assert.equal(mismatch.reason, "publication_generation_mismatch");
  delete second.metadata.source_generation;
  assert.equal(planSourcePacking(options).reason, "publication_generation_mismatch");
  second.metadata.source_generation = 3;
  second.metadata.index_scope = scope();
  assert.equal(planSourcePacking(options).reason, "mixed_scope_mode");
});

test("frozen v1 rejects incomplete fences and conflicting per-hit publication fields", () => {
  const first = fencedHit("first", { text: "first", start: 1 });
  const baselineHits = [first];
  const fence = publicationFence();
  delete fence.publication_digest;
  assert.equal(planSourcePacking({ baselineHits, candidateHits: [first], publicationFence: fence }).reason,
    "invalid_publication_fence");
  first.metadata.repository_id = "different-repository";
  assert.equal(planSourcePacking({ baselineHits, candidateHits: [first], publicationFence: publicationFence() }).reason,
    "publication_metadata_mismatch");
});

test("never creates evidence for an empty control or an oversized candidate pool", () => {
  const first = fencedHit("first", { text: "first", start: 1 });
  const publication = publicationFence();
  const empty = planSourcePacking({
    baselineHits: [], candidateHits: [first], publicationFence: publication,
  });
  assert.equal(empty.reason, "empty_control");
  assert.deepEqual(empty.hits, []);
  const oversized = planSourcePacking({
    baselineHits: [first], candidateHits: Array(33).fill(first), publicationFence: publication,
  });
  assert.equal(oversized.reason, "invalid_input");
  assert.strictEqual(oversized.hits[0], first);
});

test("renderer-aware planner protects shortened control lines with a distinct bundle ID", () => {
  const source = "anchor line\nmissing evidence\ntail line";
  const first = hit("first", { text: source, start: 1, source });
  const second = hit("second", { text: "tail line", start: 3, source });
  const input = {
    baselineHits: [first], candidateHits: [first, second],
    deliveredRuns: [delivered(first, 1, "anchor line")],
    query: "missing evidence",
  };
  const original = structuredClone(input);
  const result = rendererPlan(input);
  assert.equal(result.usedPacking, true);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].text, source);
  assert.match(result.hits[0].chunk_id, /^bundle:[0-9a-f]{64}$/);
  assert.notEqual(result.hits[0].chunk_id, first.chunk_id);
  assert.equal(rendererPlan(input).hits[0].chunk_id, result.hits[0].chunk_id);
  assert.notEqual(rendererPlan({ ...input, query: "different query" }).hits[0].chunk_id,
    result.hits[0].chunk_id);
  assert.deepEqual(result.hits[0].metadata.extras.evidence_bundle.contributing_chunk_ids,
    ["first"]);
  assert.strictEqual(result.fallbackHits, input.baselineHits);
  assert.deepEqual(input, original);
});

test("renderer-aware trim uses exact normalized token intersection and a complete line", () => {
  const anchor = hit("anchor", { text: "control", start: 1 });
  const line1 = `foobar ${"x".repeat(105)}`;
  const line2 = `ＦＯＯ evidence ${"y".repeat(105)}`;
  const line3 = `other ${"z".repeat(105)}`;
  const donor = hit("donor", {
    text: [line1, line2, line3].join("\n"), start: 1,
    path: "src/donor.py",
  });
  const result = rendererPlan({
    baselineHits: [anchor], candidateHits: [anchor, donor],
    query: "the foo and evidence", maxChars: 100,
  });
  assert.equal(result.usedPacking, true);
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[1].text, line2);
  assert.equal(result.hits[1].metadata.start_line, 2);
  assert.equal(result.hits[1].metadata.end_line, 2);
  assert.equal(result.hits[1].metadata.extras.corpuswire_display_lines.text_sha256, digest(line2));
  assert.ok(result.excerptChars <= 200); // Node clamps a 100-character request to 200.
});

test("renderer-aware trim uses midpoint and lower-line ties, then earliest zero score", () => {
  const anchor = hit("anchor", { text: "control", start: 1 });
  const lines = [
    `alpha ${"a".repeat(100)}`, `target ${"b".repeat(100)}`,
    `middle ${"c".repeat(100)}`, `target ${"d".repeat(100)}`,
  ];
  const donor = hit("donor", { text: lines.join("\n"), start: 10, path: "src/tie.py" });
  const common = { baselineHits: [anchor], candidateHits: [anchor, donor], maxChars: 200 };
  const tied = rendererPlan({ ...common, query: "target" });
  assert.equal(tied.hits[1].metadata.start_line, 11);
  assert.equal(tied.hits[1].text, lines[1]);
  const zero = rendererPlan({ ...common, query: "unmatched" });
  assert.equal(zero.hits[1].metadata.start_line, 10);
  assert.equal(zero.hits[1].text, lines[0]);
});

test("renderer-aware coalescing outranks a higher-ranked disjoint donor", () => {
  const source = "anchor\nneighbor";
  const anchor = hit("anchor", { text: "anchor", start: 1, source });
  const disjoint = hit("disjoint", {
    text: "d".repeat(186), start: 1, path: "src/disjoint.py",
  });
  const neighbor = hit("neighbor", { text: "neighbor", start: 2, source });
  const result = rendererPlan({
    baselineHits: [anchor], candidateHits: [anchor, disjoint, neighbor], maxChars: 200,
  });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].text, source);
  assert.deepEqual(result.rejected, [{ rank: 1, reason: "no_fitting_core_line" }]);
});

test("renderer-aware defers a trimmed core that no longer touches protected lines", () => {
  const lines = [
    "anchor", `plain ${"a".repeat(105)}`,
    `middle ${"b".repeat(105)}`, `target ${"c".repeat(105)}`,
  ];
  const source = lines.join("\n");
  const anchor = hit("anchor", { text: lines[0], start: 1, source });
  const donor = hit("donor", { text: lines.slice(1).join("\n"), start: 2, source });
  const result = rendererPlan({
    baselineHits: [anchor], candidateHits: [anchor, donor], query: "target", maxChars: 200,
  });
  assert.equal(result.usedPacking, true);
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[1].text, lines[3]);
  assert.equal(result.hits[1].metadata.start_line, 4);
  assert.deepEqual(result.rejected, []);
});

test("renderer-aware never retries a rejected coalescing donor", () => {
  const anchor = hit("anchor", { text: "anchor", start: 1, source: "anchor\nnew" });
  const conflicting = hit("conflicting", {
    text: "wrong\nnew", start: 1, source: "anchor\nnew",
  });
  const result = rendererPlan({ baselineHits: [anchor], candidateHits: [anchor, conflicting] });
  assert.equal(result.usedPacking, false);
  assert.deepEqual(result.rejected, [{ rank: 1, reason: "conflicting_source_lines" }]);
});

test("renderer-aware uses only the original chunk core of verified source context", () => {
  const anchor = hit("anchor", { text: "anchor", start: 1, path: "docs/a.md" });
  const donor = hit("donor", {
    text: "evidence", start: 3, source: "# Heading\n\nevidence",
    path: "docs/b.md",
  });
  Object.assign(donor.metadata.extras.corpuswire_display_lines, {
    mapping_kind: "source-context/v1", chunk_text_sha256: digest(donor.text),
    start_line: 1, end_line: 3, text: "# Heading\n\nevidence",
    text_sha256: digest("# Heading\n\nevidence"),
  });
  const result = rendererPlan({ baselineHits: [anchor], candidateHits: [anchor, donor] });
  assert.equal(result.usedPacking, true);
  assert.equal(result.hits[1].text, "evidence");
  assert.equal(result.hits[1].metadata.start_line, 3);
  assert.equal(result.hits[1].metadata.end_line, 3);
});

test("renderer-aware rejects a donor core outside its observed projection", () => {
  const anchor = hit("anchor", { text: "anchor", start: 1 });
  const donor = hit("donor", { text: "visible", start: 2, path: "src/donor.py" });
  donor.metadata.start_line = 1;
  donor.metadata.end_line = 2;
  const result = rendererPlan({ baselineHits: [anchor], candidateHits: [anchor, donor] });
  assert.equal(result.usedPacking, false);
  assert.deepEqual(result.rejected, [{ rank: 1, reason: "core_outside_projection" }]);
});

test("renderer-aware rejects uncertain control bytes and CRLF fail closed", () => {
  const anchor = hit("anchor", { text: "known", start: 1 });
  const mismatch = rendererPlan({
    baselineHits: [anchor], candidateHits: [anchor],
    deliveredRuns: [delivered(anchor, 1, "invented")],
  });
  assert.strictEqual(mismatch.hits[0], anchor);
  assert.equal(mismatch.reason, "delivered_run_mismatch");
  const crlf = hit("crlf", { text: "first\r\nsecond", start: 1 });
  const blocked = rendererPlan({ baselineHits: [crlf], candidateHits: [crlf] });
  assert.equal(blocked.reason, "crlf_unsupported");
  assert.strictEqual(blocked.hits[0], crlf);
});

test("renderer-aware uses UTF-16 characters and clamps Node maxChars", () => {
  const anchor = hit("anchor", { text: "control", start: 1 });
  const emojiLine = `evidence ${"😀".repeat(95)}`; // 199 UTF-16 code units.
  const donor = hit("donor", { text: emojiLine, start: 1, path: "src/donor.py" });
  const options = { baselineHits: [anchor], candidateHits: [anchor, donor] };
  const clamped = rendererPlan({ ...options, maxChars: 1 });
  assert.equal(clamped.usedPacking, false);
  assert.deepEqual(clamped.rejected, [{ rank: 1, reason: "no_fitting_core_line" }]);
  const above = rendererPlan({ ...options, maxChars: 12_001 });
  assert.equal(above.reason, "request_exceeds_treatment_budget");
  assert.strictEqual(above.hits, options.baselineHits);
});

test("renderer-aware keeps publication scope separate and requires a complete fence", () => {
  const anchor = fencedHit("anchor", { text: "anchor", start: 1, source: "anchor\ndonor" });
  const donor = fencedHit("donor", { text: "donor", start: 2, source: "anchor\ndonor" });
  const options = { baselineHits: [anchor], candidateHits: [anchor, donor] };
  assert.equal(rendererPlan(options).reason, "baseline_invalid_source_identity");
  const allowed = rendererPlan({ ...options, publicationFence: publicationFence() });
  assert.equal(allowed.usedPacking, true);
  donor.metadata.source_generation = 4;
  assert.equal(rendererPlan({ ...options, publicationFence: publicationFence() }).reason,
    "publication_generation_mismatch");
  const v2Anchor = hit("v2-anchor", { text: "anchor", start: 1 });
  const v2Donor = hit("v2-donor", {
    text: "donor", start: 2, source: "anchor\ndonor", indexScope: scope("snapshot-b"),
  });
  const mixed = rendererPlan({ baselineHits: [v2Anchor], candidateHits: [v2Anchor, v2Donor] });
  assert.deepEqual(mixed.rejected, [{ rank: 1, reason: "mixed_scope_mode" }]);
});

test("renderer-aware malformed fenced hits return the unchanged control", () => {
  const anchor = fencedHit("anchor", { text: "anchor", start: 1 });
  const broken = { chunk_id: "broken", text: "other" };
  const baselineHits = [anchor];
  const result = rendererPlan({
    baselineHits, candidateHits: [anchor, broken], publicationFence: publicationFence(),
  });
  assert.equal(result.reason, "invalid_hit_metadata");
  assert.strictEqual(result.hits, baselineHits);
  assert.strictEqual(result.fallbackHits, baselineHits);
});

test("renderer-aware enforces the window and contributor limits", () => {
  const anchor = hit("anchor", { text: "a", start: 1 });
  const donors = [1, 2, 3, 4, 5].map((number) => hit(`donor-${number}`, {
    text: `source-${number}`, start: 1, path: `src/${number}.py`,
  }));
  const limited = rendererPlan({
    baselineHits: [anchor], candidateHits: [anchor, ...donors], topK: 5,
  });
  assert.equal(limited.hits.length, 5);
  assert.deepEqual(limited.rejected, [{ rank: 5, reason: "window_budget" }]);
  const denseSource = Array.from({ length: 9 }, (_, index) => `line-${index + 1}`).join("\n");
  const dense = Array.from({ length: 9 }, (_, index) => hit(`dense-${index + 1}`, {
    text: `line-${index + 1}`, start: index + 1, source: denseSource,
  }));
  const capped = rendererPlan({ baselineHits: [dense[0]], candidateHits: dense });
  assert.equal(capped.hits[0].metadata.extras.evidence_bundle.contributing_chunk_ids.length, 2);
  assert.equal(capped.rejected.some((item) => item.reason === "source_cap"), true);
});

test("authenticated newline maps a real physical blank line without changing legacy output", () => {
  const input = newlineInput();
  const legacy = planRendererAwarePacking(input);
  assert.equal(legacy.reason, "delivered_run_mismatch");
  assert.strictEqual(legacy.hits, input.baselineHits);
  const proposal = planAuthenticatedNewlinePacking(input);
  assert.equal(proposal.usedPacking, true);
  assert.equal(proposal.hits.length, 1);
  const bundled = proposal.hits[0];
  assert.notEqual(bundled.chunk_id, input.baselineHits[0].chunk_id);
  assert.equal(bundled.text, "alpha");
  assert.equal(bundled.metadata.start_line, 1);
  assert.equal(bundled.metadata.end_line, 1);
  assert.deepEqual(bundled.metadata.extras.corpuswire_display_lines, {
    schema_version: "corpuswire-complete-source-lines/v1",
    source_hash: digest("alpha\n\nbeta"),
    start_line: 1, end_line: 2,
    text: "alpha\n", text_sha256: digest("alpha\n"),
    mapping_kind: "source-context/v1", chunk_text_sha256: digest("alpha"),
  });
  assert.strictEqual(proposal.fallbackHits, input.baselineHits);
  assert.equal(planAuthenticatedNewlinePacking(input).hits[0].chunk_id, bundled.chunk_id);
});

test("authenticated newline rejects an EOF phantom, wrong proof identity and malformed proofs", () => {
  const phantom = newlineInput({ source: "alpha\n", blankLines: [] });
  assert.equal(planAuthenticatedNewlinePacking(phantom).usedPacking, false);
  assert.strictEqual(planAuthenticatedNewlinePacking(phantom).hits, phantom.baselineHits);
  const valid = newlineInput();
  const wrongFence = structuredClone(valid);
  wrongFence.sourceProofs.publicationFence = structuredClone(valid.publicationFence);
  wrongFence.sourceProofs.publicationFence.publication_digest = "d".repeat(64);
  assert.equal(planAuthenticatedNewlinePacking(wrongFence).reason, "invalid_source_proofs");
  const wrongHash = structuredClone(valid);
  wrongHash.sourceProofs.records[0].sourceHash = digest("different");
  assert.equal(planAuthenticatedNewlinePacking(wrongHash).usedPacking, false);
  const duplicate = structuredClone(valid);
  duplicate.sourceProofs.records.push(structuredClone(duplicate.sourceProofs.records[0]));
  assert.equal(planAuthenticatedNewlinePacking(duplicate).reason, "duplicate_source_proof");
  const badLine = structuredClone(valid);
  badLine.sourceProofs.records[0].blankLfTerminatedLines = [3, 2];
  assert.equal(planAuthenticatedNewlinePacking(badLine).reason, "invalid_source_proofs");
});

test("authenticated newline is byte-identical to legacy for ordinary and rejected inputs", () => {
  const anchor = fencedHit("anchor", { text: "control", start: 1 });
  const donor = fencedHit("donor", { text: "evidence", start: 1, path: "src/donor.py" });
  const fence = publicationFence();
  const ordinary = {
    baselineHits: [anchor], candidateHits: [anchor, donor],
    deliveredRuns: [delivered(anchor)], query: "evidence", publicationFence: fence,
    sourceProofs: { publicationFence: fence, records: [] },
  };
  assert.deepEqual(planAuthenticatedNewlinePacking(ordinary), planRendererAwarePacking(ordinary));
  const badRun = { ...ordinary, deliveredRuns: [delivered(anchor, 1, "invented")] };
  assert.deepEqual(planAuthenticatedNewlinePacking(badRun), planRendererAwarePacking(badRun));
  const crlf = fencedHit("crlf", { text: "first\r\nsecond", start: 1 });
  const crlfInput = {
    ...ordinary, baselineHits: [crlf], candidateHits: [crlf],
    deliveredRuns: [delivered(crlf)],
  };
  assert.deepEqual(planAuthenticatedNewlinePacking(crlfInput), planRendererAwarePacking(crlfInput));
});
