import { ingestionPriority, isRetrievalExcludedPath } from "../../corpuswire-sdk/dist/index.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import minimatch from 'minimatch';
import { INDEX_INCLUDE_GLOB as includeGlob } from '../dist/index-discovery.js';

// Exercise the compiled production scanner with injected VS Code filesystem IO.
const source = await readFile(new URL('../dist/extension.js', import.meta.url), 'utf8');
const excludeGlob = JSON.parse(source.match(/^const INDEX_EXCLUDE_GLOB = (.+);$/m)[1]);
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

const directoryStat = (overrides = {}) => ({ type: 2, ctime: 1, mtime: 2, size: 0, ...overrides });
function workspaceScanner(root, hooks = {}) {
  let rootStats = 0;
  const vscode = {
    FileType: { Directory: 2, SymbolicLink: 64 },
    RelativePattern: class { constructor(folder, glob) { this.root = folder; this.glob = glob; } },
    workspace: {
      fs: {
        stat: async (uri) => uri.toString() === root.uri.toString()
          ? hooks.rootStat?.(++rootStats) ?? directoryStat()
          : { type: 1, ctime: 1, mtime: 1, size: 3 },
        readFile: async (uri) => hooks.readFile?.(uri) ?? new Uint8Array(3),
        readDirectory: async () => hooks.readDirectory?.() ?? [],
      },
      findFiles: async () => hooks.findFiles?.() ?? [],
      getWorkspaceFolder: () => root,
      asRelativePath: (uri) => uri.toString().slice(root.uri.toString().length + 1),
    },
  };
  return new Function('vscode', 'isIndexExcludedPath', 'createHash', `
    const INDEX_INCLUDE_GLOB = ${JSON.stringify(includeGlob)};
    const INDEX_EXCLUDE_GLOB = ${JSON.stringify(excludeGlob)};
    function indexRootKey(root) { return root.uri.toString(); }
    ${source.slice(workspaceScanStart, workspaceScanEnd)}
    ${source.slice(start, end)}
    ${source.slice(relativeStart, relativeEnd)}
    return collectWorkspaceFiles;
  `)(vscode, excludedPath, createHash);
}

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
      enabled: true, autoWatch: true, codeFirstPass: false, workspaceId: `test://${root.name}`,
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
  const warnings = [], information = [], progress = [], requests = [], stageRequests = [], scans = [], diagnoses = [], timers = new Map();
  const confirmations = [];
  let confirmationSelection;
  const settings = new Map(folders.map((root) => [root.uri.toString(), rootSettings(root, overrides.get(root.name))]));
  let nextTimer = 0;
  let watcherGlob;
  let capabilities = 0;
  let clientConstructions = 0, authenticationCalls = 0;
  let upload = async () => ({ status: { coverage: { state: 'verified' } }, transfer: { files_transferred: 1 } });
  let diagnose = async () => readyDiagnosis();
  let codeStage = async (request) => {
    const checkpoint = { coverage: { code_ready: true, state: 'pending', documentation_pending: true } };
    request.onCodeReady(checkpoint);
    return { outcome: 'code_ready', full_inventory_complete: false, checkpoint,
      release_status: { phase: 'aborted', pending_batches: 0, active_batches: 0 }, transfer: { complete: false } };
  };
  let scan = async (root) => ({ files: [{ relativePath: 'src/shared.ts', content: root.name }],
    skippedLargeFiles: 0, inventoryScan: { complete: true } });
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
      createFileSystemWatcher(glob) {
        watcherGlob = glob;
        return { onDidCreate: (handler) => { callbacks.create = handler; },
          onDidChange: (handler) => { callbacks.change = handler; },
          onDidDelete: (handler) => { callbacks.delete = handler; }, dispose() {} };
      },
    },
    window: {
      showWarningMessage: (message, options, ...items) => {
        warnings.push(message);
        if (options?.modal) { confirmations.push({ message, options, items }); return confirmationSelection; }
      },
      showInformationMessage: (message) => { information.push(message); },
      withProgress: async (_options, work) => work({ report: (event) => progress.push(event) }, token),
    },
  };
  class Client {
    constructor(options) { this.options = options; clientConstructions += 1; }
    async getIndexCapabilities() { capabilities += 1; return { max_file_size_bytes: 100 }; }
    async indexWorkspace(request) { requests.push(request); return upload(request); }
    async indexWorkspaceCodeStage(request) { stageRequests.push(request); return codeStage(request); }
    async diagnoseWorkspace(request) { diagnoses.push(request); return diagnose(request); }
  }
  const readSettings = (uri) => settings.get(vscode.workspace.getWorkspaceFolder(uri).uri.toString());
  const collectUriFiles = async (uris) => ({ files: uris.map((uri) => ({
    relativePath: vscode.workspace.asRelativePath(uri), content: new Uint8Array(1),
  })), skippedLargeFiles: 0, skippedPolicyFiles: 0 });
  const collectWorkspaceFiles = async (root, _limit, signal) => {
    if (signal?.aborted) throw new Error('scan cancelled');
    scans.push(root.name);
    return scan(root, signal);
  };
  const functions = new Function('vscode', 'readSettings', 'CorpusWireClient', 'buildAuthenticatedServiceHeaders',
    'collectWorkspaceFiles', 'collectUriFiles', 'isIndexExcludedPath', 'setTimeout', 'clearTimeout', `
    const MAX_CONCURRENT_INDEX_ROOTS = 2;
    ${rootsHelpers}
    ${source.slice(relativeStart, relativeEnd)}
    ${source.slice(rootsEnd, commandStart)}
    ${source.slice(commandStart, commandEnd)}
    ${source.slice(watcherStart, watcherEnd)}
    ${source.slice(statusStart, statusEnd)}
    function formatIndexingError(error) { return error.message; }
    function formatIndexProgressMessage() { return 'upload progress'; }
    const INDEX_INCLUDE_GLOB = ${JSON.stringify(includeGlob)};
    return { indexCurrentWorkspace, rebuildCurrentWorkspaceIndex, registerRemoteIndexWatchers, sendIncrementalIndexUpdate, relativePathForUri, runIndexStatusCheck, indexRootStatus };
  `)(vscode, readSettings, Client, () => { authenticationCalls += 1; return {}; }, collectWorkspaceFiles, collectUriFiles, excludedPath,
    (handler) => { const id = ++nextTimer; timers.set(id, handler); return id; }, (id) => timers.delete(id));
  return { ...functions, warnings, information, progress, requests, stageRequests, scans, diagnoses, callbacks, settings, subscriptions, confirmations,
    setConfirmation(selection) { confirmationSelection = selection; },
    get capabilities() { return capabilities; }, setUpload(handler) { upload = handler; },
    get clientConstructions() { return clientConstructions; }, get authenticationCalls() { return authenticationCalls; },
    setCodeStage(handler) { codeStage = handler; }, setScan(handler) { scan = handler; },
    get watcherGlob() { return watcherGlob; },
    setDiagnosis(handler) { diagnose = handler; },
    flushTimers() { const scheduled = [...timers.values()]; timers.clear(); scheduled.forEach((handler) => handler()); },
    cancel() { token.isCancellationRequested = true; cancelHandlers.forEach((handler) => handler()); },
  };
}

function readyDiagnosis(coverage = {}) {
  return {
    status: 'ready', can_retrieve: true, qdrant_error: null, checks: [],
    index: { indexed: true, readiness: coverage.state === 'pending' ? 'code_ready' : 'ready', health_status: 'ok', health_warnings: [], coverage: { state: 'verified', reason_codes: [], ...coverage } },
  };
}

const diagnosticPaths = [
  'reports/retrieval-failures', 'reports/retrieval-failures/probe.json',
  'nested/reports/retrieval-failures', 'nested/reports/retrieval-failures/deep/probe.json',
  'reports\\retrieval-failures\\probe.json', 'nested\\reports\\retrieval-failures\\probe.json',
];

test('generated retrieval diagnostics are excluded before scanner IO with consistent inventory evidence', async () => {
  const root = folder('diagnostic-scan');
  const reads = [];
  const collect = workspaceScanner(root, {
    findFiles: () => [...diagnosticPaths, 'reports/retrieval-failures-summary.json', 'reports/quality.json', 'src/a.ts'].map((path) => file(root, path)),
    readFile: (uri) => { reads.push(uri.toString()); return new Uint8Array(3); },
  });
  const result = await collect(root, 100);
  assert.deepEqual(result.files.map((entry) => entry.relativePath), ['reports/retrieval-failures-summary.json', 'reports/quality.json', 'src/a.ts']);
  assert.equal(reads.length, 3);
  assert.equal(result.inventoryScan.excludedFileCount, diagnosticPaths.length);
  assert.equal(result.inventoryScan.ignoreDigest, createHash('sha256').update(JSON.stringify({
    include: includeGlob, exclude: excludeGlob, hiddenPaths: 'exclude',
    retrievalExclusions: 'discovery-terraform-and-retrieval-diagnostics/v2', workspaceRootIsolation: 'v1',
  })).digest('hex'));
  for (const path of diagnosticPaths.filter((path) => !path.includes('\\'))) {
    assert.equal(minimatch(path, excludeGlob, { dot: true }), true, path);
  }
  for (const path of ['reports/quality.json', 'reports/retrieval-failures-summary.json', 'src/a.ts']) {
    assert.equal(excludedPath(path), false, path);
  }
  for (const path of ['src\\.private.json', 'build\\a.ts', 'infra\\private.tfvars.json', 'package.json']) {
    assert.equal(excludedPath(path), true, path);
  }
});

test('watcher create change and delete ignore root nested and Windows diagnostic paths', async () => {
  for (const event of ['create', 'change', 'delete']) {
    const root = folder(`diagnostic-${event}`);
    const harness = extensionHarness([root]);
    harness.registerRemoteIndexWatchers({ subscriptions: harness.subscriptions });
    for (const path of diagnosticPaths) harness.callbacks[event](file(root, path));
    harness.flushTimers();
    await tick();
    assert.equal(harness.requests.length, 0, event);
    assert.equal(harness.clientConstructions, 0, event);
    assert.equal(harness.authenticationCalls, 0, event);
    assert.equal(harness.warnings.length, 0, event);
    for (const path of diagnosticPaths) harness.callbacks[event](file(root, path));
    harness.callbacks[event](file(root, 'reports/quality.json'));
    harness.flushTimers();
    await tick();
    assert.equal(harness.requests.length, 1, event);
    const request = harness.requests[0];
    assert.deepEqual(request.deletedPaths, event === 'delete' ? ['reports/quality.json'] : []);
    assert.deepEqual(request.files.map((entry) => entry.relativePath), event === 'delete' ? [] : ['reports/quality.json']);
  }
});

test('direct incremental boundary filters diagnostic changes and deletes and retains mixed legitimate work', async () => {
  const root = folder('direct-diagnostics'), other = folder('other');
  const harness = extensionHarness([root, other]);
  await harness.sendIncrementalIndexUpdate(root, diagnosticPaths.map((path) => file(root, path)), diagnosticPaths);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.clientConstructions, 0);
  assert.equal(harness.authenticationCalls, 0);
  await harness.sendIncrementalIndexUpdate(root,
    [...diagnosticPaths, 'reports/quality.json'].map((path) => file(root, path)),
    [...diagnosticPaths, 'src\\removed.ts', 'build\\ignored.ts', 'infra\\private.tfvars.json']);
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.requests[0].files.map((entry) => entry.relativePath), ['reports/quality.json']);
  assert.deepEqual(harness.requests[0].deletedPaths, ['src/removed.ts']);
  await assert.rejects(harness.sendIncrementalIndexUpdate(root, [file(other, 'src/a.ts')], []), /cannot mix workspace folders/);
  assert.equal(harness.requests.length, 1);
});

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

test('multi-root rebuild confirms the exact participating names and identities and cancellation starts no requests', async () => {
  const roots = ['one', 'two', 'disabled'].map(folder);
  const harness = extensionHarness(roots, new Map([['disabled', { enabled: false }]]));
  await harness.rebuildCurrentWorkspaceIndex();
  assert.equal(harness.confirmations.length, 1);
  assert.match(harness.confirmations[0].message, /Rebuild 2 CorpusWire workspace/);
  assert.match(harness.confirmations[0].message, /one: test:\/\/one/);
  assert.match(harness.confirmations[0].message, /two: test:\/\/two/);
  assert.doesNotMatch(harness.confirmations[0].message, /disabled/);
  assert.equal(harness.capabilities, 0);
  assert.equal(harness.requests.length, 0);
  harness.setConfirmation('Rebuild Index');
  await harness.rebuildCurrentWorkspaceIndex();
  assert.deepEqual(harness.requests.map((request) => request.workspace.workspaceId).sort(), ['test://one', 'test://two']);
  assert.ok(harness.requests.every((request) => request.recreateCollection === true));
  const duplicate = extensionHarness(roots.slice(0, 2), new Map([['one', { workspaceId: 'test://shared' }], ['two', { workspaceId: 'test://shared' }]]));
  duplicate.setConfirmation('Rebuild Index');
  await duplicate.rebuildCurrentWorkspaceIndex();
  assert.equal(duplicate.confirmations.length, 0);
  assert.equal(duplicate.capabilities, 0);
  assert.equal(duplicate.requests.length, 0);
  assert.match(duplicate.warnings[0], /distinct remoteIndexing.workspaceId/);
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

test('equivalent service URL spellings cannot bypass duplicate root protection', async () => {
  const roots = [folder('one'), folder('two')];
  for (const [firstUrl, secondUrl] of [
    ['HTTPS://EXAMPLE.com:443', 'https://example.com/'],
    ['http://EXAMPLE.com:80/api/', 'http://example.com/api'],
  ]) {
    const harness = extensionHarness(roots, new Map(roots.map((root) => [root.name, { workspaceId: 'test://shared' }])));
    harness.settings.get(roots[0].uri.toString()).services.indexer.url = firstUrl;
    harness.settings.get(roots[1].uri.toString()).services.indexer.url = secondUrl;
    await harness.indexCurrentWorkspace();
    assert.equal(harness.capabilities, 0);
    assert.equal(harness.requests.length, 0);
    assert.match(harness.warnings[0], /distinct remoteIndexing.workspaceId/);

    harness.registerRemoteIndexWatchers({ subscriptions: harness.subscriptions });
    harness.callbacks.delete(file(roots[1], 'src/shared.ts'));
    harness.flushTimers();
    await tick();
    assert.equal(harness.requests.length, 0);
  }

  // Distinct path prefixes and nondefault ports remain separate services.
  for (const secondUrl of ['https://example.com/Other', 'https://example.com:8443/api']) {
    const harness = extensionHarness(roots, new Map(roots.map((root) => [root.name, { workspaceId: 'test://shared' }])));
    harness.settings.get(roots[0].uri.toString()).services.indexer.url = 'https://example.com/api';
    harness.settings.get(roots[1].uri.toString()).services.indexer.url = secondUrl;
    await harness.indexCurrentWorkspace();
    assert.equal(harness.requests.length, 2);
  }
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
    FileType: { Directory: 2, SymbolicLink: 64 },
    RelativePattern: class { constructor(root, glob) { this.root = root; this.glob = glob; } },
    workspace: {
      fs: { stat: async () => directoryStat(), readDirectory: async () => [] },
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

test('production scanner and watcher include canonical code extensions and wrappers without crossing exclusions', async () => {
  const extensions = ['bat', 'scala', 'sh', 'cjs', 'js', 'jsx', 'mjs', 'cts', 'mts', 'ts', 'tsx', 'java', 'kt', 'kts', 'py', 'pyi', 'hcl', 'tf', 'html', 'htm'];
  const codePaths = [...extensions.flatMap((extension) => [`src/example.${extension}`, `src/Main.${extension.toUpperCase()}`]), 'mvnw', 'tools/gradlew', 'tools/MvNw', 'tools/GradleW', 'infra/main.tf.json', 'infra/main.TF.JSON'];
  for (const path of codePaths) assert.equal(ingestionPriority(path), 1, path);
  const allowedPaths = [...codePaths, 'README.md', 'README.Md', 'config/settings.json.example', 'config/settings.JSON.ExAmPlE'];
  const deniedPaths = ['.env', 'credential.pem', 'infra/private.tfvars.json', 'package.json', '.github/pipeline.yml', 'build/example.scala', 'node_modules/example.kt'];
  const parent = folder('registry');
  const child = { name: 'child', uri: { toString: () => `${parent.uri.toString()}/child` } };
  const candidateUris = [...allowedPaths, ...deniedPaths].map((path) => file(parent, path));
  candidateUris.push(file(child, 'src/nested.kt'));
  const readPaths = [];
  const vscode = {
    FileType: { Directory: 2, SymbolicLink: 64 },
    RelativePattern: class { constructor(root, glob) { this.root = root; this.glob = glob; } },
    workspace: {
      getWorkspaceFolder: (uri) => uri.toString().startsWith(`${child.uri.toString()}/`) ? child : parent,
      asRelativePath(uri) {
        return uri.toString().slice(this.getWorkspaceFolder(uri).uri.toString().length + 1);
      },
      findFiles: async (include, exclude) => {
        assert.equal(include.root, parent);
        assert.equal(include.glob, includeGlob);
        assert.equal(exclude.glob, excludeGlob);
        return candidateUris.filter((uri) => {
          const path = uri.toString().slice(parent.uri.toString().length + 1);
          return minimatch(path, include.glob, { dot: true }) && !minimatch(path, exclude.glob, { dot: true });
        });
      },
      fs: {
        readDirectory: async () => [],
        stat: async (uri) => uri.toString() === parent.uri.toString()
          ? directoryStat() : { type: 1, size: 3, mtime: 1 },
        readFile: async (uri) => {
          readPaths.push(uri.toString().slice(parent.uri.toString().length + 1));
          return new Uint8Array(3);
        },
      },
    },
  };
  const collect = new Function('vscode', 'isIndexExcludedPath', 'createHash', `
    const INDEX_INCLUDE_GLOB = ${JSON.stringify(includeGlob)};
    const INDEX_EXCLUDE_GLOB = ${JSON.stringify(excludeGlob)};
    function indexRootKey(root) { return root.uri.toString(); }
    ${source.slice(workspaceScanStart, workspaceScanEnd)}
    ${source.slice(start, end)}
    ${source.slice(relativeStart, relativeEnd)}
    return collectWorkspaceFiles;
  `)(vscode, excludedPath, createHash);
  const result = await collect(parent, 100);
  assert.deepEqual(result.files.map((entry) => entry.relativePath).sort(), allowedPaths.toSorted());
  assert.deepEqual(readPaths.sort(), allowedPaths.toSorted());
  assert.equal(result.inventoryScan.complete, true);
  assert.equal(result.inventoryScan.excludedFileCount, 4);

  const harness = extensionHarness([parent], new Map([[parent.name, { maxAutoWatchFiles: 100 }]]));
  harness.registerRemoteIndexWatchers({ subscriptions: harness.subscriptions }, { setIndexProgress() {} });
  assert.equal(harness.watcherGlob, includeGlob);
  for (const path of [...allowedPaths, ...deniedPaths]) {
    if (minimatch(path, harness.watcherGlob, { dot: true })) harness.callbacks.change(file(parent, path));
  }
  harness.flushTimers();
  await tick(); await tick();
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.requests[0].files.map((entry) => entry.relativePath).sort(), allowedPaths.toSorted());
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

test('per-root readiness rejects unhealthy index metadata and diagnosis warnings even when top-level status is ready', () => {
  const harness = extensionHarness([folder('one')]);
  const pending = { state: 'pending', reason_codes: ['background_ingestion_pending'], code_ready: true, documentation_pending: true };
  for (const coverage of [pending, { state: 'verified', code_ready: true }]) {
    for (const unhealthy of [{ health_status: 'degraded' }, { health_status: 'error' }, { health_warnings: ['Synthetic index health warning'] }]) {
      const diagnosis = readyDiagnosis(coverage);
      Object.assign(diagnosis.index, unhealthy);
      const result = harness.indexRootStatus('one', 'test://one', diagnosis);
      assert.notEqual(result.state, 'indexed');
      assert.equal(result.code_ready, false);
    }
  }
  const partialWithoutHealth = readyDiagnosis(pending);
  delete partialWithoutHealth.index.health_status;
  assert.equal(harness.indexRootStatus('one', 'test://one', partialWithoutHealth).code_ready, false);
  const healthyPartial = readyDiagnosis(pending);
  assert.equal(harness.indexRootStatus('one', 'test://one', healthyPartial).state, 'indexed');
  healthyPartial.checks = [{ name: 'source_health', status: 'warning', message: 'Synthetic diagnosis warning' }];
  const warning = harness.indexRootStatus('one', 'test://one', healthyPartial);
  assert.equal(warning.state, 'stale');
  assert.equal(warning.code_ready, false);
  assert.match(warning.message, /Synthetic diagnosis warning/);
});

test('partial code readiness requires explicit checkpoint readiness while verified coverage remains compatible', () => {
  const root = folder('checkpoint');
  const harness = extensionHarness([root]);
  const pending = { state: 'pending', reason_codes: ['background_ingestion_pending'], code_ready: true, documentation_pending: true };
  for (const readiness of [undefined, null, 'ready', 'indexing', 'stale']) {
    const diagnosis = readyDiagnosis(pending);
    diagnosis.index.readiness = readiness;
    const result = harness.indexRootStatus(root.name, 'test://checkpoint', diagnosis);
    assert.equal(result.state, 'stale');
    assert.equal(result.code_ready, false);
    assert.equal(result.documentation_pending, true);
  }
  assert.equal(harness.indexRootStatus(root.name, 'test://checkpoint', readyDiagnosis(pending)).code_ready, true);
  const verified = readyDiagnosis({ code_ready: true });
  delete verified.index.readiness;
  assert.equal(harness.indexRootStatus(root.name, 'test://checkpoint', verified).state, 'indexed');
});

test('degraded top-level diagnosis blocks healthy pending and verified code coverage and aggregate readiness', async () => {
  const roots = ['healthy', 'pending', 'verified'].map(folder);
  const harness = extensionHarness(roots);
  const pending = { state: 'pending', reason_codes: ['background_ingestion_pending'], code_ready: true, documentation_pending: true };
  const degraded = (coverage) => ({ ...readyDiagnosis(coverage), status: 'degraded' });
  for (const coverage of [pending, { state: 'verified', code_ready: true }]) {
    const result = harness.indexRootStatus('one', 'test://one', degraded(coverage));
    assert.equal(result.state, 'stale');
    assert.equal(result.code_ready, false);
  }
  const legacy = { status: 'degraded', can_retrieve: true, checks: [], index: { indexed: true, readiness: 'ready' } };
  assert.equal(harness.indexRootStatus('legacy', 'test://legacy', legacy).state, 'stale');
  harness.setDiagnosis(async ({ workspaceId }) => workspaceId === 'test://healthy' ? readyDiagnosis(pending)
    : degraded(workspaceId === 'test://pending' ? pending : { state: 'verified', code_ready: true }));
  const messages = [];
  await harness.runIndexStatusCheck((message) => messages.push(message));
  const result = messages.at(-1);
  assert.equal(result.state, 'stale');
  assert.equal(result.code_ready, false);
  assert.equal(result.roots.find((root) => root.name === 'healthy').code_ready, true);
  assert.ok(result.roots.filter((root) => root.name !== 'healthy').every((root) => root.state === 'stale' && root.code_ready === false));
});

test('aggregate readiness cannot mask degraded, warning or error roots behind healthy code-ready roots', async () => {
  const roots = ['healthy', 'degraded', 'warning', 'error'].map(folder);
  const harness = extensionHarness(roots);
  harness.setDiagnosis(async ({ workspaceId }) => {
    const diagnosis = readyDiagnosis({ state: 'pending', reason_codes: ['background_ingestion_pending'], code_ready: true, documentation_pending: true });
    if (workspaceId === 'test://degraded') diagnosis.index.health_status = 'degraded';
    if (workspaceId === 'test://warning') diagnosis.index.health_warnings = ['Synthetic warning from index metadata'];
    if (workspaceId === 'test://error') diagnosis.index.health_status = 'error';
    return diagnosis;
  });
  const messages = [];
  await harness.runIndexStatusCheck((message) => messages.push(message));
  const result = messages.at(-1);
  assert.equal(result.state, 'error');
  assert.equal(result.code_ready, false);
  assert.equal(result.roots.find((root) => root.name === 'healthy').code_ready, true);
  assert.ok(result.roots.filter((root) => root.name !== 'healthy').every((root) => root.code_ready === false));
  assert.match(result.message, /Synthetic warning from index metadata/);
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


test('opt-in code pass releases slots for twelve roots before any fresh full continuation', async () => {
  const roots = Array.from({ length: 12 }, (_, index) => folder(`quantum-${index}`));
  const harness = extensionHarness(roots, new Map(roots.map((root) => [root.name, { codeFirstPass: true }])));
  const published = new Set(), events = [];
  let active = 0, maximumActive = 0;
  harness.setCodeStage(async (request) => {
    active += 1; maximumActive = Math.max(maximumActive, active);
    assert.ok(active <= 2, 'Synthetic tenant permits only two session slots');
    events.push(`code:${request.workspace.name}`);
    await tick();
    published.add(request.workspace.name);
    const checkpoint = { coverage: { state: 'pending', code_ready: true, documentation_pending: true } };
    request.onCodeReady(checkpoint);
    active -= 1;
    return { outcome: 'code_ready', checkpoint, release_status: { phase: 'aborted', pending_batches: 0, active_batches: 0 }, transfer: { complete: false }, full_inventory_complete: false };
  });
  harness.setUpload(async (request) => {
    assert.equal(published.size, 12, 'Every root code pass precedes documentation continuation');
    active += 1; maximumActive = Math.max(maximumActive, active);
    assert.ok(active <= 2);
    events.push(`full:${request.workspace.name}`);
    await tick(); active -= 1;
    return { status: { phase: 'completed', coverage: { state: 'verified' } }, transfer: { complete: true } };
  });
  await harness.indexCurrentWorkspace({ recreateCollection: true });
  assert.equal(maximumActive, 2);
  assert.equal(harness.stageRequests.length, 12);
  assert.equal(harness.requests.length, 12);
  assert.ok(harness.stageRequests.every((request) => request.recreateCollection === true));
  assert.ok(harness.requests.every((request) => request.recreateCollection === false));
  assert.equal(harness.scans.length, 24);
  assert.ok(events.slice(0, 12).every((event) => event.startsWith('code:')));
  assert.equal(harness.information.length, 12);
});

test('full continuation rescans changed code, added files and code deletion after publication', async () => {
  const root = folder('fresh');
  const harness = extensionHarness([root], new Map([['fresh', { codeFirstPass: true }]]));
  let scanCount = 0;
  harness.setScan(async () => ({ files: ++scanCount === 1
    ? [{ relativePath: 'deleted.py', content: 'old' }, { relativePath: 'changed.py', content: 'old' }]
    : [{ relativePath: 'changed.py', content: 'new' }, { relativePath: 'added.py', content: 'new' }, { relativePath: 'README.md', content: 'guide' }],
    skippedLargeFiles: 0, inventoryScan: { complete: true, producer: `scan-${scanCount}` } }));
  await harness.indexCurrentWorkspace();
  assert.deepEqual(harness.stageRequests[0].files.map((file) => file.relativePath), ['deleted.py', 'changed.py']);
  assert.deepEqual(harness.requests[0].files.map((file) => file.relativePath), ['changed.py', 'added.py', 'README.md']);
  assert.equal(harness.requests[0].files[0].content, 'new');
  assert.equal(harness.requests[0].inventoryScan.producer, 'scan-2');
  assert.equal(harness.requests[0].mode, 'full');
});

test('cancellation after the code pass preserves pending code and prevents every full continuation', async () => {
  const roots = [folder('one'), folder('two')];
  const harness = extensionHarness(roots, new Map(roots.map((root) => [root.name, { codeFirstPass: true }])));
  let finished = 0;
  harness.setCodeStage(async (request) => {
    const checkpoint = { coverage: { state: 'pending', code_ready: true, documentation_pending: true } };
    request.onCodeReady(checkpoint);
    if (++finished === 2) harness.cancel();
    return { outcome: 'code_ready', checkpoint, release_status: { phase: 'aborted', active_batches: 0, pending_batches: 0 }, transfer: { complete: false }, full_inventory_complete: false };
  });
  await harness.indexCurrentWorkspace();
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.information.length, 0);
  assert.ok(harness.warnings.some((message) => /full inventory remains pending/.test(message)));
});

test('documentation-only stages defer while empty and legacy full fallbacks run once', async () => {
  const roots = ['docs', 'empty', 'legacy'].map(folder);
  const harness = extensionHarness(roots, new Map(roots.map((root) => [root.name, { codeFirstPass: true }])));
  harness.setCodeStage(async (request) => request.workspace.name === 'docs'
    ? { outcome: 'deferred', reason: 'no_code', full_inventory_complete: false, files_submitted: 1 }
    : { outcome: 'full', reason: request.workspace.name === 'empty' ? 'empty_inventory' : 'checkpoint_unsupported', full_inventory_complete: true,
      committed: { status: { phase: 'completed', coverage: { state: 'verified' } }, transfer: { complete: true } } });
  await harness.indexCurrentWorkspace({ recreateCollection: true });
  assert.deepEqual(harness.requests.map((request) => request.workspace.name), ['docs']);
  assert.equal(harness.requests[0].recreateCollection, true, 'Deferred stage has not recreated anything yet');
  assert.equal(harness.scans.filter((name) => name === 'empty').length, 1);
  assert.equal(harness.scans.filter((name) => name === 'legacy').length, 1);
  assert.ok(harness.progress.some((event) => /Code checkpoint unavailable/.test(event.message)));
  assert.ok(harness.progress.some((event) => /full indexing deferred/.test(event.message)));
});

test('failed code stage never aliases success and does not start its full continuation', async () => {
  const root = folder('failed');
  const harness = extensionHarness([root], new Map([['failed', { codeFirstPass: true }]]));
  harness.setCodeStage(async () => { throw new Error('Synthetic release confirmation failure'); });
  await harness.indexCurrentWorkspace();
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.information.length, 0);
  assert.ok(harness.warnings.some((message) => /release confirmation failure/.test(message)));
});


test('legacy full fallback displays its missing inventory verification explicitly', async () => {
  const root = folder('legacy-unverified');
  const harness = extensionHarness([root], new Map([[root.name, { codeFirstPass: true }]]));
  harness.setCodeStage(async () => ({ outcome: 'full', reason: 'checkpoint_unsupported', full_inventory_complete: false,
    committed: { status: { phase: 'completed' }, transfer: { complete: true } } }));
  await harness.indexCurrentWorkspace();
  assert.equal(harness.requests.length, 0);
  assert.ok(harness.progress.some((event) => /full inventory verification unavailable/.test(event.message)));
  assert.ok(harness.information.some((message) => /Inventory coverage: unknown/.test(message)));
});

test('incremental watchers ignore the experimental full indexing treatment', async () => {
  const root = folder('watch-opt-in');
  const harness = extensionHarness([root], new Map([[root.name, { codeFirstPass: true }]]));
  harness.registerRemoteIndexWatchers({ subscriptions: harness.subscriptions });
  harness.callbacks.change(file(root, 'main.py'));
  harness.flushTimers();
  await tick(); await tick();
  assert.equal(harness.stageRequests.length, 0);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].mode, 'incremental');
});

test('cancelled continuation counts only roots whose published code is still pending', async () => {
  const roots = [folder('complete'), folder('pending')];
  const harness = extensionHarness(roots, new Map(roots.map((root) => [root.name, { codeFirstPass: true }])));
  harness.setUpload(async (request) => {
    if (request.workspace.name === 'complete') return { status: { phase: 'completed', coverage: { state: 'verified' } }, transfer: { complete: true } };
    await tick();
    harness.cancel();
    throw new Error('Synthetic cancelled continuation');
  });
  await harness.indexCurrentWorkspace();
  assert.equal(harness.information.length, 1);
  assert.ok(harness.warnings.some((message) => /Published code is preserved for 1 folder\(s\); full inventory remains pending/.test(message)));
  assert.ok(harness.warnings.every((message) => !/preserved for 2/.test(message)));
});

test('a callback publication remains visible when cancellation prevents a code-stage result', async () => {
  const root = folder('cancelled-checkpoint');
  const harness = extensionHarness([root], new Map([[root.name, { codeFirstPass: true }]]));
  harness.setCodeStage(async (request) => {
    request.onCodeReady({ coverage: { state: 'pending', code_ready: true, documentation_pending: true } });
    harness.cancel();
    throw new Error('Synthetic cancellation after publication');
  });
  await harness.indexCurrentWorkspace();
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.information.length, 0);
  assert.ok(harness.warnings.some((message) => /Published code is preserved for 1 folder/.test(message)));
});

test('production full scanner accepts an intact empty directory and checks it across discovery and reads', async () => {
  const root = folder('intact-empty');
  let checks = 0, discoveries = 0;
  const collect = workspaceScanner(root, {
    rootStat: () => { checks += 1; return directoryStat(); },
    findFiles: () => { discoveries += 1; return []; },
    readFile: () => { assert.fail('Empty roots have no files to read'); },
  });
  const result = await collect(root, 100);
  assert.deepEqual(result.files, []);
  assert.equal(result.inventoryScan.complete, true);
  assert.equal(checks, 3);
  assert.equal(discoveries, 1);
});

test('production full scanner rejects missing inaccessible non-directory and symlink roots before discovery', async () => {
  const root = folder('unavailable');
  for (const rootStat of [
    () => { throw new Error('Synthetic missing root'); },
    () => { throw new Error('Synthetic permission denial'); },
    () => directoryStat({ type: 1 }),
    () => directoryStat({ type: 2 | 64 }),
    () => directoryStat({ ctime: undefined }),
  ]) {
    const collect = workspaceScanner(root, {
      rootStat, findFiles: () => { assert.fail('Invalid root must not discover files'); },
    });
    await assert.rejects(collect(root, 100), { code: 'scan_incomplete' });
  }
});

test('production full scanner rejects empty discovery after root loss replacement or metadata change', async () => {
  const root = folder('discovery-race');
  for (const changed of [{ type: 1 }, { type: 2 | 64 }, { ctime: 3 }, { mtime: 3 }, { size: 1 }]) {
    const collect = workspaceScanner(root, {
      rootStat: (check) => directoryStat(check === 1 ? {} : changed),
      findFiles: () => [],
    });
    await assert.rejects(collect(root, 100), { code: 'scan_incomplete' });
  }
  const disappeared = workspaceScanner(root, {
    rootStat: (check) => { if (check > 1) throw new Error('Synthetic disappeared root'); return directoryStat(); },
    findFiles: () => [],
  });
  await assert.rejects(disappeared(root, 100), { code: 'scan_incomplete' });
  const failedDiscovery = workspaceScanner(root, { findFiles: () => { throw new Error('Synthetic discovery outage'); } });
  await assert.rejects(failedDiscovery(root, 100), { code: 'scan_incomplete' });
});

test('production full scanner snapshots root metadata and rechecks root after the last read', async () => {
  const root = folder('read-race');
  const sharedStat = directoryStat();
  const mutated = workspaceScanner(root, {
    rootStat: () => sharedStat,
    findFiles: () => { sharedStat.ctime += 1; return []; },
  });
  await assert.rejects(mutated(root, 100), { code: 'scan_incomplete' });
  let read = false;
  const replaced = workspaceScanner(root, {
    rootStat: () => directoryStat(read ? { ctime: 99 } : {}),
    findFiles: () => [file(root, 'main.py')],
    readFile: () => { read = true; return new Uint8Array(3); },
  });
  await assert.rejects(replaced(root, 100), { code: 'scan_incomplete' });
  assert.equal(read, true);
});

test('production full scanner rejects cancellation before scan during empty discovery and during final read', async () => {
  const root = folder('cancelled-root');
  const before = new AbortController(); before.abort();
  await assert.rejects(workspaceScanner(root, {
    rootStat: () => { assert.fail('Cancelled scan must not stat the root'); },
  })(root, 100, before.signal), { code: 'scan_incomplete' });
  const discovery = new AbortController();
  await assert.rejects(workspaceScanner(root, {
    findFiles: () => { discovery.abort(); return []; },
  })(root, 100, discovery.signal), { code: 'scan_incomplete' });
  const read = new AbortController();
  await assert.rejects(workspaceScanner(root, {
    findFiles: () => [file(root, 'main.py')],
    readFile: () => { read.abort(); return new Uint8Array(3); },
  })(root, 100, read.signal), { code: 'scan_incomplete' });
});

test('full command creates no session for unavailable root but accepts a genuine intact empty root', async () => {
  const missing = folder('missing-command');
  const failed = extensionHarness([missing]);
  failed.setScan(workspaceScanner(missing, { rootStat: () => { throw new Error('Synthetic missing root'); } }));
  await failed.indexCurrentWorkspace();
  assert.equal(failed.stageRequests.length, 0);
  assert.equal(failed.requests.length, 0);
  assert.equal(failed.information.length, 0);
  assert.ok(failed.warnings.some((message) => /Workspace scan incomplete/.test(message)));
  const empty = folder('empty-command');
  const intact = extensionHarness([empty]);
  intact.setScan((root, signal) => workspaceScanner(empty)(root, 100, signal));
  await intact.indexCurrentWorkspace();
  assert.equal(intact.requests.length, 1);
  assert.deepEqual(intact.requests[0].files, []);
  assert.equal(intact.requests[0].inventoryScan.complete, true);
  assert.equal(intact.information.length, 1);
});

test('healthy root stat with denied listing cannot certify an empty inventory or start a session', async () => {
  const root = folder('denied-root-listing');
  let discoveries = 0;
  const collect = workspaceScanner(root, {
    rootStat: () => directoryStat(),
    readDirectory: () => { throw new Error('Synthetic listing denial'); },
    findFiles: () => { discoveries += 1; return []; },
  });
  await assert.rejects(collect(root, 100), { code: 'scan_incomplete' });
  assert.equal(discoveries, 0);
  const harness = extensionHarness([root]);
  harness.setScan((folder, signal) => collect(folder, 100, signal));
  await harness.indexCurrentWorkspace();
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.stageRequests.length, 0);
  assert.equal(harness.information.length, 0);
  assert.ok(harness.warnings.some((message) => /Workspace scan incomplete/.test(message)));
});

test('failed fresh production scan preserves published code and starts no full continuation session', async () => {
  for (const reason of ['missing', 'inaccessible', 'replaced']) {
    const root = folder(`failed-continuation-${reason}`);
    const harness = extensionHarness([root], new Map([[root.name, { codeFirstPass: true }]]));
    let published = false;
    const collect = workspaceScanner(root, {
      rootStat: () => {
        if (published && reason !== 'replaced') throw new Error(`Synthetic ${reason} root`);
        return directoryStat(published ? { type: 1 } : {});
      },
      findFiles: () => [file(root, 'main.py')],
    });
    harness.setScan((folder, signal) => collect(folder, 100, signal));
    harness.setCodeStage(async (request) => {
      const checkpoint = { coverage: { state: 'pending', code_ready: true, documentation_pending: true } };
      request.onCodeReady(checkpoint);
      published = true;
      return { outcome: 'code_ready', checkpoint, release_status: { phase: 'aborted' }, full_inventory_complete: false };
    });
    await harness.indexCurrentWorkspace({ recreateCollection: true });
    assert.equal(harness.stageRequests.length, 1);
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.information.length, 0);
    assert.ok(harness.warnings.some((message) => /Workspace scan incomplete.*Published code is preserved; full inventory remains pending/.test(message)));
  }
});

test('cancelled empty discovery on fresh continuation preserves code without starting another session', async () => {
  const root = folder('cancelled-empty-continuation');
  const harness = extensionHarness([root], new Map([[root.name, { codeFirstPass: true }]]));
  let discoveries = 0;
  const collect = workspaceScanner(root, {
    findFiles: () => { if (++discoveries === 1) return [file(root, 'main.py')]; harness.cancel(); return []; },
  });
  harness.setScan((folder, signal) => collect(folder, 100, signal));
  await harness.indexCurrentWorkspace();
  assert.equal(harness.stageRequests.length, 1);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.information.length, 0);
  assert.ok(harness.warnings.some((message) => /Workspace scan incomplete.*Published code is preserved/.test(message)));
});
