# CorpusWire OpenClaw Plugin

OpenClaw plugin that exposes CorpusWire retrieval, prompt enhancement,
service-local ingest, and a context-engine adapter. It is the right client when
OpenClaw should retrieve CorpusWire context automatically or when OpenClaw tools
should call the CorpusWire API directly.

## Requirements

- OpenClaw `2026.4.20` or newer.
- Node.js 18 or newer.
- A reachable CorpusWire FastAPI service:

```bash
uvicorn corpuswire.api.app:app --reload
```

For remote-indexed workspaces, the service can be hosted. For local `/ingest`,
the service must be able to read the path you pass as `repoPath` or `sourceDir`.

## Package Layout

| Path | Purpose |
| --- | --- |
| `index.js` | Plugin registration, tool definitions, OpenClaw CLI commands, hooks, and service registration |
| `lib/client.js` | Plugin-specific HTTP client, config normalization, retries, timeouts, and local `/ingest` guardrails |
| `lib/format.js` | Tool result formatting, prompt context wrapping, snippet escaping, and token estimates |
| `lib/openclaw-context-engine.js` | OpenClaw context-engine adapter, `assemble`, `ingest`, and `ingestBatch` |
| `openclaw.plugin.json` | Plugin metadata, tool contract, UI hints, and config schema |
| `tests/plugin.test.js` | Node test coverage for registration, formatting, retries, auto context, and ingest behavior |

The plugin keeps its own small HTTP client rather than importing the SDK so it
can honor OpenClaw timeout, retry, abort-signal, config, and plugin lifecycle
expectations directly.

## Install Into OpenClaw

From this repository:

```bash
openclaw plugins install --link /Users/constantinaldea/workspace/my-context-engine/clients/corpuswire-openclaw-plugin
openclaw plugins enable corpuswire
```

Configure a remote-indexed workspace:

```bash
openclaw config set plugins.entries.corpuswire.config \
  '{"baseUrl":"https://context.example.com","workspaceId":"github://rbrn/corpuswire#main","topK":5,"minScore":0.15}' \
  --strict-json --merge
```

Configure a service-local repository:

```bash
openclaw config set plugins.entries.corpuswire.config \
  '{"baseUrl":"http://127.0.0.1:8000","repoPath":"/Users/constantinaldea/workspace/my-context-engine","topK":5}' \
  --strict-json --merge
```

To make CorpusWire the OpenClaw context-engine slot:

```bash
openclaw config set plugins.slots.contextEngine '"corpuswire"' --strict-json
```

If the API requires Basic Auth, prefer an environment variable:

```bash
export CORPUSWIRE_BASIC_AUTH='username:password'
```

## Build And Test

```bash
cd /Users/constantinaldea/workspace/my-context-engine/clients/corpuswire-openclaw-plugin
npm test
```

There is no compile step. The package is plain ES modules.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8000` | CorpusWire FastAPI base URL |
| `basicAuth` | `CORPUSWIRE_BASIC_AUTH` or empty | Optional `username:password` credentials |
| `repoPath` | `CORPUSWIRE_REPO_PATH` or unset | Service-local repository root |
| `workspaceId` | `CORPUSWIRE_WORKSPACE_ID` or unset | Remote indexed workspace id |
| `topK` | `5` | Default retrieval count |
| `minScore` | `0.15` | Default retrieval score threshold |
| `maxContextChars` | `6000` | Maximum injected context text |
| `requestTimeoutMs` | `30000` | Request timeout |
| `requestRetryAttempts` | `2` | Transient retry count |
| `requestRetryDelayMs` | `250` | Linear retry base delay |
| `autoContext` | `false` | Compatibility `before_prompt_build` hook |
| `contextEngineAutoContext` | `true` | Auto context when the plugin owns the context-engine slot |

Use either `autoContext` or the context-engine slot path for automatic context.
Keeping both active can duplicate retrieved snippets.

## Registered Tools

### `corpuswire_search`

Calls `POST /query` and returns formatted retrieved chunks.

```json
{
  "query": "where is prompt enhancement implemented?",
  "workspaceId": "github://rbrn/corpuswire#main",
  "topK": 5,
  "minScore": 0.15
}
```

### `corpuswire_enhance`

Calls `POST /v1/enhance` with fallback to `/enhance`, then returns the best
available enhanced prompt.

```json
{
  "prompt": "document the remote indexing update flow",
  "workspaceId": "github://rbrn/corpuswire#main",
  "outputMode": "claude-code",
  "localOnly": false
}
```

### `corpuswire_ingest`

Calls local `POST /ingest`. This tool is only for repositories visible to the
CorpusWire service process.

```json
{
  "repoPath": "/Users/constantinaldea/workspace/my-context-engine",
  "recreateCollection": false,
  "includeGlobs": ["**/*.md", "**/*.py", "**/*.ts"],
  "excludeGlobs": ["**/.git/**", "**/node_modules/**"],
  "maxFileSizeBytes": 524288
}
```

If only `workspaceId` is configured and no service-local `repoPath` or
`sourceDir` is available, the plugin rejects ingestion with an error explaining
that remote workspaces must upload through `/v1/index`.

## OpenClaw CLI Commands

After OpenClaw loads the plugin:

```bash
openclaw corpuswire health
openclaw corpuswire search "where is OpenClaw context assembled?" \
  --workspace-id github://rbrn/corpuswire#main
openclaw corpuswire enhance "fix stale index activity docs" --mode claude-code
openclaw corpuswire ingest --repo /Users/constantinaldea/workspace/my-context-engine
```

Local ingest with filters:

```bash
openclaw corpuswire ingest \
  --repo /Users/constantinaldea/workspace/my-context-engine \
  --include-glob "**/*.md" \
  --include-glob "**/*.ts" \
  --exclude-glob "**/dist/**" \
  --max-file-size-bytes 524288
```

Clean local rebuild:

```bash
openclaw corpuswire ingest \
  --repo /Users/constantinaldea/workspace/my-context-engine \
  --recreate
```

## Context-Engine Adapter

When registered as the OpenClaw context engine, the adapter exposes:

- `bootstrap()`: reports that CorpusWire does not bootstrap OpenClaw transcripts.
- `maintain()`: leaves transcript maintenance to OpenClaw.
- `assemble(params)`: retrieves context for the current prompt and returns
  `systemPromptAddition`.
- `compact()`: reports that CorpusWire does not compact transcripts.
- `ingest(params)`: calls the local incremental `/ingest` path.
- `ingestBatch(params)`: calls local `/ingest` once and summarizes the result.

`assemble()` wraps snippets in `<corpuswire-context>` and escapes retrieved text
before prompt injection. It treats snippets as untrusted context, not
instructions.

## Complete Ingestion And Updates

The OpenClaw plugin supports service-local ingestion only.

Use this path when:

- OpenClaw is running near the CorpusWire service.
- The FastAPI process can read the requested repo path.
- You want one command or tool call to update a local Qdrant collection.

The request body sent to `/ingest` contains:

- `repo_path` or `source_dir`.
- `recreate_collection`, defaulting to `false`.
- Optional `include_globs` and `exclude_globs`.
- Optional `max_file_size_bytes`.

The backend walks the service-local directory, indexes supported files, updates
changed files, deletes stale records it detects for that local source, and
returns counts. The plugin formats those counts as:

- `documentsIndexed`
- `chunksIndexed`
- `filesAdded`
- `filesUpdated`
- `filesDeleted`
- `vectorSize`

Use `recreateCollection: true` or `--recreate` for a complete local rebuild.
Use the default incremental mode to update already ingested content without
recreating the collection.

For remote workspaces, do not use this plugin to ingest. Use:

- `clients/corpuswire-vscode-extension` with `CorpusWire: Index Workspace`, or
- `@corpuswire/sdk` with `indexWorkspace({ mode: "full" | "incremental" })`.

The plugin can still retrieve and enhance against those remote indexes by
setting `workspaceId`.

## Failure And Retry Behavior

The plugin retries transient gateway responses and retryable socket failures
according to `requestRetryAttempts` and `requestRetryDelayMs`. It uses
OpenClaw's abort signal when available and applies `requestTimeoutMs` to each
attempt.

Stable request failures, invalid config, missing local paths, and remote
workspace-only ingest attempts are returned as failed tool results instead of
throwing raw exceptions into OpenClaw.
