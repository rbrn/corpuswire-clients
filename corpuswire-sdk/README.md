# `@corpuswire/sdk`

Zero-dependency Node/TypeScript SDK for the CorpusWire FastAPI backend. This is
the lowest-level JavaScript client in the repository and the package other
clients should use when they need typed access to retrieval, prompt rewriting,
health, index observability, or remote indexing.

## What It Provides

- `GET /v1/health` with fallback to `GET /health`.
- `POST /query` for semantic retrieval against `repoPath` or `workspaceId`.
- `POST /v1/enhance` with fallback to `POST /enhance` unless `endpointMode` is
  set to `v1-only`.
- `GET /v1/index/capabilities` for remote indexing limits.
- `GET /v1/index/events` and `GET /v1/index/activity` for index observability.
- Full remote indexing session helpers for `/v1/index/*`.
- Bounded retries for transient `502`, `503`, `504`, connection reset, timeout,
  refused connection, pipe, and Undici socket failures.
- Stable error parsing through `CorpusWireHttpError`, including backend request
  id, duration, error code, error message, detail, and the raw error envelope.

The package is runtime dependency free and targets Node.js 18 or newer.

## Package Layout

| Path | Purpose |
| --- | --- |
| `src/client.ts` | `CorpusWireClient`, request payload mapping, remote indexing orchestration, helper functions |
| `src/http.ts` | HTTP transport, endpoint fallback, retries, Basic Auth header generation, error parsing |
| `src/types.ts` | Public TypeScript types for prompt, retrieval, health, and index protocol payloads |
| `src/index.ts` | Public exports |
| `dist/` | Committed JavaScript and declaration files used by consumers |
| `examples/` | Integration examples |
| `tests/client.test.js` | Node test coverage for payload mapping, retries, fallback endpoints, and remote indexing |

## Install And Build

From a sibling client package, use the local file dependency already present in
this repository:

```json
{
  "dependencies": {
    "@corpuswire/sdk": "file:../corpuswire-sdk"
  }
}
```

The SDK ships committed `dist/` output. If you change TypeScript source, rebuild
with the workspace TypeScript toolchain and rerun the tests:

```bash
cd /Users/constantinaldea/workspace/my-context-engine
npx tsc -p clients/corpuswire-sdk/tsconfig.json
node --test clients/corpuswire-sdk/tests/client.test.js
```

If you are consuming the package directly from Node:

```ts
import { CorpusWireClient } from "./clients/corpuswire-sdk/dist/index.js";
```

## Client Construction

```ts
import { CorpusWireClient } from "@corpuswire/sdk";

const client = new CorpusWireClient({
  baseUrl: "https://context.example.com",
  endpointMode: "compat",
  defaultHeaders: {
    "X-Tenant-ID": "engineering",
  },
});
```

Constructor options:

| Option | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `CORPUSWIRE_BASE_URL` or `http://127.0.0.1:8000` | Trailing slashes are normalized by the transport |
| `basicAuth` | `CORPUSWIRE_BASIC_AUTH` or empty | Encoded as `Authorization: Basic ...` |
| `endpointMode` | `compat` | `compat` tries versioned then legacy endpoints where supported; `v1-only` disables legacy fallback |
| `fetchFn` | `globalThis.fetch` | Useful for tests or nonstandard runtimes |
| `defaultHeaders` | `{}` | Applied to every request; request-specific headers can override |

## Prompt Enhancement

```ts
import {
  CorpusWireClient,
  requireEnhancedPrompt,
} from "@corpuswire/sdk";

const client = new CorpusWireClient({
  baseUrl: "http://127.0.0.1:8000",
});

const result = await client.enhance({
  prompt: "fix the remote indexing stale hit filter",
  workspaceId: "github://rbrn/corpuswire#main",
  outputMode: "claude-code",
  topK: 6,
  minScore: 0.15,
});

console.log(requireEnhancedPrompt(result));
```

`enhance()` returns the `result` payload directly. Use `enhanceRaw()` when you
need `ok`, `request_id`, or `duration_ms` from the response envelope.

`requireEnhancedPrompt()` returns `enhanced_prompt` when present, falls back to
the deterministic `enhancement_prompt`, and throws if neither exists.

## Semantic Search

```ts
const hits = await client.semanticSearch({
  query: "where is remote indexing committed?",
  workspaceId: "github://rbrn/corpuswire#main",
  topK: 5,
});

for (const hit of hits) {
  console.log(hit.metadata.source_path, hit.score);
}
```

Use `workspaceId` for remote-indexed workspaces. Use `repoPath` only when the
FastAPI service can read that path on its own filesystem.

## Health And Index Observability

```ts
const health = await client.health({
  workspaceId: "github://rbrn/corpuswire#main",
});

console.log(health.index?.health_status);
```

```ts
const events = await client.getIndexEvents({
  workspaceId: "github://rbrn/corpuswire#main",
  status: "completed",
  limit: 10,
});

const activity = await client.getIndexActivity({
  workspaceId: "github://rbrn/corpuswire#main",
  windowHours: 24,
  expectedIntervalSeconds: 3600,
});

console.log(events.length, activity.gap_detected);
```

`getIndexEvents()` is useful when debugging a specific session, manifest batch,
file batch, commit, or abort. `getIndexActivity()` is useful for monitoring
whether a workspace has had recent successful indexing and whether a freshness
gap has been detected.

## Complete Remote Ingestion

The SDK owns the complete remote indexing choreography through
`indexWorkspace()`. This helper starts a session, sends a manifest, uploads only
files the server requests, and commits the session.

```ts
const commit = await client.indexWorkspace({
  workspace: {
    workspaceId: "github://rbrn/corpuswire#main",
    displayRoot: "github://rbrn/corpuswire#main",
    name: "corpuswire",
  },
  mode: "full",
  client: {
    name: "custom-indexer",
    transport: "node",
    indexed_commit: "866ff1680ed21e80b35323212516baf2bb211932",
  },
  includeGlobs: ["**/*.md", "**/*.ts", "**/*.py"],
  excludeGlobs: ["**/.git/**", "**/node_modules/**", "**/dist/**"],
  files: [
    {
      relativePath: "README.md",
      content: "# CorpusWire\n",
    },
    {
      relativePath: "src/index.ts",
      content: "export {};\n",
    },
  ],
  batchBytes: 4 * 1024 * 1024,
  maxConcurrentUploads: 4,
});

console.log(commit.status.files_indexed, commit.status.files_deleted);
```

Use `mode: "full"` when the file list represents the complete workspace
snapshot. The backend stores a new manifest generation and, during commit,
deletes stale records from older generations that were not present in the new
manifest. This is how complete re-ingestion reconciles removed files.

Set `recreateCollection: true` when the target collection should be recreated
before uploaded files are indexed. That is a stronger reset than a normal full
session and should be used only when a clean rebuild is intended.

## Incremental Updates To Existing Ingested Content

Use `mode: "incremental"` when sending only changes since the last successful
index. Changed files are sent as `files`; deleted files are sent through
`deletedPaths`.

```ts
await client.indexWorkspace({
  workspace: {
    workspaceId: "github://rbrn/corpuswire#main",
    displayRoot: "github://rbrn/corpuswire#main",
  },
  mode: "incremental",
  client: {
    name: "custom-watcher",
    transport: "fs-events",
  },
  files: [
    {
      relativePath: "clients/README.md",
      content: "# CorpusWire Clients\n",
    },
  ],
  deletedPaths: [
    "docs/old-indexing-notes.md",
  ],
});
```

For each file, the SDK computes SHA-256 if `sha256` is omitted and computes
`mtimeNs` from the current time if omitted. The manifest batch uses those values
to let the backend decide whether the file is unchanged or must be uploaded.

Important update semantics:

- Unchanged manifest entries are not uploaded again.
- Changed files replace old vectors after the backend validates size, hash, and
  manifest membership.
- Deleted paths remove matching manifest records and vector documents.
- Incremental sessions do not delete unmentioned files. Use `mode: "full"` for
  complete stale-file reconciliation.

## Low-Level Remote Indexing API

`indexWorkspace()` is the preferred helper. Use the low-level methods when you
need custom batching or progress reporting:

```ts
const session = await client.startIndexSession({
  workspace: { workspaceId: "workspace-1" },
  mode: "incremental",
});

const manifest = await client.sendManifestBatch(session.session_id, [
  {
    relativePath: "README.md",
    op: "upsert",
    size: 12,
    mtimeNs: Date.now() * 1_000_000,
    sha256: "known-sha256",
  },
  {
    relativePath: "old.md",
    op: "delete",
  },
]);

console.log(manifest.upload_required);

const status = await client.getIndexSessionStatus(session.session_id);
console.log(status.phase, status.queue_depth);

await client.abortIndexSession(session.session_id);
```

The backend refuses commit while uploads are still missing. In that case,
`commitIndexSession()` returns a `409` error through `CorpusWireHttpError`.

## Error Handling

```ts
import { CorpusWireHttpError } from "@corpuswire/sdk";

try {
  await client.enhance("help");
} catch (error) {
  if (error instanceof CorpusWireHttpError) {
    console.error(error.status, error.requestId, error.errorMessage);
  } else {
    throw error;
  }
}
```

The SDK retries transient gateway and socket failures. It does not retry stable
request errors such as invalid prompt payloads, unsupported output modes, or
incomplete index sessions.
