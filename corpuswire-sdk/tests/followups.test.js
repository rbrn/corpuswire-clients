import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GitIgnoreMatcher,
  commitHistoryGitEnvironment,
  COMMIT_HISTORY_GIT_CONFIG,
  formatAbstentionHint,
  isCommitDocumentPath,
  isCommitPathExcluded,
  loadCommitHistoryDocuments,
  parseCommitLog,
  renderCommitDocument,
  retrievalAbstention,
} from "../dist/index.js";

// Built at runtime so no literal address sits in the source (server convention).
const FIXTURE_EMAIL_DOMAIN = ["example", "invalid"].join(".");

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("gitignore matcher agrees with every expectation in the shared server fixture", () => {
  const cases = fixture("gitignore_cases.json");
  assert.equal(cases.schema, "corpuswire.gitignore-cases/v1");
  let checks = 0;
  for (const testCase of cases.cases) {
    const matcher = GitIgnoreMatcher.fromSources(testCase.files);
    for (const check of testCase.checks) {
      assert.equal(
        matcher.isIgnored(check.path, { isDir: check.is_dir }),
        check.expected_ignored,
        `${testCase.name}: ${check.path} (is_dir=${check.is_dir})`,
      );
      checks += 1;
    }
  }
  assert.equal(cases.cases.length, 18);
  assert.equal(checks, 78);
});

// Expectations checked with git check-ignore --no-index.
test("gitignore matcher handles escapes, classes and unreadable files", () => {
  const matcher = GitIgnoreMatcher.fromSources({
    ".gitignore": "trailing\\ \nspaced   \n[!a]x.md\n[]]y.md\nfoo**bar\n/**/deep.md\nunterminated[\n",
  });
  assert.equal(matcher.isIgnored("trailing "), true);
  assert.equal(matcher.isIgnored("spaced"), true);
  assert.equal(matcher.isIgnored("bx.md"), true);
  assert.equal(matcher.isIgnored("ax.md"), false);
  assert.equal(matcher.isIgnored("]y.md"), true);
  assert.equal(matcher.isIgnored("fooXbar"), true);
  assert.equal(matcher.isIgnored("foo/bar"), false);
  assert.equal(matcher.isIgnored("a/b/deep.md"), true);
  assert.equal(matcher.isIgnored("unterminated["), false);
  const throwing = new GitIgnoreMatcher(() => { throw new Error("EACCES"); });
  assert.equal(throwing.isIgnored("anything.md"), false);
});

test("commit documents match the server rendering byte for byte", async () => {
  const cases = fixture("commit_history_cases.json");
  const records = parseCommitLog(cases.raw_log.replaceAll("{{FIXTURE_EMAIL_DOMAIN}}", FIXTURE_EMAIL_DOMAIN), new Set(cases.shallow));
  assert.deepEqual(records.map((record) => record.sha), cases.documents.map((document) => document.sha));
  for (const [index, expected] of cases.documents.entries()) {
    const record = records[index];
    assert.equal(record.files.some((stat) => isCommitPathExcluded(stat.path)), expected.excluded, expected.sha);
    const document = await renderCommitDocument(record);
    assert.equal(document.relativePath, expected.relative_path);
    assert.equal(document.text, expected.text, expected.sha);
    assert.equal(document.sha256, expected.source_hash);
  }
  for (const pathCase of cases.path_cases) {
    assert.equal(isCommitPathExcluded(pathCase.path), pathCase.excluded, pathCase.path);
  }
});

function makeRunner(root) {
  return async (args) => {
    try {
      return execFileSync("git", [...COMMIT_HISTORY_GIT_CONFIG, ...args], {
        cwd: root, env: commitHistoryGitEnvironment(process.env), stdio: ["ignore", "pipe", "ignore"],
      }).toString("utf8");
    } catch {
      return null;
    }
  };
}

test("loadCommitHistoryDocuments reads a real repository with skips, caps and gitignore", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "cw-commit-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd: root, stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture Author", GIT_AUTHOR_EMAIL: `fixture@${FIXTURE_EMAIL_DOMAIN}`,
      GIT_COMMITTER_NAME: "Fixture Author", GIT_COMMITTER_EMAIL: `fixture@${FIXTURE_EMAIL_DOMAIN}`,
      GIT_AUTHOR_DATE: "2026-10-01T10:00:00+00:00", GIT_COMMITTER_DATE: "2026-10-01T10:00:00+00:00" },
  });
  git("init", "-q");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "app.py"), "print(1)\n");
  git("add", ".");
  git("commit", "-q", "-m", `Add app\n\nSigned-off-by: Fixture Author <fixture@${FIXTURE_EMAIL_DOMAIN}>`);
  writeFileSync(path.join(root, ".env"), "SECRET=1\n");
  git("add", "-f", ".env");
  git("commit", "-q", "-m", "Touch env");
  mkdirSync(path.join(root, "logs"));
  writeFileSync(path.join(root, "logs", "a.txt"), "x\n");
  git("add", "-f", "logs/a.txt");
  git("commit", "-q", "-m", "Add log");

  const now = new Date("2026-10-18T00:00:00Z");
  const runGit = makeRunner(root);
  const documents = await loadCommitHistoryDocuments({ runGit, now });
  assert.deepEqual(documents.map((document) => document.text.split("\n")[0].replace(/^# Commit [0-9a-f]{12}: /, "")), ["Add log", "Add app"]);
  for (const document of documents) {
    assert.ok(isCommitDocumentPath(document.relativePath));
    assert.ok(!document.text.includes(`@${FIXTURE_EMAIL_DOMAIN}`));
    assert.equal(document.mtimeNs, Date.parse("2026-10-01T10:00:00Z") * 1_000_000);
  }
  assert.match(documents[1].text, /Signed-off-by: Fixture Author\n/);
  assert.match(documents[1].text, /- `src\/app.py` \(\+1 -0\)/);

  const ignored = await loadCommitHistoryDocuments({
    runGit, now, gitignore: GitIgnoreMatcher.fromSources({ ".gitignore": "logs/\n" }),
  });
  assert.deepEqual(ignored.map((document) => document.text.split("\n")[0].endsWith("Add app")), [true]);
  assert.equal((await loadCommitHistoryDocuments({ runGit, now, maxCommits: 1 })).length, 1);
  assert.equal((await loadCommitHistoryDocuments({ runGit, now, maxCommits: 0 })).length, 0);
  assert.equal((await loadCommitHistoryDocuments({ runGit, now, sinceDays: 1 })).length, 0);
  assert.equal((await loadCommitHistoryDocuments({ runGit, now: new Date("2026-10-18T00:00:00Z"), maxCommits: 99_999 })).length, 2);

  const outside = mkdtempSync(path.join(tmpdir(), "cw-not-a-repo-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.deepEqual(await loadCommitHistoryDocuments({ runGit: makeRunner(outside), now }), []);
  assert.deepEqual(await loadCommitHistoryDocuments({ runGit: async () => { throw new Error("spawn git ENOENT"); }, now }), []);
});

test("abstention helpers stay silent unless retrieval_abstained is exactly true", () => {
  assert.equal(formatAbstentionHint(undefined), null);
  assert.equal(formatAbstentionHint({}), null);
  assert.equal(formatAbstentionHint({ retrieval_abstained: false, retrieval_closest_paths: ["a.py"] }), null);
  assert.equal(formatAbstentionHint({ retrieval_abstained: "true" }), null);
  assert.equal(
    formatAbstentionHint({ retrieval_abstained: true, retrieval_closest_paths: ["src/a.py", "docs/b.md"] }),
    "Not found in the index; closest files, not confirmed: src/a.py, docs/b.md.",
  );
  assert.equal(
    formatAbstentionHint({ retrieval_abstained: true, retrieval_closest_paths: ["src/a.py"] }, { quotePaths: true }),
    "Not found in the index; closest files, not confirmed: `src/a.py`.",
  );
  assert.equal(formatAbstentionHint({ retrieval_abstained: true }), "Not found in the index; closest files, not confirmed: none.");
  assert.deepEqual(retrievalAbstention({ retrieval_abstained: true, retrieval_closest_paths: ["a\nb", 3, "a\nb", ""] }), { closestPaths: ["a b"] });
});
