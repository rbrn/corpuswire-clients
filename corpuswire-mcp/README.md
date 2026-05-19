# `@corpuswire/mcp`

Node/TypeScript-friendly STDIO MCP server for CorpusWire. It exposes CorpusWire retrieval, prompt enhancement, health, and remote-index sync tools to MCP-compatible hosts such as GitHub Copilot Chat in VS Code, GitHub Copilot CLI, Codex, Cursor, and Claude Desktop.

This package is the preferred distributable MCP entrypoint for the VS Code/Copilot ecosystem. It vendors the built `@corpuswire/sdk` runtime and talks to a running CorpusWire API over HTTP.

## Tools

- `corpuswire_search`: calls `POST /query` for semantic retrieval.
- `corpuswire_enhance_prompt`: calls `POST /v1/enhance` for context-grounded prompt rewriting. It defaults to deterministic local rewriting and retries once with `localOnly=true` if backend generation setup is unavailable.
- `corpuswire_health`: checks backend health.
- `corpuswire_diagnose_workspace`: checks the requested `repoPath` or `workspaceId` before retrieval and returns collection readiness plus recovery actions.
- `corpuswire_doctor`: runs a read-only readiness check across health, diagnosis, sync state, active sessions, and backend activity.
- `corpuswire_sync_delta`: queues changed/deleted paths for remote workspace indexing.
- `corpuswire_sync_flush`: flushes queued sync changes.
- `corpuswire_sync_probe_paths`: classifies paths under current sync filters without queuing or uploading.
- `corpuswire_sync_reconcile`: runs a bounded full workspace reconciliation.
- `corpuswire_sync_git_delta`: scans `git status` and queues modified, added, deleted, renamed, and untracked paths for incremental sync.
- `corpuswire_sync_bootstrap`: diagnoses startup freshness, sets `needsReconcile`, and can explicitly run reconciliation when requested.
- `corpuswire_sync_status`: reports sync queue, watcher, recent event, skip-reason, and latency status.
- `corpuswire_sync_sessions`: lists active remote index sessions visible to the backend, optionally filtered by workspace id.
- `corpuswire_sync_abort_session`: aborts a known remote index session by id after inspection.
- `corpuswire_index_activity`: reports persisted backend index activity and recent index events.

Search and enhancement responses render `Agent context packets` when the API
returns them. These are ordered file-level inspection hints with roles such as
`implementation`, `integration`, `configuration`, `documentation`, and `test`.
Use them as the first files to inspect; raw hits remain available below the
packet block for evidence and citations.

## Build And Test

```bash
cd clients/corpuswire-mcp
npm install
npm test
npm run smoke
```

The package can also run directly from this repository without `npm install` because the server first checks its vendored SDK runtime and then falls back to `clients/corpuswire-sdk/dist` for development.

## Install Locally With npm

You can expose the same `corpuswire-mcp` binary to MCP hosts in any of these ways:

### Direct checkout

Use this when the host runs from the CorpusWire repository checkout.

```json
{
  "command": "node",
  "args": [
    "/Users/constantinaldea/workspace/my-context-engine/clients/corpuswire-mcp/bin/corpuswire-mcp.js"
  ]
}
```

### Global npm install from this checkout

Use this when a host prefers a command name instead of a repository-relative script path.

```bash
npm install --global /Users/constantinaldea/workspace/my-context-engine/clients/corpuswire-mcp
corpuswire-mcp
```

Then configure the MCP host with:

```json
{
  "command": "corpuswire-mcp",
  "args": []
}
```

If the host does not inherit your shell `PATH`, replace `command` with the absolute binary path under the global npm prefix. Find the prefix with:

```bash
npm prefix --global
```

For example, if the prefix is `/opt/homebrew`, use `/opt/homebrew/bin/corpuswire-mcp`.

### npm package or no-global npx

The package is published as `@corpuswire/mcp`, so a normal npm-managed install is also valid:

```bash
npm install --global @corpuswire/mcp
```

For a host where installing global binaries is inconvenient, use `npx`:

```json
{
  "command": "npx",
  "args": ["--yes", "@corpuswire/mcp"]
}
```

For a local checkout without a global install, point `npx` at the local package:

```json
{
  "command": "npx",
  "args": [
    "--yes",
    "--package",
    "/Users/constantinaldea/workspace/my-context-engine/clients/corpuswire-mcp",
    "corpuswire-mcp"
  ]
}
```

`npx` may add startup latency and can require network access for registry installs. For long-running local agent sessions, the direct checkout path or a global npm install is usually more predictable.

To test against a real local Docker CorpusWire API from the repository root:

```bash
bash ./scripts/regression_local_mcp.sh /Users/constantinaldea/workspace/my-context-engine
```

That command runs the Docker/API regression gate, then exercises the Codex wrapper path and this direct Copilot-oriented MCP path against `http://127.0.0.1:${APP_HOST_PORT:-8000}`. When the repository has `.env` with `APP_HOST_PORT`, the script uses that port.

## GitHub Copilot Chat In VS Code

For a workspace-local example, see [../../.vscode/mcp.json.example](../../.vscode/mcp.json.example). To activate it, copy the example to `.vscode/mcp.json`, adjust paths and workspace id, then run **MCP: List Servers** or use the Start button in the VS Code MCP file.

Minimal direct-checkout shape:

```json
{
  "servers": {
    "corpuswire": {
      "command": "node",
      "args": [
        "${workspaceFolder}/clients/corpuswire-mcp/bin/corpuswire-mcp.js"
      ],
      "env": {
        "CORPUSWIRE_BASE_URL": "https://corpuswire.onrender.com",
        "CORPUSWIRE_WORKSPACE_ID": "github://rbrn/corpuswire#main",
        "CORPUSWIRE_OUTPUT_MODE": "copilot",
        "CORPUSWIRE_LOCAL_ONLY": "true",
        "CORPUSWIRE_TOP_K": "5",
        "CORPUSWIRE_SYNC_ENABLED": "false"
      }
    }
  }
}
```

When using the global npm install, use the same `env` block but set `"command": "corpuswire-mcp"` and `"args": []`. See [examples/npm-global-mcp-config.json](examples/npm-global-mcp-config.json).

Keep secrets out of repository config. Put `CORPUSWIRE_BASIC_AUTH` or service tokens in user settings, environment-specific config, or the host's secret store.

## GitHub Copilot CLI

Use the Copilot CLI MCP config shape in [examples/copilot-cli-mcp-config.json](examples/copilot-cli-mcp-config.json), [examples/npm-global-mcp-config.json](examples/npm-global-mcp-config.json), or add it interactively with `/mcp add` as a local/STDIO server. Allowlist read-only tools first:

```json
{
  "tools": [
    "corpuswire_search",
    "corpuswire_enhance_prompt",
    "corpuswire_health",
    "corpuswire_diagnose_workspace",
    "corpuswire_doctor"
  ]
}
```

Enable sync tools only when the server has the intended local workspace root and the target CorpusWire workspace id.

## Correct Configuration

Set `CORPUSWIRE_BASE_URL` to the API that should answer retrieval requests. Use `http://127.0.0.1:8000` for the local Docker/API default, or `https://corpuswire.onrender.com` for the hosted service.

Choose the workspace scope deliberately:

- Use `CORPUSWIRE_WORKSPACE_ID` for remote-indexed workspaces, such as `github://rbrn/corpuswire#main`. This is the right setting for hosted CorpusWire and for MCP hosts that cannot share a local filesystem path with the API.
- Use `CORPUSWIRE_REPO_PATH` only when the CorpusWire API process can read the same local path, such as a local Docker/API regression run where the repository is mounted or visible to the service.
- For remote incremental sync, set both `CORPUSWIRE_WORKSPACE_ID` and `CORPUSWIRE_SYNC_ROOT` to the local checkout that should be watched or scanned, then enable `CORPUSWIRE_SYNC_ENABLED=true`. Keep sync disabled for read-only Copilot/Codex configs.

Recommended prompt settings:

- `CORPUSWIRE_OUTPUT_MODE=copilot` for GitHub Copilot, Copilot CLI, and Auggie-like compact context handoffs.
- `CORPUSWIRE_OUTPUT_MODE=generic` for the Codex plugin wrapper unless a host-specific style is needed.
- `CORPUSWIRE_OUTPUT_MODE=claude-code` for autonomous coding-agent prompts that should include a short plan.
- `CORPUSWIRE_OUTPUT_MODE=sequential` only when you want the strict Requirements, Success Criteria, Checkpoints, Acceptance Criteria, and Impact Analysis contract.
- `CORPUSWIRE_LOCAL_ONLY=true` keeps prompt enhancement deterministic and avoids requiring a generation provider on the backend.
- `CORPUSWIRE_TOP_K=5` is a conservative default; raise it when the task needs broader context.

## Environment

- `CORPUSWIRE_BASE_URL`: backend URL, default `http://127.0.0.1:8000`
- `CORPUSWIRE_WORKSPACE_ID`: remote workspace id for retrieval and sync
- `CORPUSWIRE_REPO_PATH`: service-local repository path for retrieval
- `CORPUSWIRE_OUTPUT_MODE`: `generic`, `copilot`, `claude-code`, or `sequential`
- `CORPUSWIRE_TOP_K`: retrieval chunk count
- `CORPUSWIRE_LOCAL_ONLY`: deterministic rewrite mode, default `true`
- `CORPUSWIRE_BASIC_AUTH`: optional `username:password`
- `CORPUSWIRE_SYNC_ENABLED`: enable remote incremental sync
- `CORPUSWIRE_SYNC_ROOT`: local workspace root readable by this MCP process
- `CORPUSWIRE_SYNC_WATCH`: optional best-effort `fs.watch` watcher
- `CORPUSWIRE_SYNC_DEBOUNCE_MS`: debounce delay for queued deltas
- `CORPUSWIRE_SYNC_MAX_PENDING_PATHS`: pending changed/deleted path count that forces a flush
- `CORPUSWIRE_SYNC_FLUSH_BEFORE_READ`: attempt a bounded flush before search/enhance
- `CORPUSWIRE_SYNC_READ_FLUSH_TIMEOUT_MS`: max pre-read flush wait
- `CORPUSWIRE_SYNC_BOOTSTRAP_CHECK`: run a startup freshness diagnosis when sync starts, default `false`
- `CORPUSWIRE_SYNC_BOOTSTRAP_TIMEOUT_MS`: max startup/bootstrap diagnosis wait, default `5000`
- `CORPUSWIRE_SYNC_MTIME_CACHE_ENABLED`: enable durable metadata-only mtime/hash duplicate suppression, default `false`
- `CORPUSWIRE_SYNC_STATE_DIR`: directory for MCP sync metadata caches, default `$XDG_CACHE_HOME/corpuswire/mcp-sync` or `~/.cache/corpuswire/mcp-sync`
- `CORPUSWIRE_SYNC_GIT_TIMEOUT_MS`: max wait for git status and metadata commands, default `5000`
- `CORPUSWIRE_SYNC_GIT_MAX_FILES`: max git status entries processed by one git delta scan, default `1000`
- `CORPUSWIRE_SYNC_GIT_MAX_STATUS_BYTES`: max buffered output from `git status -z`, default `1048576`
- `CORPUSWIRE_SYNC_GIT_DELTA_BEFORE_READ`: run a bounded git delta scan and flush before search/enhance, default `false`
- `CORPUSWIRE_SYNC_READ_FRESHNESS_CHECK`: refresh bootstrap freshness before search/enhance, default `false`
- `CORPUSWIRE_SYNC_READ_FRESHNESS_TIMEOUT_MS`: max read-side freshness diagnosis wait, default `5000`
- `CORPUSWIRE_SYNC_READ_STRICT`: block search/enhance when read freshness says reconciliation is needed, default `false`
- `CORPUSWIRE_SYNC_READ_STRICT_STALE_AFTER_MS`: optional grace period before strict mode blocks stale reads, default `0`
- `CORPUSWIRE_SYNC_RECONCILE_INTERVAL_MS`: optional scheduled full reconciliation interval
- `CORPUSWIRE_SYNC_RECONCILE_MAX_FILES`: max files scanned by one reconciliation run
- `CORPUSWIRE_SYNC_SESSION_CONFLICT_RETRY_ATTEMPTS`: active-session 409 retry attempts before requeueing, default `5`
- `CORPUSWIRE_SYNC_SESSION_CONFLICT_RETRY_DELAY_MS`: base active-session retry delay, default `750`
- `CORPUSWIRE_SYNC_SESSION_CONFLICT_RETRY_MAX_DELAY_MS`: active-session retry delay ceiling, default `5000`

`corpuswire_sync_bootstrap` is diagnostic by default. It calls workspace diagnosis, reports `bootstrapState` and `needsReconcile` in sync status, and returns recovery actions when the remote index is stale, degraded, missing, or blocked. It uploads files only when called with `"reconcile": true`.

When `CORPUSWIRE_SYNC_MTIME_CACHE_ENABLED=true`, incremental sync writes a JSON metadata cache containing relative paths, size, mtime, SHA-256, and last decision. It never stores file contents. The cache suppresses duplicate changed-file uploads across MCP restarts when size and mtime match, re-hashes same-size files when mtime changes, and is ignored while bootstrap says the remote index needs reconciliation. Full reconciliation does not use the cache because it must send a complete inventory.

`corpuswire_sync_git_delta` runs `git status --porcelain=v1 -z --untracked-files=all --ignored=no`, so gitignored files are not uploaded. Renames are sent as delete-old plus upload-new. The same CorpusWire include/exclude filters and extension allowlist still apply before anything is queued.

Read-side freshness preparation runs before `corpuswire_search` and `corpuswire_enhance_prompt`. It always performs the configured bounded queue flush. When enabled, it also runs git delta before retrieval and refreshes bootstrap freshness. Stale or degraded indexes are surfaced in the tool response even when hits exist. Strict mode is off by default and blocks retrieval only when explicitly enabled.

If a flush reports `409 Conflict` because an index session is already active for the workspace, the MCP server retries with bounded backoff before requeueing. Retry counts and the last conflict message are visible in `corpuswire_sync_status` as `sessionConflictRetries` and `lastSessionConflict*` fields. Backend builds with remote-session idle expiry clear stale locks automatically after `REMOTE_INDEX_SESSION_IDLE_TIMEOUT_SECONDS`; SDK builds from 2026-05-17 onward also abort failed high-level sessions on the client side.

Use `corpuswire_sync_sessions` when a sync stays blocked or when several agents share a remote workspace. The tool calls `GET /v1/index/sessions`, returns active session id, workspace id, collection, mode, phase, manifest revision, queue depth, indexed file count, age, idle age, timeout, and error count, and does not mutate backend state.

Use `corpuswire_sync_abort_session` only when an inspected session is clearly stale, failed, or owned by an abandoned agent. It calls the backend session abort endpoint with the exact session id and releases that workspace lock.

Use `corpuswire_index_activity` when process-local sync status is not enough. It reads persisted backend activity and recent events, including last attempt/success, failure counts, gap detection, operation, status, manifest revision, files indexed/deleted/skipped, bytes uploaded, duration, and errors or warnings.

Use `corpuswire_sync_probe_paths` before queuing uncertain edits. It applies the same root, extension, include, exclude, size, and file-existence checks as sync, then reports `upload_candidate`, `delete_candidate`, or `skipped` with the skip reason. It does not mutate queue or backend state.

Use `corpuswire_doctor` as the quick replacement-readiness check before trusting CorpusWire in a long Codex session. It returns `ready`, `attention`, or `blocked` from backend health, workspace diagnosis, process-local sync state, active sessions, and persisted activity.

For the local Docker app on an existing dense-only Qdrant collection, keep `APP_QDRANT_HYBRID_ENABLED=false` unless you intentionally recreate the collection for hybrid named vectors. A dense/hybrid mismatch raises a backend writer error; current backend builds close the failed remote session so retry attempts are not blocked by a stale active-session lock.
