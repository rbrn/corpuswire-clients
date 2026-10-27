// CORPUSWIRE_SYNC_READ_COMMIT_CHECK (CRP-004 idea 3): compare the commit the
// server says it indexed with the local HEAD after each read, and, in "sync"
// mode, sync the files committed since then. Pure helpers; the MCP server
// supplies the git runner and the sync call.

export const COMMIT_CHECK_MODES = new Set(["off", "warn", "sync"]);

/**
 * Parse `git diff --name-status -z -M <a> <b>` into changed and deleted paths.
 * A rename deletes its old path and changes its new one.
 */
export function parseGitDiffNameStatusZ(output) {
  const changed = new Set();
  const deleted = new Set();
  const fields = (output ?? "").split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (!status) continue;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const oldPath = fields[index + 1];
      const newPath = fields[index + 2];
      index += 2;
      if (newPath) changed.add(newPath);
      if (kind === "R" && oldPath) deleted.add(oldPath);
      continue;
    }
    const filePath = fields[index + 1];
    index += 1;
    if (!filePath) continue;
    if (kind === "D") deleted.add(filePath);
    else changed.add(filePath);
  }
  for (const filePath of deleted) changed.delete(filePath);
  return { changedPaths: [...changed].sort(), deletedPaths: [...deleted].sort() };
}

/**
 * Classify the index against HEAD. `git(args)` resolves to
 * `{ ok, stdout }` and never throws.
 *
 * States: fresh (same commit), behind (indexed commit is an ancestor of
 * HEAD), diverged (it is not, e.g. after a rebase or branch switch), unknown
 * (no commit on either side, or the indexed commit is not in this clone).
 */
export async function classifyCommitFreshness({ git, indexedCommit, head }) {
  if (!head) return { state: "unknown", reason: "not_a_git_repository" };
  if (!indexedCommit) return { state: "unknown", reason: "index_has_no_commit", head };
  if (indexedCommit === head) return { state: "fresh", head, indexedCommit };
  const known = await git(["cat-file", "-e", `${indexedCommit}^{commit}`]);
  if (!known.ok) {
    return { state: "unknown", reason: "indexed_commit_not_in_clone", head, indexedCommit };
  }
  const ancestor = await git(["merge-base", "--is-ancestor", indexedCommit, head]);
  if (!ancestor.ok) return { state: "diverged", head, indexedCommit };
  const [count, diff] = await Promise.all([
    git(["rev-list", "--count", `${indexedCommit}..${head}`]),
    git(["diff", "--name-status", "-z", "-M", indexedCommit, head]),
  ]);
  if (!diff.ok) return { state: "unknown", reason: "diff_failed", head, indexedCommit };
  const delta = parseGitDiffNameStatusZ(diff.stdout);
  return {
    state: "behind",
    head,
    indexedCommit,
    behindCommits: count.ok ? Number.parseInt(count.stdout.trim(), 10) || null : null,
    ...delta,
  };
}

/** One line for the tool result; null when the check did not run. */
export function formatCommitFreshnessLine(check, { readSnapshot = false } = {}) {
  if (!check) return null;
  const short = (sha) => (typeof sha === "string" ? sha.slice(0, 12) : "unknown");
  let text;
  switch (check.state) {
    case "fresh":
      text = `fresh (indexed ${short(check.indexedCommit)} = HEAD)`;
      break;
    case "behind": {
      const files = check.changedPaths.length + check.deletedPaths.length;
      const commits = check.behindCommits ?? "?";
      text = `behind by ${commits} commit(s), ${files} file(s) (indexed ${short(check.indexedCommit)}, HEAD ${short(check.head)})`;
      if (check.sync === "started") text += "; sync started";
      else if (check.sync) text += `; sync skipped (${check.sync})`;
      break;
    }
    case "diverged":
      text = `diverged (indexed ${short(check.indexedCommit)} is not an ancestor of HEAD ${short(check.head)}); run corpuswire_sync_reconcile`;
      break;
    default:
      text = `unknown (${check.reason ?? "unknown"})`;
  }
  if (readSnapshot && (check.state === "behind" || check.state === "diverged")) {
    // The index block lists read_partitions only for a published v2 read.
    text += "; this answer came from a published snapshot, so a sync updates the workspace index but shows here only after a republish";
  }
  return `- indexFreshness: ${text}`;
}
