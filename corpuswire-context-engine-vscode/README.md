# CorpusWire Context Engine — VS Code Extension

A focused VS Code extension that enhances selected prompts by sending them to the CorpusWire `POST /v1/enhance` endpoint and replacing the selection with the returned context-grounded, rewritten instruction.

## Usage

1. Open any file and select a base prompt (natural-language instruction or query).
2. Open the Command Palette (`⇧⌘P`) and run **CorpusWire Context Engine: Enhance Prompt**.
3. The selected text is replaced in-place with the context-grounded rewrite returned by the CorpusWire service.

## Configuration

All settings live under the `corpuswireContextEngine` namespace and are resource-scoped (per workspace folder).

| Setting | Default | Description |
|---|---|---|
| `corpuswireContextEngine.baseUrl` | `""` | Base URL of the CorpusWire FastAPI service. When empty the extension checks the `CORPUSWIRE_BASE_URL` environment variable, then falls back to `http://127.0.0.1:8000`. |
| `corpuswireContextEngine.workspaceId` | `""` | Remote workspace identifier forwarded in every enhance request. Leave empty to omit the field and let the server route by repository path. |
| `corpuswireContextEngine.outputMode` | `"generic"` | Prompt output style passed to the `PromptEnhancer` orchestration layer. Accepted values: `generic`, `copilot`, `claude-code`, `sequential`. |

### Example `.vscode/settings.json`

```json
{
  "corpuswireContextEngine.baseUrl": "https://corpuswire.onrender.com",
  "corpuswireContextEngine.workspaceId": "github://rbrn/corpuswire#main",
  "corpuswireContextEngine.outputMode": "claude-code"
}
```

## How It Works

1. The extension reads the three settings above to build an `EnhancePromptRequest`.
2. It calls `CorpusWireClient.enhance()` from `@corpuswire/sdk`, which `POST`s to `/v1/enhance`.
3. The service runs `PromptEnhancer`: retrieves relevant context chunks from the indexed workspace, classifies the task type, assembles a context-grounded enhancement prompt, and optionally rewrites the instruction with a configured LLM.
4. The extension prefers `enhanced_prompt` (LLM rewrite) and falls back to `enhancement_prompt` (deterministic local assembly) so it always returns something useful even when no LLM is configured.

## Development

```bash
cd clients/corpuswire-context-engine-vscode
npm install
npm run compile
```

Press **F5** in VS Code to launch an Extension Development Host for local testing.
