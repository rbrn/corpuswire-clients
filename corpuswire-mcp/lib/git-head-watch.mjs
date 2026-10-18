// CRP-001 L1.2: detect HEAD and branch changes without running git or
// contacting the backend while idle. The watcher polls the mtimes of
// `HEAD`, the current branch's ref file and `packed-refs`, and reads them
// only when one changes. It supports detached HEAD and linked worktrees,
// where `.git` is a file pointing at `<common>/.git/worktrees/<name>`.
//
// This file is kept byte-identical in corpuswire-mcp/lib/git-head-watch.mjs
// and corpuswire-cli/lib/git-head-watch.js; a CLI test checks the copies.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_HEAD_WATCH_INTERVAL_MS = 1000;
export const DEFAULT_HEAD_DELTA_MAX_FILES = 500;
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_ANCESTOR_DEPTH = 64;

/** Find the git directory and common directory that serve `sourceRoot`. */
export async function resolveGitLayout(sourceRoot) {
  let directory = path.resolve(sourceRoot);
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const dotGit = path.join(directory, ".git");
    const entry = await stat(dotGit).catch(() => null);
    if (entry?.isDirectory()) {
      return { worktreeRoot: directory, gitDir: dotGit, commonDir: dotGit, linkedWorktree: false };
    }
    if (entry?.isFile()) {
      const text = await readFile(dotGit, "utf8").catch(() => "");
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!match) return null;
      const gitDir = path.resolve(directory, match[1]);
      const commonText = await readFile(path.join(gitDir, "commondir"), "utf8").catch(() => null);
      const commonDir = commonText === null ? gitDir : path.resolve(gitDir, commonText.trim());
      return { worktreeRoot: directory, gitDir, commonDir, linkedWorktree: commonDir !== gitDir };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

async function readPackedRef(commonDir, ref) {
  const text = await readFile(path.join(commonDir, "packed-refs"), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const [sha, name] = line.trim().split(/\s+/, 2);
    if (name === ref && SHA_PATTERN.test(sha)) return sha;
  }
  return null;
}

function refFile(layout, ref) {
  // Branches and tags live in the common directory; per-worktree refs such
  // as refs/bisect and refs/worktree live in the worktree's own git dir.
  const perWorktree = ref.startsWith("refs/bisect/") || ref.startsWith("refs/worktree/")
    || ref.startsWith("refs/rewritten/");
  return path.join(perWorktree ? layout.gitDir : layout.commonDir, ...ref.split("/"));
}

/** Read the checked-out commit, symbolic ref and branch name. */
export async function readGitHeadState(layout) {
  const raw = (await readFile(path.join(layout.gitDir, "HEAD"), "utf8").catch(() => "")).trim();
  if (SHA_PATTERN.test(raw)) {
    return { head: raw, ref: null, branch: null, detached: true, unborn: false };
  }
  const match = /^ref:\s*(\S+)$/.exec(raw);
  if (!match) return { head: null, ref: null, branch: null, detached: false, unborn: false, unreadable: true };
  const ref = match[1];
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
  const loose = (await readFile(refFile(layout, ref), "utf8").catch(() => "")).trim();
  const head = SHA_PATTERN.test(loose) ? loose : await readPackedRef(layout.commonDir, ref);
  return { head, ref, branch, detached: false, unborn: head === null };
}

async function mtimeKey(filePath) {
  const entry = await stat(filePath).catch(() => null);
  return entry ? `${entry.mtimeMs}:${entry.size}:${entry.ino}` : "-";
}

/** A cheap fingerprint: changes whenever HEAD, the branch ref or packed-refs change. */
export async function gitHeadSignature(layout, state) {
  const parts = [await mtimeKey(path.join(layout.gitDir, "HEAD"))];
  if (state?.ref) parts.push(await mtimeKey(refFile(layout, state.ref)));
  parts.push(await mtimeKey(path.join(layout.commonDir, "packed-refs")));
  return parts.join("|");
}

export function sameHeadState(left, right) {
  return (left?.head ?? null) === (right?.head ?? null) && (left?.ref ?? null) === (right?.ref ?? null);
}

/**
 * Poll HEAD state. `onChange(previous, next)` runs once per observed change;
 * checks never overlap. Returns `{ start, check, close, state }`.
 */
export function createGitHeadWatcher({
  sourceRoot,
  intervalMs = DEFAULT_HEAD_WATCH_INTERVAL_MS,
  onChange,
  onError = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let layout = null;
  let state = null;
  let signature = null;
  let timer = null;
  let checking = null;
  let closed = false;

  const check = async () => {
    if (closed) return false;
    if (checking) return checking;
    checking = (async () => {
      try {
        if (!layout) {
          layout = await resolveGitLayout(sourceRoot);
          if (!layout) return false;
        }
        const nextSignature = await gitHeadSignature(layout, state);
        if (nextSignature === signature) return false;
        const next = await readGitHeadState(layout);
        signature = await gitHeadSignature(layout, next);
        const previous = state;
        state = next;
        if (previous === null || sameHeadState(previous, next)) return false;
        await onChange?.(previous, next, layout);
        return true;
      } catch (error) {
        onError(error);
        return false;
      } finally {
        checking = null;
      }
    })();
    return checking;
  };

  return {
    async start() {
      await check();
      if (!closed && timer === null) {
        timer = setIntervalFn(() => { void check(); }, Math.max(100, intervalMs));
        timer?.unref?.();
      }
      return { layout, state };
    },
    check,
    close() {
      closed = true;
      if (timer !== null) clearIntervalFn(timer);
      timer = null;
    },
    get state() { return state; },
    get layout() { return layout; },
  };
}

/** Parse `git diff --name-status -z --no-renames` output. */
export function parseGitDiffNameStatusZ(output) {
  const changedPaths = new Set();
  const deletedPaths = new Set();
  const fields = String(output ?? "").split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index].trim();
    const filePath = fields[index + 1];
    if (!status || !filePath) continue;
    if (status.startsWith("D")) deletedPaths.add(filePath);
    else changedPaths.add(filePath);
  }
  for (const deleted of deletedPaths) changedPaths.delete(deleted);
  return { changedPaths: [...changedPaths].sort(), deletedPaths: [...deletedPaths].sort() };
}

/**
 * Decide how to follow a HEAD change: nothing (same commit, e.g. a new
 * branch at HEAD), a bounded delta, or a full filtered reconcile when the
 * change is too large, the old commit is unknown, or the diff failed.
 */
export function planHeadChange({ previous, next, diff = null, diffError = null, maxFiles = DEFAULT_HEAD_DELTA_MAX_FILES }) {
  if (!next?.head) return { action: "none", reason: next?.unborn ? "unborn_branch" : "head_unreadable" };
  if (previous?.head === next.head) return { action: "none", reason: "same_commit" };
  if (!previous?.head) return { action: "reconcile", reason: "previous_head_unknown" };
  if (diffError || !diff) return { action: "reconcile", reason: "diff_failed" };
  const total = diff.changedPaths.length + diff.deletedPaths.length;
  if (total > maxFiles) return { action: "reconcile", reason: "delta_cap", total, maxFiles };
  if (total === 0) return { action: "none", reason: "empty_diff" };
  return { action: "delta", reason: "head_moved", total, changedPaths: diff.changedPaths, deletedPaths: diff.deletedPaths };
}
