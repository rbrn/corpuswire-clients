import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalCoalescingDeliveryComplete, planSourceRootCoalescing } from "../lib/source-root-coalescing.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const fence = {
  schema_version: "rqt110-frozen-publication-fence/v1",
  tenant_id: "tenant", served_workspace_id: "workspace",
  storage_workspace_id: "storage", collection: "collection",
  manifest_revision: 1, repository_id: "repo",
  source_snapshot_digest: "a".repeat(64), publication_digest: "b".repeat(64),
  generation: 1, overlay_id: null,
};

function fixture() {
  const text = Array.from({ length: 8 }, (_, index) => `source line ${index + 1}`).join("\n") + "\n";
  const hash = sha256(text);
  const hit = (chunkId, start, end) => ({
    chunk_id: chunkId, text: text.split("\n").slice(start - 1, end).join("\n"), score: 1,
    metadata: {
      source_path: "src/source.ts", source_hash: hash, source_generation: 1,
      start_line: start, end_line: end, extras: {}, index_scope: null,
    },
  });
  const first = hit("first", 3, 5);
  const second = hit("second", 5, 7);
  return {
    baselineHits: [first, second],
    deliveredRuns: [
      { chunkId: "first", startLine: 3, endLine: 5, text: first.text },
      { chunkId: "second", startLine: 5, endLine: 7, text: second.text },
    ],
    sourceRecords: [{ path: "src/source.ts", sourceHash: hash, text }],
    publicationFence: fence, topK: 5, maxChars: 12_000, maxRadius: 2,
  };
}

test("merges only exact overlapping delivered lines, then fills bounded neighbors", () => {
  const input = fixture();
  const proposal = planSourceRootCoalescing(input);
  assert.equal(proposal.usedPacking, true);
  assert.equal(proposal.hits.length, 1);
  assert.equal(proposal.hits[0].metadata.start_line, 1);
  assert.equal(proposal.hits[0].metadata.end_line, 8);
  assert.deepEqual(proposal.hits[0].metadata.extras.evidence_bundle.contributing_chunk_ids,
    ["first", "second"]);
  assert.ok(proposal.hits[0].chunk_id.startsWith("bundle:"));
  assert.equal(proposal.hits[0].metadata.extras.corpuswire_display_lines.text_sha256,
    sha256(proposal.hits[0].text));
  assert.equal(proposal.hits[0].text, input.sourceRecords[0].text.trimEnd());
  assert.equal(proposal.excerptChars, proposal.hits[0].text.length);
  assert.equal(proposal.addedLineCount, 3);
});

test("a marked partial line cannot seed complete-line source coalescing", () => {
  const input = fixture();
  input.baselineHits[0].metadata.extras.corpuswire_partial_source_line = {
    schema_version: "v1", source_line: 3, start_char: 28, end_char: 34,
    text_sha256: sha256("source"), line_sha256: sha256("source line 3"),
  };
  const result = planSourceRootCoalescing(input);
  assert.equal(result.usedPacking, false);
  assert.equal(result.reason, "selected_identity_invalid");
});

test("fails closed on source, publication, delivered-byte, scope, and budget drift", () => {
  const input = fixture();
  const changed = structuredClone(input);
  changed.sourceRecords[0].text += "tampered";
  assert.equal(planSourceRootCoalescing(changed).reason, "source_proof_invalid");

  const publication = structuredClone(input);
  publication.baselineHits[0].metadata.publication_digest = "0".repeat(64);
  assert.equal(planSourceRootCoalescing(publication).reason, "selected_identity_invalid");

  const delivered = structuredClone(input);
  delivered.deliveredRuns[0].text = "wrong line";
  assert.equal(planSourceRootCoalescing(delivered).reason, "delivered_source_mismatch");

  const scope = structuredClone(input);
  scope.baselineHits[0].metadata.index_scope = { repository_id: "other" };
  assert.equal(planSourceRootCoalescing(scope).reason, "selected_identity_invalid");

  const budget = structuredClone(input);
  budget.maxChars = 199;
  assert.equal(planSourceRootCoalescing(budget).reason, "invalid_input_or_fence");
});

test("disjoint windows and CRLF source remain unchanged", () => {
  const disjoint = fixture();
  disjoint.baselineHits[1].metadata.start_line = 8;
  disjoint.baselineHits[1].metadata.end_line = 8;
  disjoint.deliveredRuns[1] = { chunkId: "second", startLine: 8, endLine: 8, text: "source line 8" };
  assert.equal(planSourceRootCoalescing(disjoint).reason, "no_same_source_merge");

  const crlf = fixture();
  crlf.sourceRecords[0].text = crlf.sourceRecords[0].text.replaceAll("\n", "\r\n");
  crlf.sourceRecords[0].sourceHash = sha256(crlf.sourceRecords[0].text);
  for (const hit of crlf.baselineHits) hit.metadata.source_hash = crlf.sourceRecords[0].sourceHash;
  assert.equal(planSourceRootCoalescing(crlf).reason, "source_encoding_unsupported");
});

test("a source-authenticated terminal blank line has a truthful mapping", () => {
  const input = fixture();
  input.sourceRecords[0].text = "first\nsecond\nthird\n\n";
  input.sourceRecords[0].sourceHash = sha256(input.sourceRecords[0].text);
  for (const hit of input.baselineHits) hit.metadata.source_hash = input.sourceRecords[0].sourceHash;
  input.deliveredRuns = [
    { chunkId: "first", startLine: 1, endLine: 2, text: "first\nsecond" },
    { chunkId: "second", startLine: 2, endLine: 4, text: "second\nthird\n" },
  ];
  const result = planSourceRootCoalescing(input);
  assert.equal(result.usedPacking, true);
  assert.equal(result.hits.length, 1);
  const hit = result.hits[0];
  assert.equal(hit.metadata.start_line, 1);
  assert.equal(hit.metadata.end_line, 3);
  assert.equal(hit.metadata.extras.corpuswire_display_lines.end_line, 4);
  assert.equal(hit.metadata.extras.corpuswire_display_lines.mapping_kind, "source-context/v1");
  assert.equal(hit.metadata.extras.corpuswire_display_lines.chunk_text_sha256, sha256(hit.text));
});

test("per-file mode completes one selected short source without claiming publication identity", () => {
  const input = fixture();
  input.proofMode = "per-file-source/v1";
  input.publicationFence = null;
  input.maxRadius = 0;
  const proposal = planSourceRootCoalescing(input);
  assert.equal(proposal.usedPacking, true);
  assert.equal(proposal.hits.length, 1);
  assert.equal(proposal.hits[0].metadata.start_line, 1);
  assert.equal(proposal.hits[0].metadata.end_line, 8);
  assert.equal(proposal.hits[0].text, input.sourceRecords[0].text.trimEnd());
  assert.equal(proposal.hits[0].metadata.publication_digest, undefined);
  assert.equal(proposal.hits[0].metadata.source_hash, input.sourceRecords[0].sourceHash);

  const inventedFence = structuredClone(input);
  inventedFence.publicationFence = fence;
  assert.equal(planSourceRootCoalescing(inventedFence).reason, "invalid_input_or_fence");
  const missingHash = structuredClone(input);
  delete missingHash.baselineHits[0].metadata.source_hash;
  assert.equal(planSourceRootCoalescing(missingHash).reason, "selected_identity_invalid");
  const mixedGeneration = structuredClone(input);
  mixedGeneration.baselineHits[1].metadata.source_generation = 2;
  assert.equal(planSourceRootCoalescing(mixedGeneration).reason, "selected_identity_invalid");
});

test("canonical coalescing gate rejects clipping of only newly added source lines", () => {
  const proposal = { usedPacking: true, hits: [{ chunk_id: "full" }], excerptChars: 80 };
  const observed = [{ formatted: { truncated: false } }];
  const delivered = { runs: [{ chunkId: "full" }], excerptChars: 80 };
  assert.equal(canonicalCoalescingDeliveryComplete(proposal, observed, delivered), true);
  assert.equal(canonicalCoalescingDeliveryComplete(proposal,
    [{ formatted: { truncated: true } }], delivered), false);
  assert.equal(canonicalCoalescingDeliveryComplete(proposal, observed,
    { runs: delivered.runs, excerptChars: 65 }), false);
  assert.equal(canonicalCoalescingDeliveryComplete(proposal, [], delivered), false);
});
