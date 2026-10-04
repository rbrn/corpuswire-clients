import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { planAuthenticatedNewlinePacking } from "../lib/source-packing-prototype.mjs";
import { planSourceRootCoalescing } from "../lib/source-root-coalescing.mjs";

const fixturePath = "/private/tmp/rqt-112-fivecase-20260929/source-packing-two-case.private.json";
const fixtureSha256 = "18a109282ae817b46a1dee3f0b08b8da6898e74a29f8d425b4583e70b37f9e71";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const privateFixtureAvailable = fs.existsSync(fixturePath);

function physicalLines(source) {
  const lines = source.split("\n");
  if (source.endsWith("\n")) lines.pop();
  return lines;
}

function sourceForCase(item, sourcePath, sourceHash) {
  assert.match(sourcePath, /^[^\\/][^\\]*$/);
  assert.ok(!sourcePath.split("/").some((part) => !part || part === "." || part === ".."));
  const root = fs.realpathSync(item.sourceRoot);
  const file = fs.realpathSync(path.join(root, sourcePath));
  assert.ok(file.startsWith(`${root}${path.sep}`));
  const bytes = fs.readFileSync(file);
  assert.equal(sha256(bytes), sourceHash);
  return physicalLines(bytes.toString("utf8"));
}

function exactSourceRange(item, sourcePath, sourceHash, start, end, text) {
  const lines = sourceForCase(item, sourcePath, sourceHash);
  assert.ok(Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end <= lines.length);
  assert.ok(text === lines.slice(start - 1, end).join("\n"), "source range mismatch");
}

function verifyHit(item, hit) {
  const metadata = hit.metadata;
  const display = metadata.extras?.corpuswire_display_lines;
  assert.ok(display);
  assert.equal(display.source_hash, metadata.source_hash);
  assert.equal(sha256(Buffer.from(display.text, "utf8")), display.text_sha256);
  exactSourceRange(item, metadata.source_path, metadata.source_hash,
    display.start_line, display.end_line, display.text);
}

function verifyFixtureCase(item) {
  assert.equal(item.sourceSnapshotId, item.publicationFence.source_snapshot_digest);
  assert.equal(item.publicationDigest, item.publicationFence.publication_digest);
  assert.equal(item.sourceProofs.publicationFence.publication_digest, item.publicationDigest);
  assert.equal(item.baselineHits.length, 5);
  assert.equal(item.candidateHits.length, 32);
  for (const hit of [...item.baselineHits, ...item.candidateHits]) verifyHit(item, hit);
  const byId = new Map(item.baselineHits.map((hit) => [hit.chunk_id, hit]));
  for (const runs of Object.values(item.deliveredRuns)) {
    for (const run of runs) {
      const selected = byId.get(run.chunkId);
      assert.ok(selected);
      exactSourceRange(item, selected.metadata.source_path, selected.metadata.source_hash,
        run.startLine, run.endLine, run.text);
    }
  }
  for (const proof of item.sourceProofs.records) {
    const lines = sourceForCase(item, proof.path, proof.sourceHash);
    assert.equal(lines.length, proof.physicalLineCount);
  }
}

function spanCovered(hits, alternative, span) {
  const ranges = hits.filter((hit) => hit.metadata.source_path === alternative.source_path
    && hit.metadata.source_hash === alternative.source_hash)
    .map((hit) => [hit.metadata.start_line, hit.metadata.end_line])
    .sort((left, right) => left[0] - right[0]);
  let remaining = span.start;
  for (const [first, last] of ranges) {
    if (first > remaining) return false;
    if (last >= remaining) remaining = last + 1;
    if (remaining > span.end) return true;
  }
  return false;
}

function completeGroups(hits, groups) {
  return groups.filter((group) => group.alternatives.some((alternative) =>
    alternative.spans.every((span) => spanCovered(hits, alternative, span)))).length;
}

test("private RQT-112 packing replay: frozen source and saved host parity", {
  skip: !privateFixtureAvailable && "private fixture is not installed",
}, () => {
  const bytes = fs.readFileSync(fixturePath);
  assert.equal(sha256(bytes), fixtureSha256);
  const fixture = JSON.parse(bytes.toString("utf8"));
  assert.equal(fixture.schema_version, "rqt112-source-packing-private/v1");
  assert.deepEqual(fixture.input_sha256, {
    manifest: "59cb68e8f4e806d2424c32f10b15e532071de792d13d063f68d386b79e44c0d6",
    trace: "4a617193b4bd0cd4abeffb663246eec2eaa83d624a430dd900803b9e91582262",
    cases: "d3340693c77165c44bd97debcc4fa7ebad75beac980c7de6414058fa8f38b089",
  });
  assert.deepEqual(fixture.cases.map((item) => item.case_id), [
    "sv2-auggie-file-filter-priority", "rqt-continuation24-092",
  ]);
  for (const item of fixture.cases) {
    verifyFixtureCase(item);
    for (const arm of ["rootless", "root-enabled"]) {
      const proposal = planAuthenticatedNewlinePacking({
        baselineHits: item.baselineHits,
        candidateHits: item.candidateHits,
        deliveredRuns: item.deliveredRuns[arm],
        query: item.query,
        topK: 5,
        maxChars: 12_000,
        publicationFence: item.publicationFence,
        sourceProofs: item.sourceProofs,
      });
      assert.ok(proposal.hits.length <= 5);
      for (const hit of proposal.hits) verifyHit(item, hit);
      if (proposal.usedPacking) assert.ok(proposal.excerptChars <= 12_000);
      const groups = completeGroups(proposal.hits, item.requiredEvidenceGroups);
      if (item.case_id === "sv2-auggie-file-filter-priority") {
        assert.equal(groups, 1);
        assert.equal(arm === "root-enabled" ? proposal.reason : proposal.usedPacking,
          arm === "root-enabled" ? "delivered_run_outside_projection" : true);
      } else {
        assert.equal(groups, 0);
        assert.equal(proposal.usedPacking, true);
      }
    }
  }
});

test("private packing replay rejects a mismatched publication fence", {
  skip: !privateFixtureAvailable && "private fixture is not installed",
}, () => {
  const bytes = fs.readFileSync(fixturePath);
  assert.equal(sha256(bytes), fixtureSha256);
  const item = JSON.parse(bytes.toString("utf8")).cases[0];
  const altered = structuredClone(item.publicationFence);
  altered.publication_digest = "0".repeat(64);
  const proposal = planAuthenticatedNewlinePacking({
    baselineHits: item.baselineHits, candidateHits: item.candidateHits,
    deliveredRuns: item.deliveredRuns.rootless, query: item.query,
    topK: 5, maxChars: 12_000,
    publicationFence: altered, sourceProofs: item.sourceProofs,
  });
  assert.equal(proposal.usedPacking, false);
  assert.equal(proposal.reason, "invalid_source_proofs");
});

test("private file-filter source-root coalescing fits complete metadata spans", {
  skip: !privateFixtureAvailable && "private fixture is not installed",
}, () => {
  const bytes = fs.readFileSync(fixturePath);
  assert.equal(sha256(bytes), fixtureSha256);
  const item = JSON.parse(bytes.toString("utf8")).cases[0];
  verifyFixtureCase(item);
  const uniqueSources = new Map(item.baselineHits.map((hit) => [
    hit.metadata.source_path, hit.metadata.source_hash,
  ]));
  const sourceRecords = [...uniqueSources].map(([sourcePath, sourceHash]) => {
    sourceForCase(item, sourcePath, sourceHash);
    return {
      path: sourcePath, sourceHash,
      text: fs.readFileSync(path.join(item.sourceRoot, sourcePath), "utf8"),
    };
  });
  const proposal = planSourceRootCoalescing({
    baselineHits: item.baselineHits,
    deliveredRuns: item.deliveredRuns["root-enabled"],
    sourceRecords,
    publicationFence: item.publicationFence,
    topK: 5, maxChars: 12_000, maxRadius: 20,
  });
  assert.equal(proposal.usedPacking, true);
  assert.ok(proposal.hits.length <= 5);
  assert.ok(proposal.excerptChars <= 12_000);
  for (const hit of proposal.hits) verifyHit(item, hit);
  assert.equal(completeGroups(proposal.hits, item.requiredEvidenceGroups), 3);
  const driftedSources = structuredClone(sourceRecords);
  driftedSources[0].text += "changed";
  const drift = planSourceRootCoalescing({
    baselineHits: item.baselineHits,
    deliveredRuns: item.deliveredRuns["root-enabled"],
    sourceRecords: driftedSources,
    publicationFence: item.publicationFence,
    topK: 5, maxChars: 12_000, maxRadius: 20,
  });
  assert.equal(drift.usedPacking, false);
  assert.equal(drift.reason, "source_proof_invalid");
  for (const originalRun of item.deliveredRuns["root-enabled"]) {
    const original = item.baselineHits.find((hit) => hit.chunk_id === originalRun.chunkId);
    assert.ok(original);
    const preserved = proposal.hits.some((hit) =>
      hit.metadata.source_path === original.metadata.source_path
      && hit.metadata.source_hash === original.metadata.source_hash
      && hit.metadata.extras.corpuswire_display_lines.start_line <= originalRun.startLine
      && hit.metadata.extras.corpuswire_display_lines.end_line >= originalRun.endLine);
    assert.ok(preserved, "source-authenticated control line range lost");
  }
});

test("private file-filter per-file completion has no publication-fence dependency", {
  skip: !privateFixtureAvailable && "private fixture is not installed",
}, () => {
  const bytes = fs.readFileSync(fixturePath);
  assert.equal(sha256(bytes), fixtureSha256);
  const item = JSON.parse(bytes.toString("utf8")).cases[0];
  verifyFixtureCase(item);
  const uniqueSources = new Map(item.baselineHits.map((hit) => [
    hit.metadata.source_path, hit.metadata.source_hash,
  ]));
  const sourceRecords = [...uniqueSources].map(([sourcePath, sourceHash]) => ({
    path: sourcePath, sourceHash,
    text: fs.readFileSync(path.join(item.sourceRoot, sourcePath), "utf8"),
  }));
  const result = planSourceRootCoalescing({
    proofMode: "per-file-source/v1", publicationFence: null,
    baselineHits: item.baselineHits,
    deliveredRuns: item.deliveredRuns["root-enabled"],
    sourceRecords, topK: 5, maxChars: 12_000, maxRadius: 20,
  });
  assert.equal(result.usedPacking, true);
  assert.equal(completeGroups(result.hits, item.requiredEvidenceGroups), 3);
  assert.ok(result.hits.length <= 5);
  assert.ok(result.excerptChars <= 12_000);
  for (const hit of result.hits) verifyHit(item, hit);
});
