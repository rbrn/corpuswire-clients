CLI 0.1.5-beta.5 makes `cw` sync safe for git workflows (IDX-002, #56).

- `cw` skips files git ignores. Pass `--include-ignored` to index them anyway. `reports/retrieval-failures/` is never indexed.
- A full index from a folder other than the one that owns the workspace is refused by servers that run the source-root guard (engine 0.1.42-beta.1). `--allow-source-switch` moves ownership on purpose. A refused index exits non-zero, and watch stops instead of retrying.
- Large implicit rewrites stop for confirmation: more than 50 files and more than 20% of the workspace. An explicit `--yes` always passes.
- Watch waits while a rebase, merge, cherry-pick or revert is in progress and publishes once it ends.
- Index sessions carry the commit, branch and dirty-file count.
- Since 0.1.5-beta.4: a failed session that holds the workspace lock is cancelled, and Dockerfiles are indexed in the code tier (#54).

The archive bundles MCP 0.1.5-beta.3 and SDK 0.1.7. Install it together with those archives.

Download the archive with its SHA256 file. This is a GitHub prerelease; npm publication is not claimed. The coordinated runtime is v0.1.42-beta.1.
