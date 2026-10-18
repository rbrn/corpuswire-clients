SDK 0.1.5 adds `workspace-identity`, the one rule every CorpusWire client uses to decide which workspace a folder belongs to. `resolveWorkspaceIdentity` checks an explicit argument, then `CORPUSWIRE_WORKSPACE_ID`, then the folder's `.vscode/settings.json`, `.vscode/mcp.json` and `.mcp.json`, then the user profile, and finally the derived `cw` folder default. It reports which source won. `deriveWorkspaceId` and `parseJsonc` (for VS Code style settings with comments and trailing commas) are exported too. The SDK still has zero runtime dependencies.

Existing calls are unchanged. Validation: 245 SDK tests pass.

Download the archive with its SHA256 file. This is a GitHub prerelease; npm publication is not claimed. The coordinated runtime is v0.1.40-beta.1.
