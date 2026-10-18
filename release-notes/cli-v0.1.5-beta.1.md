CLI 0.1.5-beta.1 adds `cw mcp`:

- `cw mcp serve` runs the CorpusWire MCP server.
- `cw mcp install --host claude-code|vscode|copilot-cli|codex` writes a host config that launches `cw mcp serve` instead of a checkout path. It takes a backup first and refuses entries it did not write, or files with comments, unless you pass `--force`. `--dry-run` previews the change.
- `cw mcp doctor --host ...` checks a host's config and runs a live handshake.

`cw search`, `cw enhance` and `cw health` now use the folder's configured or indexed workspace, through the SDK 0.1.5 identity rule. They fall back to the backend default with a note when the folder has no index yet.

The archive bundles MCP 0.1.5-beta.1 and SDK 0.1.5, so `cw mcp serve` works from an offline install. `CORPUSWIRE_MCP_SERVER_PATH` points it at another server build.

Validation: 101 CLI tests pass, including a real `cw mcp serve` handshake. On the Mac, `cw mcp doctor --host codex` passed. Download the archive with its SHA256 file. This is a GitHub prerelease; npm publication is not claimed. The coordinated runtime is v0.1.40-beta.1.
