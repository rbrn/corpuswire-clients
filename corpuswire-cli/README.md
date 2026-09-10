# `corpuswire`

Node.js CLI for CorpusWire health checks, semantic search, prompt enhancement,
and observable workspace indexing. It delegates typed HTTP behavior to
`@corpuswire/sdk` and keeps this package focused on argument parsing and
terminal output.

## Scope

The CLI supports:

- `health` for backend and active index status.
- `search` and `query` for `POST /query` retrieval.
- `enhance` or a bare prompt for `POST /v1/enhance`.
- `index-events` for `GET /v1/index/events`.
- `index-activity` for `GET /v1/index/activity`.
- `index` for previewed, confirmed remote workspace indexing with live
  `index-progress/v1` output.

`corpuswire index` defaults the source root to the current folder. It resolves
the destination from explicit flags, workspace settings, user profile settings,
or a stable `local-docker://<folder-slug>#main` folder identity. It scans and
hashes locally, asks the backend for a read-only manifest preview, and prints the
resolved workspace, source, service/profile, candidate/excluded counts, bytes,
expected full/incremental/no-change mode, and destructive risk before mutation.

## Architecture

| Path | Purpose |
| --- | --- |
| `bin/corpuswire.js` | Executable entrypoint |
| `lib/cli.js` | Argument parsing, command dispatch, and terminal formatting |
| `package.json` | Binary metadata and public SDK dependency |
| `tests/cli.test.js` | Node tests for parsing, command dispatch, search formatting, and index observability |

`runCliCommand()` constructs a `CorpusWireClient` with the resolved base URL and
Basic Auth credentials. Command handlers then call SDK methods and format the
result for humans unless `--json` is provided.

## Install And Build

Node.js 18 or newer is required.

```bash
cd /path/to/corpuswire-clients/corpuswire-cli
npm install
```

Run the local executable:

```bash
node ./bin/corpuswire.js health
```

Build and install a local package snapshot without a source-tree entrypoint:

```bash
cd /path/to/corpuswire-clients
npm pack ./corpuswire-sdk --pack-destination /tmp/corpuswire-snapshot
npm pack ./corpuswire-cli --pack-destination /tmp/corpuswire-snapshot
npm install --prefix /tmp/corpuswire-install \
  /tmp/corpuswire-snapshot/corpuswire-sdk-0.1.3.tgz \
  /tmp/corpuswire-snapshot/corpuswire-cli-0.1.3.tgz
/tmp/corpuswire-install/node_modules/.bin/corpuswire --version
```

Run tests:

```bash
cd /path/to/corpuswire-clients
node --test corpuswire-cli/tests/cli.test.js
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

Index-specific controls include `--source-root`, `--profile local|hosted`,
repeatable `--include` and `--exclude`, `--mode full|incremental`, `--yes`,
`--non-interactive`, `--timeout-ms`, `--attach`, `--ndjson`, and `--trace`. The local
profile accepts only a loopback service; the hosted profile requires HTTPS.
Credentials are never printed.

`--trace` adds a content-free `index-observability/v1` record with client file
discovery/read/hash time, server receipt and model-wait time when the backend
enables `INDEX_OBSERVABILITY_ENABLED=true`, durable queue/chunk/embed/write/
cleanup timings, warm/cold model state, total time, and a bounded error state.
It never records file contents, prompts, credentials, or request headers.

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

Preview and index the current folder against a local service:

```bash
cd /path/to/reviewed-workspace
corpuswire index \
  --profile local \
  --api-base-url http://127.0.0.1:18080 \
  --workspace-id local-docker://reviewed-workspace#main \
  --exclude '.env*' \
  --exclude 'private/**'
```

The mutation prompt is exactly:

```text
Start indexing this workspace? [y/N]
```

EOF, an empty answer, or `n` exits without starting a session. Automation must
use both `--non-interactive` and `--yes`. A destructive `--rebuild` adds a
second confirmation; non-interactive rebuilds must also pass
`--confirm-rebuild <exact-workspace-id>`.

Stream machine-readable progress or follow an existing session:

```bash
corpuswire index --yes --non-interactive --ndjson --trace
corpuswire index --attach 8a4f... --api-base-url http://127.0.0.1:18080
```

## Ingestion And Update Behavior

The index command sends a complete manifest in full mode, uploads only files the
backend requests, and commits stale-file reconciliation after verification.
Incremental mode updates only files included in that invocation; it does not
remove unmentioned paths. A second identical full run is reported as
`no_change` in the preview and avoids re-embedding unchanged files.

Ctrl+C sends a real backend abort and waits for acknowledgement. A second Ctrl+C
detaches and reports the session id and reattachment command. An explicit
`--timeout-ms` also detaches rather than falsely marking the backend run failed.

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
- `index` shows a live TTY bar with phase, defensible percentage, elapsed and
  phase time, work units, throughput, queue depth, retries, ETA confidence, and
  heartbeat. Redirected output uses line-oriented updates; `--ndjson` emits the
  same semantic events as JSON records.

Use `--json` when another process needs the full backend envelope.

## Full inventory evidence

A successful full scan supplies a canonical inventory after the existing preview and confirmation. Read errors, disappearing files, cancellation and detected file changes stop the scan before mutation. The effective file-size ceiling is the minimum of the configured and advertised server limits. Selection policies include default directory exclusions; excluded counts cover inspected files, not descendants of excluded directories.

Terminal and NDJSON results distinguish session verification, inventory coverage, acknowledged file transfers and sender attempts. Legacy services report unknown coverage. An intentionally empty full inventory can be verified while there is no searchable content.
