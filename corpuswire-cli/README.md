# `corpuswire`

Thin Node CLI for the `corpuswire` prompt-enhancement backend.

## Purpose

This package now owns only CLI concerns:

- argument parsing
- terminal-oriented output formatting
- delegating HTTP and typed backend interaction to the reusable SDK in `clients/corpuswire-sdk/`

That separation follows the service-plan guidance:

- `clients/corpuswire-sdk/`: reusable TypeScript SDK
- `clients/corpuswire/`: CLI only
- `src/corpuswire/`: Python backend only

## Usage

```bash
node ./bin/corpuswire.js "fix the strategy bug"
node ./bin/corpuswire.js enhance "clarify the schema migration prompt" --output-mode claude-code
node ./bin/corpuswire.js search "where is remote indexing committed?" --workspace-id vscode-remote://ssh/project
node ./bin/corpuswire.js health
```

## Optional environment variables

```bash
export CORPUSWIRE_BASE_URL=http://127.0.0.1:8000
export CORPUSWIRE_BASIC_AUTH=username:password
export CORPUSWIRE_WORKSPACE_ID=vscode-remote://ssh/project
export CORPUSWIRE_REPO_PATH=/service/local/path
```

## Notes

- The CLI prefers `POST /v1/enhance` and falls back to `POST /enhance`.
- `--workspace-id` selects a remote-indexed workspace. `--repo-path` is only for paths visible to the backend service.
- Pass `--json` to inspect the full backend response instead of only the rewritten prompt.
- Programmatic usage should go through `clients/corpuswire-sdk/`.
