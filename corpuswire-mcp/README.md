# `@corpuswire/mcp`

Node/TypeScript-friendly STDIO MCP server for CorpusWire. It exposes CorpusWire retrieval, prompt enhancement, health, and remote-index sync tools to MCP-compatible hosts such as GitHub Copilot Chat in VS Code, GitHub Copilot CLI, Codex, Cursor, and Claude Desktop.

This package is the preferred distributable MCP entrypoint for the VS Code/Copilot ecosystem. It vendors the built `@corpuswire/sdk` runtime and talks to a running CorpusWire API over HTTP.

## Tools

- `corpuswire_search`: calls `POST /query` for semantic retrieval.
- `corpuswire_enhance_prompt`: calls `POST /v1/enhance` for context-grounded prompt rewriting. It defaults to deterministic local rewriting and retries once with `localOnly=true` if backend generation setup is unavailable.
- `corpuswire_health`: checks backend health.
- `corpuswire_diagnose_workspace`: checks the requested `repoPath` or `workspaceId` before retrieval and returns collection readiness plus recovery actions.
- `corpuswire_sync_delta`: queues changed/deleted paths for remote workspace indexing.
- `corpuswire_sync_flush`: flushes queued sync changes.
- `corpuswire_sync_reconcile`: runs a bounded full workspace reconciliation.
- `corpuswire_sync_status`: reports sync queue and watcher status.

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

To test against a real local Docker CorpusWire API from the repository root:

```bash
bash ./scripts/regression_local_mcp.sh /Users/constantinaldea/workspace/my-context-engine
```

That command runs the Docker/API regression gate, then exercises the Codex wrapper path and this direct Copilot-oriented MCP path against `http://127.0.0.1:${APP_HOST_PORT:-8000}`. When the repository has `.env` with `APP_HOST_PORT`, the script uses that port.

## GitHub Copilot Chat In VS Code

For a workspace-local example, see [../../.vscode/mcp.json.example](../../.vscode/mcp.json.example). To activate it, copy the example to `.vscode/mcp.json`, adjust paths and workspace id, then run **MCP: List Servers** or use the Start button in the VS Code MCP file.

Minimal shape:

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
        "CORPUSWIRE_LOCAL_ONLY": "true"
      }
    }
  }
}
```

Keep secrets out of repository config. Put `CORPUSWIRE_BASIC_AUTH` or service tokens in user settings, environment-specific config, or the host's secret store.

## GitHub Copilot CLI

Use the Copilot CLI MCP config shape in [examples/copilot-cli-mcp-config.json](examples/copilot-cli-mcp-config.json), or add it interactively with `/mcp add` as a local/STDIO server. Allowlist read-only tools first:

```json
{
  "tools": ["corpuswire_search", "corpuswire_enhance_prompt", "corpuswire_health", "corpuswire_diagnose_workspace"]
}
```

Enable sync tools only when the server has the intended local workspace root and the target CorpusWire workspace id.

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
