# `@corpuswire/sdk`

Zero-dependency Node/TypeScript SDK for the `corpuswire` prompt-enhancement backend.

## Scope

- Calls `GET /v1/health` with fallback to `GET /health`
- Calls `POST /query` for semantic retrieval with `repoPath` or `workspaceId`
- Calls `POST /v1/enhance` with fallback to `POST /enhance`
- Calls `/v1/index/*` for remote-first workspace indexing sessions
- Retries transient `502`/`503`/`504` and connection reset failures with bounded backoff
- Mirrors the backend rewrite result shape, including:
  - `request_id`
  - `duration_ms`
  - `task_type`
  - `task_type_source`
  - `task_type_classification_error`
  - `context_summary`
  - `summary_generation_error`
  - `output_mode`
  - retrieved chunk metadata and citations
- Parses the stable `/v1/enhance` error envelope into `CorpusWireHttpError`

## Design

- `src/`: TypeScript source of the reusable SDK
- `dist/`: committed JavaScript runtime plus type declarations, so the SDK stays dependency-free
- `examples/`: integration examples, including a Codex/OpenClaw workflow

## Usage

```ts
import { CorpusWireClient, requireEnhancedPrompt } from "@corpuswire/sdk";

const client = new CorpusWireClient({
  baseUrl: "http://127.0.0.1:8000",
});

const rewrite = await client.enhance({
  prompt: "fix the login bug",
  workspaceId: "vscode-remote://ssh/project",
  outputMode: "claude-code",
  topK: 6,
});

const enhancedPrompt = requireEnhancedPrompt(rewrite);
console.log(enhancedPrompt);
```

Semantic search against a remote-indexed workspace:

```ts
const hits = await client.semanticSearch({
  query: "where is remote indexing committed?",
  workspaceId: "vscode-remote://ssh/project",
  topK: 5,
});
```

Remote indexing is explicit and content-upload based. Use `workspaceId` for remote or virtual workspaces; use `repoPath` only when the backend service can see that path on its own filesystem.

If the backend rejects the request, the thrown `CorpusWireHttpError` includes:

- `requestId`
- `durationMs`
- `errorCode`
- `errorMessage`
- the parsed `errorEnvelope` when the backend returned the stable error shape

## Codex/OpenClaw Example

See [examples/codex-openclaw-workflow.ts](/Users/constantinaldea/workspace/corpuswire/clients/corpuswire-sdk/examples/codex-openclaw-workflow.ts).

That example shows how to:

1. Request an enhanced prompt from the FastAPI backend.
2. Use the returned `enhanced_prompt` as the input prompt for `openclaw capability model run --json`.
3. Keep prompt enhancement in Python while using Node.js for agent orchestration.
