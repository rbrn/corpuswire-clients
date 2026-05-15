# CorpusWire VS Code Extension

VS Code extension for prompt enhancement and remote-first workspace indexing.
This is the richest editor client in `clients/`: it can upload workspace file
contents through `/v1/index/*`, keep an existing index fresh with debounced file
watcher updates, and use the indexed workspace when replacing selected prompt
text with a CorpusWire rewrite.

Use this extension for VS Code Remote SSH, Dev Containers, Codespaces, or any
workspace where the CorpusWire service cannot read local paths directly.

## Capabilities

- `CorpusWire: Enhance Prompt` replaces selected prompt text with a
  context-grounded rewrite from `/v1/enhance`.
- `CorpusWire: Index Workspace` performs a complete remote indexing session for
  the current workspace.
- Optional file watcher sends incremental updates for changed and deleted files.
- Service-specific configuration for indexer, enhancer, and semantic search
  endpoints.
- API key, Basic Auth, and custom header support.
- Optional home config at `~/.config/corpuswire/vscode-extension.json` or
  `~/.corpuswire/vscode-extension.json`.
- Local fallback enhancement when generation is unavailable but the backend can
  still return deterministic `enhancement_prompt` output.

## Package Layout

| Path | Purpose |
| --- | --- |
| `src/extension.ts` | Command registration, indexing command, file watcher, prompt enhancement flow, error formatting |
| `src/configuration.ts` | VS Code settings, home config loading, service inheritance, header construction, repo/workspace resolution |
| `package.json` | VS Code contribution points, settings schema, scripts, and local SDK dependency |
| `tsconfig.json` | TypeScript compiler options |
| `dist/` | Generated extension runtime after compilation |

The extension relies on `@corpuswire/sdk` for all HTTP protocol calls.

## Install And Build

```bash
cd /Users/constantinaldea/workspace/my-context-engine/clients/corpuswire-vscode-extension
npm install
npm run compile
```

Run during development:

1. Open the extension folder in VS Code.
2. Press `F5`.
3. In the Extension Development Host, open a workspace.
4. Run `CorpusWire: Index Workspace` or `CorpusWire: Enhance Prompt`.

Package a VSIX:

```bash
cd /Users/constantinaldea/workspace/my-context-engine/clients/corpuswire-vscode-extension
npm run package
```

## Configuration Resolution

Settings are resolved in this order:

1. Workspace-folder setting.
2. Workspace setting.
3. User setting.
4. Optional home config.
5. Hardcoded default.

Object settings such as headers are merged from fallback to more specific
scopes. String, number, and boolean settings use the first configured value.

Home config can be either nested:

```json
{
  "serviceDefaults": {
    "url": "https://context.example.com",
    "apiKey": "shared-service-token"
  },
  "services": {
    "enhancer": {
      "url": "https://enhancer.example.com"
    }
  }
}
```

or prefixed:

```json
{
  "corpuswire.serviceDefaults.url": "https://context.example.com",
  "corpuswire.remoteIndexing.enabled": true
}
```

## Core Settings

| Setting | Default | Description |
| --- | --- | --- |
| `corpuswire.baseUrl` | `http://127.0.0.1:8000` | Compatibility fallback URL when service URLs are unset |
| `corpuswire.userConfigPath` | empty | Optional explicit home config file |
| `corpuswire.repoPath` | first workspace folder | Service-local path used only when remote indexing is disabled |
| `corpuswire.topK` | `5` | Retrieval chunk count for prompt enhancement |
| `corpuswire.outputMode` | `generic` | `generic`, `copilot`, `claude-code`, or `sequential` |
| `corpuswire.localOnly` | `false` | Ask backend for deterministic local rewrite instead of generation |

## Service Settings

`serviceDefaults` applies to `indexer`, `enhancer`, and `semanticSearch` unless a
service-specific setting overrides it.

| Setting family | Fields |
| --- | --- |
| `corpuswire.serviceDefaults.*` | `url`, `apiKey`, `apiKeyHeader`, `basicAuth`, `headers` |
| `corpuswire.services.indexer.*` | `url`, `apiKey`, `apiKeyHeader`, `basicAuth`, `headers` |
| `corpuswire.services.enhancer.*` | `url`, `apiKey`, `apiKeyHeader`, `basicAuth`, `headers` |
| `corpuswire.services.semanticSearch.*` | `url`, `apiKey`, `apiKeyHeader`, `basicAuth`, `headers` |

When `apiKeyHeader` is `Authorization`, the extension sends
`Authorization: Bearer <apiKey>`. Otherwise it sends the raw API key as the
configured header value. Basic Auth is encoded as `Authorization: Basic ...` if
no Authorization header has already been provided.

## Remote Indexing Settings

| Setting | Default | Description |
| --- | --- | --- |
| `corpuswire.remoteIndexing.enabled` | `false` | Enables remote-first indexing and sends `workspace_id` in enhancement requests |
| `corpuswire.remoteIndexing.autoWatch` | `false` | Watches file create/change/delete events and sends incremental updates |
| `corpuswire.remoteIndexing.workspaceId` | first workspace folder URI | Stable workspace identity for remote indexing |
| `corpuswire.remoteIndexing.maxConcurrentUploads` | `4` | Client concurrency hint for SDK upload batches |
| `corpuswire.remoteIndexing.batchBytes` | `4194304` | Target maximum bytes per upload batch |

Example workspace settings:

```json
{
  "corpuswire.serviceDefaults.url": "https://context.example.com",
  "corpuswire.remoteIndexing.enabled": true,
  "corpuswire.remoteIndexing.autoWatch": true,
  "corpuswire.remoteIndexing.workspaceId": "github://rbrn/corpuswire#main",
  "corpuswire.outputMode": "claude-code",
  "corpuswire.topK": 8
}
```

Keep secrets out of committed `.vscode/settings.json`. Use VS Code user
settings or the home config file for API keys and Basic Auth values.

## Complete Workspace Ingestion

Run `CorpusWire: Index Workspace` to perform a full remote indexing session.

The command:

1. Reads settings for the first workspace folder.
2. Requires a stable `remoteIndexing.workspaceId`.
3. Creates `CorpusWireClient` for the configured indexer service with
   `endpointMode: "v1-only"`.
4. Finds workspace files with:
   `**/*.{md,txt,csv,pdf,java,py,sh,cjs,js,jsx,mjs,ts,tsx,json,toml,yaml,yml}`.
5. Excludes:
   `.git`, `.vscode`, `node_modules`, `dist`, `build`, `target`, and
   `__pycache__`.
6. Reads file bytes through `vscode.workspace.fs`, so remote and virtual VS Code
   file systems work.
7. Calls `client.indexWorkspace({ mode: "full", files, ... })`.

In full mode, the SDK sends a complete manifest. The backend compares the new
manifest generation with stored records, skips unchanged files, asks the client
to upload only changed or new files, and deletes stale records during commit.
This is the correct path for initial indexing and complete reconciliation after
large workspace changes.

## Incremental Updates To Already Ingested Content

Enable automatic updates:

```json
{
  "corpuswire.remoteIndexing.enabled": true,
  "corpuswire.remoteIndexing.autoWatch": true,
  "corpuswire.remoteIndexing.workspaceId": "github://rbrn/corpuswire#main"
}
```

When enabled at activation time, the extension creates a VS Code file-system
watcher for the same include glob used by full indexing. It batches events for
one second:

- Created and changed files are deduplicated by URI and uploaded as changed
  `files`.
- Deleted files are converted to relative paths and sent as `deletedPaths`.
- If a file is created or changed and then deleted before flush, the delete wins
  for that URI.
- The SDK sends `mode: "incremental"`.

Incremental mode updates only mentioned files and deleted paths. It does not
remove stale files that were never mentioned in the update batch. Run
`CorpusWire: Index Workspace` again when you need complete stale-file
reconciliation.

The extension silently tolerates files disappearing between watcher event and
upload. The next watcher event or full index run heals state.

## Prompt Enhancement Flow

`CorpusWire: Enhance Prompt` requires an active editor selection.

The command:

1. Reads settings for the active document.
2. Builds an enhancer `CorpusWireClient` with service-specific headers.
3. Builds an `EnhancePromptRequest` with selected text, `outputMode`, `topK`,
   and `localOnly`.
4. If remote indexing is enabled and a `workspaceId` is configured, sends
   `workspaceId`.
5. Otherwise, sends `repoPath` when available.
6. Calls `/v1/enhance`.
7. Replaces the selection with `enhanced_prompt`, `rewritten_prompt`, or
   `augmented_prompt`.
8. If generation failed and `localOnly` was not already set, retries with
   `localOnly: true` and uses the deterministic `enhancement_prompt`.

This means prompt enhancement follows the same workspace identity as indexing:
remote-first workspaces use `workspaceId`; service-local workflows can still use
`repoPath`.

## Example Workflows

Initial remote index and prompt enhancement:

1. Configure `serviceDefaults.url`.
2. Set `remoteIndexing.enabled` to `true`.
3. Set a stable `remoteIndexing.workspaceId`.
4. Run `CorpusWire: Index Workspace`.
5. Select a prompt and run `CorpusWire: Enhance Prompt`.

Keep a remote index current:

1. Complete the initial full index.
2. Enable `remoteIndexing.autoWatch`.
3. Reload VS Code so activation registers the watcher with the new setting.
4. Edit files normally.
5. Use SDK/CLI `index-events` or backend health/activity to inspect freshness.

Service-local prompt enhancement without remote indexing:

```json
{
  "corpuswire.serviceDefaults.url": "http://127.0.0.1:8000",
  "corpuswire.remoteIndexing.enabled": false,
  "corpuswire.repoPath": "${workspaceFolder}"
}
```

This mode assumes the FastAPI service can read `${workspaceFolder}`. It is not
valid for hosted services that cannot mount the local path.

## Operational Notes

- `remoteIndexing.workspaceId` should be stable across sessions. Changing it
  creates or targets a different remote collection.
- Full indexing is the only extension command that performs complete stale-file
  reconciliation.
- Watcher updates are best-effort and incremental. They are not a substitute for
  periodic full reconciliation when file state may have changed while VS Code
  was closed.
- The extension currently does not expose a semantic-search command, but service
  settings include `semanticSearch` for shared configuration consistency.
- Backend `index-events` and `index-activity` are the preferred way to diagnose
  stale or failed update flows.
