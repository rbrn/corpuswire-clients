# CorpusWire VS Code Extension

VS Code extension for replacing selected prompt text with a repository-context-grounded rewrite and indexing VS Code workspaces into configurable `corpuswire` services.

## Usage

1. Configure the remote enhancer service URL and any required authentication.
2. Select prompt text in an editor.
3. Run `CorpusWire: Enhance Prompt` from the command palette.

The extension sends the selected text to `POST /v1/enhance` through `@corpuswire/sdk` and replaces the selected range with the returned enhanced prompt.

For a prompt editing surface, run `CorpusWire: Open Prompt Panel`. The panel can be seeded from the current selection, enhance arbitrary prompt text, and insert or copy the result.

To populate a remote index for VS Code Remote SSH, Dev Containers, Codespaces, or any non-local workspace, run `CorpusWire: Index Workspace`. The extension reads files through `vscode.workspace.fs` and uploads file contents to the configured indexer service with the `/v1/index/*` protocol.

## Configuration Priority

Settings are resolved in this order:

1. Workspace settings in `.vscode/settings.json`.
2. User settings, including VS Code User settings and optional home config at `~/.config/corpuswire/vscode-extension.json` or `~/.corpuswire/vscode-extension.json`.
3. Hardcoded defaults.

## Settings

- `corpuswire.baseUrl`: compatibility fallback URL when service URLs are unset. Defaults to `http://127.0.0.1:8000`.
- `corpuswire.serviceDefaults.url`: shared remote service URL for indexer, enhancer, and semantic search.
- `corpuswire.serviceDefaults.apiKey`: shared API key. With the default `Authorization` header, it is sent as `Bearer <key>`.
- `corpuswire.serviceDefaults.apiKeyHeader`: shared API key header name. Defaults to `Authorization`.
- `corpuswire.serviceDefaults.basicAuth`: shared `username:password` Basic Auth credentials.
- `corpuswire.serviceDefaults.headers`: shared HTTP headers.
- `corpuswire.services.indexer.*`: indexer-specific `url`, `apiKey`, `apiKeyHeader`, `basicAuth`, and `headers`.
- `corpuswire.services.enhancer.*`: enhancer-specific `url`, `apiKey`, `apiKeyHeader`, `basicAuth`, and `headers`.
- `corpuswire.services.semanticSearch.*`: semantic-search-specific `url`, `apiKey`, `apiKeyHeader`, `basicAuth`, and `headers`.
- `corpuswire.repoPath`: repository path for retrieval. Empty uses the first workspace folder.
- `corpuswire.topK`: retrieval chunk count. Defaults to `5`.
- `corpuswire.outputMode`: one of `generic`, `copilot`, `claude-code`, or `sequential`. Defaults to `generic`.
- `corpuswire.localOnly`: use deterministic local rewrites instead of first trying the configured generation provider. Defaults to `false`; the extension still falls back to local mode if generation is unavailable.
- `corpuswire.remoteIndexing.enabled`: use `workspace_id` for prompt enhancement and enable the remote indexing command/watch flow.
- `corpuswire.remoteIndexing.autoWatch`: send debounced incremental updates from VS Code file-system events.
- `corpuswire.remoteIndexing.workspaceId`: stable workspace id. Empty uses the first workspace folder URI.
- `corpuswire.remoteIndexing.maxConcurrentUploads`: client-side concurrency hint sent to the indexer.
- `corpuswire.remoteIndexing.batchBytes`: target remote upload batch size.

Legacy `corpuswireContextEngine.baseUrl`, `corpuswireContextEngine.workspaceId`, and `corpuswireContextEngine.outputMode` settings are still read as compatibility fallbacks. The legacy `corpuswireContextEngine.enhancePrompt` and `corpuswireContextEngine.openPanel` command IDs are also registered, but new configuration should use the `corpuswire.*` namespace.

Example workspace configuration:

```json
{
  "corpuswire.serviceDefaults.url": "https://context.example.com",
  "corpuswire.serviceDefaults.apiKey": "shared-service-token",
  "corpuswire.services.enhancer.url": "https://enhancer.example.com",
  "corpuswire.services.semanticSearch.headers": {
    "X-Tenant-ID": "engineering"
  },
  "corpuswire.repoPath": "${workspaceFolder}",
  "corpuswire.topK": 8
}
```

The optional home config can use nested keys:

```json
{
  "serviceDefaults": {
    "url": "https://context.example.com",
    "apiKey": "shared-service-token"
  },
  "services": {
    "enhancer": {
      "url": "https://enhancer.example.com"
    },
    "semanticSearch": {
      "headers": {
        "X-Tenant-ID": "engineering"
      }
    }
  }
}
```
