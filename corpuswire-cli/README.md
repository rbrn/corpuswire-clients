# `corpuswire`

Thin Node.js CLI for CorpusWire health checks, semantic search, prompt
enhancement, and index observability. It delegates all typed HTTP behavior to
`@corpuswire/sdk` and keeps this package focused on argument parsing and
terminal output.

## Scope

The CLI supports:

- `health` for backend and active index status.
- `search` and `query` for `POST /query` retrieval.
- `enhance` or a bare prompt for `POST /v1/enhance`.
- `index-events` for `GET /v1/index/events`.
- `index-activity` for `GET /v1/index/activity`.

The CLI does not perform ingestion. Use the full VS Code extension or SDK for
remote `/v1/index/*` indexing, and use the Python backend CLI
for service-local `/ingest`.

## Architecture

| Path | Purpose |
| --- | --- |
| `bin/corpuswire.js` | Executable entrypoint |
| `lib/cli.js` | Argument parsing, command dispatch, and terminal formatting |
| `package.json` | Binary metadata and local SDK dependency |
| `tests/cli.test.js` | Node tests for parsing, command dispatch, search formatting, and index observability |

`runCliCommand()` constructs a `CorpusWireClient` with the resolved base URL and
Basic Auth credentials. Command handlers then call SDK methods and format the
result for humans unless `--json` is provided.

## Install And Build

Node.js 18 or newer is required.

```bash
cd /Users/constantinaldea/workspace/my-context-engine/clients/corpuswire-cli
npm install
```

Run the local executable:

```bash
node ./bin/corpuswire.js health
```

Link it into your shell while developing:

```bash
cd /Users/constantinaldea/workspace/my-context-engine/clients/corpuswire-cli
npm link
corpuswire health
```

Run tests:

```bash
cd /Users/constantinaldea/workspace/my-context-engine
node --test clients/corpuswire-cli/tests/cli.test.js
```

## Configuration

Command-line flags override environment defaults.

| Source | Setting | Purpose |
| --- | --- | --- |
| `--api-base-url` or `CORPUSWIRE_BASE_URL` | Backend base URL | Defaults to `http://127.0.0.1:8000` |
| `--basic-auth` or `CORPUSWIRE_BASIC_AUTH` | Basic Auth credentials | Sent as HTTP Basic Auth by the SDK |
| `--workspace-id` or `CORPUSWIRE_WORKSPACE_ID` | Remote workspace selector | Used for remote-indexed retrieval/enhancement |
| `--repo-path` or `CORPUSWIRE_REPO_PATH` | Service-local path selector | Only valid when the service can see that path |
| `--top-k` | Retrieval count | For search/enhance |
| `--min-score` | Retrieval threshold | For search/enhance |
| `--output-mode` | Prompt style | `generic`, `copilot`, `claude-code`, or `sequential` |
| `--local-only` | Deterministic rewrite | Disables backend LLM generation for enhancement |
| `--json` | Raw response output | Useful for automation and debugging |

Example environment:

```bash
export CORPUSWIRE_BASE_URL=https://context.example.com
export CORPUSWIRE_WORKSPACE_ID=github://rbrn/corpuswire#main
```

Avoid storing Basic Auth values or bearer tokens in shell history.

## Usage Examples

Check the backend:

```bash
node ./bin/corpuswire.js health
node ./bin/corpuswire.js health --workspace-id github://rbrn/corpuswire#main --json
```

Search an already indexed workspace:

```bash
node ./bin/corpuswire.js search "where is remote indexing committed?" \
  --workspace-id github://rbrn/corpuswire#main \
  --top-k 5
```

Enhance a prompt:

```bash
node ./bin/corpuswire.js enhance "document the VS Code index watcher" \
  --workspace-id github://rbrn/corpuswire#main \
  --output-mode claude-code
```

Use the bare prompt shorthand:

```bash
node ./bin/corpuswire.js "fix stale remote search results" \
  --workspace-id github://rbrn/corpuswire#main
```

Inspect recent indexing events:

```bash
node ./bin/corpuswire.js index-events \
  --workspace-id github://rbrn/corpuswire#main \
  --status completed \
  --limit 10
```

Inspect freshness activity:

```bash
node ./bin/corpuswire.js index-activity \
  --workspace-id github://rbrn/corpuswire#main
```

## Ingestion And Update Behavior

This CLI is intentionally read-only with respect to ingestion. It can observe
index state, but it does not send manifests, upload file bytes, call `/ingest`,
or mutate a collection.

For complete ingestion:

- Use `clients/corpuswire-vscode-extension` and run
  `CorpusWire: Index Workspace` for a full remote upload from VS Code.
- Use `@corpuswire/sdk` and call `indexWorkspace({ mode: "full", ... })` from a
  custom Node client.

For updates to already ingested content:

- Use the VS Code extension's remote watcher when
  `corpuswire.remoteIndexing.autoWatch` is enabled.
- Use the SDK with `mode: "incremental"`, changed `files`, and `deletedPaths`.

The CLI helps verify those flows after they run:

- `index-events` shows session, manifest, file batch, commit, and failure
  records when the backend event store is enabled.
- `index-activity` reports last attempt, last success, consecutive failures,
  and freshness gap detection.
- `search --json` shows retrieval warnings and index context returned by
  `/query`.

## Output Model

Default output is compact and human-readable:

- `health` prints status, CorpusWire enabled state, and Qdrant collection.
- `search` prints numbered chunks with source path, heading, score, and snippet.
- `enhance` prints only the selected enhanced prompt text.
- `index-events` prints one line per event with timestamp, status, operation,
  source, and counts.
- `index-activity` prints freshness fields.

Use `--json` when another process needs the full backend envelope.
