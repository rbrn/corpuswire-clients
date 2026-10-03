import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { planSelectedUnitCompletion } from "../lib/selected-unit-completion.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
function plan(text, runs, query = "Where is the billing token validated?") {
  return planSelectedUnitCompletion({
    sources: [{ sourceId: "docs/example.md", sourceHash: sha(text), text }],
    selectedRuns: runs.map(([startLine, endLine]) => ({ sourceId: "docs/example.md", startLine, endLine })),
    query,
  });
}

test("a leaf section beyond the 20-line padding radius is complete and keeps core identities", () => {
  const text = ["# Billing token", ...Array.from({ length: 50 }, (_, i) =>
    i === 25 ? "The token is validated by the gateway." : `Detail ${i}.`), "# Other"].join("\n");
  const result = plan(text, [[27, 27]]);
  assert.equal(result.units.length, 1);
  assert.deepEqual([result.units[0].startLine, result.units[0].endLine], [1, 51]);
  assert.equal(result.units[0].coreLineKeys[0], `docs/example.md:${sha(text)}:27`);
  assert.ok(27 - 1 > 20);
});

test("heading-like text inside a fence does not split the containing section", () => {
  const text = ["# Billing token", "Intro", "```md", "# Fake heading", "token validated", "```", "After fence", "# Next"].join("\n");
  const result = plan(text, [[7, 7]]);
  assert.equal(result.units[0]?.kind, "atx-leaf");
  assert.equal(result.units[0]?.endLine, 7);
});

test("fenced block is proposed with both delimiters and a containing heading", () => {
  const text = ["# Billing token", "Intro", "```js", "const token = validated();", "```", "# Next"].join("\n");
  const result = plan(text, [[4, 4]]);
  assert.equal(result.units[0]?.kind, "fenced-block");
  assert.deepEqual([result.units[0].startLine, result.units[0].endLine], [3, 5]);
});

test("nested parent heading is not offered as a leaf", () => {
  const text = ["# Billing token", "Parent", "## Validation", "The token is validated.", "## Other"].join("\n");
  const result = plan(text, [[4, 4]], "How is validation token handled?");
  assert.deepEqual([result.units[0]?.startLine, result.units[0]?.endLine], [3, 4]);
});

test("unclosed fence and Setext or HTML uncertainty abstain", () => {
  assert.equal(plan("# Billing token\n```\ntoken validated", [[3, 3]]).units.length, 0);
  assert.equal(plan("# Billing token\nTitle\n-----\ntoken validated", [[4, 4]]).units.length, 0);
  assert.equal(plan("# Billing token\n<div>\ntoken validated", [[3, 3]]).units.length, 0);
});

test("renamed terms must be witnessed in heading and selected body", () => {
  const text = "# Billing token\nThe credential is checked.\nMore detail";
  assert.equal(plan(text, [[2, 2]], "Where is the invoice secret checked?").units.length, 0);
  assert.equal(plan(text, [[2, 2]], "Where is the billing token checked?").units.length, 1);
});

test("line and character caps reject oversized units", () => {
  const longLines = ["# Billing token", ...Array(160).fill("token validated")].join("\n");
  assert.equal(plan(longLines, [[2, 2]]).units.length, 0);
  const longChars = "# Billing token\n" + "token validated ".repeat(510);
  assert.equal(plan(longChars, [[2, 2]]).units.length, 0);
});

test("duplicate windows coalesce and already complete core is skipped", () => {
  const text = "# Billing token\nThe token is validated.\nMore detail\n# Other";
  const duplicate = plan(text, [[2, 2], [3, 3], [2, 2]]);
  assert.equal(duplicate.units.length, 1);
  assert.deepEqual(duplicate.units[0].coreLineKeys.length, 2);
  assert.equal(plan(text, [[1, 3]]).units.length, 0);
});

test("source hash and run bounds are checked before proposals", () => {
  const text = "# Billing token\nThe token is validated.\nMore detail";
  const input = { sources: [{ sourceId: "docs/example.md", sourceHash: sha("wrong"), text }],
    selectedRuns: [{ sourceId: "docs/example.md", startLine: 2, endLine: 2 }],
    query: "billing token" };
  assert.equal(planSelectedUnitCompletion(input).reason, "source_mismatch");
  assert.equal(plan(text, [[2, 99]]).units.length, 0);
});
