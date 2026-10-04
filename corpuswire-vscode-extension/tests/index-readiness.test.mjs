import { isRetrievalExcludedPath } from "../../corpuswire-sdk/dist/index.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the compiled production scanner with injected VS Code filesystem IO.
const source = await readFile(new URL('../dist/extension.js', import.meta.url), 'utf8');
const start = source.indexOf('async function collectUriFiles(');
const end = source.indexOf('\nfunction relativePathForUri', start);
assert.ok(start > 0 && end > start);
function scanner(fs) {
  const vscode = { FileType: { Directory: 2, SymbolicLink: 64 }, workspace: { fs } };
  return new Function('vscode', 'relativePathForUri', 'isRetrievalExcludedPath', `${source.slice(start, end)}; return collectUriFiles;`)(vscode, (uri) => uri, isRetrievalExcludedPath);
}

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
  assert.deepEqual((await collect(['.github/a.yml', 'src/.private.json', 'package.json', 'requirements-dev.txt', 'a.tfvars.json'], 100, true)).files, []);
});
