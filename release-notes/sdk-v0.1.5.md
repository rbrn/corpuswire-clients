SDK 0.1.5 adds `workspace-identity`, the one rule every CorpusWire client uses to decide which workspace a folder belongs to. `resolveWorkspaceIdentity` checks an explicit argument, then `CORPUSWIRE_WORKSPACE_ID`, then the folder's `.vscode/settings.json`, `.vscode/mcp.json` and `.mcp.json`, then the user profile, and finally the derived `cw` folder default. It reports which source won. `deriveWorkspaceId` and `parseJsonc` (for VS Code style settings with comments and trailing commas) are exported too. The SDK still has zero runtime dependencies.

Also in this release:

- Types for the engine's server-packed evidence: `EvidenceSpan` and `PackingReport`, including `spans_dropped_conflict` and the optional `spans_clipped_budget` (older engines omit it).
- The SDK now schedules the engine's systems-language files (such as `.c`, `.cpp`, `.h`, `.go` and `.rb`) as code. Before, a full reconcile that included them failed with a 409. A test compares the list with the engine's registry so the two cannot drift again.

Existing calls are unchanged. Validation: 245 SDK tests pass.

Download the archive with its SHA256 file. This is a GitHub prerelease; npm publication is not claimed. The coordinated runtime is v0.1.40-beta.1.
