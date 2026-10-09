import { isRetrievalExcludedPath } from "../../corpuswire-sdk/dist/index.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Exercise the compiled production scanner with injected VS Code filesystem IO.
const source = await readFile(new URL('../dist/extension.js', import.meta.url), 'utf8');
const start = source.indexOf('async function collectUriFiles(');
const end = source.indexOf('\nfunction relativePathForUri', start);
assert.ok(start > 0 && end > start);
function scanner(fs) {
  const vscode = { FileType: { Directory: 2, SymbolicLink: 64 }, workspace: { fs } };
  return new Function('vscode', 'relativePathForUri', 'isIndexExcludedPath', `${source.slice(start, end)}; return collectUriFiles;`)(vscode, (uri) => uri, excludedPath);
}

const excludedStart = source.indexOf('function isIndexExcludedPath(');
const excludedEnd = source.indexOf('\nasync function enhanceSelectedPrompt', excludedStart);
const excludedPath = new Function('isRetrievalExcludedPath', `${source.slice(excludedStart, excludedEnd)}; return isIndexExcludedPath;`)(isRetrievalExcludedPath);

test('full scanner rejects unreadable/disappearing files while incremental watcher stays explicit', async () => {
  const collect = scanner({ stat: async () => ({ type: 1, size: 3, mtime: 1 }),
    readFile: async () => { throw new Error('synthetic read outage'); } });
  await assert.rejects(collect(['a.py'], 100, true), { code: 'scan_incomplete' });
  assert.deepEqual((await collect(['a.py'], 100, false)).files, []);
});

test('full scanner retains empty source and rejects size or mtime races', async () => {
  const empty = scanner({ stat: async () => ({ type: 1, size: 0, mtime: 1 }), readFile: async () => new Uint8Array() });
  assert.equal((await empty(['empty.py'], 100, true)).files.length, 1);
  let n = 0;
  const racing = scanner({ stat: async () => ({ type: 1, size: 3, mtime: ++n }), readFile: async () => new Uint8Array(3) });
  await assert.rejects(racing(['a.py'], 100, true), { code: 'scan_incomplete' });
});

test('scanner excludes hidden paths and discovery metadata before reading', async () => {
  const collect = scanner({ stat: async () => { throw new Error('Excluded file read'); } });
  assert.deepEqual((await collect(['.github/a.yml', 'src/.private.json', 'package.json', 'requirements-dev.txt', 'a.tfvars.json', 'node_modules/a.js', 'build/a.ts'], 100, true)).files, []);
});

test('scanner stops promptly when indexing is cancelled', async () => {
  const collect = scanner({ stat: async () => { throw new Error('Cancelled file read'); } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collect(['a.py'], 100, true, controller.signal), /cancelled/);
});

// Execute the compiled multi-root command and watcher functions with a synthetic VS Code host.
const rootsStart = source.indexOf('function indexRootKey(');
const rootsEnd = source.indexOf('\nasync function rebuildCurrentWorkspaceIndex', rootsStart);
const rootsHelpers = source.slice(rootsStart, rootsEnd);
const commandStart = source.indexOf('async function indexCurrentWorkspace(');
const commandEnd = source.indexOf('\nfunction formatIndexProgressMessage', commandStart);
const watcherStart = source.indexOf('function registerRemoteIndexWatchers(');
const watcherEnd = source.indexOf('\nasync function collectWorkspaceFiles', watcherStart);
const relativeStart = source.indexOf('function relativePathForUri(');
const relativeEnd = source.indexOf('\nfunction isIndexExcludedPath', relativeStart);
const workspaceScanStart = source.indexOf('async function collectWorkspaceFiles(');
const workspaceScanEnd = source.indexOf('\nasync function collectUriFiles', workspaceScanStart);
const statusStart = source.indexOf('async function runIndexStatusCheck(');
const statusEnd = source.indexOf('\nasync function runFetchModel', statusStart);
assert.ok(rootsStart > 0 && commandEnd > commandStart && watcherEnd > watcherStart);

function folder(name) {
  const root = `file:///workspace/${name}`;
  return { name, uri: { toString: () => root } };
}
function file(root, path) {
  return { toString: () => `${root.uri.toString()}/${path}` };
}
function rootSettings(root, overrides = {}) {
  return {
    services: { indexer: { url: 'http://synthetic-indexer', headers: {} } },
    remoteIndexing: {
      enabled: true, autoWatch: true, workspaceId: `test://${root.name}`,
      maxConcurrentUploads: 1, batchBytes: 1024, maxFileSizeBytes: 100,
      autoWatchDebounceMs: 1, maxAutoWatchFiles: 20, ...overrides,
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function extensionHarness(folders, overrides = new Map()) {
  const warnings = [], information = [], progress = [], requests = [], diagnoses = [], timers = new Map();
  const settings = new Map(folders.map((root) => [root.uri.toString(), rootSettings(root, overrides.get(root.name))]));
  let nextTimer = 0;
  let capabilities = 0;
  let upload = async () => ({ status: { coverage: { state: 'verified' } }, transfer: { files_transferred: 1 } });
  let diagnose = async () => readyDiagnosis();
  const callbacks = {};
  const subscriptions = [];
  const cancelHandlers = [];
  const token = { isCancellationRequested: false, onCancellationRequested(handler) {
    cancelHandlers.push(handler);
    return { dispose() {} };
  } };
  const vscode = {
    ProgressLocation: { Notification: 1 },
    workspace: {
      workspaceFolders: folders,
      getWorkspaceFolder(uri) {
        return [...folders].sort((a, b) => b.uri.toString().length - a.uri.toString().length)
          .find((root) => uri.toString() === root.uri.toString() || uri.toString().startsWith(`${root.uri.toString()}/`));
      },
      asRelativePath(uri) {
        const root = this.getWorkspaceFolder(uri);
        return uri.toString().slice(root.uri.toString().length + 1);
      },
      createFileSystemWatcher() {
        return { onDidCreate: (handler) => { callbacks.create = handler; },
          onDidChange: (handler) => { callbacks.change = handler; },
          onDidDelete: (handler) => { callbacks.delete = handler; }, dispose() {} };
      },
    },
    window: {
      showWarningMessage: (message) => { warnings.push(message); },
      showInformationMessage: (message) => { information.push(message); },
      withProgress: async (_options, work) => work({ report: (event) => progress.push(event) }, token),
    },
  };
  class Client {
    constructor(options) { this.options = options; }
    async getIndexCapabilities() { capabilities += 1; return { max_file_size_bytes: 100 }; }
    async indexWorkspace(request) { requests.push(request); return upload(request); }
    async diagnoseWorkspace(request) { diagnoses.push(request); return diagnose(request); }
  }
  const readSettings = (uri) => settings.get(vscode.workspace.getWorkspaceFolder(uri).uri.toString());
  const collectUriFiles = async (uris) => ({ files: uris.map((uri) => ({
    relativePath: vscode.workspace.asRelativePath(uri), content: new Uint8Array(1),
  })), skippedLargeFiles: 0, skippedPolicyFiles: 0 });
  const collectWorkspaceFiles = async (root, _limit, signal) => {
    if (signal?.aborted) throw new Error('scan cancelled');
    return { files: [{ relativePath: 'src/shared.ts', content: root.name }],
      skippedLargeFiles: 0, inventoryScan: { complete: true } };
  };
  const functions = new Function('vscode', 'readSettings', 'CorpusWireClient', 'buildAuthenticatedServiceHeaders',
    'collectWorkspaceFiles', 'collectUriFiles', 'isIndexExcludedPath', 'setTimeout', 'clearTimeout', `
    const MAX_CONCURRENT_INDEX_ROOTS = 2;
    ${rootsHelpers}
    ${source.slice(relativeStart, relativeEnd)}
    ${source.slice(commandStart, commandEnd)}
    ${source.slice(watcherStart, watcherEnd)}
    ${source.slice(statusStart, statusEnd)}
    function formatIndexingError(error) { return error.message; }
    function formatIndexProgressMessage() { return 'upload progress'; }
    const INDEX_INCLUDE_GLOB = '**/*';
    return { indexCurrentWorkspace, registerRemoteIndexWatchers, relativePathForUri, runIndexStatusCheck };
  `)(vscode, readSettings, Client, () => ({}), collectWorkspaceFiles, collectUriFiles, excludedPath,
    (handler) => { const id = ++nextTimer; timers.set(id, handler); return id; }, (id) => timers.delete(id));
  return { ...functions, warnings, information, progress, requests, diagnoses, callbacks, settings, subscriptions,
    get capabilities() { return capabilities; }, setUpload(handler) { upload = handler; },
    setDiagnosis(handler) { diagnose = handler; },
    flushTimers() { const scheduled = [...timers.values()]; timers.clear(); scheduled.forEach((handler) => handler()); },
    cancel() { token.isCancellationRequested = true; cancelHandlers.forEach((handler) => handler()); },
  };
}

function readyDiagnosis(coverage = {}) {
  return {
    status: 'ready', can_retrieve: true, qdrant_error: null, checks: [],
    index: { indexed: true, coverage: { state: 'verified', reason_codes: [], ...coverage } },
  };
}

test('full indexing handles every enabled root with at most two concurrent root jobs', async () => {
  const roots = Array.from({ length: 12 }, (_, index) => folder(`repo-${index}`));
  const harness = extensionHarness(roots, new Map([['repo-4', { enabled: false }]]));
  const firstUploads = deferred();
  let active = 0, maxActive = 0;
  harness.setUpload(async (request) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    request.onCodeReady({ coverage: { code_ready: true, documentation_pending: true, other_pending: false } });
    request.onProgress({ overall_percent: 50 });
    await firstUploads.promise;
    request.onProgress({ overall_percent: 100, phase: 'completed' });
    active -= 1;
    return { status: { coverage: { state: 'verified' } } };
  });
  const indexing = harness.indexCurrentWorkspace();
  await tick();
  assert.equal(harness.requests.length, 2);
  firstUploads.resolve();
  await indexing;
  assert.equal(maxActive, 2);
  assert.deepEqual(harness.requests.map((request) => request.workspace.name).sort(), roots.filter((root) => root.name !== 'repo-4').map((root) => root.name).sort());
  assert.ok(harness.requests.every((request) => request.workspace.displayRoot === `file:///workspace/${request.workspace.name}`));
  assert.ok(harness.requests.every((request) => request.inventoryScan.complete));
  assert.ok(harness.progress.some((event) => event.message === 'repo-0 · Code ready to serve · documentation pending'));
  assert.equal(harness.progress.at(-1).message.includes('pending'), false);
  assert.equal(harness.information.length, 11);
});

test('single-root manual command preserves explicit indexing when automatic indexing is disabled', async () => {
  const root = folder('manual');
  const harness = extensionHarness([root], new Map([['manual', { enabled: false }]]));
  await harness.indexCurrentWorkspace();
  assert.equal(harness.requests.length, 1);
});

test('duplicate root workspace identities fail before any capabilities or upload calls', async () => {
  const roots = [folder('one'), folder('two')];
  const harness = extensionHarness(roots, new Map(roots.map((root) => [root.name, { workspaceId: 'test://shared' }])));
  await harness.indexCurrentWorkspace();
  assert.equal(harness.capabilities, 0);
  assert.equal(harness.requests.length, 0);
  assert.match(harness.warnings[0], /distinct remoteIndexing.workspaceId/);
});

test('watcher keeps same-path changes and deletion-only events isolated by root', async () => {
  const oneRoot = folder('one'), twoRoot = folder('two'), disabledRoot = folder('disabled'), manualRoot = folder('manual-only');
  const roots = [disabledRoot, oneRoot, twoRoot, manualRoot];
  const harness = extensionHarness(roots, new Map([
    ['disabled', { enabled: false }], ['manual-only', { autoWatch: false }],
    ['two', { batchBytes: 2048, maxConcurrentUploads: 2 }],
  ]));
  harness.registerRemoteIndexWatchers({ subscriptions: harness.subscriptions });
  harness.callbacks.change(file(oneRoot, 'src/shared.ts'));
  harness.callbacks.delete(file(twoRoot, 'src/shared.ts'));
  harness.callbacks.change(file(disabledRoot, 'src/shared.ts'));
  harness.callbacks.change(file(manualRoot, 'src/shared.ts'));
  harness.callbacks.change(file(oneRoot, 'node_modules/private.ts'));
  harness.flushTimers();
  await tick();
  assert.equal(harness.requests.length, 2);
  const one = harness.requests.find((request) => request.workspace.name === 'one');
  const two = harness.requests.find((request) => request.workspace.name === 'two');
  assert.deepEqual(one.files.map((entry) => entry.relativePath), ['src/shared.ts']);
  assert.deepEqual(one.deletedPaths, []);
  assert.deepEqual(two.files, []);
  assert.deepEqual(two.deletedPaths, ['src/shared.ts']);
  assert.equal(two.workspace.workspaceId, 'test://two');
  assert.equal(two.workspace.displayRoot, 'file:///workspace/two');
  assert.equal(two.batchBytes, 2048);
  assert.equal(two.maxConcurrentUploads, 2);
  assert.equal(harness.relativePathForUri({ toString: () => 'file:///outside/src/shared.ts' }), null);
});

test('watcher bounds concurrent root updates and admits remaining roots as capacity returns', async () => {
  const roots = Array.from({ length: 4 }, (_, index) => folder(`repo-${index}`));
  const harness = extensionHarness(roots);
  const gate = deferred();
  let active = 0, maxActive = 0;
  harness.setUpload(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate.promise;
    active -= 1;
    return { status: {} };
  });
  harness.registerRemoteIndexWatchers({ subscriptions: harness.subscriptions });
  roots.forEach((root) => harness.callbacks.change(file(root, 'src/shared.ts')));
  harness.flushTimers();
  await tick();
  assert.equal(harness.requests.length, 2);
  gate.resolve();
  await tick();
  await tick();
  assert.equal(harness.requests.length, 4);
  assert.equal(maxActive, 2);
});

test('watcher rejects duplicate configured root identities before upload', async () => {
  const roots = [folder('one'), folder('two')];
  const harness = extensionHarness(roots, new Map(roots.map((root) => [root.name, { workspaceId: 'test://shared' }])));
  harness.registerRemoteIndexWatchers({ subscriptions: harness.subscriptions });
  harness.callbacks.delete(file(roots[1], 'src/shared.ts'));
  harness.flushTimers();
  await tick();
  assert.equal(harness.requests.length, 0);
  assert.match(harness.warnings[0], /distinct remoteIndexing.workspaceId/);
});

test('full workspace scanner partitions nested roots and keeps exclusion evidence complete', async () => {
  const parent = folder('parent');
  const child = { name: 'child', uri: { toString: () => `${parent.uri.toString()}/child` } };
  const own = file(parent, 'src/shared.ts');
  const nested = file(child, 'src/shared.ts');
  const vscode = {
    RelativePattern: class { constructor(root, glob) { this.root = root; this.glob = glob; } },
    workspace: {
      findFiles: async () => [own, nested],
      getWorkspaceFolder: (uri) => uri.toString().startsWith(`${child.uri.toString()}/`) ? child : parent,
    },
  };
  let scanned;
  const collect = new Function('vscode', 'collectUriFiles', 'indexRootKey', 'createHash', `
    const INDEX_INCLUDE_GLOB = '**/*'; const INDEX_EXCLUDE_GLOB = '**/node_modules/**';
    ${source.slice(workspaceScanStart, workspaceScanEnd)}
    return collectWorkspaceFiles;
  `)(vscode, async (uris, _limit, strict) => {
    assert.equal(strict, true);
    scanned = uris;
    return { files: [{ relativePath: 'src/shared.ts' }], skippedLargeFiles: 0, skippedPolicyFiles: 0 };
  }, (root) => root.uri.toString(), createHash);
  const result = await collect(parent, 100);
  assert.deepEqual(scanned, [own]);
  assert.equal(result.inventoryScan.complete, true);
  assert.equal(result.inventoryScan.excludedFileCount, 1);
});

test('watcher retains events arriving in flight, coalesces delete/recreate, and aborts on disposal', async () => {
  const root = folder('one');
  const harness = extensionHarness([root]);
  const gate = deferred();
  harness.setUpload(async () => { await gate.promise; return { status: {} }; });
  harness.registerRemoteIndexWatchers({ subscriptions: harness.subscriptions });
  harness.callbacks.change(file(root, 'src/shared.ts'));
  harness.flushTimers();
  await tick();
  assert.equal(harness.requests.length, 1);
  harness.callbacks.delete(file(root, 'src/shared.ts'));
  harness.callbacks.create(file(root, 'src/shared.ts'));
  harness.callbacks.delete(file(root, 'src/gone.ts'));
  harness.flushTimers();
  assert.equal(harness.requests.length, 1);
  gate.resolve();
  await tick();
  harness.flushTimers();
  await tick();
  assert.equal(harness.requests.length, 2);
  assert.deepEqual(harness.requests[1].files.map((entry) => entry.relativePath), ['src/shared.ts']);
  assert.deepEqual(harness.requests[1].deletedPaths, ['src/gone.ts']);

  const disposalGate = deferred();
  harness.setUpload(async () => { await disposalGate.promise; return { status: {} }; });
  harness.callbacks.change(file(root, 'src/third.ts'));
  harness.flushTimers();
  await tick();
  harness.subscriptions.forEach((item) => item.dispose());
  assert.equal(harness.requests[2].signal.aborted, true);
  harness.callbacks.change(file(root, 'src/fourth.ts'));
  harness.flushTimers();
  disposalGate.resolve();
  await tick();
  assert.equal(harness.requests.length, 3);
});

test('full indexing cancellation stops new roots and passes cancellation to active uploads', async () => {
  const roots = [folder('one'), folder('two'), folder('three')];
  const harness = extensionHarness(roots);
  const gate = deferred();
  harness.setUpload(async () => { await gate.promise; return { status: {} }; });
  const indexing = harness.indexCurrentWorkspace();
  await tick();
  harness.cancel();
  assert.equal(harness.requests.length, 2);
  assert.ok(harness.requests.every((request) => request.signal.aborted));
  gate.resolve();
  await indexing;
  assert.equal(harness.requests.length, 2);
  assert.ok(harness.warnings.some((message) => /indexing cancelled/.test(message)));
});

test('status diagnoses every enabled root with two concurrent calls and exposes conditional readiness', async () => {
  const roots = Array.from({ length: 12 }, (_, index) => folder(`repo-${index}`));
  const harness = extensionHarness(roots, new Map([['repo-0', { enabled: false }]]));
  const gate = deferred();
  let active = 0, maxActive = 0;
  harness.setDiagnosis(async ({ workspaceId }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate.promise;
    active -= 1;
    return workspaceId === 'test://repo-1'
      ? readyDiagnosis({ state: 'pending', reason_codes: ['background_ingestion_pending'], code_ready: true, documentation_pending: true, other_pending: true })
      : readyDiagnosis();
  });
  const messages = [];
  const check = harness.runIndexStatusCheck((message) => messages.push(message));
  await tick();
  assert.equal(harness.diagnoses.length, 2);
  gate.resolve();
  await check;
  assert.equal(maxActive, 2);
  assert.equal(harness.diagnoses.length, 11);
  assert.ok(harness.diagnoses.every(({ workspaceId }) => workspaceId !== 'test://repo-0'));
  const result = messages.at(-1);
  assert.equal(result.state, 'indexed');
  assert.equal(result.code_ready, true);
  assert.equal(result.documentation_pending, true);
  assert.equal(result.other_pending, true);
  assert.equal(result.roots.length, 11);
  assert.match(result.message, /11\/11 workspace folder\(s\) code ready to serve/);
});

test('status retains genuine vector errors and failed diagnosis calls despite ready code elsewhere', async () => {
  const roots = [folder('code'), folder('vector'), folder('offline')];
  const harness = extensionHarness(roots);
  harness.setDiagnosis(async ({ workspaceId }) => {
    if (workspaceId === 'test://offline') throw new Error('synthetic backend unavailable');
    const diagnosis = readyDiagnosis({ state: 'pending', reason_codes: ['background_ingestion_pending'], code_ready: true, documentation_pending: true });
    if (workspaceId === 'test://vector') {
      diagnosis.status = 'blocked'; diagnosis.can_retrieve = false;
      diagnosis.qdrant_error = 'synthetic vector outage';
      diagnosis.checks = [{ name: 'qdrant', status: 'error', message: 'synthetic vector outage' }];
    }
    return diagnosis;
  });
  const messages = [];
  await harness.runIndexStatusCheck((message) => messages.push(message));
  const result = messages.at(-1);
  assert.equal(result.state, 'error');
  assert.equal(result.code_ready, false);
  assert.equal(result.documentation_pending, true);
  assert.equal(result.roots.find((root) => root.name === 'vector').code_ready, false);
  assert.match(result.message, /vector: synthetic vector outage/);
  assert.match(result.message, /offline: Could not diagnose index: synthetic backend unavailable/);
});

test('status does not certify pending or invalidated coverage from existing points alone', async () => {
  const roots = [folder('one'), folder('two')];
  const harness = extensionHarness(roots);
  harness.setDiagnosis(async ({ workspaceId }) => readyDiagnosis({
    state: workspaceId === 'test://one' ? 'pending' : 'invalidated',
    reason_codes: ['coverage_incomplete'], code_ready: true,
  }));
  const messages = [];
  await harness.runIndexStatusCheck((message) => messages.push(message));
  assert.equal(messages.at(-1).state, 'stale');
  assert.equal(messages.at(-1).code_ready, false);
  assert.ok(messages.at(-1).roots.every((root) => root.code_ready === false));
});

test('status preserves diagnosis warnings and supports explicitly ready legacy diagnosis without coverage', async () => {
  const root = folder('one');
  const harness = extensionHarness([root]);
  harness.setDiagnosis(async () => ({ status: 'ready', can_retrieve: true, checks: [], index: { indexed: true } }));
  const messages = [];
  await harness.runIndexStatusCheck((message) => messages.push(message));
  assert.equal(messages.at(-1).state, 'indexed');
  harness.setDiagnosis(async () => ({
    ...readyDiagnosis(), status: 'degraded',
    checks: [{ name: 'index_health', status: 'warning', message: 'Synthetic stale source warning' }],
  }));
  await harness.runIndexStatusCheck((message) => messages.push(message));
  assert.equal(messages.at(-1).state, 'stale');
  assert.equal(messages.at(-1).code_ready, false);
  assert.match(messages.at(-1).message, /Synthetic stale source warning/);
});

test('webview labels verified conditional readiness and retains aggregate errors', () => {
  const applyStart = source.indexOf('function applyIndexStatus(message) {');
  const applyEnd = source.indexOf('\n    indexBtn.addEventListener', applyStart);
  assert.ok(applyStart > 0 && applyEnd > applyStart);
  const banner = { classList: { remove() {} } }, label = {}, message = {};
  const indexButton = { style: {} }, refreshButton = {};
  const apply = new Function('indexBanner', 'indexLabel', 'indexMessage', 'indexBtn', 'refreshStatusBtn',
    `${source.slice(applyStart, applyEnd)}; return applyIndexStatus;`)(banner, label, message, indexButton, refreshButton);
  apply({ state: 'indexed', code_ready: true, documentation_pending: true, message: 'Code served; documentation pending.' });
  assert.equal(label.textContent, 'Code ready');
  assert.equal(banner.className, 'state-indexed');
  apply({ state: 'error', code_ready: false, documentation_pending: true, message: 'One root is unavailable.' });
  assert.equal(label.textContent, 'Index status error');
  assert.equal(banner.className, 'state-error');
  assert.equal(message.textContent, 'One root is unavailable.');
});
