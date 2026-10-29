import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifyCommitFreshness,
  formatCommitFreshnessLine,
  parseGitDiffNameStatusZ,
} from "../lib/commit-freshness.mjs";

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), "cw-commit-freshness-"));
  const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.invalid");
  run("config", "user.name", "test");
  const commit = (message) => {
    run("add", "-A");
    run("commit", "-q", "-m", message);
    return run("rev-parse", "HEAD");
  };
  const git = async (args) => {
    try {
      return { ok: true, stdout: run(...args) };
    } catch {
      return { ok: false, stdout: "" };
    }
  };
  return { root, run, commit, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("parses modified, added, deleted and renamed paths", () => {
  const output = ["M", "src/a.py", "A", "src/b.py", "D", "src/c.py", "R087", "old/d.py", "new/d.py", ""].join("\0");
  assert.deepEqual(parseGitDiffNameStatusZ(output), {
    changedPaths: ["new/d.py", "src/a.py", "src/b.py"],
    deletedPaths: ["old/d.py", "src/c.py"],
  });
  assert.deepEqual(parseGitDiffNameStatusZ(""), { changedPaths: [], deletedPaths: [] });
});

test("classifies fresh, behind, diverged and unknown", async () => {
  const r = repo();
  try {
    writeFileSync(path.join(r.root, "a.txt"), "1");
    writeFileSync(path.join(r.root, "b.txt"), "1");
    const first = r.commit("first");

    assert.equal((await classifyCommitFreshness({ git: r.git, indexedCommit: first, head: first })).state, "fresh");
    assert.deepEqual(
      await classifyCommitFreshness({ git: r.git, indexedCommit: undefined, head: first }),
      { state: "unknown", reason: "index_has_no_commit", head: first },
    );
    assert.equal(
      (await classifyCommitFreshness({ git: r.git, indexedCommit: first, head: null })).reason,
      "not_a_git_repository",
    );

    writeFileSync(path.join(r.root, "a.txt"), "2");
    renameSync(path.join(r.root, "b.txt"), path.join(r.root, "c.txt"));
    r.commit("second");
    writeFileSync(path.join(r.root, "d.txt"), "1");
    const third = r.commit("third");

    const behind = await classifyCommitFreshness({ git: r.git, indexedCommit: first, head: third });
    assert.equal(behind.state, "behind");
    assert.equal(behind.behindCommits, 2);
    assert.deepEqual(behind.changedPaths, ["a.txt", "c.txt", "d.txt"]);
    assert.deepEqual(behind.deletedPaths, ["b.txt"]);

    r.run("checkout", "-q", "-b", "other", first);
    writeFileSync(path.join(r.root, "e.txt"), "1");
    const other = r.commit("other");
    const diverged = await classifyCommitFreshness({ git: r.git, indexedCommit: third, head: other });
    assert.equal(diverged.state, "diverged");

    const missing = await classifyCommitFreshness({ git: r.git, indexedCommit: "f".repeat(40), head: other });
    assert.equal(missing.reason, "indexed_commit_not_in_clone");
  } finally {
    r.cleanup();
  }
});

test("formats one line, with the snapshot note only for a published v2 read", () => {
  assert.equal(formatCommitFreshnessLine(null), null);
  const behind = {
    state: "behind", indexedCommit: "a".repeat(40), head: "b".repeat(40),
    behindCommits: 3, changedPaths: ["x"], deletedPaths: ["y"], sync: "started",
  };
  const line = formatCommitFreshnessLine(behind);
  assert.match(line, /^- indexFreshness: behind by 3 commit\(s\), 2 file\(s\)/);
  assert.match(line, /sync started$/);
  assert.match(formatCommitFreshnessLine(behind, { readSnapshot: true }), /published snapshot/);
  assert.match(
    formatCommitFreshnessLine({ state: "unknown", reason: "index_has_no_commit" }),
    /unknown \(index_has_no_commit\)/,
  );
});
