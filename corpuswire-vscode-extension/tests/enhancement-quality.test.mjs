import assert from "node:assert/strict";
import test from "node:test";

import { assessEnhancementQuality } from "../dist/enhancement-quality.js";

function result(overrides = {}) {
  return {
    retrieved_chunks: [{ chunk_id: "one" }],
    citations: ["src/example.ts#function-run"],
    retrieval_warning: null,
    retrieval_confidence: 0.72,
    retrieval_not_found: false,
    ...overrides,
  };
}

test("reports a cited retrieval result as grounded", () => {
  const quality = assessEnhancementQuality(result());

  assert.equal(quality.status, "grounded");
  assert.match(quality.message, /Grounded in 1 workspace chunk/);
  assert.match(quality.message, /72% confidence/);
});

test("does not present stale retrieval as successful", () => {
  const quality = assessEnhancementQuality(result({
    retrieval_warning: "Index freshness is unknown because the pre-read sync timed out.",
  }));

  assert.equal(quality.status, "degraded");
  assert.match(quality.message, /pre-read sync timed out/);
  assert.match(quality.message, /reconcile the index/i);
});

test("reports a context-free rewrite as ungrounded", () => {
  const quality = assessEnhancementQuality(result({
    retrieved_chunks: [],
    citations: [],
    retrieval_not_found: true,
  }));

  assert.equal(quality.status, "ungrounded");
  assert.match(quality.message, /No workspace context was found/);
});

test("reports low-confidence or uncited results as degraded", () => {
  const quality = assessEnhancementQuality(result({
    citations: [],
    retrieval_confidence: 0.21,
  }));

  assert.equal(quality.status, "degraded");
  assert.match(quality.message, /21%/);
  assert.match(quality.message, /no source citations/);
});
