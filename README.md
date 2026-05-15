# CorpusWire Clients

The `clients/` tree contains the JavaScript and TypeScript surfaces that talk to
the CorpusWire FastAPI backend. Each package targets a different host, but they
share the same backend concepts:

- `workspaceId` identifies a remote or virtual workspace whose bytes are sent to
  CorpusWire over HTTP.
- `repoPath` identifies a repository path that the CorpusWire service can read
  on its own filesystem.
- `/query` retrieves context from an already populated index.
- `/v1/enhance` rewrites a prompt with retrieved context.
- `/ingest` indexes a service-local directory.
- `/v1/index/*` performs remote-first indexing by accepting manifests and file
  bytes from clients that can see files the service cannot.

## Client Map

| Client | Package | Main role | Indexing capability |
| --- | --- | --- | --- |
| SDK | `clients/corpuswire-sdk` | Reusable Node/TypeScript HTTP client and protocol types | Full and incremental remote indexing with `/v1/index/*` |
| CLI | `clients/corpuswire-cli` | Terminal wrapper for health, search, enhance, and index observability | Does not index; reads index events/activity |
| VS Code extension | `clients/corpuswire-vscode-extension` | Prompt enhancement plus remote workspace indexing for VS Code, Remote SSH, Dev Containers, and Codespaces | Full workspace upload and debounced incremental updates |
| MCP server | `clients/corpuswire-mcp` | stdio MCP server exposing CorpusWire search/enhance to Codex, Copilot, Cursor and other MCP hosts | Service-local incremental `/ingest`; remote indexing must use SDK or VS Code |

## Choosing The Right Ingestion Path

Use remote indexing when the CorpusWire service cannot directly read the files.
This is the normal path for VS Code Remote SSH, Dev Containers, Codespaces,
browser-like workspaces, and any hosted service that cannot mount the user's
repository path.

Use service-local ingest only when `repoPath` or `sourceDir` exists on the
machine running the FastAPI service. A local laptop service reading a local clone
is a valid service-local case. A hosted Render service reading a developer's
Mac path is not.

## Remote Indexing Lifecycle

Remote indexing is a manifest-first protocol exposed by the SDK and used by the
full VS Code extension.

1. The client starts a session with `POST /v1/index/sessions`.
2. The client sends manifest entries to
   `POST /v1/index/sessions/{session_id}/manifest/batch`.
3. The service compares each manifest entry with the stored manifest for the
   workspace and returns `upload_required`, `unchanged`, `deletes`, `skipped`,
   and `errors`.
4. The client uploads only the files listed in `upload_required` to
   `POST /v1/index/sessions/{session_id}/files/batch`.
5. The service validates file size, SHA-256, supported extension, include/exclude
   filters, and the manifest relationship before indexing uploaded files.
6. The client commits with `POST /v1/index/sessions/{session_id}/commit`.

`mode: "full"` means the manifest is the complete workspace snapshot. At commit,
records from older generations that were not seen in the new manifest are
deleted from both the manifest store and vector index. This is the complete
reconciliation path.

`mode: "incremental"` means the manifest describes only changed and deleted
paths. Unmentioned files are left untouched. Deleted files must be sent as
manifest entries with `op: "delete"` through the SDK's `deletedPaths` helper or
the VS Code watcher.

The backend records index events for session start, manifest batches, file
batches, commits, and aborts. Clients can inspect those records through
`GET /v1/index/events` and `GET /v1/index/activity`.

## Service-Local Ingest Lifecycle

The local ingest path is a single `POST /ingest` call with an optional
`repo_path`, `source_dir`, `recreate_collection`, `include_globs`,
`exclude_globs`, and `max_file_size_bytes`.

This path is exposed by the MCP server and Python backend CLI. It is intentionally not a remote
upload protocol: the service walks its own filesystem, applies ingest filters,
updates existing files, detects deletes, and reports counts such as
`files_added`, `files_updated`, `files_deleted`, `files_unchanged`, and
`files_skipped`.

Use `recreate_collection: true` when you want a clean rebuild of the service
local collection. Use the default `false` for incremental updates.

## Build Baseline

All JavaScript clients require Node.js 18 or newer because they rely on the
runtime `fetch`, `Blob`, `TextEncoder`, `AbortController`, and ES module support.

VS Code extensions require VS Code `^1.90.0` and compile with TypeScript. The SDK is dependency
free at runtime and ships committed `dist/` files for consumers.

## Credentials

Do not place credentials in examples, logs, commits, or issue text. Prefer
environment variables or user-level editor configuration for secrets:

```bash
export CORPUSWIRE_BASE_URL=https://context.example.com
export CORPUSWIRE_BASIC_AUTH=username:password
```

For the full VS Code extension, use service-specific API key or Basic Auth
settings in VS Code user settings or the optional home config file rather than
checking secrets into `.vscode/settings.json`.
