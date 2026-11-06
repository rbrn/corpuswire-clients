MCP 0.1.5-beta.2 records more in the retrieval journal and can warn when the index is behind your commit.

- Journal v2 records the detected host and clientInfo, the engine's retrieval event id and a fixed error category for failures. Successful results end with a `journalEventId` line, and `corpuswire_rate_result` accepts `journalEventId`, `expectedPaths` and `missingPaths`, which saves an owner-only rating next to the journal record.
- Journal v3 also saves the engine's stage trace (paths and query identifiers are hashed in metadata mode) and the folder's git HEAD and dirty state for each call. The trace never enters the delivered text.
- `CORPUSWIRE_SYNC_READ_COMMIT_CHECK=off|warn|sync` (default `off`) compares the index's commit with local HEAD after each search or enhance and adds one `indexFreshness` line. `sync` also starts a background sync of the files changed between the two commits, and never delays the read.

Removed: the `corpuswire_review_context` and `corpuswire_review_context_v2` tools, because the engine archived the review sidecar. `corpuswire_codebase_status` stays. Also removed: dead prototypes, the never-adopted source-root coalescing switch and the `CORPUSWIRE_PRIVATE_SEARCH_TELEMETRY_PATH` timing files.

The vendored SDK is now 0.1.6.

Validation: 113 MCP tests pass in the engine checkout, including the Codex wrapper entry point once the engine re-vendors this build.

Download the archive with its SHA256 file and restart existing MCP hosts. This is a GitHub prerelease; npm publication is not claimed. The coordinated runtime is v0.1.40-beta.1.
