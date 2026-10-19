MCP 0.1.5-beta.1 serves Claude Code, VS Code Copilot and Copilot CLI as well as Codex.

- The server detects the host from `initialize`, negotiates the protocol version (2025-06-18, 2025-03-26 or 2024-11-05) and returns server instructions. Ratings are filed under the detected host instead of always `codex`.
- When no workspace is configured, read tools find it from the host's folder: MCP roots, `CLAUDE_PROJECT_DIR`, `CORPUSWIRE_SYNC_ROOT` or the git top level, then that folder's settings, MCP configs, user profile or the `cw` folder default. A derived default is used only when the backend reports an index for it. Each result names where the identity came from.
- Every tool has a title and MCP annotations (read-only, destructive, idempotent). Review-context requests start a backend job, so they are marked as writes.
- New opt-in flags, each a rollback switch: `CORPUSWIRE_HOST`, `CORPUSWIRE_IDENTITY_RESOLUTION=env-only`, `CORPUSWIRE_TOOL_PROFILE=core`, `CORPUSWIRE_RESULT_HEADER=compact`, `CORPUSWIRE_MCP_HANDSHAKE_LOG=1`.

Server-packed evidence (CRP-003):

- When the engine returns `evidence_spans` with a packing report marked complete, the server renders those source-verified line spans. Otherwise it keeps the selected-neighbor and heading-prefix path unchanged.
- `CORPUSWIRE_SERVER_PACKING=auto|off` switches it (`off` is the rollback), `CORPUSWIRE_EVIDENCE_BUDGET_CHARS` sets the default budget, and the `max_evidence_chars` tool argument overrides it per call.
- `maxChars` bounds the packed evidence by whole spans, in rendered order. Citations and packet ranges come only from the spans that were kept, and a truncation note counts the omitted spans.

Smaller fix: an explicit reconcile now waits for less time than the host's tool timeout, so the host no longer gives up first.

Explicit and env-configured setups, such as the Codex plugin, send the same requests and get the same output as before.

Validation: 140 MCP tests pass (5 skipped), including replayed Claude Code, VS Code, Copilot CLI and Codex handshakes. On the Mac, the read-only Docker/MCP regression and a live Claude Code handshake passed. Live Codex, VS Code and Copilot CLI handshakes were not run.

Download the archive with its SHA256 file and restart existing MCP hosts. This is a GitHub prerelease; npm publication is not claimed. The coordinated runtime is v0.1.40-beta.1.
