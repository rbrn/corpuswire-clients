// CRP-001 L1.1 (workspace writer lease) and L1.2 (HEAD and branch watcher).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createGitHeadWatcher,
  parseGitDiffNameStatusZ,
  planHeadChange,
  readGitHeadState,
  resolveGitLayout,
} from "../lib/git-head-watch.mjs";

const SERVER_BIN = fileURLToPath(new URL("../bin/corpuswire-mcp.js", import.meta.url));
const execFileAsync = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

async function fixtureRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "cw-head-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, "a.py"), "a = 1\n");
  await writeFile(path.join(repo, "b.py"), "b = 1\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "initial");
  return { root, repo };
}

function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await predicate();
        if (value) return resolve(value);
      } catch { /* retry */ }
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    void tick();
  });
}

// --- git-head-watch library ---------------------------------------------

test("HEAD state follows commits, branch switches and detached HEAD", async () => {
  const { root, repo } = await fixtureRepo();
  try {
    const layout = await resolveGitLayout(path.join(repo));
    assert.equal(layout.linkedWorktree, false);
    const initial = await readGitHeadState(layout);
    assert.equal(initial.branch, "main");
    assert.equal(initial.head, await git(repo, "rev-parse", "HEAD"));

    await git(repo, "checkout", "-q", "-b", "feature");
    const branched = await readGitHeadState(layout);
    assert.equal(branched.branch, "feature");
    assert.equal(branched.head, initial.head);

    await git(repo, "checkout", "-q", "--detach");
    const detached = await readGitHeadState(layout);
    assert.equal(detached.detached, true);
    assert.equal(detached.branch, null);
    assert.equal(detached.head, initial.head);

    // Packed refs (after gc) still resolve.
    await git(repo, "checkout", "-q", "main");
    await git(repo, "pack-refs", "--all");
    const packed = await readGitHeadState(layout);
    assert.equal(packed.head, initial.head);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("linked worktrees resolve HEAD from their own git dir and refs from the common dir", async () => {
  const { root, repo } = await fixtureRepo();
  try {
    const worktree = path.join(root, "linked");
    await git(repo, "worktree", "add", "-q", "-b", "side", worktree);
    const nested = path.join(worktree, "pkg");
    await mkdir(nested);
    const layout = await resolveGitLayout(nested);
    assert.equal(layout.linkedWorktree, true);
    assert.equal(layout.worktreeRoot, worktree);
    assert.notEqual(layout.gitDir, layout.commonDir);
    const state = await readGitHeadState(layout);
    assert.equal(state.branch, "side");
    assert.equal(state.head, await git(worktree, "rev-parse", "HEAD"));

    // A commit in the linked worktree moves its HEAD, not the main checkout's.
    await writeFile(path.join(worktree, "c.py"), "c = 1\n");
    await git(worktree, "add", ".");
    await git(worktree, "commit", "-q", "-m", "side commit");
    const moved = await readGitHeadState(layout);
    assert.equal(moved.head, await git(worktree, "rev-parse", "HEAD"));
    assert.equal((await readGitHeadState(await resolveGitLayout(repo))).branch, "main");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the watcher reports one change per HEAD move and nothing while idle", async () => {
  const { root, repo } = await fixtureRepo();
  const changes = [];
  const watcher = createGitHeadWatcher({
    sourceRoot: repo, intervalMs: 100, onChange: (previous, next) => { changes.push([previous, next]); },
    setIntervalFn: () => null, clearIntervalFn: () => {},
  });
  try {
    await watcher.start();
    assert.equal(await watcher.check(), false, "idle check reports no change");
    await writeFile(path.join(repo, "a.py"), "a = 2\n");
    await git(repo, "commit", "-q", "-am", "edit a");
    assert.equal(await watcher.check(), true);
    await git(repo, "checkout", "-q", "-b", "other");
    assert.equal(await watcher.check(), true, "branch name change at the same commit is observed");
    await git(repo, "checkout", "-q", "--detach", "HEAD~1");
    assert.equal(await watcher.check(), true);
    assert.equal(await watcher.check(), false);
    assert.equal(changes.length, 3);
    assert.equal(changes[2][1].detached, true);
  } finally { watcher.close(); await rm(root, { recursive: true, force: true }); }
});

test("a directory outside git never starts a watch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cw-nogit-"));
  try {
    const watcher = createGitHeadWatcher({ sourceRoot: root, setIntervalFn: () => null });
    const started = await watcher.start();
    // tmpdir itself may live inside a repository on some hosts; only assert no throw.
    assert.ok(started.layout === null || typeof started.layout.gitDir === "string");
    watcher.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("head-change plans cap large switches and fall back to a full reconcile", () => {
  const diff = parseGitDiffNameStatusZ("M\0src/a.py\0A\0src/new.py\0D\0src/old.py\0T\0link\0");
  assert.deepEqual(diff, { changedPaths: ["link", "src/a.py", "src/new.py"], deletedPaths: ["src/old.py"] });
  const previous = { head: "1".repeat(40), ref: "refs/heads/main" };
  const next = { head: "2".repeat(40), ref: "refs/heads/feature" };
  assert.equal(planHeadChange({ previous, next, diff, maxFiles: 10 }).action, "delta");
  assert.deepEqual(planHeadChange({ previous, next, diff, maxFiles: 3 }),
    { action: "reconcile", reason: "delta_cap", total: 4, maxFiles: 3 });
  assert.equal(planHeadChange({ previous, next, diffError: new Error("bad object") }).reason, "diff_failed");
  assert.equal(planHeadChange({ previous, next: { ...next, head: previous.head } }).reason, "same_commit");
  assert.equal(planHeadChange({ previous: { head: null }, next }).reason, "previous_head_unknown");
  assert.equal(planHeadChange({ previous, next: { head: null, unborn: true } }).reason, "unborn_branch");
  assert.equal(planHeadChange({ previous, next, diff: { changedPaths: [], deletedPaths: [] } }).reason, "empty_diff");
});

// --- MCP integration ------------------------------------------------------

function createRpc(child) {
  let buffer = "";
  const waiters = [];
  const responses = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const message = JSON.parse(line);
        if (message.id !== undefined) responses.push(message);
      }
      index = buffer.indexOf("\n");
    }
    while (responses.length && waiters.length) waiters.shift()(responses.shift());
  });
  let id = 0;
  return (name, args = {}) => new Promise((resolve) => {
    waiters.push(resolve);
    id += 1;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    while (responses.length && waiters.length) waiters.shift()(responses.shift());
  });
}

async function writeLeaseMockSdk(dir) {
  const sdkPath = path.join(dir, "lease-sdk.mjs");
  await writeFile(sdkPath, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    const log = (entry) => appendFileSync(process.env.MOCK_CALLS_PATH, JSON.stringify(entry) + '\\n');
    const counter = () => {
      const file = process.env.MOCK_CALLS_PATH + '.count';
      const value = existsSync(file) ? Number(readFileSync(file, 'utf8')) + 1 : 1;
      writeFileSync(file, String(value));
      return value;
    };
    const ok = (request) => ({ ok: true, result: {}, status: { phase: 'completed' }, transfer: {
      complete: true, files_submitted: request.files.length, files_reused: 0,
      files_transferred: request.files.length, acknowledged_files: [] } });
    export class CorpusWireClient {
      async indexWorkspace(request) {
        log({ method: 'indexWorkspace', mode: request.mode, files: request.files.length });
        if (process.env.MOCK_LEASE_SCENARIO === 'forbid-plain') throw new Error('plain indexWorkspace must not run');
        return ok(request);
      }
      async indexWorkspaceWithLease(request, options) {
        const attempt = counter();
        log({ method: 'indexWorkspaceWithLease', holderId: options.holderId, attempt, mode: request.mode });
        const scenario = process.env.MOCK_LEASE_SCENARIO;
        if (scenario === 'disabled') throw new Error('lease must stay unused when disabled');
        if (scenario === 'held' && attempt <= 2) {
          const error = new Error('409 ERROR: Workspace writer lease is held by another sync writer');
          Object.assign(error, { status: 409, errorCode: 'index_lease_held', retryAfterSeconds: 0.01 });
          throw error;
        }
        if (scenario === 'lost' && attempt === 1) {
          options.onLeaseEvent?.({ type: 'acquired', lease: {} });
          options.onLeaseEvent?.({ type: 'lost', error: {} });
          const error = new Error('Workspace writer lease was lost during indexing');
          Object.assign(error, { name: 'RemoteIndexLeaseLostError', code: 'lease_lost', requeue: true });
          throw error;
        }
        options.onLeaseEvent?.({ type: 'acquired', lease: {} });
        options.onLeaseEvent?.({ type: 'released', released: true });
        return ok(request);
      }
    }`);
  return sdkPath;
}

async function startMcp(env) {
  const child = spawn("node", [SERVER_BIN], { stdio: ["pipe", "pipe", "pipe"], env: {
    ...process.env, CORPUSWIRE_BASE_URL: "http://127.0.0.1:8000", CORPUSWIRE_SYNC_ENABLED: "true",
    CORPUSWIRE_WORKSPACE_ID: "fixture", ...env,
  } });
  return { child, call: createRpc(child) };
}

async function readCalls(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

test("lease is unused by default: reconcile calls plain indexWorkspace and status is unchanged", async () => {
  const { root, repo } = await fixtureRepo();
  const callsPath = path.join(root, "calls.jsonl");
  const { child, call } = await startMcp({
    CORPUSWIRE_SDK_PATH: await writeLeaseMockSdk(root), CORPUSWIRE_SYNC_ROOT: repo,
    CORPUSWIRE_SYNC_STATE_DIR: path.join(root, "state"), MOCK_CALLS_PATH: callsPath, MOCK_LEASE_SCENARIO: "disabled",
  });
  try {
    const reconcile = await call("corpuswire_sync_reconcile");
    assert.equal(reconcile.result.isError, false, reconcile.result.content[0].text);
    const calls = await readCalls(callsPath);
    assert.deepEqual(calls.map((entry) => entry.method), ["indexWorkspace"]);
    const status = await call("corpuswire_sync_status");
    assert.doesNotMatch(status.result.content[0].text, /lease|headWatch/i);
  } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
});

test("lease conflicts back off with the existing session-conflict retry and then succeed", async () => {
  const { root, repo } = await fixtureRepo();
  const callsPath = path.join(root, "calls.jsonl");
  const { child, call } = await startMcp({
    CORPUSWIRE_SDK_PATH: await writeLeaseMockSdk(root), CORPUSWIRE_SYNC_ROOT: repo,
    CORPUSWIRE_SYNC_STATE_DIR: path.join(root, "state"), MOCK_CALLS_PATH: callsPath, MOCK_LEASE_SCENARIO: "held",
    CORPUSWIRE_SYNC_LEASE_ENABLED: "true", CORPUSWIRE_SYNC_SESSION_CONFLICT_RETRY_DELAY_MS: "5",
  });
  try {
    const reconcile = await call("corpuswire_sync_reconcile");
    assert.equal(reconcile.result.isError, false, reconcile.result.content[0].text);
    const calls = await readCalls(callsPath);
    assert.deepEqual(calls.map((entry) => entry.method), Array(3).fill("indexWorkspaceWithLease"));
    assert.equal(new Set(calls.map((entry) => entry.holderId)).size, 1);
    assert.match(calls[0].holderId, /^corpuswire-mcp:[0-9a-f]{24}$/);
    const status = (await call("corpuswire_sync_status")).result.content[0].text;
    assert.match(status, /leaseEnabled: true/);
    assert.match(status, /held=2/);
    assert.match(status, /sessionConflictRetries: .*retries=2/);
  } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
});

test("a lease lost mid-reconcile aborts and requeues the reconcile", async () => {
  const { root, repo } = await fixtureRepo();
  const callsPath = path.join(root, "calls.jsonl");
  const { child, call } = await startMcp({
    CORPUSWIRE_SDK_PATH: await writeLeaseMockSdk(root), CORPUSWIRE_SYNC_ROOT: repo,
    CORPUSWIRE_SYNC_STATE_DIR: path.join(root, "state"), MOCK_CALLS_PATH: callsPath, MOCK_LEASE_SCENARIO: "lost",
    CORPUSWIRE_SYNC_LEASE_ENABLED: "true", CORPUSWIRE_SYNC_SESSION_CONFLICT_RETRY_DELAY_MS: "20",
  });
  try {
    const first = await call("corpuswire_sync_reconcile");
    assert.match(first.result.content[0].text, /lease was lost/);
    const calls = await waitFor(async () => {
      const entries = await readCalls(callsPath);
      return entries.length >= 2 ? entries : null;
    });
    assert.deepEqual(calls.map((entry) => entry.attempt), [1, 2]);
    const status = (await call("corpuswire_sync_status")).result.content[0].text;
    assert.match(status, /lost=1/);
  } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
});

test("HEAD watcher queues a small branch-switch delta and reconciles a large one", async () => {
  const { root, repo } = await fixtureRepo();
  await git(repo, "checkout", "-q", "-b", "feature");
  await writeFile(path.join(repo, "a.py"), "a = 2\n");
  await git(repo, "rm", "-q", "b.py");
  await git(repo, "commit", "-q", "-am", "feature change");
  for (let index = 0; index < 4; index += 1) await writeFile(path.join(repo, `bulk${index}.py`), `x = ${index}\n`);
  await git(repo, "checkout", "-q", "-b", "bulk");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "bulk change");
  await git(repo, "checkout", "-q", "main");
  const callsPath = path.join(root, "calls.jsonl");
  const { child, call } = await startMcp({
    CORPUSWIRE_SDK_PATH: await writeLeaseMockSdk(root), CORPUSWIRE_SYNC_ROOT: repo,
    CORPUSWIRE_SYNC_STATE_DIR: path.join(root, "state"), MOCK_CALLS_PATH: callsPath,
    CORPUSWIRE_SYNC_HEAD_WATCH: "true", CORPUSWIRE_SYNC_HEAD_WATCH_INTERVAL_MS: "100",
    CORPUSWIRE_SYNC_HEAD_DELTA_MAX_FILES: "3", CORPUSWIRE_SYNC_DEBOUNCE_MS: "600000",
  });
  try {
    await waitFor(async () => /headWatchActive: true/.test((await call("corpuswire_sync_status")).result.content[0].text));
    // Idle: no backend traffic.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await readCalls(callsPath), []);

    await git(repo, "checkout", "-q", "feature");
    const small = await waitFor(async () => {
      const text = (await call("corpuswire_sync_status")).result.content[0].text;
      return /lastHeadChange: delta \(head_moved\)/.test(text) ? text : null;
    });
    assert.match(small, /pendingChanged: 1/);
    assert.match(small, /pendingDeleted: 1/);
    assert.match(small, /lastGitBranch: feature/);

    // feature -> bulk changes 6 paths, above the cap of 3: one full reconcile.
    await git(repo, "checkout", "-q", "bulk");
    const calls = await waitFor(async () => {
      const entries = await readCalls(callsPath);
      return entries.some((entry) => entry.mode === "full") ? entries : null;
    });
    assert.deepEqual(calls.map((entry) => [entry.method, entry.mode]), [["indexWorkspace", "full"]]);
    const status = (await call("corpuswire_sync_status")).result.content[0].text;
    assert.match(status, /lastHeadChange: reconcile \(delta_cap\)/);

    await git(repo, "checkout", "-q", "--detach", "HEAD");
    // Same commit, detached: nothing to sync.
    const detached = await waitFor(async () => {
      const text = (await call("corpuswire_sync_status")).result.content[0].text;
      return /lastHeadChange: none \(same_commit\) .* detached/.test(text) ? text : null;
    });
    assert.ok(detached);
  } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
});
