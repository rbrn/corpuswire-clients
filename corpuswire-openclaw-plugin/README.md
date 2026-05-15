# CorpusWire OpenClaw Plugin

This package exposes the CorpusWire API as an OpenClaw plugin. Retrieval can target either a service-local repository path or a remote-indexed `workspaceId`.

## Requirements

- OpenClaw `2026.4.20` or newer.
- Node.js 18 or newer.
- A running CorpusWire API, usually:

```bash
uvicorn corpuswire.api.app:app --reload
```

## Install Into OpenClaw

From this repository:

```bash
openclaw plugins install --link /path/to/corpuswire/clients/corpuswire-openclaw-plugin
openclaw plugins enable corpuswire
```

Configure the plugin for a remote-indexed workspace:

```bash
openclaw config set plugins.entries.corpuswire.config '{"baseUrl":"https://context.example.com","workspaceId":"vscode-remote://ssh/project","topK":5,"minScore":0.15}' --strict-json --merge
```

Use `repoPath` only when the FastAPI service can see that path on its own filesystem.
Transient gateway failures from hosted services are retried by default. Tune with `requestRetryAttempts` and `requestRetryDelayMs` when needed.

To use it as OpenClaw's context-engine slot:

```bash
openclaw config set plugins.slots.contextEngine '"corpuswire"' --strict-json
```

If the CorpusWire API uses Basic Auth, prefer an environment variable:

```bash
export CORPUSWIRE_BASIC_AUTH='username:password'
```

## Tools

- `corpuswire_search`: retrieves repository or remote workspace context through `POST /query`.
- `corpuswire_enhance`: rewrites a prompt through `POST /v1/enhance`.
- `corpuswire_ingest`: incrementally updates a service-local repository index through `POST /ingest`. Remote workspaces must be uploaded through `/v1/index`.

## CLI Commands

After OpenClaw loads the plugin:

```bash
openclaw corpuswire health
openclaw corpuswire ingest --repo /path/to/repo
openclaw corpuswire search "where is OpenClaw memory configured?" --workspace-id vscode-remote://ssh/project
openclaw corpuswire enhance "fix remote indexing search"
```

## Auto Context

There are two automatic context paths:

- `plugins.slots.contextEngine = "corpuswire"` uses the context-engine adapter and `contextEngineAutoContext` defaults to `true`.
- `autoContext = true` enables the compatibility `before_prompt_build` hook.

Use one automatic path at a time to avoid duplicate context. Explicit tools are always available.
The context-engine adapter also exposes OpenClaw `ingest` / `ingestBatch` for service-local repositories. For remote clients, run the VS Code remote index command or an SDK client using `/v1/index/*` so file bytes are uploaded over HTTP.
