CLI 0.1.5-beta.2 adds a prompt editor to the `cw` start screen and makes `cw init` register and index the folder.

- Bare `cw` in a terminal shows a multiline prompt box under the watch output. Ctrl+P rewrites the draft through prompt enhancement and Enter copies it. `cw enhance` with no prompt opens the same box on its own. `CORPUSWIRE_CLI_PROMPT_EDITOR=off` turns it off.
- `cw init` on a local service now registers the folder's workspace and indexes it. `--no-index` keeps the old settings-only behavior. With no saved credential, it creates a tenant through self-onboarding and saves the token, owner-only, in `~/.local/share/corpuswire/cli-credentials.json`.
- When the service refuses a workspace (403) before indexing, `cw` asks the service to register it once and retries. Errors now say whether credentials are missing or the workspace was refused, still without echoing server text.
- Behavior change: `cw search`, `cw enhance` and `cw health` in a folder with no index now keep that folder's workspace and answer without repository context. They no longer fall back to the backend default workspace, which gave context from an unrelated repository.
- SDK: `ensureWorkspace()` and `selfOnboard()`.

The archive bundles MCP 0.1.5-beta.2 and SDK 0.1.6. Install it together with those archives from the same release.

Known limit: 10 watch-mode tests still fail on the Mac, the same list as on main. One-shot commands work.

Validation: 140 of 150 CLI tests pass; the 10 failures are those watch-mode tests.

Download the archive with its SHA256 file. This is a GitHub prerelease; npm publication is not claimed. The coordinated runtime is v0.1.40-beta.1.
