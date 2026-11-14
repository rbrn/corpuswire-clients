import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import minimatch from 'minimatch';
import { GIT_MOVE_GLOB, isGitMovePath } from '../dist/git-move.js';

test('git move watcher matches only the files a bulk working-tree move rewrites', () => {
  for (const path of ['.git/HEAD', '.git/ORIG_HEAD', 'app/.git/HEAD', 'a/b/.git/ORIG_HEAD']) {
    assert.equal(minimatch(path, GIT_MOVE_GLOB), true, path);
  }
  for (const path of ['.git/index', '.git/FETCH_HEAD', '.git/refs/heads/main', '.git/objects/ab/cd', 'src/HEAD']) {
    assert.equal(minimatch(path, GIT_MOVE_GLOB), false, path);
  }
});

test('only the workspace root git files count as a git move', () => {
  assert.equal(isGitMovePath('.git/HEAD'), true);
  assert.equal(isGitMovePath('.git/ORIG_HEAD'), true);
  assert.equal(isGitMovePath('.git\\HEAD'), true);
  assert.equal(isGitMovePath('vendor/lib/.git/HEAD'), false);
  assert.equal(isGitMovePath('.git/index'), false);
});

test('the extension reconciles the whole root after a git move instead of replaying file events', async () => {
  const source = await readFile(new URL('../dist/extension.js', import.meta.url), 'utf8');
  assert.match(source, /createFileSystemWatcher\(GIT_MOVE_GLOB\)/);
  assert.match(source, /async function reconcileFolderIndex\(/);
  const reconcile = source.slice(source.indexOf('async function reconcileFolderIndex('), source.indexOf('async function sendIncrementalIndexUpdate('));
  assert.match(reconcile, /mode: "full"/);
  assert.match(reconcile, /inventoryScan: collected\.inventoryScan/);
  // A pending reconcile supersedes queued per-file events.
  assert.match(source, /if \(pending\.reconcile\) \{[\s\S]*?pending\.changed\.clear\(\);[\s\S]*?reconcileFolderIndex\(/);
});
