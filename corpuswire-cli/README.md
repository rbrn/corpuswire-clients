# `cw`

Node.js CLI for CorpusWire health checks, semantic search, prompt enhancement,
and observable workspace indexing. It delegates typed HTTP behavior to
`@corpuswire/sdk` and keeps this package focused on argument parsing and
terminal output.

## Scope

The Node CLI defaults to the existing local Docker service at
`http://127.0.0.1:18080`. No host Python installation is required.

From any repository folder:

```bash
cw init                 # Save reusable, secret-free local workspace settings
cw doctor               # Read-only readiness and inventory checks
cw                      # Index, then watch this folder until Ctrl+C
cw --once               # Index once and exit (for scripts)
cw watch                # Explicit persistent watch, including non-TTY use
cw reconcile            # Explicit full reconciliation, with preview/confirmation
cw --help               # Show supported commands without indexing
cw version              # Show this CLI's version without contacting the service
```

`init` configures the CLI workspace; it does not install Docker, create service
credentials, register a new MCP server, or replace existing editor/MCP settings.
`init --index --verify` also indexes and checks readiness. Bare local invocation
runs the normal full-index preview and indexing without another confirmation;
in an interactive terminal it then watches for source changes. Piped/non-TTY bare
calls, `--once`, and explicit `index`/`reconcile` remain one-shot; explicit
`watch` or `--watch` stays open in either environment. Explicit `index`/`reconcile` retain the existing confirmation unless `--yes` is
provided. Hosted upload and collection rebuild are never implicitly enabled.

Existing workspace identities, include/exclude filters and file-size limits are
retained. New unconfigured identities include a directory fingerprint so two
folders with the same name do not share an index. Present malformed settings
stop the operation rather than silently falling back to a broader scan.
Environment authentication takes precedence. The CLI can also read an owner-only
`~/.local/share/corpuswire/cli-credentials.json` file, with credentials scoped to
exact local service URLs; malformed, shared or symlinked files are rejected.
On macOS, the existing OS keychain is an additional fallback. No token is written
into workspace settings. A new folder still requires authorization from the local
service; a scope error is reported rather than bypassed.

The Node CLI executable is `cw`; the Python management CLI remains `corpuswire`.
They can coexist, including in an activated Python virtual environment. Check
`type -a cw`, `cw --version`, and `cw --help` to confirm the intended Node
installation. `version`, `--version`, and `-V` report the Node CLI version
offline; they do not report the Docker backend version. `corpuswire_doctor`
remains an MCP tool, not a shell executable.

If startup reports `CorpusWire API unavailable`, the error names the resolved
service URL. Start Docker Desktop and your existing CorpusWire service for a
loopback URL, then run `cw doctor`. The CLI connects to that existing
service; it does not start Docker or create containers. An unexpected URL can
come from `CORPUSWIRE_BASE_URL`, workspace `.vscode/settings.json`,
`.vscode/mcp.json` or `.mcp.json`, or the CorpusWire user profile. Inspect those
settings or explicitly select the intended service with `--api-base-url <url>`.
Authentication rejections retain their separate HTTP errors.

The CLI supports:

- `init` for idempotent local workspace configuration.
- `doctor` for read-only service, authorization and verified inventory readiness.
- `health` for backend and active index status.
- `version` (or `--version` / `-V`) for the installed CLI version, offline.
- `search` and `query` for `POST /query` retrieval.
- `enhance` or a bare prompt for `POST /v1/enhance`.
- `index-events` for `GET /v1/index/events`.
- `index-activity` for `GET /v1/index/activity`.
- `index` and `reconcile` for previewed, confirmed workspace indexing with live
  `index-progress/v1` output.

`cw index` defaults the source root to the current folder. It resolves
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

Run the source-tree executable:

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
  /tmp/corpuswire-snapshot/corpuswire-cli-0.1.4-beta.3.tgz
/tmp/corpuswire-install/node_modules/.bin/cw --version
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
| `--api-base-url` or `CORPUSWIRE_BASE_URL` | Backend base URL | Defaults to `http://127.0.0.1:18080` |
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
cw health
cw health --workspace-id github://rbrn/corpuswire#main --json
```

Search an already indexed workspace:

```bash
cw search "where is remote indexing committed?" \
  --workspace-id github://rbrn/corpuswire#main \
  --top-k 5
```

Enhance a prompt:

```bash
cw enhance "document the VS Code index watcher" \
  --workspace-id github://rbrn/corpuswire#main \
  --output-mode claude-code
```

Use the bare prompt shorthand:

```bash
cw "fix stale remote search results" \
  --workspace-id github://rbrn/corpuswire#main
```

Inspect recent indexing events:

```bash
cw index-events \
  --workspace-id github://rbrn/corpuswire#main \
  --status completed \
  --limit 10
```

Inspect freshness activity:

```bash
cw index-activity \
  --workspace-id github://rbrn/corpuswire#main
```

Preview and index the current folder against a local service:

```bash
cd /path/to/reviewed-workspace
cw index \
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
cw index --yes --non-interactive --ndjson --trace
cw index --attach 8a4f... --api-base-url http://127.0.0.1:18080
```

## Automatic watching

Run `cw` in the repository terminal and leave it open while you edit.
The initial full reconciliation is followed by native filesystem notifications,
a 500 ms quiet-edit delay, and a complete content scan every 10 seconds as a
fallback for missed events. Change these with `--debounce-ms` and `--poll-ms`.
Unchanged eligible content makes no backend requests. Actual changes publish a
complete filtered inventory; the backend requests only changed file uploads and
removes deleted eligible paths after verification. At most one cycle runs at a
time, with edits during indexing queued for the next cycle.

Watching respects existing file selection, credentials and workspace identity.
It does not recreate collections or broaden access. Root replacement, changed
workspace/service/filters/credentials, authentication rejection, unverified
completion or detached work stops the watcher with an error. Transient scan or
network failures retry at most three times; the last verified digest remains
unchanged. Continuous edits defer publication until a stable scan is possible.
A local filesystem is not an atomic snapshot; a later edit can race publication,
but notifications and periodic scans converge to the next stable inventory.

Ctrl+C or SIGTERM closes the watcher and cancels this process's active indexing;
it does not cancel another process's session. A second interrupt can detach.
Watch HTTP requests have a 30-second deadline, including response-body reads.
The first interrupt cancels read-only preflight immediately, while mutation
requests let the SDK identify and cancel its own session. A second interrupt
can abort the transport; the backend may still need verification afterward.
Use `cw doctor` to check readiness. `watch --ndjson` includes structured
`watch-progress/v1` lifecycle records alongside normal index progress.

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
- `index` shows a live TTY bar for the current phase, its completion percentage,
  a separately labeled file-based overall percentage, elapsed and phase time,
  work units, throughput, queue depth, retries, ETA confidence, and heartbeat.
  For example, `580/1455 chunks` means `phase 39.9%` during embedding; an
  unchanged `overall 89.1%` counts completed file decisions and can remain fixed
  while a file is embedding. Unknown or zero phase totals are indeterminate.
  A phase reaching 100% is separate from verified overall completion. Redirected output uses line-oriented updates; `--ndjson` emits the
  same semantic events as JSON records.

Use `--json` when another process needs the full backend envelope.

## Full inventory evidence

A successful full scan supplies a canonical inventory after the existing preview and confirmation. Read errors, disappearing files, cancellation and detected file changes stop the scan before mutation. The effective file-size ceiling is the minimum of the configured and advertised server limits. Selection policies include default directory exclusions; excluded counts cover inspected files, not descendants of excluded directories.

Terminal and NDJSON results distinguish session verification, inventory coverage, acknowledged file transfers and sender attempts. Legacy services report unknown coverage. An intentionally empty full inventory can be verified while there is no searchable content.
